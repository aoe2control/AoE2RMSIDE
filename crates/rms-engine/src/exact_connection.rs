use super::*;
use rms_semantics::{RmsRandom, RmsRngState, SemanticOperation};

use super::exact_zone::TERRAIN_SLOT_COUNT;

mod open_queue;
use open_queue::PathOpenQueue;

const MAXIMUM_CONNECTION_DESCRIPTORS: usize = 256;
const MAXIMUM_PATH_ATTEMPTS: usize = 262_144;
const MAXIMUM_RETAINED_PATH_RECORDS: usize = 2_048;
const MAXIMUM_PATH_WORK_MULTIPLIER: u64 = 16;
const CARDINAL_COST_BITS: u32 = 1.0_f32.to_bits();
const DIAGONAL_COST_BITS: u32 = 1.36_f32.to_bits();
const LEFT_DIAGONAL_HEURISTIC_BITS: u32 = 0.41_f32.to_bits();
const RIGHT_DIAGONAL_HEURISTIC_BITS: u32 = 0.4_f32.to_bits();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactConnectionTerrainRule {
    pub cost_f32_bits: u32,
    pub size: i32,
    pub variance: i32,
    pub land_id: i32,
    pub replacement_terrain_id: i32,
}

impl Default for ExactConnectionTerrainRule {
    fn default() -> Self {
        Self {
            cost_f32_bits: CARDINAL_COST_BITS,
            size: 1,
            variance: 0,
            land_id: -1,
            replacement_terrain_id: -1,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactConnectionDescriptor {
    pub mode: i32,
    pub endpoints: Vec<MapCoordinate>,
    pub explicit_land_zones: Vec<u8>,
    pub default_replacement_terrain_id: i32,
    pub terrain_rules: Vec<ExactConnectionTerrainRule>,
    pub operation_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactConnectionPathTile {
    pub coordinate: MapCoordinate,
    pub direction: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactConnectionPathAttempt {
    pub descriptor_index: u16,
    pub path_ordinal: u16,
    pub start: MapCoordinate,
    pub target_requested: MapCoordinate,
    pub target_effective: MapCoordinate,
    pub success: bool,
    pub primary_rng_draws_before: u64,
    pub primary_rng_draws_after: u64,
    pub tiles: Vec<ExactConnectionPathTile>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactConnectionStatistics {
    pub path_attempts: u64,
    pub successful_paths: u64,
    pub failed_paths: u64,
    pub path_tiles: u64,
    pub path_work: u64,
    pub painting_rng_draws: u64,
    pub painted_tiles: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactConnectionState {
    pub restriction_zones: ExactRestrictionZones,
    pub removed_land_appearances: BTreeSet<u32>,
    pub dimensions: MapDimensions,
    pub descriptors: Vec<ExactConnectionDescriptor>,
    pub paths: Vec<ExactConnectionPathAttempt>,
    pub terrain: Vec<TerrainId>,
    pub elevation: Vec<i16>,
    pub land_id: Vec<u16>,
    pub terrain_zone: Vec<u32>,
    pub tile_operation_indices: Vec<u32>,
    pub connections: Vec<MapConnection>,
    pub connection_operation_indices: Vec<u32>,
    pub rng_state: RmsRngState,
    pub statistics: ExactConnectionStatistics,
}

impl ExactConnectionState {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-connection-state-v2");
        writer.u32(self.removed_land_appearances.len() as u32);
        for ordinal in &self.removed_land_appearances {
            writer.u32(*ordinal);
        }
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.u32(self.descriptors.len() as u32);
        for descriptor in &self.descriptors {
            writer.u32(descriptor.mode as u32);
            writer.u32(descriptor.endpoints.len() as u32);
            for endpoint in &descriptor.endpoints {
                writer.coordinate(*endpoint);
            }
            writer.u32(descriptor.explicit_land_zones.len() as u32);
            writer.bytes(&descriptor.explicit_land_zones);
            writer.u32(descriptor.default_replacement_terrain_id as u32);
            writer.u32(descriptor.terrain_rules.len() as u32);
            for rule in &descriptor.terrain_rules {
                writer.u32(rule.cost_f32_bits);
                writer.u32(rule.size as u32);
                writer.u32(rule.variance as u32);
                writer.u32(rule.land_id as u32);
                writer.u32(rule.replacement_terrain_id as u32);
            }
            writer.u32(descriptor.operation_index);
        }
        writer.u32(self.paths.len() as u32);
        for path in &self.paths {
            writer.u16(path.descriptor_index);
            writer.u16(path.path_ordinal);
            writer.coordinate(path.start);
            writer.coordinate(path.target_requested);
            writer.coordinate(path.target_effective);
            writer.u8(u8::from(path.success));
            writer.u64(path.primary_rng_draws_before);
            writer.u64(path.primary_rng_draws_after);
            writer.u32(path.tiles.len() as u32);
            for tile in &path.tiles {
                writer.coordinate(tile.coordinate);
                writer.u8(tile.direction);
            }
        }
        for terrain in &self.terrain {
            writer.u32(terrain.0);
        }
        for connection in &self.connections {
            writer.coordinate(connection.start);
            writer.coordinate(connection.end);
            writer.u8(match connection.kind {
                ConnectionKind::Land => 0,
                ConnectionKind::Water => 1,
                ConnectionKind::Road => 2,
            });
        }
        writer.bytes(&self.rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

pub fn resolve_exact_connection_state(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    land: &ExactLandState,
    terrain: &ExactTerrainState,
    content: CompatibleContentView<'_>,
    rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactConnectionState, GenerationError> {
    resolve_exact_connection_state_with_substages(
        semantic_program,
        setup,
        land,
        terrain,
        content,
        rng,
        cancellation,
        &mut |_| {},
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_exact_connection_state_with_substages(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    land: &ExactLandState,
    terrain: &ExactTerrainState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    cancellation: &dyn CancellationToken,
    substage: &mut dyn FnMut(&[TerrainId]),
) -> Result<ExactConnectionState, GenerationError> {
    if land.dimensions != terrain.dimensions || setup.effective_dimensions != terrain.dimensions {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection inputs disagree on map dimensions",
        ));
    }
    let tile_count = terrain.dimensions.tile_count()?;
    if terrain.terrain.len() != tile_count
        || terrain.elevation.len() != tile_count
        || terrain.land_id.len() != tile_count
        || terrain.terrain_zone.len() != tile_count
        || terrain.tile_operation_indices.len() != tile_count
    {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection input columns do not match map dimensions",
        ));
    }

    if semantic_program.has_section("connection_generation") {
        rng.next_u32();
    }
    let descriptors = collect_descriptors(semantic_program, setup, land, content)?;
    if descriptors.is_empty() {
        return Ok(ExactConnectionState {
            restriction_zones: terrain.restriction_zones.clone(),
            removed_land_appearances: terrain.removed_land_appearances.clone(),
            dimensions: terrain.dimensions,
            descriptors,
            paths: Vec::new(),
            terrain: terrain.terrain.clone(),
            elevation: terrain.elevation.clone(),
            land_id: terrain.land_id.clone(),
            terrain_zone: terrain.terrain_zone.clone(),
            tile_operation_indices: terrain.tile_operation_indices.clone(),
            connections: Vec::new(),
            connection_operation_indices: Vec::new(),
            rng_state: rng.state(),
            statistics: ExactConnectionStatistics::default(),
        });
    }
    if descriptors.len() > MAXIMUM_CONNECTION_DESCRIPTORS {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection descriptor count exceeds its bounded limit",
        ));
    }

    let planned_path_attempts = descriptors.iter().try_fold(0_usize, |total, descriptor| {
        let count = descriptor.endpoints.len();
        total
            .checked_add(count.saturating_mul(count.saturating_sub(1)) / 2)
            .filter(|total| *total <= MAXIMUM_PATH_ATTEMPTS)
    });
    let Some(planned_path_attempts) = planned_path_attempts else {
        return Err(invalid_request(
            "RMSGEN7002",
            "connection path attempts exceed their bounded limit",
        ));
    };
    let maximum_path_work = (tile_count as u64)
        .saturating_mul(MAXIMUM_PATH_WORK_MULTIPLIER)
        .saturating_mul(planned_path_attempts.max(MAXIMUM_RETAINED_PATH_RECORDS) as u64);
    let mut state = ExactConnectionState {
        restriction_zones: terrain.restriction_zones.clone(),
        removed_land_appearances: terrain.removed_land_appearances.clone(),
        dimensions: terrain.dimensions,
        descriptors,
        paths: Vec::new(),
        terrain: terrain.terrain.clone(),
        elevation: terrain.elevation.clone(),
        land_id: terrain.land_id.clone(),
        terrain_zone: terrain.terrain_zone.clone(),
        tile_operation_indices: terrain.tile_operation_indices.clone(),
        connections: Vec::new(),
        connection_operation_indices: Vec::new(),
        rng_state: rng.state(),
        statistics: ExactConnectionStatistics::default(),
    };
    let authored_accumulation = authored_accumulation(semantic_program);
    let isolate_descriptors = state.descriptors.len() > 1 && !authored_accumulation;
    let terrain_at_stage_entry = state.terrain.clone();
    let operations_at_stage_entry = state.tile_operation_indices.clone();
    let mut aggregate_paint = vec![None::<(TerrainId, u32)>; tile_count];

    let mut path_ordinal = 0_u16;
    for descriptor_index in 0..state.descriptors.len() {
        if isolate_descriptors {
            state.terrain.clone_from(&terrain_at_stage_entry);
            state
                .tile_operation_indices
                .clone_from(&operations_at_stage_entry);
        }
        let descriptor = state.descriptors[descriptor_index].clone();
        let mut connection_permissions = [true; TERRAIN_SLOT_COUNT];
        connection_permissions[0] = false;
        state.restriction_zones.lookup(
            state.dimensions,
            &state.terrain,
            &connection_permissions,
            true,
        )?;
        for start_index in 0..descriptor.endpoints.len() {
            for target_index in (start_index + 1)..descriptor.endpoints.len() {
                let start = descriptor.endpoints[start_index];
                let target = descriptor.endpoints[target_index];
                let primary_rng_draws_before = rng.state().draws();
                let (success, tiles, work) = find_path(
                    state.dimensions,
                    &state.terrain,
                    &descriptor.terrain_rules,
                    start,
                    target,
                    cancellation,
                )?;
                let primary_rng_draws_after = rng.state().draws();
                state.statistics.path_attempts += 1;
                state.statistics.path_work = state.statistics.path_work.saturating_add(work);
                if state.statistics.path_work > maximum_path_work {
                    return Err(invalid_request(
                        "RMSGEN7002",
                        "connection path search exhausted its bounded work budget",
                    ));
                }
                if success {
                    state.statistics.successful_paths += 1;
                    state.statistics.path_tiles = state
                        .statistics
                        .path_tiles
                        .saturating_add(tiles.len() as u64);
                    paint_path(
                        &mut state,
                        &descriptor,
                        &tiles,
                        &mut aggregate_paint,
                        &mut rng,
                        cancellation,
                    )?;
                    state.connections.push(MapConnection {
                        start,
                        end: target,
                        kind: ConnectionKind::Land,
                    });
                    state
                        .connection_operation_indices
                        .push(descriptor.operation_index);
                } else {
                    state.statistics.failed_paths += 1;
                }
                if state.paths.len() < MAXIMUM_RETAINED_PATH_RECORDS {
                    state.paths.push(ExactConnectionPathAttempt {
                        descriptor_index: u16::try_from(descriptor_index)
                            .expect("bounded descriptor"),
                        path_ordinal,
                        start,
                        target_requested: target,
                        target_effective: target,
                        success,
                        primary_rng_draws_before,
                        primary_rng_draws_after,
                        tiles,
                    });
                    path_ordinal = path_ordinal.checked_add(1).ok_or_else(|| {
                        invalid_request("RMSGEN7002", "connection path ordinal exceeds u16")
                    })?;
                }
                if !isolate_descriptors {
                    substage(&state.terrain);
                }
            }
        }
    }
    if isolate_descriptors {
        state.terrain = terrain_at_stage_entry;
        state.tile_operation_indices = operations_at_stage_entry;
        for (index, paint) in aggregate_paint.into_iter().enumerate() {
            if let Some((replacement, operation_index)) = paint {
                state.terrain[index] = replacement;
                state.tile_operation_indices[index] = operation_index;
            }
        }
    }
    let finalizer_rules = super::exact_terrain::terrain_finalizer_rules(content, "RMSGEN7001")?;
    let runtime_attributes = state.restriction_zones.runtime_attributes();
    super::exact_terrain::fill_water_topology(
        state.dimensions,
        &mut state.terrain,
        &mut state.land_id,
        &finalizer_rules,
        cancellation,
        |index, previous, current_terrain| {
            super::exact_appearance::remove_replaced_appearances_on_terrain(
                &land.appearance_objects,
                &mut state.removed_land_appearances,
                std::sync::Arc::make_mut(&mut state.restriction_zones.objects),
                state.dimensions,
                index,
                previous,
                content,
                &runtime_attributes,
                |object| {
                    super::exact_object::topology_placement_rejects(
                        object,
                        state.dimensions,
                        current_terrain,
                        &state.elevation,
                        content,
                        &runtime_attributes,
                    )
                },
                Some(current_terrain),
            )
        },
    )?;
    apply_connection_shoreline(&mut state, &finalizer_rules)?;
    state.rng_state = rng.state();
    Ok(state)
}

fn apply_connection_shoreline(
    state: &mut ExactConnectionState,
    rules: &super::exact_terrain::TerrainFinalizerRules,
) -> Result<(), GenerationError> {
    let before = state.terrain.clone();
    let width = usize::from(state.dimensions.width);
    let height = usize::from(state.dimensions.height);
    state.dimensions.tile_count()?;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if rules.is_water(before[index]) {
                continue;
            }
            let Some(shoreline_terrain_id) = rules.shoreline_terrain_id(before[index]) else {
                continue;
            };
            if (y.saturating_sub(1)..=(y + 1).min(height - 1)).any(|next_y| {
                (x.saturating_sub(1)..=(x + 1).min(width - 1)).any(|next_x| {
                    (next_x != x || next_y != y) && rules.is_water(before[next_y * width + next_x])
                })
            }) {
                state.terrain[index] = shoreline_terrain_id;
            }
        }
    }
    Ok(())
}

fn collect_descriptors(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    land: &ExactLandState,
    content: CompatibleContentView<'_>,
) -> Result<Vec<ExactConnectionDescriptor>, GenerationError> {
    let mut descriptors = raw_connection_descriptors(semantic_program, content)?;
    preprocess_connection_descriptors(&mut descriptors, setup, land)?;
    Ok(descriptors)
}

fn raw_connection_descriptors(
    semantic_program: &SemanticProgram,
    content: CompatibleContentView<'_>,
) -> Result<Vec<ExactConnectionDescriptor>, GenerationError> {
    let operations = semantic_program
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            operation.accepted_by_target_parser() && operation.section == "connection_generation"
        })
        .collect::<Vec<_>>();
    let mut descriptors = Vec::new();
    let mut current: Option<(&SemanticOperation, ConnectionTemplate)> = None;
    for &(operation_index, operation) in &operations {
        if operation.depth != 0 {
            if let Some((_, template)) = current.as_mut() {
                template.apply(operation, content)?;
            }
            continue;
        }
        if !is_connection_create(&operation.name) {
            continue;
        }
        if let Some((create, template)) = current.take() {
            descriptors.push(raw_connection_descriptor(create, &template)?);
        }
        let template = ConnectionTemplate::new(u32::try_from(operation_index).map_err(|_| {
            invalid_request("RMSGEN7001", "connection operation index exceeds u32")
        })?);
        current = Some((operation, template));
    }
    if let Some((create, template)) = current {
        descriptors.push(raw_connection_descriptor(create, &template)?);
    }
    Ok(descriptors)
}

fn is_connection_create(name: &str) -> bool {
    matches!(
        name,
        "create_connect_all_players_land"
            | "create_connect_teams_lands"
            | "create_connect_same_land_zones"
            | "create_connect_all_lands"
            | "create_connect_to_nonplayer_land"
            | "create_connect_land_zones"
    )
}

fn raw_connection_descriptor(
    operation: &SemanticOperation,
    template: &ConnectionTemplate,
) -> Result<ExactConnectionDescriptor, GenerationError> {
    let (mode, explicit_land_zones) = match operation.name.as_str() {
        "create_connect_all_players_land" => (63, Vec::new()),
        "create_connect_teams_lands" => (64, Vec::new()),
        "create_connect_same_land_zones" => (65, Vec::new()),
        "create_connect_all_lands" => (66, Vec::new()),
        "create_connect_to_nonplayer_land" => (103, Vec::new()),
        "create_connect_land_zones" => (
            150,
            vec![
                connection_zone_argument(operation, 0)?,
                connection_zone_argument(operation, 1)?,
            ],
        ),
        _ => unreachable!("filtered connection create"),
    };
    Ok(template.finish(mode, Vec::new(), explicit_land_zones))
}

fn preprocess_connection_descriptors(
    descriptors: &mut Vec<ExactConnectionDescriptor>,
    setup: &ExactSetupState,
    land: &ExactLandState,
) -> Result<(), GenerationError> {
    let (team_by_slot, team_count) = connection_team_ordinals(setup);
    let retained_lands = land
        .descriptors
        .iter()
        .map(|descriptor| {
            (
                descriptor.assigned_slot,
                descriptor.position,
                descriptor.zone,
            )
        })
        .collect::<Vec<_>>();
    let mut descriptor_index = 0;
    while descriptor_index < descriptors.len() {
        match descriptors[descriptor_index].mode {
            63 => descriptors[descriptor_index].endpoints.extend(
                retained_lands
                    .iter()
                    .filter(|(slot, _, _)| slot.is_some())
                    .map(|(_, position, _)| *position),
            ),
            64 => expand_team_descriptor(
                descriptors,
                descriptor_index,
                &retained_lands,
                &team_by_slot,
                team_count,
            )?,
            65 | 66 => descriptors[descriptor_index]
                .endpoints
                .extend(retained_lands.iter().map(|(_, position, _)| *position)),
            103 => {
                let land_endpoints = retained_lands
                    .iter()
                    .map(|(slot, position, _)| (slot.is_some(), *position))
                    .collect::<Vec<_>>();
                expand_nonplayer_descriptor(descriptors, descriptor_index, &land_endpoints)?;
            }
            150 => {
                let zones = descriptors[descriptor_index].explicit_land_zones.clone();
                for zone in zones {
                    descriptors[descriptor_index].endpoints.extend(
                        retained_lands
                            .iter()
                            .filter(|(_, _, land_zone)| *land_zone == zone)
                            .map(|(_, position, _)| *position),
                    );
                }
            }
            _ => {}
        }
        descriptor_index += 1;
    }
    Ok(())
}

fn connection_team_ordinals(setup: &ExactSetupState) -> (BTreeMap<u8, usize>, usize) {
    let mut named_teams = BTreeMap::<u8, usize>::new();
    let mut team_by_slot = BTreeMap::<u8, usize>::new();
    let mut team_count = 0;
    for player in &setup.players {
        let ordinal = if player.team == 0 {
            team_count += 1;
            team_count
        } else if let Some(ordinal) = named_teams.get(&player.team) {
            *ordinal
        } else {
            team_count += 1;
            named_teams.insert(player.team, team_count);
            team_count
        };
        team_by_slot.insert(player.slot, ordinal);
    }
    (team_by_slot, team_count)
}

fn expand_team_descriptor(
    descriptors: &mut Vec<ExactConnectionDescriptor>,
    descriptor_index: usize,
    retained_lands: &[(Option<u8>, MapCoordinate, u8)],
    team_by_slot: &BTreeMap<u8, usize>,
    team_count: usize,
) -> Result<(), GenerationError> {
    if team_count == 0 {
        return Err(invalid_request(
            "RMSGEN7001",
            "team connections require at least one resolved player team",
        ));
    }
    let original_len = descriptors.len();
    let additional = team_count - 1;
    checked_connection_descriptor_growth(original_len, additional)?;
    let template = descriptors[descriptor_index].clone();
    descriptors.extend((0..additional).map(|_| {
        let mut continuation = template.clone();
        continuation.mode = -1;
        continuation
    }));
    for (slot, position, _) in retained_lands {
        let Some(slot) = slot else {
            continue;
        };
        let team = team_by_slot.get(slot).copied().ok_or_else(|| {
            invalid_request(
                "RMSGEN7001",
                "connection land names a player without a resolved team",
            )
        })?;
        let target = if team == 1 {
            descriptor_index
        } else {
            original_len + team - 2
        };
        descriptors[target].endpoints.push(*position);
    }
    Ok(())
}

fn expand_nonplayer_descriptor(
    descriptors: &mut Vec<ExactConnectionDescriptor>,
    descriptor_index: usize,
    retained_lands: &[(bool, MapCoordinate)],
) -> Result<(), GenerationError> {
    let mut player_count = 0;
    for (is_player, position) in retained_lands {
        if !is_player {
            for continuation in 0..=player_count {
                descriptors[descriptor_index + continuation]
                    .endpoints
                    .push(*position);
            }
            continue;
        }
        let additional = player_count + 1;
        checked_connection_descriptor_growth(descriptors.len(), additional)?;
        descriptors.extend((0..additional).map(|_| zero_initialized_connection_descriptor()));
        let target = descriptor_index + player_count + 1;
        let mut continuation = descriptors[descriptor_index].clone();
        continuation.mode = -1;
        continuation.endpoints.push(*position);
        descriptors[target] = continuation;
        player_count += 1;
    }
    Ok(())
}

fn checked_connection_descriptor_growth(
    current: usize,
    additional: usize,
) -> Result<usize, GenerationError> {
    let length = current.checked_add(additional).ok_or_else(|| {
        invalid_request(
            "RMSGEN7001",
            "connection descriptor count exceeds fixed-width range",
        )
    })?;
    if length > MAXIMUM_CONNECTION_DESCRIPTORS {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection descriptor count exceeds its bounded limit",
        ));
    }
    Ok(length)
}

