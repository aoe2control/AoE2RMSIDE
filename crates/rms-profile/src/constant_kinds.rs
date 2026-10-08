use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    CURRENT_PROFILE_ID, CompatibilityRange, PROFILE_54800_ID, PROFILE_SCHEMA_MAJOR, ProfileError,
    compare_product_versions, is_calendar_date, parse_product_version, validate_identifier,
};

pub const CONSTANT_KINDS_SCHEMA_VERSION: &str = "1.0.0";
pub const CONSTANT_KINDS_DERIVATION_CONTRACT: &str = "aoe2de-definition-heading-kinds-v1";
pub const MAXIMUM_CONSTANT_KIND_NAMES: usize = 100_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConstantKind {
    Object,
    ObjectClass,
    Terrain,
    CliffType,
    MapType,
    ColorCorrection,
    WaterDefinition,
    Civilization,
    AssignType,
    Effect,
    EffectType,
    ModifyTech,
    PlayerData,
    Attribute,
    Resource,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConstantKindsSource {
    DefinitionFileHeadings,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstantKindsProvenance {
    pub tool: String,
    pub installation_build: String,
    pub input_file: String,
    pub input_sha256: String,
    pub definitions_sha256: String,
    pub derived_on: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedConstantKind {
    pub name: String,
    pub kind: ConstantKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstantKindsEntry {
    pub table_id: String,
    pub product_version: String,
    pub source: ConstantKindsSource,
    pub provenance: ConstantKindsProvenance,
    pub names: Vec<NamedConstantKind>,
}

impl ConstantKindsEntry {
    pub fn kinds(&self) -> BTreeMap<&str, ConstantKind> {
        self.names
            .iter()
            .map(|named| (named.name.as_str(), named.kind))
            .collect()
    }

    pub fn kind_of(&self, name: &str) -> Option<ConstantKind> {
        self.names
            .binary_search_by(|named| named.name.as_str().cmp(name))
            .ok()
            .map(|index| self.names[index].kind)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstantKinds {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub profile_id: String,
    pub derivation_contract: String,
    pub entries: Vec<ConstantKindsEntry>,
}

impl ConstantKinds {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.schema_version != CONSTANT_KINDS_SCHEMA_VERSION
            || self.compatibility.minimum_major != PROFILE_SCHEMA_MAJOR
            || self.compatibility.maximum_major != PROFILE_SCHEMA_MAJOR
        {
            return Err(ProfileError::UnsupportedConstantKindsSchema(
                self.schema_version.clone(),
            ));
        }
        validate_identifier("constant kinds profile", &self.profile_id, 64)?;
        if self.derivation_contract != CONSTANT_KINDS_DERIVATION_CONTRACT {
            return Err(ProfileError::InvalidField(
                "constant kinds derivationContract",
            ));
        }
        if self.entries.is_empty() || self.entries.len() > 256 {
            return Err(ProfileError::ResourceLimit("constant kinds entries"));
        }
        if !self.entries.windows(2).all(|pair| {
            compare_product_versions(&pair[0].product_version, &pair[1].product_version)
                == Some(std::cmp::Ordering::Less)
        }) {
            return Err(ProfileError::NonCanonicalOrdering("constant kinds entries"));
        }
        self.entries.iter().try_for_each(validate_entry)
    }

    pub fn entry(&self, product_version: &str) -> Option<&ConstantKindsEntry> {
        self.entries
            .iter()
            .find(|entry| entry.product_version == product_version)
    }
}

fn validate_entry(entry: &ConstantKindsEntry) -> Result<(), ProfileError> {
    validate_identifier("constant kinds table", &entry.table_id, 96)?;
    if parse_product_version(&entry.product_version).is_none() {
        return Err(ProfileError::InvalidField("constant kinds productVersion"));
    }
    let provenance = &entry.provenance;
    if provenance.tool.is_empty()
        || provenance.tool.len() > 256
        || provenance.tool.chars().any(char::is_control)
    {
        return Err(ProfileError::InvalidField("constant kinds provenance tool"));
    }
    if parse_product_version(&provenance.installation_build).is_none() {
        return Err(ProfileError::InvalidField(
            "constant kinds provenance installationBuild",
        ));
    }
    let relative_path = !provenance.input_file.is_empty()
        && provenance.input_file.len() <= 256
        && provenance.input_file.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        });
    if !relative_path {
        return Err(ProfileError::InvalidField(
            "constant kinds provenance inputFile",
        ));
    }
    let hex = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !hex(&provenance.input_sha256) || !hex(&provenance.definitions_sha256) {
        return Err(ProfileError::InvalidField(
            "constant kinds provenance sha256",
        ));
    }
    if !is_calendar_date(&provenance.derived_on) {
        return Err(ProfileError::InvalidField(
            "constant kinds provenance derivedOn",
        ));
    }
    if entry.names.is_empty() || entry.names.len() > MAXIMUM_CONSTANT_KIND_NAMES {
        return Err(ProfileError::ResourceLimit("constant kinds names"));
    }
    let valid_name = |name: &str| {
        let mut bytes = name.bytes();
        name.len() <= 128
            && bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    };
    if !entry.names.iter().all(|named| valid_name(&named.name)) {
        return Err(ProfileError::InvalidField("constant kinds name"));
    }
    if !entry
        .names
        .windows(2)
        .all(|pair| pair[0].name < pair[1].name)
    {
        return Err(ProfileError::NonCanonicalOrdering("constant kinds names"));
    }
    Ok(())
}

pub fn frozen_constant_kinds(profile_id: &str) -> Result<Option<ConstantKinds>, ProfileError> {
    let text = match profile_id {
        CURRENT_PROFILE_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/constant-kinds/aoe2de-101.103.48987-rms-v1.json"
        )),
        PROFILE_54800_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/constant-kinds/aoe2de-101.103.54800-rms-v1.json"
        )),
        _ => return Ok(None),
    };
    let kinds = serde_json::from_str::<ConstantKinds>(text).map_err(ProfileError::Parse)?;
    kinds.validate()?;
    if kinds.profile_id != profile_id {
        return Err(ProfileError::InvalidField("constant kinds profileId"));
    }
    Ok(Some(kinds))
}
