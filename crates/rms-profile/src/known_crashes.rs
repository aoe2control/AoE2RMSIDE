use serde::{Deserialize, Serialize};

use crate::{
    CURRENT_PROFILE_ID, CompatibilityRange, PROFILE_54800_ID, ProfileError, parse_product_version,
};

pub const KNOWN_CRASHES_SCHEMA_VERSION: &str = "1.0.0";
pub const KNOWN_CRASHES_SCHEMA_MAJOR: u32 = 1;
pub const KNOWN_CRASHES_CATALOG_ID: &str = "aoe2de-rms-known-crashes-v1";
pub const MAXIMUM_KNOWN_CRASHES: usize = 256;
pub const KNOWN_CRASH_PLACEHOLDERS: [&str; 3] = ["command", "terrain", "word"];
pub const KNOWN_CRASH_LINT_CODE: &str = "RMS4012";

const MAXIMUM_ID_BYTES: usize = 64;
const MAXIMUM_TITLE_BYTES: usize = 160;
const MAXIMUM_SENTENCE_BYTES: usize = 400;
const MAXIMUM_DOC_TERMS: usize = 8;
const MAXIMUM_TERMS_PER_NOTE: usize = 8;
const MAXIMUM_PLACES_PER_NOTE: usize = 8;
const SECTIONS: [&str; 7] = [
    "cliff_generation",
    "connection_generation",
    "elevation_generation",
    "land_generation",
    "objects_generation",
    "player_setup",
    "terrain_generation",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownCrashDependence {
    Path,
    Seed,
    MapSize,
    Players,
    Positions,
    Lobby,
    Content,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownCrashTiming {
    Generation,
    Match,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownCrashStage {
    Parser,
    Lint,
    Generation,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownCrashDetector {
    pub stage: KnownCrashStage,
    pub code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownCrashDocTerms {
    pub terms: Vec<String>,
    pub places: Vec<String>,
    pub note: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownCrashEvidenceQuality {
    Live,
    Static,
    Inferred,
}

impl KnownCrashEvidenceQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Static => "static",
            Self::Inferred => "inferred",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownCrashEvidence {
    pub quality: KnownCrashEvidenceQuality,
    pub live_profiles: Vec<String>,
    pub static_profiles: Vec<String>,
    pub inferred_profiles: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KnownCrashStatus {
    Active,
    Retired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownCrash {
    pub id: String,
    pub title: String,
    pub cause: String,
    pub fix: Option<String>,
    pub depends_on: Vec<KnownCrashDependence>,
    pub timing: KnownCrashTiming,
    pub detectors: Vec<KnownCrashDetector>,
    pub doc_terms: Vec<KnownCrashDocTerms>,
    pub evidence: KnownCrashEvidence,
    pub status: KnownCrashStatus,
    pub retired_in: Option<String>,
}

impl KnownCrash {
    pub fn warns(&self) -> bool {
        self.status == KnownCrashStatus::Active
            && self.evidence.quality != KnownCrashEvidenceQuality::Inferred
    }

    pub fn covers_profile(&self, profile_id: &str) -> bool {
        let evidence = &self.evidence;
        [
            &evidence.live_profiles,
            &evidence.static_profiles,
            &evidence.inferred_profiles,
        ]
        .into_iter()
        .any(|profiles| profiles.iter().any(|profile| profile == profile_id))
    }

    pub fn placeholders(&self) -> Vec<&str> {
        placeholders(&self.cause).unwrap_or_default()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownCrashes {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub catalog_id: String,
    pub profiles: Vec<String>,
    pub entries: Vec<KnownCrash>,
}

impl KnownCrashes {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.schema_version != KNOWN_CRASHES_SCHEMA_VERSION
            || self.compatibility.minimum_major != KNOWN_CRASHES_SCHEMA_MAJOR
            || self.compatibility.maximum_major != KNOWN_CRASHES_SCHEMA_MAJOR
        {
            return Err(ProfileError::UnsupportedKnownCrashesSchema(
                self.schema_version.clone(),
            ));
        }
        if self.catalog_id != KNOWN_CRASHES_CATALOG_ID {
            return Err(ProfileError::InvalidField("known crashes catalogId"));
        }
        let known_profiles = [CURRENT_PROFILE_ID, PROFILE_54800_ID];
        if self.profiles.is_empty()
            || !self
                .profiles
                .iter()
                .all(|profile| known_profiles.contains(&profile.as_str()))
            || !strictly_ascending(&self.profiles)
        {
            return Err(ProfileError::InvalidField("known crashes profiles"));
        }
        if self.entries.is_empty() || self.entries.len() > MAXIMUM_KNOWN_CRASHES {
            return Err(ProfileError::ResourceLimit("known crashes entries"));
        }
        if !self.entries.windows(2).all(|pair| pair[0].id < pair[1].id) {
            return Err(ProfileError::NonCanonicalOrdering("known crashes entries"));
        }
        self.entries
            .iter()
            .try_for_each(|entry| validate_entry(entry, &self.profiles))
    }

    pub fn entry(&self, id: &str) -> Option<&KnownCrash> {
        self.entries
            .binary_search_by(|entry| entry.id.as_str().cmp(id))
            .ok()
            .map(|index| &self.entries[index])
    }
}

pub fn is_known_crash_id(id: &str) -> bool {
    id.len() <= MAXIMUM_ID_BYTES
        && id.starts_with(|character: char| character.is_ascii_lowercase())
        && id.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub mod crash_ids {
    pub const ACTOR_RADIUS_SEARCH_TOO_SMALL: &str = "actor-radius-search-too-small";
    pub const CONNECTION_BLOCK_MISSING_TERRAIN: &str = "connection-block-missing-terrain";
    pub const CONNECTION_TO_LAND_OUTSIDE_MAP: &str = "connection-to-land-outside-map";
    pub const DEFINED_NAME_RUNS_AS_CLIFF_TYPE: &str = "defined-name-runs-as-cliff-type";
    pub const DEFINED_NAME_RUNS_AS_ELEVATION_TERRAIN: &str =
        "defined-name-runs-as-elevation-terrain";
    pub const DEFINED_NAME_RUNS_AS_GLOBAL_COMMAND: &str = "defined-name-runs-as-global-command";
    pub const DEFINED_NAME_RUNS_AS_GUARD_STATE: &str = "defined-name-runs-as-guard-state";
    pub const DEFINED_NAME_RUNS_AS_LAND_BASE_TERRAIN: &str =
        "defined-name-runs-as-land-base-terrain";
    pub const DEFINED_NAME_RUNS_AS_LAND_TERRAIN: &str = "defined-name-runs-as-land-terrain";
    pub const DEFINED_NAME_RUNS_AS_OBJECT_TERRAIN: &str = "defined-name-runs-as-object-terrain";
    pub const DEFINED_NAME_RUNS_AS_TERRAIN_COMMAND: &str = "defined-name-runs-as-terrain-command";
    pub const GROUPED_PLACEMENT_ZERO_PERIMETER: &str = "grouped-placement-zero-perimeter";
    pub const OBJECT_GROUP_ENTRY_WITHOUT_OBJECT: &str = "object-group-entry-without-object";
    pub const OBJECT_ON_LAND_OUTSIDE_MAP: &str = "object-on-land-outside-map";
    pub const OVERRIDE_MAP_SIZE_SHRINKS_AFTER_LANDS: &str = "override-map-size-shrinks-after-lands";
    pub const TERRAIN_WITHOUT_MOVEMENT_DATA: &str = "terrain-without-movement-data";
}

pub const KNOWN_CRASH_IDS: [&str; 16] = [
    crash_ids::ACTOR_RADIUS_SEARCH_TOO_SMALL,
    crash_ids::CONNECTION_BLOCK_MISSING_TERRAIN,
    crash_ids::CONNECTION_TO_LAND_OUTSIDE_MAP,
    crash_ids::DEFINED_NAME_RUNS_AS_CLIFF_TYPE,
    crash_ids::DEFINED_NAME_RUNS_AS_ELEVATION_TERRAIN,
    crash_ids::DEFINED_NAME_RUNS_AS_GLOBAL_COMMAND,
    crash_ids::DEFINED_NAME_RUNS_AS_GUARD_STATE,
    crash_ids::DEFINED_NAME_RUNS_AS_LAND_BASE_TERRAIN,
    crash_ids::DEFINED_NAME_RUNS_AS_LAND_TERRAIN,
    crash_ids::DEFINED_NAME_RUNS_AS_OBJECT_TERRAIN,
    crash_ids::DEFINED_NAME_RUNS_AS_TERRAIN_COMMAND,
    crash_ids::GROUPED_PLACEMENT_ZERO_PERIMETER,
    crash_ids::OBJECT_GROUP_ENTRY_WITHOUT_OBJECT,
    crash_ids::OBJECT_ON_LAND_OUTSIDE_MAP,
    crash_ids::OVERRIDE_MAP_SIZE_SHRINKS_AFTER_LANDS,
    crash_ids::TERRAIN_WITHOUT_MOVEMENT_DATA,
];

pub const MAXIMUM_KNOWN_CRASH_ARGUMENT_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct KnownCrashHit {
    pub id: &'static str,
    pub arguments: Vec<(&'static str, String)>,
}

impl KnownCrashHit {
    pub fn new(id: &'static str) -> Self {
        Self {
            id,
            arguments: Vec::new(),
        }
    }

    pub fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
        let mut value = value.into();
        if value.len() > MAXIMUM_KNOWN_CRASH_ARGUMENT_BYTES {
            let mut end = MAXIMUM_KNOWN_CRASH_ARGUMENT_BYTES;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            value.truncate(end);
        }
        self.arguments.retain(|(existing, _)| *existing != name);
        self.arguments.push((name, value));
        self.arguments.sort_by(|left, right| left.0.cmp(right.0));
        self
    }

    pub fn entry(&self) -> Option<&'static KnownCrash> {
        shipped_known_crash(self.id)
    }

    pub fn evidence(&self) -> KnownCrashEvidenceQuality {
        self.entry()
            .map_or(KnownCrashEvidenceQuality::Inferred, |entry| {
                entry.evidence.quality
            })
    }

    pub fn cause(&self) -> Option<String> {
        let entry = self.entry()?;
        let mut cause = entry.cause.clone();
        for (name, value) in &self.arguments {
            cause = cause.replace(&format!("{{{name}}}"), value);
        }
        Some(cause)
    }
}

pub fn shipped_known_crash_catalogue() -> Option<&'static KnownCrashes> {
    static CATALOGUE: std::sync::OnceLock<Option<KnownCrashes>> = std::sync::OnceLock::new();
    CATALOGUE
        .get_or_init(|| shipped_known_crashes().ok())
        .as_ref()
}

pub fn shipped_known_crash(id: &str) -> Option<&'static KnownCrash> {
    shipped_known_crash_catalogue()?.entry(id)
}

fn strictly_ascending(values: &[String]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn placeholders(text: &str) -> Option<Vec<&str>> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find(['{', '}']) {
        if rest.as_bytes()[open] == b'}' {
            return None;
        }
        let after = &rest[open + 1..];
        let close = after.find(['{', '}'])?;
        if after.as_bytes()[close] == b'{' || close == 0 {
            return None;
        }
        found.push(&after[..close]);
        rest = &after[close + 1..];
    }
    Some(found)
}

fn valid_text(text: &str, maximum: usize) -> bool {
    let lower = text.to_ascii_lowercase();
    let words = lower
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let shorthand = |word: &&str| {
        word.strip_suffix('x')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
    };
    let hexadecimal = |word: &&str| word.starts_with("0x");
    let dotted_version = text
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .any(|run| run.split('.').filter(|part| !part.is_empty()).count() >= 3);
    !text.is_empty()
        && text.len() <= maximum
        && text.trim() == text
        && !text.chars().any(char::is_control)
        && !lower.contains("exact")
        && !words.iter().any(shorthand)
        && !words.iter().any(hexadecimal)
        && !dotted_version
}

fn valid_term(term: &str) -> bool {
    (1..=64).contains(&term.len())
        && term.starts_with(|character: char| character.is_ascii_lowercase())
        && term
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_place(place: &str) -> bool {
    let (section, block) = place.split_once('/').unwrap_or((place, ""));
    SECTIONS.contains(&section)
        && (block.is_empty()
            || block.strip_prefix("create_").is_some_and(|rest| {
                !rest.is_empty()
                    && rest
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            }))
}

fn valid_code(stage: KnownCrashStage, code: &str) -> bool {
    let digits = |prefix: &str| {
        code.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_digit()))
    };
    match stage {
        KnownCrashStage::Parser => digits("RMS") && code.starts_with("RMS2"),
        KnownCrashStage::Lint => code == KNOWN_CRASH_LINT_CODE,
        KnownCrashStage::Generation => digits("RMSGEN"),
    }
}

fn validate_entry(entry: &KnownCrash, profiles: &[String]) -> Result<(), ProfileError> {
    if !is_known_crash_id(&entry.id) {
        return Err(ProfileError::InvalidIdentifier {
            label: "known crash",
            value: entry.id.clone(),
        });
    }
    let placeholders_valid = placeholders(&entry.cause).is_some_and(|names| {
        names
            .iter()
            .all(|name| KNOWN_CRASH_PLACEHOLDERS.contains(name))
    });
    if !valid_text(&entry.title, MAXIMUM_TITLE_BYTES)
        || placeholders(&entry.title) != Some(Vec::new())
    {
        return Err(ProfileError::InvalidField("known crash title"));
    }
    if !valid_text(&entry.cause, MAXIMUM_SENTENCE_BYTES) || !placeholders_valid {
        return Err(ProfileError::InvalidField("known crash cause"));
    }
    if entry.fix.as_deref().is_some_and(|fix| {
        !valid_text(fix, MAXIMUM_SENTENCE_BYTES) || placeholders(fix) != Some(Vec::new())
    }) {
        return Err(ProfileError::InvalidField("known crash fix"));
    }
    if entry.depends_on.is_empty() || !entry.depends_on.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(ProfileError::InvalidField("known crash dependsOn"));
    }
    if entry.detectors.is_empty()
        || !entry.detectors.windows(2).all(|pair| pair[0] < pair[1])
        || !entry
            .detectors
            .iter()
            .all(|detector| valid_code(detector.stage, &detector.code))
    {
        return Err(ProfileError::InvalidField("known crash detectors"));
    }
    if entry.doc_terms.len() > MAXIMUM_DOC_TERMS
        || !entry.doc_terms.iter().all(|note| {
            (1..=MAXIMUM_TERMS_PER_NOTE).contains(&note.terms.len())
                && note.terms.iter().all(|term| valid_term(term))
                && strictly_ascending(&note.terms)
                && note.places.len() <= MAXIMUM_PLACES_PER_NOTE
                && note.places.iter().all(|place| valid_place(place))
                && strictly_ascending(&note.places)
                && valid_text(&note.note, MAXIMUM_SENTENCE_BYTES)
                && placeholders(&note.note) == Some(Vec::new())
        })
    {
        return Err(ProfileError::InvalidField("known crash docTerms"));
    }
    validate_evidence(entry, profiles)?;
    match (entry.status, entry.retired_in.as_deref()) {
        (KnownCrashStatus::Active, None) => Ok(()),
        (KnownCrashStatus::Retired, Some(version)) if parse_product_version(version).is_some() => {
            Ok(())
        }
        _ => Err(ProfileError::InvalidField("known crash retiredIn")),
    }
}

fn validate_evidence(entry: &KnownCrash, profiles: &[String]) -> Result<(), ProfileError> {
    let evidence = &entry.evidence;
    let lists = [
        &evidence.live_profiles,
        &evidence.static_profiles,
        &evidence.inferred_profiles,
    ];
    if !lists.iter().all(|list| {
        strictly_ascending(list) && list.iter().all(|profile| profiles.contains(profile))
    }) {
        return Err(ProfileError::InvalidField(
            "known crash profiles per quality",
        ));
    }
    let consistent = match evidence.quality {
        KnownCrashEvidenceQuality::Live => !evidence.live_profiles.is_empty(),
        KnownCrashEvidenceQuality::Static => {
            evidence.live_profiles.is_empty() && !evidence.static_profiles.is_empty()
        }
        KnownCrashEvidenceQuality::Inferred => {
            evidence.live_profiles.is_empty() && evidence.static_profiles.is_empty()
        }
    };
    if !consistent {
        return Err(ProfileError::InvalidField("known crash quality"));
    }
    if evidence.quality == KnownCrashEvidenceQuality::Inferred
        && (!entry.doc_terms.is_empty()
            || entry
                .detectors
                .iter()
                .any(|detector| detector.stage == KnownCrashStage::Lint))
    {
        return Err(ProfileError::InvalidField("known crash inferred warning"));
    }
    Ok(())
}

pub fn shipped_known_crashes() -> Result<KnownCrashes, ProfileError> {
    let text = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../profiles/known-crashes/rms-known-crashes-v1.json"
    ));
    parse_known_crashes(text)
}

pub fn parse_known_crashes(text: &str) -> Result<KnownCrashes, ProfileError> {
    let catalogue = serde_json::from_str::<KnownCrashes>(text).map_err(ProfileError::Parse)?;
    catalogue.validate()?;
    Ok(catalogue)
}
