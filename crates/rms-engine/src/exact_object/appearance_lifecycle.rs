use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TerrainAppearanceObjects {
    pub(super) dimensions: MapDimensions,
    pub(super) module_entry_objects: Vec<ExactAppearanceObject>,
    pub(super) objects: Vec<ExactAppearanceObject>,
}

impl TerrainAppearanceObjects {
    #[allow(clippy::too_many_arguments)]
    fn matching_object_in_window(
        &self,
        appearances: &[ExactAppearanceObject],
        minimum_x: u32,
        minimum_y: u32,
        maximum_x: u32,
        maximum_y: u32,
        predicate: &impl Fn(&ObjectDefinition) -> bool,
        terrain: &[TerrainId],
        content: CompatibleContentView<'_>,
    ) -> bool {
        let width = usize::from(self.dimensions.width);
        for y in minimum_y..=maximum_y {
            for x in minimum_x..=maximum_x {
                let index = y as usize * width + x as usize;
                let index_u32 =
                    u32::try_from(index).expect("validated exact map tile index fits in u32");
                let mut cursor =
                    appearances.partition_point(|appearance| appearance.tile_index < index_u32);
                while let Some(appearance) = appearances.get(cursor) {
                    if appearance.tile_index != index_u32 {
                        break;
                    }
                    if appearance_matches(appearance, index, predicate, terrain, content) {
                        return true;
                    }
                    cursor += 1;
                }
            }
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn any_of_class_in_window(
        &self,
        coordinate: MapCoordinate,
        negative_extent: u32,
        positive_extent: u32,
        class_id: u32,
        terrain: &[TerrainId],
        content: CompatibleContentView<'_>,
        index: Option<&AppearanceClassIndex>,
        terrain_writes: Option<u64>,
    ) -> bool {
        let predicate = |definition: &ObjectDefinition| definition.class_id == class_id;
        if let Some(index) = index {
            let minimum_x = u32::from(coordinate.x).saturating_sub(negative_extent);
            let minimum_y = u32::from(coordinate.y).saturating_sub(negative_extent);
            let maximum_x = u32::from(coordinate.x)
                .saturating_add(positive_extent)
                .min(u32::from(self.dimensions.width.saturating_sub(1)));
            let maximum_y = u32::from(coordinate.y)
                .saturating_add(positive_extent)
                .min(u32::from(self.dimensions.height.saturating_sub(1)));
            if let Some(found) = index.any_in_window(
                self,
                class_id,
                coordinate,
                [minimum_x, minimum_y],
                [maximum_x, maximum_y],
                |appearance, tile| {
                    appearance_matches(appearance, tile, &predicate, terrain, content)
                },
                content,
                terrain_writes.map(|writes| TerrainVersion::of(terrain, writes)),
            ) {
                return found;
            }
        }
        self.any_in_window(
            coordinate,
            negative_extent,
            positive_extent,
            predicate,
            terrain,
            content,
        )
    }
}

pub(super) fn appearance_matches(
    appearance: &ExactAppearanceObject,
    tile: usize,
    predicate: &impl Fn(&ObjectDefinition) -> bool,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
) -> bool {
    terrain.get(tile) == Some(&appearance.source_terrain_id)
        && content.object(appearance.object_id).is_some_and(predicate)
}

impl TerrainAppearanceObjects {
    pub(super) fn any_in_window(
        &self,
        coordinate: MapCoordinate,
        negative_extent: u32,
        positive_extent: u32,
        predicate: impl Fn(&ObjectDefinition) -> bool,
        terrain: &[TerrainId],
        content: CompatibleContentView<'_>,
    ) -> bool {
        let minimum_x = u32::from(coordinate.x).saturating_sub(negative_extent);
        let minimum_y = u32::from(coordinate.y).saturating_sub(negative_extent);
        let maximum_x = u32::from(coordinate.x)
            .saturating_add(positive_extent)
            .min(u32::from(self.dimensions.width.saturating_sub(1)));
        let maximum_y = u32::from(coordinate.y)
            .saturating_add(positive_extent)
            .min(u32::from(self.dimensions.height.saturating_sub(1)));
        self.matching_object_in_window(
            &self.module_entry_objects,
            minimum_x,
            minimum_y,
            maximum_x,
            maximum_y,
            &predicate,
            terrain,
            content,
        ) || self.matching_object_in_window(
            &self.objects,
            minimum_x,
            minimum_y,
            maximum_x,
            maximum_y,
            &predicate,
            terrain,
            content,
        )
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn consume_terrain_appearance_rng(
    connection: &ExactConnectionState,
    pieces: &[PlacedObject],
    retained_module_entry_appearances: &[ExactAppearanceObject],
    blocking_module_entry_appearances: &[ExactAppearanceObject],
    mut next_instance_id: u32,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    restriction_zones: &mut ExactRestrictionZones,
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<TerrainAppearanceObjects, GenerationError> {
    let mut objects = Vec::new();
    let mut collision_objects = blocking_module_entry_appearances.to_vec();
    let mut module_entry_blockers = collision_objects.len();
    let mut collision_index = AppearanceObstructionIndex::default();
    for (tile_index, terrain_id) in connection.terrain.iter().copied().enumerate() {
        let terrain = content
            .terrain(terrain_id)
            .expect("terrain content was validated before appearance RNG");
        let tile = MapCoordinate {
            x: u16::try_from(tile_index % usize::from(connection.dimensions.width))
                .map_err(|_| invalid_object("terrain appearance tile X exceeds u16"))?,
            y: u16::try_from(tile_index / usize::from(connection.dimensions.width))
                .map_err(|_| invalid_object("terrain appearance tile Y exceeds u16"))?,
        };
        std::sync::Arc::make_mut(&mut restriction_zones.objects).retire_tile_members_matching(
            tile,
            0,
            |object_id| {
                terrain
                    .appearances
                    .iter()
                    .rev()
                    .any(|appearance| appearance.object_id == Some(object_id))
            },
        )?;
        let retired = retire_module_entry_blockers(
            &mut collision_objects,
            &mut module_entry_blockers,
            tile_index,
            &terrain.appearances,
        );
        if retired {
            collision_index = AppearanceObstructionIndex::default();
        }
        consume_terrain_appearances(
            &terrain.appearances,
            rng,
            auxiliary_rng,
            GenerationStage::Objects,
            cancellation,
            |candidate, auxiliary| {
                if !appearance_candidate_allows_indexed(
                    tile_index,
                    candidate,
                    connection.dimensions,
                    &collision_objects,
                    pieces,
                    &connection.terrain,
                    content,
                    runtime_attributes,
                    Some(&collision_index),
                )? {
                    return Ok(false);
                }
                let auxiliary_sample = match candidate.object_id {
                    Some(_) if appearance_profile_rule_disabled_for_attribution() => {
                        Some(auxiliary.next_u32())
                    }
                    Some(object_id) => {
                        let (_, profile) =
                            appearance_creation_profile(object_id, content, runtime_attributes)?;
                        appearance_creation_draws(profile, auxiliary)
                    }
                    None => Some(auxiliary.next_u32()),
                };
                let appearance = AppearanceAcceptance {
                    object_id: candidate.object_id,
                    placement: candidate.placement,
                    x_sample: candidate.x_sample,
                    y_sample: candidate.y_sample,
                    auxiliary_sample,
                };
                if let Some(appearance) =
                    ExactAppearanceObject::from_acceptance(tile_index, terrain_id, appearance)
                {
                    let (x, y) = appearance_position(
                        tile_index,
                        appearance.placement,
                        appearance.x_sample,
                        appearance.y_sample,
                        connection.dimensions,
                    )?;
                    let hit_points =
                        runtime_attributes.initial_hit_points(appearance.object_id, 0, content)?;
                    let definition = runtime_attributes
                        .definition(appearance.object_id, 0, content)
                        .ok_or_else(|| missing_object_definition(appearance.object_id))?;
                    std::sync::Arc::make_mut(&mut restriction_zones.objects).birth_on_terrain(
                        next_instance_id,
                        appearance.object_id,
                        0,
                        definition.initial_lifecycle_state,
                        [x, y],
                        connection.dimensions,
                        hit_points,
                        definition.pathing,
                        definition.collision_half_extents(),
                        definition.position_family,
                        Some(&connection.terrain),
                    )?;
                    next_instance_id = next_instance_id
                        .checked_add(1)
                        .ok_or_else(|| invalid_object("appearance identity exceeds u32"))?;
                    restriction_zones.construct(
                        appearance.object_id,
                        0,
                        connection.dimensions,
                        &connection.terrain,
                        content,
                    )?;
                    collision_objects.push(appearance);
                    objects.push(appearance);
                }
                Ok(true)
            },
        )?;
    }
    let mut module_entry_objects = retained_module_entry_appearances.to_vec();
    module_entry_objects.sort_unstable_by_key(|appearance| appearance.tile_index);
    Ok(TerrainAppearanceObjects {
        dimensions: connection.dimensions,
        module_entry_objects,
        objects,
    })
}

pub(super) fn retire_module_entry_blockers(
    collision_objects: &mut Vec<ExactAppearanceObject>,
    module_entry_blockers: &mut usize,
    tile_index: usize,
    table: &[rms_content::TerrainAppearanceDefinition],
) -> bool {
    let retires = |blocker: &ExactAppearanceObject| {
        blocker.tile_index as usize == tile_index
            && table
                .iter()
                .any(|appearance| appearance.object_id == Some(blocker.object_id))
    };
    if !collision_objects[..*module_entry_blockers]
        .iter()
        .any(retires)
    {
        return false;
    }
    let accepted = collision_objects.split_off(*module_entry_blockers);
    collision_objects.retain(|blocker| !retires(blocker));
    *module_entry_blockers = collision_objects.len();
    collision_objects.extend(accepted);
    true
}

pub(super) fn rebase_module_entry_appearance(
    mut appearance: ExactAppearanceObject,
    live_tile: MapCoordinate,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
) -> Result<ExactAppearanceObject, GenerationError> {
    if live_tile.x >= dimensions.width || live_tile.y >= dimensions.height {
        return Err(invalid_object(
            "module-entry appearance live tile lies outside map",
        ));
    }
    let tile_index =
        usize::from(live_tile.y) * usize::from(dimensions.width) + usize::from(live_tile.x);
    appearance.tile_index = u32::try_from(tile_index)
        .map_err(|_| invalid_object("module-entry appearance tile exceeds u32"))?;
    appearance.source_terrain_id = *terrain
        .get(tile_index)
        .ok_or_else(|| invalid_object("module-entry appearance terrain is unavailable"))?;
    Ok(appearance)
}

pub(super) fn module_entry_appearance_blocks_refresh(
    original: ExactAppearanceObject,
    rebased: ExactAppearanceObject,
) -> bool {
    original.source_terrain_id != rebased.source_terrain_id
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn appearance_candidate_allows(
    tile_index: usize,
    candidate: AppearanceCandidate,
    dimensions: MapDimensions,
    existing: &[ExactAppearanceObject],
    pieces: &[PlacedObject],
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    appearance_candidate_allows_indexed(
        tile_index,
        candidate,
        dimensions,
        existing,
        pieces,
        terrain,
        content,
        runtime_attributes,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn appearance_candidate_allows_in_world(
    tile_index: usize,
    candidate: AppearanceCandidate,
    dimensions: MapDimensions,
    roster: &super::super::exact_world::ObjectRoster,
    terrain: &[TerrainId],
    elevation: &[i16],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    if !appearance_candidate_allows(
        tile_index,
        candidate,
        dimensions,
        &[],
        &[],
        terrain,
        content,
        runtime_attributes,
    )? {
        return Ok(false);
    }
    let Some(object_id) = candidate.object_id else {
        return Ok(true);
    };
    let definition = runtime_attributes
        .definition(object_id, 0, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    let (x, y) = appearance_input_position(
        tile_index,
        candidate.placement,
        candidate.x_sample,
        candidate.y_sample,
        dimensions,
    )?;
    if !master_slope_allows_position(
        [x, y],
        definition,
        0,
        dimensions,
        elevation,
        runtime_attributes,
    ) {
        return Ok(false);
    }
    let placement = definition.placement_half_extents();
    if definition.placement_collision == ObjectPlacementCollision::None
        || (placement[0] <= 0.0 && placement[1] <= 0.0)
    {
        return Ok(true);
    }
    let mut live_definition = runtime_attributes.scan_definition_lookup(content);
    for (_, occupant) in roster.registered_objects() {
        if occupant.lifecycle >= 7 {
            continue;
        }
        let existing = live_definition(occupant.object_id, occupant.owner)
            .ok_or_else(|| missing_object_definition(occupant.object_id))?;
        if existing.can_be_built_on || existing.obstruction == ObstructionKind::None {
            continue;
        }
        let extents = existing.collision_half_extents();
        let [existing_x, existing_y] = occupant.position_bits.map(f32::from_bits);
        if extents[0] > 0.0
            && extents[1] > 0.0
            && (existing_x - x).abs() < placement[0] + extents[0]
            && (existing_y - y).abs() < placement[1] + extents[1]
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn appearance_candidate_allows_indexed(
    tile_index: usize,
    candidate: AppearanceCandidate,
    dimensions: MapDimensions,
    existing: &[ExactAppearanceObject],
    pieces: &[PlacedObject],
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    index: Option<&AppearanceObstructionIndex>,
) -> Result<bool, GenerationError> {
    let mut live_definition = runtime_attributes.scan_definition_lookup(content);
    let Some(object_id) = candidate.object_id else {
        return Ok(true);
    };
    let definition =
        live_definition(object_id, 0).ok_or_else(|| missing_object_definition(object_id))?;
    let restriction_id = runtime_attributes
        .master_restriction_id(object_id, 0, definition)
        .ok_or_else(|| invalid_object("terrain appearance master lacks a placement restriction"))?;
    let restriction = content
        .restriction(restriction_id)
        .ok_or_else(|| invalid_object("terrain appearance placement restriction is unavailable"))?;
    let placement = definition.placement_half_extents();
    let (candidate_x, candidate_y) = appearance_input_position(
        tile_index,
        candidate.placement,
        candidate.x_sample,
        candidate.y_sample,
        dimensions,
    )?;
    let lower_x = candidate_x - placement[0];
    let lower_y = candidate_y - placement[1];
    let upper_x = (placement[0] + candidate_x) - 0.001_f32;
    let upper_y = (placement[1] + candidate_y) - 0.001_f32;
    if lower_x < 0.0
        || lower_y < 0.0
        || upper_x >= f32::from(dimensions.width)
        || upper_y >= f32::from(dimensions.height)
    {
        return Ok(false);
    }
    let width = usize::from(dimensions.width);
    for y in lower_y as usize..=upper_y as usize {
        for x in lower_x as usize..=upper_x as usize {
            let terrain_id = *terrain
                .get(y * width + x)
                .ok_or_else(|| invalid_object("terrain appearance restriction tile is absent"))?;
            if crate::exact_zone::rejects_placement(restriction, terrain_id).ok_or_else(|| {
                invalid_object("terrain appearance numeric restriction cost is unavailable")
            })? {
                return Ok(false);
            }
        }
    }
    if definition.placement_collision == ObjectPlacementCollision::None
        || (placement[0] <= 0.0 && placement[1] <= 0.0)
    {
        return Ok(true);
    }
    let overlaps = |x: f32, y: f32, extents: [f32; 2]| {
        extents[0] > 0.0
            && extents[1] > 0.0
            && (x - candidate_x).abs() < placement[0] + extents[0]
            && (y - candidate_y).abs() < placement[1] + extents[1]
    };
    for piece in pieces {
        let existing_definition = live_definition(piece.object_id, piece.owner)
            .ok_or_else(|| missing_object_definition(piece.object_id))?;
        if !existing_definition.can_be_built_on
            && existing_definition.obstruction != ObstructionKind::None
            && piece.status != 7
            && piece.death_state != 7
            && overlaps(
                piece.x_256 as f32 / 256.0,
                piece.y_256 as f32 / 256.0,
                existing_definition.collision_half_extents(),
            )
        {
            return Ok(false);
        }
    }
    let mut scan = |visits: Option<&[u32]>| -> Result<bool, GenerationError> {
        for existing_index in VisitOrder::of(visits, existing.len()) {
            let appearance = &existing[existing_index];
            let existing_definition = live_definition(appearance.object_id, 0)
                .ok_or_else(|| missing_object_definition(appearance.object_id))?;
            if existing_definition.can_be_built_on
                || existing_definition.obstruction == ObstructionKind::None
                || existing_definition.footprint_width_256 == 0
                || existing_definition.footprint_height_256 == 0
            {
                continue;
            }
            let existing_index = usize::try_from(appearance.tile_index)
                .map_err(|_| invalid_object("terrain appearance tile index exceeds usize"))?;
            let (existing_x, existing_y) = appearance_position(
                existing_index,
                appearance.placement,
                appearance.x_sample,
                appearance.y_sample,
                dimensions,
            )?;
            if overlaps(
                existing_x,
                existing_y,
                existing_definition.collision_half_extents(),
            ) {
                return Ok(false);
            }
        }
        Ok(true)
    };
    let Some(index) = index else {
        return scan(None);
    };
    let admission = |appearance: &ExactAppearanceObject| {
        let Some(existing_definition) =
            runtime_attributes.definition(appearance.object_id, 0, content)
        else {
            return AppearanceAdmission::Always;
        };
        let half_extents = existing_definition.collision_half_extents();
        if existing_definition.can_be_built_on
            || existing_definition.obstruction == ObstructionKind::None
            || existing_definition.footprint_width_256 == 0
            || existing_definition.footprint_height_256 == 0
            || half_extents[0] <= 0.0
            || half_extents[1] <= 0.0
        {
            return AppearanceAdmission::Skip;
        }
        match appearance_position(
            appearance.tile_index as usize,
            appearance.placement,
            appearance.x_sample,
            appearance.y_sample,
            dimensions,
        ) {
            Ok((x, y)) => AppearanceAdmission::Footprint {
                center: [x, y],
                half_extents,
            },
            Err(_) => AppearanceAdmission::Always,
        }
    };
    let center = [candidate_x, candidate_y];
    match crate::placement_oracle::mode() {
        crate::placement_oracle::PlacementCheckMode::Accelerated => {
            match index.visits(existing, dimensions, center, placement, admission) {
                Some(visits) => scan(Some(visits.indices())),
                None => scan(None),
            }
        }
        crate::placement_oracle::PlacementCheckMode::Reference => scan(None),
        crate::placement_oracle::PlacementCheckMode::Differential => {
            let reference = scan(None);
            let accelerated = match index.visits(existing, dimensions, center, placement, admission)
            {
                Some(visits) => scan(Some(visits.indices())),
                None => scan(None),
            };
            crate::placement_oracle::compare(
                crate::placement_oracle::OracleCheck::AppearanceObstruction,
                &reference,
                &accelerated,
                || {
                    format!(
                        "appearance candidate on tile {tile_index}, {} accepted",
                        existing.len()
                    )
                },
            );
            reference
        }
    }
}

pub(crate) fn appearance_position(
    tile_index: usize,
    placement: TerrainAppearancePlacement,
    x_sample: Option<u32>,
    y_sample: Option<u32>,
    dimensions: MapDimensions,
) -> Result<(f32, f32), GenerationError> {
    let (x, y) = appearance_input_position(tile_index, placement, x_sample, y_sample, dimensions)?;
    let [x, y] = transfer_base_position([x, y], dimensions)?;
    Ok((x, y))
}

pub(super) fn transfer_base_position(
    mut position: [f32; 2],
    dimensions: MapDimensions,
) -> Result<[f32; 2], GenerationError> {
    if dimensions.width == 0 || dimensions.height == 0 || position.iter().any(|v| !v.is_finite()) {
        return Err(invalid_object(
            "base position input or dimensions are invalid",
        ));
    }
    for (value, extent) in position
        .iter_mut()
        .zip([dimensions.width, dimensions.height])
    {
        if *value < 0.0 {
            *value = 0.0;
        }
        if *value >= f32::from(extent) {
            *value = f32::from(extent) - 0.001_f32;
        }
    }
    Ok(position)
}

pub(super) fn transfer_constructed_position(
    mut position: [f32; 2],
    family: Option<ObjectPositionFamily>,
    movement_speed_f32_bits: Option<u32>,
    collision_half_extents: [f32; 2],
    dimensions: MapDimensions,
) -> Result<[f32; 2], GenerationError> {
    if matches!(
        family,
        Some(
            ObjectPositionFamily::Moving
                | ObjectPositionFamily::Combat
                | ObjectPositionFamily::Building
        )
    ) {
        let speed = movement_speed_f32_bits
            .map(f32::from_bits)
            .ok_or_else(|| invalid_object("moving position speed is unavailable"))?;
        if !speed.is_finite() {
            return Err(invalid_object("moving position speed is nonfinite"));
        }
        if speed > f32::from_bits(0x33d6_bf95) {
            if collision_half_extents
                .iter()
                .any(|extent| !extent.is_finite() || extent.is_sign_negative())
            {
                return Err(invalid_object(
                    "moving position collision geometry is unavailable",
                ));
            }
            for axis in 0..2 {
                let radius = collision_half_extents[axis];
                let margin = radius + 0.01_f32;
                if !margin.is_finite() {
                    return Err(invalid_object(
                        "moving position collision margin is nonfinite",
                    ));
                }
                if position[axis] < margin {
                    position[axis] = margin;
                } else if position[axis] > f32::from(dimensions.width) - margin {
                    position[axis] = (f32::from(dimensions.width) - radius) - 0.01_f32;
                }
            }
        }
    }
    transfer_base_position(position, dimensions)
}

pub(super) fn appearance_input_position(
    tile_index: usize,
    placement: TerrainAppearancePlacement,
    x_sample: Option<u32>,
    y_sample: Option<u32>,
    dimensions: MapDimensions,
) -> Result<(f32, f32), GenerationError> {
    if dimensions.width == 0 || dimensions.height == 0 {
        return Err(invalid_object("appearance dimensions are empty"));
    }
    let width = usize::from(dimensions.width);
    let tile_x = tile_index % width;
    let tile_y = tile_index / width;
    if tile_y >= usize::from(dimensions.height) {
        return Err(invalid_object("terrain appearance tile lies outside map"));
    }
    match placement {
        TerrainAppearancePlacement::Randomized => {
            let x_sample = x_sample
                .ok_or_else(|| invalid_object("randomized appearance lacks an X sample"))?;
            let y_sample =
                y_sample.ok_or_else(|| invalid_object("randomized appearance lacks a Y sample"))?;
            Ok((
                appearance_axis(tile_x as u32, x_sample),
                appearance_axis(tile_y as u32, y_sample),
            ))
        }
        TerrainAppearancePlacement::Centered => {
            if x_sample.is_some() || y_sample.is_some() {
                return Err(invalid_object(
                    "centered appearance unexpectedly retained coordinate samples",
                ));
            }
            Ok((tile_x as f32 + 0.5, tile_y as f32 + 0.5))
        }
    }
}

pub(super) fn module_entry_retirement_mask(
    identities: impl IntoIterator<Item = u32>,
    removed: &BTreeSet<u32>,
    roster: &super::exact_world::ObjectRoster,
) -> Result<Vec<bool>, GenerationError> {
    identities
        .into_iter()
        .map(
            |identity| match (roster.object(identity), removed.contains(&identity)) {
                (Some(object), false) => Ok(object.lifecycle == 7),
                (None, true) => Ok(false),
                _ => Err(invalid_object(
                    "appearance lifetime disagrees with the live roster",
                )),
            },
        )
        .collect()
}

pub(super) fn materialize_appearance_objects(
    appearances: &[ExactAppearanceObject],
    dimensions: MapDimensions,
    elevation: &[i16],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    next_instance_id: &mut u32,
) -> Result<Vec<PlacedObject>, GenerationError> {
    let mut objects = Vec::with_capacity(appearances.len());
    for appearance in appearances {
        objects.push(materialize_appearance_object(
            appearance,
            *next_instance_id,
            dimensions,
            elevation,
            content,
            runtime_attributes,
        )?);
        *next_instance_id = next_instance_id
            .checked_add(1)
            .ok_or_else(|| invalid_object("object instance identity exceeds u32"))?;
    }
    Ok(objects)
}

pub(super) fn materialize_appearance_object(
    appearance: &ExactAppearanceObject,
    instance_id: u32,
    dimensions: MapDimensions,
    elevation: &[i16],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<PlacedObject, GenerationError> {
    let (definition, profile) =
        appearance_creation_profile(appearance.object_id, content, runtime_attributes)?;
    if profile.random_angle || profile.random_combat_seed {
        return Err(GenerationError::IncompatibleContent);
    }
    let (x, y) = appearance_position(
        appearance.tile_index as usize,
        appearance.placement,
        appearance.x_sample,
        appearance.y_sample,
        dimensions,
    )?;
    let x_256 = fixed_256(x);
    let y_256 = fixed_256(y);
    let facet = appearance_facet(profile, appearance.auxiliary_sample);
    let resources = runtime_attributes.initial_resources(definition, 0, content)?;
    Ok(PlacedObject {
        instance_id,
        object_id: appearance.object_id,
        x_256,
        y_256,
        z_256: super::exact_elevation::terrain_height_from_f32(x, y, dimensions, elevation)
            .ok_or_else(|| invalid_object("object elevation lookup lies outside map"))?,
        owner: 0,
        facet,
        footprint_width_256: definition.footprint_width_256,
        footprint_height_256: definition.footprint_height_256,
        presentation_kind: 0,
        resource_type: resources.resource_type,
        resource_quantity_f32_bits: resources.quantity_f32_bits,
        resource_delta: 0,
        status: i32::from(definition.initial_lifecycle_state),
        death_state: i8::from_ne_bytes([definition.initial_lifecycle_state]),
        data_status: definition.data_status,
        selection_flags: 0,
        behavior_flags: 0,
    })
}

pub(crate) fn write_appearance(writer: &mut CanonicalWriter, appearance: &ExactAppearanceObject) {
    writer.u32(appearance.tile_index);
    writer.u32(appearance.source_terrain_id.0);
    writer.u32(appearance.object_id.0);
    writer.u8(match appearance.placement {
        TerrainAppearancePlacement::Randomized => 0,
        TerrainAppearancePlacement::Centered => 1,
    });
    writer.u32(appearance.x_sample.unwrap_or(u32::MAX));
    writer.u32(appearance.y_sample.unwrap_or(u32::MAX));
    match appearance.auxiliary_sample {
        Some(sample) => {
            writer.u8(1);
            writer.u32(sample);
        }
        None => writer.u8(0),
    }
}

pub(crate) fn write_legacy_appearance(
    writer: &mut CanonicalWriter,
    appearance: &ExactAppearanceObject,
) {
    writer.u32(appearance.tile_index);
    writer.u32(appearance.source_terrain_id.0);
    writer.u32(appearance.object_id.0);
    writer.u8(match appearance.placement {
        TerrainAppearancePlacement::Randomized => 0,
        TerrainAppearancePlacement::Centered => 1,
    });
    writer.u32(appearance.x_sample.unwrap_or(u32::MAX));
    writer.u32(appearance.y_sample.unwrap_or(u32::MAX));
    writer.u32(appearance.auxiliary_sample.unwrap_or(u32::MAX));
}

pub(super) fn appearance_creation_profile<'a>(
    object_id: ObjectId,
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
) -> Result<(&'a ObjectDefinition, ObjectCreationRng), GenerationError> {
    let definition = runtime_attributes
        .definition(object_id, 0, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    if appearance_profile_rule_disabled_for_attribution() {
        return Ok((definition, definition.creation_rng));
    }
    let profile = runtime_attributes.creation_rng(object_id, definition, 0, content)?;
    Ok((definition, profile))
}

#[cfg(any(test, feature = "placement-oracle"))]
fn appearance_profile_rule_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_APPEARANCE_PROFILE_RULE").is_some()
}

#[cfg(not(any(test, feature = "placement-oracle")))]
fn appearance_profile_rule_disabled_for_attribution() -> bool {
    false
}

pub(super) fn appearance_creation_draws(
    profile: ObjectCreationRng,
    auxiliary: &mut RmsRandom,
) -> Option<u32> {
    let mut first = None;
    for draws in [
        profile.random_facet,
        profile.random_angle,
        profile.random_combat_seed,
    ] {
        if draws {
            let sample = auxiliary.next_u32();
            first.get_or_insert(sample);
        }
    }
    first
}

pub(super) fn appearance_axis(tile: u32, sample: u32) -> f32 {
    let unit = (f64::from(sample) * 2.328_306_436_538_696_3e-10_f64) as f32;
    tile as f32 + unit.clamp(0.0, 1.0)
}

pub(super) fn fixed_256(value: f32) -> u32 {
    ((f64::from(value) * 256.0).round() as u64).min(u64::from(u32::MAX)) as u32
}

pub(super) fn appearance_facet(profile: ObjectCreationRng, sample: Option<u32>) -> u16 {
    let facet = if profile.random_facet
        && let Some(sample) = sample
    {
        let sample = sample & 0x7fff;
        let scaled = u32::from(profile.facet_count) * sample / 0x7fff;
        scaled.min(u32::from(profile.facet_count - 1)) as u16
    } else {
        0
    };
    profile.fixed_facet.unwrap_or(facet)
}
