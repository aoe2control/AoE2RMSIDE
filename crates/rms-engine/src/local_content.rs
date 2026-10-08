use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rms_content::{
    Aoe2deContentInputs, ContentError, DatImportLimits, NativeContentBindings, NeutralContentPack,
    import_aoe2de_content, packaged_support_bundles,
};
use rms_profile::ProfileCatalog;
use rms_semantics::normalize_implicit_definition_bytes;
use thiserror::Error;

pub const LOCAL_CONTENT_PACK_VERSION: &str = "1.0.0";
pub const MAXIMUM_LOCAL_DAT_BYTES: u64 = 256 * 1024 * 1024;
pub const MAXIMUM_LOCAL_OBJECT_REPLACEMENT_BYTES: u64 = 1024 * 1024;
pub const MAXIMUM_LOCAL_DEFINITION_BYTES: u64 = 4 * 1024 * 1024;
pub const LOCAL_DAT_RELATIVE_PATH: [&str; 4] =
    ["resources", "_common", "dat", "empires2_x2_p1.dat"];
pub const LOCAL_OBJECT_REPLACEMENTS_RELATIVE_PATH: [&str; 4] =
    ["resources", "_common", "dat", "objreplacement.json"];
pub const LOCAL_DEFINITIONS_RELATIVE_PATH: [&str; 5] = [
    "resources",
    "_common",
    "drs",
    "gamedata_x2",
    "random_map.def",
];

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LocalContentError {
    #[error("{0}")]
    Unreadable(String),
    #[error("{0}")]
    UnsupportedLayout(String),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalContentPaths {
    pub dat: PathBuf,
    pub object_replacements: PathBuf,
    pub definitions: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalContentStamp {
    files: [(PathBuf, u64, Option<SystemTime>); 3],
}

pub struct LocalContentFiles {
    pub dat: Vec<u8>,
    pub object_replacements: Vec<u8>,
    pub definitions: Vec<u8>,
}

impl LocalContentPaths {
    fn entries(&self) -> [(&Path, &'static str, u64, &'static str); 3] {
        [
            (&self.dat, "dat", MAXIMUM_LOCAL_DAT_BYTES, "game data file"),
            (
                &self.object_replacements,
                "json",
                MAXIMUM_LOCAL_OBJECT_REPLACEMENT_BYTES,
                "object replacement configuration",
            ),
            (
                &self.definitions,
                "def",
                MAXIMUM_LOCAL_DEFINITION_BYTES,
                "implicit definition source",
            ),
        ]
    }

    pub fn stamp(&self) -> Result<LocalContentStamp, LocalContentError> {
        let mut files = Vec::with_capacity(3);
        for (path, extension, maximum, label) in self.entries() {
            let metadata = checked_metadata(path, extension, maximum, label)?;
            files.push((path.to_path_buf(), metadata.len(), metadata.modified().ok()));
        }
        Ok(LocalContentStamp {
            files: files
                .try_into()
                .map_err(|_| LocalContentError::Unreadable("local content inputs".to_owned()))?,
        })
    }

    pub fn resolved(&self) -> Result<Self, LocalContentError> {
        let root = installation_root(&self.dat, &LOCAL_DAT_RELATIVE_PATH).ok_or_else(|| {
            LocalContentError::Unreadable(
                "the game data file is not at its installation-relative location".to_owned(),
            )
        })?;
        for (path, relative, label) in [
            (
                &self.object_replacements,
                &LOCAL_OBJECT_REPLACEMENTS_RELATIVE_PATH[..],
                "object replacement configuration",
            ),
            (
                &self.definitions,
                &LOCAL_DEFINITIONS_RELATIVE_PATH[..],
                "implicit definition source",
            ),
        ] {
            if installation_root(path, relative).is_none_or(|other| !same_path(&other, &root)) {
                return Err(LocalContentError::Unreadable(format!(
                    "the {label} is not in the game data file's installation"
                )));
            }
        }
        Ok(Self {
            dat: resolve_local_file(&self.dat, "game data file")?,
            object_replacements: resolve_local_file(
                &self.object_replacements,
                "object replacement configuration",
            )?,
            definitions: resolve_local_file(&self.definitions, "implicit definition source")?,
        })
    }

    pub fn read(&self) -> Result<LocalContentFiles, LocalContentError> {
        let mut bytes = Vec::with_capacity(3);
        for (path, extension, maximum, label) in self.entries() {
            checked_metadata(path, extension, maximum, label)?;
            let unreadable = || LocalContentError::Unreadable(format!("the {label} is unreadable"));
            let file = std::fs::File::open(path).map_err(|_| unreadable())?;
            let metadata = file.metadata().map_err(|_| unreadable())?;
            if !metadata.is_file() || metadata.len() > maximum {
                return Err(LocalContentError::Unreadable(format!(
                    "the {label} is not a file within its {maximum}-byte bound"
                )));
            }
            let mut content = Vec::with_capacity(metadata.len() as usize);
            std::io::Read::read_to_end(
                &mut std::io::Read::take(file, maximum.saturating_add(1)),
                &mut content,
            )
            .map_err(|_| unreadable())?;
            if content.len() as u64 > maximum {
                return Err(LocalContentError::Unreadable(format!(
                    "the {label} exceeds its {maximum}-byte bound"
                )));
            }
            bytes.push(content);
        }
        let definitions = bytes.pop().unwrap_or_default();
        let object_replacements = bytes.pop().unwrap_or_default();
        let dat = bytes.pop().unwrap_or_default();
        Ok(LocalContentFiles {
            dat,
            object_replacements,
            definitions,
        })
    }
}

pub fn installation_root(path: &Path, relative: &[&str]) -> Option<PathBuf> {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    let mut root = path.to_path_buf();
    for expected in relative.iter().rev() {
        let name = root.file_name()?.to_str()?;
        if !name.eq_ignore_ascii_case(expected) {
            return None;
        }
        root.pop();
    }
    root.file_name().is_some().then_some(root)
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

pub fn is_local_drive_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        path.is_absolute()
            && matches!(
                path.components().next(),
                Some(Component::Prefix(prefix))
                    if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            )
    }
    #[cfg(not(windows))]
    {
        path.is_absolute()
    }
}

pub fn resolve_local_file(path: &Path, label: &str) -> Result<PathBuf, LocalContentError> {
    if path.as_os_str().len() > 4096 || !is_local_drive_path(path) {
        return Err(LocalContentError::Unreadable(format!(
            "the {label} path is not an absolute local drive path"
        )));
    }
    let resolved = std::fs::canonicalize(path)
        .map_err(|_| LocalContentError::Unreadable(format!("the {label} is missing")))?;
    if !is_local_drive_path(&resolved) {
        return Err(LocalContentError::Unreadable(format!(
            "the {label} resolves outside a local drive"
        )));
    }
    Ok(resolved)
}

fn checked_metadata(
    path: &Path,
    extension: &str,
    maximum: u64,
    label: &str,
) -> Result<std::fs::Metadata, LocalContentError> {
    let acceptable = path.is_absolute()
        && path.as_os_str().len() <= 4096
        && path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension));
    if !acceptable {
        return Err(LocalContentError::Unreadable(format!(
            "the {label} path is not an absolute .{extension} path"
        )));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|_| LocalContentError::Unreadable(format!("the {label} is missing")))?;
    if !metadata.is_file() {
        return Err(LocalContentError::Unreadable(format!(
            "the {label} is not a file"
        )));
    }
    if metadata.len() > maximum {
        return Err(LocalContentError::Unreadable(format!(
            "the {label} exceeds its {maximum}-byte bound"
        )));
    }
    Ok(metadata)
}

