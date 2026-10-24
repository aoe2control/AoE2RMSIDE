use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use anyhow::{Result, bail};
use rms_content::{CompatibleContentView, TerrainId, TerrainLayerClass};
use rms_engine::{GeneratedMap, PlacedObject};

use crate::StopCheck;
use crate::analysis::{Place, place_tiles, player_place};
use crate::quality::{HostData, QUALITY_CASES};
use crate::records::{PlayerRecord, StartKind};
use crate::walk::{
    self, Blocking, Field, PassageResult, STRAIGHT_COST, WalkGrid, WalkRules, cost_within,
};

const BUILDING_CLASS: u32 = 3;
const CIVILIAN_CLASS: u32 = 4;
const DEEP_FISH_CLASS: u32 = 5;
const BERRY_CLASS: u32 = 7;
const STONE_CLASS: u32 = 8;
const HUNT_CLASS: u32 = 9;
const PREDATOR_CLASS: u32 = 10;
const TREE_CLASS: u32 = 15;
const WALL_CLASS: u32 = 27;
const GOLD_CLASS: u32 = 32;
const SHORE_FISH_CLASS: u32 = 33;
const FLAG_CLASS: u32 = 30;
const GATE_CLASS: u32 = 39;
const RELIC_CLASS: u32 = 42;
const FARM_CLASS: u32 = 49;
const TOWER_CLASS: u32 = 52;
const HERDABLE_CLASS: u32 = 58;
const SCOUT_CLASS: u32 = 47;

const TRAINING_BUILDINGS: [&str; 11] = [
    "TOWN_CENTER",
    "TOWN_CENTER_FOUNDATION",
    "BARRACKS",
    "ARCHERY_RANGE",
    "STABLE",
    "SIEGE_WORKSHOP",
    "CASTLE",
    "MONASTERY",
    "DOCK",
    "MARKET",
    "KREPOST",
];
const NAME_VARIANTS: [&str; 4] = ["", "_C", "_F", "_I"];
const SCOUT_NAMES: [&str; 4] = ["SCOUT", "SCOUT_CAVALRY", "EAGLE_WARRIOR", "SCYTHIAN_SCOUT"];

const FOOD: i16 = 0;
const STONE: i16 = 2;
const GOLD: i16 = 3;

pub(crate) const CLOSED_START_TILES: usize = 64;
pub(crate) const BASE_RADIUS: u32 = 30;
pub(crate) const BASE_MARGIN: u32 = 2;
pub(crate) const GROUP_REACH: u16 = 2;
pub(crate) const UNREACHABLE_TILES: i64 = 255;
pub(crate) const WOOD_RADIUS: u32 = 20;
pub(crate) const WOODLINE_RADIUS: u32 = 25;
pub(crate) const WOODLINE_TILES: usize = 40;
pub(crate) const BUILD_RADIUS: u32 = 16;
pub(crate) const WALL_RING: u32 = 20;
pub(crate) const WALL_LIMIT: u32 = 64;
pub(crate) const HILL_RADIUS: f64 = 20.0;
pub(crate) const SHORE_RADIUS: u32 = 25;
pub(crate) const SHORE_FISH_RADIUS: u32 = 20;
pub(crate) const WATER_BODY_TILES: usize = 400;
pub(crate) const EXPOSED_RADIUS: u32 = 8;
pub(crate) const START_SPACING: u16 = 2;
pub(crate) const ROUTE_LIMIT: u32 = 16;
pub(crate) const MINERAL_LIMIT: u32 = 3;
pub(crate) const CLUSTER_TILES: usize = 20;
pub(crate) const ROUND_PERCENT: i64 = 95;
pub(crate) const EDGE_BAND: u16 = 10;
pub(crate) const EDGE_RADIUS: f64 = 40.0;
pub(crate) const EDGE_TILES: usize = 50;
pub(crate) const SHORE_TILES: usize = 20;
const MAX_ROW_TILES: usize = rms_protocol::MAX_QUALITY_ROW_TILES;

#[derive(Debug)]
pub(crate) struct QualityContent {
    classes: HashMap<u32, u32>,
    markers: HashSet<u32>,
    waterside: HashSet<u32>,
    training: HashSet<u32>,
    town_centers: HashSet<u32>,
    scouts: HashSet<u32>,
    water: Vec<bool>,
    beach: Vec<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeyFamily {
    TownCenter,
    Villager,
    Scout,
}

impl QualityContent {
    pub(crate) fn new(content: CompatibleContentView<'_>) -> Self {
        let classes: HashMap<u32, u32> = content
            .objects()
            .iter()
            .map(|definition| (definition.id.0, definition.class_id))
            .collect();
        let markers = content
            .objects()
            .iter()
            .filter(|definition| definition.hit_points.is_some_and(|points| points <= 0))
            .map(|definition| definition.id.0)
            .collect();
        let grass = content
            .rms_implicit_definition("GRASS")
            .and_then(|id| u32::try_from(id).ok())
            .map(TerrainId);
        let waterside = content
            .objects()
            .iter()
            .filter(|definition| {
                grass.is_some_and(|grass| {
                    definition
                        .restriction_for(None)
                        .and_then(|id| content.restriction(id))
                        .is_some_and(|restriction| restriction.allows_terrain(grass) == Some(false))
                })
            })
            .map(|definition| definition.id.0)
            .collect();
        let named = |bases: &[&str], variants: &[&str], class: Option<u32>| {
            bases
                .iter()
                .flat_map(|base| {
                    variants
                        .iter()
                        .map(move |variant| format!("{base}{variant}"))
                })
                .filter_map(|name| content.rms_implicit_definition(&name))
                .filter_map(|id| u32::try_from(id).ok())
                .filter(|id| class.is_none_or(|class| classes.get(id) == Some(&class)))
                .collect::<HashSet<u32>>()
        };
        let training = named(&TRAINING_BUILDINGS, &NAME_VARIANTS, Some(BUILDING_CLASS));
        let town_centers = named(
            &TRAINING_BUILDINGS[..2],
            &NAME_VARIANTS,
            Some(BUILDING_CLASS),
        );
        let scouts = named(&SCOUT_NAMES, &[""], None);
        let count = content
            .terrains()
            .iter()
            .map(|terrain| terrain.id.0 as usize + 1)
            .max()
            .unwrap_or(0);
        let mut water = vec![false; count];
        let mut beach = vec![false; count];
        for terrain in content.terrains() {
            let index = terrain.id.0 as usize;
            water[index] = terrain.layer_class == TerrainLayerClass::Water;
            beach[index] = terrain.layer_class == TerrainLayerClass::Beach;
        }
        Self {
            classes,
            markers,
            waterside,
            training,
            town_centers,
            scouts,
            water,
            beach,
        }
    }

    fn class(&self, object: &PlacedObject) -> Option<u32> {
        self.classes.get(&object.object_id.0).copied()
    }

    fn played_with(&self, object_id: u32) -> bool {
        !self.markers.contains(&object_id)
            && !self
                .classes
                .get(&object_id)
                .is_some_and(|class| matches!(*class, WALL_CLASS | GATE_CLASS | FLAG_CLASS))
    }

    fn waterside(&self, object_id: u32) -> bool {
        self.waterside.contains(&object_id)
    }

    fn usable(&self, object: &PlacedObject) -> bool {
        self.kind(object).is_some() || self.training.contains(&object.object_id.0)
    }

    fn family(&self, object_id: u32) -> Option<KeyFamily> {
        if self.town_centers.contains(&object_id) {
            Some(KeyFamily::TownCenter)
        } else if self.scouts.contains(&object_id)
            || self.classes.get(&object_id) == Some(&SCOUT_CLASS)
        {
            Some(KeyFamily::Scout)
        } else if self.classes.get(&object_id) == Some(&CIVILIAN_CLASS) {
            Some(KeyFamily::Villager)
        } else {
            None
        }
    }

    fn kind(&self, object: &PlacedObject) -> Option<Kind> {
        Some(match self.class(object)? {
            GOLD_CLASS => Kind::Gold,
            STONE_CLASS => Kind::Stone,
            BERRY_CLASS => Kind::Berries,
            HUNT_CLASS => Kind::Hunt,
            PREDATOR_CLASS if object.resource_type == FOOD && quantity(object) > 0.0 => Kind::Hunt,
            PREDATOR_CLASS
                if object.resource_type == FOOD && quantity(object) <= 0.0 && object.owner == 0 =>
            {
                Kind::Predator
            }
            HERDABLE_CLASS => Kind::Herdables,
            RELIC_CLASS => Kind::Relic,
            TREE_CLASS => Kind::Tree,
            SHORE_FISH_CLASS => Kind::ShoreFish,
            DEEP_FISH_CLASS => Kind::DeepFish,
            _ => return None,
        })
    }

    fn water(&self, map: &GeneratedMap, index: usize) -> bool {
        self.water
            .get(map.terrain[index].0 as usize)
            .copied()
            .unwrap_or(false)
    }

