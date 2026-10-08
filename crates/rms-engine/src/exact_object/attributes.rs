use super::*;

const BUILDING_CONSTRUCTOR_TYPE: u8 = 80;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ObjectRuntimeAttributes {
    pub(super) owner_civilizations: [Option<CivilizationId>; 9],
    pub(super) gaia_preset_facets: std::collections::BTreeMap<ObjectId, u8>,
    restriction_ids: std::collections::BTreeMap<ObjectId, Option<RestrictionId>>,
    pub(super) gaia_restriction_ids: std::collections::BTreeMap<ObjectId, Option<RestrictionId>>,
    master_restriction_ids: std::collections::BTreeMap<ObjectId, Option<RestrictionId>>,
    master_gaia_restriction_ids: std::collections::BTreeMap<ObjectId, Option<RestrictionId>>,
    hit_points: std::collections::BTreeMap<ObjectId, HitPointMutation>,
    gaia_hit_points: std::collections::BTreeMap<ObjectId, HitPointMutation>,
    standing_graphic_ids: std::collections::BTreeMap<ObjectId, i16>,
    gaia_standing_graphic_ids: std::collections::BTreeMap<ObjectId, i16>,
    upgrade_targets: std::collections::BTreeMap<ObjectId, ObjectId>,
    pub(super) gaia_upgrade_targets: std::collections::BTreeMap<ObjectId, ObjectId>,
    pub(super) modified_masters: std::collections::BTreeMap<(ObjectId, bool), ObjectDefinition>,
    modified_owner_speeds: std::collections::BTreeMap<(ObjectId, CivilizationId), u32>,
    foundation_terrain_values: std::collections::BTreeMap<(ObjectId, bool), i16>,
    player_resource_writes: Vec<PlayerResourceWrite>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct PlayerResourceWrite {
    pub(super) gaia_only: bool,
    pub(super) resource: u32,
    pub(super) mutation: Option<AttributeMutation>,
    pub(super) value_f32_bits: u32,
}

impl PlayerResourceWrite {
    fn reaches(&self, owner: u8) -> bool {
        !self.gaia_only || owner == 0
    }

    fn apply(&self, current: f32) -> f32 {
        let operand = f32::from_bits(self.value_f32_bits);
        match self.mutation {
            Some(AttributeMutation::Set) => operand,
            Some(AttributeMutation::Add) => current + operand,
            Some(AttributeMutation::Multiply) => current * operand,
            None => current,
        }
    }

    fn keeps(&self, current: f32) -> bool {
        let operand = f32::from_bits(self.value_f32_bits);
        match self.mutation {
            Some(AttributeMutation::Set) => operand == current,
            Some(AttributeMutation::Add) => operand == 0.0,
            Some(AttributeMutation::Multiply) => operand == 1.0,
            None => false,
        }
    }
}

pub(super) fn truncate_f32_to_i32(value: f32) -> i32 {
    if value.is_nan() || !(-2_147_483_648.0..2_147_483_648.0).contains(&value) {
        i32::MIN
    } else {
        value as i32
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ResourceRuleSwitch {
    StartingVillagers,
    LiveReplacementResources,
}

#[cfg(any(test, feature = "placement-oracle"))]
pub(super) fn resource_rule_disabled(switch: ResourceRuleSwitch) -> bool {
    std::env::var_os(match switch {
        ResourceRuleSwitch::StartingVillagers => "RMSIDE_TEST_DISABLE_VILLAGER_RESOURCE_RULE",
        ResourceRuleSwitch::LiveReplacementResources => {
            "RMSIDE_TEST_DISABLE_LIVE_REPLACEMENT_RESOURCE_RULE"
        }
    })
    .is_some()
}

#[cfg(not(any(test, feature = "placement-oracle")))]
pub(super) fn resource_rule_disabled(_switch: ResourceRuleSwitch) -> bool {
    false
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AttributeMutation {
    Set,
    Add,
    Multiply,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HitPointMutation {
    Set(u16),
    Add(u16),
}

impl HitPointMutation {
    fn add(self, amount: u16) -> Self {
        match self {
            Self::Set(value) => Self::Set(value.wrapping_add(amount)),
            Self::Add(value) => Self::Add(value.wrapping_add(amount)),
        }
    }

    fn apply(self, base: u16) -> u16 {
        match self {
            Self::Set(value) => value,
            Self::Add(value) => base.wrapping_add(value),
        }
    }
}

impl ObjectRuntimeAttributes {
    pub(super) fn record_player_resource_write(&mut self, write: PlayerResourceWrite) {
        self.player_resource_writes.push(write);
    }

    pub(super) fn effective_player_resource(&self, owner: u8, resource: u32, initial: f32) -> f32 {
        self.player_resource_writes
            .iter()
            .filter(|write| write.resource == resource && write.reaches(owner))
            .fold(initial, |value, write| write.apply(value))
    }

    pub(super) fn replacement_input_may_change(
        &self,
        owner: u8,
        resource: u32,
        current: f32,
    ) -> bool {
        self.player_resource_writes.iter().any(|write| {
            write.resource == resource && write.gaia_only == (owner == 0) && !write.keeps(current)
        })
    }

    pub(super) fn starting_villager_count(&self, generation_start: u32, owner: u8) -> u32 {
        if resource_rule_disabled(ResourceRuleSwitch::StartingVillagers) {
            return generation_start;
        }
        let value = self.effective_player_resource(
            owner,
            STARTING_VILLAGERS_RESOURCE,
            generation_start as f32,
        );
        u32::try_from(truncate_f32_to_i32(value)).unwrap_or(0)
    }

    pub(crate) fn initial_path_context(
        &self,
        dimensions: MapDimensions,
        content: CompatibleContentView<'_>,
        rules: rms_profile::GenerationRules,
    ) -> Result<super::exact_path::PathContext, GenerationError> {
        let Some(slot) = content.rms_path_reference_object_id() else {
            return Ok(super::exact_path::PathContext::Unavailable);
        };
        let definition = self.definition(slot, 0, content);
        let restriction = definition
            .and_then(|definition| self.master_restriction_id(slot, 0, definition))
            .and_then(|id| content.restriction(id));
        let Some(restriction) = restriction else {
            return Ok(super::exact_path::PathContext::Absent);
        };
        let Some(costs) = restriction.traversal_cost_f32_bits.as_deref() else {
            return Ok(super::exact_path::PathContext::Unavailable);
        };
        super::exact_path::PathContext::with_rules(dimensions, Some(costs), rules)
    }

    pub(super) fn path_reference<'a>(
        &'a self,
        owner: u8,
        content: CompatibleContentView<'a>,
    ) -> Result<Option<(&'a [u32], f32)>, GenerationError> {
        let slot = content.rms_path_reference_object_id().ok_or_else(|| {
            invalid_object("required traversal reference metadata is unavailable")
        })?;
        let Some(reference) = self.definition(slot, owner, content) else {
            return Ok(None);
        };
        let restriction_slot = reference.id;
        let Some(first_reference) = self.definition(restriction_slot, 0, content) else {
            return Ok(None);
        };
        let Some(restriction) = self
            .master_restriction_id(restriction_slot, 0, first_reference)
            .and_then(|id| content.restriction(id))
        else {
            return Ok(None);
        };
        let costs = restriction
            .traversal_cost_f32_bits
            .as_deref()
            .ok_or_else(|| invalid_object("required traversal costs are unavailable"))?;
        Ok(Some((costs, reference.collision_half_extents()[0])))
    }
    pub(crate) fn bind_owner_civilizations(
        &mut self,
        players: &[ExactSetupPlayer],
    ) -> Result<(), GenerationError> {
        if self.owner_civilizations.iter().any(Option::is_some) {
            return Err(invalid_object(
                "initial master owner tables are already bound",
            ));
        }
        let mut owners = [None; 9];
        owners[0] = Some(CivilizationId(0));
        for player in players {
            let slot = usize::from(player.slot);
            if slot == 0 || slot >= owners.len() || owners[slot].is_some() {
                return Err(invalid_object("initial master owner slots are invalid"));
            }
            owners[slot] = Some(player.civilization_id);
        }
        self.owner_civilizations = owners;
        Ok(())
    }

    pub(super) fn initial_resources(
        &self,
        definition: &ObjectDefinition,
        owner: u8,
        content: CompatibleContentView<'_>,
    ) -> Result<rms_content::ObjectResourceState, GenerationError> {
        if let Some(resource) = definition.initial_resource_override {
            return Ok(resource);
        }
        if let Some(slots) = definition.resource_slots {
            return Ok(rms_content::ObjectResourceState::from_slots(&slots));
        }
        let civilization = self
            .owner_civilizations
            .get(usize::from(owner))
            .copied()
            .flatten()
            .ok_or_else(|| invalid_object("object resource owner table is unavailable"))?;
        let slots = content
            .object_resource_slots(definition.id, civilization)
            .ok_or_else(|| {
                GenerationError::InvalidContent(format!(
                    "resource slots are unavailable for object {}",
                    definition.id.0
                ))
            })?;
        Ok(rms_content::ObjectResourceState::from_slots(&slots))
    }

    pub(crate) fn construction_restriction(
        &self,
        object_id: ObjectId,
        owner: u8,
        content: CompatibleContentView<'_>,
    ) -> Result<Option<RestrictionId>, GenerationError> {
        let source = content
            .object(object_id)
            .ok_or_else(|| missing_object_definition(object_id))?;
        if !source.initializes_restriction_zones {
            return Ok(None);
        }
        let definition = self
            .definition(object_id, owner, content)
            .ok_or_else(|| missing_object_definition(object_id))?;
        self.master_restriction_id(object_id, owner, definition)
            .map(Some)
            .ok_or_else(|| invalid_object("zone-initializing master lacks a restriction"))
    }
    pub(super) fn standing_graphic_id(
        &self,
        object_id: ObjectId,
        owner: u8,
        definition: &ObjectDefinition,
    ) -> Option<i16> {
        (if owner == 0 {
            self.gaia_standing_graphic_ids.get(&object_id)
        } else {
            self.standing_graphic_ids.get(&object_id)
        })
        .copied()
        .or(definition.standing_graphic_id)
    }

    pub(super) fn creation_rng(
        &self,
        object_id: ObjectId,
        definition: &ObjectDefinition,
        owner: u8,
        content: CompatibleContentView<'_>,
    ) -> Result<ObjectCreationRng, GenerationError> {
        let standing_graphic_id = (if owner == 0 {
            self.gaia_standing_graphic_ids.get(&object_id)
        } else {
            self.standing_graphic_ids.get(&object_id)
        })
        .copied();
        let mut profile = standing_graphic_id
            .map_or(Ok(definition.creation_rng), |graphic_id| {
                effect_graphic_creation_rng(definition, graphic_id, content)
            })?;
        if owner == 0
            && let Some(&facet) = self.gaia_preset_facets.get(&definition.id)
        {
            profile.random_facet = false;
            profile.fixed_facet = Some(u16::from(facet));
        }
        Ok(profile)
    }

    pub(super) fn mutate_standing_graphic(
        &mut self,
        object_id: ObjectId,
        mutation: AttributeMutation,
        value: i32,
        gaia_only: bool,
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        if matches!(mutation, AttributeMutation::Multiply) {
            return Ok(());
        }
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            let Some(definition) = self.definition(object_id, *owner, content) else {
                continue;
            };
            let current = (if *owner == 0 {
                self.gaia_standing_graphic_ids.get(&object_id)
            } else {
                self.standing_graphic_ids.get(&object_id)
            })
            .copied()
            .or(definition.standing_graphic_id)
            .map_or(-1, i32::from);
            let requested = match mutation {
                AttributeMutation::Set => value,
                AttributeMutation::Add => current.wrapping_add(value),
                AttributeMutation::Multiply => unreachable!("handled above"),
            };
            let Some(selected) = i16::try_from(requested).ok().filter(|id| {
                *id >= 0
                    && (content.graphic(*id).is_some()
                        || definition.creation_rng_for_standing_graphic(*id).is_some())
            }) else {
                continue;
            };
            effect_graphic_creation_rng(definition, selected, content)?;
            if *owner == 0 {
                self.gaia_standing_graphic_ids.insert(object_id, selected);
            } else {
                self.standing_graphic_ids.insert(object_id, selected);
            }
        }
        Ok(())
    }

    pub(super) fn set_hit_points(&mut self, object_id: ObjectId, value: u16, gaia_only: bool) {
        if gaia_only {
            self.gaia_hit_points
                .insert(object_id, HitPointMutation::Set(value));
        } else {
            self.hit_points
                .insert(object_id, HitPointMutation::Set(value));
            self.gaia_hit_points
                .insert(object_id, HitPointMutation::Set(value));
        }
    }

    pub(super) fn add_hit_points(&mut self, object_id: ObjectId, amount: u16, gaia_only: bool) {
        let add = |values: &mut std::collections::BTreeMap<ObjectId, HitPointMutation>| {
            values
                .entry(object_id)
                .and_modify(|value| *value = value.add(amount))
                .or_insert(HitPointMutation::Add(amount));
        };
        if gaia_only {
            add(&mut self.gaia_hit_points);
        } else {
            add(&mut self.hit_points);
            add(&mut self.gaia_hit_points);
        }
    }

    pub(super) fn set_restriction(
        &mut self,
        object_id: ObjectId,
        restriction_id: Option<RestrictionId>,
        gaia_only: bool,
    ) {
        if gaia_only {
            self.gaia_restriction_ids.insert(object_id, restriction_id);
            self.master_gaia_restriction_ids
                .insert(object_id, restriction_id);
        } else {
            self.restriction_ids.insert(object_id, restriction_id);
            self.master_restriction_ids
                .insert(object_id, restriction_id);
            self.master_gaia_restriction_ids
                .insert(object_id, restriction_id);
        }
    }

    pub(super) fn set_upgrade(&mut self, object_id: ObjectId, target: ObjectId, gaia_only: bool) {
        self.modified_owner_speeds.retain(|&(id, civilization), _| {
            id != object_id || (gaia_only && civilization != CivilizationId(0))
        });
        self.modified_masters.remove(&(object_id, true));
        self.gaia_standing_graphic_ids.remove(&object_id);
        if !gaia_only {
            self.modified_masters.remove(&(object_id, false));
            self.standing_graphic_ids.remove(&object_id);
        }
        if gaia_only {
            self.gaia_upgrade_targets.insert(object_id, target);
            self.master_gaia_restriction_ids.remove(&object_id);
            self.gaia_hit_points.remove(&object_id);
        } else {
            self.upgrade_targets.insert(object_id, target);
            self.gaia_upgrade_targets.insert(object_id, target);
            self.master_restriction_ids.remove(&object_id);
            self.master_gaia_restriction_ids.remove(&object_id);
            self.hit_points.remove(&object_id);
            self.gaia_hit_points.remove(&object_id);
        }
    }

    pub(crate) fn initial_hit_points(
        &self,
        object_id: ObjectId,
        owner: u8,
        content: CompatibleContentView<'_>,
    ) -> Result<i16, GenerationError> {
        let definition = self
            .definition(object_id, owner, content)
            .ok_or_else(|| missing_object_definition(object_id))?;
        self.hit_points(object_id, owner, definition)
    }

    pub(super) fn hit_points(
        &self,
        object_id: ObjectId,
        owner: u8,
        definition: &ObjectDefinition,
    ) -> Result<i16, GenerationError> {
        let mutation = (if owner == 0 {
            self.gaia_hit_points.get(&object_id)
        } else {
            self.hit_points.get(&object_id)
        })
        .copied();
        if let Some(HitPointMutation::Set(value)) = mutation {
            return Ok(value as i16);
        }
        let base = definition
            .hit_points
            .ok_or_else(|| invalid_object("object hit-point metadata is unavailable"))?;
        Ok(mutation.map_or(base, |value| value.apply(base as u16) as i16))
    }

    pub(super) fn restriction_id(
        &self,
        object_id: ObjectId,
        owner: u8,
        definition: &ObjectDefinition,
    ) -> Option<RestrictionId> {
        (if owner == 0 {
            self.gaia_restriction_ids.get(&object_id)
        } else {
            self.restriction_ids.get(&object_id)
        })
        .copied()
        .unwrap_or_else(|| {
            definition.restriction_for(
                self.owner_civilizations
                    .get(usize::from(owner))
                    .copied()
                    .flatten(),
            )
        })
    }

    pub(super) fn invalidation_restriction_id(
        &self,
        object_id: ObjectId,
        content: CompatibleContentView<'_>,
    ) -> Option<RestrictionId> {
        for (owner, civilization) in self.owner_civilizations.iter().enumerate() {
            let Some(civilization) = civilization else {
                continue;
            };
            let owner = owner as u8;
            let Some(definition) = self.definition(object_id, owner, content) else {
                continue;
            };
            let table_civilization = if owner == 0 {
                CivilizationId(0)
            } else {
                *civilization
            };
            if definition
                .available_civilizations
                .as_ref()
                .is_some_and(|available| available.binary_search(&table_civilization).is_err())
            {
                continue;
            }
            return self.master_restriction_id(object_id, owner, definition);
        }
        None
    }

    pub(super) fn master_restriction_id(
        &self,
        object_id: ObjectId,
        owner: u8,
        definition: &ObjectDefinition,
    ) -> Option<RestrictionId> {
        (if owner == 0 {
            self.master_gaia_restriction_ids.get(&object_id)
        } else {
            self.master_restriction_ids.get(&object_id)
        })
        .copied()
        .unwrap_or_else(|| {
            definition.restriction_for(
                self.owner_civilizations
                    .get(usize::from(owner))
                    .copied()
                    .flatten(),
            )
        })
    }

    pub(super) fn definition_id(&self, object_id: ObjectId, owner: u8) -> ObjectId {
        (if owner == 0 {
            self.gaia_upgrade_targets.get(&object_id)
        } else {
            self.upgrade_targets.get(&object_id)
        })
        .copied()
        .unwrap_or(object_id)
    }

    pub(crate) fn definition<'a>(
        &'a self,
        object_id: ObjectId,
        owner: u8,
        content: CompatibleContentView<'a>,
    ) -> Option<&'a ObjectDefinition> {
        self.modified_masters
            .get(&(object_id, owner == 0))
            .or_else(|| content.object(self.definition_id(object_id, owner)))
    }

    pub(crate) fn movement_speed_bits(
        &self,
        object_id: ObjectId,
        owner: u8,
        content: CompatibleContentView<'_>,
    ) -> Option<u32> {
        let definition = self.definition(object_id, owner, content)?;
        if definition.movement_speed_f32_bits.is_some() {
            return definition.movement_speed_f32_bits;
        }
        let civilization = self.owner_civilizations.get(usize::from(owner))?.as_ref()?;
        self.modified_owner_speeds
            .get(&(object_id, *civilization))
            .copied()
            .or_else(|| content.object_movement_speed_bits(definition.id, *civilization))
    }

    pub(super) fn scan_definition_lookup<'a>(
        &'a self,
        content: CompatibleContentView<'a>,
    ) -> impl FnMut(ObjectId, u8) -> Option<&'a ObjectDefinition> {
        let mut last = None;
        move |id, owner| {
            if let Some((previous_id, previous_owner, definition)) = last
                && (previous_id, previous_owner) == (id, owner)
            {
                return Some(definition);
            }
            let definition = self.definition(id, owner, content);
            last = definition.map(|definition| (id, owner, definition));
            definition
        }
    }

    pub(super) fn mutate_geometry(
        &mut self,
        object_id: ObjectId,
        axis: usize,
        mutation: AttributeMutation,
        value: f32,
        gaia_only: bool,
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            let definition = self
                .definition(object_id, *owner, content)
                .ok_or_else(|| missing_object_definition(object_id))?;
            let mut collision = definition.collision_half_extents();
            let placement = definition.placement_half_extents();
            collision[axis] = match mutation {
                AttributeMutation::Set => value,
                AttributeMutation::Add => collision[axis] + value,
                AttributeMutation::Multiply => collision[axis] * value,
            };
            let projected = (f64::from(collision[axis]) * 512.0).round();
            if !projected.is_finite() || collision[axis] < 0.0 || projected > f64::from(u16::MAX) {
                return Err(invalid_object(
                    "runtime collision extent exceeds output domain",
                ));
            }
            let key = (object_id, *owner == 0);
            let definition_id = definition.id;
            let definition = self.modified_masters.entry(key).or_insert_with(|| {
                content
                    .object(definition_id)
                    .expect("effective master was validated")
                    .clone()
            });
            definition.placement_geometry = Some(rms_content::ObjectPlacementGeometry {
                collision_half_width_f32_bits: collision[0].to_bits(),
                collision_half_height_f32_bits: collision[1].to_bits(),
                placement_half_width_f32_bits: placement[0].to_bits(),
                placement_half_height_f32_bits: placement[1].to_bits(),
            });
            if axis == 0 {
                definition.footprint_width_256 = projected as u16;
            } else {
                definition.footprint_height_256 = projected as u16;
            }
        }
        Ok(())
    }

    pub(super) fn mutate_foundation_terrain(
        &mut self,
        object_id: ObjectId,
        mutation: AttributeMutation,
        value: f32,
        gaia_only: bool,
        content: CompatibleContentView<'_>,
    ) {
        if mutation == AttributeMutation::Multiply {
            return;
        }
        let operand = if f64::from(value) >= -2_147_483_648.0 && f64::from(value) < 2_147_483_648.0
        {
            value as i32
        } else {
            i32::MIN
        };
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            let Some(definition) = self.definition(object_id, *owner, content).cloned() else {
                continue;
            };
            if definition.constructor_type != Some(BUILDING_CONSTRUCTOR_TYPE) {
                continue;
            }
            let key = (object_id, *owner == 0);
            let current = self
                .foundation_terrain_values
                .get(&key)
                .copied()
                .unwrap_or_else(|| {
                    definition
                        .foundation
                        .as_ref()
                        .map_or(-1, |foundation| foundation.terrain_id.0 as i16)
                });
            let updated = match mutation {
                AttributeMutation::Set => operand as i16,
                AttributeMutation::Add => current.wrapping_add(operand as i16),
                AttributeMutation::Multiply => unreachable!("handled above"),
            };
            self.foundation_terrain_values.insert(key, updated);
            let omitted_cells = definition
                .foundation
                .as_ref()
                .map(|foundation| foundation.omitted_cells.clone())
                .unwrap_or_default();
            let definition = self.modified_masters.entry(key).or_insert(definition);
            definition.foundation = (updated > -1).then(|| rms_content::ObjectFoundation {
                terrain_id: TerrainId(u32::from(updated as u8)),
                omitted_cells,
            });
        }
    }

    pub(super) fn mutate_movement_speed(
        &mut self,
        object_id: ObjectId,
        mutation: AttributeMutation,
        value: f32,
        gaia_only: bool,
        content: CompatibleContentView<'_>,
    ) {
        let mut variant_scopes = [false; 2];
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            let effective_id = self.definition_id(object_id, *owner);
            for variant in content.object_movement_speed_variants(effective_id) {
                variant_scopes[usize::from(*owner)] = true;
                for &civilization in &variant.civilization_ids {
                    if (civilization == CivilizationId(0)) != (*owner == 0) {
                        continue;
                    }
                    let key = (object_id, civilization);
                    let current = self
                        .modified_owner_speeds
                        .get(&key)
                        .copied()
                        .unwrap_or(variant.speed_f32_bits);
                    let current = f32::from_bits(current);
                    let updated = match mutation {
                        AttributeMutation::Set => value,
                        AttributeMutation::Add => value + current,
                        AttributeMutation::Multiply => value * current,
                    };
                    self.modified_owner_speeds.insert(key, updated.to_bits());
                }
            }
        }
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            if variant_scopes[usize::from(*owner)] {
                continue;
            }
            let Some(definition) = self.definition(object_id, *owner, content) else {
                continue;
            };
            let Some(current) = definition.movement_speed_f32_bits else {
                continue;
            };
            let current = f32::from_bits(current);
            let updated = match mutation {
                AttributeMutation::Set => value,
                AttributeMutation::Add => value + current,
                AttributeMutation::Multiply => value * current,
            };
            let definition_id = definition.id;
            self.modified_masters
                .entry((object_id, *owner == 0))
                .or_insert_with(|| {
                    content
                        .object(definition_id)
                        .expect("effective master was validated")
                        .clone()
                })
                .movement_speed_f32_bits = Some(updated.to_bits());
        }
    }

    pub(super) fn mutate_storage(
        &mut self,
        object_id: ObjectId,
        slot: usize,
        mutation: AttributeMutation,
        value: f32,
        gaia_only: bool,
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        fn storage_word(value: f32) -> f32 {
            let integer = if (-2_147_483_648.0_f32..2_147_483_648.0_f32).contains(&value) {
                value as i32
            } else {
                i32::MIN
            };
            f32::from(integer as i16)
        }
        for owner in if gaia_only { &[0][..] } else { &[0, 1][..] } {
            let Some(definition) = self.definition(object_id, *owner, content) else {
                continue;
            };
            let mut slots = if let Some(slots) = definition.resource_slots {
                slots
            } else {
                let Some(civilization) = self
                    .owner_civilizations
                    .get(usize::from(*owner))
                    .copied()
                    .flatten()
                else {
                    continue;
                };
                let Some(slots) = content.object_resource_slots(definition.id, civilization) else {
                    continue;
                };
                slots
            };
            let current = f32::from_bits(slots[slot].quantity_f32_bits);
            slots[slot].quantity_f32_bits = match mutation {
                AttributeMutation::Set => storage_word(value),
                AttributeMutation::Add => storage_word(value) + current,
                AttributeMutation::Multiply => storage_word(value * current + 0.5_f32),
            }
            .to_bits();
            let definition_id = definition.id;
            let definition = self
                .modified_masters
                .entry((object_id, *owner == 0))
                .or_insert_with(|| {
                    content
                        .object(definition_id)
                        .expect("effective master was validated")
                        .clone()
                });
            definition.resource_slots = Some(slots);
        }
        Ok(())
    }
}

fn effect_graphic_creation_rng(
    definition: &ObjectDefinition,
    graphic_id: i16,
    content: CompatibleContentView<'_>,
) -> Result<ObjectCreationRng, GenerationError> {
    if let Some(profile) = definition.creation_rng_for_standing_graphic(graphic_id) {
        return Ok(profile);
    }
    let constructor_type = definition
        .constructor_type
        .ok_or(GenerationError::IncompatibleContent)?;
    let graphic = match graphic_id {
        graphic_id if graphic_id < 0 => None,
        graphic_id => Some(
            content
                .graphic(graphic_id)
                .ok_or(GenerationError::IncompatibleContent)?,
        ),
    };
    Ok(ObjectCreationRng::for_constructor(
        constructor_type,
        graphic,
    ))
}
