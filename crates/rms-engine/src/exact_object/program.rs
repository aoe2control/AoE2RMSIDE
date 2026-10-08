use super::*;
use rms_semantics::{ObjectBlockCommandEffect, object_block_command_effect};

pub(super) fn collect_object_program(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
) -> Result<ExactObjectProgram, GenerationError> {
    let operations = semantic_program
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            operation.accepted_by_target_parser() && operation.section == "objects_generation"
        })
        .collect::<Vec<_>>();
    let roll_filter =
        generation_rules(&semantic_program.identity.profile)?.object_group_roll_filter;
    let mut gaia = setup.gaia_civilization_id;
    let mut actor_areas = Vec::new();
    let mut groups = Vec::<ExactObjectGroup>::new();
    let mut descriptors = Vec::<ExactObjectDescriptor>::new();
    let mut active_group: Option<usize> = None;
    let mut opener: Option<&str> = None;
    let mut cursor = 0;
    while cursor < operations.len() {
        let (operation_index, operation) = operations[cursor];
        if operation.depth > 0 {
            apply_braced_object_command(
                operation,
                opener == Some("create_object_group"),
                active_group,
                &mut groups,
                &mut descriptors,
                &mut gaia,
                content,
            )?;
            cursor += 1;
            continue;
        }
        opener = Some(operation.name.as_str());
        match operation.name.as_str() {
            "set_gaia_civilization" => {
                gaia = gaia_civilization(operation)?;
                active_group = None;
            }
            "create_actor_area" => {
                if actor_areas.len() >= MAXIMUM_ACTOR_AREAS {
                    return Err(object_limit("actor areas", MAXIMUM_ACTOR_AREAS));
                }
                actor_areas.push(ExactActorArea {
                    id: rounded_numeric_i32(operation, 2)?,
                    center: ActorAreaCenter {
                        x: rounded_numeric_i32(operation, 0)?,
                        y: rounded_numeric_i32(operation, 1)?,
                    },
                    radius: rounded_numeric_i32(operation, 3)?,
                    player_slot: None,
                    operation_index: operation_index as u32,
                });
                active_group = None;
            }
            "create_object_group" => {
                let name = text_argument(operation, 0)?.to_owned();
                if let Some(index) = groups.iter().position(|group| group.name == name) {
                    freeze_referenced_object_group(
                        index,
                        operation_index as u32,
                        &mut groups,
                        &mut descriptors,
                    )?;
                    active_group = Some(index);
                } else {
                    if groups.len() >= MAXIMUM_OBJECT_GROUPS {
                        return Err(object_limit("object groups", MAXIMUM_OBJECT_GROUPS));
                    }
                    groups.push(ExactObjectGroup {
                        name,
                        entries: Vec::new(),
                        operation_index: operation_index as u32,
                        roll_filter,
                    });
                    active_group = Some(groups.len() - 1);
                }
            }
            "add_object" => {}
            "create_object" => {
                if descriptors.len() >= MAXIMUM_OBJECT_DESCRIPTORS {
                    return Err(object_limit(
                        "object descriptors",
                        MAXIMUM_OBJECT_DESCRIPTORS,
                    ));
                }
                let depth = operation.depth;
                let mut next = cursor + 1;
                while next < operations.len() && operations[next].1.depth > depth {
                    next += 1;
                }
                if let Some(mut descriptor) =
                    start_object_descriptor(operation, &groups, operation_index as u32, content)?
                {
                    for (_, child) in &operations[cursor + 1..next] {
                        apply_object_block_command(
                            &mut descriptor,
                            child,
                            &groups,
                            &mut gaia,
                            content,
                        )?;
                    }
                    descriptors.push(descriptor);
                }
                active_group = None;
                cursor = next.saturating_sub(1);
            }
            _ => active_group = None,
        }
        cursor += 1;
    }
    Ok((gaia, actor_areas, groups, descriptors))
}

