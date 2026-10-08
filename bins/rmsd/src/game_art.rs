mod cache;
mod team_colors;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rms_content::game_art::{
    self, GAME_ART_BLEND_ATLASES, GameArtCatalog, Image, ObjectArt, is_asset_name,
    read_aoe2de_dat_game_art,
};
use rms_content::{ContentError, DatImportLimits};
use rms_engine::local_content::{LOCAL_DAT_RELATIVE_PATH, is_local_drive_path};
use rms_protocol::v1;
use serde::{Deserialize, Serialize};

use cache::{Cache, CacheError, Stamp};

pub(crate) const TERRAIN_EDGE: u32 = 512;
pub(crate) const TEXTURE_REPEAT_TILES: u32 = 10;
pub(crate) const PREPARE_DEADLINE: Duration = Duration::from_secs(300);
pub(crate) const SPRITES_DEADLINE: Duration = Duration::from_secs(180);
pub(crate) const MAXIMUM_REQUEST_OBJECTS: usize = 4_096;
pub(crate) const MAXIMUM_REQUEST_GRAPHICS: usize = 4_096;
pub(crate) const MAXIMUM_FACINGS: usize = 64;
const MAXIMUM_REPORTED_FALLBACKS: usize = 256;
const MAXIMUM_DAT_BYTES: u64 = 256 * 1024 * 1024;
const MAXIMUM_TEXTURE_BYTES: u64 = 128 * 1024 * 1024;
const MAXIMUM_ATLAS_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_SPRITE_BYTES: u64 = 256 * 1024 * 1024;
const MAXIMUM_PATH_BYTES: usize = 4_096;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

const TEXTURES: [&str; 5] = ["resources", "_common", "terrain", "textures", "2x"];
const BLENDS: [&str; 4] = ["resources", "_common", "terrain", "blends"];
const MASKS: [&str; 4] = ["resources", "_common", "terrain", "masks"];
const SPRITES: [&str; 4] = ["resources", "_common", "drs", "graphics"];
const CACHE_VERSIONS: [&str; 2] = ["game-art-cache", "v1"];

type Status = v1::GameArtStatus;
type Phase = v1::GameArtPhase;

pub(crate) trait JobContext {
    fn cancelled(&self) -> bool;
    fn progress(&mut self, phase: Phase, completed: u32, total: u32);
}

static GAME_ART_GATE: Mutex<()> = Mutex::new(());

struct Failure {
    status: Status,
    message: String,
}