fn zero_initialized_connection_descriptor() -> ExactConnectionDescriptor {
    ExactConnectionDescriptor {
        mode: 0,
        endpoints: Vec::new(),
        explicit_land_zones: Vec::new(),
        default_replacement_terrain_id: 0,
        terrain_rules: vec![
            ExactConnectionTerrainRule {
                cost_f32_bits: 0,
                size: 0,
                variance: 0,
                land_id: 0,
                replacement_terrain_id: 0,
            };
            TERRAIN_SLOT_COUNT
        ],
        operation_index: 0,
    }
}

fn connection_zone_argument(
    operation: &SemanticOperation,
    argument_index: usize,
) -> Result<u8, GenerationError> {
    let authored = connection_i32_argument(operation, argument_index)?;
    let translated = authored.checked_add(10).ok_or_else(|| {
        invalid_request(
            "RMSGEN7001",
            "connection land zone exceeds fixed-width range",
        )
    })?;
    u8::try_from(translated).map_err(|_| {
        invalid_request(
            "RMSGEN7001",
            "connection land zone exceeds fixed-width range",
        )
    })
}

#[derive(Clone)]
struct ConnectionTemplate {
    rules: Vec<ExactConnectionTerrainRule>,
    default_replacement_terrain_id: i32,
    operation_index: u32,
}