    fn beach(&self, map: &GeneratedMap, index: usize) -> bool {
        self.beach
            .get(map.terrain[index].0 as usize)
            .copied()
            .unwrap_or(false)
    }
}

fn quantity(object: &PlacedObject) -> f32 {
    f32::from_bits(object.resource_quantity_f32_bits)
}

type Narrowest = (u32, i64, Option<(u16, u16)>);

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum Kind {
    Gold,
    Stone,
    Berries,
    Hunt,
    Herdables,
    Relic,
    Tree,
    ShoreFish,
    DeepFish,
    Predator,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Row {
    pub code: &'static str,
    pub value: i64,
    pub aux: i64,
    pub players: Vec<i64>,
    pub tiles: Vec<(u16, u16, u8)>,
    pub mark: Option<(u16, u16)>,
}

impl Row {
    fn new(code: &'static str, value: i64) -> Self {
        Self {
            code,
            value,
            aux: 0,
            players: Vec::new(),
            tiles: Vec::new(),
            mark: None,
        }
    }

    fn players(mut self, values: Vec<i64>) -> Self {
        self.players = values;
        self.players
            .truncate(rms_protocol::MAX_QUALITY_PLAYER_VALUES);
        self
    }

    fn mark(mut self, tile: Option<(u16, u16)>) -> Self {
        self.mark = tile;
        self
    }

    fn tiles(mut self, tiles: Vec<(u16, u16, u8)>) -> Self {
        self.tiles = tiles;
        self.tiles.truncate(MAX_ROW_TILES);
        if self.mark.is_none() {
            self.mark = self.tiles.first().map(|&(x, y, _)| (x, y));
        }
        self
    }

    fn aux(mut self, aux: i64) -> Self {
        self.aux = aux;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Signature {
    pub forest: Vec<u64>,
    pub starts: Vec<(u16, u16)>,
    pub objects: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CaseMeasure {
    pub rows: Vec<Row>,
    pub favoured: Option<u8>,
    pub contenders: u8,
    pub signature: Option<Arc<Signature>>,
}

impl CaseMeasure {
    fn rows(rows: Vec<Row>) -> Self {
        Self {
            rows,
            ..Self::default()
        }
    }

    pub(crate) fn heap_bytes(&self) -> u64 {
        let rows = self
            .rows
            .iter()
            .map(|row| 96 + 8 * row.players.len() + 8 * row.tiles.len())
            .sum::<usize>();
        let signature = self.signature.as_ref().map_or(0, |signature| {
            8 * signature.forest.len() + 4 * signature.starts.len() + 64
        });
        (rows + signature + 64) as u64
    }
}

pub(crate) struct MeasureInput<'a> {
    pub map: &'a GeneratedMap,
    pub players: &'a [PlayerRecord],
    pub content: &'a QualityContent,
    pub walk: Option<(&'a WalkRules, &'a WalkGrid)>,
}

pub(crate) fn needs_walk(cases: &[usize]) -> bool {
    cases
        .iter()
        .any(|&case| QUALITY_CASES[case].needs.contains(&HostData::Walk))
}

pub(crate) fn measure(
    input: &MeasureInput<'_>,
    cases: &[usize],
    stop: &dyn StopCheck,
) -> Result<Vec<(usize, CaseMeasure)>> {
    if needs_walk(cases) && input.walk.is_none() {
        bail!("the quality check needs the walk rules for this case");
    }
    let shared = Shared::new(input, stop);
    let mut result = Vec::with_capacity(cases.len());
    for &case in cases {
        stop.check()?;
        let id = QUALITY_CASES[case].id;
        if shared.without_start() && compares_starts(id) {
            result.push((case, CaseMeasure::default()));
            continue;
        }
        let measure = match id {
            "generation" => shared.generation(),
            "start-resources" => shared.start_resources()?,
            "resource-distances" => shared.resource_distances()?,
            "shared-resources" => shared.shared_resources()?,
            "wood" => shared.wood()?,
            "trapped" => shared.trapped()?,
            "paths" => shared.paths()?,
            "building-space" => shared.building_space()?,
            "hills" => shared.hills(),
            "water" => shared.water()?,
            "spacing" => shared.spacing(),
            "chokepoints" => shared.chokepoints()?,
            "variation" => shared.variation(),
            "looks" => shared.looks(),
            other => bail!("unknown quality case {other}"),
        };
        result.push((case, measure));
    }
    Ok(result)
}

fn compares_starts(case: &str) -> bool {
    !matches!(case, "generation" | "variation" | "looks")
}

struct Start {
    slot: u8,
    team: u8,
    place: Place,
    centre: (f64, f64),
    tile: (u16, u16),
}

impl Start {
    fn opposes(&self, other: &Self) -> bool {
        self.slot != other.slot && (self.team == 0 || other.team == 0 || self.team != other.team)
    }

    fn allied(&self, other: &Self) -> bool {
        self.slot != other.slot && self.team != 0 && self.team == other.team
    }

    fn distance(&self, other: &Self) -> f64 {
        let (dx, dy) = (
            self.centre.0 - other.centre.0,
            self.centre.1 - other.centre.1,
        );
        (dx * dx + dy * dy).sqrt()
    }

    fn open_for(&self) -> Option<u8> {
        Some(self.slot).filter(|slot| (1..=walk::MAX_PLAYER_SLOT).contains(slot))
    }
}

struct Resource {
    object: usize,
    kind: Kind,
    tile: (u16, u16),
    owner: u8,
    costs: Vec<Option<u32>>,
}

type GroupsByStart = Vec<Vec<(u32, usize)>>;

struct Group {
    kind: Kind,
    members: Vec<usize>,
    tile: (u16, u16),
}

struct Shared<'a> {
    input: &'a MeasureInput<'a>,
    stop: &'a dyn StopCheck,
    width: usize,
    height: usize,
    starts: Vec<Start>,
    fields: OnceCell<Result<Vec<Field>, String>>,
    clearing_fields: OnceCell<Result<Vec<Field>, String>>,
    start_tiles: OnceCell<Result<Vec<Vec<usize>>, String>>,
    placed_for: OnceCell<Vec<Option<usize>>>,
    resources: OnceCell<Result<Vec<Resource>, String>>,
    groups: OnceCell<Vec<Group>>,
    trees: OnceCell<Vec<bool>>,
    woodlines: OnceCell<Vec<Vec<usize>>>,
    big_water: OnceCell<Vec<bool>>,
}

fn tile_of(map: &GeneratedMap, object: &PlacedObject) -> (u16, u16) {
    (
        ((object.x_256 / 256) as u16).min(map.dimensions.width.saturating_sub(1)),
        ((object.y_256 / 256) as u16).min(map.dimensions.height.saturating_sub(1)),
    )
}

fn spread(values: &[i64]) -> i64 {
    match (values.iter().max(), values.iter().min()) {
        (Some(max), Some(min)) => max - min,
        _ => 0,
    }
}

fn spread_percent(values: &[i64]) -> i64 {
    let max = values.iter().copied().max().unwrap_or(0);
    let min = values.iter().copied().min().unwrap_or(0);
    if max <= 0 { 0 } else { (max - min) * 100 / max }
}

fn tiles_of(cost: Option<u32>) -> i64 {
    cost.map_or(UNREACHABLE_TILES, |cost| {
        i64::from(walk::whole_tiles(cost)).min(UNREACHABLE_TILES)
    })
}

fn arg_min(values: &[i64]) -> Option<usize> {
    values
        .iter()
        .enumerate()
        .min_by_key(|&(index, value)| (*value, index))
        .map(|(index, _)| index)
}

fn arg_max(values: &[i64]) -> Option<usize> {
    values
        .iter()
        .enumerate()
        .max_by_key(|&(index, value)| (*value, std::cmp::Reverse(index)))
        .map(|(index, _)| index)
}

const EIGHT: [(i32, i32); 8] = [
    (0, -1),
    (1, 0),
    (0, 1),
    (-1, 0),
    (1, -1),
    (1, 1),
    (-1, 1),
    (-1, -1),
];

impl<'a> Shared<'a> {
    fn new(input: &'a MeasureInput<'a>, stop: &'a dyn StopCheck) -> Self {
        let map = input.map;
        let starts = input
            .players
            .iter()
            .filter(|player| player.start != StartKind::None)
            .filter_map(|player| {
                let place = player_place(player)?;
                let centre = match place {
                    Place::Tile { x, y } => (f64::from(x) + 0.5, f64::from(y) + 0.5),
                    Place::Object { x_256, y_256, .. } => {
                        (f64::from(x_256) / 256.0, f64::from(y_256) / 256.0)
                    }
                };
                let tile = player.start_tile.unwrap_or((
                    (centre.0 as u16).min(map.dimensions.width.saturating_sub(1)),
                    (centre.1 as u16).min(map.dimensions.height.saturating_sub(1)),
                ));
                Some(Start {
                    slot: player.slot,
                    team: player.team,
                    place,
                    centre,
                    tile,
                })
            })
            .collect();
        Self {
            input,
            stop,
            width: usize::from(map.dimensions.width),
            height: usize::from(map.dimensions.height),
            starts,
            fields: OnceCell::new(),
            clearing_fields: OnceCell::new(),
            start_tiles: OnceCell::new(),
            placed_for: OnceCell::new(),
            resources: OnceCell::new(),
            groups: OnceCell::new(),
            trees: OnceCell::new(),
            woodlines: OnceCell::new(),
            big_water: OnceCell::new(),
        }
    }

    fn map(&self) -> &'a GeneratedMap {
        self.input.map
    }

    fn without_start(&self) -> bool {
        self.input
            .players
            .iter()
            .any(|player| player.start == StartKind::None)
    }

    fn startless_record(&self, slot: Option<u8>) -> bool {
        slot.is_some_and(|slot| {
            self.input
                .players
                .iter()
                .any(|player| player.slot == slot && player.start == StartKind::None)
        })
    }

    fn walk(&self) -> Result<(&'a WalkRules, &'a WalkGrid)> {
        self.input
            .walk
            .ok_or_else(|| anyhow::anyhow!("the quality check needs the walk rules for this case"))
    }

    fn index(&self, (x, y): (u16, u16)) -> usize {
        usize::from(y) * self.width + usize::from(x)
    }

    fn position(&self, index: usize) -> (u16, u16) {
        ((index % self.width) as u16, (index / self.width) as u16)
    }

    fn neighbours(&self, index: usize) -> impl Iterator<Item = usize> + '_ {
        let (x, y) = ((index % self.width) as i32, (index / self.width) as i32);
        EIGHT.iter().filter_map(move |(dx, dy)| {
            let (nx, ny) = (x + dx, y + dy);
            (nx >= 0 && ny >= 0 && (nx as usize) < self.width && (ny as usize) < self.height)
                .then(|| ny as usize * self.width + nx as usize)
        })
    }

    fn four(&self, index: usize) -> impl Iterator<Item = usize> + '_ {
        let (x, y) = ((index % self.width) as i32, (index / self.width) as i32);
        EIGHT[..4].iter().filter_map(move |(dx, dy)| {
            let (nx, ny) = (x + dx, y + dy);
            (nx >= 0 && ny >= 0 && (nx as usize) < self.width && (ny as usize) < self.height)
                .then(|| ny as usize * self.width + nx as usize)
        })
    }

    fn start_tiles(&self) -> Result<&Vec<Vec<usize>>> {
        self.start_tiles
            .get_or_init(|| {
                let (rules, grid) = self.walk().map_err(|error| error.to_string())?;
                self.starts
                    .iter()
                    .map(|start| {
                        place_tiles(rules, grid, &grid.walker(start.open_for()), &[start.place])
                            .map_err(|error| error.to_string())
                    })
                    .collect()
            })
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }

    fn fields(&self) -> Result<&Vec<Field>> {
        let tiles = self.start_tiles()?;
        self.fields
            .get_or_init(|| {
                let (_, grid) = self.walk().map_err(|error| error.to_string())?;
                self.starts
                    .iter()
                    .zip(tiles)
                    .map(|(start, tiles)| {
                        walk::distance_field(&grid.walker(start.open_for()), tiles, None, self.stop)
                            .map_err(|error| format!("{error:#}"))
                    })
                    .collect()
            })
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }

