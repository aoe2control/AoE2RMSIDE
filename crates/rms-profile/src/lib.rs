use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod certified_constructs;
mod constant_kinds;

pub use certified_constructs::{
    CERTIFIED_CONSTRUCTS_DERIVATION_CONTRACT, CERTIFIED_CONSTRUCTS_SCHEMA_MAJOR,
    CERTIFIED_CONSTRUCTS_SCHEMA_VERSION, CertifiedConstruct, CertifiedConstructs,
    CertifiedConstructsEntry, CertifiedConstructsProvenance, CertifiedConstructsSource,
    MAXIMUM_CERTIFIED_CONSTRUCTS, frozen_certified_constructs,
};

pub use constant_kinds::{
    CONSTANT_KINDS_DERIVATION_CONTRACT, CONSTANT_KINDS_SCHEMA_VERSION, ConstantKind, ConstantKinds,
    ConstantKindsEntry, ConstantKindsProvenance, ConstantKindsSource, MAXIMUM_CONSTANT_KIND_NAMES,
    NamedConstantKind, frozen_constant_kinds,
};

pub const PROFILE_SCHEMA_MAJOR: u32 = 1;
pub const PROFILE_SCHEMA_VERSION: &str = "1.0.0";
pub const PROFILE_SCHEMA_VERSION_1_1: &str = "1.1.0";
pub const MINIMAP_PALETTE_SCHEMA_VERSION: &str = "1.0.0";
pub const TEXTURE_PALETTE_SCHEMA_VERSION: &str = "1.0.0";
pub const CURRENT_PROFILE_ID: &str = "aoe2de-101.103.48987-rms-v1";
pub const FROZEN_PRODUCT_VERSION: &str = "101.103.48987.0";
pub const PROFILE_54800_ID: &str = "aoe2de-101.103.54800-rms-v1";
pub const PRODUCT_VERSION_54800: &str = "101.103.54800.0";
pub const DECISION_OBJECT_GROUP_ROLL_FILTER: &str = "object-group-roll-filter";
pub const DECISION_PATH_NO_ROUTE_RESULT: &str = "path-no-route-result";
pub const DECISION_BUILDING_SPAWN_PLACEMENT: &str = "building-spawn-placement";
pub const DECISION_FOUNDATION_TERRAIN_REMAP: &str = "foundation-terrain-remap";
pub const MAXIMUM_PROFILE_BYTES: usize = 1024 * 1024;
pub const EXACT_GENERATION_PREREQUISITES: [&str; 11] = [
    "exact-engine",
    "exact-setup",
    "exact-rng",
    "exact-land",
    "exact-elevation",
    "exact-cliff",
    "exact-terrain",
    "exact-connection",
    "exact-object",
    "strict-parser",
    "source-catalog-v1",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityRange {
    pub minimum_major: u32,
    pub maximum_major: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityStatus {
    Unsupported,
    Partial,
    Complete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum DecisionValue {
    Boolean(bool),
    Integer(i64),
    String(String),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BehaviorDecisions {
    #[serde(default)]
    pub parser: BTreeMap<String, DecisionValue>,
    #[serde(default)]
    pub rng: BTreeMap<String, DecisionValue>,
    #[serde(default)]
    pub generator: BTreeMap<String, DecisionValue>,
    #[serde(default)]
    pub observed_failures: BTreeMap<String, DecisionValue>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MinimapPaletteSource {
    DedicatedDatPaletteIndices,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainMinimapColor {
    pub terrain_id: u32,
    pub high_color: u32,
    pub medium_color: u32,
    pub low_color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeutralObjectMinimapColor {
    pub object_id: u32,
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffMinimapColor {
    pub cliff_type: u32,
    pub left_color: u32,
    pub right_color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MinimapPaletteEntry {
    pub palette_id: String,
    pub product_version: String,
    pub source: MinimapPaletteSource,
    #[serde(default)]
    pub terrain_colors: Vec<TerrainMinimapColor>,
    #[serde(default)]
    pub neutral_object_colors: Vec<NeutralObjectMinimapColor>,
    #[serde(default)]
    pub cliff_colors: Vec<CliffMinimapColor>,
}

impl MinimapPaletteEntry {
    pub fn deterministic_hash(&self) -> Result<[u8; 32], ProfileError> {
        Ok(Sha256::digest(serde_json::to_vec(self).map_err(ProfileError::Serialize)?).into())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MinimapPalettes {
    pub schema_version: String,
    pub derivation_contract: String,
    #[serde(default)]
    pub entries: Vec<MinimapPaletteEntry>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TexturePaletteSource {
    InstallationTextureAverages,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TexturePaletteProvenance {
    pub tool: String,
    pub installation_build: String,
    pub derived_on: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainTextureColor {
    pub terrain_id: u32,
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectTextureColor {
    pub object_id: u32,
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffTextureColor {
    pub cliff_type: u32,
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TexturePaletteEntry {
    pub palette_id: String,
    pub product_version: String,
    pub source: TexturePaletteSource,
    pub provenance: TexturePaletteProvenance,
    #[serde(default)]
    pub terrain_colors: Vec<TerrainTextureColor>,
    #[serde(default)]
    pub object_colors: Vec<ObjectTextureColor>,
    #[serde(default)]
    pub cliff_colors: Vec<CliffTextureColor>,
}

impl TexturePaletteEntry {
    pub fn deterministic_hash(&self) -> Result<[u8; 32], ProfileError> {
        Ok(Sha256::digest(serde_json::to_vec(self).map_err(ProfileError::Serialize)?).into())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TexturePalettes {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub profile_id: String,
    pub derivation_contract: String,
    #[serde(default)]
    pub entries: Vec<TexturePaletteEntry>,
}

impl TexturePalettes {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.compatibility.minimum_major != PROFILE_SCHEMA_MAJOR
            || self.compatibility.maximum_major != PROFILE_SCHEMA_MAJOR
        {
            return Err(ProfileError::UnsupportedTexturePaletteSchema(
                self.schema_version.clone(),
            ));
        }
        validate_identifier("texture palette profile", &self.profile_id, 64)?;
        validate_texture_palettes(self)
    }

    pub fn resolve(
        &self,
        detected_product_version: Option<&str>,
    ) -> Option<TexturePaletteResolution<'_>> {
        let exact = detected_product_version.and_then(|product_version| {
            self.entries
                .iter()
                .find(|entry| entry.product_version == product_version)
        });
        let entry = exact.or_else(|| self.entries.last())?;
        Some(TexturePaletteResolution {
            entry,
            exact_product_version: exact.is_some(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TexturePaletteResolution<'a> {
    pub entry: &'a TexturePaletteEntry,
    pub exact_product_version: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MinimapPaletteResolution<'a> {
    pub entry: &'a MinimapPaletteEntry,
    pub exact_product_version: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BehaviorProfile {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub profile_id: String,
    pub behavior_version: String,
    #[serde(default)]
    pub product_versions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unverified_product_versions: Vec<String>,
    #[serde(default)]
    pub capabilities: BTreeMap<String, CapabilityStatus>,
    pub decisions: BehaviorDecisions,
    #[serde(default)]
    pub semantic_token_aliases: BTreeMap<i64, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimap_palettes: Option<MinimapPalettes>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObjectGroupRollFilter {
    WeightAtMostRoll,
    WeightAtLeastRoll,
}

impl ObjectGroupRollFilter {
    pub fn keeps(self, weight: u32, roll: u32) -> bool {
        match self {
            Self::WeightAtMostRoll => weight <= roll,
            Self::WeightAtLeastRoll => weight >= roll,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BuildingSpawnPlacement {
    InnerTileFallback,
    UnitRingNearestDefault,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FoundationTerrainRemap {
    Remap8To27And64To54,
    None,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationRules {
    pub object_group_roll_filter: ObjectGroupRollFilter,
    pub path_no_route_result: u8,
    pub building_spawn_placement: BuildingSpawnPlacement,
    pub foundation_terrain_remap: FoundationTerrainRemap,
}

impl GenerationRules {
    pub const BUILD_48987: Self = Self {
        object_group_roll_filter: ObjectGroupRollFilter::WeightAtMostRoll,
        path_no_route_result: 3,
        building_spawn_placement: BuildingSpawnPlacement::InnerTileFallback,
        foundation_terrain_remap: FoundationTerrainRemap::Remap8To27And64To54,
    };
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIdentity {
    pub schema_version: String,
    pub profile_id: String,
    pub behavior_version: String,
}

impl BehaviorProfile {
    pub fn identity(&self) -> ProfileIdentity {
        ProfileIdentity {
            schema_version: self.schema_version.clone(),
            profile_id: self.profile_id.clone(),
            behavior_version: self.behavior_version.clone(),
        }
    }

    fn is_schema_1_1(&self) -> bool {
        self.schema_version == PROFILE_SCHEMA_VERSION_1_1
    }

    pub fn is_verified(&self) -> bool {
        !self.product_versions.is_empty()
    }

    pub fn generation_rules(&self) -> Result<GenerationRules, ProfileError> {
        let generator = &self.decisions.generator;
        let stated = [
            DECISION_OBJECT_GROUP_ROLL_FILTER,
            DECISION_PATH_NO_ROUTE_RESULT,
            DECISION_BUILDING_SPAWN_PLACEMENT,
            DECISION_FOUNDATION_TERRAIN_REMAP,
        ]
        .map(|key| generator.get(key));
        if !self.is_schema_1_1() {
            if stated.iter().any(Option::is_some) {
                return Err(ProfileError::InvalidField(
                    "schema 1.0.0 profile carries a schema 1.1 generator decision",
                ));
            }
            return Ok(GenerationRules::BUILD_48987);
        }
        let object_group_roll_filter = match stated[0] {
            Some(DecisionValue::String(value)) if value == "weight-at-most-roll" => {
                ObjectGroupRollFilter::WeightAtMostRoll
            }
            Some(DecisionValue::String(value)) if value == "weight-at-least-roll" => {
                ObjectGroupRollFilter::WeightAtLeastRoll
            }
            _ => {
                return Err(ProfileError::InvalidField(
                    "decisions.generator.object-group-roll-filter",
                ));
            }
        };
        let path_no_route_result = match stated[1] {
            Some(DecisionValue::Integer(3)) => 3,
            Some(DecisionValue::Integer(4)) => 4,
            _ => {
                return Err(ProfileError::InvalidField(
                    "decisions.generator.path-no-route-result",
                ));
            }
        };
        let building_spawn_placement = match stated[2] {
            Some(DecisionValue::String(value)) if value == "inner-tile-fallback" => {
                BuildingSpawnPlacement::InnerTileFallback
            }
            Some(DecisionValue::String(value)) if value == "unit-ring-nearest-default" => {
                BuildingSpawnPlacement::UnitRingNearestDefault
            }
            _ => {
                return Err(ProfileError::InvalidField(
                    "decisions.generator.building-spawn-placement",
                ));
            }
        };
        let foundation_terrain_remap = match stated[3] {
            Some(DecisionValue::String(value)) if value == "remap-8-to-27-and-64-to-54" => {
                FoundationTerrainRemap::Remap8To27And64To54
            }
            Some(DecisionValue::String(value)) if value == "none" => FoundationTerrainRemap::None,
            _ => {
                return Err(ProfileError::InvalidField(
                    "decisions.generator.foundation-terrain-remap",
                ));
            }
        };
        Ok(GenerationRules {
            object_group_roll_filter,
            path_no_route_result,
            building_spawn_placement,
            foundation_terrain_remap,
        })
    }

    pub fn validate(&self) -> Result<(), ProfileError> {
        if (self.schema_version != PROFILE_SCHEMA_VERSION && !self.is_schema_1_1())
            || self.compatibility.minimum_major != PROFILE_SCHEMA_MAJOR
            || self.compatibility.maximum_major != PROFILE_SCHEMA_MAJOR
        {
            return Err(ProfileError::UnsupportedSchema(self.schema_version.clone()));
        }
        validate_identifier("profile", &self.profile_id, 64)?;
        if self.behavior_version.is_empty()
            || self.behavior_version.len() > 64
            || self.behavior_version.chars().any(char::is_control)
        {
            return Err(ProfileError::InvalidField("behaviorVersion"));
        }
        if self.product_versions.len() > 256 {
            return Err(ProfileError::ResourceLimit("productVersions"));
        }
        if !self
            .product_versions
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        {
            return Err(ProfileError::NonCanonicalOrdering("productVersions"));
        }
        for product_version in &self.product_versions {
            if product_version.is_empty()
                || product_version.len() > 64
                || product_version.chars().any(char::is_control)
            {
                return Err(ProfileError::InvalidField("productVersions"));
            }
        }
        if !self.unverified_product_versions.is_empty() && !self.is_schema_1_1() {
            return Err(ProfileError::InvalidField(
                "unverifiedProductVersions requires schema 1.1.0",
            ));
        }
        if self.unverified_product_versions.len() > 256 {
            return Err(ProfileError::ResourceLimit("unverifiedProductVersions"));
        }
        if !self
            .unverified_product_versions
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        {
            return Err(ProfileError::NonCanonicalOrdering(
                "unverifiedProductVersions",
            ));
        }
        for product_version in &self.unverified_product_versions {
            if parse_product_version(product_version).is_none() {
                return Err(ProfileError::InvalidField("unverifiedProductVersions"));
            }
            if self.product_versions.contains(product_version) {
                return Err(ProfileError::InvalidField(
                    "a product version is both verified and unverified",
                ));
            }
        }
        if self.capabilities.len() > 256 {
            return Err(ProfileError::ResourceLimit("capabilities"));
        }
        for capability in self.capabilities.keys() {
            validate_identifier("capability", capability, 64)?;
        }
        if self.capabilities.get("exact-generation") == Some(&CapabilityStatus::Complete) {
            for prerequisite in EXACT_GENERATION_PREREQUISITES {
                if self.capabilities.get(prerequisite) != Some(&CapabilityStatus::Complete) {
                    return Err(ProfileError::UnsatisfiedCapabilityPrerequisite {
                        capability: "exact-generation",
                        prerequisite,
                    });
                }
            }
        }
        for decisions in [
            &self.decisions.parser,
            &self.decisions.rng,
            &self.decisions.generator,
            &self.decisions.observed_failures,
        ] {
            if decisions.len() > 1024 {
                return Err(ProfileError::ResourceLimit("decisions"));
            }
            for key in decisions.keys() {
                validate_identifier("decision", key, 96)?;
            }
            for value in decisions.values() {
                if let DecisionValue::String(value) = value
                    && (value.len() > 256 || value.chars().any(char::is_control))
                {
                    return Err(ProfileError::InvalidField("decision value"));
                }
            }
        }
        if self.semantic_token_aliases.len() > 1024 {
            return Err(ProfileError::ResourceLimit("semanticTokenAliases"));
        }
        for alias in self.semantic_token_aliases.values() {
            validate_identifier("semanticTokenAliases", alias, 64)?;
        }
        if let Some(palettes) = &self.minimap_palettes {
            if palettes.schema_version != MINIMAP_PALETTE_SCHEMA_VERSION {
                return Err(ProfileError::UnsupportedMinimapPaletteSchema(
                    palettes.schema_version.clone(),
                ));
            }
            validate_identifier(
                "minimap derivation contract",
                &palettes.derivation_contract,
                96,
            )?;
            if palettes.entries.is_empty() || palettes.entries.len() > 256 {
                return Err(ProfileError::ResourceLimit("minimap palette entries"));
            }
            if !palettes.entries.windows(2).all(|pair| {
                compare_product_versions(&pair[0].product_version, &pair[1].product_version)
                    == Some(std::cmp::Ordering::Less)
            }) {
                return Err(ProfileError::NonCanonicalOrdering(
                    "minimap palette entries",
                ));
            }
            for entry in &palettes.entries {
                validate_identifier("minimap palette", &entry.palette_id, 96)?;
                if parse_product_version(&entry.product_version).is_none() {
                    return Err(ProfileError::InvalidField("minimap palette productVersion"));
                }
                validate_minimap_colors(entry)?;
            }
        }
        self.generation_rules()?;
        Ok(())
    }

    pub fn supports_exact_generation(&self) -> bool {
        self.capabilities.get("exact-generation") == Some(&CapabilityStatus::Complete)
            && EXACT_GENERATION_PREREQUISITES.iter().all(|prerequisite| {
                self.capabilities.get(*prerequisite) == Some(&CapabilityStatus::Complete)
            })
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProfileError> {
        self.validate()?;
        let mut copy = self.clone();
        copy.schema = None;
        copy.minimap_palettes = None;
        let bytes = serde_json::to_vec(&copy).map_err(ProfileError::Serialize)?;
        if bytes.len() > MAXIMUM_PROFILE_BYTES {
            return Err(ProfileError::ResourceLimit("canonical profile"));
        }
        Ok(bytes)
    }

    pub fn deterministic_hash(&self) -> Result<[u8; 32], ProfileError> {
        Ok(Sha256::digest(self.canonical_bytes()?).into())
    }

    pub fn minimap_palette_hash(&self) -> Result<Option<[u8; 32]>, ProfileError> {
        self.validate()?;
        self.minimap_palettes
            .as_ref()
            .map(|palettes| {
                serde_json::to_vec(palettes)
                    .map(|bytes| Sha256::digest(bytes).into())
                    .map_err(ProfileError::Serialize)
            })
            .transpose()
    }

    pub fn resolve_minimap_palette(
        &self,
        detected_product_version: Option<&str>,
    ) -> Option<MinimapPaletteResolution<'_>> {
        let palettes = self.minimap_palettes.as_ref()?;
        let exact = detected_product_version.and_then(|product_version| {
            palettes
                .entries
                .iter()
                .find(|entry| entry.product_version == product_version)
        });
        let entry = exact.or_else(|| palettes.entries.last())?;
        Some(MinimapPaletteResolution {
            entry,
            exact_product_version: exact.is_some(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProfileCatalog {
    profiles: BTreeMap<String, BehaviorProfile>,
    product_versions: BTreeMap<String, String>,
    unverified_product_versions: BTreeMap<String, String>,
}

impl ProfileCatalog {
    pub fn new(profiles: impl IntoIterator<Item = BehaviorProfile>) -> Result<Self, ProfileError> {
        let mut by_id = BTreeMap::new();
        let mut by_product = BTreeMap::new();
        let mut by_unverified_product = BTreeMap::new();
        for profile in profiles {
            profile.validate()?;
            let profile_id = profile.profile_id.clone();
            if by_id.insert(profile_id.clone(), profile).is_some() {
                return Err(ProfileError::DuplicateProfile(profile_id));
            }
            let profile = &by_id[&profile_id];
            for (product_version, verified) in profile
                .product_versions
                .iter()
                .map(|version| (version, true))
                .chain(
                    profile
                        .unverified_product_versions
                        .iter()
                        .map(|version| (version, false)),
                )
            {
                let previous = by_product
                    .get(product_version)
                    .or_else(|| by_unverified_product.get(product_version))
                    .cloned();
                if let Some(previous) = previous {
                    return Err(ProfileError::DuplicateProductVersion {
                        product_version: product_version.clone(),
                        first_profile: previous,
                        second_profile: profile_id,
                    });
                }
                let map = if verified {
                    &mut by_product
                } else {
                    &mut by_unverified_product
                };
                map.insert(product_version.clone(), profile_id.clone());
            }
        }
        Ok(Self {
            profiles: by_id,
            product_versions: by_product,
            unverified_product_versions: by_unverified_product,
        })
    }

    pub fn frozen_current() -> Result<Self, ProfileError> {
        Self::new(frozen_profiles()?)
    }

    pub fn frozen_shared() -> Result<&'static Self, ProfileError> {
        static CATALOG: OnceLock<Result<ProfileCatalog, String>> = OnceLock::new();
        CATALOG
            .get_or_init(|| Self::frozen_current().map_err(|error| error.to_string()))
            .as_ref()
            .map_err(|error| ProfileError::FrozenCatalog(error.clone()))
    }

    pub fn profiles(&self) -> impl ExactSizeIterator<Item = &BehaviorProfile> {
        self.profiles.values()
    }

    pub fn get(&self, profile_id: &str) -> Option<&BehaviorProfile> {
        self.profiles.get(profile_id)
    }

    pub fn for_product_version(&self, product_version: &str) -> Option<&BehaviorProfile> {
        self.product_versions
            .get(product_version)
            .and_then(|profile_id| self.profiles.get(profile_id))
    }

    pub fn for_unverified_product_version(
        &self,
        product_version: &str,
    ) -> Option<&BehaviorProfile> {
        self.unverified_product_versions
            .get(product_version)
            .and_then(|profile_id| self.profiles.get(profile_id))
    }

    fn latest_versioned_profile(&self) -> Option<&BehaviorProfile> {
        let (_, profile_id) = self
            .product_versions
            .iter()
            .filter(|(version, _)| parse_product_version(version).is_some())
            .max_by(|(left, _), (right, _)| {
                compare_product_versions(left, right).unwrap_or(std::cmp::Ordering::Equal)
            })?;
        self.profiles.get(profile_id)
    }

    pub fn for_unknown_product_version(&self, product_version: &str) -> Option<&BehaviorProfile> {
        let nearest_lower = parse_product_version(product_version)
            .filter(|parts| parts.len() >= 2)
            .and_then(|unknown| {
                self.product_versions
                    .iter()
                    .chain(&self.unverified_product_versions)
                    .filter_map(|(label, profile_id)| {
                        let known = parse_product_version(label)?;
                        (known.len() >= 2
                            && known[..2] == unknown[..2]
                            && compare_product_versions(label, product_version)
                                .is_some_and(std::cmp::Ordering::is_le))
                        .then_some((label, profile_id))
                    })
                    .max_by(|(left, _), (right, _)| {
                        compare_product_versions(left, right).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .and_then(|(_, profile_id)| self.profiles.get(profile_id))
            });
        nearest_lower.or_else(|| self.latest_versioned_profile())
    }

    pub fn resolve(
        &self,
        detected_product_version: Option<&str>,
        selection: &ProfileSelection,
    ) -> Result<ProfileResolution<'_>, ProfileError> {
        if let Some(profile_id) = selection.session_override.as_deref() {
            return self.explicit_resolution(profile_id, SelectionSource::SessionOverride);
        }
        if let Some(profile_id) = selection.folder_pin.as_deref() {
            return self.explicit_resolution(profile_id, SelectionSource::FolderPin);
        }
        let Some(product_version) = detected_product_version else {
            return Ok(ProfileResolution::EditingOnly {
                reason: EditingOnlyReason::NoInstallationVersion,
            });
        };
        let mapped = self
            .for_product_version(product_version)
            .map(|profile| (profile, GenerationCertification::VersionMapped))
            .or_else(|| {
                self.for_unverified_product_version(product_version)
                    .map(|profile| (profile, GenerationCertification::UnverifiedProductVersion))
            });
        let (profile, certification) = match mapped {
            Some(mapped) => mapped,
            None => {
                let Some(profile) = self.for_unknown_product_version(product_version) else {
                    return Ok(ProfileResolution::EditingOnly {
                        reason: EditingOnlyReason::UnknownProductVersion(
                            product_version.to_owned(),
                        ),
                    });
                };
                (profile, GenerationCertification::UnverifiedProductVersion)
            }
        };
        Ok(ProfileResolution::Executable {
            profile,
            source: SelectionSource::Auto,
            certification,
        })
    }

    fn explicit_resolution(
        &self,
        profile_id: &str,
        source: SelectionSource,
    ) -> Result<ProfileResolution<'_>, ProfileError> {
        let profile = self
            .get(profile_id)
            .ok_or_else(|| ProfileError::UnknownProfile(profile_id.to_owned()))?;
        Ok(ProfileResolution::Executable {
            profile,
            source,
            certification: GenerationCertification::UncertifiedExplicitSelection,
        })
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProfileSelection {
    pub session_override: Option<String>,
    pub folder_pin: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectionSource {
    Auto,
    SessionOverride,
    FolderPin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationCertification {
    VersionMapped,
    UnverifiedProductVersion,
    UncertifiedExplicitSelection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditingOnlyReason {
    NoInstallationVersion,
    UnknownProductVersion(String),
}

#[derive(Clone, Debug)]
pub enum ProfileResolution<'a> {
    Executable {
        profile: &'a BehaviorProfile,
        source: SelectionSource,
        certification: GenerationCertification,
    },
    EditingOnly {
        reason: EditingOnlyReason,
    },
}

pub fn frozen_current_profile() -> Result<BehaviorProfile, ProfileError> {
    parse_frozen(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../profiles/aoe2de-101.103.48987-rms-v1.json"
    )))
}

pub fn frozen_54800_profile() -> Result<BehaviorProfile, ProfileError> {
    parse_frozen(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../profiles/aoe2de-101.103.54800-rms-v1.json"
    )))
}

pub fn frozen_texture_palettes(profile_id: &str) -> Result<Option<TexturePalettes>, ProfileError> {
    let text = match profile_id {
        CURRENT_PROFILE_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/texture-palettes/aoe2de-101.103.48987-rms-v1.json"
        )),
        PROFILE_54800_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/texture-palettes/aoe2de-101.103.54800-rms-v1.json"
        )),
        _ => return Ok(None),
    };
    let palettes = serde_json::from_str::<TexturePalettes>(text).map_err(ProfileError::Parse)?;
    palettes.validate()?;
    if palettes.profile_id != profile_id {
        return Err(ProfileError::InvalidField("texture palette profileId"));
    }
    Ok(Some(palettes))
}

pub fn frozen_profiles() -> Result<Vec<BehaviorProfile>, ProfileError> {
    Ok(vec![frozen_current_profile()?, frozen_54800_profile()?])
}

fn parse_frozen(text: &str) -> Result<BehaviorProfile, ProfileError> {
    let profile = serde_json::from_str::<BehaviorProfile>(text).map_err(ProfileError::Parse)?;
    profile.validate()?;
    Ok(profile)
}

fn validate_texture_palettes(palettes: &TexturePalettes) -> Result<(), ProfileError> {
    if palettes.schema_version != TEXTURE_PALETTE_SCHEMA_VERSION {
        return Err(ProfileError::UnsupportedTexturePaletteSchema(
            palettes.schema_version.clone(),
        ));
    }
    validate_identifier(
        "texture palette derivation contract",
        &palettes.derivation_contract,
        96,
    )?;
    if palettes.entries.is_empty() || palettes.entries.len() > 256 {
        return Err(ProfileError::ResourceLimit("texture palette entries"));
    }
    if !palettes.entries.windows(2).all(|pair| {
        compare_product_versions(&pair[0].product_version, &pair[1].product_version)
            == Some(std::cmp::Ordering::Less)
    }) {
        return Err(ProfileError::NonCanonicalOrdering(
            "texture palette entries",
        ));
    }
    for entry in &palettes.entries {
        validate_identifier("texture palette", &entry.palette_id, 96)?;
        if parse_product_version(&entry.product_version).is_none() {
            return Err(ProfileError::InvalidField("texture palette productVersion"));
        }
        let provenance = &entry.provenance;
        if provenance.tool.is_empty()
            || provenance.tool.len() > 256
            || provenance.tool.chars().any(char::is_control)
        {
            return Err(ProfileError::InvalidField(
                "texture palette provenance tool",
            ));
        }
        if parse_product_version(&provenance.installation_build).is_none() {
            return Err(ProfileError::InvalidField(
                "texture palette provenance installationBuild",
            ));
        }
        if !is_calendar_date(&provenance.derived_on) {
            return Err(ProfileError::InvalidField(
                "texture palette provenance derivedOn",
            ));
        }
        if entry.terrain_colors.is_empty()
            || entry.terrain_colors.len() > 4096
            || entry.object_colors.is_empty()
            || entry.object_colors.len() > 100_000
            || entry.cliff_colors.is_empty()
            || entry.cliff_colors.len() > 4096
        {
            return Err(ProfileError::ResourceLimit("texture palette mappings"));
        }
        if !entry
            .terrain_colors
            .windows(2)
            .all(|pair| pair[0].terrain_id < pair[1].terrain_id)
            || !entry
                .object_colors
                .windows(2)
                .all(|pair| pair[0].object_id < pair[1].object_id)
            || !entry
                .cliff_colors
                .windows(2)
                .all(|pair| pair[0].cliff_type < pair[1].cliff_type)
        {
            return Err(ProfileError::NonCanonicalOrdering(
                "texture palette mappings",
            ));
        }
        if entry
            .terrain_colors
            .iter()
            .any(|color| color.color > 0x00ff_ffff)
            || entry
                .object_colors
                .iter()
                .any(|color| color.color > 0x00ff_ffff)
            || entry
                .cliff_colors
                .iter()
                .any(|color| color.color > 0x00ff_ffff)
        {
            return Err(ProfileError::InvalidField("texture palette color"));
        }
    }
    Ok(())
}

fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || !bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) == (*byte == b'-')
                && (matches!(index, 4 | 7) || byte.is_ascii_digit())
        })
    {
        return false;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<u32>().unwrap_or(0);
    (1..=12).contains(&number(5..7)) && (1..=31).contains(&number(8..10))
}

fn validate_minimap_colors(entry: &MinimapPaletteEntry) -> Result<(), ProfileError> {
    if entry.terrain_colors.is_empty()
        || entry.terrain_colors.len() > 4096
        || entry.neutral_object_colors.is_empty()
        || entry.neutral_object_colors.len() > 100_000
        || entry.cliff_colors.is_empty()
        || entry.cliff_colors.len() > 4096
    {
        return Err(ProfileError::ResourceLimit("minimap palette mappings"));
    }
    if !entry
        .terrain_colors
        .windows(2)
        .all(|pair| pair[0].terrain_id < pair[1].terrain_id)
        || !entry
            .neutral_object_colors
            .windows(2)
            .all(|pair| pair[0].object_id < pair[1].object_id)
        || !entry
            .cliff_colors
            .windows(2)
            .all(|pair| pair[0].cliff_type < pair[1].cliff_type)
    {
        return Err(ProfileError::NonCanonicalOrdering(
            "minimap palette mappings",
        ));
    }
    let invalid_color = entry.terrain_colors.iter().any(|color| {
        color.high_color > 0x00ff_ffff
            || color.medium_color > 0x00ff_ffff
            || color.low_color > 0x00ff_ffff
    }) || entry
        .neutral_object_colors
        .iter()
        .any(|color| color.color > 0x00ff_ffff)
        || entry
            .cliff_colors
            .iter()
            .any(|color| color.left_color > 0x00ff_ffff || color.right_color > 0x00ff_ffff);
    if invalid_color {
        return Err(ProfileError::InvalidField("minimap palette color"));
    }
    Ok(())
}

fn parse_product_version(value: &str) -> Option<Vec<u32>> {
    if value.is_empty() || value.len() > 64 {
        return None;
    }
    value
        .split('.')
        .map(|part| {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                None
            } else {
                part.parse::<u32>().ok()
            }
        })
        .collect()
}

fn compare_product_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let mut left = parse_product_version(left)?;
    let mut right = parse_product_version(right)?;
    let width = left.len().max(right.len());
    left.resize(width, 0);
    right.resize(width, 0);
    Some(left.cmp(&right))
}

fn validate_identifier(
    label: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ProfileError> {
    let mut characters = value.chars();
    let valid_first = characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
    let valid_rest = characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
    });
    if !valid_first || !valid_rest || value.len() > maximum {
        return Err(ProfileError::InvalidIdentifier {
            label,
            value: value.to_owned(),
        });
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("unsupported profile schema version {0}")]
    UnsupportedSchema(String),
    #[error("unsupported minimap palette schema version {0}")]
    UnsupportedMinimapPaletteSchema(String),
    #[error("unsupported texture palette schema version {0}")]
    UnsupportedTexturePaletteSchema(String),
    #[error("unsupported constant kinds schema version {0}")]
    UnsupportedConstantKindsSchema(String),
    #[error("unsupported construct verification table schema version {0}")]
    UnsupportedCertifiedConstructsSchema(String),
    #[error("profile field {0} is invalid")]
    InvalidField(&'static str),
    #[error("profile resource limit exceeded for {0}")]
    ResourceLimit(&'static str),
    #[error("{label} identifier is invalid: {value}")]
    InvalidIdentifier { label: &'static str, value: String },
    #[error("profile field {0} is not in canonical sorted order")]
    NonCanonicalOrdering(&'static str),
    #[error("capability {capability} needs {prerequisite} to be complete")]
    UnsatisfiedCapabilityPrerequisite {
        capability: &'static str,
        prerequisite: &'static str,
    },
    #[error("duplicate profile identity {0}")]
    DuplicateProfile(String),
    #[error("product version {product_version} maps to both {first_profile} and {second_profile}")]
    DuplicateProductVersion {
        product_version: String,
        first_profile: String,
        second_profile: String,
    },
    #[error("unknown behavior profile {0}")]
    UnknownProfile(String),
    #[error("the built-in game version catalog is invalid: {0}")]
    FrozenCatalog(String),
    #[error("profile JSON is invalid: {0}")]
    Parse(serde_json::Error),
    #[error("profile canonicalization failed: {0}")]
    Serialize(serde_json::Error),
}
