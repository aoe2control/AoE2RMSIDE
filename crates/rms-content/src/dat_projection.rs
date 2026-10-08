use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::dat::{DatDocument, DatMaster, DatResourceStorage};
use crate::native_bindings::NativeContentBindings;
use crate::{
    BUILDING_CONSTRUCTOR_TYPE, CivilizationId, CliffDefinition, CliffPieceRule, CliffPieceVariant,
    ContentError, GraphicDefinition, ObjectAttachment, ObjectBuildingConstruction,
    ObjectCreationRng, ObjectDefinition, ObjectFoundation, ObjectGraphicReplacementFacet,
    ObjectGraphicReplacementVariant, ObjectId, ObjectMovementSpeedVariant, ObjectNeighborFacing,
    ObjectNeighborFallback, ObjectPathing, ObjectPlacementCollision, ObjectPlacementFamily,
    ObjectPlacementGeometry, ObjectPlacementRuleVariant, ObjectPlacementRules,
    ObjectPositionFamily, ObjectResourceSlot, ObjectResourceSlotVariant, ObjectRestrictionVariant,
    ObstructionKind, ResourceDefinition, ResourceId, RestrictionDefinition, RestrictionId,
    TerrainAppearanceDefinition, TerrainAppearancePlacement, TerrainDefinition, TerrainId,
    TerrainLayerClass,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectExclusionReason {
    SourceAbsent,
    AbsentFromGaiaTable,
    ClassSentinel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectSlotAccount {
    pub object_id: ObjectId,
    pub reason: ObjectExclusionReason,
}

pub(crate) struct DatProjection {
    pub(crate) terrains: Vec<TerrainDefinition>,
    pub(crate) objects: Vec<ObjectDefinition>,
    pub(crate) restrictions: Vec<RestrictionDefinition>,
    pub(crate) resources: Vec<ResourceDefinition>,
    pub(crate) resource_slot_variants: Vec<ObjectResourceSlotVariant>,
    pub(crate) movement_speed_variants: Vec<ObjectMovementSpeedVariant>,
    pub(crate) cliffs: Vec<CliffDefinition>,
    pub(crate) graphics: Vec<GraphicDefinition>,
    pub(crate) excluded_objects: Vec<ObjectSlotAccount>,
    pub(crate) civilization_count: usize,
    pub(crate) terrain_slot_count: usize,
    pub(crate) object_slot_count: usize,
}

fn invalid(field: &'static str) -> ContentError {
    ContentError::InvalidField(field)
}

fn finite_bits(bits: u32, field: &'static str) -> Result<u32, ContentError> {
    if f32::from_bits(bits).is_finite() {
        Ok(bits)
    } else {
        Err(invalid(field))
    }
}

fn nonnegative_bits(bits: u32, field: &'static str) -> Result<u32, ContentError> {
    let value = f32::from_bits(finite_bits(bits, field)?);
    if value.is_sign_negative() {
        Err(invalid(field))
    } else {
        Ok(bits)
    }
}

struct SlotMasters<'a> {
    owners: Vec<(CivilizationId, &'a DatMaster)>,
}

impl<'a> SlotMasters<'a> {
    fn gaia(&self) -> &'a DatMaster {
        self.owners[0].1
    }

    fn grouped<T: Clone + Ord>(
        &self,
        value: impl Fn(&DatMaster) -> T,
    ) -> Vec<(Vec<CivilizationId>, T)> {
        let mut groups: BTreeMap<T, Vec<CivilizationId>> = BTreeMap::new();
        for (civilization, master) in &self.owners {
            groups.entry(value(master)).or_default().push(*civilization);
        }
        let mut groups = groups
            .into_iter()
            .map(|(value, civilizations)| (civilizations, value))
            .collect::<Vec<_>>();
        groups.sort_by_key(|(civilizations, _)| civilizations[0]);
        groups
    }

    fn uniform<T: Eq>(
        &self,
        field: &'static str,
        value: impl Fn(&DatMaster) -> T,
    ) -> Result<T, ContentError> {
        let expected = value(self.gaia());
        if self
            .owners
            .iter()
            .all(|(_, master)| value(master) == expected)
        {
            Ok(expected)
        } else {
            Err(ContentError::UnsupportedLayout(format!(
                "owner-varying {field} has no neutral representation"
            )))
        }
    }
}

pub(crate) fn project(
    document: &DatDocument,
    bindings: &NativeContentBindings,
) -> Result<DatProjection, ContentError> {
    let civilization_count = document.civilizations.len();
    let object_slot_count = document.civilizations[0].masters.len();
    if document
        .civilizations
        .iter()
        .any(|civilization| civilization.masters.len() != object_slot_count)
    {
        return Err(ContentError::UnsupportedLayout(
            "owner tables have different object slot counts".to_owned(),
        ));
    }
    let terrain_count = document.terrains.len();
    let restrictions = project_restrictions(document, bindings)?;
    let terrains = project_terrains(document, bindings, &restrictions)?;
    let graphics = project_graphics(document)?;
    let mut objects = Vec::new();
    let mut excluded_objects = Vec::new();
    let mut resource_slot_variants = Vec::new();
    let mut movement_speed_variants = Vec::new();
    for slot in 0..object_slot_count {
        let object_id = ObjectId(u32::try_from(slot).map_err(|_| invalid("object slot"))?);
        let owners = document
            .civilizations
            .iter()
            .enumerate()
            .filter_map(|(civilization, table)| {
                table.masters[slot]
                    .as_deref()
                    .filter(|master| master.class != -1)
                    .map(|master| (CivilizationId(civilization as u32), master))
            })
            .collect::<Vec<_>>();
        let gaia_master = document.civilizations[0].masters[slot].as_ref();
        let reason = if document
            .civilizations
            .iter()
            .all(|table| table.masters[slot].is_none())
        {
            Some(ObjectExclusionReason::SourceAbsent)
        } else if gaia_master.is_none() {
            Some(ObjectExclusionReason::AbsentFromGaiaTable)
        } else if gaia_master.is_some_and(|master| master.class == -1) {
            Some(ObjectExclusionReason::ClassSentinel)
        } else {
            None
        };
        if let Some(reason) = reason {
            excluded_objects.push(ObjectSlotAccount { object_id, reason });
            continue;
        }
        let masters = SlotMasters { owners };
        let object = project_object(
            object_id,
            &masters,
            document,
            bindings,
            &graphics,
            terrain_count,
            &mut resource_slot_variants,
            &mut movement_speed_variants,
        )?;
        objects.push(object);
    }
    resolve_object_references(&mut objects)?;
    let resources = project_resources(&objects, &resource_slot_variants);
    let cliffs = project_cliffs(bindings, &objects)?;
    Ok(DatProjection {
        terrains,
        objects,
        restrictions,
        resources,
        resource_slot_variants,
        movement_speed_variants,
        cliffs,
        graphics,
        excluded_objects,
        civilization_count,
        terrain_slot_count: terrain_count,
        object_slot_count,
    })
}

fn placement_pathing_mask(
    row: &[u32],
    document: &DatDocument,
    bindings: &NativeContentBindings,
) -> i32 {
    let mut raw = 0_u32;
    for (bit, mask) in bindings
        .restriction_classification_class_masks
        .iter()
        .enumerate()
    {
        let present = row.iter().enumerate().any(|(terrain, &bits)| {
            f32::from_bits(bits) > 0.0
                && document
                    .terrains
                    .get(terrain)
                    .is_some_and(|terrain| terrain.placement_class & mask != 0)
        });
        if present {
            raw |= 1 << bit;
        }
    }
    (((!raw) & 0xff) | 0x4000) as i32
}

fn project_restrictions(
    document: &DatDocument,
    bindings: &NativeContentBindings,
) -> Result<Vec<RestrictionDefinition>, ContentError> {
    document
        .restrictions
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut allowed = Vec::new();
            let mut blocked = Vec::new();
            for terrain in 0..document.terrains.len() {
                let permitted = row
                    .multiplier_bits
                    .get(terrain)
                    .is_some_and(|&bits| f32::from_bits(bits) > 0.0);
                let id = TerrainId(terrain as u32);
                if permitted {
                    allowed.push(id);
                } else {
                    blocked.push(id);
                }
            }
            Ok(RestrictionDefinition {
                id: RestrictionId(index as u32),
                name: format!("Restriction {index}"),
                allowed_terrain_ids: allowed,
                blocked_terrain_ids: blocked,
                traversal_cost_f32_bits: Some(row.multiplier_bits.clone()),
                placement_pathing_mask_i32: Some(placement_pathing_mask(
                    &row.multiplier_bits,
                    document,
                    bindings,
                )),
            })
        })
        .collect()
}

