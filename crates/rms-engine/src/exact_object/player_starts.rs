use super::*;

const START_ATTEMPT_LIMIT: u32 = 5_000;

#[cfg(any(test, feature = "placement-oracle"))]
fn fallback_starts_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_FALLBACK_STARTS").is_some()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn finalize_player_starts(
    state: &mut ExactObjectState,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    semantic_program: &SemanticProgram,
    generation_program_mode: NativeGenerationProgramMode,
    content: CompatibleContentView<'_>,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    #[cfg(any(test, feature = "placement-oracle"))]
    if fallback_starts_disabled_for_attribution() {
        return Ok(());
    }
    if setup.players.iter().all(|player| {
        state
            .restriction_zones
            .objects
            .objects_from(0)
            .any(|(_, object)| object.owner == player.slot)
    }) {
        return Ok(());
    }
    let mut players = setup.players.iter().collect::<Vec<_>>();
    players.sort_by_key(|player| player.slot);
    let bindings = content
        .native_generation_bindings()
        .and_then(|bindings| bindings.player_start_bindings)
        .ok_or(GenerationError::IncompatibleContent)?;
    validate_start_resource_effects(semantic_program, bindings, content)?;
    let generation_start_villagers = content
        .object(bindings.villager_object_id)
        .and_then(|object| object.single_request_count)
        .ok_or(GenerationError::IncompatibleContent)?;
    let mut objects = state.module_exit_pieces.clone();
    let piece_count = objects.len();
    objects.extend(state.objects.iter().cloned());
    let internal_start = objects.len();
    let construction_positions = state
        .scripted_position_overrides
        .iter()
        .map(|(index, position)| (piece_count + index, *position))
        .collect();
    let mut operations = vec![u32::MAX; objects.len()];
    let mut auxiliary_rng = RmsRandom::from_state(state.auxiliary_rng_state);
    let mut foundation = FoundationMap {
        restriction_zones: state.restriction_zones.clone(),
        next_instance_id: state.post_rms_next_instance_id,
        dimensions: state.dimensions,
        generation_program_mode,
        automatic_technologies: state.automatic_technologies.take(),
        content,
        runtime_attributes: state.runtime_attributes.as_ref(),
        terrain: &mut state.terrain,
        land_id: &mut state.land_id,
        operation_indices: &mut state.tile_operation_indices,
        work: 0,
        painted: 0,
        construction_positions,
        pending_neighbor_completion: Vec::new(),
        obstruction_index: ObstructionIndex::default(),
        lifecycle_projection: LifecycleProjection::default(),
        list_classes: ListClassIndex::default(),
        stale_links: StaleHeaderLinks::default(),
        foundation_terrain_remap: state.foundation_terrain_remap,
        viewing_player: viewing_player(setup),
        deferred_foundations: DeferredFoundations::immediate(),
    };
    for player in players {
        if foundation
            .restriction_zones
            .objects
            .objects_from(0)
            .any(|(_, object)| object.owner == player.slot)
        {
            continue;
        }
        let packed = content
            .civilization_attribute_value(
                player.civilization_id,
                bindings.packed_town_center_attribute_id,
            )
            .ok_or(GenerationError::IncompatibleContent)?;
        let live_replacement =
            !resource_rule_disabled(ResourceRuleSwitch::LiveReplacementResources);
        let live_villagers = !resource_rule_disabled(ResourceRuleSwitch::StartingVillagers);
        let attributes = foundation.runtime_attributes;
        let packed = if live_replacement {
            attributes.effective_player_resource(
                player.slot,
                bindings.packed_town_center_attribute_id.0,
                packed,
            )
        } else {
            packed
        };
        let town_center = if !setup.computer_player_slots.contains(player.slot) && packed > 0.0 {
            bindings.packed_town_center_object_id
        } else {
            bindings.town_center_object_id
        };
        let town_center = content.substituted_object(player.civilization_id, town_center);
        let definition = foundation
            .runtime_attributes
            .definition(town_center, player.slot, content)
            .ok_or_else(|| missing_object_definition(town_center))?;
        let collision = definition.collision_half_extents();
        let mut center = None;
        for attempt in 1..=START_ATTEMPT_LIMIT {
            cancellation_checkpoint(cancellation, GenerationStage::Finalize, u64::from(attempt))?;
            let position = [
                start_axis(
                    player_sample(&mut foundation)?,
                    state.dimensions.height,
                    collision[0],
                ),
                start_axis(
                    player_sample(&mut foundation)?,
                    state.dimensions.width,
                    collision[1],
                ),
            ];
            if attempt == START_ATTEMPT_LIMIT {
                break;
            }
            if start_position_allows(
                position,
                town_center,
                player.slot,
                setup,
                connection,
                &state.terrain_appearances,
                &objects,
                &foundation,
            )? {
                center = Some(position);
                break;
            }
        }
        let Some(center) = center else {
            continue;
        };
        let descriptor = start_descriptor(town_center);
        construct_one_at(
            town_center,
            center,
            player.slot,
            &descriptor,
            setup,
            content,
            &mut auxiliary_rng,
            &mut objects,
            &mut operations,
            &mut foundation,
            0,
            None,
        )?;
        let configured_scout = content
            .civilization_object_attribute(
                player.civilization_id,
                bindings.starting_scout_attribute_id,
            )
            .ok_or(GenerationError::IncompatibleContent)?;
        let configured_scout = if live_replacement {
            u32::try_from(truncate_f32_to_i32(attributes.effective_player_resource(
                player.slot,
                bindings.starting_scout_attribute_id.0,
                configured_scout.0 as f32,
            )))
            .ok()
            .map(ObjectId)
        } else {
            Some(configured_scout)
        };
        let scout = match configured_scout {
            Some(scout) if object_available_to_owner(scout, player.slot, setup, content)? => scout,
            _ => bindings.fallback_scout_object_id,
        };
        let villagers = if live_villagers {
            truncate_f32_to_i32(attributes.effective_player_resource(
                player.slot,
                bindings.starting_villagers_attribute_id.0,
                generation_start_villagers as f32,
            ))
        } else {
            i32::try_from(generation_start_villagers).unwrap_or(i32::MAX)
        };
        let total = villagers.wrapping_add(1).max(0) as u32;
        if total as usize > MAXIMUM_CREATED_OBJECTS {
            return Err(object_limit(
                "fallback starting units",
                MAXIMUM_CREATED_OBJECTS,
            ));
        }
        let mut attempts = 0;
        for ordinal in 0..total {
            let source = if ordinal == 0 {
                scout
            } else if player_sample(&mut foundation)? % 100 < 50 {
                bindings.villager_object_id
            } else {
                bindings.alternate_villager_object_id
            };
            let object_id = content.substituted_object(player.civilization_id, source);
            attempts += 1;
            while attempts < START_ATTEMPT_LIMIT {
                cancellation_checkpoint(
                    cancellation,
                    GenerationStage::Finalize,
                    u64::from(attempts),
                )?;
                let x = player_sample(&mut foundation)? * 6 / 32_767 - 2;
                let y = player_sample(&mut foundation)? * 6 / 32_767 - 2;
                let fx = player_sample(&mut foundation)? / 32_767;
                let fy = player_sample(&mut foundation)? / 32_767;
                let position = [
                    (x as f32 + center[0]) + fx as f32,
                    (y as f32 + center[1]) + fy as f32,
                ];
                if start_position_allows(
                    position,
                    object_id,
                    player.slot,
                    setup,
                    connection,
                    &state.terrain_appearances,
                    &objects,
                    &foundation,
                )? {
                    construct_one_at(
                        object_id,
                        position,
                        player.slot,
                        &start_descriptor(object_id),
                        setup,
                        content,
                        &mut auxiliary_rng,
                        &mut objects,
                        &mut operations,
                        &mut foundation,
                        0,
                        None,
                    )?;
                    break;
                }
                attempts += 1;
            }
        }
    }
    state.post_rms_objects = objects.split_off(internal_start);
    state.post_rms_positions = foundation
        .construction_positions
        .range(internal_start..)
        .map(|(index, position)| (index - internal_start, *position))
        .collect();
    state.post_rms_next_instance_id = foundation.next_instance_id;
    state.restriction_zones = foundation.restriction_zones;
    state.automatic_technologies = foundation.automatic_technologies;
    state.auxiliary_rng_state = auxiliary_rng.state();
    compact_destroyed_projection(
        &mut state.objects,
        &mut state.object_operation_indices,
        &mut state.scripted_position_overrides,
        &state.restriction_zones.objects,
    )?;
    let mut internal_operations = vec![u32::MAX; state.post_rms_objects.len()];
    compact_destroyed_projection(
        &mut state.post_rms_objects,
        &mut internal_operations,
        &mut state.post_rms_positions,
        &state.restriction_zones.objects,
    )?;
    state.module_exit_pieces.retain(|object| {
        !state
            .restriction_zones
            .objects
            .was_destroyed(object.instance_id)
    });
    Ok(())
}