impl ConnectionTemplate {
    fn new(operation_index: u32) -> Self {
        Self {
            rules: vec![ExactConnectionTerrainRule::default(); TERRAIN_SLOT_COUNT],
            default_replacement_terrain_id: -1,
            operation_index,
        }
    }

    fn apply(
        &mut self,
        operation: &SemanticOperation,
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        match operation.name.as_str() {
            "default_terrain_replacement" => {
                let replacement = connection_terrain_argument(operation, 0, content)? as i32;
                self.default_replacement_terrain_id = replacement;
                for rule in &mut self.rules {
                    rule.replacement_terrain_id = replacement;
                }
            }
            "replace_terrain" => {
                let terrain = connection_terrain_argument(operation, 0, content)?;
                self.rules[terrain].replacement_terrain_id =
                    connection_terrain_argument(operation, 1, content)? as i32;
            }
            "terrain_cost" => {
                let terrain = connection_terrain_argument(operation, 0, content)?;
                self.rules[terrain].cost_f32_bits =
                    connection_f32_argument(operation, 1)?.to_bits();
            }
            "terrain_size" => {
                let terrain = connection_terrain_argument(operation, 0, content)?;
                let size = connection_i32_argument(operation, 1)?;
                let variance = connection_i32_argument(operation, 2)?;
                self.rules[terrain].size = size;
                self.rules[terrain].variance = variance;
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(
        &self,
        mode: i32,
        endpoints: Vec<MapCoordinate>,
        explicit_land_zones: Vec<u8>,
    ) -> ExactConnectionDescriptor {
        ExactConnectionDescriptor {
            mode,
            endpoints,
            explicit_land_zones,
            default_replacement_terrain_id: self.default_replacement_terrain_id,
            terrain_rules: self.rules.clone(),
            operation_index: self.operation_index,
        }
    }
}

fn authored_accumulation(semantic_program: &SemanticProgram) -> bool {
    semantic_program.executable_operations().any(|operation| {
        operation.section == "connection_generation"
            && operation.depth == 0
            && operation.name == "accumulate_connections"
    })
}

fn connection_f32_argument(
    operation: &SemanticOperation,
    index: usize,
) -> Result<f32, GenerationError> {
    let value = operation
        .arguments
        .get(index)
        .ok_or_else(|| {
            invalid_request("RMSGEN7001", "connection operation is missing an argument")
        })?
        .value
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN7001", "connection argument is not numeric"))?;
    if !value.is_finite() {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection argument must be finite",
        ));
    }
    Ok(value)
}

fn connection_i32_argument(
    operation: &SemanticOperation,
    index: usize,
) -> Result<i32, GenerationError> {
    let value = connection_f32_argument(operation, index)?;
    if value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection argument exceeds fixed-width range",
        ));
    }
    Ok(value.round() as i32)
}

