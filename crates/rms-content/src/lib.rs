mod dat;
mod dat_import;
mod dat_projection;
pub mod game_art;
mod native_bindings;
mod presentation_names;
mod resource;
mod standard_resource;
mod support_bundle;
#[cfg(any(test, feature = "synthetic-dat-fixture"))]
pub mod synthetic_fixture;
pub use dat_import::{
    AOE2DE_VER89_LAYOUT_ID, Aoe2deContentInputs, ContentCompletenessManifest, import_aoe2de_content,
};
pub use dat_projection::{ObjectExclusionReason, ObjectSlotAccount};
pub use native_bindings::{NativeContentBindings, load_native_content_bindings};
pub use presentation_names::{
    DatMinimapIndices, DatObjectMinimapIndex, DatPresentationStringIds, DatTerrainMinimapIndices,
    MAXIMUM_PRESENTATION_STRING_ID, PresentationObjectSlot, PresentationStringId,
    PresentationTerrainMinimapIndices, read_aoe2de_dat_minimap_indices,
    read_aoe2de_dat_presentation_string_ids,
};
pub use resource::{ObjectResourceSlot, ObjectResourceState};
pub use standard_resource::{
    StandardIncludeInventory, canonical_standard_include_inventory,
    load_canonical_standard_include_inventory, packaged_48987_standard_include_inventory,
};
pub use support_bundle::{
    SanitizedSupportBundle, SupportBundle, SupportBundleInputs, SupportBundleManifest,
    packaged_support_bundle, packaged_support_bundles, sanitize_support_bundle,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::DeflateDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const CONTENT_SCHEMA_MAJOR: u32 = 2;
pub const CONTENT_SCHEMA_VERSION: &str = "2.5.0";
pub const PLAYER_START_SCHEMA_VERSION: &str = "2.4.0";
const CONSTRUCTION_SITE_SCHEMA_VERSION: &str = "2.3.0";
pub const NATIVE_BINDINGS_SCHEMA_VERSION: &str = "2.2.0";
pub const BUILDING_CONSTRUCTOR_TYPE: u8 = 80;
const LEGACY_OWNER_SPEED_SCHEMA_VERSION: &str = "2.1.0";
const LEGACY_UNIFORM_SPEED_SCHEMA_VERSION: &str = "2.0.0";
pub const SYNTHETIC_PACK_ID: &str = "synthetic-neutral-v1";
pub const EXACT_REFERENCE_PACK_ID: &str = "aoe2de-exact-neutral-reference-v1";
pub const MAXIMUM_PACK_BYTES: usize = 32 * 1024 * 1024;
pub const MAXIMUM_IMPLICIT_DEFINITION_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityRange {
    pub minimum_major: u32,
    pub maximum_major: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TerrainId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ObjectId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CivilizationId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ResourceId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PlayerAttributeId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RestrictionId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerrainLayerClass {
    Land,
    Water,
    Beach,
    Ice,
    Overlay,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerrainAppearancePlacement {
    Randomized,
    Centered,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainAppearanceDefinition {
    pub placement: TerrainAppearancePlacement,
    pub weight_per_thousand: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_restriction_id: Option<RestrictionId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainDefinition {
    pub id: TerrainId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rms_names: Vec<String>,
    pub layer_class: TerrainLayerClass,
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub placement_class: u8,
    pub passable: bool,
    pub buildable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub appearances: Vec<TerrainAppearanceDefinition>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObstructionKind {
    None,
    Point,
    Rectangle,
    Circle,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectPlacementCollision {
    #[default]
    Footprint,
    None,
}

impl ObjectPlacementCollision {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectCreationRng {
    pub facet_count: u16,
    pub random_facet: bool,
    pub random_angle: bool,
    pub random_combat_seed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_facet: Option<u16>,
}

impl Default for ObjectCreationRng {
    fn default() -> Self {
        Self {
            facet_count: 4,
            random_facet: true,
            random_angle: false,
            random_combat_seed: false,
            fixed_facet: None,
        }
    }
}

impl ObjectCreationRng {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn for_constructor(constructor_type: u8, graphic: Option<&GraphicDefinition>) -> Self {
        let random_combat_seed = matches!(constructor_type, 70 | 80);
        let directionless = Self {
            facet_count: 1,
            random_facet: false,
            random_angle: false,
            random_combat_seed,
            fixed_facet: None,
        };
        let Some(graphic) = graphic else {
            return directionless;
        };
        if graphic.signed_angle_count() <= 0 {
            return directionless;
        }
        let facet_count = graphic.angle_count;
        let random_facet = facet_count > 1 && graphic.random_facet;
        let random_angle = constructor_type >= 30 && facet_count > 1 && graphic.random_angle;
        let fixed_facet = if constructor_type >= 30 && !random_angle {
            Some(zero_angle_facet(facet_count))
        } else if (20..30).contains(&constructor_type) && random_facet {
            Some(0)
        } else {
            None
        };
        Self {
            facet_count,
            random_facet,
            random_angle,
            random_combat_seed,
            fixed_facet,
        }
    }
}

fn zero_angle_facet(directions: u16) -> u16 {
    let directions = f32::from(directions.max(8));
    let mut facing =
        ((0.0_f32 - std::f32::consts::FRAC_PI_4) * directions) / (2.0 * std::f32::consts::PI) + 0.5;
    if facing < 0.0 {
        facing += directions;
    }
    facing as u16
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicDefinition {
    pub id: i16,
    pub angle_count: u16,
    #[serde(default, skip_serializing_if = "is_false")]
    pub random_facet: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub random_angle: bool,
}

impl GraphicDefinition {
    pub fn signed_angle_count(&self) -> i16 {
        i16::from_ne_bytes(self.angle_count.to_ne_bytes())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectStandingGraphicCreationVariant {
    pub standing_graphic_id: i16,
    pub creation_rng: ObjectCreationRng,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectGraphicReplacementFacet {
    Preserve,
    ResetZero,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectGraphicReplacementVariant {
    pub civilization_ids: Vec<CivilizationId>,
    pub facet: ObjectGraphicReplacementFacet,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPlacementGeometry {
    pub collision_half_width_f32_bits: u32,
    pub collision_half_height_f32_bits: u32,
    pub placement_half_width_f32_bits: u32,
    pub placement_half_height_f32_bits: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectPlacementFamily {
    Terrain,
    Collision,
    Occupancy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectPositionFamily {
    Base,
    Moving,
    Combat,
    Building,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPlacementRules {
    pub family: ObjectPlacementFamily,
    pub slope_mode: u8,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPlacementRuleVariant {
    pub civilization_ids: Vec<CivilizationId>,
    pub rules: ObjectPlacementRules,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRestrictionVariant {
    pub civilization_ids: Vec<CivilizationId>,
    pub restriction_id: Option<RestrictionId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectResourceSlotVariant {
    pub object_id: ObjectId,
    pub civilization_ids: Vec<CivilizationId>,
    pub resource_slots: [ObjectResourceSlot; 3],
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectMovementSpeedVariant {
    pub object_id: ObjectId,
    pub civilization_ids: Vec<CivilizationId>,
    pub speed_f32_bits: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPathing {
    pub action: u8,
    pub kind: u8,
    pub vertical_extent_f32_bits: u32,
    pub outline_half_width_f32_bits: u32,
    pub outline_half_height_f32_bits: u32,
}

impl ObjectPathing {
    pub fn vertical_extent(self) -> f32 {
        f32::from_bits(self.vertical_extent_f32_bits)
    }

    pub fn outline_half_extents(self) -> [f32; 2] {
        [
            f32::from_bits(self.outline_half_width_f32_bits),
            f32::from_bits(self.outline_half_height_f32_bits),
        ]
    }

    fn validate(self) -> Result<(), ContentError> {
        if !matches!(self.action, 0 | 1 | 2 | 3 | 5 | 10 | 11 | 12 | 13) {
            return Err(ContentError::InvalidField("object pathing action"));
        }
        if self
            .outline_half_extents()
            .into_iter()
            .chain([self.vertical_extent()])
            .any(|extent| !extent.is_finite() || extent.is_sign_negative())
        {
            return Err(ContentError::InvalidField("object pathing geometry"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectAttachment {
    pub object_id: ObjectId,
    pub x_offset_f32_bits: u32,
    pub y_offset_f32_bits: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectDefinition {
    pub id: ObjectId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rms_names: Vec<String>,
    pub class_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_civilizations: Option<Vec<CivilizationId>>,
    pub footprint_width_256: u16,
    pub footprint_height_256: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_geometry: Option<ObjectPlacementGeometry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_rules: Option<ObjectPlacementRules>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub placement_rule_variants: Vec<ObjectPlacementRuleVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pathing: Option<ObjectPathing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class39_pathing_gate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_family: Option<ObjectPositionFamily>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occupancy_uses_movement_speed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub movement_speed_f32_bits: Option<u32>,
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub edge_margin_256: u8,
    pub obstruction: ObstructionKind,
    #[serde(default, skip_serializing_if = "is_false")]
    pub can_be_built_on: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub construction_retirement_requires_height: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_points: Option<i16>,
    #[serde(default, skip_serializing_if = "ObjectPlacementCollision::is_default")]
    pub placement_collision: ObjectPlacementCollision,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub placement_side_terrain_ids: Vec<TerrainId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub placement_center_terrain_ids: Vec<TerrainId>,
    #[serde(
        default = "default_object_lifecycle_state",
        skip_serializing_if = "is_default_object_lifecycle_state"
    )]
    pub initial_lifecycle_state: u8,
    pub restriction_id: Option<RestrictionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restriction_variants: Vec<ObjectRestrictionVariant>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub initializes_restriction_zones: bool,
    pub resource_slots: Option<[ObjectResourceSlot; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_resource_override: Option<ObjectResourceState>,
    #[serde(default = "default_object_data_status")]
    pub data_status: i16,
    #[serde(default, skip_serializing_if = "ObjectCreationRng::is_default")]
    pub creation_rng: ObjectCreationRng,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing_graphic_id: Option<i16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constructor_type: Option<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub standing_graphic_creation_variants: Vec<ObjectStandingGraphicCreationVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graphic_replacement_variants: Vec<ObjectGraphicReplacementVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub construction_attachments: Vec<ObjectAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub neighbor_facing: Option<ObjectNeighborFacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub single_request_count: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub disappears_when_built: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building_construction: Option<ObjectBuildingConstruction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foundation: Option<ObjectFoundation>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectBuildingConstruction {
    pub positive_build_time: bool,
    pub head_unit: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstructionSiteExemptions {
    pub object_ids: Vec<ObjectId>,
    pub class_ids: Vec<u32>,
}

impl ConstructionSiteExemptions {
    pub fn starts_as_construction_site(
        &self,
        object_id: ObjectId,
        class_id: u32,
        facts: ObjectBuildingConstruction,
    ) -> bool {
        !self.class_ids.contains(&class_id)
            && !self.object_ids.contains(&object_id)
            && !facts.head_unit
            && facts.positive_build_time
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectNeighborFacing {
    pub updates_neighbors: bool,
    pub has_graphic: bool,
    pub preserve_facet: bool,
    pub fallback: Option<ObjectNeighborFallback>,
    pub linked_object_id: Option<ObjectId>,
    pub accepts_linked_neighbor: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ObjectNeighborFallback {
    Class { class_id: u32 },
    LinkedObject,
    LinkingClass { class_id: u32 },
}

fn validate_object_attachments(objects: &[ObjectDefinition]) -> Result<(), ContentError> {
    fn visit(
        objects: &[ObjectDefinition],
        index: usize,
        active: &mut [bool],
        memo: &mut [Option<(usize, usize)>],
        depth: usize,
    ) -> Result<(usize, usize), ContentError> {
        if active[index] || depth >= 16 {
            return Err(ContentError::InvalidField(
                "object attachment cycle or depth",
            ));
        }
        if let Some(value) = memo[index] {
            return Ok(value);
        }
        let object = &objects[index];
        if object.construction_attachments.len() > 4 {
            return Err(ContentError::ResourceLimit("object attachment slots"));
        }
        active[index] = true;
        let (mut height, mut count) = (1, 1_usize);
        for child in &object.construction_attachments {
            if [child.x_offset_f32_bits, child.y_offset_f32_bits]
                .into_iter()
                .map(f32::from_bits)
                .any(|value| !value.is_finite() || value.abs() > 480.0)
            {
                return Err(ContentError::InvalidField("object attachment offset"));
            }
            let child_index = objects
                .binary_search_by_key(&child.object_id, |object| object.id)
                .map_err(|_| ContentError::InvalidField("object attachment master"))?;
            let (child_height, child_count) = visit(objects, child_index, active, memo, depth + 1)?;
            height = height.max(child_height + 1);
            count = count.saturating_add(child_count);
            if height > 16 || count > 65_536 {
                return Err(ContentError::ResourceLimit("object attachment expansion"));
            }
        }
        active[index] = false;
        memo[index] = Some((height, count));
        Ok((height, count))
    }
    let mut active = vec![false; objects.len()];
    let mut memo = vec![None; objects.len()];
    for index in 0..objects.len() {
        visit(objects, index, &mut active, &mut memo, 0)?;
    }
    Ok(())
}

impl ObjectDefinition {
    pub fn restriction_for(&self, civilization: Option<CivilizationId>) -> Option<RestrictionId> {
        if self.restriction_variants.is_empty() {
            return self.restriction_id;
        }
        let civilization = civilization?;
        self.restriction_variants
            .iter()
            .find(|variant| {
                variant
                    .civilization_ids
                    .binary_search(&civilization)
                    .is_ok()
            })
            .and_then(|variant| variant.restriction_id)
    }

    pub fn creation_rng_for_standing_graphic(
        &self,
        standing_graphic_id: i16,
    ) -> Option<ObjectCreationRng> {
        if self.standing_graphic_id == Some(standing_graphic_id) {
            return Some(self.creation_rng);
        }
        self.standing_graphic_creation_variants
            .binary_search_by_key(&standing_graphic_id, |variant| variant.standing_graphic_id)
            .ok()
            .map(|index| self.standing_graphic_creation_variants[index].creation_rng)
    }

    pub fn placement_rules_for(
        &self,
        civilization: Option<CivilizationId>,
    ) -> Option<ObjectPlacementRules> {
        self.placement_rules.or_else(|| {
            let civilization = civilization?;
            self.placement_rule_variants
                .iter()
                .find(|variant| {
                    variant
                        .civilization_ids
                        .binary_search(&civilization)
                        .is_ok()
                })
                .map(|variant| variant.rules)
        })
    }

    pub fn initial_resources(&self) -> Option<ObjectResourceState> {
        self.initial_resource_override.or_else(|| {
            self.resource_slots
                .as_ref()
                .map(ObjectResourceState::from_slots)
        })
    }

    pub fn graphic_replacement_facet_for(
        &self,
        civilization: CivilizationId,
    ) -> Option<ObjectGraphicReplacementFacet> {
        self.graphic_replacement_variants
            .iter()
            .find(|variant| {
                variant
                    .civilization_ids
                    .binary_search(&civilization)
                    .is_ok()
            })
            .map(|variant| variant.facet)
    }

    pub fn collision_half_extents(&self) -> [f32; 2] {
        self.placement_geometry.map_or(
            [
                f32::from(self.footprint_width_256) / 512.0,
                f32::from(self.footprint_height_256) / 512.0,
            ],
            |geometry| {
                [
                    f32::from_bits(geometry.collision_half_width_f32_bits),
                    f32::from_bits(geometry.collision_half_height_f32_bits),
                ]
            },
        )
    }

    pub fn placement_half_extents(&self) -> [f32; 2] {
        self.placement_geometry.map_or_else(
            || self.collision_half_extents(),
            |geometry| {
                [
                    f32::from_bits(geometry.placement_half_width_f32_bits),
                    f32::from_bits(geometry.placement_half_height_f32_bits),
                ]
            },
        )
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

const fn default_object_data_status() -> i16 {
    1
}

const fn default_object_lifecycle_state() -> u8 {
    2
}

const fn is_default_object_lifecycle_state(value: &u8) -> bool {
    *value == default_object_lifecycle_state()
}

const fn is_zero_u8(value: &u8) -> bool {
    *value == 0
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationCell {
    pub x: u16,
    pub y: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectFoundation {
    pub terrain_id: TerrainId,
    pub omitted_cells: Vec<FoundationCell>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationTerrainRule {
    pub target_terrain_id: TerrainId,
    pub compatible_source_terrain_ids: Vec<TerrainId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protected_source_terrain_ids: Vec<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_class_replacement: Option<FoundationAnchorClassReplacement>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoundationAnchorClassReplacement {
    pub anchor_placement_class_mask: u8,
    pub comparison_terrain_id: TerrainId,
    pub primary_terrain_id: TerrainId,
    pub secondary_terrain_id: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompositeTerrainRule {
    pub source_terrain_id: TerrainId,
    pub primary_terrain_id: TerrainId,
    pub secondary_terrain_id: TerrainId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CivilizationSubstitution {
    pub civilization_id: CivilizationId,
    pub source_object_id: ObjectId,
    pub replacement_object_id: ObjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectReplacementRule {
    pub source_object_id: ObjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_object_id: Option<ObjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_attribute_id: Option<PlayerAttributeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_roll_inclusive: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_attribute_id: Option<PlayerAttributeId>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub excludes_computer_players: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology_gate: Option<TechnologyStateGate>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TechnologyStateGate {
    pub technology_ids: Vec<u16>,
    pub state: i16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TechnologyStateRule {
    pub technology_id: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_technology_ids: Vec<u16>,
    pub required_count: u8,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_civilization_ids: Vec<CivilizationId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub researched_civilization_ids: Vec<CivilizationId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TechnologyStateOwner {
    Gaia,
    Player(CivilizationId),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TechnologyStateError {
    Unavailable,
    Undetermined,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CivilizationAttributeValue {
    pub civilization_id: CivilizationId,
    pub attribute_id: PlayerAttributeId,
    pub value_f32_bits: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WallPlacementRule {
    pub wall_object_id: ObjectId,
    pub horizontal_gate_center_object_id: ObjectId,
    pub horizontal_gate_flank_object_id: ObjectId,
    pub vertical_gate_center_object_id: ObjectId,
    pub vertical_gate_flank_object_id: ObjectId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CivilizationObjectAttributeValue {
    pub civilization_id: CivilizationId,
    pub attribute_id: PlayerAttributeId,
    pub object_id: ObjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDefinition {
    pub id: ResourceId,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffDefinition {
    pub cliff_type: u32,
    pub terrain_id: TerrainId,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub piece_rules: Vec<CliffPieceRule>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffPieceRule {
    pub edges: [i8; 4],
    pub primary: CliffPieceVariant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternate: Option<CliffPieceVariant>,
    pub x_offset_256: u16,
    pub y_offset_256: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliffPieceVariant {
    pub object_id: ObjectId,
    pub facet: u8,
}

impl CliffDefinition {
    pub fn piece_rule(&self, edges: [i8; 4]) -> Option<CliffPieceRule> {
        self.piece_rules
            .binary_search_by_key(&edges, |rule| rule.edges)
            .ok()
            .map(|index| self.piece_rules[index])
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPlacementClassBindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forest_zone_class_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cliff_zone_class_id: Option<u32>,
}

impl ObjectPlacementClassBindings {
    fn is_empty(&self) -> bool {
        self.forest_zone_class_id.is_none() && self.cliff_zone_class_id.is_none()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeClassBindings {
    pub farm: u32,
    pub tree: u32,
    pub wall: u32,
    pub gate: u32,
    pub tower: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayerStartBindings {
    pub town_center_object_id: ObjectId,
    pub packed_town_center_object_id: ObjectId,
    pub villager_object_id: ObjectId,
    pub alternate_villager_object_id: ObjectId,
    pub fallback_scout_object_id: ObjectId,
    pub packed_town_center_attribute_id: PlayerAttributeId,
    pub starting_villagers_attribute_id: PlayerAttributeId,
    pub starting_scout_attribute_id: PlayerAttributeId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FarmCompletionBindings {
    pub parent_object_ids: Vec<ObjectId>,
    pub spawned_object_ids: Vec<ObjectId>,
    pub spawn_count_attribute_id: PlayerAttributeId,
    pub total_resource_quantity_attribute_id: PlayerAttributeId,
    pub bonus_amount_attribute_id: PlayerAttributeId,
    pub bonus_resource_attribute_id: PlayerAttributeId,
    pub bonus_anchor_attribute_id: PlayerAttributeId,
}

impl FarmCompletionBindings {
    pub fn attribute_ids(&self) -> [PlayerAttributeId; 5] {
        [
            self.spawn_count_attribute_id,
            self.total_resource_quantity_attribute_id,
            self.bonus_amount_attribute_id,
            self.bonus_resource_attribute_id,
            self.bonus_anchor_attribute_id,
        ]
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupTechnologyRoute {
    Automatic,
    Team,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupResourceOperationKind {
    Set,
    Add,
    Multiply,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupResourceOperation {
    pub kind: StartupResourceOperationKind,
    pub resource_id: PlayerAttributeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_resource_id: Option<PlayerAttributeId>,
    pub value_f32_bits: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupTechnologyResourceEffect {
    pub civilization_id: CivilizationId,
    pub route: StartupTechnologyRoute,
    pub technology_id: u16,
    pub operations: Vec<StartupResourceOperation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeGenerationBindings {
    pub default_terrain_id: TerrainId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flat_only_terrain_id: Option<TerrainId>,
    pub wall_anchor_object_ids: Vec<ObjectId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub explicit_maximum_seed_foundation_object_ids: Vec<ObjectId>,
    pub classes: NativeClassBindings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub construction_site_exemptions: Option<ConstructionSiteExemptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_start_bindings: Option<PlayerStartBindings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm_completion_bindings: Option<FarmCompletionBindings>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainTopologyBindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cliff_facet_terrain_id: Option<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cliff_overlay_terrain_id: Option<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_terrain_id: Option<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shoreline_terrain_id: Option<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_shoreline_terrain_id: Option<TerrainId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded_shoreline_water_terrain_ids: Vec<TerrainId>,
}

impl TerrainTopologyBindings {
    fn is_empty(&self) -> bool {
        self.cliff_facet_terrain_id.is_none()
            && self.cliff_overlay_terrain_id.is_none()
            && self.fill_terrain_id.is_none()
            && self.default_shoreline_terrain_id.is_none()
            && self.frozen_shoreline_terrain_id.is_none()
            && self.excluded_shoreline_water_terrain_ids.is_empty()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameModeTerrainRule {
    pub game_mode_raw: u8,
    pub terrain_id: TerrainId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_terrain_id: Option<TerrainId>,
    pub radius: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameModePlayerObjectRule {
    pub game_mode_raw: u8,
    pub object_id: ObjectId,
    pub anchor_object_id: ObjectId,
    pub inner_radius: u16,
    pub outer_radius: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildingTechnologyTrigger {
    pub civilization_id: CivilizationId,
    pub object_id: ObjectId,
    pub technology_id: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildingSpawnCommand {
    pub spawned_object_id: ObjectId,
    pub building_object_id: ObjectId,
    pub count: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomaticSpawnTechnology {
    pub technology_id: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub civilization_id: Option<CivilizationId>,
    pub required_technology_ids: Vec<u16>,
    pub commands: Vec<BuildingSpawnCommand>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildingSpawnVariantRule {
    pub source_object_id: ObjectId,
    pub alternate_object_id: ObjectId,
    pub alternate_from_percent: u8,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestrictionDefinition {
    pub id: RestrictionId,
    pub name: String,
    pub allowed_terrain_ids: Vec<TerrainId>,
    pub blocked_terrain_ids: Vec<TerrainId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traversal_cost_f32_bits: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_pathing_mask_i32: Option<i32>,
}

impl RestrictionDefinition {
    pub fn rejects_placement(&self, terrain: TerrainId) -> Option<bool> {
        self.traversal_cost_f32_bits
            .as_ref()?
            .get(terrain.0 as usize)
            .map(|&bits| f32::from_bits(bits) <= 0.05_f32)
    }

    pub fn allows_terrain(&self, terrain: TerrainId) -> Option<bool> {
        if let Some(costs) = &self.traversal_cost_f32_bits {
            return costs
                .get(terrain.0 as usize)
                .map(|&bits| f32::from_bits(bits) > 0.0);
        }
        Some(
            self.allowed_terrain_ids.binary_search(&terrain).is_ok()
                && self.blocked_terrain_ids.binary_search(&terrain).is_err(),
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentSourceKind {
    Synthetic,
    IndependentReference,
    Aoe2deDat,
    ReviewedBundle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentSource {
    pub kind: ContentSourceKind,
    pub fingerprint: String,
    pub product_version_label: Option<String>,
    pub dat_version_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_replacement_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeutralContentPack {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub pack_id: String,
    pub pack_version: String,
    pub source: ContentSource,
    pub compatible_behavior_profiles: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub rms_implicit_definitions: BTreeMap<String, i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rms_path_reference_object_id: Option<ObjectId>,
    pub terrains: Vec<TerrainDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub foundation_terrain_rules: Vec<FoundationTerrainRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub composite_terrain_rules: Vec<CompositeTerrainRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub game_mode_terrain_rules: Vec<GameModeTerrainRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub game_mode_player_object_rules: Vec<GameModePlayerObjectRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initial_automatic_technology_ids: Vec<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub building_technology_triggers: Vec<BuildingTechnologyTrigger>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub automatic_spawn_technologies: Vec<AutomaticSpawnTechnology>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_dependent_spawn_technologies: Vec<AutomaticSpawnTechnology>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub building_spawn_variant_rules: Vec<BuildingSpawnVariantRule>,
    pub objects: Vec<ObjectDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_resource_slot_variants: Vec<ObjectResourceSlotVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_movement_speed_variants: Vec<ObjectMovementSpeedVariant>,
    pub civilization_substitutions: Vec<CivilizationSubstitution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_replacement_rules: Vec<ObjectReplacementRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wall_placement_rules: Vec<WallPlacementRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub civilization_object_attribute_values: Vec<CivilizationObjectAttributeValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub civilization_attribute_values: Vec<CivilizationAttributeValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub technology_state_rules: Vec<TechnologyStateRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub startup_technology_resource_effects: Vec<StartupTechnologyResourceEffect>,
    pub resources: Vec<ResourceDefinition>,
    pub cliffs: Vec<CliffDefinition>,
    pub restrictions: Vec<RestrictionDefinition>,
    #[serde(default, skip_serializing_if = "TerrainTopologyBindings::is_empty")]
    pub terrain_topology: TerrainTopologyBindings,
    #[serde(
        default,
        skip_serializing_if = "ObjectPlacementClassBindings::is_empty"
    )]
    pub object_placement_classes: ObjectPlacementClassBindings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_generation_bindings: Option<NativeGenerationBindings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graphics: Vec<GraphicDefinition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentPackIdentity {
    pub pack_id: String,
    pub pack_version: String,
    pub source_fingerprint: String,
    pub content_hash: [u8; 32],
}

impl NeutralContentPack {
    fn carries_native_generation_facts(&self) -> bool {
        matches!(
            self.schema_version.as_str(),
            CONTENT_SCHEMA_VERSION
                | PLAYER_START_SCHEMA_VERSION
                | CONSTRUCTION_SITE_SCHEMA_VERSION
                | NATIVE_BINDINGS_SCHEMA_VERSION
        )
    }

    fn carries_player_start_facts(&self) -> bool {
        matches!(
            self.schema_version.as_str(),
            CONTENT_SCHEMA_VERSION | PLAYER_START_SCHEMA_VERSION
        )
    }

    fn carries_construction_site_facts(&self) -> bool {
        matches!(
            self.schema_version.as_str(),
            CONTENT_SCHEMA_VERSION | PLAYER_START_SCHEMA_VERSION | CONSTRUCTION_SITE_SCHEMA_VERSION
        )
    }

    fn validate_farm_completion_facts(&self) -> Result<(), ContentError> {
        let farm = self
            .native_generation_bindings
            .as_ref()
            .and_then(|bindings| bindings.farm_completion_bindings.as_ref());
        if (self.schema_version == CONTENT_SCHEMA_VERSION) != farm.is_some()
            || (farm.is_none() && !self.startup_technology_resource_effects.is_empty())
        {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        let Some(farm) = farm else {
            return Ok(());
        };
        require_sorted_unique_by(
            &farm.parent_object_ids,
            "nativeGenerationBindings.farmCompletionBindings.parentObjectIds",
            |value| value.0,
        )?;
        if farm.parent_object_ids.is_empty()
            || farm.parent_object_ids.len() > 16
            || farm.spawned_object_ids.is_empty()
            || farm.spawned_object_ids.len() > 16
        {
            return Err(ContentError::InvalidField(
                "nativeGenerationBindings.farmCompletionBindings",
            ));
        }
        for id in farm
            .parent_object_ids
            .iter()
            .chain(&farm.spawned_object_ids)
        {
            if self
                .objects
                .binary_search_by_key(id, |object| object.id)
                .is_err()
            {
                return Err(ContentError::DanglingReference("farm completion object"));
            }
        }
        let attributes = farm.attribute_ids();
        if attributes.into_iter().collect::<BTreeSet<_>>().len() != attributes.len() {
            return Err(ContentError::InvalidField(
                "farm completion attribute roles",
            ));
        }
        require_sorted_unique_by(
            &self.startup_technology_resource_effects,
            "startupTechnologyResourceEffects",
            |effect| (effect.civilization_id, effect.route, effect.technology_id),
        )?;
        if self.startup_technology_resource_effects.len() > 4096 {
            return Err(ContentError::ResourceLimit("startup technology effects"));
        }
        let mut needed = attributes.into_iter().collect::<BTreeSet<_>>();
        for effect in &self.startup_technology_resource_effects {
            if effect.operations.is_empty() || effect.operations.len() > 64 {
                return Err(ContentError::InvalidField(
                    "startupTechnologyResourceEffects.operations",
                ));
            }
            for operation in &effect.operations {
                if !f32::from_bits(operation.value_f32_bits).is_finite()
                    || (operation.kind == StartupResourceOperationKind::Multiply
                        && operation.source_resource_id.is_some())
                {
                    return Err(ContentError::InvalidField(
                        "startupTechnologyResourceEffects.operations",
                    ));
                }
                needed.insert(operation.resource_id);
                needed.extend(operation.source_resource_id);
            }
        }
        let civilizations = self
            .civilization_attribute_values
            .iter()
            .map(|value| value.civilization_id)
            .collect::<BTreeSet<_>>();
        if civilizations.is_empty()
            || civilizations.iter().any(|civilization| {
                needed.iter().any(|attribute| {
                    self.civilization_attribute_values
                        .binary_search_by_key(&(*civilization, *attribute), |value| {
                            (value.civilization_id, value.attribute_id)
                        })
                        .is_err()
                })
            })
            || self
                .startup_technology_resource_effects
                .iter()
                .any(|effect| !civilizations.contains(&effect.civilization_id))
        {
            return Err(ContentError::DanglingReference(
                "farm completion civilization attribute",
            ));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), ContentError> {
        if !matches!(
            self.schema_version.as_str(),
            CONTENT_SCHEMA_VERSION
                | PLAYER_START_SCHEMA_VERSION
                | CONSTRUCTION_SITE_SCHEMA_VERSION
                | NATIVE_BINDINGS_SCHEMA_VERSION
                | LEGACY_OWNER_SPEED_SCHEMA_VERSION
                | LEGACY_UNIFORM_SPEED_SCHEMA_VERSION
        ) || self.compatibility.minimum_major != CONTENT_SCHEMA_MAJOR
            || self.compatibility.maximum_major != CONTENT_SCHEMA_MAJOR
        {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        if self.schema_version == LEGACY_UNIFORM_SPEED_SCHEMA_VERSION
            && !self.object_movement_speed_variants.is_empty()
        {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        if self.carries_native_generation_facts() != self.native_generation_bindings.is_some() {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        if let Some(bindings) = &self.native_generation_bindings {
            let terrain_known = |id: TerrainId| {
                self.terrains
                    .binary_search_by_key(&id, |terrain| terrain.id)
                    .is_ok()
            };
            if !terrain_known(bindings.default_terrain_id)
                || bindings
                    .flat_only_terrain_id
                    .is_some_and(|id| !terrain_known(id))
                || bindings.wall_anchor_object_ids.is_empty()
                || bindings.wall_anchor_object_ids.len() > 16
                || bindings.explicit_maximum_seed_foundation_object_ids.len() > 256
            {
                return Err(ContentError::InvalidField("nativeGenerationBindings"));
            }
            let mut anchors = BTreeSet::new();
            if !bindings
                .wall_anchor_object_ids
                .iter()
                .all(|id| anchors.insert(*id))
            {
                return Err(ContentError::InvalidField(
                    "nativeGenerationBindings.wallAnchorObjectIds",
                ));
            }
            require_sorted_unique_by(
                &bindings.explicit_maximum_seed_foundation_object_ids,
                "nativeGenerationBindings.explicitMaximumSeedFoundationObjectIds",
                |value| value.0,
            )?;
            match &bindings.construction_site_exemptions {
                Some(exemptions) => {
                    if exemptions.object_ids.len() > 256 || exemptions.class_ids.len() > 256 {
                        return Err(ContentError::InvalidField(
                            "nativeGenerationBindings.constructionSiteExemptions",
                        ));
                    }
                    require_sorted_unique_by(
                        &exemptions.object_ids,
                        "nativeGenerationBindings.constructionSiteExemptions.objectIds",
                        |value| value.0,
                    )?;
                    require_sorted_unique_by(
                        &exemptions.class_ids,
                        "nativeGenerationBindings.constructionSiteExemptions.classIds",
                        |value| *value,
                    )?;
                }
                None if self.carries_construction_site_facts() => {
                    return Err(ContentError::InvalidField(
                        "nativeGenerationBindings.constructionSiteExemptions",
                    ));
                }
                None => {}
            }
            if bindings.construction_site_exemptions.is_some()
                && !self.carries_construction_site_facts()
            {
                return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
            }
        }
        let starts = self
            .native_generation_bindings
            .as_ref()
            .and_then(|bindings| bindings.player_start_bindings);
        if self.carries_player_start_facts() != starts.is_some() {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        self.validate_farm_completion_facts()?;
        if let Some(starts) = starts {
            for id in [
                starts.town_center_object_id,
                starts.packed_town_center_object_id,
                starts.villager_object_id,
                starts.alternate_villager_object_id,
                starts.fallback_scout_object_id,
            ] {
                if !self.objects.iter().any(|object| object.id == id) {
                    return Err(ContentError::DanglingReference("player start object"));
                }
            }
            if self
                .objects
                .iter()
                .find(|object| object.id == starts.villager_object_id)
                .and_then(|object| object.single_request_count)
                .is_none()
            {
                return Err(ContentError::InvalidField("player start villager count"));
            }
            let attributes = [
                starts.packed_town_center_attribute_id,
                starts.starting_villagers_attribute_id,
                starts.starting_scout_attribute_id,
            ];
            if attributes.into_iter().collect::<BTreeSet<_>>().len() != attributes.len() {
                return Err(ContentError::InvalidField("player start attribute roles"));
            }
        }
        for object in &self.objects {
            let building = object.constructor_type == Some(BUILDING_CONSTRUCTOR_TYPE);
            match (
                self.carries_construction_site_facts(),
                object.building_construction.is_some(),
            ) {
                (true, present) if present == building => {}
                (false, false) => {}
                (false, true) => {
                    return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
                }
                (true, _) => {
                    return Err(ContentError::InvalidField("objects.buildingConstruction"));
                }
            }
        }
        validate_identifier("packId", &self.pack_id, 128)?;
        validate_semver(&self.pack_version)?;
        if !is_sha256(&self.source.fingerprint) {
            return Err(ContentError::InvalidField("source.fingerprint"));
        }
        if self
            .source
            .object_replacement_fingerprint
            .as_ref()
            .is_some_and(|value| !is_sha256(value))
        {
            return Err(ContentError::InvalidField(
                "source.objectReplacementFingerprint",
            ));
        }
        if self
            .source
            .product_version_label
            .as_ref()
            .is_some_and(|value| {
                value.is_empty() || value.len() > 64 || value.chars().any(char::is_control)
            })
        {
            return Err(ContentError::InvalidField("source.productVersionLabel"));
        }
        match self.source.kind {
            ContentSourceKind::Synthetic
                if self.source.dat_version_header.is_some()
                    || self.source.product_version_label.is_some()
                    || self.source.object_replacement_fingerprint.is_some() =>
            {
                return Err(ContentError::InvalidField("source.datVersionHeader"));
            }
            ContentSourceKind::Aoe2deDat | ContentSourceKind::ReviewedBundle
                if self
                    .source
                    .dat_version_header
                    .as_deref()
                    .and_then(parse_supported_dat_header)
                    .is_none() =>
            {
                return Err(ContentError::InvalidField("source.datVersionHeader"));
            }
            ContentSourceKind::ReviewedBundle
                if !self.carries_native_generation_facts()
                    || self.source.product_version_label.is_none() =>
            {
                return Err(ContentError::InvalidField("source.productVersionLabel"));
            }
            _ => {}
        }
        if self.compatible_behavior_profiles.is_empty()
            || self.compatible_behavior_profiles.len() > 256
        {
            return Err(ContentError::ResourceLimit("compatible behavior profiles"));
        }
        for profile_id in &self.compatible_behavior_profiles {
            validate_identifier("compatibleBehaviorProfiles", profile_id, 64)?;
        }
        require_sorted_unique_strings(
            &self.compatible_behavior_profiles,
            "compatibleBehaviorProfiles",
        )?;
        if self.rms_implicit_definitions.len() > 65_536 {
            return Err(ContentError::ResourceLimit("RMS implicit definitions"));
        }
        for name in self.rms_implicit_definitions.keys() {
            validate_rms_name(name)?;
        }
        require_sorted_unique_by(&self.terrains, "terrains", |value| value.id.0)?;
        require_sorted_unique_by(
            &self.foundation_terrain_rules,
            "foundationTerrainRules",
            |value| value.target_terrain_id.0,
        )?;
        require_sorted_unique_by(
            &self.composite_terrain_rules,
            "compositeTerrainRules",
            |value| value.source_terrain_id.0,
        )?;
        require_sorted_unique_by(
            &self.game_mode_terrain_rules,
            "gameModeTerrainRules",
            |value| value.game_mode_raw,
        )?;
        require_sorted_unique_by(
            &self.game_mode_player_object_rules,
            "gameModePlayerObjectRules",
            |value| value.game_mode_raw,
        )?;
        require_sorted_unique_by(
            &self.initial_automatic_technology_ids,
            "initialAutomaticTechnologyIds",
            |value| *value,
        )?;
        require_sorted_unique_by(
            &self.building_technology_triggers,
            "buildingTechnologyTriggers",
            |value| (value.civilization_id.0, value.object_id.0),
        )?;
        require_sorted_unique_by(
            &self.automatic_spawn_technologies,
            "automaticSpawnTechnologies",
            |value| value.technology_id,
        )?;
        require_sorted_unique_by(
            &self.building_spawn_variant_rules,
            "buildingSpawnVariantRules",
            |value| value.source_object_id.0,
        )?;
        require_sorted_unique_by(&self.objects, "objects", |value| value.id.0)?;
        if let Some(reference) = self.rms_path_reference_object_id
            && self
                .objects
                .binary_search_by_key(&reference, |value| value.id)
                .is_err()
        {
            return Err(ContentError::DanglingReference("rmsPathReferenceObjectId"));
        }
        require_sorted_unique_by(
            &self.civilization_substitutions,
            "civilizationSubstitutions",
            |value| (value.civilization_id.0, value.source_object_id.0),
        )?;
        require_sorted_unique_by(
            &self.object_replacement_rules,
            "objectReplacementRules",
            |value| value.source_object_id.0,
        )?;
        require_sorted_unique_by(&self.wall_placement_rules, "wallPlacementRules", |value| {
            value.wall_object_id.0
        })?;
        require_sorted_unique_by(
            &self.civilization_object_attribute_values,
            "civilizationObjectAttributeValues",
            |value| (value.civilization_id.0, value.attribute_id.0),
        )?;
        require_sorted_unique_by(&self.resources, "resources", |value| value.id.0)?;
        require_sorted_unique_by(&self.graphics, "graphics", |value| value.id)?;
        if self.graphics.len() > 65_536
            || (!self.graphics.is_empty() && !self.carries_native_generation_facts())
        {
            return Err(ContentError::InvalidField("graphics"));
        }
        if !self.carries_native_generation_facts()
            && (!self.civilization_attribute_values.is_empty()
                || !self.technology_state_rules.is_empty()
                || !self.setup_dependent_spawn_technologies.is_empty()
                || self.objects.iter().any(|object| {
                    object.constructor_type.is_some() || object.disappears_when_built
                })
                || self
                    .automatic_spawn_technologies
                    .iter()
                    .any(|technology| technology.civilization_id.is_none()))
        {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        require_sorted_unique_by(&self.cliffs, "cliffs", |value| value.cliff_type)?;
        require_sorted_unique_by(&self.restrictions, "restrictions", |value| value.id.0)?;
        require_sorted_unique_by(
            &self.terrain_topology.excluded_shoreline_water_terrain_ids,
            "terrainTopology.excludedShorelineWaterTerrainIds",
            |value| value.0,
        )?;
        if self.terrains.len() > 65_536
            || self.foundation_terrain_rules.len() > 65_536
            || self.composite_terrain_rules.len() > 65_536
            || self.game_mode_terrain_rules.len() > 256
            || self.game_mode_player_object_rules.len() > 256
            || self.initial_automatic_technology_ids.len() > 1024
            || self.building_technology_triggers.len() > 65_536
            || self.automatic_spawn_technologies.len() > 1024
            || self.setup_dependent_spawn_technologies.len() > 1024
            || self.building_spawn_variant_rules.len() > 1024
            || self.objects.len() > 100_000
            || self.object_resource_slot_variants.len() > 1_000_000
            || self.object_movement_speed_variants.len() > 1_000_000
            || self.civilization_substitutions.len() > 1_000_000
            || self.object_replacement_rules.len() > 100_000
            || self.wall_placement_rules.len() > 100_000
            || self.civilization_object_attribute_values.len() > 1_000_000
            || self.civilization_attribute_values.len() > 1_000_000
            || self.technology_state_rules.len() > 65_536
            || self.resources.len() > 65_536
            || self.cliffs.len() > 65_536
            || self.restrictions.len() > 65_536
        {
            return Err(ContentError::ResourceLimit("content definition count"));
        }
        let mut terrain_aliases = BTreeSet::new();
        for terrain in &self.terrains {
            validate_name(&terrain.name)?;
            require_sorted_unique_strings(&terrain.rms_names, "terrain RMS names")?;
            for alias in &terrain.rms_names {
                validate_rms_name(alias)?;
                if self
                    .rms_implicit_definitions
                    .get(alias)
                    .is_some_and(|value| i64::from(*value) != i64::from(terrain.id.0))
                {
                    return Err(ContentError::InvalidField(
                        "conflicting RMS content token identity",
                    ));
                }
                if !terrain_aliases.insert(alias.as_str()) {
                    return Err(ContentError::InvalidField("duplicate terrain RMS name"));
                }
            }
            if terrain.appearances.len() > 32 {
                return Err(ContentError::ResourceLimit("terrain appearances"));
            }
            if terrain
                .appearances
                .iter()
                .any(|appearance| appearance.weight_per_thousand > 1_000)
            {
                return Err(ContentError::InvalidField("terrain appearance weight"));
            }
        }
        for (field, terrain_id) in [
            (
                "terrainTopology.cliffFacetTerrainId",
                self.terrain_topology.cliff_facet_terrain_id,
            ),
            (
                "terrainTopology.cliffOverlayTerrainId",
                self.terrain_topology.cliff_overlay_terrain_id,
            ),
            (
                "terrainTopology.fillTerrainId",
                self.terrain_topology.fill_terrain_id,
            ),
            (
                "terrainTopology.defaultShorelineTerrainId",
                self.terrain_topology.default_shoreline_terrain_id,
            ),
            (
                "terrainTopology.frozenShorelineTerrainId",
                self.terrain_topology.frozen_shoreline_terrain_id,
            ),
        ] {
            if terrain_id.is_some_and(|terrain_id| {
                self.terrains
                    .binary_search_by_key(&terrain_id, |terrain| terrain.id)
                    .is_err()
            }) {
                return Err(ContentError::InvalidField(field));
            }
        }
        if self
            .terrain_topology
            .excluded_shoreline_water_terrain_ids
            .iter()
            .any(|terrain_id| {
                self.terrains
                    .binary_search_by_key(terrain_id, |terrain| terrain.id)
                    .is_err()
            })
        {
            return Err(ContentError::InvalidField(
                "terrainTopology.excludedShorelineWaterTerrainIds",
            ));
        }
        if self.game_mode_terrain_rules.iter().any(|rule| {
            self.terrains
                .binary_search_by_key(&rule.terrain_id, |terrain| terrain.id)
                .is_err()
                || rule.boundary_terrain_id.is_some_and(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(&terrain_id, |terrain| terrain.id)
                        .is_err()
                })
        }) {
            return Err(ContentError::InvalidField("gameModeTerrainRules.terrainId"));
        }
        if self.game_mode_player_object_rules.iter().any(|rule| {
            rule.inner_radius > rule.outer_radius
                || self
                    .objects
                    .binary_search_by_key(&rule.object_id, |object| object.id)
                    .is_err()
                || self
                    .objects
                    .binary_search_by_key(&rule.anchor_object_id, |object| object.id)
                    .is_err()
        }) {
            return Err(ContentError::InvalidField("gameModePlayerObjectRules"));
        }
        let known_technology = |id: u16| {
            self.initial_automatic_technology_ids
                .binary_search(&id)
                .is_ok()
                || self
                    .building_technology_triggers
                    .iter()
                    .any(|trigger| trigger.technology_id == id)
                || self
                    .automatic_spawn_technologies
                    .binary_search_by_key(&id, |technology| technology.technology_id)
                    .is_ok()
        };
        if self.building_technology_triggers.iter().any(|trigger| {
            self.objects
                .binary_search_by_key(&trigger.object_id, |object| object.id)
                .is_err()
        }) || self.automatic_spawn_technologies.iter().any(|technology| {
            technology.required_technology_ids.len() > 6
                || technology
                    .required_technology_ids
                    .iter()
                    .copied()
                    .collect::<BTreeSet<_>>()
                    .len()
                    != technology.required_technology_ids.len()
                || self
                    .initial_automatic_technology_ids
                    .binary_search(&technology.technology_id)
                    .is_ok()
                || self
                    .building_technology_triggers
                    .iter()
                    .any(|trigger| trigger.technology_id == technology.technology_id)
                || technology.commands.is_empty()
                || technology.commands.len() > 16
                || technology
                    .required_technology_ids
                    .iter()
                    .any(|&id| !known_technology(id) || id == technology.technology_id)
                || technology.commands.iter().any(|command| {
                    command.count == 0
                        || command.count > 1024
                        || self
                            .objects
                            .binary_search_by_key(&command.spawned_object_id, |object| object.id)
                            .is_err()
                        || self
                            .objects
                            .binary_search_by_key(&command.building_object_id, |object| object.id)
                            .is_err()
                })
        }) || self.building_spawn_variant_rules.iter().any(|rule| {
            rule.alternate_from_percent == 0
                || rule.alternate_from_percent >= 100
                || self
                    .objects
                    .binary_search_by_key(&rule.source_object_id, |object| object.id)
                    .is_err()
                || self
                    .objects
                    .binary_search_by_key(&rule.alternate_object_id, |object| object.id)
                    .is_err()
        }) {
            return Err(ContentError::InvalidField(
                "automatic building spawn technology",
            ));
        }
        require_sorted_unique_by(
            &self.setup_dependent_spawn_technologies,
            "setupDependentSpawnTechnologies",
            |technology| technology.technology_id,
        )?;
        let object_known = |id: ObjectId| {
            self.objects
                .binary_search_by_key(&id, |object| object.id)
                .is_ok()
        };
        if self
            .setup_dependent_spawn_technologies
            .iter()
            .any(|technology| {
                technology.required_technology_ids.is_empty()
                    || technology.required_technology_ids.len() > 6
                    || technology
                        .required_technology_ids
                        .contains(&technology.technology_id)
                    || technology.commands.is_empty()
                    || technology.commands.len() > 16
                    || known_technology(technology.technology_id)
                    || technology.commands.iter().any(|command| {
                        command.count == 0
                            || command.count > 1024
                            || !object_known(command.spawned_object_id)
                            || !object_known(command.building_object_id)
                    })
            })
        {
            return Err(ContentError::InvalidField(
                "setupDependentSpawnTechnologies",
            ));
        }
        for technology in self
            .automatic_spawn_technologies
            .iter()
            .chain(&self.setup_dependent_spawn_technologies)
        {
            let mut required = technology.required_technology_ids.clone();
            required.sort_unstable();
            required.dedup();
            if required.len() != technology.required_technology_ids.len() {
                return Err(ContentError::InvalidField(
                    "automaticSpawnTechnologies.requiredTechnologyIds",
                ));
            }
        }
        for rule in &self.foundation_terrain_rules {
            require_sorted_unique_by(
                &rule.compatible_source_terrain_ids,
                "foundationTerrainRules.compatibleSourceTerrainIds",
                |value| value.0,
            )?;
            require_sorted_unique_by(
                &rule.protected_source_terrain_ids,
                "foundationTerrainRules.protectedSourceTerrainIds",
                |value| value.0,
            )?;
            if self
                .terrains
                .binary_search_by_key(&rule.target_terrain_id, |terrain| terrain.id)
                .is_err()
                || rule.compatible_source_terrain_ids.iter().any(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(terrain_id, |terrain| terrain.id)
                        .is_err()
                })
                || rule.protected_source_terrain_ids.iter().any(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(terrain_id, |terrain| terrain.id)
                        .is_err()
                })
            {
                return Err(ContentError::InvalidField(
                    "foundation terrain rule references unavailable terrain",
                ));
            }
            if let Some(replacement) = rule.anchor_class_replacement {
                if replacement.anchor_placement_class_mask == 0 {
                    return Err(ContentError::InvalidField(
                        "foundationTerrainRules.anchorClassReplacement.anchorPlacementClassMask",
                    ));
                }
                let replacement_terrain_ids = [
                    replacement.comparison_terrain_id,
                    replacement.primary_terrain_id,
                ];
                if replacement_terrain_ids.iter().any(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(terrain_id, |terrain| terrain.id)
                        .is_err()
                }) || (replacement.secondary_terrain_id != u16::MAX
                    && self
                        .terrains
                        .binary_search_by_key(
                            &TerrainId(u32::from(replacement.secondary_terrain_id)),
                            |terrain| terrain.id,
                        )
                        .is_err())
                {
                    return Err(ContentError::InvalidField(
                        "foundation terrain class replacement references unavailable terrain",
                    ));
                }
            }
        }
        for rule in &self.composite_terrain_rules {
            if rule.source_terrain_id.0 > u32::from(u16::MAX)
                || rule.secondary_terrain_id.0 > u32::from(u16::MAX)
                || [
                    rule.source_terrain_id,
                    rule.primary_terrain_id,
                    rule.secondary_terrain_id,
                ]
                .iter()
                .any(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(terrain_id, |terrain| terrain.id)
                        .is_err()
                })
            {
                return Err(ContentError::InvalidField(
                    "composite terrain rule references unavailable terrain",
                ));
            }
        }
        validate_object_attachments(&self.objects)?;
        let mut object_aliases = BTreeSet::new();
        for object in &self.objects {
            if !object.placement_rule_variants.is_empty() {
                if object.placement_rules.is_some() {
                    return Err(ContentError::InvalidField(
                        "ambiguous object placement rules",
                    ));
                }
                if object.placement_rule_variants.len() > 65_536 {
                    return Err(ContentError::ResourceLimit("object placement variants"));
                }
                let mut covered = BTreeSet::new();
                let mut previous = None;
                for variant in &object.placement_rule_variants {
                    let ids = &variant.civilization_ids;
                    if ids.is_empty() || ids.len() > 65_536 {
                        return Err(ContentError::InvalidField(
                            "object placement variant civilizations",
                        ));
                    }
                    require_sorted_unique_by(
                        ids,
                        "object placement variant civilizations",
                        |id| id.0,
                    )?;
                    if previous.is_some_and(|id| id >= ids[0]) {
                        return Err(ContentError::InvalidField("object placement variant order"));
                    }
                    previous = Some(ids[0]);
                    for &id in ids {
                        if !covered.insert(id) {
                            return Err(ContentError::InvalidField(
                                "overlapping object placement variants",
                            ));
                        }
                    }
                    if covered.len() > 65_536 {
                        return Err(ContentError::ResourceLimit(
                            "object placement variant civilizations",
                        ));
                    }
                }
                if object
                    .available_civilizations
                    .as_ref()
                    .is_some_and(|ids| !covered.iter().eq(ids.iter()))
                {
                    return Err(ContentError::InvalidField(
                        "object placement variant availability",
                    ));
                }
            }
            if !object.restriction_variants.is_empty() {
                if object.restriction_id.is_some() {
                    return Err(ContentError::InvalidField("ambiguous object restriction"));
                }
                let Some(available) = &object.available_civilizations else {
                    return Err(ContentError::InvalidField(
                        "object restriction variant availability",
                    ));
                };
                if object.restriction_variants.len() > 65_536 {
                    return Err(ContentError::ResourceLimit("object restriction variants"));
                }
                let mut covered = BTreeSet::new();
                let mut previous = None;
                for variant in &object.restriction_variants {
                    let ids = &variant.civilization_ids;
                    if ids.is_empty() || ids.len() > 65_536 {
                        return Err(ContentError::InvalidField(
                            "object restriction variant civilizations",
                        ));
                    }
                    require_sorted_unique_by(
                        ids,
                        "object restriction variant civilizations",
                        |id| id.0,
                    )?;
                    if previous.is_some_and(|id| id >= ids[0]) {
                        return Err(ContentError::InvalidField(
                            "object restriction variant order",
                        ));
                    }
                    previous = Some(ids[0]);
                    for &id in ids {
                        if !covered.insert(id) {
                            return Err(ContentError::InvalidField(
                                "overlapping object restriction variants",
                            ));
                        }
                    }
                }
                if !covered.iter().eq(available.iter()) {
                    return Err(ContentError::InvalidField(
                        "object restriction variant availability",
                    ));
                }
            }
            if let Some(pathing) = object.pathing {
                pathing.validate()?;
            }
            if object.class39_pathing_gate.is_some() && object.class_id != 39 {
                return Err(ContentError::InvalidField(
                    "class-39 pathing gate on another object class",
                ));
            }
            if object
                .movement_speed_f32_bits
                .is_some_and(|bits| !f32::from_bits(bits).is_finite())
            {
                return Err(ContentError::InvalidField("object movement speed"));
            }
            if object.construction_retirement_requires_height && object.pathing.is_none() {
                return Err(ContentError::InvalidField(
                    "construction retirement vertical extent unavailable",
                ));
            }
            if let Some(civilizations) = &object.available_civilizations {
                if civilizations.len() > 65_536 {
                    return Err(ContentError::ResourceLimit(
                        "object available civilizations",
                    ));
                }
                require_sorted_unique_by(civilizations, "object available civilizations", |id| {
                    id.0
                })?;
            }
            if object.graphic_replacement_variants.len() > 65_536 {
                return Err(ContentError::ResourceLimit(
                    "object graphic replacement variants",
                ));
            }
            let mut graphic_replacement_civilizations = BTreeSet::new();
            let mut previous_graphic_replacement = None;
            for variant in &object.graphic_replacement_variants {
                let civilizations = &variant.civilization_ids;
                if civilizations.is_empty() || civilizations.len() > 65_536 {
                    return Err(ContentError::InvalidField(
                        "object graphic replacement civilizations",
                    ));
                }
                require_sorted_unique_by(
                    civilizations,
                    "object graphic replacement civilizations",
                    |id| id.0,
                )?;
                if previous_graphic_replacement
                    .is_some_and(|civilization| civilization >= civilizations[0])
                {
                    return Err(ContentError::InvalidField(
                        "object graphic replacement variant order",
                    ));
                }
                previous_graphic_replacement = Some(civilizations[0]);
                for &civilization in civilizations {
                    if civilization == CivilizationId(0)
                        || !graphic_replacement_civilizations.insert(civilization)
                        || object
                            .available_civilizations
                            .as_ref()
                            .is_some_and(|available| {
                                available.binary_search(&civilization).is_err()
                            })
                    {
                        return Err(ContentError::InvalidField(
                            "object graphic replacement civilizations",
                        ));
                    }
                }
            }
            validate_name(&object.name)?;
            require_sorted_unique_strings(&object.rms_names, "object RMS names")?;
            for alias in &object.rms_names {
                validate_rms_name(alias)?;
                if self
                    .rms_implicit_definitions
                    .get(alias)
                    .is_some_and(|value| i64::from(*value) != i64::from(object.id.0))
                {
                    return Err(ContentError::InvalidField(
                        "conflicting RMS content token identity",
                    ));
                }
                if !object_aliases.insert(alias.as_str()) {
                    return Err(ContentError::InvalidField("duplicate object RMS name"));
                }
            }
            let zero_sized_non_obstructing = object.footprint_width_256 == 0
                && object.footprint_height_256 == 0
                && object.obstruction == ObstructionKind::None
                && object.foundation.is_none();
            if (object.footprint_width_256 == 0 || object.footprint_height_256 == 0)
                && !zero_sized_non_obstructing
            {
                return Err(ContentError::InvalidField("object footprint"));
            }
            if object.placement_geometry.is_some() {
                let collision = object.collision_half_extents();
                let placement = object.placement_half_extents();
                if collision.into_iter().chain(placement).any(|extent| {
                    !extent.is_finite()
                        || extent.is_sign_negative()
                        || extent > f32::from(u16::MAX) / 512.0
                }) {
                    return Err(ContentError::InvalidField("object placement geometry"));
                }
                if (collision[0] * 512.0).round() as u16 != object.footprint_width_256
                    || (collision[1] * 512.0).round() as u16 != object.footprint_height_256
                {
                    return Err(ContentError::InvalidField(
                        "object geometry footprint projection",
                    ));
                }
            }
            if object.creation_rng.facet_count == 0 || object.creation_rng.facet_count > 256 {
                return Err(ContentError::InvalidField("object creation facet count"));
            }
            if object.creation_rng.random_angle && object.creation_rng.facet_count == 1 {
                return Err(ContentError::InvalidField(
                    "random-angle object creation facet count",
                ));
            }
            if object
                .creation_rng
                .fixed_facet
                .is_some_and(|facet| facet > 255)
            {
                return Err(ContentError::InvalidField("fixed object creation facet"));
            }
            if object.standing_graphic_creation_variants.len() > 65_536 {
                return Err(ContentError::ResourceLimit(
                    "object standing-graphic creation variants",
                ));
            }
            if !object.standing_graphic_creation_variants.is_empty()
                && object.standing_graphic_id.is_none()
            {
                return Err(ContentError::InvalidField(
                    "object standing-graphic identity",
                ));
            }
            require_sorted_unique_by(
                &object.standing_graphic_creation_variants,
                "object standing-graphic creation variants",
                |variant| variant.standing_graphic_id,
            )?;
            for variant in &object.standing_graphic_creation_variants {
                if Some(variant.standing_graphic_id) == object.standing_graphic_id {
                    return Err(ContentError::InvalidField(
                        "redundant object standing-graphic creation variant",
                    ));
                }
                let profile = variant.creation_rng;
                if profile.facet_count == 0 || profile.facet_count > 256 {
                    return Err(ContentError::InvalidField(
                        "object standing-graphic creation facet count",
                    ));
                }
                if profile.random_angle && profile.facet_count == 1 {
                    return Err(ContentError::InvalidField(
                        "random-angle object standing-graphic creation facet count",
                    ));
                }
                if profile.fixed_facet.is_some_and(|facet| facet > 255) {
                    return Err(ContentError::InvalidField(
                        "fixed object standing-graphic creation facet",
                    ));
                }
            }
            if object
                .single_request_count
                .is_some_and(|count| count == 0 || count > 65_536)
            {
                return Err(ContentError::InvalidField("object single-request count"));
            }
            if object
                .neighbor_facing
                .and_then(|f| f.linked_object_id)
                .is_some_and(|id| {
                    self.objects
                        .binary_search_by_key(&id, |object| object.id)
                        .is_err()
                })
            {
                return Err(ContentError::InvalidField(
                    "neighbor link references unavailable object",
                ));
            }
            for (field, terrain_ids) in [
                (
                    "object placement-side terrain IDs",
                    &object.placement_side_terrain_ids,
                ),
                (
                    "object placement-center terrain IDs",
                    &object.placement_center_terrain_ids,
                ),
            ] {
                if terrain_ids.len() > 2 {
                    return Err(ContentError::ResourceLimit(field));
                }
                if terrain_ids.iter().any(|terrain_id| {
                    self.terrains
                        .binary_search_by_key(terrain_id, |terrain| terrain.id)
                        .is_err()
                }) {
                    return Err(ContentError::InvalidField(field));
                }
            }
            if let Some(foundation) = &object.foundation {
                if foundation.omitted_cells.len() > 65_536 {
                    return Err(ContentError::ResourceLimit(
                        "object foundation omitted cells",
                    ));
                }
                require_sorted_unique_by(
                    &foundation.omitted_cells,
                    "object foundation omitted cells",
                    |cell| (cell.x, cell.y),
                )?;
                let footprint_columns = u32::from(object.footprint_width_256).div_ceil(256);
                let footprint_rows = u32::from(object.footprint_height_256).div_ceil(256);
                if foundation.omitted_cells.iter().any(|cell| {
                    u32::from(cell.x) >= footprint_columns || u32::from(cell.y) >= footprint_rows
                }) {
                    return Err(ContentError::InvalidField("object foundation omitted cell"));
                }
            }
        }
        for resource in &self.resources {
            validate_name(&resource.name)?;
        }
        for restriction in &self.restrictions {
            validate_name(&restriction.name)?;
            require_sorted_unique_by(
                &restriction.allowed_terrain_ids,
                "restriction allowed terrain IDs",
                |value| value.0,
            )?;
            require_sorted_unique_by(
                &restriction.blocked_terrain_ids,
                "restriction blocked terrain IDs",
                |value| value.0,
            )?;
            if let Some(costs) = &restriction.traversal_cost_f32_bits {
                if costs.len() > 256 {
                    return Err(ContentError::InvalidField(
                        "restriction traversal cost bound",
                    ));
                }
                for (ids, expected) in [
                    (&restriction.allowed_terrain_ids, true),
                    (&restriction.blocked_terrain_ids, false),
                ] {
                    if ids.iter().any(|&id| match restriction.allows_terrain(id) {
                        Some(actual) => actual != expected,
                        None => expected,
                    }) {
                        return Err(ContentError::InvalidField(
                            "restriction traversal cost sign",
                        ));
                    }
                }
            }
        }

        let terrain_ids = self
            .terrains
            .iter()
            .map(|value| value.id)
            .collect::<Vec<_>>();
        let object_ids = self
            .objects
            .iter()
            .map(|value| value.id)
            .collect::<Vec<_>>();
        let resource_ids = self
            .resources
            .iter()
            .map(|value| value.id)
            .collect::<Vec<_>>();
        let restriction_ids = self
            .restrictions
            .iter()
            .map(|value| value.id)
            .collect::<Vec<_>>();
        for terrain in &self.terrains {
            for appearance in &terrain.appearances {
                match (appearance.object_id, appearance.placement_restriction_id) {
                    (Some(object_id), Some(restriction_id)) => {
                        if object_ids.binary_search(&object_id).is_err() {
                            return Err(ContentError::DanglingReference(
                                "terrain appearance object",
                            ));
                        }
                        if restriction_ids.binary_search(&restriction_id).is_err() {
                            return Err(ContentError::DanglingReference(
                                "terrain appearance placement restriction",
                            ));
                        }
                    }
                    (Some(_), None) => {
                        return Err(ContentError::InvalidField(
                            "terrain appearance placement restriction",
                        ));
                    }
                    (None, Some(_)) => {
                        return Err(ContentError::InvalidField(
                            "terrain appearance restriction without object",
                        ));
                    }
                    (None, None) => {}
                }
            }
        }
        for object in &self.objects {
            if object.initializes_restriction_zones
                && (if object.restriction_variants.is_empty() {
                    object.restriction_id.is_none()
                } else {
                    object
                        .restriction_variants
                        .iter()
                        .any(|variant| variant.restriction_id.is_none())
                })
            {
                return Err(ContentError::InvalidField("zone initializer restriction"));
            }
            if object
                .restriction_id
                .is_some_and(|value| restriction_ids.binary_search(&value).is_err())
            {
                return Err(ContentError::DanglingReference("object restriction"));
            }
            if object.restriction_variants.iter().any(|variant| {
                variant
                    .restriction_id
                    .is_some_and(|value| restriction_ids.binary_search(&value).is_err())
            }) {
                return Err(ContentError::DanglingReference(
                    "object restriction variant",
                ));
            }
            if let Some(slots) = object.resource_slots {
                for slot in slots {
                    if !slot.has_finite_quantity() {
                        return Err(ContentError::InvalidField("object resource quantity"));
                    }
                    if slot.resource_type >= 0
                        && resource_ids
                            .binary_search(&ResourceId(slot.resource_type as u32))
                            .is_err()
                    {
                        return Err(ContentError::DanglingReference("object resource"));
                    }
                }
            }
            if let Some(resource) = object.initial_resource_override {
                if !f32::from_bits(resource.quantity_f32_bits).is_finite() {
                    return Err(ContentError::InvalidField(
                        "object initial resource quantity",
                    ));
                }
                if resource.resource_type >= 0
                    && resource_ids
                        .binary_search(&ResourceId(resource.resource_type as u32))
                        .is_err()
                {
                    return Err(ContentError::DanglingReference("object initial resource"));
                }
            }
            if object.foundation.as_ref().is_some_and(|foundation| {
                terrain_ids.binary_search(&foundation.terrain_id).is_err()
            }) {
                return Err(ContentError::DanglingReference("object foundation terrain"));
            }
        }
        let mut resource_variant_coverage = BTreeMap::<ObjectId, BTreeSet<CivilizationId>>::new();
        let mut previous_resource_variant = None;
        for variant in &self.object_resource_slot_variants {
            if variant.civilization_ids.is_empty() || variant.civilization_ids.len() > 65_536 {
                return Err(ContentError::InvalidField(
                    "object resource variant civilizations",
                ));
            }
            require_sorted_unique_by(
                &variant.civilization_ids,
                "object resource variant civilizations",
                |id| id.0,
            )?;
            let key = (variant.object_id.0, variant.civilization_ids[0].0);
            if previous_resource_variant.is_some_and(|previous| previous >= key) {
                return Err(ContentError::InvalidField("object resource variant order"));
            }
            previous_resource_variant = Some(key);
            let object = self
                .objects
                .binary_search_by_key(&variant.object_id, |object| object.id)
                .ok()
                .map(|index| &self.objects[index])
                .ok_or(ContentError::DanglingReference(
                    "object resource variant master",
                ))?;
            if object.resource_slots.is_some() {
                return Err(ContentError::InvalidField(
                    "ambiguous object resource slots",
                ));
            }
            let covered = resource_variant_coverage
                .entry(variant.object_id)
                .or_default();
            for &civilization in &variant.civilization_ids {
                if !covered.insert(civilization) {
                    return Err(ContentError::InvalidField(
                        "overlapping object resource variants",
                    ));
                }
            }
            for slot in variant.resource_slots {
                if !slot.has_finite_quantity() {
                    return Err(ContentError::InvalidField("object resource quantity"));
                }
                if slot.resource_type >= 0
                    && resource_ids
                        .binary_search(&ResourceId(slot.resource_type as u32))
                        .is_err()
                {
                    return Err(ContentError::DanglingReference("object resource"));
                }
            }
        }
        for (object_id, covered) in resource_variant_coverage {
            let object = &self.objects[self
                .objects
                .binary_search_by_key(&object_id, |object| object.id)
                .expect("resource variant master was validated")];
            if object
                .available_civilizations
                .as_ref()
                .is_none_or(|civilizations| !covered.iter().eq(civilizations.iter()))
            {
                return Err(ContentError::InvalidField(
                    "object resource variant availability",
                ));
            }
        }
        let mut speed_variant_coverage = BTreeMap::<ObjectId, BTreeSet<CivilizationId>>::new();
        let mut previous_speed_variant = None;
        for variant in &self.object_movement_speed_variants {
            if variant.civilization_ids.is_empty() || variant.civilization_ids.len() > 65_536 {
                return Err(ContentError::InvalidField(
                    "object movement speed variant civilizations",
                ));
            }
            require_sorted_unique_by(
                &variant.civilization_ids,
                "object movement speed variant civilizations",
                |id| id.0,
            )?;
            let key = (variant.object_id.0, variant.civilization_ids[0].0);
            if previous_speed_variant.is_some_and(|previous| previous >= key) {
                return Err(ContentError::InvalidField(
                    "object movement speed variant order",
                ));
            }
            previous_speed_variant = Some(key);
            let object = self
                .objects
                .binary_search_by_key(&variant.object_id, |object| object.id)
                .ok()
                .map(|index| &self.objects[index])
                .ok_or(ContentError::DanglingReference(
                    "object movement speed variant master",
                ))?;
            if object.movement_speed_f32_bits.is_some() {
                return Err(ContentError::InvalidField(
                    "ambiguous object movement speed",
                ));
            }
            if !f32::from_bits(variant.speed_f32_bits).is_finite() {
                return Err(ContentError::InvalidField("object movement speed variant"));
            }
            let covered = speed_variant_coverage.entry(variant.object_id).or_default();
            for &civilization in &variant.civilization_ids {
                if !covered.insert(civilization) {
                    return Err(ContentError::InvalidField(
                        "overlapping object movement speed variants",
                    ));
                }
            }
        }
        for (object_id, covered) in speed_variant_coverage {
            let object = &self.objects[self
                .objects
                .binary_search_by_key(&object_id, |object| object.id)
                .expect("speed variant master was validated")];
            if object
                .available_civilizations
                .as_ref()
                .is_none_or(|civilizations| !covered.iter().eq(civilizations.iter()))
            {
                return Err(ContentError::InvalidField(
                    "object movement speed variant availability",
                ));
            }
        }
        for substitution in &self.civilization_substitutions {
            if object_ids
                .binary_search(&substitution.source_object_id)
                .is_err()
                || object_ids
                    .binary_search(&substitution.replacement_object_id)
                    .is_err()
            {
                return Err(ContentError::DanglingReference(
                    "civilization object substitution",
                ));
            }
        }
        if !self.object_replacement_rules.is_empty()
            && self.source.object_replacement_fingerprint.is_none()
        {
            return Err(ContentError::InvalidField(
                "source.objectReplacementFingerprint",
            ));
        }
        for replacement in &self.object_replacement_rules {
            let has_direct = replacement.replacement_object_id.is_some();
            let has_attribute = replacement.replacement_attribute_id.is_some();
            if object_ids
                .binary_search(&replacement.source_object_id)
                .is_err()
                || has_direct == has_attribute
                || replacement
                    .replacement_object_id
                    .is_some_and(|object_id| object_ids.binary_search(&object_id).is_err())
                || replacement
                    .replacement_attribute_id
                    .is_some_and(|attribute_id| {
                        !self
                            .civilization_object_attribute_values
                            .iter()
                            .any(|value| value.attribute_id == attribute_id)
                    })
                || replacement
                    .maximum_roll_inclusive
                    .is_some_and(|value| value > 99)
            {
                return Err(ContentError::DanglingReference("direct object replacement"));
            }
            if let Some(attribute_id) = replacement.required_attribute_id
                && !self
                    .civilization_attribute_values
                    .iter()
                    .any(|value| value.attribute_id == attribute_id)
            {
                return Err(ContentError::DanglingReference(
                    "object replacement required attribute",
                ));
            }
            if let Some(gate) = &replacement.technology_gate {
                require_sorted_unique_by(
                    &gate.technology_ids,
                    "objectReplacementRules.technologyGate.technologyIds",
                    |value| *value,
                )?;
                if gate.technology_ids.is_empty()
                    || gate.technology_ids.len() > 16
                    || !matches!(gate.state, -1..=4)
                    || gate.technology_ids.iter().any(|id| {
                        self.technology_state_rules
                            .binary_search_by_key(id, |rule| rule.technology_id)
                            .is_err()
                    })
                {
                    return Err(ContentError::DanglingReference(
                        "object replacement technology gate",
                    ));
                }
            }
            if !self.carries_native_generation_facts()
                && (replacement.required_attribute_id.is_some()
                    || replacement.excludes_computer_players
                    || replacement.technology_gate.is_some())
            {
                return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
            }
        }
        require_sorted_unique_by(
            &self.civilization_attribute_values,
            "civilizationAttributeValues",
            |value| (value.civilization_id, value.attribute_id),
        )?;
        if self
            .civilization_attribute_values
            .iter()
            .any(|value| !f32::from_bits(value.value_f32_bits).is_finite())
        {
            return Err(ContentError::InvalidField("civilizationAttributeValues"));
        }
        require_sorted_unique_by(
            &self.technology_state_rules,
            "technologyStateRules",
            |rule| rule.technology_id,
        )?;
        for rule in &self.technology_state_rules {
            require_sorted_unique_by(
                &rule.required_technology_ids,
                "technologyStateRules.requiredTechnologyIds",
                |value| *value,
            )?;
            require_sorted_unique_by(
                &rule.disabled_civilization_ids,
                "technologyStateRules.disabledCivilizationIds",
                |value| value.0,
            )?;
            require_sorted_unique_by(
                &rule.researched_civilization_ids,
                "technologyStateRules.researchedCivilizationIds",
                |value| value.0,
            )?;
            if rule.required_technology_ids.len() > 6
                || usize::from(rule.required_count) > rule.required_technology_ids.len()
                || rule
                    .disabled_civilization_ids
                    .iter()
                    .any(|id| rule.researched_civilization_ids.binary_search(id).is_ok())
            {
                return Err(ContentError::InvalidField("technologyStateRules"));
            }
        }
        for rule in &self.wall_placement_rules {
            if [
                rule.wall_object_id,
                rule.horizontal_gate_center_object_id,
                rule.horizontal_gate_flank_object_id,
                rule.vertical_gate_center_object_id,
                rule.vertical_gate_flank_object_id,
            ]
            .iter()
            .any(|object_id| object_ids.binary_search(object_id).is_err())
            {
                return Err(ContentError::DanglingReference("wall placement object"));
            }
        }
        for value in &self.civilization_object_attribute_values {
            if object_ids.binary_search(&value.object_id).is_err() {
                return Err(ContentError::DanglingReference(
                    "civilization object attribute value",
                ));
            }
        }
        for cliff in &self.cliffs {
            if terrain_ids.binary_search(&cliff.terrain_id).is_err() {
                return Err(ContentError::DanglingReference("cliff terrain"));
            }
            if cliff.piece_rules.len() > 32 {
                return Err(ContentError::ResourceLimit("cliff piece rules"));
            }
            require_sorted_unique_by(&cliff.piece_rules, "cliff piece rules", |rule| rule.edges)?;
            for rule in &cliff.piece_rules {
                let connected = rule.edges.iter().filter(|edge| **edge != 0).count();
                if !(1..=2).contains(&connected)
                    || rule.edges.iter().any(|edge| !(-1..=1).contains(edge))
                    || !(256..=512).contains(&rule.x_offset_256)
                    || !(256..=512).contains(&rule.y_offset_256)
                {
                    return Err(ContentError::InvalidField("cliff piece geometry"));
                }
                for variant in std::iter::once(rule.primary).chain(rule.alternate) {
                    if object_ids.binary_search(&variant.object_id).is_err() {
                        return Err(ContentError::DanglingReference("cliff piece object"));
                    }
                }
            }
        }
        for restriction in &self.restrictions {
            if restriction.traversal_cost_f32_bits.is_some() {
                for terrain in &self.terrains {
                    let listed = restriction
                        .allowed_terrain_ids
                        .binary_search(&terrain.id)
                        .is_ok()
                        && restriction
                            .blocked_terrain_ids
                            .binary_search(&terrain.id)
                            .is_err();
                    if restriction
                        .allows_terrain(terrain.id)
                        .is_some_and(|actual| actual != listed)
                    {
                        return Err(ContentError::InvalidField(
                            "restriction traversal terrain coverage",
                        ));
                    }
                }
            }
            for terrain_id in restriction
                .allowed_terrain_ids
                .iter()
                .chain(&restriction.blocked_terrain_ids)
            {
                if terrain_ids.binary_search(terrain_id).is_err() {
                    return Err(ContentError::DanglingReference("restriction terrain"));
                }
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ContentError> {
        self.validate()?;
        let mut copy = self.clone();
        copy.schema = None;
        let bytes = serde_json::to_vec(&copy).map_err(ContentError::Serialize)?;
        if bytes.len() > MAXIMUM_PACK_BYTES {
            return Err(ContentError::ResourceLimit("serialized content pack"));
        }
        Ok(bytes)
    }

    pub fn identity(&self) -> Result<ContentPackIdentity, ContentError> {
        Ok(ContentPackIdentity {
            pack_id: self.pack_id.clone(),
            pack_version: self.pack_version.clone(),
            source_fingerprint: self.source.fingerprint.clone(),
            content_hash: Sha256::digest(self.canonical_bytes()?).into(),
        })
    }

    pub fn rms_implicit_definitions(&self) -> Result<BTreeMap<String, String>, ContentError> {
        self.validate()?;
        let mut definitions = self
            .rms_implicit_definitions
            .iter()
            .map(|(name, value)| (name.clone(), value.to_string()))
            .collect::<BTreeMap<_, _>>();
        for (names, identity) in self
            .terrains
            .iter()
            .map(|terrain| (&terrain.rms_names, terrain.id.0))
            .chain(
                self.objects
                    .iter()
                    .map(|object| (&object.rms_names, object.id.0)),
            )
        {
            for name in names {
                let value = identity.to_string();
                if definitions
                    .insert(name.clone(), value.clone())
                    .is_some_and(|previous| previous != value)
                {
                    return Err(ContentError::InvalidField(
                        "conflicting RMS content token identity",
                    ));
                }
            }
        }
        Ok(definitions)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CompatibleContentView<'a> {
    pack: &'a NeutralContentPack,
}

impl<'a> CompatibleContentView<'a> {
    pub fn new(
        pack: &'a NeutralContentPack,
        behavior_profile_id: &str,
    ) -> Result<Self, ContentError> {
        pack.validate()?;
        if pack
            .compatible_behavior_profiles
            .binary_search_by(|value| value.as_str().cmp(behavior_profile_id))
            .is_err()
        {
            return Err(ContentError::IncompatibleProfile(
                behavior_profile_id.to_owned(),
            ));
        }
        Ok(Self { pack })
    }

    pub fn identity(&self) -> Result<ContentPackIdentity, ContentError> {
        self.pack.identity()
    }

    pub fn rms_implicit_definition(&self, name: &str) -> Option<i32> {
        self.pack.rms_implicit_definitions.get(name).copied()
    }

    pub fn terrain(&self, id: TerrainId) -> Option<&'a TerrainDefinition> {
        self.pack
            .terrains
            .binary_search_by_key(&id, |terrain| terrain.id)
            .ok()
            .map(|index| &self.pack.terrains[index])
    }

    pub fn foundation_terrain_rule(
        &self,
        target_terrain_id: TerrainId,
    ) -> Option<&'a FoundationTerrainRule> {
        self.pack
            .foundation_terrain_rules
            .binary_search_by_key(&target_terrain_id, |rule| rule.target_terrain_id)
            .ok()
            .map(|index| &self.pack.foundation_terrain_rules[index])
    }

    pub fn composite_terrain_rule(
        &self,
        source_terrain_id: TerrainId,
    ) -> Option<CompositeTerrainRule> {
        self.pack
            .composite_terrain_rules
            .binary_search_by_key(&source_terrain_id, |rule| rule.source_terrain_id)
            .ok()
            .map(|index| self.pack.composite_terrain_rules[index])
    }

    pub fn game_mode_terrain_rule(&self, game_mode_raw: u8) -> Option<GameModeTerrainRule> {
        self.pack
            .game_mode_terrain_rules
            .binary_search_by_key(&game_mode_raw, |rule| rule.game_mode_raw)
            .ok()
            .map(|index| self.pack.game_mode_terrain_rules[index])
    }

    pub fn game_mode_player_object_rule(
        &self,
        game_mode_raw: u8,
    ) -> Option<GameModePlayerObjectRule> {
        self.pack
            .game_mode_player_object_rules
            .binary_search_by_key(&game_mode_raw, |rule| rule.game_mode_raw)
            .ok()
            .map(|index| self.pack.game_mode_player_object_rules[index])
    }

    pub fn initial_automatic_technology_ids(&self) -> &'a [u16] {
        &self.pack.initial_automatic_technology_ids
    }

    pub fn building_technology_trigger(
        &self,
        civilization_id: CivilizationId,
        object_id: ObjectId,
    ) -> Option<u16> {
        self.pack
            .building_technology_triggers
            .binary_search_by_key(&(civilization_id.0, object_id.0), |rule| {
                (rule.civilization_id.0, rule.object_id.0)
            })
            .ok()
            .map(|index| self.pack.building_technology_triggers[index].technology_id)
    }

    pub fn automatic_spawn_technologies(&self) -> &'a [AutomaticSpawnTechnology] {
        &self.pack.automatic_spawn_technologies
    }

    pub fn setup_dependent_spawn_technologies(&self) -> &'a [AutomaticSpawnTechnology] {
        &self.pack.setup_dependent_spawn_technologies
    }

    pub fn building_spawn_variant_rule(
        &self,
        object_id: ObjectId,
    ) -> Option<BuildingSpawnVariantRule> {
        self.pack
            .building_spawn_variant_rules
            .binary_search_by_key(&object_id, |rule| rule.source_object_id)
            .ok()
            .map(|index| self.pack.building_spawn_variant_rules[index])
    }

    pub fn terrain_by_rms_name(&self, name: &str) -> Option<&'a TerrainDefinition> {
        self.pack.terrains.iter().find(|terrain| {
            terrain
                .rms_names
                .binary_search_by(|alias| alias.as_str().cmp(name))
                .is_ok()
        })
    }

    pub fn object(&self, id: ObjectId) -> Option<&'a ObjectDefinition> {
        self.pack
            .objects
            .binary_search_by_key(&id, |object| object.id)
            .ok()
            .map(|index| &self.pack.objects[index])
    }

    pub fn object_by_rms_name(&self, name: &str) -> Option<&'a ObjectDefinition> {
        self.pack.objects.iter().find(|object| {
            object
                .rms_names
                .binary_search_by(|alias| alias.as_str().cmp(name))
                .is_ok()
        })
    }

    pub fn restriction(&self, id: RestrictionId) -> Option<&'a RestrictionDefinition> {
        self.pack
            .restrictions
            .binary_search_by_key(&id, |restriction| restriction.id)
            .ok()
            .map(|index| &self.pack.restrictions[index])
    }

    pub fn restrictions(&self) -> &'a [RestrictionDefinition] {
        &self.pack.restrictions
    }

    pub fn substituted_object(
        &self,
        civilization_id: CivilizationId,
        source_object_id: ObjectId,
    ) -> ObjectId {
        self.pack
            .civilization_substitutions
            .binary_search_by_key(&(civilization_id, source_object_id), |substitution| {
                (substitution.civilization_id, substitution.source_object_id)
            })
            .ok()
            .map(|index| self.pack.civilization_substitutions[index].replacement_object_id)
            .unwrap_or(source_object_id)
    }

    pub fn object_replacement_rule(
        &self,
        source_object_id: ObjectId,
    ) -> Option<&'a ObjectReplacementRule> {
        self.pack
            .object_replacement_rules
            .binary_search_by_key(&source_object_id, |replacement| {
                replacement.source_object_id
            })
            .ok()
            .map(|index| &self.pack.object_replacement_rules[index])
    }

    pub fn object_replacement_rules(&self) -> &'a [ObjectReplacementRule] {
        &self.pack.object_replacement_rules
    }

    pub fn building_technology_trigger_ids(&self) -> impl Iterator<Item = u16> + 'a {
        self.pack
            .building_technology_triggers
            .iter()
            .map(|trigger| trigger.technology_id)
    }

    pub fn civilization_attribute_value(
        &self,
        civilization_id: CivilizationId,
        attribute_id: PlayerAttributeId,
    ) -> Option<f32> {
        self.pack
            .civilization_attribute_values
            .binary_search_by_key(&(civilization_id, attribute_id), |value| {
                (value.civilization_id, value.attribute_id)
            })
            .ok()
            .map(|index| {
                f32::from_bits(self.pack.civilization_attribute_values[index].value_f32_bits)
            })
    }

    pub fn farm_completion_bindings(&self) -> Option<&'a FarmCompletionBindings> {
        self.pack
            .native_generation_bindings
            .as_ref()
            .and_then(|bindings| bindings.farm_completion_bindings.as_ref())
    }

    pub fn startup_technology_resource_effects(&self) -> &'a [StartupTechnologyResourceEffect] {
        &self.pack.startup_technology_resource_effects
    }

    pub fn technology_state_rule(&self, technology_id: u16) -> Option<&'a TechnologyStateRule> {
        self.pack
            .technology_state_rules
            .binary_search_by_key(&technology_id, |rule| rule.technology_id)
            .ok()
            .map(|index| &self.pack.technology_state_rules[index])
    }

    pub fn generation_start_technology_state(
        &self,
        technology_id: u16,
        owner: TechnologyStateOwner,
    ) -> Result<i16, TechnologyStateError> {
        let rule = self
            .technology_state_rule(technology_id)
            .ok_or(TechnologyStateError::Unavailable)?;
        let civilization_id = match owner {
            TechnologyStateOwner::Gaia => CivilizationId(0),
            TechnologyStateOwner::Player(civilization_id) => civilization_id,
        };
        if rule
            .disabled_civilization_ids
            .binary_search(&civilization_id)
            .is_ok()
        {
            return Ok(-1);
        }
        if owner == TechnologyStateOwner::Gaia {
            return if rule.required_count == 0 {
                Err(TechnologyStateError::Undetermined)
            } else {
                Ok(0)
            };
        }
        let researched = |id: u16| -> bool {
            self.initial_automatic_technology_ids()
                .binary_search(&id)
                .is_ok()
                || self.technology_state_rule(id).is_some_and(|rule| {
                    rule.researched_civilization_ids
                        .binary_search(&civilization_id)
                        .is_ok()
                })
        };
        if researched(technology_id) {
            return Ok(3);
        }
        let satisfied = rule
            .required_technology_ids
            .iter()
            .filter(|id| researched(**id))
            .count();
        Ok(if satisfied >= usize::from(rule.required_count) {
            1
        } else {
            0
        })
    }

    pub fn wall_placement_rule(&self, wall_object_id: ObjectId) -> Option<WallPlacementRule> {
        self.pack
            .wall_placement_rules
            .binary_search_by_key(&wall_object_id, |rule| rule.wall_object_id)
            .ok()
            .map(|index| self.pack.wall_placement_rules[index])
    }

    pub fn civilization_object_attribute(
        &self,
        civilization_id: CivilizationId,
        attribute_id: PlayerAttributeId,
    ) -> Option<ObjectId> {
        self.pack
            .civilization_object_attribute_values
            .binary_search_by_key(&(civilization_id, attribute_id), |value| {
                (value.civilization_id, value.attribute_id)
            })
            .ok()
            .map(|index| self.pack.civilization_object_attribute_values[index].object_id)
    }

    pub fn objects(&self) -> &'a [ObjectDefinition] {
        &self.pack.objects
    }

    pub fn object_resource_slots(
        &self,
        object_id: ObjectId,
        civilization_id: CivilizationId,
    ) -> Option<[ObjectResourceSlot; 3]> {
        let object = self.object(object_id)?;
        object.resource_slots.or_else(|| {
            let variants = &self.pack.object_resource_slot_variants;
            let start = variants.partition_point(|variant| variant.object_id < object_id);
            variants[start..]
                .iter()
                .take_while(|variant| variant.object_id == object_id)
                .find(|variant| {
                    variant
                        .civilization_ids
                        .binary_search(&civilization_id)
                        .is_ok()
                })
                .map(|variant| variant.resource_slots)
        })
    }

    pub fn object_movement_speed_bits(
        &self,
        object_id: ObjectId,
        civilization_id: CivilizationId,
    ) -> Option<u32> {
        let object = self.object(object_id)?;
        object.movement_speed_f32_bits.or_else(|| {
            let variants = &self.pack.object_movement_speed_variants;
            let start = variants.partition_point(|variant| variant.object_id < object_id);
            variants[start..]
                .iter()
                .take_while(|variant| variant.object_id == object_id)
                .find(|variant| {
                    variant
                        .civilization_ids
                        .binary_search(&civilization_id)
                        .is_ok()
                })
                .map(|variant| variant.speed_f32_bits)
        })
    }

    pub fn object_movement_speed_variants(
        &self,
        object_id: ObjectId,
    ) -> impl Iterator<Item = &'a ObjectMovementSpeedVariant> + 'a {
        let variants = &self.pack.object_movement_speed_variants;
        let start = variants.partition_point(|variant| variant.object_id < object_id);
        variants[start..]
            .iter()
            .take_while(move |variant| variant.object_id == object_id)
    }

    pub fn rms_path_reference_object_id(&self) -> Option<ObjectId> {
        self.pack.rms_path_reference_object_id
    }

    pub fn terrains(&self) -> &'a [TerrainDefinition] {
        &self.pack.terrains
    }

    pub fn object_placement_classes(&self) -> ObjectPlacementClassBindings {
        self.pack.object_placement_classes
    }

    pub fn graphic(&self, graphic_id: i16) -> Option<&'a GraphicDefinition> {
        self.pack
            .graphics
            .binary_search_by_key(&graphic_id, |graphic| graphic.id)
            .ok()
            .map(|index| &self.pack.graphics[index])
    }

    pub fn native_generation_bindings(&self) -> Option<&'a NativeGenerationBindings> {
        self.pack.native_generation_bindings.as_ref()
    }

    pub fn terrain_topology(&self) -> &TerrainTopologyBindings {
        &self.pack.terrain_topology
    }

    pub fn cliff(&self, cliff_type: u32) -> Option<&'a CliffDefinition> {
        self.pack
            .cliffs
            .binary_search_by_key(&cliff_type, |cliff| cliff.cliff_type)
            .ok()
            .map(|index| &self.pack.cliffs[index])
    }
}

pub fn synthetic_content_pack(behavior_profile_id: &str) -> NeutralContentPack {
    let fingerprint = hex_sha256(b"rmside-synthetic-neutral-content-v1");
    NeutralContentPack {
        schema: Some("https://rmside.invalid/schemas/content-pack/v1".to_owned()),
        schema_version: NATIVE_BINDINGS_SCHEMA_VERSION.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: CONTENT_SCHEMA_MAJOR,
            maximum_major: CONTENT_SCHEMA_MAJOR,
        },
        pack_id: SYNTHETIC_PACK_ID.to_owned(),
        pack_version: "1.0.0".to_owned(),
        source: ContentSource {
            kind: ContentSourceKind::Synthetic,
            fingerprint,
            product_version_label: None,
            dat_version_header: None,
            object_replacement_fingerprint: None,
        },
        compatible_behavior_profiles: vec![behavior_profile_id.to_owned()],
        rms_implicit_definitions: BTreeMap::new(),
        rms_path_reference_object_id: None,
        terrains: vec![
            TerrainDefinition {
                id: TerrainId(1),
                name: "Synthetic grass".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(2),
                name: "Synthetic shallows".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Water,
                placement_class: 0,
                passable: true,
                buildable: false,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(3),
                name: "Synthetic water".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Water,
                placement_class: 0,
                passable: false,
                buildable: false,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(4),
                name: "Synthetic beach".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Beach,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
        ],
        foundation_terrain_rules: Vec::new(),
        composite_terrain_rules: Vec::new(),
        game_mode_terrain_rules: Vec::new(),
        game_mode_player_object_rules: Vec::new(),
        initial_automatic_technology_ids: Vec::new(),
        building_technology_triggers: Vec::new(),
        automatic_spawn_technologies: Vec::new(),
        setup_dependent_spawn_technologies: Vec::new(),
        building_spawn_variant_rules: Vec::new(),
        objects: vec![
            ObjectDefinition {
                initializes_restriction_zones: false,
                constructor_type: None,
                id: ObjectId(1),
                name: "Synthetic tree".to_owned(),
                rms_names: vec!["SYNTHETIC_TREE".to_owned()],
                class_id: 1,
                available_civilizations: None,
                footprint_width_256: 128,
                footprint_height_256: 128,
                placement_geometry: None,
                placement_rules: None,
                placement_rule_variants: Vec::new(),
                pathing: None,
                class39_pathing_gate: None,
                position_family: None,
                movement_speed_f32_bits: None,
                occupancy_uses_movement_speed: None,
                edge_margin_256: 0,
                obstruction: ObstructionKind::Circle,
                can_be_built_on: false,
                construction_retirement_requires_height: false,
                hit_points: Some(i16::MAX),
                placement_collision: ObjectPlacementCollision::default(),
                placement_side_terrain_ids: Vec::new(),
                placement_center_terrain_ids: Vec::new(),
                initial_lifecycle_state: default_object_lifecycle_state(),
                restriction_id: Some(RestrictionId(1)),
                restriction_variants: Vec::new(),
                resource_slots: Some([
                    ObjectResourceSlot {
                        resource_type: 1,
                        quantity_f32_bits: 100.0_f32.to_bits(),
                        mode: 0,
                    },
                    ObjectResourceSlot::EMPTY,
                    ObjectResourceSlot::EMPTY,
                ]),
                initial_resource_override: None,
                data_status: default_object_data_status(),
                creation_rng: ObjectCreationRng::default(),
                standing_graphic_id: None,
                standing_graphic_creation_variants: Vec::new(),
                graphic_replacement_variants: Vec::new(),
                construction_attachments: Vec::new(),
                neighbor_facing: None,
                single_request_count: None,
                disappears_when_built: false,
                building_construction: None,
                foundation: None,
            },
            ObjectDefinition {
                initializes_restriction_zones: false,
                constructor_type: None,
                id: ObjectId(2),
                name: "Synthetic town center".to_owned(),
                rms_names: vec!["SYNTHETIC_TOWN_CENTER".to_owned()],
                class_id: 2,
                available_civilizations: None,
                footprint_width_256: 1024,
                footprint_height_256: 1024,
                placement_geometry: None,
                placement_rules: None,
                placement_rule_variants: Vec::new(),
                pathing: None,
                class39_pathing_gate: None,
                position_family: None,
                movement_speed_f32_bits: None,
                occupancy_uses_movement_speed: None,
                edge_margin_256: 0,
                obstruction: ObstructionKind::Rectangle,
                can_be_built_on: false,
                construction_retirement_requires_height: false,
                hit_points: Some(i16::MAX),
                placement_collision: ObjectPlacementCollision::default(),
                placement_side_terrain_ids: Vec::new(),
                placement_center_terrain_ids: Vec::new(),
                initial_lifecycle_state: default_object_lifecycle_state(),
                restriction_id: Some(RestrictionId(1)),
                restriction_variants: Vec::new(),
                resource_slots: Some([ObjectResourceSlot::EMPTY; 3]),
                initial_resource_override: None,
                data_status: default_object_data_status(),
                creation_rng: ObjectCreationRng::default(),
                standing_graphic_id: None,
                standing_graphic_creation_variants: Vec::new(),
                graphic_replacement_variants: Vec::new(),
                construction_attachments: Vec::new(),
                neighbor_facing: None,
                single_request_count: None,
                disappears_when_built: false,
                building_construction: None,
                foundation: None,
            },
        ],
        object_resource_slot_variants: Vec::new(),
        object_movement_speed_variants: Vec::new(),
        civilization_substitutions: vec![CivilizationSubstitution {
            civilization_id: CivilizationId(1),
            source_object_id: ObjectId(2),
            replacement_object_id: ObjectId(2),
        }],
        object_replacement_rules: Vec::new(),
        wall_placement_rules: Vec::new(),
        civilization_object_attribute_values: Vec::new(),
        civilization_attribute_values: Vec::new(),
        technology_state_rules: Vec::new(),
        startup_technology_resource_effects: Vec::new(),
        resources: vec![ResourceDefinition {
            id: ResourceId(1),
            name: "Synthetic wood".to_owned(),
        }],
        cliffs: vec![CliffDefinition {
            cliff_type: 1,
            terrain_id: TerrainId(1),
            piece_rules: Vec::new(),
        }],
        restrictions: vec![RestrictionDefinition {
            id: RestrictionId(1),
            name: "Synthetic land".to_owned(),
            traversal_cost_f32_bits: None,
            placement_pathing_mask_i32: None,
            allowed_terrain_ids: vec![TerrainId(1), TerrainId(4)],
            blocked_terrain_ids: vec![TerrainId(2), TerrainId(3)],
        }],
        terrain_topology: TerrainTopologyBindings::default(),
        object_placement_classes: ObjectPlacementClassBindings {
            forest_zone_class_id: Some(1),
            cliff_zone_class_id: Some(2),
        },
        graphics: Vec::new(),
        native_generation_bindings: Some(NativeGenerationBindings {
            default_terrain_id: TerrainId(1),
            flat_only_terrain_id: None,
            wall_anchor_object_ids: vec![ObjectId(109), ObjectId(444)],
            explicit_maximum_seed_foundation_object_ids: vec![ObjectId(50), ObjectId(1187)],
            classes: NativeClassBindings {
                farm: 49,
                tree: 15,
                wall: 27,
                gate: 39,
                tower: 52,
            },
            construction_site_exemptions: None,
            player_start_bindings: None,
            farm_completion_bindings: None,
        }),
    }
}

pub fn exact_reference_content_pack(behavior_profile_id: &str) -> NeutralContentPack {
    let fingerprint = hex_sha256(b"rmside-independent-exact-neutral-reference-v2");
    let object = |id: u32,
                  name: &str,
                  class_id: u32,
                  width: u16,
                  height: u16,
                  obstruction: ObstructionKind,
                  resource_slot: Option<ObjectResourceSlot>,
                  data_status: i16,
                  foundation: Option<ObjectFoundation>| {
        ObjectDefinition {
            initializes_restriction_zones: false,
            id: ObjectId(id),
            name: name.to_owned(),
            rms_names: match id {
                59 => vec!["FORAGE_BUSH".to_owned()],
                109 => vec!["TOWN_CENTER".to_owned()],
                594 => vec!["SHEEP".to_owned()],
                _ => Vec::new(),
            },
            class_id,
            available_civilizations: (id == 59).then(|| vec![CivilizationId(0)]),
            footprint_width_256: width,
            footprint_height_256: height,
            placement_geometry: None,
            placement_rules: None,
            placement_rule_variants: Vec::new(),
            pathing: None,
            class39_pathing_gate: None,
            position_family: None,
            movement_speed_f32_bits: None,
            occupancy_uses_movement_speed: None,
            edge_margin_256: 0,
            obstruction,
            can_be_built_on: false,
            construction_retirement_requires_height: false,
            hit_points: Some(i16::MAX),
            placement_collision: ObjectPlacementCollision::default(),
            placement_side_terrain_ids: Vec::new(),
            placement_center_terrain_ids: Vec::new(),
            initial_lifecycle_state: default_object_lifecycle_state(),
            restriction_id: Some(RestrictionId(7)),
            restriction_variants: Vec::new(),
            resource_slots: Some([
                resource_slot.unwrap_or(ObjectResourceSlot::EMPTY),
                ObjectResourceSlot::EMPTY,
                ObjectResourceSlot::EMPTY,
            ]),
            initial_resource_override: None,
            data_status,
            standing_graphic_id: None,
            constructor_type: None,
            standing_graphic_creation_variants: Vec::new(),
            graphic_replacement_variants: Vec::new(),
            construction_attachments: Vec::new(),
            neighbor_facing: None,
            creation_rng: match id {
                594 => ObjectCreationRng {
                    facet_count: 16,
                    random_facet: true,
                    random_angle: true,
                    random_combat_seed: true,
                    fixed_facet: None,
                },
                109 | 618 | 619 | 620 | 1649 | 890 => ObjectCreationRng {
                    facet_count: 1,
                    random_facet: false,
                    random_angle: false,
                    random_combat_seed: true,
                    fixed_facet: (id != 890).then_some(7),
                },
                _ => ObjectCreationRng::default(),
            },
            single_request_count: None,
            disappears_when_built: false,
            building_construction: None,
            foundation,
        }
    };
    let attachment = |id: u32, x: f32, y: f32| ObjectAttachment {
        object_id: ObjectId(id),
        x_offset_f32_bits: x.to_bits(),
        y_offset_f32_bits: y.to_bits(),
    };
    let mut cliff_piece = object(
        9911,
        "Neutral cliff marker",
        80,
        0,
        0,
        ObstructionKind::None,
        None,
        1,
        None,
    );
    cliff_piece.available_civilizations = Some(vec![CivilizationId(0)]);
    cliff_piece.restriction_id = Some(RestrictionId(8));
    cliff_piece.placement_rules = Some(ObjectPlacementRules {
        family: ObjectPlacementFamily::Terrain,
        slope_mode: 0,
    });
    cliff_piece.creation_rng.random_facet = false;
    let mut piece_rules = Vec::new();
    for mask in 1_u8..16 {
        if mask.count_ones() > 2 {
            continue;
        }
        let edges = std::array::from_fn(|index| i8::from(mask & (1 << index) != 0));
        piece_rules.push(CliffPieceRule {
            edges,
            primary: CliffPieceVariant {
                object_id: ObjectId(9911),
                facet: 0,
            },
            alternate: matches!(mask, 5 | 10).then_some(CliffPieceVariant {
                object_id: ObjectId(9911),
                facet: 1,
            }),
            x_offset_256: 384,
            y_offset_256: 384,
        });
    }
    piece_rules.sort_by_key(|rule| rule.edges);
    let start_unit = |id: u32, class_id: u32, width: u16, hit_points: i16| ObjectDefinition {
        available_civilizations: None,
        hit_points: Some(hit_points),
        constructor_type: Some(70),
        creation_rng: ObjectCreationRng {
            facet_count: 16,
            random_facet: true,
            random_angle: true,
            random_combat_seed: true,
            fixed_facet: None,
        },
        ..object(
            id,
            match id {
                83 => "Neutral villager",
                293 => "Neutral alternate villager",
                _ => "Neutral scout",
            },
            class_id,
            width,
            width,
            ObstructionKind::Circle,
            None,
            60,
            None,
        )
    };
    let villager = ObjectDefinition {
        single_request_count: Some(3),
        ..start_unit(83, 4, 102, 25)
    };
    let alternate_villager = start_unit(293, 4, 102, 25);
    let scout = start_unit(448, 47, 128, 45);
    let packed_town_center = object(
        444,
        "Neutral packed town center",
        51,
        256,
        256,
        ObstructionKind::Circle,
        None,
        60,
        None,
    );
    NeutralContentPack {
        schema: Some("https://rmside.invalid/schemas/content-pack/v1".to_owned()),
        schema_version: PLAYER_START_SCHEMA_VERSION.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: CONTENT_SCHEMA_MAJOR,
            maximum_major: CONTENT_SCHEMA_MAJOR,
        },
        pack_id: EXACT_REFERENCE_PACK_ID.to_owned(),
        rms_path_reference_object_id: None,
        pack_version: "1.2.0".to_owned(),
        source: ContentSource {
            kind: ContentSourceKind::IndependentReference,
            fingerprint,
            product_version_label: None,
            dat_version_header: None,
            object_replacement_fingerprint: None,
        },
        compatible_behavior_profiles: vec![behavior_profile_id.to_owned()],
        rms_implicit_definitions: [
            ("AT_PLAYER", 0),
            ("CT_GRANITE", 0),
            ("CT_DESERT", 1),
            ("CT_SNOW", 2),
            ("CT_MARBLE", 3),
            ("CT_LIMESTONE", 4),
            ("CT_TERRACE", 5),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect(),
        terrains: vec![
            TerrainDefinition {
                id: TerrainId(0),
                name: "Neutral grass".to_owned(),
                rms_names: vec!["GRASS".to_owned()],
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: vec![TerrainAppearanceDefinition {
                    placement: TerrainAppearancePlacement::Randomized,
                    weight_per_thousand: 60,
                    object_id: None,
                    placement_restriction_id: None,
                }],
            },
            TerrainDefinition {
                id: TerrainId(1),
                name: "Neutral water".to_owned(),
                rms_names: vec!["WATER".to_owned()],
                layer_class: TerrainLayerClass::Water,
                placement_class: 0x04,
                passable: false,
                buildable: false,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(2),
                name: "Neutral beach".to_owned(),
                rms_names: vec!["BEACH".to_owned()],
                layer_class: TerrainLayerClass::Beach,
                placement_class: 0x10,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(3),
                name: "Neutral dirt".to_owned(),
                rms_names: vec!["DIRT3".to_owned()],
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: vec![
                    TerrainAppearanceDefinition {
                        placement: TerrainAppearancePlacement::Randomized,
                        weight_per_thousand: 10,
                        object_id: None,
                        placement_restriction_id: None,
                    },
                    TerrainAppearanceDefinition {
                        placement: TerrainAppearancePlacement::Randomized,
                        weight_per_thousand: 10,
                        object_id: None,
                        placement_restriction_id: None,
                    },
                ],
            },
            TerrainDefinition {
                id: TerrainId(6),
                name: "Neutral dirt two".to_owned(),
                rms_names: vec!["DIRT".to_owned()],
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(10),
                name: "Neutral forest".to_owned(),
                rms_names: vec!["FOREST".to_owned()],
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: false,
                buildable: false,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(16),
                name: "Neutral visual facet".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Overlay,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(27),
                name: "Neutral building foundation".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Land,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
            TerrainDefinition {
                id: TerrainId(70),
                name: "Neutral cliff brush overlay".to_owned(),
                rms_names: Vec::new(),
                layer_class: TerrainLayerClass::Overlay,
                placement_class: 0,
                passable: true,
                buildable: true,
                appearances: Vec::new(),
            },
        ],
        foundation_terrain_rules: vec![FoundationTerrainRule {
            target_terrain_id: TerrainId(27),
            compatible_source_terrain_ids: vec![TerrainId(0), TerrainId(3)],
            protected_source_terrain_ids: Vec::new(),
            anchor_class_replacement: None,
        }],
        composite_terrain_rules: Vec::new(),
        game_mode_terrain_rules: Vec::new(),
        game_mode_player_object_rules: Vec::new(),
        initial_automatic_technology_ids: Vec::new(),
        building_technology_triggers: Vec::new(),
        automatic_spawn_technologies: Vec::new(),
        setup_dependent_spawn_technologies: Vec::new(),
        building_spawn_variant_rules: Vec::new(),
        objects: vec![
            object(
                59,
                "Neutral forage",
                10,
                256,
                256,
                ObstructionKind::Circle,
                Some(ObjectResourceSlot {
                    resource_type: 0,
                    quantity_f32_bits: 0,
                    mode: 0,
                }),
                1,
                None,
            ),
            villager,
            ObjectDefinition {
                construction_attachments: vec![
                    attachment(618, 1.0, -1.0),
                    attachment(619, -0.5, 0.5),
                    attachment(620, -1.0, 1.0),
                    attachment(890, -1.0, 1.0),
                ],
                ..object(
                    109,
                    "Neutral town center",
                    80,
                    1024,
                    1024,
                    ObstructionKind::Rectangle,
                    None,
                    1,
                    Some(ObjectFoundation {
                        terrain_id: TerrainId(27),
                        omitted_cells: vec![
                            FoundationCell { x: 0, y: 2 },
                            FoundationCell { x: 0, y: 3 },
                            FoundationCell { x: 1, y: 2 },
                            FoundationCell { x: 1, y: 3 },
                        ],
                    }),
                )
            },
            alternate_villager,
            packed_town_center,
            scout,
            object(
                594,
                "Neutral herdable",
                58,
                154,
                154,
                ObstructionKind::Circle,
                Some(ObjectResourceSlot {
                    resource_type: 0,
                    quantity_f32_bits: 0,
                    mode: 0,
                }),
                60,
                None,
            ),
            object(
                618,
                "Town center annex north-east",
                80,
                512,
                512,
                ObstructionKind::None,
                None,
                1,
                None,
            ),
            ObjectDefinition {
                construction_attachments: vec![attachment(1649, 0.75, -0.75)],
                ..object(
                    619,
                    "Town center annex west",
                    80,
                    768,
                    768,
                    ObstructionKind::None,
                    None,
                    1,
                    None,
                )
            },
            object(
                620,
                "Town center annex south-west",
                80,
                512,
                512,
                ObstructionKind::None,
                None,
                1,
                None,
            ),
            object(
                890,
                "Town center co-located component",
                80,
                0,
                0,
                ObstructionKind::None,
                None,
                0,
                None,
            ),
            object(
                1649,
                "Town center annex north",
                80,
                0,
                0,
                ObstructionKind::None,
                None,
                1,
                None,
            ),
            cliff_piece,
        ],
        object_resource_slot_variants: Vec::new(),
        object_movement_speed_variants: Vec::new(),
        civilization_substitutions: Vec::new(),
        object_replacement_rules: Vec::new(),
        wall_placement_rules: Vec::new(),
        civilization_object_attribute_values: (0..60)
            .map(|civilization| CivilizationObjectAttributeValue {
                civilization_id: CivilizationId(civilization),
                attribute_id: PlayerAttributeId(263),
                object_id: ObjectId(448),
            })
            .collect(),
        civilization_attribute_values: (0..60)
            .map(|civilization| CivilizationAttributeValue {
                civilization_id: CivilizationId(civilization),
                attribute_id: PlayerAttributeId(82),
                value_f32_bits: 0.0_f32.to_bits(),
            })
            .collect(),
        technology_state_rules: Vec::new(),
        startup_technology_resource_effects: Vec::new(),
        resources: vec![ResourceDefinition {
            id: ResourceId(0),
            name: "Neutral food".to_owned(),
        }],
        cliffs: (0..6)
            .map(|cliff_type| CliffDefinition {
                cliff_type,
                terrain_id: TerrainId(0),
                piece_rules: piece_rules.clone(),
            })
            .collect(),
        restrictions: vec![
            RestrictionDefinition {
                id: RestrictionId(7),
                name: "Neutral land object placement".to_owned(),
                traversal_cost_f32_bits: Some(
                    (0..71)
                        .map(|id| if id == 0 { 1.0_f32.to_bits() } else { 0 })
                        .collect(),
                ),
                placement_pathing_mask_i32: None,
                allowed_terrain_ids: vec![TerrainId(0)],
                blocked_terrain_ids: vec![TerrainId(1), TerrainId(2), TerrainId(3), TerrainId(6)],
            },
            RestrictionDefinition {
                id: RestrictionId(8),
                name: "Independent unrestricted cliff marker".to_owned(),
                traversal_cost_f32_bits: Some(
                    (0..71)
                        .map(|id| {
                            if [0, 1, 2, 3, 6, 10, 16, 27, 70].contains(&id) {
                                1.0_f32.to_bits()
                            } else {
                                0
                            }
                        })
                        .collect(),
                ),
                placement_pathing_mask_i32: None,
                allowed_terrain_ids: [0, 1, 2, 3, 6, 10, 16, 27, 70].map(TerrainId).to_vec(),
                blocked_terrain_ids: Vec::new(),
            },
        ],
        terrain_topology: TerrainTopologyBindings {
            cliff_facet_terrain_id: Some(TerrainId(16)),
            cliff_overlay_terrain_id: Some(TerrainId(70)),
            fill_terrain_id: Some(TerrainId(1)),
            default_shoreline_terrain_id: Some(TerrainId(2)),
            frozen_shoreline_terrain_id: None,
            excluded_shoreline_water_terrain_ids: Vec::new(),
        },
        object_placement_classes: ObjectPlacementClassBindings {
            forest_zone_class_id: Some(10),
            cliff_zone_class_id: Some(80),
        },
        graphics: Vec::new(),
        native_generation_bindings: Some(NativeGenerationBindings {
            default_terrain_id: TerrainId(0),
            flat_only_terrain_id: Some(TerrainId(1)),
            wall_anchor_object_ids: vec![ObjectId(109), ObjectId(444)],
            explicit_maximum_seed_foundation_object_ids: vec![ObjectId(50), ObjectId(1187)],
            classes: NativeClassBindings {
                farm: 49,
                tree: 15,
                wall: 27,
                gate: 39,
                tower: 52,
            },
            construction_site_exemptions: Some(ConstructionSiteExemptions {
                object_ids: vec![ObjectId(357), ObjectId(1188)],
                class_ids: vec![51, 54],
            }),
            player_start_bindings: Some(PlayerStartBindings {
                town_center_object_id: ObjectId(109),
                packed_town_center_object_id: ObjectId(444),
                villager_object_id: ObjectId(83),
                alternate_villager_object_id: ObjectId(293),
                fallback_scout_object_id: ObjectId(448),
                packed_town_center_attribute_id: PlayerAttributeId(82),
                starting_villagers_attribute_id: PlayerAttributeId(84),
                starting_scout_attribute_id: PlayerAttributeId(263),
            }),
            farm_completion_bindings: None,
        }),
    }
}

#[cfg(any(test, feature = "synthetic-dat-fixture"))]
pub fn schema_2_2_reference_content_pack(behavior_profile_id: &str) -> NeutralContentPack {
    let mut pack = exact_reference_content_pack(behavior_profile_id);
    pack.schema_version = NATIVE_BINDINGS_SCHEMA_VERSION.to_owned();
    pack.pack_version = "1.1.0".to_owned();
    pack.objects
        .retain(|object| !matches!(object.id.0, 83 | 293 | 444 | 448));
    pack.civilization_attribute_values.clear();
    pack.civilization_object_attribute_values.clear();
    let bindings = pack
        .native_generation_bindings
        .as_mut()
        .expect("reference bindings");
    bindings.construction_site_exemptions = None;
    bindings.player_start_bindings = None;
    pack
}

pub fn import_neutral_config(
    bytes: &[u8],
    required_behavior_profile_id: &str,
) -> Result<NeutralContentPack, ContentError> {
    if bytes.len() > MAXIMUM_PACK_BYTES {
        return Err(ContentError::ResourceLimit("neutral configuration"));
    }
    let pack = serde_json::from_slice::<NeutralContentPack>(bytes).map_err(ContentError::Parse)?;
    if pack.source.kind != ContentSourceKind::Synthetic {
        return Err(ContentError::InvalidField("source.kind"));
    }
    CompatibleContentView::new(&pack, required_behavior_profile_id)?;
    Ok(pack)
}

pub fn load_canonical_implicit_definitions(
    bytes: &[u8],
) -> Result<BTreeMap<String, i32>, ContentError> {
    if bytes.len() > MAXIMUM_IMPLICIT_DEFINITION_BYTES {
        return Err(ContentError::ResourceLimit(
            "implicit definition environment",
        ));
    }
    let raw =
        serde_json::from_slice::<BTreeMap<String, String>>(bytes).map_err(ContentError::Parse)?;
    if raw.len() > 65_536 {
        return Err(ContentError::ResourceLimit("RMS implicit definitions"));
    }
    let mut definitions = BTreeMap::new();
    for (name, value) in &raw {
        validate_rms_name(name)?;
        let parsed = value
            .parse::<i32>()
            .map_err(|_| ContentError::InvalidField("RMS implicit definition value"))?;
        if &parsed.to_string() != value {
            return Err(ContentError::InvalidField("RMS implicit definition value"));
        }
        definitions.insert(name.clone(), parsed);
    }
    let canonical = serde_json::to_vec_pretty(&raw).map_err(ContentError::Serialize)?;
    if bytes.strip_suffix(b"\n").unwrap_or(bytes) != canonical {
        return Err(ContentError::NonCanonicalOrdering(
            "implicit definition environment",
        ));
    }
    Ok(definitions)
}

pub fn canonical_implicit_definitions_bytes(
    definitions: &BTreeMap<String, i32>,
) -> Result<Vec<u8>, ContentError> {
    let raw = definitions
        .iter()
        .map(|(name, value)| (name.clone(), value.to_string()))
        .collect::<BTreeMap<_, _>>();
    let mut bytes = serde_json::to_vec_pretty(&raw).map_err(ContentError::Serialize)?;
    bytes.push(b'\n');
    if load_canonical_implicit_definitions(&bytes)? != *definitions {
        return Err(ContentError::InvalidField("RMS implicit definition value"));
    }
    Ok(bytes)
}

pub fn packaged_48987_implicit_definitions() -> Result<&'static BTreeMap<String, i32>, ContentError>
{
    use std::sync::OnceLock;

    static DEFINITIONS: OnceLock<Option<BTreeMap<String, i32>>> = OnceLock::new();
    DEFINITIONS
        .get_or_init(|| {
            load_canonical_implicit_definitions(include_bytes!(
                "../data/aoe2de-101.103.48987-implicit-definitions.json"
            ))
            .ok()
        })
        .as_ref()
        .ok_or(ContentError::InvalidField(
            "packaged implicit definition environment",
        ))
}

#[derive(Clone, Copy, Debug)]
pub struct DatImportLimits {
    pub maximum_compressed_bytes: usize,
    pub maximum_decompressed_bytes: usize,
}

impl Default for DatImportLimits {
    fn default() -> Self {
        Self {
            maximum_compressed_bytes: 256 * 1024 * 1024,
            maximum_decompressed_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DatPreflight {
    pub version_header: String,
    pub compressed_size: u64,
    pub decompressed_size: u64,
    pub source_fingerprint: String,
}

pub struct DatLayoutContext<'a> {
    pub preflight: &'a DatPreflight,
    pub product_version_label: Option<&'a str>,
    pub required_behavior_profile_id: &'a str,
}

pub trait Aoe2deDatLayoutReader {
    fn layout_id(&self) -> &'static str;
    fn supports_header(&self, version_header: &str) -> bool;
    fn read_neutral_pack(
        &self,
        decompressed: &[u8],
        context: &DatLayoutContext<'_>,
    ) -> Result<NeutralContentPack, ContentError>;
}

pub fn preflight_aoe2de_dat(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<DatPreflight, ContentError> {
    decode_aoe2de_dat(compressed, limits).map(|(preflight, _)| preflight)
}

pub fn import_aoe2de_dat(
    compressed: &[u8],
    limits: DatImportLimits,
    product_version_label: Option<&str>,
    required_behavior_profile_id: &str,
    reader: &dyn Aoe2deDatLayoutReader,
) -> Result<NeutralContentPack, ContentError> {
    let (preflight, decompressed) = decode_aoe2de_dat(compressed, limits)?;
    if reader.layout_id().is_empty() || !reader.supports_header(&preflight.version_header) {
        return Err(ContentError::UnsupportedLayout(format!(
            "reader {:?} does not support {}",
            reader.layout_id(),
            preflight.version_header
        )));
    }
    let context = DatLayoutContext {
        preflight: &preflight,
        product_version_label,
        required_behavior_profile_id,
    };
    let mut pack = reader.read_neutral_pack(&decompressed, &context)?;
    pack.source = ContentSource {
        kind: ContentSourceKind::Aoe2deDat,
        fingerprint: preflight.source_fingerprint,
        product_version_label: product_version_label.map(str::to_owned),
        dat_version_header: Some(preflight.version_header),
        object_replacement_fingerprint: None,
    };
    CompatibleContentView::new(&pack, required_behavior_profile_id)?;
    Ok(pack)
}

fn decode_aoe2de_dat(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<(DatPreflight, Vec<u8>), ContentError> {
    let (version_header, decompressed) = inflate_aoe2de_dat(compressed, limits)?;
    Ok((
        DatPreflight {
            version_header,
            compressed_size: compressed.len() as u64,
            decompressed_size: decompressed.len() as u64,
            source_fingerprint: hex_sha256(compressed),
        },
        decompressed,
    ))
}

fn read_bounded_growth(
    reader: &mut impl Read,
    maximum_read: usize,
) -> Result<Vec<u8>, ContentError> {
    const CHUNK_BYTES: usize = 64 * 1024;
    let mut output = Vec::new();
    let mut chunk = vec![0_u8; CHUNK_BYTES];
    loop {
        let wanted = CHUNK_BYTES.min(maximum_read - output.len());
        if wanted == 0 {
            return Ok(output);
        }
        let read = match reader.read(&mut chunk[..wanted]) {
            Ok(0) => return Ok(output),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(ContentError::Decompress(error)),
        };
        if output.capacity() - output.len() < read {
            let target = output
                .capacity()
                .saturating_mul(2)
                .max(output.len() + read)
                .max(CHUNK_BYTES)
                .min(maximum_read);
            output
                .try_reserve_exact(target - output.len())
                .map_err(|_| ContentError::ResourceLimit("decompressed DAT stream"))?;
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

fn inflate_aoe2de_dat(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<(String, Vec<u8>), ContentError> {
    if compressed.is_empty() {
        return Err(ContentError::Truncated("empty DAT stream"));
    }
    if compressed.len() > limits.maximum_compressed_bytes {
        return Err(ContentError::ResourceLimit("compressed DAT stream"));
    }
    let mut decoder = DeflateDecoder::new(compressed);
    let maximum_read = limits
        .maximum_decompressed_bytes
        .checked_add(1)
        .ok_or(ContentError::ResourceLimit("decompressed DAT stream"))?;
    let decompressed = read_bounded_growth(&mut decoder, maximum_read)?;
    if decompressed.len() > limits.maximum_decompressed_bytes {
        return Err(ContentError::ResourceLimit("decompressed DAT stream"));
    }
    if decoder.total_in() as usize != compressed.len() {
        return Err(ContentError::TrailingData);
    }
    if decompressed.len() < 8 {
        return Err(ContentError::Truncated("DAT version header"));
    }
    let version_header = std::str::from_utf8(&decompressed[..8])
        .map_err(|_| ContentError::UnsupportedLayout("non-UTF-8 DAT version header".to_owned()))?
        .trim_end_matches('\0')
        .to_owned();
    if parse_supported_dat_header(&version_header).is_none() {
        return Err(ContentError::UnsupportedLayout(format!(
            "unsupported AoE2DE DAT header {version_header:?}"
        )));
    }
    Ok((version_header, decompressed))
}

pub struct ContentPackStore {
    root: PathBuf,
}

impl ContentPackStore {
    pub fn new(local_app_data_root: impl Into<PathBuf>) -> Self {
        Self {
            root: local_app_data_root.into(),
        }
    }

    pub fn publish(&self, pack: &NeutralContentPack) -> Result<PathBuf, ContentError> {
        let bytes = pack.canonical_bytes()?;
        let identity = pack.identity()?;
        let source_directory = self
            .root
            .join("content-packs-v1")
            .join(&identity.source_fingerprint);
        fs::create_dir_all(&source_directory).map_err(ContentError::Storage)?;
        let file_name = format!("{}.json", hex_bytes(&identity.content_hash));
        let target = source_directory.join(file_name);
        ensure_under_root(&self.root, &target)?;
        if target.exists() {
            let existing = fs::read(&target).map_err(ContentError::Storage)?;
            if existing == bytes {
                return Ok(target);
            }
            return Err(ContentError::HashCollision);
        }
        let temporary = source_directory.join(format!(
            ".{}.{}.tmp",
            hex_bytes(&identity.content_hash),
            std::process::id()
        ));
        ensure_under_root(&self.root, &temporary)?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(ContentError::Storage)?;
            file.write_all(&bytes).map_err(ContentError::Storage)?;
            file.sync_all().map_err(ContentError::Storage)?;
            fs::rename(&temporary, &target).map_err(ContentError::Storage)?;
            let published = fs::read(&target).map_err(ContentError::Storage)?;
            if published != bytes {
                return Err(ContentError::TransactionalVerification);
            }
            Ok(target.clone())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn ensure_under_root(root: &Path, target: &Path) -> Result<(), ContentError> {
    let root = absolute_lexical(root)?;
    let target = absolute_lexical(target)?;
    if !target.starts_with(&root) {
        return Err(ContentError::StorageBoundary);
    }
    Ok(())
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, ContentError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(ContentError::Storage)
    }
}

fn require_sorted_unique_by<T, K: Ord>(
    values: &[T],
    field: &'static str,
    key: impl Fn(&T) -> K,
) -> Result<(), ContentError> {
    if !values.windows(2).all(|pair| key(&pair[0]) < key(&pair[1])) {
        return Err(ContentError::NonCanonicalOrdering(field));
    }
    Ok(())
}

fn require_sorted_unique_strings(
    values: &[String],
    field: &'static str,
) -> Result<(), ContentError> {
    if !values.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(ContentError::NonCanonicalOrdering(field));
    }
    Ok(())
}

fn validate_identifier(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ContentError> {
    let mut characters = value.chars();
    if value.len() > maximum
        || !characters
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        || !characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
    {
        return Err(ContentError::InvalidField(field));
    }
    Ok(())
}

fn validate_rms_name(value: &str) -> Result<(), ContentError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(ContentError::InvalidField("RMS name"));
    }
    Ok(())
}

fn validate_name(value: &str) -> Result<(), ContentError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(ContentError::InvalidField("definition name"));
    }
    Ok(())
}

fn validate_semver(value: &str) -> Result<(), ContentError> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || part.parse::<u32>().is_err())
    {
        return Err(ContentError::InvalidField("packVersion"));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_supported_dat_header(value: &str) -> Option<(u32, u32)> {
    let (major, minor) = value.strip_prefix("VER ")?.split_once('.')?;
    let parsed = (major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?);
    (parsed.0 == 7 && parsed.1 >= 1 || parsed.0 == 8 && parsed.1 <= 9).then_some(parsed)
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[derive(Debug, Error)]
pub enum ContentError {
    #[error("unsupported content schema version {0}")]
    UnsupportedSchema(String),
    #[error("content field {0} is invalid")]
    InvalidField(&'static str),
    #[error("content field {0} is not in canonical sorted order")]
    NonCanonicalOrdering(&'static str),
    #[error("content reference is unresolved: {0}")]
    DanglingReference(&'static str),
    #[error("content pack is incompatible with behavior profile {0}")]
    IncompatibleProfile(String),
    #[error("resource limit exceeded for {0}")]
    ResourceLimit(&'static str),
    #[error("input is truncated: {0}")]
    Truncated(&'static str),
    #[error("DAT stream contains trailing compressed data")]
    TrailingData,
    #[error("unsupported DAT layout: {0}")]
    UnsupportedLayout(String),
    #[error("DAT decompression failed: {0}")]
    Decompress(std::io::Error),
    #[error("content pack canonicalization failed: {0}")]
    Serialize(serde_json::Error),
    #[error("neutral content configuration is invalid: {0}")]
    Parse(serde_json::Error),
    #[error("content pack storage failed: {0}")]
    Storage(std::io::Error),
    #[error("content pack storage path escaped LocalAppData")]
    StorageBoundary,
    #[error("content hash collision detected")]
    HashCollision,
    #[error("published content pack failed read-back verification")]
    TransactionalVerification,
}
