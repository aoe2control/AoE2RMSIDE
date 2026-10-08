use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::{
    CURRENT_PROFILE_ID, CompatibilityRange, PROFILE_54800_ID, ProfileError,
    compare_product_versions, is_calendar_date, parse_product_version, validate_identifier,
};

pub const CERTIFIED_CONSTRUCTS_SCHEMA_VERSION: &str = "1.0.0";
pub const CERTIFIED_CONSTRUCTS_SCHEMA_MAJOR: u32 = 1;
pub const CERTIFIED_CONSTRUCTS_DERIVATION_CONTRACT: &str =
    "aoe2de-native-capture-executed-constructs-v1";
pub const MAXIMUM_CERTIFIED_CONSTRUCTS: usize = 4096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CertifiedConstructsSource {
    MatchedNativeCaptures,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertifiedConstructsProvenance {
    pub tool: String,
    pub native_build: String,
    pub matched_cases: u32,
    pub executions_sha256: String,
    pub derived_on: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertifiedConstruct {
    pub context: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertifiedConstructsEntry {
    pub table_id: String,
    pub product_version: String,
    pub source: CertifiedConstructsSource,
    pub provenance: CertifiedConstructsProvenance,
    pub constructs: Vec<CertifiedConstruct>,
}

impl CertifiedConstructsEntry {
    pub fn contains(&self, context: &str, name: &str) -> bool {
        self.constructs
            .binary_search_by(|construct| {
                construct
                    .context
                    .as_str()
                    .cmp(context)
                    .then_with(|| construct.name.as_str().cmp(name))
            })
            .is_ok()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertifiedConstructs {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub profile_id: String,
    pub derivation_contract: String,
    pub entries: Vec<CertifiedConstructsEntry>,
}

impl CertifiedConstructs {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.schema_version != CERTIFIED_CONSTRUCTS_SCHEMA_VERSION
            || self.compatibility.minimum_major != CERTIFIED_CONSTRUCTS_SCHEMA_MAJOR
            || self.compatibility.maximum_major != CERTIFIED_CONSTRUCTS_SCHEMA_MAJOR
        {
            return Err(ProfileError::UnsupportedCertifiedConstructsSchema(
                self.schema_version.clone(),
            ));
        }
        validate_identifier("construct verification table profile", &self.profile_id, 64)?;
        if self.derivation_contract != CERTIFIED_CONSTRUCTS_DERIVATION_CONTRACT {
            return Err(ProfileError::InvalidField(
                "construct verification table derivationContract",
            ));
        }
        if self.entries.is_empty() || self.entries.len() > 256 {
            return Err(ProfileError::ResourceLimit(
                "construct verification table entries",
            ));
        }
        if !self.entries.windows(2).all(|pair| {
            compare_product_versions(&pair[0].product_version, &pair[1].product_version)
                == Some(Ordering::Less)
        }) {
            return Err(ProfileError::NonCanonicalOrdering(
                "construct verification table entries",
            ));
        }
        self.entries.iter().try_for_each(validate_entry)
    }

    pub fn entry(&self, product_version: &str) -> Option<&CertifiedConstructsEntry> {
        self.entries
            .iter()
            .find(|entry| entry.product_version == product_version)
    }
}

fn valid_context(context: &str) -> bool {
    let header = context
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
        .is_some_and(|inner| {
            (1..=63).contains(&inner.len())
                && inner.starts_with(|character: char| character.is_ascii_uppercase())
                && inner
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        });
    let block = context.strip_prefix("create_").is_some_and(|rest| {
        (1..=57).contains(&rest.len())
            && rest.starts_with(|character: char| character.is_ascii_lowercase())
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    });
    context.is_empty() || header || block
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.starts_with(|character: char| character.is_ascii_lowercase())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn validate_entry(entry: &CertifiedConstructsEntry) -> Result<(), ProfileError> {
    validate_identifier("construct verification table table", &entry.table_id, 96)?;
    if parse_product_version(&entry.product_version).is_none() {
        return Err(ProfileError::InvalidField(
            "construct verification table productVersion",
        ));
    }
    let provenance = &entry.provenance;
    if provenance.tool.is_empty()
        || provenance.tool.len() > 256
        || provenance.tool.chars().any(char::is_control)
    {
        return Err(ProfileError::InvalidField(
            "construct verification table provenance tool",
        ));
    }
    if provenance.native_build != entry.product_version {
        return Err(ProfileError::InvalidField(
            "construct verification table provenance nativeBuild",
        ));
    }
    if provenance.matched_cases == 0 || provenance.matched_cases > 10_000 {
        return Err(ProfileError::InvalidField(
            "construct verification table provenance matchedCases",
        ));
    }
    let hex = provenance.executions_sha256.len() == 64
        && provenance
            .executions_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !hex {
        return Err(ProfileError::InvalidField(
            "construct verification table provenance executionsSha256",
        ));
    }
    if !is_calendar_date(&provenance.derived_on) {
        return Err(ProfileError::InvalidField(
            "construct verification table provenance derivedOn",
        ));
    }
    if entry.constructs.is_empty() || entry.constructs.len() > MAXIMUM_CERTIFIED_CONSTRUCTS {
        return Err(ProfileError::ResourceLimit("construct verification table"));
    }
    if !entry
        .constructs
        .iter()
        .all(|construct| valid_context(&construct.context) && valid_name(&construct.name))
    {
        return Err(ProfileError::InvalidField(
            "construct verification table construct",
        ));
    }
    if !entry.constructs.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(ProfileError::NonCanonicalOrdering(
            "construct verification table",
        ));
    }
    Ok(())
}

pub fn frozen_certified_constructs(
    profile_id: &str,
) -> Result<Option<CertifiedConstructs>, ProfileError> {
    let text = match profile_id {
        CURRENT_PROFILE_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/certified-constructs/aoe2de-101.103.48987-rms-v1.json"
        )),
        PROFILE_54800_ID => include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../profiles/certified-constructs/aoe2de-101.103.54800-rms-v1.json"
        )),
        _ => return Ok(None),
    };
    let constructs =
        serde_json::from_str::<CertifiedConstructs>(text).map_err(ProfileError::Parse)?;
    constructs.validate()?;
    if constructs.profile_id != profile_id {
        return Err(ProfileError::InvalidField(
            "construct verification table profileId",
        ));
    }
    Ok(Some(constructs))
}