    fn clearing_fields(&self) -> Result<&Vec<Field>> {
        let tiles = self.start_tiles()?;
        self.clearing_fields
            .get_or_init(|| {
                let (_, grid) = self.walk().map_err(|error| error.to_string())?;
                let trees = self.trees();
                self.starts
                    .iter()
                    .zip(tiles)
                    .map(|(start, tiles)| {
                        walk::distance_field(
                            &grid.clearing_walker(start.open_for(), trees),
                            tiles,
                            Some(cost_within(BASE_RADIUS)),
                            self.stop,
                        )
                        .map_err(|error| format!("{error:#}"))
                    })
                    .collect()
            })
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }

    fn closed_starts(&self) -> Result<bool> {
        let fields = self.fields()?;
        let tiles = self.width * self.height;
        let closed = fields
            .iter()
            .filter(|field| {
                (0..tiles)
                    .filter(|&tile| field.cost(tile).is_some())
                    .take(CLOSED_START_TILES)
                    .count()
                    < CLOSED_START_TILES
            })
            .count();
        Ok(closed * 2 > fields.len())
    }

    fn walk_measured(&self) -> Result<bool> {
        Ok(self.starts.len() >= 2 && !self.closed_starts()?)
    }

    fn placed_for(&self) -> &Vec<Option<usize>> {
        self.placed_for.get_or_init(|| {
            let map = self.map();
            let start_of = |slot: u8| self.starts.iter().position(|start| start.slot == slot);
            let mut records = BTreeMap::<u32, Vec<(u8, u32)>>::new();
            for record in &map.placement_records {
                records
                    .entry(record.operation_index)
                    .or_default()
                    .push((record.player_slot.unwrap_or(0), record.objects_created));
            }
            records.retain(|_, parts| parts.iter().any(|(slot, _)| *slot >= 1));
            let mut by_operation = BTreeMap::<u32, Vec<usize>>::new();
            for (index, operation) in map.object_operation_indices.iter().enumerate() {
                if records.contains_key(operation) {
                    by_operation.entry(*operation).or_default().push(index);
                }
            }
            let mut placed = map
                .objects
                .iter()
                .map(|object| start_of(object.owner).filter(|_| object.owner >= 1))
                .collect::<Vec<_>>();
            for (operation, objects) in by_operation {
                let parts = &records[&operation];
                let created = parts
                    .iter()
                    .map(|(_, count)| *count as usize)
                    .sum::<usize>();
                if created == objects.len() {
                    let mut next = objects.iter();
                    for &(slot, count) in parts {
                        for &object in next.by_ref().take(count as usize) {
                            if placed[object].is_none() && slot >= 1 {
                                placed[object] = start_of(slot);
                            }
                        }
                    }
                } else {
                    for object in objects {
                        if placed[object].is_none() {
                            let (x, y) = tile_of(map, &map.objects[object]);
                            placed[object] = self.nearest_start((x, y));
                        }
                    }
                }
            }
            placed
        })
    }

    fn nearest_start(&self, (x, y): (u16, u16)) -> Option<usize> {
        let centre = (f64::from(x) + 0.5, f64::from(y) + 0.5);
        (0..self.starts.len()).min_by(|left, right| {
            let distance =
                |start: &Start| (start.centre.0 - centre.0).hypot(start.centre.1 - centre.1);
            distance(&self.starts[*left])
                .total_cmp(&distance(&self.starts[*right]))
                .then(left.cmp(right))
        })
    }

    fn object_tiles(&self, walker: &walk::Walker<'_>, object: &PlacedObject) -> Vec<usize> {
        let map = self.map();
        let (x, y) = tile_of(map, object);
        let rectangle = self
            .input
            .walk
            .and_then(|(rules, _)| rules.object(object.object_id.0).ok())
            .map_or((x, y, x, y), |rule| {
                rule.covered(
                    object.x_256,
                    object.y_256,
                    map.dimensions.width,
                    map.dimensions.height,
                )
            });
        walker.place_tiles(rectangle)
    }

    fn resources(&self) -> Result<&Vec<Resource>> {
        let fields = self.fields()?;
        self.resources
            .get_or_init(|| {
                let (_, grid) = self.walk().map_err(|error| error.to_string())?;
                let walkers = self
                    .starts
                    .iter()
                    .map(|start| grid.walker(start.open_for()))
                    .collect::<Vec<_>>();
                let map = self.map();
                let mut resources = Vec::new();
                for (index, object) in map.objects.iter().enumerate() {
                    let Some(kind) = self.input.content.kind(object) else {
                        continue;
                    };
                    if matches!(kind, Kind::Tree | Kind::DeepFish) {
                        continue;
                    }
                    if index.is_multiple_of(crate::HOST_CHECK_INTERVAL) {
                        self.stop.check().map_err(|error| error.to_string())?;
                    }
                    let costs = walkers
                        .iter()
                        .zip(fields)
                        .map(|(walker, field)| field.least(&self.object_tiles(walker, object)))
                        .collect();
                    resources.push(Resource {
                        object: index,
                        kind,
                        tile: tile_of(map, object),
                        owner: object.owner,
                        costs,
                    });
                }
                Ok(resources)
            })
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }

    fn in_base(costs: &[Option<u32>], start: usize) -> bool {
        let Some(cost) = costs[start] else {
            return false;
        };
        cost <= cost_within(BASE_RADIUS)
            && costs.iter().enumerate().all(|(other, other_cost)| {
                other == start
                    || other_cost
                        .is_none_or(|other_cost| other_cost > cost + BASE_MARGIN * STRAIGHT_COST)
            })
    }

    fn groups(&self) -> Result<&Vec<Group>> {
        let resources = self.resources()?;
        Ok(self.groups.get_or_init(|| group_resources(resources)))
    }

    fn trees(&self) -> &Vec<bool> {
        self.trees.get_or_init(|| {
            let map = self.map();
            let mut trees = vec![false; map.terrain.len()];
            for appearance in &map.appearance_objects {
                if appearance.tree {
                    let x = ((appearance.x_256 / 256) as usize).min(self.width - 1);
                    let y = ((appearance.y_256 / 256) as usize).min(self.height - 1);
                    trees[y * self.width + x] = true;
                }
            }
            for object in &map.objects {
                if self.input.content.class(object) == Some(TREE_CLASS) {
                    let index = self.index(tile_of(map, object));
                    trees[index] = true;
                }
            }
            trees
        })
    }

    fn components(
        &self,
        member: impl Fn(usize) -> bool,
        diagonal: bool,
        minimum: usize,
    ) -> Vec<Vec<usize>> {
        let tiles = self.width * self.height;
        let mut seen = vec![false; tiles];
        let mut result = Vec::new();
        for start in 0..tiles {
            if seen[start] || !member(start) {
                continue;
            }
            seen[start] = true;
            let mut members = vec![start];
            let mut next = 0;
            while next < members.len() {
                let tile = members[next];
                next += 1;
                let around = if diagonal {
                    self.neighbours(tile).collect::<Vec<_>>()
                } else {
                    self.four(tile).collect::<Vec<_>>()
                };
                for neighbour in around {
                    if !seen[neighbour] && member(neighbour) {
                        seen[neighbour] = true;
                        members.push(neighbour);
                    }
                }
            }
            if members.len() >= minimum {
                result.push(members);
            }
        }
        result
    }

    fn woodlines(&self) -> &Vec<Vec<usize>> {
        self.woodlines.get_or_init(|| {
            let trees = self.trees();
            self.components(|tile| trees[tile], true, WOODLINE_TILES)
        })
    }

    fn big_water(&self) -> &Vec<bool> {
        self.big_water.get_or_init(|| {
            let map = self.map();
            let mut big = vec![false; map.terrain.len()];
            for body in self.components(
                |tile| self.input.content.water(map, tile),
                false,
                WATER_BODY_TILES,
            ) {
                for tile in body {
                    big[tile] = true;
                }
            }
            big
        })
    }

    fn beside_cost(&self, field: &Field, tile: usize) -> Option<u32> {
        self.neighbours(tile)
            .filter_map(|neighbour| field.cost(neighbour))
            .min()
    }

    fn nearest_opponents(&self) -> Vec<Option<usize>> {
        self.starts
            .iter()
            .map(|start| {
                self.starts
                    .iter()
                    .enumerate()
                    .filter(|(_, other)| start.opposes(other))
                    .min_by(|(left_index, left), (right_index, right)| {
                        start
                            .distance(left)
                            .total_cmp(&start.distance(right))
                            .then(left_index.cmp(right_index))
                    })
                    .map(|(index, _)| index)
            })
            .collect()
    }

    fn start_marks(&self, index: usize) -> Option<(u16, u16)> {
        self.starts.get(index).map(|start| start.tile)
    }

    fn generation(&self) -> CaseMeasure {
        let map = self.map();
        let without_start = self
            .input
            .players
            .iter()
            .filter(|player| player.start == StartKind::None)
            .count() as i64;
        let content = self.input.content;
        let played = map
            .objects
            .iter()
            .zip(&map.object_operation_indices)
            .filter(|(object, _)| {
                content
                    .kind(object)
                    .is_some_and(|kind| kind != Kind::Predator)
                    || (object.owner != 0 && content.played_with(object.object_id.0))
            })
            .map(|(_, operation)| *operation)
            .collect::<HashSet<_>>();
        let mut per_command = BTreeMap::<u32, Vec<u32>>::new();
        for record in &map.placement_records {
            if record.player_slot.is_some()
                && !self.startless_record(record.player_slot)
                && played.contains(&record.operation_index)
            {
                per_command
                    .entry(record.operation_index)
                    .or_default()
                    .push(record.groups_placed);
            }
        }
        let uneven = per_command
            .values()
            .filter(|placed| placed.iter().any(|count| *count != placed[0]))
            .count() as i64;
        let short = map
            .placement_records
            .iter()
            .filter(|record| {
                record.groups_placed < record.groups_requested
                    && !self.startless_record(record.player_slot)
            })
            .count() as i64;
        let gaia_buildings = map
            .objects
            .iter()
            .filter(|object| {
                object.owner == 0
                    && self.input.content.class(object).is_some_and(|class| {
                        matches!(
                            class,
                            BUILDING_CLASS | TOWER_CLASS | WALL_CLASS | GATE_CLASS
                        )
                    })
            })
            .map(|object| {
                let (x, y) = tile_of(map, object);
                (x, y, 0)
            })
            .collect::<Vec<_>>();
        CaseMeasure::rows(vec![
            Row::new("failed-generation", 0),
            Row::new("game-crash", 0),
            Row::new("player-without-start", without_start).players(
                self.input
                    .players
                    .iter()
                    .map(|player| i64::from(player.start == StartKind::None))
                    .collect(),
            ),
            Row::new("uneven-placement", uneven),
            Row::new("objects-not-placed", short),
            Row::new("generation-warnings", map.warnings.len() as i64),
            Row::new("gaia-buildings", gaia_buildings.len() as i64).tiles(gaia_buildings),
            Row::new(
                "placement-records-omitted",
                i64::from(map.omitted_placement_records),
            ),
        ])
    }