fn restriction_permits(
    restrictions: &[RestrictionDefinition],
    restriction: u32,
    terrain: usize,
) -> Result<bool, ContentError> {
    let row = restrictions
        .get(restriction as usize)
        .ok_or(invalid("terrain-class restriction"))?;
    Ok(row
        .traversal_cost_f32_bits
        .as_ref()
        .and_then(|costs| costs.get(terrain))
        .is_some_and(|&bits| f32::from_bits(bits) > 0.0))
}

fn project_terrains(
    document: &DatDocument,
    bindings: &NativeContentBindings,
    restrictions: &[RestrictionDefinition],
) -> Result<Vec<TerrainDefinition>, ContentError> {
    let classes = &bindings.terrain_class_restrictions;
    let object_slots = document.civilizations[0].masters.len();
    document
        .terrains
        .iter()
        .enumerate()
        .map(|(index, terrain)| {
            let land = restriction_permits(restrictions, classes.land, index)?;
            let water = restriction_permits(restrictions, classes.water, index)?;
            let buildable = restriction_permits(restrictions, classes.buildable, index)?;
            let layer_class = match (land, water) {
                (true, true) => TerrainLayerClass::Beach,
                (false, true) => TerrainLayerClass::Water,
                (true, false) => TerrainLayerClass::Land,
                (false, false) => TerrainLayerClass::Overlay,
            };
            let active = usize::try_from(terrain.active_appearances)
                .ok()
                .filter(|count| *count <= terrain.appearances.len())
                .ok_or(invalid("terrain appearance count"))?;
            let appearances = terrain.appearances[..active]
                .iter()
                .map(|appearance| {
                    let slot = usize::try_from(appearance.object_id)
                        .ok()
                        .filter(|slot| *slot < object_slots)
                        .ok_or(invalid("terrain appearance object"))?;
                    let weight = u16::try_from(appearance.density)
                        .ok()
                        .filter(|weight| *weight <= 1000)
                        .ok_or(invalid("terrain appearance density"))?;
                    let placement = match appearance.centering {
                        0 => TerrainAppearancePlacement::Randomized,
                        1 => TerrainAppearancePlacement::Centered,
                        _ => return Err(invalid("terrain appearance centering")),
                    };
                    let master = document.civilizations[0].masters[slot]
                        .as_ref()
                        .ok_or(invalid("terrain appearance master"))?;
                    Ok(TerrainAppearanceDefinition {
                        placement,
                        weight_per_thousand: weight,
                        object_id: Some(ObjectId(slot as u32)),
                        placement_restriction_id: u32::try_from(master.restriction)
                            .ok()
                            .map(RestrictionId),
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(TerrainDefinition {
                id: TerrainId(index as u32),
                name: format!("Terrain {index}"),
                rms_names: Vec::new(),
                layer_class,
                placement_class: terrain.placement_class,
                passable: land || water,
                buildable,
                appearances,
            })
        })
        .collect()
}

fn position_family(kind: u8) -> Result<ObjectPositionFamily, ContentError> {
    match kind {
        10 | 15 | 20 | 25 => Ok(ObjectPositionFamily::Base),
        30 | 40 => Ok(ObjectPositionFamily::Moving),
        50 | 60 | 70 => Ok(ObjectPositionFamily::Combat),
        80 => Ok(ObjectPositionFamily::Building),
        _ => Err(ContentError::UnsupportedLayout(format!(
            "object type {kind} has no reviewed constructor family"
        ))),
    }
}

fn placement_family(kind: u8) -> Result<ObjectPlacementFamily, ContentError> {
    match kind {
        70 => Ok(ObjectPlacementFamily::Collision),
        80 => Ok(ObjectPlacementFamily::Occupancy),
        10 | 15 | 20 | 25 | 30 | 40 | 50 | 60 => Ok(ObjectPlacementFamily::Terrain),
        _ => Err(ContentError::UnsupportedLayout(format!(
            "object type {kind} has no reviewed placement family"
        ))),
    }
}

fn footprint_256(half_extent_bits: u32) -> Result<u16, ContentError> {
    let value = f32::from_bits(nonnegative_bits(
        half_extent_bits,
        "object collision extent",
    )?);
    let scaled = (value * 512.0 + 0.5).floor();
    if scaled > f32::from(u16::MAX) {
        return Err(invalid("object footprint"));
    }
    Ok(scaled as u16)
}

pub(crate) fn project_graphics(
    document: &DatDocument,
) -> Result<Vec<GraphicDefinition>, ContentError> {
    document
        .graphics
        .iter()
        .enumerate()
        .filter_map(|(index, graphic)| graphic.as_ref().map(|graphic| (index, graphic)))
        .map(|(index, graphic)| {
            Ok(GraphicDefinition {
                id: i16::try_from(index).map_err(|_| invalid("graphic identity"))?,
                angle_count: graphic.angle_count,
                random_facet: graphic.sequence_flags & 0x04 != 0,
                random_angle: graphic.sequence_flags & 0x02 != 0,
            })
        })
        .collect()
}

fn creation_rng(
    master: &DatMaster,
    graphics: &[GraphicDefinition],
) -> Result<ObjectCreationRng, ContentError> {
    let graphic = match master.standing_graphics[0] {
        graphic if graphic < 0 => None,
        graphic => Some(
            graphics
                .binary_search_by_key(&graphic, |definition| definition.id)
                .map(|index| &graphics[index])
                .map_err(|_| invalid("object standing graphic"))?,
        ),
    };
    Ok(ObjectCreationRng::for_constructor(master.kind, graphic))
}

fn resource_slots(master: &DatMaster) -> Result<[ObjectResourceSlot; 3], ContentError> {
    let slot = |storage: DatResourceStorage| -> Result<ObjectResourceSlot, ContentError> {
        Ok(ObjectResourceSlot {
            resource_type: storage.resource_type,
            quantity_f32_bits: finite_bits(storage.quantity_bits, "object resource quantity")?,
            mode: storage.mode,
        })
    };
    Ok([
        slot(master.resources[0])?,
        slot(master.resources[1])?,
        slot(master.resources[2])?,
    ])
}

#[allow(clippy::too_many_arguments)]
fn project_object(
    object_id: ObjectId,
    masters: &SlotMasters<'_>,
    document: &DatDocument,
    bindings: &NativeContentBindings,
    graphics: &[GraphicDefinition],
    terrain_count: usize,
    resource_slot_variants: &mut Vec<ObjectResourceSlotVariant>,
    movement_speed_variants: &mut Vec<ObjectMovementSpeedVariant>,
) -> Result<ObjectDefinition, ContentError> {
    let gaia = masters.gaia();
    let kind = masters.uniform("object type", |master| master.kind)?;
    let class = masters.uniform("object class", |master| master.class)?;
    let class_id = u32::try_from(class).map_err(|_| invalid("object class"))?;
    let collision = masters.uniform("collision extents", |master| master.collision_bits)?;
    let clearance = masters.uniform("clearance extents", |master| master.clearance_bits)?;
    let outline = masters.uniform("outline extents", |master| master.outline_bits)?;
    let obstruction_type = masters.uniform("obstruction", |master| master.obstruction_type)?;
    let obstruction_class =
        masters.uniform("obstruction class", |master| master.obstruction_class)?;
    let hit_points = masters.uniform("hit points", |master| master.hit_points)?;
    let can_be_built_on = masters.uniform("build-on selector", |master| master.can_be_built_on)?;
    let side = masters.uniform("side terrains", |master| master.placement_side_terrains)?;
    let center = masters.uniform("center terrains", |master| master.placement_terrains)?;
    let terrain_list = |pair: [i16; 2]| -> Result<Vec<TerrainId>, ContentError> {
        pair.into_iter()
            .filter(|terrain| *terrain >= 0)
            .map(|terrain| {
                let terrain = terrain as usize;
                if terrain < terrain_count {
                    Ok(TerrainId(terrain as u32))
                } else {
                    Err(invalid("object placement terrain"))
                }
            })
            .collect()
    };
    let footprint_width_256 = footprint_256(collision[0])?;
    let footprint_height_256 = footprint_256(collision[1])?;
    let placement_geometry = ObjectPlacementGeometry {
        collision_half_width_f32_bits: nonnegative_bits(collision[0], "object collision extent")?,
        collision_half_height_f32_bits: nonnegative_bits(collision[1], "object collision extent")?,
        placement_half_width_f32_bits: nonnegative_bits(clearance[0], "object clearance extent")?,
        placement_half_height_f32_bits: nonnegative_bits(clearance[1], "object clearance extent")?,
    };
    let family = placement_family(kind)?;
    let slope_groups = masters.grouped(|master| master.slope_mode);
    let (placement_rules, placement_rule_variants) = if slope_groups.len() == 1 {
        (
            Some(ObjectPlacementRules {
                family,
                slope_mode: slope_groups[0].1,
            }),
            Vec::new(),
        )
    } else {
        (
            None,
            slope_groups
                .into_iter()
                .map(
                    |(civilization_ids, slope_mode)| ObjectPlacementRuleVariant {
                        civilization_ids,
                        rules: ObjectPlacementRules { family, slope_mode },
                    },
                )
                .collect(),
        )
    };
    let restriction_groups = masters.grouped(|master| master.restriction);
    let restriction = |value: i16| -> Result<Option<RestrictionId>, ContentError> {
        match value {
            -1 => Ok(None),
            value if value >= 0 && (value as usize) < document.restrictions.len() => {
                Ok(Some(RestrictionId(value as u32)))
            }
            _ => Err(invalid("object restriction")),
        }
    };
    let (restriction_id, restriction_variants) = if restriction_groups.len() == 1 {
        (restriction(restriction_groups[0].1)?, Vec::new())
    } else {
        (
            None,
            restriction_groups
                .into_iter()
                .map(|(civilization_ids, value)| {
                    Ok(ObjectRestrictionVariant {
                        civilization_ids,
                        restriction_id: restriction(value)?,
                    })
                })
                .collect::<Result<Vec<_>, ContentError>>()?,
        )
    };
    let speed_groups = masters.grouped(|master| master.speed_bits);
    let movement_speed_f32_bits = if speed_groups.len() == 1 {
        speed_groups[0]
            .1
            .map(|bits| finite_bits(bits, "object movement speed"))
            .transpose()?
    } else {
        for (civilization_ids, bits) in speed_groups {
            let bits = bits.ok_or(invalid("object movement speed"))?;
            movement_speed_variants.push(ObjectMovementSpeedVariant {
                object_id,
                civilization_ids,
                speed_f32_bits: finite_bits(bits, "object movement speed")?,
            });
        }
        None
    };
    let resource_groups = masters.grouped(|master| {
        master
            .resources
            .map(|storage| (storage.resource_type, storage.quantity_bits, storage.mode))
    });
    let resource_slots = if resource_groups.len() == 1 {
        Some(resource_slots(gaia)?)
    } else {
        for (civilization_ids, _) in resource_groups {
            let owner = masters
                .owners
                .iter()
                .find(|(civilization, _)| *civilization == civilization_ids[0])
                .map(|(_, master)| *master)
                .ok_or(invalid("object resource owner"))?;
            resource_slot_variants.push(ObjectResourceSlotVariant {
                object_id,
                civilization_ids,
                resource_slots: resource_slots(owner)?,
            });
        }
        None
    };
    let position_family = position_family(kind)?;
    let speed_value = gaia.speed_bits.map(f32::from_bits);
    let occupancy_uses_movement_speed = kind >= 30
        && gaia
            .speed_bits
            .is_some_and(|bits| f32::from_bits(bits).is_finite());
    let edge_margin_256 = edge_margin(position_family, speed_value, collision)?;
    let pathing_action = match obstruction_type {
        4 | 6 | 7 | 8 | 9 => 0,
        action @ (0 | 1 | 2 | 3 | 5 | 10 | 11 | 12 | 13) => action,
        _ => return Err(invalid("object pathing action")),
    };
    let obstruction =
        if obstruction_type == 0 || (footprint_width_256 == 0 && footprint_height_256 == 0) {
            ObstructionKind::None
        } else {
            ObstructionKind::Circle
        };
    let placement_collision = if collision[2] == 0 && kind != 80 {
        ObjectPlacementCollision::None
    } else {
        ObjectPlacementCollision::Footprint
    };
    let building = gaia.building.as_ref();
    let standing_graphic_id = (gaia.standing_graphics[0] >= 0).then_some(gaia.standing_graphics[0]);
    let data_status = match usize::try_from(gaia.standing_graphics[0]) {
        Ok(graphic) => document
            .graphics
            .get(graphic)
            .and_then(Option::as_ref)
            .map(|graphic| i16::try_from(graphic.frame_count))
            .ok_or(invalid("object standing graphic"))?
            .map_err(|_| invalid("object data status"))?,
        Err(_) => 0,
    };
    let foundation = masters
        .uniform("foundation terrain", |master| {
            master
                .building
                .as_ref()
                .map(|building| building.foundation_terrain_id)
        })?
        .filter(|terrain| *terrain >= 0)
        .map(|terrain| {
            let terrain = terrain as usize;
            if terrain >= terrain_count {
                return Err(invalid("object foundation terrain"));
            }
            Ok(ObjectFoundation {
                terrain_id: TerrainId(terrain as u32),
                omitted_cells: bindings.foundation_omitted_cells(object_id),
            })
        })
        .transpose()?;
    let classes = bindings.native_generation_bindings.classes;
    let neighbor_facing = building.map(|building| ObjectNeighborFacing {
        updates_neighbors: building.adjacent_mode != 0,
        has_graphic: gaia.standing_graphics[0] >= 0,
        preserve_facet: class_id == classes.gate,
        fallback: if class_id == classes.wall {
            Some(ObjectNeighborFallback::Class {
                class_id: classes.gate,
            })
        } else if class_id == classes.gate {
            Some(ObjectNeighborFallback::Class {
                class_id: classes.wall,
            })
        } else {
            None
        },
        linked_object_id: u32::try_from(building.stack_unit_id).ok().map(ObjectId),
        accepts_linked_neighbor: false,
    });
    let class39_pathing_gate = (class_id == classes.gate)
        .then(|| kind == 80 && building.is_some_and(|building| building.head_unit_id >= 0));
    let construction_attachments = building
        .map(|building| {
            building
                .annexes
                .iter()
                .filter(|annex| annex.object_id != -1)
                .map(|annex| {
                    Ok(ObjectAttachment {
                        object_id: ObjectId(
                            u32::try_from(annex.object_id).map_err(|_| invalid("object annex"))?,
                        ),
                        x_offset_f32_bits: finite_bits(annex.x_offset_bits, "object annex offset")?,
                        y_offset_f32_bits: finite_bits(annex.y_offset_bits, "object annex offset")?,
                    })
                })
                .collect::<Result<Vec<_>, ContentError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let graphic_replacement_variants = graphic_replacements(kind, masters);
    let initializes_restriction_zones =
        bindings.initializes_restriction_zones(object_id, kind, class_id);
    Ok(ObjectDefinition {
        id: object_id,
        name: format!("Object {}", object_id.0),
        rms_names: Vec::new(),
        class_id,
        available_civilizations: Some(
            masters
                .owners
                .iter()
                .map(|(civilization, _)| *civilization)
                .collect(),
        ),
        footprint_width_256,
        footprint_height_256,
        placement_geometry: Some(placement_geometry),
        placement_rules,
        placement_rule_variants,
        pathing: Some(ObjectPathing {
            action: pathing_action,
            kind: obstruction_class,
            vertical_extent_f32_bits: nonnegative_bits(collision[2], "object vertical extent")?,
            outline_half_width_f32_bits: nonnegative_bits(outline[0], "object outline extent")?,
            outline_half_height_f32_bits: nonnegative_bits(outline[1], "object outline extent")?,
        }),
        class39_pathing_gate,
        position_family: Some(position_family),
        occupancy_uses_movement_speed: Some(occupancy_uses_movement_speed),
        movement_speed_f32_bits,
        edge_margin_256,
        obstruction,
        can_be_built_on: can_be_built_on != 0,
        construction_retirement_requires_height: bindings
            .construction_retirement_requires_height
            .contains(&object_id),
        hit_points: Some(hit_points),
        placement_collision,
        placement_side_terrain_ids: terrain_list(side)?,
        placement_center_terrain_ids: terrain_list(center)?,
        initial_lifecycle_state: 2,
        restriction_id,
        restriction_variants,
        initializes_restriction_zones,
        resource_slots,
        initial_resource_override: bindings.constructor_resource_override(class_id),
        data_status,
        creation_rng: creation_rng(gaia, graphics)?,
        constructor_type: Some(kind),
        standing_graphic_id,
        standing_graphic_creation_variants: Vec::new(),
        graphic_replacement_variants,
        construction_attachments,
        neighbor_facing,
        single_request_count: bindings.single_request_count(object_id),
        disappears_when_built: masters.uniform("disappears when built", |master| {
            master
                .building
                .as_ref()
                .is_some_and(|building| building.disappears_when_built != 0)
        })?,
        building_construction: (kind == BUILDING_CONSTRUCTOR_TYPE)
            .then(|| {
                masters.uniform("building construction", |master| {
                    building_construction(master)
                })
            })
            .transpose()?,
        foundation,
    })
}

fn building_construction(master: &DatMaster) -> ObjectBuildingConstruction {
    ObjectBuildingConstruction {
        positive_build_time: master
            .train_locations
            .first()
            .is_some_and(|location| location.build_time > 0),
        head_unit: master
            .building
            .as_ref()
            .is_some_and(|building| building.head_unit_id != -1),
    }
}

fn edge_margin(
    family: ObjectPositionFamily,
    speed: Option<f32>,
    collision: [u32; 3],
) -> Result<u8, ContentError> {
    let threshold = f32::from_bits(0x33d6_bf95);
    if !matches!(
        family,
        ObjectPositionFamily::Moving | ObjectPositionFamily::Combat
    ) || speed.is_none_or(|speed| speed <= threshold)
    {
        return Ok(0);
    }
    let margin = |bits: u32| -> i64 {
        let half = f32::from_bits(bits);
        let clamped = ((half + 0.01_f32) * 256.0).ceil() as i64;
        let footprint = (half * 512.0 + 0.5).floor() as i64;
        clamped - (footprint + 1) / 2
    };
    let [width, height] = [margin(collision[0]), margin(collision[1])];
    if width != height {
        return Err(ContentError::UnsupportedLayout(
            "object edge margin differs by axis".to_owned(),
        ));
    }
    u8::try_from(width.max(0)).map_err(|_| invalid("object edge margin"))
}

fn graphic_replacements(
    kind: u8,
    masters: &SlotMasters<'_>,
) -> Vec<ObjectGraphicReplacementVariant> {
    let gaia_graphic = masters.gaia().standing_graphics[0];
    if !matches!(kind, 10 | 20) || gaia_graphic < 0 {
        return Vec::new();
    }
    let civilization_ids = masters
        .owners
        .iter()
        .filter(|(civilization, master)| {
            civilization.0 != 0
                && master.standing_graphics[0] >= 0
                && master.standing_graphics[0] != gaia_graphic
        })
        .map(|(civilization, _)| *civilization)
        .collect::<Vec<_>>();
    if civilization_ids.is_empty() {
        Vec::new()
    } else {
        vec![ObjectGraphicReplacementVariant {
            civilization_ids,
            facet: ObjectGraphicReplacementFacet::ResetZero,
        }]
    }
}

fn resolve_object_references(objects: &mut [ObjectDefinition]) -> Result<(), ContentError> {
    let emitted = objects
        .iter()
        .map(|object| object.id)
        .collect::<BTreeSet<_>>();
    for object in objects.iter_mut() {
        object
            .construction_attachments
            .retain(|child| emitted.contains(&child.object_id));
        if let Some(facing) = &mut object.neighbor_facing
            && facing
                .linked_object_id
                .is_some_and(|linked| !emitted.contains(&linked))
        {
            return Err(ContentError::DanglingReference("object neighbor link"));
        }
    }
    Ok(())
}

fn project_resources(
    objects: &[ObjectDefinition],
    variants: &[ObjectResourceSlotVariant],
) -> Vec<ResourceDefinition> {
    let mut identities = BTreeSet::new();
    let slots = objects
        .iter()
        .filter_map(|object| object.resource_slots.as_ref())
        .chain(variants.iter().map(|variant| &variant.resource_slots));
    for slot in slots.flatten() {
        if slot.resource_type >= 0 {
            identities.insert(slot.resource_type as u32);
        }
    }
    identities.extend(
        objects
            .iter()
            .filter_map(|object| object.initial_resource_override)
            .filter(|state| state.resource_type >= 0)
            .map(|state| state.resource_type as u32),
    );
    identities
        .into_iter()
        .map(|id| ResourceDefinition {
            id: ResourceId(id),
            name: format!("Resource {id}"),
        })
        .collect()
}

fn project_cliffs(
    bindings: &NativeContentBindings,
    objects: &[ObjectDefinition],
) -> Result<Vec<CliffDefinition>, ContentError> {
    let emitted = objects
        .iter()
        .map(|object| object.id)
        .collect::<BTreeSet<_>>();
    let cliff = &bindings.cliffs;
    cliff
        .style_base_object_ids
        .iter()
        .enumerate()
        .map(|(cliff_type, base)| {
            let object = |slot: u16| -> Result<ObjectId, ContentError> {
                let id = ObjectId(base.0 + u32::from(slot));
                if emitted.contains(&id) {
                    Ok(id)
                } else {
                    Err(ContentError::DanglingReference("cliff piece master"))
                }
            };
            let mut piece_rules = cliff
                .piece_rules
                .iter()
                .map(|rule| {
                    Ok(CliffPieceRule {
                        edges: rule.edges,
                        primary: CliffPieceVariant {
                            object_id: object(rule.primary.slot)?,
                            facet: rule.primary.facet,
                        },
                        alternate: rule
                            .alternate
                            .map(|variant| {
                                Ok::<_, ContentError>(CliffPieceVariant {
                                    object_id: object(variant.slot)?,
                                    facet: variant.facet,
                                })
                            })
                            .transpose()?,
                        x_offset_256: rule.x_offset_256,
                        y_offset_256: rule.y_offset_256,
                    })
                })
                .collect::<Result<Vec<_>, ContentError>>()?;
            piece_rules.sort_by_key(|rule| rule.edges);
            Ok(CliffDefinition {
                cliff_type: cliff_type as u32,
                terrain_id: cliff.terrain_id,
                piece_rules,
            })
        })
        .collect()
}