fn freeze_referenced_object_group(
    index: usize,
    operation_index: u32,
    groups: &mut Vec<ExactObjectGroup>,
    descriptors: &mut [ExactObjectDescriptor],
) -> Result<(), GenerationError> {
    let name = groups[index].name.clone();
    let referenced = |reference: &Option<String>| reference.as_deref() == Some(name.as_str());
    if !descriptors.iter().any(|descriptor| {
        referenced(&descriptor.object_group_name)
            || referenced(&descriptor.second_object_group_name)
    }) {
        return Ok(());
    }
    if groups.len() >= MAXIMUM_OBJECT_GROUPS {
        return Err(object_limit("object groups", MAXIMUM_OBJECT_GROUPS));
    }
    let frozen = format!("{name} (before operation {operation_index})");
    for descriptor in descriptors.iter_mut() {
        for reference in [
            &mut descriptor.object_group_name,
            &mut descriptor.second_object_group_name,
        ] {
            if reference.as_deref() == Some(name.as_str()) {
                *reference = Some(frozen.clone());
            }
        }
    }
    groups.push(ExactObjectGroup {
        name: frozen,
        ..groups[index].clone()
    });
    Ok(())
}

fn apply_object_block_command(
    descriptor: &mut ExactObjectDescriptor,
    command: &SemanticOperation,
    groups: &[ExactObjectGroup],
    gaia: &mut CivilizationId,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    match object_block_command_effect(&command.name) {
        ObjectBlockCommandEffect::Descriptor => {
            apply_object_descriptor_command(descriptor, command, groups, content)
        }
        ObjectBlockCommandEffect::Global => apply_global_object_command(command, gaia),
        ObjectBlockCommandEffect::GroupEntry => {
            if groups.is_empty() {
                Ok(())
            } else {
                Err(invalid_object(
                    "the preview does not support add_object inside create_object braces after a create_object_group",
                ))
            }
        }
        ObjectBlockCommandEffect::Ignored => Ok(()),
    }
}

fn apply_object_descriptor_command(
    descriptor: &mut ExactObjectDescriptor,
    command: &SemanticOperation,
    groups: &[ExactObjectGroup],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if command.name == "second_object"
        && command
            .arguments
            .first()
            .is_some_and(|argument| argument.resolution == ArgumentResolution::ObjectGroupReference)
    {
        let name = text_argument(command, 0)?;
        let group = groups
            .iter()
            .find(|group| group.name == name)
            .ok_or_else(|| invalid_object("secondary object group is unresolved"))?;
        if group.entries.is_empty() {
            return Err(invalid_object("secondary object group has no entries"));
        }
        descriptor.second_object_id = None;
        descriptor.second_object_group_name = Some(name.to_owned());
        if descriptor.object_group_name.is_some() {
            descriptor.object_group_name = Some(name.to_owned());
        }
        return Ok(());
    }
    descriptor.apply(command, content)
}

fn apply_global_object_command(
    command: &SemanticOperation,
    gaia: &mut CivilizationId,
) -> Result<(), GenerationError> {
    if command.name == "set_gaia_civilization" {
        *gaia = gaia_civilization(command)?;
    }
    Ok(())
}

fn gaia_civilization(command: &SemanticOperation) -> Result<CivilizationId, GenerationError> {
    Ok(CivilizationId(rounded_nonnegative_u32(
        command,
        0,
        "gaia civilization",
    )?))
}