    fn start_resources(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let resources = self.resources()?;
        let map = self.map();
        let mut rows = Vec::new();
        let own_kinds = self.own_kinds(resources);
        let counted = |resource: &Resource, start: usize| self.counted(&own_kinds, resource, start);
        for (code, kind) in [
            ("start-gold", Kind::Gold),
            ("start-stone", Kind::Stone),
            ("start-berries", Kind::Berries),
            ("start-hunt", Kind::Hunt),
            ("start-herdables", Kind::Herdables),
        ] {
            let counts = (0..self.starts.len())
                .map(|start| {
                    resources
                        .iter()
                        .filter(|resource| resource.kind == kind && counted(resource, start))
                        .count() as i64
                })
                .collect::<Vec<_>>();
            let fewest = arg_min(&counts).and_then(|start| self.start_marks(start));
            rows.push(Row::new(code, spread(&counts)).players(counts).mark(fewest));
        }
        let predators = resources
            .iter()
            .filter(|resource| resource.kind == Kind::Predator)
            .collect::<Vec<_>>();
        if !predators.is_empty() {
            let counts = (0..self.starts.len())
                .map(|start| {
                    predators
                        .iter()
                        .filter(|resource| Self::in_base(&resource.costs, start))
                        .count() as i64
                })
                .collect::<Vec<_>>();
            let nearest = predators
                .iter()
                .filter_map(|resource| {
                    resource
                        .costs
                        .iter()
                        .flatten()
                        .min()
                        .map(|cost| (*cost, resource.tile))
                })
                .min();
            rows.push(
                Row::new("start-predators", spread(&counts))
                    .players(counts)
                    .aux(tiles_of(nearest.map(|(cost, _)| cost)))
                    .mark(nearest.map(|(_, tile)| tile)),
            );
        }
        rows.extend(self.owned_rows());
        let totals = (0..self.starts.len())
            .map(|start| {
                resources
                    .iter()
                    .filter(|resource| counted(resource, start))
                    .map(|resource| {
                        let object = &map.objects[resource.object];
                        if matches!(object.resource_type, FOOD | GOLD | STONE) {
                            quantity(object).max(0.0).round() as i64
                        } else {
                            0
                        }
                    })
                    .sum::<i64>()
            })
            .collect::<Vec<_>>();
        let fewest = arg_min(&totals).and_then(|start| self.start_marks(start));
        rows.push(
            Row::new("resource-totals", spread_percent(&totals))
                .players(totals)
                .mark(fewest),
        );
        Ok(CaseMeasure::rows(rows))
    }

    fn own_kinds(&self, resources: &[Resource]) -> HashSet<Kind> {
        let placed_for = self.placed_for();
        resources
            .iter()
            .filter(|resource| placed_for[resource.object].is_some())
            .map(|resource| resource.kind)
            .collect()
    }

    fn counted(&self, own_kinds: &HashSet<Kind>, resource: &Resource, start: usize) -> bool {
        if own_kinds.contains(&resource.kind) {
            self.placed_for()[resource.object] == Some(start)
                && resource.costs[start].is_some_and(|cost| {
                    !resource
                        .costs
                        .iter()
                        .enumerate()
                        .any(|(other, other_cost)| {
                            self.starts[start].opposes(&self.starts[other])
                                && other_cost.is_some_and(|other_cost| {
                                    other_cost <= cost_within(BASE_RADIUS)
                                        && other_cost + BASE_MARGIN * STRAIGHT_COST < cost
                                })
                        })
                })
        } else {
            resource.owner == 0 && Self::in_base(&resource.costs, start)
        }
    }

    fn owned_rows(&self) -> [Row; 2] {
        let map = self.map();
        let content = self.input.content;
        let mut owned = BTreeMap::<u32, Vec<i64>>::new();
        let mut families = vec![[0_i64; 3]; self.starts.len()];
        for object in map
            .objects
            .iter()
            .filter(|object| content.played_with(object.object_id.0))
        {
            let Some(start) = self
                .starts
                .iter()
                .position(|start| start.slot == object.owner && object.owner >= 1)
            else {
                continue;
            };
            owned
                .entry(object.object_id.0)
                .or_insert_with(|| vec![0; self.starts.len()])[start] += 1;
            if let Some(family) = content.family(object.object_id.0) {
                families[start][family as usize] += 1;
            }
        }
        let totals = (0..self.starts.len())
            .map(|start| owned.values().map(|counts| counts[start]).sum())
            .collect::<Vec<i64>>();
        let differing = owned
            .iter()
            .filter(|(_, counts)| spread(counts) > 0)
            .map(|(id, _)| *id)
            .collect::<HashSet<_>>();
        let tiles = map
            .objects
            .iter()
            .filter(|object| differing.contains(&object.object_id.0) && object.owner >= 1)
            .map(|object| {
                let (x, y) = tile_of(map, object);
                (x, y, object.owner)
            })
            .collect::<Vec<_>>();
        let fewest = arg_min(&totals).and_then(|start| self.start_marks(start));
        let missing = (0..3)
            .filter(|&family| {
                families.iter().any(|counts| counts[family] > 0)
                    && families.iter().any(|counts| counts[family] == 0)
            })
            .count() as i64;
        let lacking = families
            .iter()
            .map(|counts| counts.iter().filter(|count| **count > 0).count() as i64)
            .collect::<Vec<_>>();
        let poorest = arg_min(&lacking).and_then(|start| self.start_marks(start));
        [
            Row::new("owned-objects", spread(&totals))
                .players(totals)
                .mark(fewest)
                .tiles(tiles),
            Row::new("missing-start-objects", missing)
                .players(lacking)
                .mark(poorest),
        ]
    }

    fn nearest_groups(&self, kind: Kind) -> Result<GroupsByStart> {
        let resources = self.resources()?;
        let groups = self.groups()?;
        Ok((0..self.starts.len())
            .map(|start| {
                let mut found = groups
                    .iter()
                    .enumerate()
                    .filter(|(_, group)| group.kind == kind)
                    .filter_map(|(index, group)| {
                        group
                            .members
                            .iter()
                            .filter_map(|&member| resources[member].costs[start])
                            .min()
                            .map(|cost| (cost, index))
                    })
                    .collect::<Vec<_>>();
                found.sort_unstable();
                found
            })
            .collect())
    }

    fn own_groups(&self, kind: Kind) -> Result<Option<GroupsByStart>> {
        let resources = self.resources()?;
        let groups = self.groups()?;
        let placed_for = self.placed_for();
        let mut own = vec![Vec::new(); self.starts.len()];
        let mut any = false;
        for (index, group) in groups.iter().enumerate() {
            if group.kind != kind {
                continue;
            }
            let mut votes = BTreeMap::<Option<usize>, usize>::new();
            for &member in &group.members {
                *votes
                    .entry(placed_for[resources[member].object])
                    .or_default() += 1;
            }
            let Some((Some(start), _)) = votes
                .iter()
                .max_by_key(|(owner, count)| (**count, std::cmp::Reverse(**owner)))
                .map(|(owner, count)| (*owner, *count))
            else {
                continue;
            };
            any = true;
            if let Some(cost) = group
                .members
                .iter()
                .filter_map(|&member| resources[member].costs[start])
                .min()
            {
                own[start].push((cost, index));
            }
        }
        for found in &mut own {
            found.sort_unstable();
        }
        Ok(any.then_some(own))
    }

    fn resource_distances(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let groups = self.groups()?;
        let mut rows = Vec::new();
        let mut nearest_by_kind = BTreeMap::new();
        for (code, kind) in [
            ("nearest-gold", Kind::Gold),
            ("nearest-stone", Kind::Stone),
            ("nearest-berries", Kind::Berries),
            ("nearest-hunt", Kind::Hunt),
        ] {
            let (nearest, ranks) = match self.own_groups(kind)? {
                Some(own) => (own, 2),
                None => (self.nearest_groups(kind)?, 1),
            };
            nearest_by_kind.insert(kind, nearest.clone());
            let mut value = None;
            for rank in 0..ranks {
                if nearest.iter().all(|found| found.len() > rank) {
                    let distances = nearest
                        .iter()
                        .map(|found| tiles_of(Some(found[rank].0)).min(i64::from(BASE_RADIUS)))
                        .collect::<Vec<_>>();
                    value = Some(value.unwrap_or(0).max(spread(&distances)));
                }
            }
            let Some(value) = value else {
                continue;
            };
            let first = nearest
                .iter()
                .map(|found| tiles_of(found.first().map(|(cost, _)| *cost)))
                .collect::<Vec<_>>();
            let farthest = arg_max(&first).unwrap_or(0);
            let mark = nearest[farthest]
                .first()
                .map(|(_, group)| groups[*group].tile)
                .or_else(|| self.start_marks(farthest));
            rows.push(Row::new(code, value).players(first).mark(mark));
        }
        let opponents = self.nearest_opponents();
        if opponents.iter().all(Option::is_some) {
            let fields = self.fields()?;
            let woodlines = self.woodlines();
            let mut nearest = Vec::new();
            for kind in [Kind::Gold, Kind::Stone, Kind::Berries] {
                nearest.push(match nearest_by_kind.remove(&kind) {
                    Some(found) => found,
                    None => self.nearest_groups(kind)?,
                });
            }
            let mut patterns = Vec::new();
            for (start, opponent) in opponents.iter().enumerate() {
                let opponent = &self.starts[opponent.expect("checked above")];
                let own = &self.starts[start];
                let towards = (
                    opponent.centre.0 - own.centre.0,
                    opponent.centre.1 - own.centre.1,
                );
                let sector = |tile: Option<(u16, u16)>| -> i64 {
                    let Some((x, y)) = tile else {
                        return 0;
                    };
                    let along = (
                        f64::from(x) + 0.5 - own.centre.0,
                        f64::from(y) + 0.5 - own.centre.1,
                    );
                    let lengths = (along.0.hypot(along.1)) * towards.0.hypot(towards.1);
                    if lengths == 0.0 {
                        return 2;
                    }
                    let cosine = (along.0 * towards.0 + along.1 * towards.1) / lengths;
                    if cosine > 0.5 {
                        1
                    } else if cosine < -0.5 {
                        3
                    } else {
                        2
                    }
                };
                let mut pattern = Vec::new();
                for nearest in &nearest {
                    pattern.push(sector(
                        nearest[start].first().map(|(_, group)| groups[*group].tile),
                    ));
                }
                let woodline = woodlines
                    .iter()
                    .flat_map(|woodline| woodline.iter())
                    .filter_map(|&tile| {
                        self.beside_cost(&fields[start], tile)
                            .map(|cost| (cost, tile))
                    })
                    .min();
                pattern.push(sector(woodline.map(|(_, tile)| self.position(tile))));
                patterns.push(pattern);
            }
            let differing = (0..4)
                .filter(|&kind| {
                    patterns.iter().any(|pattern| pattern[kind] == 1)
                        && patterns.iter().any(|pattern| pattern[kind] == 3)
                })
                .count() as i64;
            rows.push(
                Row::new("front-back", differing).players(
                    patterns
                        .iter()
                        .map(|pattern| pattern.iter().fold(0, |code, sector| code * 10 + sector))
                        .collect(),
                ),
            );
        }
        Ok(CaseMeasure::rows(rows))
    }