fn player_sample(foundation: &mut FoundationMap<'_>) -> Result<i32, GenerationError> {
    let automatic = foundation.automatic_technologies.as_mut().ok_or_else(|| {
        invalid_object("fallback player RNG was not initialized at world creation")
    })?;
    Ok((automatic.variant_rng.next_u32() & 0x7fff) as i32)
}

fn start_axis(sample: i32, dimension: u16, half_extent: f32) -> f32 {
    let integer = 15 + sample * (i32::from(dimension) - 30) / 32_767;
    integer as f32 + if half_extent.fract() > 0.0 { 0.5 } else { 0.0 }
}

fn start_descriptor(object_id: ObjectId) -> ExactObjectDescriptor {
    game_mode_player_object_descriptor(rms_content::GameModePlayerObjectRule {
        game_mode_raw: 0,
        object_id,
        anchor_object_id: object_id,
        inner_radius: 0,
        outer_radius: 0,
    })
}

#[allow(clippy::too_many_arguments)]
fn start_position_allows(
    position: [f32; 2],
    object_id: ObjectId,
    owner: u8,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    appearances: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    foundation: &FoundationMap<'_>,
) -> Result<bool, GenerationError> {
    if position[0] < 0.0
        || position[1] < 0.0
        || position[0] >= f32::from(connection.dimensions.width)
        || position[1] >= f32::from(connection.dimensions.height)
    {
        return Ok(false);
    }
    let attributes = foundation.runtime_attributes;
    let definition = attributes
        .definition(object_id, owner, foundation.content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    let restriction = attributes.master_restriction_id(object_id, owner, definition);
    Ok(master_terrain_rejection_at_position(
        position,
        definition,
        connection.dimensions,
        foundation.terrain,
        foundation.content,
        false,
        restriction,
    )
    .is_none()
        && master_slope_allows_position(
            position,
            definition,
            owner,
            connection.dimensions,
            &connection.elevation,
            attributes,
        )
        && master_obstruction_scan(
            position,
            definition,
            owner,
            appearances,
            objects,
            &foundation.construction_positions,
            foundation.terrain,
            foundation.content,
            attributes,
            Some(Class39PlacementContext {
                setup,
                roster: &foundation.restriction_zones.objects,
                master_restriction: restriction,
            }),
            ObstructionCallMode::FallbackStart,
            None,
        )?)
}

fn validate_start_resource_effects(
    program: &SemanticProgram,
    bindings: rms_content::PlayerStartBindings,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let effects = [
        "MOD_RESOURCE",
        "MUL_RESOURCE",
        "GAIA_MOD_RESOURCE",
        "GAIA_MUL_RESOURCE",
    ]
    .into_iter()
    .filter_map(|name| content.rms_implicit_definition(name))
    .collect::<BTreeSet<_>>();
    let mut attributes = Vec::new();
    if resource_rule_disabled(ResourceRuleSwitch::LiveReplacementResources) {
        attributes.push(bindings.packed_town_center_attribute_id.0);
        attributes.push(bindings.starting_scout_attribute_id.0);
    }
    if resource_rule_disabled(ResourceRuleSwitch::StartingVillagers) {
        attributes.push(bindings.starting_villagers_attribute_id.0);
    }
    if program.operations.iter().any(|operation| {
        operation.accepted_by_target_parser()
            && matches!(operation.name.as_str(), "effect_amount" | "effect_percent")
            && numeric_i32(operation, 0)
                .ok()
                .is_some_and(|effect| effects.contains(&effect))
            && numeric_i32(operation, 1)
                .ok()
                .is_some_and(|attribute| attributes.contains(&(attribute as u32)))
    }) {
        return Err(invalid_object(
            "fallback player starts after RMS changes to a starting resource are unsupported",
        ));
    }
    Ok(())
}