fn apply_braced_object_command(
    command: &SemanticOperation,
    in_object_group_block: bool,
    active_group: Option<usize>,
    groups: &mut [ExactObjectGroup],
    descriptors: &mut [ExactObjectDescriptor],
    gaia: &mut CivilizationId,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if matches!(
        command.name.as_str(),
        "create_object" | "create_object_group" | "create_actor_area"
    ) {
        return Ok(());
    }
    match object_block_command_effect(&command.name) {
        ObjectBlockCommandEffect::GroupEntry => {
            if in_object_group_block && let Some(group_index) = active_group {
                if groups[group_index].entries.len() >= MAXIMUM_OBJECT_GROUP_ENTRIES {
                    return Err(object_limit(
                        "object group entries",
                        MAXIMUM_OBJECT_GROUP_ENTRIES,
                    ));
                }
                groups[group_index].entries.push(ExactObjectGroupEntry {
                    object_id: object_argument(command, 0, content)?,
                    weight: rounded_nonnegative_u32(command, 1, "object group weight")?,
                });
                Ok(())
            } else if groups.is_empty() {
                Ok(())
            } else {
                Err(invalid_object(
                    "the preview does not support add_object outside create_object_group braces after a create_object_group",
                ))
            }
        }
        ObjectBlockCommandEffect::Descriptor => match descriptors.last_mut() {
            Some(descriptor) => {
                apply_object_descriptor_command(descriptor, command, groups, content)
            }
            None => Ok(()),
        },
        ObjectBlockCommandEffect::Global => apply_global_object_command(command, gaia),
        ObjectBlockCommandEffect::Ignored => Ok(()),
    }
}