fn connection_terrain_argument(
    operation: &SemanticOperation,
    index: usize,
    content: CompatibleContentView<'_>,
) -> Result<usize, GenerationError> {
    let terrain = exact_terrain_argument(operation, index, content, "RMSGEN7001")?.0 as usize;
    if terrain >= TERRAIN_SLOT_COUNT {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection terrain id exceeds the descriptor slot table",
        ));
    }
    Ok(terrain)
}

fn find_path(
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    rules: &[ExactConnectionTerrainRule],
    start: MapCoordinate,
    target: MapCoordinate,
    cancellation: &dyn CancellationToken,
) -> Result<(bool, Vec<ExactConnectionPathTile>, u64), GenerationError> {
    let tile_count = dimensions.tile_count()?;
    let start_index = start.index(dimensions).ok_or_else(|| {
        invalid_request(
            "RMSGEN7001",
            "a connection starts at a land position outside the map, where the game writes outside its map data; the preview cannot generate this map",
        )
    })?;
    let target_index = target.index(dimensions).ok_or_else(|| {
        invalid_request(
            "RMSGEN7001",
            "a connection targets a land position outside the map; the game reads a missing tile there and crashes, so this map cannot be generated",
        )
    })?;
    if terrain.len() != tile_count || rules.len() != TERRAIN_SLOT_COUNT {
        return Err(invalid_request(
            "RMSGEN7001",
            "connection path input shape is invalid",
        ));
    }
    if terrain_cost(terrain[target_index], rules)? <= 0.0 {
        return Ok((false, Vec::new(), 0));
    }

    let mut status = vec![0_u8; tile_count];
    status[start_index] = 3;
    status[target_index] = 2;
    let mut queue = PathOpenQueue::new(tile_count);
    let mut current = start;
    let mut current_cost = 0.0_f32;
    let mut work = 0_u64;
    loop {
        work = work.saturating_add(1);
        if work.is_multiple_of(1024) {
            cancellation_checkpoint(cancellation, GenerationStage::Terrain, work)?;
        }
        let dx = i32::from(target.x) - i32::from(current.x);
        let dy = i32::from(target.y) - i32::from(current.y);
        let current_distance = ((dx * dx + dy * dy) as f32).sqrt();
        if current_distance == 0.0 {
            let tiles = backtrace_path(dimensions, &status, start, current)?;
            return Ok((true, tiles, work));
        }

        let neighbors = [
            (0, 1, 7_u8, false, 0_u8),
            (0, -1, 6, false, 1),
            (-1, 0, 4, false, 2),
            (-1, -1, 8, true, 3),
            (-1, 1, 9, true, 4),
            (1, 0, 5, false, 5),
            (1, -1, 10, true, 6),
            (1, 1, 11, true, 7),
        ];
        for (move_x, move_y, direction, diagonal, heuristic_kind) in neighbors {
            let next_x = i32::from(current.x) + move_x;
            let next_y = i32::from(current.y) + move_y;
            if next_x < 0
                || next_y < 0
                || next_x >= i32::from(dimensions.width)
                || next_y >= i32::from(dimensions.height)
            {
                continue;
            }
            let next = MapCoordinate {
                x: next_x as u16,
                y: next_y as u16,
            };
            let next_index = next.index(dimensions).expect("bounded neighbor");
            if status[next_index] == 2 {
                status[next_index] = direction;
                let tiles = backtrace_path(dimensions, &status, start, next)?;
                return Ok((true, tiles, work));
            }
            if status[next_index] != 0 {
                continue;
            }
            let cost = terrain_cost(terrain[next_index], rules)?;
            if cost <= 0.0 {
                status[next_index] = 1;
                continue;
            }
            if diagonal {
                let horizontal = MapCoordinate {
                    x: next.x,
                    y: current.y,
                };
                let vertical = MapCoordinate {
                    x: current.x,
                    y: next.y,
                };
                if terrain_cost(terrain[horizontal.index(dimensions).unwrap()], rules)? <= 0.0
                    || terrain_cost(terrain[vertical.index(dimensions).unwrap()], rules)? <= 0.0
                {
                    continue;
                }
            }
            status[next_index] = direction;
            let movement = if diagonal {
                f32::from_bits(DIAGONAL_COST_BITS)
            } else {
                f32::from_bits(CARDINAL_COST_BITS)
            };
            let cumulative = current_cost + cost * movement;
            let heuristic = adjusted_heuristic(
                current_distance,
                current,
                target,
                move_x,
                move_y,
                heuristic_kind,
            );
            queue.insert(next_index, cumulative, cumulative + heuristic);
        }
        let Some((next_index, cumulative)) = queue.pop() else {
            return Ok((false, Vec::new(), work));
        };
        current = MapCoordinate {
            x: (next_index % usize::from(dimensions.width)) as u16,
            y: (next_index / usize::from(dimensions.width)) as u16,
        };
        current_cost = cumulative;
    }
}