    fn shared_resources(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let resources = self.resources()?;
        let fields = self.fields()?;
        let placed_for = self.placed_for();
        let starts = self.starts.len();
        let mut group_of = vec![0; resources.len()];
        for (group, members) in self.groups()?.iter().enumerate() {
            for &member in &members.members {
                group_of[member] = group;
            }
        }
        let mut assigned = vec![Vec::<(u32, usize)>::new(); starts];
        let mut by_kind = BTreeMap::<Kind, Vec<i64>>::new();
        let mut neutral = BTreeMap::<Kind, i64>::new();
        for (index, resource) in resources.iter().enumerate() {
            if resource.owner != 0
                || placed_for[resource.object].is_some()
                || !matches!(
                    resource.kind,
                    Kind::Gold | Kind::Stone | Kind::Relic | Kind::Hunt
                )
            {
                continue;
            }
            *neutral.entry(resource.kind).or_default() += 1;
            let mut order = resource
                .costs
                .iter()
                .enumerate()
                .filter_map(|(start, cost)| cost.map(|cost| (cost, start)))
                .collect::<Vec<_>>();
            order.sort_unstable();
            let Some(&(best, start)) = order.first() else {
                continue;
            };
            if order
                .get(1)
                .is_some_and(|&(second, _)| second <= best + BASE_MARGIN * STRAIGHT_COST)
            {
                continue;
            }
            assigned[start].push((best, index));
            by_kind
                .entry(resource.kind)
                .or_insert_with(|| vec![0; starts])[start] += 1;
        }
        let mut rows = Vec::new();
        for (code, kind) in [
            ("neutral-gold", Kind::Gold),
            ("neutral-stone", Kind::Stone),
            ("neutral-relics", Kind::Relic),
            ("neutral-hunt", Kind::Hunt),
        ] {
            let Some(&total) = neutral.get(&kind) else {
                continue;
            };
            let counts = by_kind
                .get(&kind)
                .cloned()
                .unwrap_or_else(|| vec![0; starts]);
            let most = arg_max(&counts).unwrap_or(0);
            let mark = assigned[most]
                .iter()
                .filter(|(_, index)| resources[*index].kind == kind)
                .max_by_key(|(cost, index)| (*cost, std::cmp::Reverse(*index)))
                .map(|(_, index)| resources[*index].tile);
            let groups = assigned
                .iter()
                .map(|got| {
                    got.iter()
                        .filter(|(_, index)| resources[*index].kind == kind)
                        .map(|(_, index)| group_of[*index])
                        .collect::<BTreeSet<_>>()
                        .len() as i64
                })
                .collect::<Vec<_>>();
            let value = if spread(&groups) < 2 {
                0
            } else {
                self.uneven_share(&counts, total)
            };
            rows.push(Row::new(code, value).players(counts).mark(mark));
        }
        let totals = assigned
            .iter()
            .map(|got| got.len() as i64)
            .collect::<Vec<_>>();
        let most = totals.iter().copied().max().unwrap_or(0);
        let favoured = (most > 0 && totals.iter().filter(|total| **total == most).count() == 1)
            .then(|| self.starts[arg_max(&totals).unwrap_or(0)].slot);
        let mut contested = Vec::<(i64, i64, Option<(u16, u16)>)>::new();
        let relics = resources
            .iter()
            .filter(|resource| resource.kind == Kind::Relic)
            .collect::<Vec<_>>();
        if !relics.is_empty() {
            let nearest = (0..starts)
                .map(|start| {
                    relics
                        .iter()
                        .filter_map(|relic| relic.costs[start].map(|cost| (cost, relic.tile)))
                        .min()
                })
                .collect::<Vec<_>>();
            if nearest.iter().all(Option::is_some) {
                let distances = nearest
                    .iter()
                    .map(|found| tiles_of(found.map(|(cost, _)| cost)))
                    .collect::<Vec<_>>();
                let closest = arg_min(&distances).unwrap_or(0);
                contested.push((
                    spread(&distances),
                    distances.iter().sum::<i64>() / starts as i64,
                    nearest[closest].map(|(_, tile)| tile),
                ));
            }
        }
        let (rules, grid) = self.walk()?;
        let centre = Place::Tile {
            x: (self.width / 2) as u32,
            y: (self.height / 2) as u32,
        };
        let distances = self
            .starts
            .iter()
            .zip(fields)
            .map(|(start, field)| {
                let tiles = place_tiles(rules, grid, &grid.walker(start.open_for()), &[centre])?;
                Ok(field.least(&tiles))
            })
            .collect::<Result<Vec<_>>>()?;
        if distances.iter().all(Option::is_some) {
            let distances = distances.into_iter().map(tiles_of).collect::<Vec<_>>();
            contested.push((
                spread(&distances),
                distances.iter().sum::<i64>() / starts as i64,
                Some(((self.width / 2) as u16, (self.height / 2) as u16)),
            ));
        }
        if let Some(&(value, mean, mark)) = contested
            .iter()
            .max_by_key(|(value, mean, _)| value * 100 - mean)
        {
            rows.push(Row::new("contested-distance", value).aux(mean).mark(mark));
        }
        Ok(CaseMeasure {
            rows,
            favoured,
            contenders: starts as u8,
            signature: None,
        })
    }

    fn uneven_share(&self, counts: &[i64], total: i64) -> i64 {
        if total <= 0 {
            return 0;
        }
        let teams = self
            .starts
            .iter()
            .map(|start| start.team)
            .collect::<BTreeSet<_>>();
        let sides = if !teams.contains(&0) && teams.len() >= 2 {
            teams
                .iter()
                .map(|team| {
                    let members = self
                        .starts
                        .iter()
                        .enumerate()
                        .filter(|(_, start)| start.team == *team)
                        .map(|(index, _)| counts[index])
                        .collect::<Vec<_>>();
                    members.iter().sum::<i64>() * 100 / members.len() as i64
                })
                .collect::<Vec<_>>()
        } else {
            counts.iter().map(|count| count * 100).collect()
        };
        spread(&sides) * self.starts.len() as i64 / total
    }

    fn wood(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let fields = self.fields()?;
        let trees = self.trees();
        let near = cost_within(WOOD_RADIUS);
        let counts = fields
            .iter()
            .map(|field| {
                trees
                    .iter()
                    .enumerate()
                    .filter(|(tile, tree)| {
                        **tree
                            && self
                                .beside_cost(field, *tile)
                                .is_some_and(|cost| cost <= near)
                    })
                    .count() as i64
            })
            .collect::<Vec<_>>();
        let fewest = arg_min(&counts).and_then(|start| self.start_marks(start));
        let woodlines = self.woodlines();
        let reach = cost_within(WOODLINE_RADIUS);
        let most = counts.iter().copied().max().unwrap_or(0);
        let has = fields
            .iter()
            .zip(&counts)
            .map(|(field, &trees)| {
                i64::from(
                    trees * 2 >= most
                        || woodlines.iter().any(|woodline| {
                            woodline.iter().any(|&tile| {
                                self.beside_cost(field, tile)
                                    .is_some_and(|cost| cost <= reach)
                            })
                        }),
                )
            })
            .collect::<Vec<_>>();
        let lacking = has
            .iter()
            .position(|has| *has == 0)
            .and_then(|start| self.start_marks(start));
        Ok(CaseMeasure::rows(vec![
            Row::new("wood-near-start", spread_percent(&counts))
                .players(counts)
                .mark(fewest),
            Row::new("missing-woodline", spread(&has))
                .players(has)
                .mark(lacking),
        ]))
    }