pub(crate) fn collect_runtime_object_attributes(
    operations: &[SemanticOperation],
    content: CompatibleContentView<'_>,
) -> Result<ObjectRuntimeAttributes, GenerationError> {
    let set_attribute = content.rms_implicit_definition("SET_ATTRIBUTE");
    let gaia_set_attribute = content.rms_implicit_definition("GAIA_SET_ATTRIBUTE");
    let add_attribute = content.rms_implicit_definition("ADD_ATTRIBUTE");
    let gaia_add_attribute = content.rms_implicit_definition("GAIA_ADD_ATTRIBUTE");
    let multiply_attribute = content.rms_implicit_definition("MUL_ATTRIBUTE");
    let gaia_multiply_attribute = content.rms_implicit_definition("GAIA_MUL_ATTRIBUTE");
    let radius_attributes = [
        content.rms_implicit_definition("ATTR_RADIUS_1"),
        content.rms_implicit_definition("ATTR_RADIUS_2"),
    ];
    let storage_attributes = [
        content.rms_implicit_definition("ATTR_STORAGE_VALUE"),
        content.rms_implicit_definition("ATTR_STORAGE2_VALUE"),
        content.rms_implicit_definition("ATTR_STORAGE3_VALUE"),
    ];
    let hit_points_attribute = content.rms_implicit_definition("ATTR_HITPOINTS");
    let movement_speed_attribute = content.rms_implicit_definition("ATTR_MOVE_SPEED");
    let terrain_attribute = content.rms_implicit_definition("ATTR_TERRAIN_ID");
    let foundation_terrain_attribute = content.rms_implicit_definition("ATTR_FOUNDATION_TERRAIN");
    let standing_graphic_attribute = content.rms_implicit_definition("ATTR_STANDING_GRAPHIC");
    let upgrade_unit = content.rms_implicit_definition("UPGRADE_UNIT");
    let gaia_upgrade_unit = content.rms_implicit_definition("GAIA_UPGRADE_UNIT");
    let modify_resource = content.rms_implicit_definition("MOD_RESOURCE");
    let gaia_modify_resource = content.rms_implicit_definition("GAIA_MOD_RESOURCE");
    let multiply_resource = content.rms_implicit_definition("MUL_RESOURCE");
    let gaia_multiply_resource = content.rms_implicit_definition("GAIA_MUL_RESOURCE");
    let mut attributes = ObjectRuntimeAttributes::default();
    for operation in operations.iter().filter(|operation| {
        operation.accepted_by_target_parser()
            && matches!(operation.name.as_str(), "effect_amount" | "effect_percent")
    }) {
        let effect = numeric_i32(operation, 0)?;
        let target_id = nonnegative_u32(operation, 1, "effect object")?;
        if Some(effect) == upgrade_unit || Some(effect) == gaia_upgrade_unit {
            let target = ObjectId(nonnegative_u32(operation, 2, "upgrade target")?);
            attributes.set_upgrade(
                ObjectId(target_id),
                target,
                Some(effect) == gaia_upgrade_unit,
            );
            continue;
        }
        let modify = Some(effect) == modify_resource || Some(effect) == gaia_modify_resource;
        let resource_multiply =
            Some(effect) == multiply_resource || Some(effect) == gaia_multiply_resource;
        if modify || resource_multiply {
            let mutation = if resource_multiply {
                Some(AttributeMutation::Multiply)
            } else {
                match numeric_i32(operation, 2) {
                    Ok(0) => Some(AttributeMutation::Set),
                    Ok(1) => Some(AttributeMutation::Add),
                    _ => None,
                }
            };
            let value = text_argument(operation, 3)
                .ok()
                .and_then(|text| text.parse::<f32>().ok());
            let value = value.map(|value| {
                if operation.name == "effect_percent" {
                    value / 100.0_f32
                } else {
                    value
                }
            });
            attributes.record_player_resource_write(PlayerResourceWrite {
                gaia_only: Some(effect) == gaia_modify_resource
                    || Some(effect) == gaia_multiply_resource,
                resource: target_id,
                mutation: value.and(mutation),
                value_f32_bits: value.unwrap_or(0.0).to_bits(),
            });
            continue;
        }
        let set = Some(effect) == set_attribute || Some(effect) == gaia_set_attribute;
        let add = Some(effect) == add_attribute || Some(effect) == gaia_add_attribute;
        let multiply =
            Some(effect) == multiply_attribute || Some(effect) == gaia_multiply_attribute;
        if !set && !add && !multiply {
            continue;
        }
        let attribute = numeric_i32(operation, 2)?;
        let value = text_argument(operation, 3)?
            .parse::<f32>()
            .map_err(|_| invalid_object("effect value is not numeric"))?;
        let value = if operation.name == "effect_percent" {
            value / 100.0_f32
        } else {
            value
        };
        if !value.is_finite() {
            return Err(invalid_object("effect value is not finite"));
        }
        let gaia_only = Some(effect) == gaia_set_attribute
            || Some(effect) == gaia_add_attribute
            || Some(effect) == gaia_multiply_attribute;
        let mutation = if set {
            AttributeMutation::Set
        } else if add {
            AttributeMutation::Add
        } else {
            AttributeMutation::Multiply
        };
        if Some(attribute) == movement_speed_attribute {
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                attributes.mutate_movement_speed(object_id, mutation, value, gaia_only, content);
                Ok(())
            })?;
            continue;
        }
        if let Some(slot) = storage_attributes
            .iter()
            .position(|id| *id == Some(attribute))
        {
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                attributes.mutate_storage(object_id, slot, mutation, value, gaia_only, content)
            })?;
            continue;
        }
        if let Some(axis) = radius_attributes
            .iter()
            .position(|id| *id == Some(attribute))
        {
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                attributes.mutate_geometry(object_id, axis, mutation, value, gaia_only, content)
            })?;
            continue;
        }
        if Some(attribute) == foundation_terrain_attribute {
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                attributes
                    .mutate_foundation_terrain(object_id, mutation, value, gaia_only, content);
                Ok(())
            })?;
            continue;
        }
        if Some(attribute) == standing_graphic_attribute {
            let operand =
                if f64::from(value) >= -2_147_483_648.0 && f64::from(value) < 2_147_483_648.0 {
                    value as i32
                } else {
                    i32::MIN
                };
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                attributes.mutate_standing_graphic(object_id, mutation, operand, gaia_only, content)
            })?;
            continue;
        }
        if multiply {
            continue;
        }
        if f64::from(value) < f64::from(i32::MIN) || f64::from(value) > f64::from(i32::MAX) {
            return Err(invalid_object("effect value exceeds i32"));
        }
        let value = value.trunc() as i32;
        if Some(attribute) == hit_points_attribute {
            for_each_runtime_attribute_target(target_id, content, |object_id| {
                if set {
                    attributes.set_hit_points(object_id, value as u16, gaia_only);
                } else {
                    attributes.add_hit_points(object_id, value as u16, gaia_only);
                }
                Ok(())
            })?;
            continue;
        }
        if Some(attribute) != terrain_attribute || !set {
            continue;
        }
        let restriction_id = if value < 0 {
            None
        } else {
            let restriction_id = RestrictionId(value as u32);
            if content.restriction(restriction_id).is_none() {
                return Err(GenerationError::IncompatibleContent);
            }
            Some(restriction_id)
        };
        for_each_runtime_attribute_target(target_id, content, |object_id| {
            attributes.set_restriction(object_id, restriction_id, gaia_only);
            Ok(())
        })?;
    }
    Ok(attributes)
}