fn terrain_cost(
    terrain: TerrainId,
    rules: &[ExactConnectionTerrainRule],
) -> Result<f32, GenerationError> {
    let terrain = usize::try_from(terrain.0)
        .map_err(|_| invalid_request("RMSGEN7001", "connection terrain id exceeds usize"))?;
    let rule = rules.get(terrain).ok_or_else(|| {
        invalid_request(
            "RMSGEN7001",
            "connection terrain id exceeds the descriptor slot table",
        )
    })?;
    Ok(f32::from_bits(rule.cost_f32_bits))
}

fn adjusted_heuristic(
    mut distance: f32,
    current: MapCoordinate,
    target: MapCoordinate,
    move_x: i32,
    move_y: i32,
    heuristic_kind: u8,
) -> f32 {
    let x_closer = (move_x < 0 && target.x < current.x) || (move_x > 0 && target.x > current.x);
    let y_closer = (move_y < 0 && target.y < current.y) || (move_y > 0 && target.y > current.y);
    if move_x == 0 {
        distance = if y_closer {
            distance - 1.0
        } else {
            distance + 1.0
        };
    } else if move_y == 0 {
        distance = if x_closer {
            distance - 1.0
        } else {
            distance + 1.0
        };
    } else {
        distance = if x_closer {
            distance - 1.0
        } else {
            distance + 1.0
        };
        let adjustment = if heuristic_kind == 3 || heuristic_kind == 4 {
            f32::from_bits(LEFT_DIAGONAL_HEURISTIC_BITS)
        } else {
            f32::from_bits(RIGHT_DIAGONAL_HEURISTIC_BITS)
        };
        distance = if y_closer {
            distance - adjustment
        } else {
            distance + adjustment
        };
    }
    distance
}