impl Failure {
    fn new(status: Status, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<CacheError> for Failure {
    fn from(error: CacheError) -> Self {
        Self::new(Status::Unreadable, error.0)
    }
}

struct Source {
    root: PathBuf,
    product_version: String,
    versions: PathBuf,
    key: String,
}

fn canonical_local_directory(path: &str, label: &str) -> Result<PathBuf, Failure> {
    let raw = Path::new(path);
    if path.is_empty() || path.len() > MAXIMUM_PATH_BYTES || !is_local_drive_path(raw) {
        return Err(Failure::new(
            Status::Unreadable,
            format!("the {label} is not an absolute local drive path"),
        ));
    }
    let resolved = std::fs::canonicalize(raw)
        .map_err(|_| Failure::new(Status::Unreadable, format!("the {label} is missing")))?;
    if !is_local_drive_path(&resolved) || !resolved.is_dir() {
        return Err(Failure::new(
            Status::Unreadable,
            format!("the {label} is not a local directory"),
        ));
    }
    Ok(resolved)
}

fn validate_source(source: Option<&v1::GameArtSource>) -> Result<Source, Failure> {
    let source =
        source.ok_or_else(|| Failure::new(Status::Invalid, "the game art source is required"))?;
    if rms_engine::local_content::local_content_pack_id(&source.product_version).is_err() {
        return Err(Failure::new(
            Status::Invalid,
            "the product version is not a dotted numeric label",
        ));
    }
    let root = canonical_local_directory(&source.installation_root, "installation root")?;
    let cache_root = canonical_local_directory(&source.cache_root, "cache location")?;
    if cache_root.starts_with(&root) || root.starts_with(&cache_root) {
        return Err(Failure::new(
            Status::Unreadable,
            "the cache location and the installation overlap",
        ));
    }
    let mut versions = cache_root.clone();
    for segment in CACHE_VERSIONS {
        versions.push(segment);
    }
    std::fs::create_dir_all(&versions)
        .map_err(|_| Failure::new(Status::Unreadable, "the cache location is not writable"))?;
    let versions = std::fs::canonicalize(&versions)
        .ok()
        .filter(|resolved| resolved.starts_with(&cache_root) && !resolved.starts_with(&root))
        .ok_or_else(|| Failure::new(Status::Unreadable, "the cache location is redirected"))?;
    let key = cache::cache_key(&root, &source.product_version);
    Ok(Source {
        root,
        product_version: source.product_version.clone(),
        versions,
        key,
    })
}

enum ReadError {
    Missing,
    Refused(&'static str),
}

impl Source {
    fn relative(directory: &[&str], name: &str) -> String {
        let mut path = directory.join("/");
        path.push('/');
        path.push_str(name);
        path
    }

    fn resolve(&self, directory: &[&str], name: &str) -> Result<(PathBuf, Stamp), ReadError> {
        if !is_asset_name(name) {
            return Err(ReadError::Refused("not a plain asset name"));
        }
        let mut path = self.root.clone();
        for segment in directory {
            path.push(segment);
        }
        path.push(name);
        let resolved = std::fs::canonicalize(&path).map_err(|_| ReadError::Missing)?;
        if !resolved.starts_with(&self.root) || !is_local_drive_path(&resolved) {
            return Err(ReadError::Refused("resolves outside the installation"));
        }
        let metadata = std::fs::metadata(&resolved).map_err(|_| ReadError::Missing)?;
        if !metadata.is_file() {
            return Err(ReadError::Refused("not a file"));
        }
        Ok((resolved, Stamp::of(&metadata)))
    }

    fn read(path: &Path, maximum: u64) -> Result<Vec<u8>, ReadError> {
        use std::io::Read;
        let file = std::fs::File::open(path).map_err(|_| ReadError::Missing)?;
        let metadata = file.metadata().map_err(|_| ReadError::Missing)?;
        if !metadata.is_file() || metadata.len() > maximum {
            return Err(ReadError::Refused("exceeds its size bound"));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ReadError::Missing)?;
        if bytes.len() as u64 > maximum {
            return Err(ReadError::Refused("grew past its size bound"));
        }
        Ok(bytes)
    }
}

type CatalogCache = Option<(PathBuf, Stamp, Arc<GameArtCatalog>)>;
static CATALOG: Mutex<CatalogCache> = Mutex::new(None);

fn catalog(source: &Source) -> Result<(Arc<GameArtCatalog>, Stamp), Failure> {
    let (directory, name) = LOCAL_DAT_RELATIVE_PATH.split_at(LOCAL_DAT_RELATIVE_PATH.len() - 1);
    let (path, stamp) = source.resolve(directory, name[0]).map_err(|error| {
        Failure::new(
            Status::Unreadable,
            match error {
                ReadError::Missing => "the game data file is missing".to_owned(),
                ReadError::Refused(reason) => format!("the game data file {reason}"),
            },
        )
    })?;
    let mut cached = CATALOG.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some((cached_path, cached_stamp, catalog)) = cached.as_ref()
        && *cached_path == path
        && *cached_stamp == stamp
    {
        return Ok((Arc::clone(catalog), stamp));
    }
    let bytes = Source::read(&path, MAXIMUM_DAT_BYTES)
        .map_err(|_| Failure::new(Status::Unreadable, "the game data file is unreadable"))?;
    let catalog = read_aoe2de_dat_game_art(&bytes, DatImportLimits::default()).map_err(
        |error| match error {
            ContentError::ResourceLimit(_) => Failure::new(Status::Unreadable, error.to_string()),
            _ => Failure::new(
                Status::UnsupportedLayout,
                format!("the game data file is not a reviewed layout: {error}"),
            ),
        },
    )?;
    let catalog = Arc::new(catalog);
    *cached = Some((path, stamp, Arc::clone(&catalog)));
    Ok((catalog, stamp))
}

struct Outcome {
    converted: u32,
    reused: u32,
    fallbacks: Vec<v1::GameArtFallback>,
    fallback_count: u32,
    started: Instant,
    deadline: Duration,
    last_progress: Option<Instant>,
}

impl Outcome {
    fn new(deadline: Duration) -> Self {
        Self {
            converted: 0,
            reused: 0,
            fallbacks: Vec::new(),
            fallback_count: 0,
            started: Instant::now(),
            deadline,
            last_progress: None,
        }
    }

    fn fallback(&mut self, asset: String, reason: impl Into<String>) {
        self.fallback_count += 1;
        if self.fallbacks.len() < MAXIMUM_REPORTED_FALLBACKS {
            self.fallbacks.push(v1::GameArtFallback {
                asset,
                reason: reason.into(),
            });
        }
    }

    fn check(&self, context: &dyn JobContext) -> Result<(), Failure> {
        if context.cancelled() {
            return Err(Failure::new(
                Status::Cancelled,
                "the conversion was cancelled",
            ));
        }
        if self.started.elapsed() > self.deadline {
            return Err(Failure::new(
                Status::Invalid,
                format!(
                    "the conversion exceeded its {}-second bound",
                    self.deadline.as_secs()
                ),
            ));
        }
        Ok(())
    }

    fn progress(
        &mut self,
        context: &mut dyn JobContext,
        phase: Phase,
        completed: u32,
        total: u32,
        phase_end: bool,
    ) {
        let due = completed == total
            || phase_end
            || self
                .last_progress
                .is_none_or(|last| last.elapsed() >= PROGRESS_INTERVAL);
        if due {
            self.last_progress = Some(Instant::now());
            context.progress(phase, completed, total);
        }
    }
}

fn read_failure_reason(error: ReadError) -> String {
    match error {
        ReadError::Missing => "the file is missing".to_owned(),
        ReadError::Refused(reason) => format!("the file {reason}"),
    }
}

const MANIFEST_SAVE_INTERVAL: u32 = 8;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerrainIndex {
    pub(crate) format: String,
    pub(crate) product_version: String,
    pub(crate) texture_repeat_tiles: u32,
    pub(crate) terrains: Vec<TerrainIndexEntry>,
    pub(crate) blends: Vec<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) player_colors: Option<team_colors::TeamColors>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerrainIndexEntry {
    pub(crate) id: u32,
    pub(crate) texture: Option<String>,
    pub(crate) blend_priority: i32,
    pub(crate) blend_type: i32,
    pub(crate) overlay_mask: Option<String>,
    pub(crate) water_class: u8,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

struct Asset<'a> {
    phase: Phase,
    directory: &'a [&'a str],
    entry_prefix: &'static str,
    output_directory: &'static str,
    maximum_bytes: u64,
    convert: fn(&[u8]) -> Result<Image, game_art::GameArtError>,
    progress: (u32, u32),
}

fn convert_terrain(bytes: &[u8]) -> Result<Image, game_art::GameArtError> {
    game_art::dds::decode_terrain_texture(bytes, TERRAIN_EDGE)
}

fn convert_alpha(bytes: &[u8]) -> Result<Image, game_art::GameArtError> {
    game_art::png::decode(bytes).map(|image| image.first_channel())
}

fn convert_family(
    source: &Source,
    cache: &mut Cache,
    asset: &Asset<'_>,
    files: &[(String, String)],
    outcome: &mut Outcome,
    context: &mut dyn JobContext,
    now: u64,
) -> Result<BTreeMap<String, String>, Failure> {
    let mut available = BTreeMap::new();
    let (base, total) = asset.progress;
    for (index, (file, output)) in files.iter().enumerate() {
        outcome.check(context)?;
        let entry = format!("{}/{}", asset.entry_prefix, output);
        let output_path = format!("{}/{}.png", asset.output_directory, output);
        let asset_key = format!("{}/{}", asset.entry_prefix, output);
        match source.resolve(asset.directory, file) {
            Err(error) => outcome.fallback(asset_key, read_failure_reason(error)),
            Ok((path, stamp)) => {
                if cache.reusable(&entry, stamp, now) {
                    outcome.reused += 1;
                    available.insert(file.clone(), output_path);
                } else {
                    let converted = Source::read(&path, asset.maximum_bytes)
                        .map_err(read_failure_reason)
                        .and_then(|bytes| {
                            (asset.convert)(&bytes).map_err(|error| error.to_string())
                        })
                        .and_then(|image| {
                            game_art::png::encode(&image).map_err(|error| error.to_string())
                        });
                    match converted {
                        Ok(png) => {
                            if !cache.reserve(png.len() as u64) {
                                outcome.fallback(asset_key, "the cache cap is reached");
                            } else {
                                cache.store(
                                    &entry,
                                    Source::relative(asset.directory, file),
                                    stamp,
                                    vec![(output_path.clone(), png)],
                                    now,
                                )?;
                                outcome.converted += 1;
                                available.insert(file.clone(), output_path);
                                if outcome.converted.is_multiple_of(MANIFEST_SAVE_INTERVAL) {
                                    cache.save()?;
                                }
                            }
                        }
                        Err(reason) => outcome.fallback(asset_key, reason),
                    }
                }
            }
        }
        outcome.progress(
            context,
            asset.phase,
            base + index as u32 + 1,
            total,
            index + 1 == files.len(),
        );
    }
    Ok(available)
}

fn prepare_inner(
    request: &v1::GameArtPrepareRequest,
    context: &mut dyn JobContext,
    outcome: &mut Outcome,
    now: u64,
) -> Result<Cache, Failure> {
    let source = validate_source(request.source.as_ref())?;
    context.progress(Phase::Catalog, 0, 1);
    let (catalog, dat_stamp) = catalog(&source)?;
    context.progress(Phase::Catalog, 1, 1);
    let mut cache = Cache::open(
        &source.versions,
        source.key.clone(),
        &source.product_version,
        now,
    )?;
    if cache.manifest.dat != Some(dat_stamp) {
        let sprites = cache
            .manifest
            .entries
            .keys()
            .filter(|key| key.starts_with("sprite/"))
            .cloned()
            .collect::<Vec<_>>();
        for key in sprites {
            cache.remove_entry(&key);
        }
        let _ = std::fs::remove_file(cache.directory.join("sprites.json"));
        cache.manifest.dat = Some(dat_stamp);
    }
    let result = prepare_assets(&source, &catalog, &mut cache, context, outcome, now);
    cache.save()?;
    result?;
    Ok(cache)
}

fn prepare_assets(
    source: &Source,
    catalog: &GameArtCatalog,
    cache: &mut Cache,
    context: &mut dyn JobContext,
    outcome: &mut Outcome,
    now: u64,
) -> Result<(), Failure> {
    let textures = catalog
        .terrain_textures()
        .into_iter()
        .map(|name| (format!("{name}.dds"), name))
        .collect::<Vec<_>>();
    let blends = GAME_ART_BLEND_ATLASES
        .iter()
        .map(|name| (format!("{name}.png"), (*name).to_owned()))
        .collect::<Vec<_>>();
    let masks = catalog
        .overlay_masks()
        .into_iter()
        .filter_map(|name| {
            let stem = name
                .strip_suffix(".png")
                .or_else(|| name.strip_suffix(".PNG"))?;
            Some((name.clone(), stem.to_owned()))
        })
        .collect::<Vec<_>>();
    let total = (textures.len() + blends.len() + masks.len()) as u32;
    let blends_base = textures.len() as u32;
    let masks_base = blends_base + blends.len() as u32;
    let textures = convert_family(
        source,
        cache,
        &Asset {
            phase: Phase::Terrain,
            directory: &TEXTURES,
            entry_prefix: "terrain",
            output_directory: "terrain",
            maximum_bytes: MAXIMUM_TEXTURE_BYTES,
            convert: convert_terrain,
            progress: (0, total),
        },
        &textures,
        outcome,
        context,
        now,
    )?;
    let blend_files = convert_family(
        source,
        cache,
        &Asset {
            phase: Phase::Blends,
            directory: &BLENDS,
            entry_prefix: "blend",
            output_directory: "blends",
            maximum_bytes: MAXIMUM_ATLAS_BYTES,
            convert: convert_alpha,
            progress: (blends_base, total),
        },
        &blends,
        outcome,
        context,
        now,
    )?;
    let mask_files = convert_family(
        source,
        cache,
        &Asset {
            phase: Phase::Masks,
            directory: &MASKS,
            entry_prefix: "mask",
            output_directory: "masks",
            maximum_bytes: MAXIMUM_ATLAS_BYTES,
            convert: convert_alpha,
            progress: (masks_base, total),
        },
        &masks,
        outcome,
        context,
        now,
    )?;
    let index = TerrainIndex {
        format: "rmside-game-art-terrain-index-1".to_owned(),
        product_version: source.product_version.clone(),
        texture_repeat_tiles: TEXTURE_REPEAT_TILES,
        terrains: catalog
            .terrains
            .iter()
            .map(|terrain| TerrainIndexEntry {
                id: terrain.id,
                texture: textures.get(&format!("{}.dds", terrain.texture)).cloned(),
                blend_priority: terrain.blend_priority,
                blend_type: terrain.blend_type,
                overlay_mask: mask_files.get(&terrain.overlay_mask).cloned(),
                water_class: terrain.water_class,
            })
            .collect(),
        blends: GAME_ART_BLEND_ATLASES
            .iter()
            .map(|name| blend_files.get(&format!("{name}.png")).cloned())
            .collect(),
        player_colors: team_colors::installation_team_colors(|name| {
            let (path, _) = source.resolve(&team_colors::PALETTES, name).ok()?;
            Source::read(&path, team_colors::MAXIMUM_TEAM_COLOR_BYTES).ok()
        }),
    };
    cache.write_document("index.json", &index)?;
    Ok(())
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpriteIndex {
    pub(crate) format: String,
    pub(crate) objects: BTreeMap<String, SpriteObject>,
    pub(crate) graphics: BTreeMap<String, SpriteGraphic>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpriteObject {
    pub(crate) table: u32,
    pub(crate) parts: Vec<SpritePart>,
    pub(crate) foundation_terrain: Option<u32>,
    pub(crate) annexes: Vec<SpriteAnnex>,
    #[serde(default)]
    pub(crate) invisible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpritePart {
    pub(crate) graphic: u32,
    pub(crate) offset_x: i32,
    pub(crate) offset_y: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpriteAnnex {
    pub(crate) object: u32,
    pub(crate) offset_x: f32,
    pub(crate) offset_y: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpriteGraphic {
    pub(crate) layer: u8,
    pub(crate) facings: Vec<SpriteFacing>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpriteFacing {
    pub(crate) image: String,
    pub(crate) player_mask: Option<String>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) anchor_x: i32,
    pub(crate) anchor_y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) average_color: Option<u32>,
}

pub(crate) fn average_color(image: &game_art::Image) -> Option<u32> {
    if image.channels != 4 {
        return None;
    }
    let (mut red, mut green, mut blue, mut count) = (0_u64, 0_u64, 0_u64, 0_u64);
    for pixel in image.pixels.chunks_exact(4) {
        if pixel[3] >= 128 {
            red += u64::from(pixel[0]);
            green += u64::from(pixel[1]);
            blue += u64::from(pixel[2]);
            count += 1;
        }
    }
    (count > 0).then(|| {
        let mean = |sum: u64| ((sum + count / 2) / count).min(255) as u32;
        (mean(red) << 16) | (mean(green) << 8) | mean(blue)
    })
}

pub(crate) fn facing_frame(
    facing: usize,
    facings: usize,
    frames_per_facing: usize,
    stored_frames: usize,
    mirroring: bool,
) -> Option<(usize, bool)> {
    let frames_per_facing = frames_per_facing.max(1);
    let stored_facings = stored_frames / frames_per_facing;
    if stored_facings == 0 {
        return (facing == 0 && stored_frames > 0).then_some((0, false));
    }
    if facing < stored_facings {
        return Some((facing * frames_per_facing, false));
    }
    if mirroring && facings > facing {
        let source = facings - facing;
        if source < stored_facings {
            return Some((source * frames_per_facing, true));
        }
    }
    None
}

pub(crate) fn standing_frame(
    first: usize,
    frames_per_facing: usize,
    stored_frames: usize,
    visible: impl Fn(usize) -> bool,
) -> usize {
    let end = first
        .saturating_add(frames_per_facing.max(1))
        .min(stored_frames);
    (first..end).find(|frame| visible(*frame)).unwrap_or(first)
}

type CacheFiles = Vec<(String, Vec<u8>)>;

fn convert_graphic(
    graphic: &game_art::ArtGraphic,
    bytes: &[u8],
) -> Result<(SpriteGraphic, CacheFiles), String> {
    let file = game_art::sld::SldFile::parse(bytes).map_err(|error| error.to_string())?;
    let facings = usize::from(graphic.angle_count.max(1)).min(MAXIMUM_FACINGS);
    let mut outputs = Vec::new();
    let mut described = Vec::new();
    let mut decoded = BTreeMap::new();
    for facing in 0..facings {
        let Some((frame, mirrored)) = facing_frame(
            facing,
            usize::from(graphic.angle_count.max(1)),
            usize::from(graphic.frame_count),
            file.frame_count(),
            graphic.mirroring != 0,
        ) else {
            continue;
        };
        let frame = standing_frame(
            frame,
            usize::from(graphic.frame_count),
            file.frame_count(),
            |index| file.has_main_image(index),
        );
        if let std::collections::btree_map::Entry::Vacant(slot) = decoded.entry(frame) {
            slot.insert(file.decode(frame).map_err(|error| error.to_string())?);
        }
        let Some(frame_image) = decoded.get(&frame) else {
            continue;
        };
        let Some(main) = frame_image.main.as_ref() else {
            continue;
        };
        let mut image = main.image.clone();
        let mut anchor_x = i32::from(frame_image.hotspot_x) - i32::from(main.x);
        let anchor_y = i32::from(frame_image.hotspot_y) - i32::from(main.y);
        let mut mask = frame_image.player.as_ref().map(|layer| layer.image.clone());
        if mirrored {
            image = image.flipped_horizontally();
            mask = mask.map(|mask| mask.flipped_horizontally());
            anchor_x = image.width as i32 - anchor_x;
        }
        let image_name = format!("sprites/{}-{facing}.png", graphic.id);
        outputs.push((
            image_name.clone(),
            game_art::png::encode(&image).map_err(|error| error.to_string())?,
        ));
        let mask_name = match mask {
            Some(mask) if mask.pixels.iter().any(|value| *value != 0) => {
                let name = format!("sprites/{}-{facing}-player.png", graphic.id);
                outputs.push((
                    name.clone(),
                    game_art::png::encode(&mask).map_err(|error| error.to_string())?,
                ));
                Some(name)
            }
            _ => None,
        };
        described.push(SpriteFacing {
            image: image_name,
            player_mask: mask_name,
            width: image.width,
            height: image.height,
            anchor_x,
            anchor_y,
            average_color: average_color(&image),
        });
    }
    if described.is_empty() {
        return Err("the sprite has no visible standing frame".to_owned());
    }
    Ok((
        SpriteGraphic {
            layer: graphic.layer,
            facings: described,
        },
        outputs,
    ))
}

fn resolve_objects(
    catalog: &GameArtCatalog,
    objects: &[v1::GameArtObject],
) -> Vec<(String, ObjectArt)> {
    let mut queue = objects
        .iter()
        .map(|object| (object.object_id, object.civilization_id))
        .collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    let mut resolved = Vec::new();
    while let Some((object, civilization)) = queue.pop() {
        if !seen.insert((object, civilization)) || seen.len() > MAXIMUM_REQUEST_OBJECTS * 2 {
            continue;
        }
        let Some(art) = catalog.object_art(object, civilization) else {
            continue;
        };
        for annex in &art.annexes {
            queue.push((annex.object, civilization));
        }
        resolved.push((format!("{civilization}:{object}"), art));
    }
    resolved.sort_by(|left, right| left.0.cmp(&right.0));
    resolved
}

fn sprites_inner(
    request: &v1::GameArtSpritesRequest,
    context: &mut dyn JobContext,
    outcome: &mut Outcome,
    now: u64,
) -> Result<Cache, Failure> {
    if request.objects.len() > MAXIMUM_REQUEST_OBJECTS {
        return Err(Failure::new(
            Status::Invalid,
            format!("at most {MAXIMUM_REQUEST_OBJECTS} objects may be requested"),
        ));
    }
    let source = validate_source(request.source.as_ref())?;
    context.progress(Phase::Catalog, 0, 1);
    let (catalog, dat_stamp) = catalog(&source)?;
    context.progress(Phase::Catalog, 1, 1);
    let mut cache = Cache::open(
        &source.versions,
        source.key.clone(),
        &source.product_version,
        now,
    )?;
    if cache.manifest.dat != Some(dat_stamp) {
        return Err(Failure::new(
            Status::Invalid,
            "the cache is not prepared for this game data file; prepare it first",
        ));
    }
    let mut index = cache
        .read_document::<SpriteIndex>("sprites.json")
        .unwrap_or_default();
    index.format = "rmside-game-art-sprite-index-1".to_owned();
    let objects = resolve_objects(&catalog, &request.objects);
    let mut graphics = BTreeSet::new();
    for (key, art) in &objects {
        graphics.extend(art.parts.iter().map(|part| part.graphic));
        index.objects.insert(
            key.clone(),
            SpriteObject {
                table: art.table,
                parts: art
                    .parts
                    .iter()
                    .map(|part| SpritePart {
                        graphic: part.graphic,
                        offset_x: part.offset_x,
                        offset_y: part.offset_y,
                    })
                    .collect(),
                foundation_terrain: art.foundation_terrain,
                annexes: art
                    .annexes
                    .iter()
                    .map(|annex| SpriteAnnex {
                        object: annex.object,
                        offset_x: annex.offset_x,
                        offset_y: annex.offset_y,
                    })
                    .collect(),
                invisible: art.invisible,
            },
        );
    }
    let graphics = graphics
        .into_iter()
        .take(MAXIMUM_REQUEST_GRAPHICS)
        .collect::<Vec<_>>();
    let total = graphics.len() as u32;
    let mut result = Ok(());
    for (position, id) in graphics.iter().enumerate() {
        if let Err(failure) = outcome.check(context) {
            result = Err(failure);
            break;
        }
        let entry = format!("sprite/{id}");
        let Some(graphic) = catalog.graphic(*id) else {
            continue;
        };
        let file = format!("{}.sld", graphic.file);
        match source.resolve(&SPRITES, &file) {
            Err(ReadError::Missing) => {
                let other = ["smx", "slp"].iter().any(|extension| {
                    source
                        .resolve(&SPRITES, &format!("{}.{extension}", graphic.file))
                        .is_ok()
                });
                outcome.fallback(
                    entry.clone(),
                    if other {
                        "the sprite is not in the reviewed SLD format"
                    } else {
                        "the file is missing"
                    },
                );
                index.graphics.remove(&id.to_string());
            }
            Err(error) => {
                outcome.fallback(entry.clone(), read_failure_reason(error));
                index.graphics.remove(&id.to_string());
            }
            Ok((path, stamp)) => {
                if cache.reusable(&entry, stamp, now)
                    && index.graphics.contains_key(&id.to_string())
                {
                    outcome.reused += 1;
                } else {
                    let converted = Source::read(&path, MAXIMUM_SPRITE_BYTES)
                        .map_err(read_failure_reason)
                        .and_then(|bytes| convert_graphic(graphic, &bytes));
                    match converted {
                        Ok((described, files)) => {
                            let bytes = files.iter().map(|(_, data)| data.len() as u64).sum();
                            if !cache.reserve(bytes) {
                                outcome.fallback(entry.clone(), "the cache cap is reached");
                            } else {
                                match cache.store(
                                    &entry,
                                    Source::relative(&SPRITES, &file),
                                    stamp,
                                    files,
                                    now,
                                ) {
                                    Ok(()) => {
                                        index.graphics.insert(id.to_string(), described);
                                        outcome.converted += 1;
                                    }
                                    Err(error) => {
                                        result = Err(error.into());
                                        break;
                                    }
                                }
                            }
                        }
                        Err(reason) => {
                            outcome.fallback(entry.clone(), reason);
                            index.graphics.remove(&id.to_string());
                        }
                    }
                }
            }
        }
        outcome.progress(context, Phase::Sprites, position as u32 + 1, total, false);
    }
    index
        .graphics
        .retain(|id, _| cache.manifest.entries.contains_key(&format!("sprite/{id}")));
    cache.write_document("sprites.json", &index)?;
    cache.save()?;
    result?;
    Ok(cache)
}

fn respond(result: Result<Cache, Failure>, outcome: Outcome) -> v1::GameArtResponse {
    let elapsed = outcome
        .started
        .elapsed()
        .as_micros()
        .min(u128::from(u64::MAX)) as u64;
    let base = v1::GameArtResponse {
        status: Status::Available as i32,
        message: String::new(),
        cache_key: String::new(),
        converted: outcome.converted,
        reused: outcome.reused,
        fallbacks: outcome.fallbacks,
        fallback_count: outcome.fallback_count,
        cache_bytes: 0,
        elapsed_microseconds: elapsed,
        evicted: 0,
    };
    match result {
        Ok(cache) => v1::GameArtResponse {
            cache_key: cache.key.clone(),
            cache_bytes: cache.total_bytes(),
            evicted: cache.evicted,
            ..base
        },
        Err(failure) => v1::GameArtResponse {
            status: failure.status as i32,
            message: failure.message,
            ..base
        },
    }
}

pub(crate) fn prepare(
    request: &v1::GameArtPrepareRequest,
    context: &mut dyn JobContext,
) -> v1::GameArtResponse {
    let mut outcome = Outcome::new(PREPARE_DEADLINE);
    let _gate = GAME_ART_GATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let result = prepare_inner(request, context, &mut outcome, now_seconds());
    respond(result, outcome)
}

pub(crate) fn sprites(
    request: &v1::GameArtSpritesRequest,
    context: &mut dyn JobContext,
) -> v1::GameArtResponse {
    let mut outcome = Outcome::new(SPRITES_DEADLINE);
    let _gate = GAME_ART_GATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let result = sprites_inner(request, context, &mut outcome, now_seconds());
    respond(result, outcome)
}