pub(super) fn for_each_runtime_attribute_target(
    encoded_target: u32,
    content: CompatibleContentView<'_>,
    mut apply: impl FnMut(ObjectId) -> Result<(), GenerationError>,
) -> Result<(), GenerationError> {
    if let Some(class_id) = encoded_target
        .checked_sub(900)
        .filter(|class_id| *class_id < 100)
    {
        for definition in content
            .objects()
            .iter()
            .filter(|definition| definition.class_id == class_id)
        {
            apply(definition.id)?;
        }
        return Ok(());
    }
    apply(ObjectId(encoded_target))
}

pub(super) fn start_object_descriptor(
    operation: &SemanticOperation,
    groups: &[ExactObjectGroup],
    operation_index: u32,
    content: CompatibleContentView<'_>,
) -> Result<Option<ExactObjectDescriptor>, GenerationError> {
    if operation
        .arguments
        .first()
        .is_some_and(|argument| argument.resolution == ArgumentResolution::UndefinedNumericFallback)
    {
        return Ok(None);
    }
    ExactObjectDescriptor::new(
        text_argument(operation, 0)?,
        groups,
        operation_index,
        content,
    )
    .map(Some)
}

impl ExactObjectDescriptor {
    pub(super) fn new(
        identity: &str,
        groups: &[ExactObjectGroup],
        operation_index: u32,
        content: CompatibleContentView<'_>,
    ) -> Result<Self, GenerationError> {
        let (object_id, object_group_name) = match parse_object(identity, content) {
            Some(id) => (Some(id), None),
            None if groups.iter().any(|group| group.name == identity) => {
                (None, Some(identity.to_owned()))
            }
            None => {
                return Err(invalid_object(&format!(
                    "object identity {identity:?} is unresolved"
                )));
            }
        };
        Ok(Self {
            object_id,
            object_group_name,
            number_of_groups: 1,
            number_of_objects: 1,
            group_variance: 0,
            group_placement_radius: 3,
            grouping: ExactObjectGrouping::Default,
            scaling: ExactObjectScaling::None,
            place_for_every_player: false,
            gaia_object_only: false,
            explicit_facet: None,
            second_object_id: None,
            second_object_group_name: None,
            resource_delta: 0,
            behavior_flags: 0,
            terrain_to_place_on: None,
            layer_to_place_on: None,
            specific_land_id: None,
            ignore_terrain_restrictions: false,
            player_distance_command: false,
            minimum_player_distance_command: false,
            minimum_distance_to_players: 0,
            maximum_distance_to_players: None,
            minimum_distance_to_map_edge: 0,
            maximum_distance_to_other_zones: None,
            minimum_group_distance: 0,
            temporary_minimum_group_distance: 0,
            minimum_connected_tiles: -1,
            override_actor_radius_if_required: false,
            avoid_other_land_zones: false,
            avoid_other_land_zones_distance: 0,
            path_requirement: 0,
            actor_area: None,
            actor_area_to_place_in: None,
            avoid_actor_areas: Vec::new(),
            avoid_all_actor_areas: false,
            actor_area_radius: 1,
            object_class_filter: None,
            find_closest: false,
            find_closest_to_map_center: None,
            find_closest_to_map_edge: None,
            circular_placement: false,
            tile_shuffling: false,
            force_placement: false,
            remove_obstructions: false,
            generate_for_first_land_only: false,
            operation_index,
        })
    }