    fn trapped(&self) -> Result<CaseMeasure> {
        if self.starts.is_empty() || self.closed_starts()? {
            return Ok(CaseMeasure::default());
        }
        let fields = self.fields()?;
        let (_, grid) = self.walk()?;
        let map = self.map();
        let content = self.input.content;
        let clearing = self.clearing_fields()?;
        let mut own = vec![0_i64; self.starts.len()];
        let mut own_tiles = Vec::new();
        let mut enclosed = vec![Vec::<(u16, u16, u8)>::new(); self.starts.len()];
        for (start, (player, field)) in self.starts.iter().zip(fields).enumerate() {
            let walker = grid.walker(player.open_for());
            let cutting = grid.clearing_walker(player.open_for(), self.trees());
            for object in map
                .objects
                .iter()
                .filter(|object| object.owner == player.slot)
            {
                if !content.played_with(object.object_id.0)
                    || content.class(object) == Some(FARM_CLASS)
                {
                    continue;
                }
                let tile = tile_of(map, object);
                if content.water(map, self.index(tile)) || content.waterside(object.object_id.0) {
                    continue;
                }
                if field.least(&self.object_tiles(&walker, object)).is_none() {
                    if content.usable(object) {
                        own[start] += 1;
                        own_tiles.push((tile.0, tile.1, player.slot));
                    } else if clearing[start]
                        .least(&self.object_tiles(&cutting, object))
                        .is_none()
                    {
                        enclosed[start].push((tile.0, tile.1, player.slot));
                    }
                }
            }
        }
        let mut rows = Vec::new();
        if self.starts.len() >= 2 {
            let resources = self.resources()?;
            let placed_for = self.placed_for();
            let walkers = self
                .starts
                .iter()
                .map(|start| grid.clearing_walker(start.open_for(), self.trees()))
                .collect::<Vec<_>>();
            let mut trapped = vec![Vec::<(u16, u16, u8)>::new(); self.starts.len()];
            for resource in resources {
                if resource.owner != 0
                    || !matches!(
                        resource.kind,
                        Kind::Gold | Kind::Stone | Kind::Berries | Kind::Hunt | Kind::Herdables
                    )
                {
                    continue;
                }
                let object = &map.objects[resource.object];
                let cut = walkers
                    .iter()
                    .zip(clearing)
                    .map(|(walker, field)| field.least(&self.object_tiles(walker, object)))
                    .collect::<Vec<_>>();
                let tile = (resource.tile.0, resource.tile.1);
                match placed_for[resource.object] {
                    Some(start) => {
                        if resource.costs[start].is_none() && cut[start].is_some() {
                            trapped[start].push((tile.0, tile.1, self.starts[start].slot));
                        }
                    }
                    None => {
                        let nearest = (0..self.starts.len()).find(|&start| {
                            cut[start].is_some_and(|cost| {
                                cut.iter().enumerate().all(|(other, other_cost)| {
                                    other == start || other_cost.is_none_or(|other| other > cost)
                                })
                            })
                        });
                        if let Some(start) = nearest
                            && resource.costs[start].is_none()
                        {
                            trapped[start].push((tile.0, tile.1, self.starts[start].slot));
                        }
                    }
                }
            }
            let counts = trapped
                .iter()
                .map(|tiles| tiles.len() as i64)
                .collect::<Vec<_>>();
            let most = arg_max(&counts).unwrap_or(0);
            let fewest = arg_min(&counts).unwrap_or(0);
            rows.push(
                Row::new("uneven-trapped", spread(&counts))
                    .players(counts.clone())
                    .tiles(trapped[most].clone()),
            );
            rows.push(
                Row::new("trapped-resources", counts[fewest])
                    .players(counts)
                    .tiles(trapped[fewest].clone()),
            );
        }
        let fenced = self.fenced_animals()?;
        let counts = enclosed
            .iter()
            .map(|tiles| tiles.len() as i64)
            .collect::<Vec<_>>();
        let most = arg_max(&counts).unwrap_or(0);
        let fewest = arg_min(&counts).unwrap_or(0);
        rows.insert(
            0,
            Row::new("own-object-trapped", own.iter().sum())
                .players(own)
                .tiles(own_tiles),
        );
        rows.push(
            Row::new("uneven-enclosed", spread(&counts))
                .players(counts.clone())
                .tiles(enclosed[most].clone()),
        );
        rows.push(
            Row::new("enclosed-own-objects", counts[fewest])
                .players(counts)
                .tiles(enclosed[fewest].clone()),
        );
        let counts = fenced
            .iter()
            .map(|tiles| tiles.len() as i64)
            .collect::<Vec<_>>();
        let most = arg_max(&counts).unwrap_or(0);
        rows.push(
            Row::new("fenced-animals", counts[most])
                .players(counts)
                .tiles(fenced[most].clone()),
        );
        Ok(CaseMeasure::rows(rows))
    }