pub fn local_content_pack_id(product_version: &str) -> Result<String, LocalContentError> {
    let parts = product_version.split('.').collect::<Vec<_>>();
    let numeric = (2..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 10 && part.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !numeric {
        return Err(LocalContentError::Invalid(
            "the linked product version is not a dotted numeric label".to_owned(),
        ));
    }
    Ok(format!("aoe2de-{product_version}-local"))
}

pub fn import_local_content(
    files: &LocalContentFiles,
    product_version: &str,
    behavior_profile_id: &str,
    bindings: &NativeContentBindings,
) -> Result<NeutralContentPack, LocalContentError> {
    let pack_id = local_content_pack_id(product_version)?;
    let definitions =
        normalize_implicit_definition_bytes("game/random_map.def", files.definitions.clone())
            .map_err(|error| {
                LocalContentError::Invalid(format!(
                    "the implicit definition source is invalid: {error}"
                ))
            })?;
    import_aoe2de_content(&Aoe2deContentInputs {
        dat: &files.dat,
        object_replacements: &files.object_replacements,
        implicit_definitions: &definitions,
        bindings,
        behavior_profile_id,
        product_version_label: Some(product_version),
        pack_id: &pack_id,
        pack_version: LOCAL_CONTENT_PACK_VERSION,
        limits: DatImportLimits::default(),
    })
    .map(|(pack, _manifest)| pack)
    .map_err(|error| match error {
        ContentError::UnsupportedLayout(_) | ContentError::UnsupportedSchema(_) => {
            LocalContentError::UnsupportedLayout(format!(
                "the game data file is not a supported layout: {error}"
            ))
        }
        ContentError::ResourceLimit(_) => LocalContentError::Unreadable(format!(
            "the game data file exceeds a reader bound: {error}"
        )),
        error => LocalContentError::Invalid(format!(
            "the installation files do not form valid generation content: {error}"
        )),
    })
}

const MAXIMUM_CACHED_LOCAL_PACKS: usize = 2;

#[derive(Clone, Eq, PartialEq)]
struct CacheKey {
    stamp: LocalContentStamp,
    product_version: String,
    profile_id: String,
}

type LocalContentCache = VecDeque<(CacheKey, Arc<NeutralContentPack>)>;

static CACHE: Mutex<LocalContentCache> = Mutex::new(VecDeque::new());

pub fn local_content_pack(
    paths: &LocalContentPaths,
    product_version: &str,
    profile_id: &str,
) -> Result<(Arc<NeutralContentPack>, Option<Duration>), LocalContentError> {
    let invalid = |message: String| LocalContentError::Invalid(message);
    let catalog = ProfileCatalog::frozen_current()
        .map_err(|error| invalid(format!("profile catalog failed: {error}")))?;
    let profile = catalog
        .get(profile_id)
        .ok_or_else(|| invalid(format!("unknown behavior profile {profile_id}")))?;
    local_content_pack_id(product_version)?;
    if catalog.for_product_version(product_version).is_some() {
        return Err(invalid(format!(
            "{product_version} is a verified version and uses its packaged content"
        )));
    }
    let bundle = packaged_support_bundles()
        .map_err(|error| invalid(format!("packaged support bundle failed: {error}")))?
        .iter()
        .find(|bundle| bundle.manifest.behavior_profile_id == profile.profile_id)
        .ok_or_else(|| {
            invalid(format!(
                "no reviewed bindings exist for profile {profile_id}"
            ))
        })?;
    let resolved = paths.resolved()?;
    let paths = &resolved;
    let key = CacheKey {
        stamp: paths.stamp()?,
        product_version: product_version.to_owned(),
        profile_id: profile.profile_id.clone(),
    };
    if let Some(pack) = cached(&key) {
        return Ok((pack, None));
    }
    let started = Instant::now();
    let files = paths.read()?;
    let pack = Arc::new(import_local_content(
        &files,
        product_version,
        &profile.profile_id,
        &bundle.native_bindings,
    )?);
    drop(files);
    if paths.stamp()? == key.stamp {
        let mut cache = CACHE.lock().expect("local content cache poisoned");
        cache.retain(|(existing, _)| *existing != key);
        if cache.len() >= MAXIMUM_CACHED_LOCAL_PACKS {
            cache.pop_front();
        }
        cache.push_back((key, Arc::clone(&pack)));
    }
    Ok((pack, Some(started.elapsed())))
}

fn cached(key: &CacheKey) -> Option<Arc<NeutralContentPack>> {
    CACHE
        .lock()
        .expect("local content cache poisoned")
        .iter()
        .find(|(existing, _)| existing == key)
        .map(|(_, pack)| Arc::clone(pack))
}