    pub(super) fn apply(
        &mut self,
        operation: &SemanticOperation,
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        match operation.name.as_str() {
            "number_of_groups" => {
                self.number_of_groups = rounded_nonnegative_u32(operation, 0, "number of groups")?;
                if self.grouping == ExactObjectGrouping::Default {
                    self.grouping = ExactObjectGrouping::Loose;
                }
            }
            "number_of_objects" => {
                self.number_of_objects = rounded_nonnegative_u32(operation, 0, "number of objects")?
            }
            "group_variance" => {
                self.group_variance = rounded_nonnegative_u32(operation, 0, "group variance")?
            }
            "group_placement_radius" => {
                self.group_placement_radius = u16_value(operation, 0, "group radius")?
            }
            "set_tight_grouping" => self.grouping = ExactObjectGrouping::Tight,
            "set_loose_grouping" => self.grouping = ExactObjectGrouping::Loose,
            "set_scaling_to_map_size" => self.scaling = ExactObjectScaling::MapSize,
            "set_scaling_to_player_number" => self.scaling = ExactObjectScaling::PlayerCount,
            "set_place_for_every_player" => self.place_for_every_player = true,
            "set_gaia_object_only" => self.gaia_object_only = true,
            "set_facet" => self.explicit_facet = Some(u16_value(operation, 0, "facet")?),
            "second_object" => {
                self.second_object_id = Some(object_argument(operation, 0, content)?);
                self.second_object_group_name = None;
            }
            "resource_delta" => self.resource_delta = rounded_numeric_i32(operation, 0)?,
            "set_gaia_unconvertible" => self.behavior_flags |= OBJECT_FLAG_GAIA_UNCONVERTIBLE,
            "set_building_capturable" => self.behavior_flags |= OBJECT_FLAG_BUILDING_CAPTURABLE,
            "make_indestructible" => self.behavior_flags |= OBJECT_FLAG_INDESTRUCTIBLE,
            "terrain_to_place_on" => {
                if operation.arguments.first().is_some_and(|argument| {
                    argument.resolution == ArgumentResolution::UndefinedNumericFallback
                }) {
                    self.terrain_to_place_on = None;
                    return Ok(());
                }
                let terrain = exact_terrain_argument(operation, 0, content, "RMSGEN6001")?;
                self.terrain_to_place_on = Some(terrain);
            }
            "layer_to_place_on" => {
                if operation.arguments.first().is_some_and(|argument| {
                    argument.resolution == ArgumentResolution::UndefinedNumericFallback
                }) {
                    self.layer_to_place_on = None;
                    return Ok(());
                }
                self.layer_to_place_on =
                    Some(exact_terrain_argument(operation, 0, content, "RMSGEN6001")?);
            }
            "place_on_specific_land_id" => {
                let authored = u16_value(operation, 0, "land id")?;
                self.specific_land_id = Some(authored.checked_add(10).ok_or_else(|| {
                    invalid_object(
                        "authored object land id exceeds its translated fixed-width range",
                    )
                })?);
            }
            "ignore_terrain_restrictions" => self.ignore_terrain_restrictions = true,
            "min_distance_to_players" => {
                self.player_distance_command = true;
                self.minimum_player_distance_command = true;
                self.minimum_distance_to_players = u16_value(operation, 0, "player distance")?;
            }
            "max_distance_to_players" => {
                self.player_distance_command = true;
                self.maximum_distance_to_players =
                    Some(u16_value(operation, 0, "maximum player distance")?)
            }
            "min_distance_to_map_edge" => {
                self.minimum_distance_to_map_edge = u16_value(operation, 0, "edge distance")?
            }
            "max_distance_to_other_zones" => {
                self.maximum_distance_to_other_zones =
                    Some(u16_value(operation, 0, "zone distance")?)
            }
            "min_distance_group_placement" => {
                self.minimum_group_distance = u16_value(operation, 0, "group distance")?
            }
            "temp_min_distance_group_placement" => {
                self.temporary_minimum_group_distance =
                    u16_value(operation, 0, "temporary group distance")?
            }
            "min_connected_tiles" => {
                self.minimum_connected_tiles = rounded_numeric_i32(operation, 0)?
            }
            "avoid_other_land_zones" => {
                self.avoid_other_land_zones = true;
                self.avoid_other_land_zones_distance = if operation.arguments.is_empty() {
                    0
                } else {
                    rounded_numeric_i32(operation, 0)?
                };
            }
            "require_path" => {
                let operand = if operation.arguments.is_empty() {
                    0
                } else {
                    rounded_numeric_i32(operation, 0)?
                };
                self.path_requirement = operand.wrapping_add(1);
            }
            "actor_area" => {
                self.actor_area = Some(rounded_numeric_i32(operation, 0)?);
            }
            "actor_area_to_place_in" => {
                self.actor_area_to_place_in = Some(rounded_numeric_i32(operation, 0)?)
            }
            "avoid_actor_area" => {
                if !operation.arguments.is_empty() {
                    self.avoid_actor_areas
                        .push(rounded_numeric_i32(operation, 0)?);
                }
            }
            "avoid_all_actor_areas" => self.avoid_all_actor_areas = true,
            "actor_area_radius" => {
                self.actor_area_radius = u16_value(operation, 0, "actor radius")?
            }
            "place_on_forest_zone" => {
                let class_id = content
                    .object_placement_classes()
                    .forest_zone_class_id
                    .ok_or_else(|| {
                        invalid_object("content lacks the forest-zone object-class binding")
                    })?;
                self.push_object_class_constraint(
                    ExactObjectClassFilterMode::Require,
                    class_id,
                    object_class_filter_radius(operation)?,
                );
            }
            "avoid_forest_zone" => {
                let class_id = content
                    .object_placement_classes()
                    .forest_zone_class_id
                    .ok_or_else(|| {
                        invalid_object("content lacks the forest-zone object-class binding")
                    })?;
                self.push_object_class_constraint(
                    ExactObjectClassFilterMode::Exclude,
                    class_id,
                    object_class_filter_radius(operation)?,
                );
            }
            "avoid_cliff_zone" => {
                let class_id = content
                    .object_placement_classes()
                    .cliff_zone_class_id
                    .ok_or_else(|| {
                        invalid_object("content lacks the cliff-zone object-class binding")
                    })?;
                self.push_object_class_constraint(
                    ExactObjectClassFilterMode::Exclude,
                    class_id,
                    object_class_filter_radius(operation)?,
                );
            }
            "find_closest" => self.find_closest = true,
            "find_closest_to_map_center" | "find_closest_to_map_edge" => {
                let direction = if operation.arguments.is_empty() {
                    0
                } else {
                    rounded_numeric_i32(operation, 0)?
                };
                let preference = if direction == 1 {
                    ExactObjectDistancePreference::Farthest
                } else {
                    ExactObjectDistancePreference::Nearest
                };
                if operation.name == "find_closest_to_map_center" {
                    self.find_closest_to_map_center = Some(preference);
                } else {
                    self.find_closest_to_map_edge = Some(preference);
                }
            }
            "set_circular_placement" => self.circular_placement = true,
            "enable_tile_shuffling" => self.tile_shuffling = true,
            "force_placement" => self.force_placement = true,
            "remove_obstructions" => self.remove_obstructions = true,
            "generate_for_first_land_only" => self.generate_for_first_land_only = true,
            "override_actor_radius_if_required" => self.override_actor_radius_if_required = true,
            name if object_block_command_effect(name) != ObjectBlockCommandEffect::Descriptor => {}
            _ => {
                return Err(invalid_object(&format!(
                    "the preview does not support the object attribute {}",
                    operation.name
                )));
            }
        }
        Ok(())
    }

