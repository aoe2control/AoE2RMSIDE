use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{CompatibilityRange, ContentError};

const MAXIMUM_INVENTORY_BYTES: usize = 128 * 1024;
const MAXIMUM_INCLUDE_NAMES: usize = 512;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandardIncludeInventory {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub build: String,
    pub compatibility: CompatibilityRange,
    pub reserved_file_names: Vec<String>,
    pub schema_version: String,
    pub standard_includes: Vec<String>,
}

impl StandardIncludeInventory {
    pub fn contains_include(&self, relative_path: &str) -> bool {
        let canonical = relative_path.replace('\\', "/").to_ascii_lowercase();
        self.standard_includes
            .binary_search_by_key(&canonical, |name| name.to_ascii_lowercase())
            .is_ok()
    }

    pub fn resolver_identifiers(&self) -> impl Iterator<Item = &str> {
        self.standard_includes
            .iter()
            .map(String::as_str)
            .chain(["random_map.def"])
    }

    pub fn reserves_file_name(&self, file_name: &str) -> bool {
        if !file_name.is_ascii() {
            return false;
        }
        self.reserved_file_names
            .binary_search(&file_name.to_ascii_lowercase())
            .is_ok()
    }
}

pub fn load_canonical_standard_include_inventory(
    bytes: &[u8],
    expected_build: &str,
) -> Result<StandardIncludeInventory, ContentError> {
    if bytes.len() > MAXIMUM_INVENTORY_BYTES {
        return Err(ContentError::ResourceLimit("standard include inventory"));
    }
    let inventory: StandardIncludeInventory =
        serde_json::from_slice(bytes).map_err(ContentError::Parse)?;
    if inventory.schema != "https://rmside.invalid/schemas/standard-includes/v1"
        || inventory.schema_version != "1.0.0"
        || inventory.compatibility.minimum_major != 1
        || inventory.compatibility.maximum_major != 1
    {
        return Err(ContentError::UnsupportedSchema(
            inventory.schema_version.clone(),
        ));
    }
    if inventory.build != expected_build || expected_build.is_empty() {
        return Err(ContentError::InvalidField("standard include build"));
    }
    if inventory.standard_includes.is_empty()
        || inventory.standard_includes.len() > MAXIMUM_INCLUDE_NAMES
    {
        return Err(ContentError::ResourceLimit("standard include identifiers"));
    }
    let mut previous = None;
    let mut reserved = BTreeSet::from(["random_map.def".to_owned()]);
    for name in &inventory.standard_includes {
        if !valid_include_path(name) {
            return Err(ContentError::InvalidField("standard include path"));
        }
        let folded = name.to_ascii_lowercase();
        if previous.as_ref().is_some_and(|prior| prior >= &folded) {
            return Err(ContentError::NonCanonicalOrdering(
                "standard include identifiers",
            ));
        }
        previous = Some(folded);
        reserved.insert(
            name.rsplit('/')
                .next()
                .expect("validated nonempty include path")
                .to_ascii_lowercase(),
        );
    }
    if inventory.reserved_file_names != reserved.into_iter().collect::<Vec<_>>() {
        return Err(ContentError::InvalidField("reserved standard file names"));
    }
    let canonical = serde_json::to_vec_pretty(
        &serde_json::to_value(&inventory).map_err(ContentError::Serialize)?,
    )
    .map_err(ContentError::Serialize)?;
    if bytes.strip_suffix(b"\n").unwrap_or(bytes) != canonical {
        return Err(ContentError::NonCanonicalOrdering(
            "standard include inventory",
        ));
    }
    Ok(inventory)
}

pub fn canonical_standard_include_inventory(
    build: &str,
    include_paths: impl IntoIterator<Item = String>,
) -> Result<(StandardIncludeInventory, Vec<u8>), ContentError> {
    let mut standard_includes = include_paths.into_iter().collect::<Vec<_>>();
    if standard_includes.len() > MAXIMUM_INCLUDE_NAMES {
        return Err(ContentError::ResourceLimit("standard include identifiers"));
    }
    standard_includes.sort_by_key(|name| name.to_ascii_lowercase());
    let mut reserved = BTreeSet::from(["random_map.def".to_owned()]);
    for name in &standard_includes {
        if !valid_include_path(name) {
            return Err(ContentError::InvalidField("standard include path"));
        }
        reserved.insert(
            name.rsplit('/')
                .next()
                .expect("validated nonempty include path")
                .to_ascii_lowercase(),
        );
    }
    let inventory = StandardIncludeInventory {
        schema: "https://rmside.invalid/schemas/standard-includes/v1".to_owned(),
        build: build.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: 1,
            maximum_major: 1,
        },
        reserved_file_names: reserved.into_iter().collect(),
        schema_version: "1.0.0".to_owned(),
        standard_includes,
    };
    let mut bytes = serde_json::to_vec_pretty(
        &serde_json::to_value(&inventory).map_err(ContentError::Serialize)?,
    )
    .map_err(ContentError::Serialize)?;
    bytes.push(b'\n');
    let loaded = load_canonical_standard_include_inventory(&bytes, build)?;
    Ok((loaded, bytes))
}

fn valid_include_path(path: &str) -> bool {
    if !path.is_ascii() || path.starts_with('/') || path.contains('\\') || path.contains("..") {
        return false;
    }
    let (directory, file) = path
        .split_once('/')
        .map_or(("", path), |(dir, file)| (dir, file));
    if !directory.is_empty() && directory != "includes" {
        return false;
    }
    if file.contains('/') || !file.ends_with(".inc") || file.len() <= 4 {
        return false;
    }
    file.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

pub fn packaged_48987_standard_include_inventory()
-> Result<&'static StandardIncludeInventory, ContentError> {
    static INVENTORY: OnceLock<Option<StandardIncludeInventory>> = OnceLock::new();
    INVENTORY
        .get_or_init(|| {
            load_canonical_standard_include_inventory(
                include_bytes!("../data/aoe2de-101.103.48987-standard-includes.json"),
                "101.103.48987",
            )
            .ok()
        })
        .as_ref()
        .ok_or(ContentError::InvalidField(
            "packaged standard include inventory",
        ))
}