fn backtrace_path(
    dimensions: MapDimensions,
    status: &[u8],
    start: MapCoordinate,
    target: MapCoordinate,
) -> Result<Vec<ExactConnectionPathTile>, GenerationError> {
    let tile_count = dimensions.tile_count()?;
    let mut coordinate = target;
    let mut tiles = Vec::new();
    while coordinate != start {
        if tiles.len() >= tile_count {
            return Err(invalid_request(
                "RMSGEN7002",
                "connection path backtrace exhausted its bounded limit",
            ));
        }
        let direction = status[coordinate.index(dimensions).expect("bounded backtrace")];
        tiles.push(ExactConnectionPathTile {
            coordinate,
            direction,
        });
        let (delta_x, delta_y) = match direction {
            4 => (1, 0),
            5 => (-1, 0),
            6 => (0, 1),
            7 => (0, -1),
            8 => (1, 1),
            9 => (1, -1),
            10 => (-1, 1),
            11 => (-1, -1),
            _ => {
                return Err(invalid_request(
                    "RMSGEN7002",
                    "connection path contains an invalid backtrace direction",
                ));
            }
        };
        let x = i32::from(coordinate.x) + delta_x;
        let y = i32::from(coordinate.y) + delta_y;
        if x < 0 || y < 0 || x >= i32::from(dimensions.width) || y >= i32::from(dimensions.height) {
            return Err(invalid_request(
                "RMSGEN7002",
                "connection path backtrace left the map",
            ));
        }
        coordinate = MapCoordinate {
            x: x as u16,
            y: y as u16,
        };
    }
    Ok(tiles)
}