    fn fenced_animals(&self) -> Result<Vec<Vec<(u16, u16, u8)>>> {
        let (rules, grid) = self.walk()?;
        let resources = self.resources()?;
        let own_kinds = self.own_kinds(resources);
        let map = self.map();
        let content = self.input.content;
        let near = cost_within(BASE_RADIUS);
        let mut fenced = vec![Vec::new(); self.starts.len()];
        for (start, player) in self.starts.iter().enumerate() {
            self.stop.check()?;
            let animals = resources
                .iter()
                .filter(|resource| {
                    matches!(resource.kind, Kind::Herdables | Kind::Hunt)
                        && resource.costs[start].is_some_and(|cost| cost <= near)
                        && self.counted(&own_kinds, resource, start)
                })
                .collect::<Vec<_>>();
            if animals.is_empty() || player.slot == 0 {
                continue;
            }
            let mut closed = vec![false; grid.tile_count()];
            let mut buildings = false;
            for object in map.objects.iter().filter(|object| {
                object.owner == player.slot
                    && !content
                        .class(object)
                        .is_some_and(|class| matches!(class, WALL_CLASS | GATE_CLASS))
            }) {
                let Ok(rule) = rules.object(object.object_id.0) else {
                    continue;
                };
                if rule.blocking != Blocking::Owned {
                    continue;
                }
                let (x0, y0, x1, y1) = rule.covered(
                    object.x_256,
                    object.y_256,
                    map.dimensions.width,
                    map.dimensions.height,
                );
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        closed[self.index((x, y))] = true;
                    }
                }
                buildings = true;
            }
            if !buildings {
                continue;
            }
            let walker = grid.closing_walker(player.open_for(), &closed);
            let sources = place_tiles(rules, grid, &walker, &[player.place])?;
            let field = walk::distance_field(
                &walker,
                &sources,
                Some(cost_within(2 * BASE_RADIUS)),
                self.stop,
            )?;
            for animal in animals {
                if closed[self.index(animal.tile)] {
                    continue;
                }
                let object = &map.objects[animal.object];
                if field.least(&self.object_tiles(&walker, object)).is_none() {
                    fenced[start].push((animal.tile.0, animal.tile.1, player.slot));
                }
            }
        }
        Ok(fenced)
    }

    fn paths(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let fields = self.fields()?;
        let (rules, grid) = self.walk()?;
        let count = self.starts.len();
        let mut distance = vec![vec![None; count]; count];
        for (from, start) in self.starts.iter().enumerate() {
            let walker = grid.walker(start.open_for());
            for (to, other) in self.starts.iter().enumerate() {
                if from != to {
                    let tiles = place_tiles(rules, grid, &walker, &[other.place])?;
                    distance[from][to] = fields[from].least(&tiles);
                }
            }
        }
        let mut cut_off = 0;
        let mut cut_tiles = Vec::new();
        let pairs = (0..count).flat_map(|from| (from + 1..count).map(move |to| (from, to)));
        for (from, to) in pairs {
            if distance[from][to].is_none() || distance[to][from].is_none() {
                cut_off += 1;
                let (x, y) = self.starts[to].tile;
                cut_tiles.push((x, y, self.starts[to].slot));
            }
        }
        let mut rows = vec![Row::new("players-cut-off", cut_off).tiles(cut_tiles)];
        let nearest = |related: &dyn Fn(&Start, &Start) -> bool| {
            (0..count)
                .map(|from| {
                    (0..count)
                        .filter(|&to| related(&self.starts[from], &self.starts[to]))
                        .filter_map(|to| distance[from][to])
                        .min()
                        .map(|cost| tiles_of(Some(cost)))
                })
                .collect::<Vec<_>>()
        };
        for (code, values) in [
            ("rush-distance", nearest(&|from, to| from.opposes(to))),
            ("ally-distance", nearest(&|from, to| from.allied(to))),
        ] {
            let known = values.iter().flatten().copied().collect::<Vec<_>>();
            if known.len() >= 2 {
                let farthest = arg_max(
                    &values
                        .iter()
                        .map(|value| value.unwrap_or(-1))
                        .collect::<Vec<_>>(),
                );
                rows.push(
                    Row::new(code, spread_percent(&known))
                        .players(values.iter().map(|value| value.unwrap_or(0)).collect())
                        .mark(farthest.and_then(|start| self.start_marks(start))),
                );
            }
        }
        Ok(CaseMeasure::rows(rows))
    }

    fn building_space(&self) -> Result<CaseMeasure> {
        if !self.walk_measured()? {
            return Ok(CaseMeasure::default());
        }
        let fields = self.fields()?;
        let (_, grid) = self.walk()?;
        let mut rows = Vec::new();
        if grid.require_buildable().is_ok() {
            let near = cost_within(BUILD_RADIUS);
            let counts = fields
                .iter()
                .map(|field| {
                    (0..grid.tile_count())
                        .filter(|&tile| {
                            grid.buildable(tile)
                                && field.cost(tile).is_some_and(|cost| cost <= near)
                        })
                        .count() as i64
                })
                .collect::<Vec<_>>();
            let fewest = arg_min(&counts).and_then(|start| self.start_marks(start));
            rows.push(
                Row::new("building-space", spread_percent(&counts))
                    .players(counts)
                    .mark(fewest),
            );
        }
        let tiles = self.start_tiles()?;
        let reach = f64::from(WALL_RING);
        let mut widths = Vec::new();
        for (start, sources) in self.starts.iter().zip(tiles) {
            self.stop.check()?;
            let walker = grid.walker(start.open_for());
            let sinks = (0..grid.tile_count())
                .filter(|&tile| {
                    let (x, y) = self.position(tile);
                    walker.open(tile)
                        && (f64::from(x) + 0.5 - start.centre.0)
                            .hypot(f64::from(y) + 0.5 - start.centre.1)
                            >= reach
                })
                .collect::<Vec<_>>();
            let width =
                match walk::narrowest_passage(&walker, sources, &sinks, WALL_LIMIT, self.stop)? {
                    PassageResult::Capped => WALL_LIMIT,
                    PassageResult::Cut { width, .. } => width,
                };
            widths.push(i64::from(width));
        }
        let fewest = arg_min(&widths).and_then(|start| self.start_marks(start));
        rows.push(
            Row::new("wall-length", spread_percent(&widths))
                .players(widths)
                .mark(fewest),
        );
        Ok(CaseMeasure::rows(rows))
    }

    fn hills(&self) -> CaseMeasure {
        let opponents = self.nearest_opponents();
        if self.starts.len() < 2 || opponents.iter().any(Option::is_none) {
            return CaseMeasure::default();
        }
        let map = self.map();
        let cosine = std::f64::consts::FRAC_1_SQRT_2;
        let shares = self
            .starts
            .iter()
            .zip(&opponents)
            .map(|(start, opponent)| {
                let opponent = &self.starts[opponent.expect("checked above")];
                let towards = (
                    opponent.centre.0 - start.centre.0,
                    opponent.centre.1 - start.centre.1,
                );
                let length = towards.0.hypot(towards.1);
                let own = map.elevation[self.index(start.tile)];
                let radius = HILL_RADIUS.ceil() as i64;
                let (cx, cy) = (start.tile.0 as i64, start.tile.1 as i64);
                let (mut tiles, mut higher) = (0_i64, 0_i64);
                for y in (cy - radius).max(0)..=(cy + radius).min(self.height as i64 - 1) {
                    for x in (cx - radius).max(0)..=(cx + radius).min(self.width as i64 - 1) {
                        let along = (
                            x as f64 + 0.5 - start.centre.0,
                            y as f64 + 0.5 - start.centre.1,
                        );
                        let distance = along.0.hypot(along.1);
                        if distance > HILL_RADIUS || distance == 0.0 || length == 0.0 {
                            continue;
                        }
                        if (along.0 * towards.0 + along.1 * towards.1) / (distance * length)
                            < cosine
                        {
                            continue;
                        }
                        tiles += 1;
                        if map.elevation[y as usize * self.width + x as usize] > own {
                            higher += 1;
                        }
                    }
                }
                if tiles == 0 { 0 } else { higher * 100 / tiles }
            })
            .collect::<Vec<_>>();
        let most = arg_max(&shares).and_then(|start| self.start_marks(start));
        CaseMeasure::rows(vec![
            Row::new("front-hills", spread(&shares))
                .players(shares)
                .mark(most),
        ])
    }

    fn water(&self) -> Result<CaseMeasure> {
        let big = self.big_water();
        if !big.iter().any(|tile| *tile) || self.starts.is_empty() || self.closed_starts()? {
            return Ok(CaseMeasure::default());
        }
        let fields = self.fields()?;
        let (_, grid) = self.walk()?;
        let resources = self.resources()?;
        let groups = self.groups()?;
        let map = self.map();
        let mut rows = Vec::new();
        if self.starts.len() >= 2 {
            let shore = (0..grid.tile_count())
                .filter(|&tile| {
                    grid.walkable(tile) && self.neighbours(tile).any(|neighbour| big[neighbour])
                })
                .collect::<Vec<_>>();
            let reach = cost_within(SHORE_RADIUS);
            let has = fields
                .iter()
                .map(|field| {
                    i64::from(
                        shore
                            .iter()
                            .any(|&tile| field.cost(tile).is_some_and(|cost| cost <= reach)),
                    )
                })
                .collect::<Vec<_>>();
            let lacking = has
                .iter()
                .position(|has| *has == 0)
                .and_then(|start| self.start_marks(start));
            rows.push(
                Row::new("no-shore", spread(&has))
                    .players(has)
                    .mark(lacking),
            );
            let reach = cost_within(SHORE_FISH_RADIUS);
            let fish = (0..self.starts.len())
                .map(|start| {
                    groups
                        .iter()
                        .filter(|group| {
                            group.kind == Kind::ShoreFish
                                && group.members.iter().any(|&member| {
                                    resources[member].costs[start].is_some_and(|cost| cost <= reach)
                                })
                        })
                        .count() as i64
                })
                .collect::<Vec<_>>();
            let fewest = arg_min(&fish).and_then(|start| self.start_marks(start));
            rows.push(
                Row::new("shore-fish", spread(&fish))
                    .players(fish)
                    .mark(fewest),
            );
            let sizes = fields
                .iter()
                .map(|field| {
                    (0..grid.tile_count())
                        .filter(|&tile| field.cost(tile).is_some())
                        .count() as i64
                })
                .collect::<Vec<_>>();
            let smallest = arg_min(&sizes).and_then(|start| self.start_marks(start));
            rows.push(
                Row::new("island-size", spread_percent(&sizes))
                    .players(sizes)
                    .mark(smallest),
            );
            let trees = self.trees();
            let present = (0..self.starts.len())
                .map(|start| {
                    let reachable = |kinds: &[Kind]| {
                        resources.iter().any(|resource| {
                            kinds.contains(&resource.kind)
                                && (resource.owner == 0
                                    || resource.owner == self.starts[start].slot)
                                && resource.costs[start].is_some()
                        })
                    };
                    let food =
                        reachable(&[Kind::Berries, Kind::Hunt, Kind::Herdables, Kind::ShoreFish]);
                    let wood = trees.iter().enumerate().any(|(tile, tree)| {
                        *tree && self.beside_cost(&fields[start], tile).is_some()
                    });
                    let gold = reachable(&[Kind::Gold]);
                    i64::from(food) + 2 * i64::from(wood) + 4 * i64::from(gold)
                })
                .collect::<Vec<_>>();
            let missing = [1, 2, 4]
                .iter()
                .filter(|bit| {
                    present.iter().any(|kinds| kinds & *bit != 0)
                        && present.iter().any(|kinds| kinds & *bit == 0)
                })
                .count() as i64;
            let lacking = arg_min(&present).and_then(|start| self.start_marks(start));
            rows.push(
                Row::new("island-resources", missing)
                    .players(present)
                    .mark(lacking),
            );
        }
        let mut distance = vec![u32::MAX; map.terrain.len()];
        let mut queue = VecDeque::new();
        for (tile, water) in big.iter().enumerate() {
            if *water {
                distance[tile] = 0;
                queue.push_back(tile);
            }
        }
        while let Some(tile) = queue.pop_front() {
            if distance[tile] >= EXPOSED_RADIUS {
                continue;
            }
            for neighbour in self.neighbours(tile).collect::<Vec<_>>() {
                if distance[neighbour] == u32::MAX {
                    distance[neighbour] = distance[tile] + 1;
                    queue.push_back(neighbour);
                }
            }
        }
        let exposed_kinds = [Kind::Gold, Kind::Stone, Kind::Berries];
        let candidates = resources
            .iter()
            .filter(|resource| resource.owner == 0 && exposed_kinds.contains(&resource.kind))
            .collect::<Vec<_>>();
        if !candidates.is_empty() {
            let exposed = candidates
                .iter()
                .filter(|resource| distance[self.index(resource.tile)] <= EXPOSED_RADIUS)
                .map(|resource| (resource.tile.0, resource.tile.1, 0))
                .collect::<Vec<_>>();
            rows.push(
                Row::new(
                    "exposed-resources",
                    exposed.len() as i64 * 100 / candidates.len() as i64,
                )
                .tiles(exposed),
            );
        }
        Ok(CaseMeasure::rows(rows))
    }

    fn spacing(&self) -> CaseMeasure {
        let map = self.map();
        let spaced = [Kind::Gold, Kind::Stone, Kind::Berries, Kind::Relic];
        let mut at = HashMap::<(u16, u16), Vec<(usize, Kind)>>::new();
        let mut listed = Vec::new();
        for (index, object) in map.objects.iter().enumerate() {
            if object.owner != 0 {
                continue;
            }
            if let Some(kind) = self
                .input
                .content
                .kind(object)
                .filter(|kind| spaced.contains(kind))
            {
                let tile = tile_of(map, object);
                at.entry(tile).or_default().push((index, kind));
                listed.push((index, kind, tile));
            }
        }
        let mut clashes = Vec::new();
        for &(index, kind, (x, y)) in &listed {
            for dy in -1..=1_i32 {
                for dx in -1..=1_i32 {
                    let (nx, ny) = (i32::from(x) + dx, i32::from(y) + dy);
                    if nx < 0 || ny < 0 {
                        continue;
                    }
                    let Some(others) = at.get(&(nx as u16, ny as u16)) else {
                        continue;
                    };
                    for &(other, other_kind) in others {
                        if other > index && other_kind != kind {
                            clashes.push((x, y, 0));
                        }
                    }
                }
            }
        }
        let mut near_start = vec![0_i64; self.starts.len()];
        let mut near_tiles = Vec::new();
        for (start, player) in self.starts.iter().enumerate() {
            let (x0, y0, x1, y1) = match player.place {
                Place::Object { .. } => {
                    let town_center = self
                        .input
                        .players
                        .iter()
                        .find(|record| record.slot == player.slot)
                        .and_then(|record| record.town_center.as_ref());
                    match town_center {
                        Some(object) => {
                            let half_x = u32::from(object.footprint_width_256) / 2;
                            let half_y = u32::from(object.footprint_height_256) / 2;
                            (
                                (object.x_256.saturating_sub(half_x) / 256) as i32,
                                (object.y_256.saturating_sub(half_y) / 256) as i32,
                                ((object.x_256 + half_x).saturating_sub(1) / 256) as i32,
                                ((object.y_256 + half_y).saturating_sub(1) / 256) as i32,
                            )
                        }
                        None => {
                            let (x, y) = player.tile;
                            (i32::from(x), i32::from(y), i32::from(x), i32::from(y))
                        }
                    }
                }
                Place::Tile { x, y } => (x as i32, y as i32, x as i32, y as i32),
            };
            let reach = i32::from(START_SPACING);
            for &(_, _, (x, y)) in &listed {
                let (x, y) = (i32::from(x), i32::from(y));
                if x >= x0 - reach && x <= x1 + reach && y >= y0 - reach && y <= y1 + reach {
                    near_start[start] += 1;
                    near_tiles.push((x as u16, y as u16, player.slot));
                }
            }
        }
        CaseMeasure::rows(vec![
            Row::new("resource-clash", clashes.len() as i64).tiles(clashes),
            Row::new("resource-at-start", near_start.iter().sum())
                .players(near_start)
                .tiles(near_tiles),
        ])
    }

    fn chokepoints(&self) -> Result<CaseMeasure> {
        if self.starts.len() < 2 {
            return Ok(CaseMeasure::default());
        }
        let (rules, grid) = self.walk()?;
        let mut rows = Vec::new();
        let opponents = self.nearest_opponents();
        let neutral = grid.walker(None);
        let mut pairs = opponents
            .iter()
            .enumerate()
            .filter_map(|(start, opponent)| {
                opponent.map(|opponent| (start.min(opponent), start.max(opponent)))
            })
            .collect::<Vec<_>>();
        pairs.sort_unstable();
        pairs.dedup();
        let mut narrowest: Option<Narrowest> = None;
        for (from, to) in pairs {
            self.stop.check()?;
            let sources = place_tiles(rules, grid, &neutral, &[self.starts[from].place])?;
            let sinks = place_tiles(rules, grid, &neutral, &[self.starts[to].place])?;
            let (width, routes, mark) = match walk::narrowest_passage(
                &neutral,
                &sources,
                &sinks,
                ROUTE_LIMIT,
                self.stop,
            )? {
                PassageResult::Capped => (ROUTE_LIMIT, 0, None),
                PassageResult::Cut { width: 0, .. } => continue,
                PassageResult::Cut { width, passages } => (
                    width,
                    passages.len() as i64,
                    passages.first().map(|passage| self.position(passage.tile)),
                ),
            };
            if narrowest.is_none_or(|(least, _, _)| width < least) {
                narrowest = Some((width, routes, mark));
            }
        }
        if let Some((width, routes, mark)) = narrowest {
            rows.push(
                Row::new("narrow-route", i64::from(width))
                    .aux(routes)
                    .mark(mark),
            );
        }
        let tiles = self.start_tiles()?;
        let resources = self.resources()?;
        let groups = self.groups()?;
        let nearest = [
            self.nearest_groups(Kind::Gold)?,
            self.nearest_groups(Kind::Stone)?,
        ];
        let mut widths = Vec::new();
        let mut least: Option<(u32, Option<(u16, u16)>)> = None;
        for (start, player) in self.starts.iter().enumerate() {
            let walker = grid.walker(player.open_for());
            let mut player_least = MINERAL_LIMIT;
            for nearest in &nearest {
                self.stop.check()?;
                let Some(&(_, group)) = nearest[start].first() else {
                    continue;
                };
                let mut sinks = groups[group]
                    .members
                    .iter()
                    .flat_map(|&member| {
                        self.object_tiles(&walker, &self.map().objects[resources[member].object])
                    })
                    .collect::<Vec<_>>();
                sinks.sort_unstable();
                sinks.dedup();
                let (width, mark) = match walk::narrowest_passage(
                    &walker,
                    &tiles[start],
                    &sinks,
                    MINERAL_LIMIT,
                    self.stop,
                )? {
                    PassageResult::Capped => (MINERAL_LIMIT, None),
                    PassageResult::Cut { width, passages } => (
                        width,
                        passages.first().map(|passage| self.position(passage.tile)),
                    ),
                };
                player_least = player_least.min(width);
                if least.is_none_or(|(least, _)| width < least) {
                    least = Some((width, mark));
                }
            }
            widths.push(i64::from(player_least));
        }
        if let Some((width, mark)) = least {
            rows.push(
                Row::new("minerals-cut-off", i64::from(width))
                    .players(widths)
                    .mark(mark),
            );
        }
        Ok(CaseMeasure::rows(rows))
    }

    fn variation(&self) -> CaseMeasure {
        let trees = self.trees();
        let mut forest = vec![0_u64; trees.len().div_ceil(64)];
        for (tile, tree) in trees.iter().enumerate() {
            if *tree {
                forest[tile / 64] |= 1 << (tile % 64);
            }
        }
        CaseMeasure {
            rows: Vec::new(),
            favoured: None,
            contenders: 0,
            signature: Some(Arc::new(Signature {
                forest,
                starts: self.starts.iter().map(|start| start.tile).collect(),
                objects: self.map().objects.len() as u64,
            })),
        }
    }

    fn looks(&self) -> CaseMeasure {
        let map = self.map();
        let content = self.input.content;
        let tiles = map.terrain.len();
        let water = (0..tiles)
            .map(|tile| content.water(map, tile))
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let shore = (0..tiles)
            .filter(|&tile| !water[tile] && self.four(tile).any(|neighbour| water[neighbour]))
            .collect::<Vec<_>>();
        if shore.len() >= SHORE_TILES {
            let bare = shore
                .iter()
                .filter(|&&tile| !content.beach(map, tile))
                .count();
            rows.push(Row::new(
                "no-beaches",
                bare as i64 * 100 / shore.len() as i64,
            ));
        }
        let mut occupied = vec![false; tiles];
        for object in &map.objects {
            occupied[self.index(tile_of(map, object))] = true;
        }
        for appearance in &map.appearance_objects {
            let x = ((appearance.x_256 / 256) as usize).min(self.width - 1);
            let y = ((appearance.y_256 / 256) as usize).min(self.height - 1);
            occupied[y * self.width + x] = true;
        }
        for piece in &map.cliff_pieces {
            let x = ((piece.x_256 / 256) as usize).min(self.width - 1);
            let y = ((piece.y_256 / 256) as usize).min(self.height - 1);
            occupied[y * self.width + x] = true;
        }
        let mut side = vec![0_u32; tiles];
        let mut best = (0_u32, 0_usize);
        for y in 0..self.height {
            for x in 0..self.width {
                let tile = y * self.width + x;
                if occupied[tile] || water[tile] {
                    continue;
                }
                let terrain = map.terrain[tile];
                side[tile] = if x > 0
                    && y > 0
                    && map.terrain[tile - 1] == terrain
                    && map.terrain[tile - self.width] == terrain
                    && map.terrain[tile - self.width - 1] == terrain
                {
                    1 + side[tile - 1]
                        .min(side[tile - self.width])
                        .min(side[tile - self.width - 1])
                } else {
                    1
                };
                if side[tile] > best.0 {
                    best = (side[tile], tile);
                }
            }
        }
        if best.0 > 0 {
            let (x, y) = self.position(best.1);
            let half = (best.0 / 2) as u16;
            rows.push(
                Row::new("bare-area", i64::from(best.0))
                    .mark(Some((x.saturating_sub(half), y.saturating_sub(half)))),
            );
        }
        let mut histogram = BTreeMap::<u32, i64>::new();
        let mut land = 0_i64;
        for (&wet, terrain) in water.iter().zip(&map.terrain).take(tiles) {
            if !wet {
                *histogram.entry(terrain.0).or_default() += 1;
                land += 1;
            }
        }
        if land > 0 {
            let most = histogram.values().copied().max().unwrap_or(0);
            rows.push(Row::new("one-terrain", most * 100 / land));
        }
        let trees = self.trees();
        let forests = self.components(|tile| trees[tile], true, CLUSTER_TILES);
        let lakes = self
            .components(|tile| water[tile], false, CLUSTER_TILES)
            .into_iter()
            .filter(|lake| {
                lake.iter().all(|&tile| {
                    let (x, y) = self.position(tile);
                    x > 0
                        && y > 0
                        && usize::from(x) + 1 < self.width
                        && usize::from(y) + 1 < self.height
                })
            })
            .collect::<Vec<_>>();
        let round = forests
            .iter()
            .chain(&lakes)
            .filter_map(|cluster| {
                let count = cluster.len() as f64;
                let (sum_x, sum_y) = cluster.iter().fold((0.0, 0.0), |(x, y), &tile| {
                    let (tx, ty) = self.position(tile);
                    (x + f64::from(tx) + 0.5, y + f64::from(ty) + 0.5)
                });
                let centre = (sum_x / count, sum_y / count);
                let radius = cluster
                    .iter()
                    .map(|&tile| {
                        let (tx, ty) = self.position(tile);
                        (f64::from(tx) + 0.5 - centre.0).hypot(f64::from(ty) + 0.5 - centre.1)
                    })
                    .fold(0.0_f64, f64::max)
                    + 0.5;
                let roundness = (count * 100.0 / (std::f64::consts::PI * radius * radius)) as i64;
                (roundness > ROUND_PERCENT).then(|| {
                    (
                        (centre.0 as u16).min(self.width as u16 - 1),
                        (centre.1 as u16).min(self.height as u16 - 1),
                        0,
                    )
                })
            })
            .collect::<Vec<_>>();
        rows.push(Row::new("round-shapes", round.len() as i64).tiles(round));
        if forests.len() >= 3 {
            let sizes = forests
                .iter()
                .map(|forest| forest.len() as i64)
                .collect::<Vec<_>>();
            rows.push(Row::new("uniform-clusters", spread_percent(&sizes)));
        }
        let band = usize::from(EDGE_BAND);
        let shares = self
            .starts
            .iter()
            .map(|start| {
                let (mut count, mut forest) = (0_usize, 0_usize);
                for (tile, &tree) in trees.iter().enumerate().take(tiles) {
                    let (x, y) = self.position(tile);
                    let (x, y) = (usize::from(x), usize::from(y));
                    let edge =
                        x < band || y < band || x + band >= self.width || y + band >= self.height;
                    if !edge
                        || (x as f64 + 0.5 - start.centre.0).hypot(y as f64 + 0.5 - start.centre.1)
                            > EDGE_RADIUS
                    {
                        continue;
                    }
                    count += 1;
                    if tree {
                        forest += 1;
                    }
                }
                (count >= EDGE_TILES).then(|| (forest * 100 / count) as i64)
            })
            .collect::<Vec<_>>();
        let known = shares.iter().flatten().copied().collect::<Vec<_>>();
        if known.len() >= 2 && !self.without_start() {
            let row = Row::new("edge-differs", spread(&known));
            rows.push(if known.len() == shares.len() {
                let least = arg_min(&known).and_then(|start| self.start_marks(start));
                row.players(known).mark(least)
            } else {
                row
            });
        }
        CaseMeasure::rows(rows)
    }
}