    pub(super) fn push_object_class_constraint(
        &mut self,
        mode: ExactObjectClassFilterMode,
        class_id: u32,
        radius: u16,
    ) {
        let filter = self
            .object_class_filter
            .get_or_insert_with(|| ExactObjectClassFilter {
                mode,
                constraints: Vec::new(),
            });
        filter.mode = mode;
        filter
            .constraints
            .push(ExactObjectClassConstraint { class_id, radius });
    }
}

pub(super) fn effective_group_count(
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    dimensions: MapDimensions,
    _object_groups: &[ExactObjectGroup],
    _content: CompatibleContentView<'_>,
) -> Result<u32, GenerationError> {
    if descriptor.number_of_groups == 0
        || (descriptor.number_of_objects == 0
            && descriptor.grouping == ExactObjectGrouping::Default
            && descriptor.scaling != ExactObjectScaling::MapSize)
    {
        return Ok(0);
    }
    let promotes_default_members = default_members_use_outer_anchors(descriptor);
    if !promotes_default_members && descriptor.number_of_objects as usize > MAXIMUM_CREATED_OBJECTS
    {
        return Err(object_limit(
            "object group members",
            MAXIMUM_CREATED_OBJECTS,
        ));
    }
    let requested = if descriptor.number_of_objects == 0
        && descriptor.grouping == ExactObjectGrouping::Default
    {
        0
    } else if promotes_default_members && descriptor.number_of_objects > 1 {
        descriptor.number_of_objects
    } else {
        descriptor.number_of_groups
    };
    let groups = match descriptor.scaling {
        ExactObjectScaling::None => requested,
        ExactObjectScaling::MapSize => {
            let product = (requested as i32)
                .wrapping_mul(i32::from(dimensions.width))
                .wrapping_mul(i32::from(dimensions.height));
            (product / 10_000).max(1) as u32
        }
        ExactObjectScaling::PlayerCount => requested
            .checked_mul(setup.players.len() as u32)
            .ok_or_else(|| invalid_object("player-count object scaling overflow"))?,
    };
    Ok(groups)
}