#[derive(Clone, Debug, Default)]
struct PaintNode {
    queued: bool,
    previous: Option<usize>,
    next: Option<usize>,
}

struct PaintQueue {
    head: Option<usize>,
    nodes: Vec<PaintNode>,
}

impl PaintQueue {
    fn new(tile_count: usize) -> Self {
        Self {
            head: None,
            nodes: vec![PaintNode::default(); tile_count],
        }
    }

    fn insert_front(&mut self, index: usize) {
        self.remove(index);
        let former_head = self.head;
        self.nodes[index].queued = true;
        self.nodes[index].next = former_head;
        if let Some(former_head) = former_head {
            self.nodes[former_head].previous = Some(index);
        }
        self.head = Some(index);
    }

    fn remove(&mut self, index: usize) {
        if !self.nodes[index].queued {
            return;
        }
        let previous = self.nodes[index].previous;
        let next = self.nodes[index].next;
        if let Some(previous) = previous {
            self.nodes[previous].next = next;
        } else {
            self.head = next;
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        }
        self.nodes[index] = PaintNode::default();
    }

    fn pop(&mut self) -> Option<usize> {
        let index = self.head?;
        self.remove(index);
        Some(index)
    }
}

struct PaintTiles {
    width: usize,
    queue: Option<PaintQueue>,
    rows: Vec<Vec<(usize, usize)>>,
}

impl PaintTiles {
    fn new(width: usize, height: usize, reference: bool, accelerated: bool) -> Self {
        Self {
            width,
            queue: reference.then(|| PaintQueue::new(width * height)),
            rows: if accelerated {
                vec![Vec::new(); height]
            } else {
                Vec::new()
            },
        }
    }

    fn insert_rectangle(&mut self, columns: (usize, usize), rows: (usize, usize)) {
        if let Some(queue) = &mut self.queue {
            for y in rows.0..=rows.1 {
                for x in columns.0..=columns.1 {
                    queue.insert_front(y * self.width + x);
                }
            }
        }
        if self.rows.is_empty() {
            return;
        }
        for y in rows.0..=rows.1 {
            let intervals = &mut self.rows[y];
            let (mut start, mut end) = columns;
            let first = intervals.partition_point(|&(_, right)| right + 1 < start);
            let mut last = first;
            while last < intervals.len() && intervals[last].0 <= end + 1 {
                start = start.min(intervals[last].0);
                end = end.max(intervals[last].1);
                last += 1;
            }
            intervals.splice(first..last, [(start, end)]);
        }
    }

    fn union(&self) -> Vec<usize> {
        let mut tiles = Vec::new();
        for (y, intervals) in self.rows.iter().enumerate() {
            for &(start, end) in intervals {
                tiles.extend((start..=end).map(|x| y * self.width + x));
            }
        }
        tiles
    }