fn group_resources(resources: &[Resource]) -> Vec<Group> {
    let mut parent = (0..resources.len()).collect::<Vec<_>>();
    fn root(parent: &mut [usize], mut node: usize) -> usize {
        while parent[node] != node {
            parent[node] = parent[parent[node]];
            node = parent[node];
        }
        node
    }
    let mut at = HashMap::<(Kind, u16, u16), Vec<usize>>::new();
    for (index, resource) in resources.iter().enumerate() {
        at.entry((resource.kind, resource.tile.0, resource.tile.1))
            .or_default()
            .push(index);
    }
    let reach = i32::from(GROUP_REACH);
    for (index, resource) in resources.iter().enumerate() {
        let (x, y) = (i32::from(resource.tile.0), i32::from(resource.tile.1));
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 {
                    continue;
                }
                if let Some(others) = at.get(&(resource.kind, nx as u16, ny as u16)) {
                    for &other in others {
                        let (left, right) = (root(&mut parent, index), root(&mut parent, other));
                        if left != right {
                            let (low, high) = (left.min(right), left.max(right));
                            parent[high] = low;
                        }
                    }
                }
            }
        }
    }
    let mut members = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..resources.len() {
        let group = root(&mut parent, index);
        members.entry(group).or_default().push(index);
    }
    members
        .into_values()
        .map(|members| {
            let count = members.len() as i64;
            let (sum_x, sum_y) = members.iter().fold((0_i64, 0_i64), |(x, y), &member| {
                (
                    x + i64::from(resources[member].tile.0),
                    y + i64::from(resources[member].tile.1),
                )
            });
            let centre = members
                .iter()
                .min_by_key(|&&member| {
                    let dx = count * i64::from(resources[member].tile.0) - sum_x;
                    let dy = count * i64::from(resources[member].tile.1) - sum_y;
                    (dx * dx + dy * dy, member)
                })
                .copied()
                .expect("a group has a member");
            Group {
                kind: resources[centre].kind,
                tile: resources[centre].tile,
                members,
            }
        })
        .collect()
}