pub(super) fn default_members_use_outer_anchors(descriptor: &ExactObjectDescriptor) -> bool {
    descriptor.number_of_objects > 1 && descriptor.grouping == ExactObjectGrouping::Default
}

pub(super) fn loose_group_uses_local_queue(descriptor: &ExactObjectDescriptor) -> bool {
    descriptor.grouping == ExactObjectGrouping::Loose
        && !(descriptor.number_of_objects == 1 && descriptor.group_variance == 0)
}

pub(super) const STARTING_VILLAGERS_RESOURCE: u32 = 84;

pub(super) fn starting_villager_group_count(
    descriptor: &ExactObjectDescriptor,
    land_local: bool,
    groups_requested: u32,
    owner: u8,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Option<u32> {
    if !land_local || groups_requested != 1 {
        return None;
    }
    let generation_start = descriptor
        .object_id
        .and_then(|object_id| content.object(object_id))
        .and_then(|object| object.single_request_count)?;
    Some(runtime_attributes.starting_villager_count(generation_start, owner))
}

pub(super) fn effective_group_member_count(
    descriptor: &ExactObjectDescriptor,
    rng: &mut RmsRandom,
) -> Result<u32, GenerationError> {
    let count = if descriptor.group_variance == 0 {
        i64::from(descriptor.number_of_objects)
    } else {
        let span = descriptor
            .group_variance
            .checked_mul(2)
            .ok_or_else(|| invalid_object("group variance overflow"))?;
        let sample = rng.bounded(span).result;
        i64::from(descriptor.number_of_objects) - i64::from(descriptor.group_variance)
            + i64::from(sample)
    };
    Ok(u32::try_from(count.max(1)).unwrap_or(u32::MAX))
}