    fn reference_order(&mut self) -> Vec<usize> {
        let mut order = Vec::new();
        if let Some(queue) = &mut self.queue {
            while let Some(index) = queue.pop() {
                order.push(index);
            }
        }
        order
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_tiles(
    order: &[usize],
    descriptor: &ExactConnectionDescriptor,
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    tile_operation_indices: &mut [u32],
    aggregate_paint: &mut [Option<(TerrainId, u32)>],
    painted_tiles: &mut u64,
) -> Result<(), GenerationError> {
    for &paint_index in order {
        let current_terrain = usize::try_from(terrain[paint_index].0)
            .map_err(|_| invalid_request("RMSGEN7001", "connection paint terrain exceeds usize"))?;
        let replacement = descriptor
            .terrain_rules
            .get(current_terrain)
            .ok_or_else(|| {
                invalid_request(
                    "RMSGEN7001",
                    "connection paint terrain exceeds the descriptor slot table",
                )
            })?
            .replacement_terrain_id;
        if replacement >= 0 {
            let replacement = TerrainId(replacement as u32);
            terrain[paint_index] = replacement;
            land_id[paint_index] = u16::MAX;
            tile_operation_indices[paint_index] = descriptor.operation_index;
            aggregate_paint[paint_index] = Some((replacement, descriptor.operation_index));
            *painted_tiles += 1;
        }
    }
    Ok(())
}

fn paint_path(
    state: &mut ExactConnectionState,
    descriptor: &ExactConnectionDescriptor,
    path: &[ExactConnectionPathTile],
    aggregate_paint: &mut [Option<(TerrainId, u32)>],
    rng: &mut RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    state.dimensions.tile_count()?;
    let width = usize::from(state.dimensions.width);
    let mode = crate::placement_oracle::mode();
    let mut queue = PaintTiles::new(
        width,
        usize::from(state.dimensions.height),
        mode != crate::placement_oracle::PlacementCheckMode::Accelerated,
        mode != crate::placement_oracle::PlacementCheckMode::Reference,
    );
    for (path_index, path_tile) in path.iter().enumerate() {
        if path_index % 1024 == 0 {
            cancellation_checkpoint(
                cancellation,
                GenerationStage::Terrain,
                state
                    .statistics
                    .path_tiles
                    .saturating_add(path_index as u64),
            )?;
        }
        let paint_coordinate = path_predecessor(path_tile, state.dimensions)?;
        let index = paint_coordinate.index(state.dimensions).unwrap();
        let terrain_index = usize::try_from(state.terrain[index].0).map_err(|_| {
            invalid_request("RMSGEN7001", "connection painter terrain exceeds usize")
        })?;
        let rule = descriptor.terrain_rules.get(terrain_index).ok_or_else(|| {
            invalid_request(
                "RMSGEN7001",
                "connection painter terrain exceeds the descriptor slot table",
            )
        })?;
        let base = rule.size.wrapping_sub(rule.variance);
        let upper = rule.variance.wrapping_mul(2) as u32;
        let left = rng.bounded(upper).result as i32;
        let top = rng.bounded(upper).result as i32;
        let right = rng.bounded(upper).result as i32;
        let bottom = rng.bounded(upper).result as i32;
        state.statistics.painting_rng_draws += 4;
        let minimum_x = i32::from(paint_coordinate.x)
            .wrapping_sub(base)
            .wrapping_sub(left)
            .clamp(0, i32::from(state.dimensions.width) - 1);
        let minimum_y = i32::from(paint_coordinate.y)
            .wrapping_sub(base)
            .wrapping_sub(top)
            .clamp(0, i32::from(state.dimensions.height) - 1);
        let maximum_x = i32::from(paint_coordinate.x)
            .wrapping_add(base)
            .wrapping_add(right)
            .clamp(0, i32::from(state.dimensions.width) - 1);
        let maximum_y = i32::from(paint_coordinate.y)
            .wrapping_add(base)
            .wrapping_add(bottom)
            .clamp(0, i32::from(state.dimensions.height) - 1);
        if minimum_x <= maximum_x && minimum_y <= maximum_y {
            queue.insert_rectangle(
                (minimum_x as usize, maximum_x as usize),
                (minimum_y as usize, maximum_y as usize),
            );
        }
    }
    let order = match mode {
        crate::placement_oracle::PlacementCheckMode::Accelerated => queue.union(),
        crate::placement_oracle::PlacementCheckMode::Reference => queue.reference_order(),
        crate::placement_oracle::PlacementCheckMode::Differential => {
            let mut terrain = state.terrain.clone();
            let mut land_id = state.land_id.clone();
            let mut operations = state.tile_operation_indices.clone();
            let mut aggregate = aggregate_paint.to_vec();
            let mut painted = state.statistics.painted_tiles;
            let accelerated = paint_tiles(
                &queue.union(),
                descriptor,
                &mut terrain,
                &mut land_id,
                &mut operations,
                &mut aggregate,
                &mut painted,
            );
            let order = queue.reference_order();
            let reference = paint_tiles(
                &order,
                descriptor,
                &mut state.terrain,
                &mut state.land_id,
                &mut state.tile_operation_indices,
                aggregate_paint,
                &mut state.statistics.painted_tiles,
            );
            let same_state = reference.is_err()
                || (terrain == state.terrain
                    && land_id == state.land_id
                    && operations == state.tile_operation_indices
                    && aggregate == aggregate_paint
                    && painted == state.statistics.painted_tiles);
            crate::placement_oracle::compare(
                crate::placement_oracle::OracleCheck::ConnectionPaint,
                &(reference.clone(), true),
                &(accelerated, same_state),
                || format!("connection paint of {} tiles", order.len()),
            );
            return reference;
        }
    };
    paint_tiles(
        &order,
        descriptor,
        &mut state.terrain,
        &mut state.land_id,
        &mut state.tile_operation_indices,
        aggregate_paint,
        &mut state.statistics.painted_tiles,
    )
}

fn path_predecessor(
    tile: &ExactConnectionPathTile,
    dimensions: MapDimensions,
) -> Result<MapCoordinate, GenerationError> {
    let (delta_x, delta_y) = match tile.direction {
        4 => (1, 0),
        5 => (-1, 0),
        6 => (0, 1),
        7 => (0, -1),
        8 => (1, 1),
        9 => (1, -1),
        10 => (-1, 1),
        11 => (-1, -1),
        _ => {
            return Err(invalid_request(
                "RMSGEN7002",
                "connection painter received an invalid path direction",
            ));
        }
    };
    let x = i32::from(tile.coordinate.x) + delta_x;
    let y = i32::from(tile.coordinate.y) + delta_y;
    if x < 0 || y < 0 || x >= i32::from(dimensions.width) || y >= i32::from(dimensions.height) {
        return Err(invalid_request(
            "RMSGEN7002",
            "connection painter predecessor left the map",
        ));
    }
    Ok(MapCoordinate {
        x: x as u16,
        y: y as u16,
    })
}
