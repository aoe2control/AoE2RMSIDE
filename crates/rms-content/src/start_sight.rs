use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{CivilizationId, CompatibilityRange, ContentError, ObjectId};

pub const START_SIGHT_SCHEMA: &str = "https://rmside.invalid/schemas/start-sight/v1";
pub const START_SIGHT_SCHEMA_VERSION: &str = "1.0.0";
const MAXIMUM_START_SIGHT_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_OBJECTS: usize = 65_536;
const MAXIMUM_EFFECTS: usize = 4_096;
const MAXIMUM_ROWS_PER_EFFECT: usize = 256;
const MAXIMUM_CIVILIZATION_ID: u32 = 255;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSightObject {
    pub object_id: ObjectId,
    pub line_of_sight_f32_bits: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSightObjectVariant {
    pub object_id: ObjectId,
    pub civilization_ids: Vec<CivilizationId>,
    pub line_of_sight_f32_bits: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartSightRoute {
    Own,
    Team,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartSightAge {
    Dark,
    Feudal,
    Castle,
    Imperial,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartSightOperationKind {
    Set,
    Add,
    Multiply,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSightOperation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<u32>,
    pub kind: StartSightOperationKind,
    pub value_f32_bits: u32,
}

impl StartSightOperation {
    pub fn addresses(&self, object_id: ObjectId, class_id: u32) -> bool {
        self.object_id.is_none_or(|id| id == object_id)
            && self.class_id.is_none_or(|id| id == class_id)
    }

    pub fn apply(&self, value: f32) -> f32 {
        let operand = f32::from_bits(self.value_f32_bits);
        match self.kind {
            StartSightOperationKind::Set => operand,
            StartSightOperationKind::Add => value + operand,
            StartSightOperationKind::Multiply => value * operand,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSightUpgrade {
    pub object_id: ObjectId,
    pub target_object_id: ObjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSightEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology_id: Option<u16>,
    pub civilization_id: i32,
    pub route: StartSightRoute,
    pub required_age: StartSightAge,
    pub operations: Vec<StartSightOperation>,
    pub upgrades: Vec<StartSightUpgrade>,
}

impl StartSightEffect {
    pub fn names_civilization(&self, civilization: CivilizationId) -> bool {
        self.civilization_id == -1 || i64::from(self.civilization_id) == i64::from(civilization.0)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSight {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub behavior_profile_id: String,
    pub content_pack_id: String,
    pub product_version: String,
    pub objects: Vec<StartSightObject>,
    pub object_variants: Vec<StartSightObjectVariant>,
    pub technology_effects: Vec<StartSightEffect>,
}

impl StartSight {
    pub fn line_of_sight(&self, object_id: ObjectId, civilization: CivilizationId) -> Option<f32> {
        let index = self
            .objects
            .binary_search_by_key(&object_id, |object| object.object_id)
            .ok()?;
        let start = self
            .object_variants
            .partition_point(|variant| variant.object_id < object_id);
        let bits = self.object_variants[start..]
            .iter()
            .take_while(|variant| variant.object_id == object_id)
            .find(|variant| {
                variant
                    .civilization_ids
                    .binary_search(&civilization)
                    .is_ok()
            })
            .map_or(self.objects[index].line_of_sight_f32_bits, |variant| {
                variant.line_of_sight_f32_bits
            });
        Some(f32::from_bits(bits))
    }
}

pub fn load_start_sight(
    bytes: &[u8],
    behavior_profile_id: &str,
    content_pack_id: &str,
) -> Result<StartSight, ContentError> {
    if bytes.len() > MAXIMUM_START_SIGHT_BYTES {
        return Err(ContentError::ResourceLimit("start sight data"));
    }
    let sight: StartSight = serde_json::from_slice(bytes).map_err(ContentError::Parse)?;
    if sight.schema != START_SIGHT_SCHEMA
        || sight.schema_version != START_SIGHT_SCHEMA_VERSION
        || sight.compatibility.minimum_major != 1
        || sight.compatibility.maximum_major != 1
    {
        return Err(ContentError::UnsupportedSchema(sight.schema_version));
    }
    if sight.behavior_profile_id != behavior_profile_id || sight.content_pack_id != content_pack_id
    {
        return Err(ContentError::IncompatibleProfile(
            behavior_profile_id.to_owned(),
        ));
    }
    validate(&sight)?;
    Ok(sight)
}

fn validate(sight: &StartSight) -> Result<(), ContentError> {
    if sight.objects.len() > MAXIMUM_OBJECTS
        || sight.object_variants.len() > MAXIMUM_OBJECTS
        || sight.technology_effects.len() > MAXIMUM_EFFECTS
    {
        return Err(ContentError::ResourceLimit("start sight data"));
    }
    if !sight
        .objects
        .windows(2)
        .all(|pair| pair[0].object_id < pair[1].object_id)
    {
        return Err(ContentError::NonCanonicalOrdering("start sight objects"));
    }
    let known = |id: ObjectId| {
        sight
            .objects
            .binary_search_by_key(&id, |object| object.object_id)
            .is_ok()
    };
    for variant in &sight.object_variants {
        if variant.civilization_ids.is_empty()
            || variant.civilization_ids.len() > 256
            || variant
                .civilization_ids
                .iter()
                .any(|id| id.0 > MAXIMUM_CIVILIZATION_ID)
        {
            return Err(ContentError::InvalidField(
                "start sight variant civilizations",
            ));
        }
        if !variant
            .civilization_ids
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        {
            return Err(ContentError::NonCanonicalOrdering(
                "start sight variant civilizations",
            ));
        }
        if !known(variant.object_id) {
            return Err(ContentError::DanglingReference(
                "start sight variant object",
            ));
        }
    }
    for pair in sight.object_variants.windows(2) {
        let key =
            |variant: &StartSightObjectVariant| (variant.object_id, variant.civilization_ids[0]);
        if key(&pair[0]) >= key(&pair[1]) {
            return Err(ContentError::NonCanonicalOrdering("start sight variants"));
        }
    }
    for (index, variant) in sight.object_variants.iter().enumerate() {
        for other in sight.object_variants[index + 1..]
            .iter()
            .take_while(|other| other.object_id == variant.object_id)
        {
            if variant
                .civilization_ids
                .iter()
                .any(|id| other.civilization_ids.binary_search(id).is_ok())
            {
                return Err(ContentError::InvalidField(
                    "start sight variant civilizations",
                ));
            }
        }
    }
    for effect in &sight.technology_effects {
        if effect.civilization_id < -1
            || effect.civilization_id > MAXIMUM_CIVILIZATION_ID as i32
            || (effect.route == StartSightRoute::Team && effect.civilization_id < 0)
        {
            return Err(ContentError::InvalidField(
                "start sight effect civilization",
            ));
        }
        if effect.operations.len() > MAXIMUM_ROWS_PER_EFFECT
            || effect.upgrades.len() > MAXIMUM_ROWS_PER_EFFECT
        {
            return Err(ContentError::ResourceLimit("start sight effect rows"));
        }
        for operation in &effect.operations {
            let value = f32::from_bits(operation.value_f32_bits);
            if (operation.object_id.is_none() && operation.class_id.is_none())
                || operation.class_id.is_some_and(|class| class > 65_535)
                || !value.is_finite()
            {
                return Err(ContentError::InvalidField("start sight operation"));
            }
            if operation.object_id.is_some_and(|id| !known(id)) {
                return Err(ContentError::DanglingReference(
                    "start sight operation object",
                ));
            }
        }
        if effect
            .upgrades
            .iter()
            .any(|upgrade| !known(upgrade.object_id) || !known(upgrade.target_object_id))
        {
            return Err(ContentError::DanglingReference(
                "start sight upgrade object",
            ));
        }
    }
    if sight
        .objects
        .iter()
        .any(|object| !f32::from_bits(object.line_of_sight_f32_bits).is_finite())
        || sight
            .object_variants
            .iter()
            .any(|variant| !f32::from_bits(variant.line_of_sight_f32_bits).is_finite())
    {
        return Err(ContentError::InvalidField("start sight line of sight"));
    }
    Ok(())
}

struct PackagedStartSight {
    behavior_profile_id: &'static str,
    content_pack_id: &'static str,
    bytes: &'static [u8],
}

const PACKAGED: &[PackagedStartSight] = &[
    PackagedStartSight {
        behavior_profile_id: "aoe2de-101.103.48987-rms-v1",
        content_pack_id: "aoe2de-101.103.48987-complete-v1",
        bytes: include_bytes!("../data/aoe2de-101.103.48987-start-sight.json"),
    },
    PackagedStartSight {
        behavior_profile_id: "aoe2de-101.103.54800-rms-v1",
        content_pack_id: "aoe2de-101.103.54800-complete-v1",
        bytes: include_bytes!("../data/aoe2de-101.103.54800-start-sight.json"),
    },
    PackagedStartSight {
        behavior_profile_id: "aoe2de-101.103.57257-rms-v1",
        content_pack_id: "aoe2de-101.103.57257-complete-v1",
        bytes: include_bytes!("../data/aoe2de-101.103.57257-start-sight.json"),
    },
];

pub fn packaged_start_sight(
    behavior_profile_id: &str,
    content_pack_id: &str,
) -> Result<Option<&'static StartSight>, ContentError> {
    static LOADED: OnceLock<Result<Vec<StartSight>, String>> = OnceLock::new();
    let loaded = LOADED
        .get_or_init(|| {
            PACKAGED
                .iter()
                .map(|entry| {
                    load_start_sight(
                        entry.bytes,
                        entry.behavior_profile_id,
                        entry.content_pack_id,
                    )
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })
        .as_deref()
        .map_err(|_| ContentError::InvalidField("packaged start sight data"))?;
    Ok(loaded.iter().find(|sight| {
        sight.behavior_profile_id == behavior_profile_id && sight.content_pack_id == content_pack_id
    }))
}
