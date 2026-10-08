use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    CompatibilityRange, CompositeTerrainRule, ContentError, FoundationCell, FoundationTerrainRule,
    GameModePlayerObjectRule, GameModeTerrainRule, NativeGenerationBindings, ObjectId,
    ObjectPlacementClassBindings, ObjectResourceState, TerrainId, TerrainTopologyBindings,
    WallPlacementRule,
};

const MAXIMUM_BINDING_BYTES: usize = 256 * 1024;
pub const NATIVE_BINDING_SCHEMA_VERSION: &str = "1.3.0";
const PLAYER_START_BINDING_SCHEMA_VERSION: &str = "1.2.0";
const CONSTRUCTION_SITE_BINDING_SCHEMA_VERSION: &str = "1.1.0";
const LEGACY_NATIVE_BINDING_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainClassRestrictions {
    pub land: u32,
    pub water: u32,
    pub buildable: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffPieceSlot {
    pub slot: u16,
    pub facet: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffPieceSlotRule {
    pub edges: [i8; 4],
    pub primary: CliffPieceSlot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternate: Option<CliffPieceSlot>,
    pub x_offset_256: u16,
    pub y_offset_256: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffBindings {
    pub terrain_id: TerrainId,
    pub style_base_object_ids: Vec<ObjectId>,
    pub piece_rules: Vec<CliffPieceSlotRule>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestrictionZoneConstructorBindings {
    pub object_ids: Vec<ObjectId>,
    pub excluded_class_ids: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstructorResourceOverrideBinding {
    pub class_ids: Vec<u32>,
    pub state: ObjectResourceState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationOmittedCellsBinding {
    pub object_id: ObjectId,
    pub cells: Vec<FoundationCell>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleRequestCountBinding {
    pub object_id: ObjectId,
    pub count: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeContentBindings {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub behavior_profile_id: String,
    pub terrain_class_restrictions: TerrainClassRestrictions,
    pub terrain_topology: TerrainTopologyBindings,
    pub native_generation_bindings: NativeGenerationBindings,
    pub object_placement_classes: ObjectPlacementClassBindings,
    pub rms_path_reference_object_id: ObjectId,
    pub restriction_classification_class_masks: Vec<u8>,
    pub cliffs: CliffBindings,
    pub composite_terrain_rules: Vec<CompositeTerrainRule>,
    pub foundation_terrain_rules: Vec<FoundationTerrainRule>,
    pub foundation_omitted_cells: Vec<FoundationOmittedCellsBinding>,
    pub game_mode_terrain_rules: Vec<GameModeTerrainRule>,
    pub game_mode_player_object_rules: Vec<GameModePlayerObjectRule>,
    pub wall_placement_rules: Vec<WallPlacementRule>,
    pub construction_retirement_requires_height: BTreeSet<ObjectId>,
    pub restriction_zone_constructor: RestrictionZoneConstructorBindings,
    pub constructor_resource_override: ConstructorResourceOverrideBinding,
    pub single_request_counts: Vec<SingleRequestCountBinding>,
}

impl NativeContentBindings {
    pub(crate) fn foundation_omitted_cells(&self, object_id: ObjectId) -> Vec<FoundationCell> {
        self.foundation_omitted_cells
            .iter()
            .find(|binding| binding.object_id == object_id)
            .map(|binding| binding.cells.clone())
            .unwrap_or_default()
    }

    pub(crate) fn single_request_count(&self, object_id: ObjectId) -> Option<u32> {
        self.single_request_counts
            .iter()
            .find(|binding| binding.object_id == object_id)
            .map(|binding| binding.count)
    }

    pub(crate) fn constructor_resource_override(
        &self,
        class_id: u32,
    ) -> Option<ObjectResourceState> {
        let binding = &self.constructor_resource_override;
        binding
            .class_ids
            .contains(&class_id)
            .then_some(binding.state)
    }

    pub(crate) fn initializes_restriction_zones(
        &self,
        object_id: ObjectId,
        kind: u8,
        class_id: u32,
    ) -> bool {
        let binding = &self.restriction_zone_constructor;
        matches!(kind, 70 | 80)
            && (binding.object_ids.contains(&object_id)
                || !binding.excluded_class_ids.contains(&class_id))
    }
}

pub fn load_native_content_bindings(
    bytes: &[u8],
    behavior_profile_id: &str,
) -> Result<NativeContentBindings, ContentError> {
    if bytes.len() > MAXIMUM_BINDING_BYTES {
        return Err(ContentError::ResourceLimit("content generation bindings"));
    }
    let bindings: NativeContentBindings =
        serde_json::from_slice(bytes).map_err(ContentError::Parse)?;
    if bindings.schema != "https://rmside.invalid/schemas/native-content-bindings/v1"
        || !matches!(
            bindings.schema_version.as_str(),
            NATIVE_BINDING_SCHEMA_VERSION
                | PLAYER_START_BINDING_SCHEMA_VERSION
                | CONSTRUCTION_SITE_BINDING_SCHEMA_VERSION
                | LEGACY_NATIVE_BINDING_SCHEMA_VERSION
        )
        || (bindings.schema_version != LEGACY_NATIVE_BINDING_SCHEMA_VERSION)
            != bindings
                .native_generation_bindings
                .construction_site_exemptions
                .is_some()
        || matches!(
            bindings.schema_version.as_str(),
            NATIVE_BINDING_SCHEMA_VERSION | PLAYER_START_BINDING_SCHEMA_VERSION
        ) != bindings
            .native_generation_bindings
            .player_start_bindings
            .is_some()
        || (bindings.schema_version == NATIVE_BINDING_SCHEMA_VERSION)
            != bindings
                .native_generation_bindings
                .farm_completion_bindings
                .is_some()
        || bindings.compatibility.minimum_major != 1
        || bindings.compatibility.maximum_major != 1
    {
        return Err(ContentError::UnsupportedSchema(bindings.schema_version));
    }
    if bindings.behavior_profile_id != behavior_profile_id {
        return Err(ContentError::IncompatibleProfile(
            behavior_profile_id.to_owned(),
        ));
    }
    validate_bindings(&bindings)?;
    Ok(bindings)
}

fn validate_bindings(bindings: &NativeContentBindings) -> Result<(), ContentError> {
    let strictly_ascending = |ids: &[ObjectId]| ids.windows(2).all(|pair| pair[0] < pair[1]);
    let cliffs = &bindings.cliffs;
    if bindings.restriction_classification_class_masks.is_empty()
        || bindings.restriction_classification_class_masks.len() > 16
        || cliffs.style_base_object_ids.is_empty()
        || cliffs.style_base_object_ids.len() > 64
        || cliffs.piece_rules.is_empty()
        || cliffs.piece_rules.len() > 256
        || bindings.composite_terrain_rules.len() > 65_536
        || bindings.foundation_terrain_rules.len() > 65_536
        || bindings.foundation_omitted_cells.len() > 65_536
        || bindings.game_mode_terrain_rules.len() > 256
        || bindings.game_mode_player_object_rules.len() > 256
        || bindings.wall_placement_rules.len() > 100_000
        || bindings.construction_retirement_requires_height.len() > 65_536
        || bindings.restriction_zone_constructor.object_ids.len() > 65_536
        || bindings
            .restriction_zone_constructor
            .excluded_class_ids
            .len()
            > 65_536
        || bindings.constructor_resource_override.class_ids.len() > 65_536
        || bindings.single_request_counts.len() > 65_536
    {
        return Err(ContentError::ResourceLimit("content generation bindings"));
    }
    let omitted: Vec<ObjectId> = bindings
        .foundation_omitted_cells
        .iter()
        .map(|binding| binding.object_id)
        .collect();
    let single: Vec<ObjectId> = bindings
        .single_request_counts
        .iter()
        .map(|binding| binding.object_id)
        .collect();
    let exemptions = bindings
        .native_generation_bindings
        .construction_site_exemptions
        .as_ref();
    let farm = bindings
        .native_generation_bindings
        .farm_completion_bindings
        .as_ref();
    if farm.is_some_and(|farm| {
        farm.parent_object_ids.is_empty()
            || farm.parent_object_ids.len() > 16
            || !strictly_ascending(&farm.parent_object_ids)
            || farm.spawned_object_ids.is_empty()
            || farm.spawned_object_ids.len() > 16
            || farm
                .attribute_ids()
                .into_iter()
                .collect::<BTreeSet<_>>()
                .len()
                != farm.attribute_ids().len()
    }) {
        return Err(ContentError::InvalidField("content generation bindings"));
    }
    if exemptions.is_some_and(|exemptions| {
        exemptions.object_ids.len() > 256
            || exemptions.class_ids.len() > 256
            || !strictly_ascending(&exemptions.object_ids)
            || !exemptions
                .class_ids
                .windows(2)
                .all(|pair| pair[0] < pair[1])
    }) {
        return Err(ContentError::InvalidField("content generation bindings"));
    }
    if !strictly_ascending(&omitted)
        || !strictly_ascending(&single)
        || !strictly_ascending(&bindings.restriction_zone_constructor.object_ids)
        || bindings
            .single_request_counts
            .iter()
            .any(|binding| binding.count == 0 || binding.count > 65_536)
        || bindings
            .foundation_omitted_cells
            .iter()
            .any(|binding| binding.cells.is_empty() || binding.cells.len() > 65_536)
    {
        return Err(ContentError::InvalidField("content generation bindings"));
    }
    Ok(())
}
