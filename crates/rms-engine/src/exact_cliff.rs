use super::exact_appearance::consume_terrain_appearances;
use super::exact_cliff_piece::CliffPieces;
use super::*;
use rms_semantics::{RmsRandom, RmsRngState, SemanticOperation};
use std::collections::BTreeSet;

const MAXIMUM_CLIFF_LENGTH: usize = 512;
const RANDOMIZATION_BUCKETS: usize = 100;
const COARSE_TILE_SIZE: usize = 3;
const PLAYER_CLEARANCE_RADIUS: i32 = 7;
const MAXIMUM_CLIFF_ATTEMPTS: i32 = u16::MAX as i32;
const DEFAULT_MINIMUM_CLIFF_COUNT: i32 = 3;
const DEFAULT_MAXIMUM_CLIFF_COUNT: i32 = 9;
const DEFAULT_MINIMUM_CLIFF_LENGTH: i32 = 5;
const DEFAULT_MAXIMUM_CLIFF_LENGTH: i32 = 9;
const DEFAULT_CLIFF_CURLINESS: i32 = 36;
const DEFAULT_MINIMUM_CLIFF_DISTANCE: i32 = 2;
const DEFAULT_MINIMUM_TERRAIN_DISTANCE: i32 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactCliffConfiguration {
    pub cliff_type: u8,
    pub minimum_count: i32,
    pub maximum_count: i32,
    pub minimum_length: i32,
    pub maximum_length: i32,
    pub curliness: i32,
    pub minimum_cliff_distance: i32,
    pub minimum_terrain_distance: i32,
    pub operation_index: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactCliffAttempt {
    pub attempt_index: u16,
    pub requested_length: i32,
    pub start: Option<MapCoordinate>,
    pub path: Vec<MapCoordinate>,
    pub direction_samples: Vec<ExactCliffDirectionSample>,
    pub rng_draws_before: u64,
    pub rng_draws_after: u64,
    pub auxiliary_rng_draws_before: u64,
    pub auxiliary_rng_draws_after: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactCliffDirectionSample {
    pub curl: u8,
    pub heading: u8,
    pub chosen: Option<u8>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactCliffStatistics {
    pub candidate_count: u64,
    pub randomization_draws: u64,
    pub randomization_pass_leading_samples: [Vec<u8>; 2],
    pub randomization_pass_leading_coordinates: [Vec<MapCoordinate>; 2],
    pub randomization_final_leading_coordinates: Vec<MapCoordinate>,
    pub attempts: Vec<ExactCliffAttempt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactCliffState {
    pub restriction_zones: ExactRestrictionZones,
    pub dimensions: MapDimensions,
    pub configuration: ExactCliffConfiguration,
    pub terrain: Vec<TerrainId>,
    pub deferred_primary_terrain: Vec<u32>,
    pub tile_operation_indices: Vec<u32>,
    pub layer: Vec<u16>,
    pub cliffs: Vec<CliffEdge>,
    pub cliff_operation_indices: Vec<u32>,
    pub piece_objects: Vec<PlacedObject>,
    pub appearance_objects: Vec<(u32, ExactAppearanceObject)>,
    pub removed_land_appearances: BTreeSet<u32>,
    pub master_facets: Vec<(rms_content::ObjectId, u8)>,
    pub next_instance_id: u32,
    pub rng_state: RmsRngState,
    pub auxiliary_rng_state: RmsRngState,
    pub statistics: ExactCliffStatistics,
}

impl ExactCliffState {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-cliff-state-v5");
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.u8(self.configuration.cliff_type);
        for terrain in &self.terrain {
            writer.u32(terrain.0);
        }
        for terrain in &self.deferred_primary_terrain {
            writer.u32(*terrain);
        }
        for layer in &self.layer {
            writer.u16(*layer);
        }
        writer.u32(self.cliffs.len() as u32);
        for cliff in &self.cliffs {
            writer.u16(cliff.from.x);
            writer.u16(cliff.from.y);
            writer.u16(cliff.to.x);
            writer.u16(cliff.to.y);
            writer.u32(cliff.cliff_type);
        }
        writer.u32(self.next_instance_id);
        writer.u32(self.appearance_objects.len() as u32);
        for (identity, appearance) in &self.appearance_objects {
            writer.u32(*identity);
            super::exact_object::write_legacy_appearance(&mut writer, appearance);
        }
        writer.u32(self.removed_land_appearances.len() as u32);
        for identity in &self.removed_land_appearances {
            writer.u32(*identity);
        }
        writer.u32(self.piece_objects.len() as u32);
        for object in &self.piece_objects {
            super::exact_object::write_object(&mut writer, object);
        }
        writer.u32(self.master_facets.len() as u32);
        for (id, facet) in &self.master_facets {
            writer.u32(id.0);
            writer.u8(*facet);
        }
        writer.bytes(&self.rng_state.checkpoint_hash());
        writer.bytes(&self.auxiliary_rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

#[derive(Clone, Debug, Default)]
struct QueueNode {
    queue: Option<usize>,
    previous: Option<usize>,
    next: Option<usize>,
}

struct CliffQueues {
    heads: Vec<Option<usize>>,
    nodes: Vec<QueueNode>,
}

impl CliffQueues {
    fn new(queue_count: usize, node_count: usize) -> Self {
        Self {
            heads: vec![None; queue_count],
            nodes: vec![QueueNode::default(); node_count],
        }
    }

    fn remove(&mut self, index: usize) {
        let Some(queue) = self.nodes[index].queue else {
            return;
        };
        let previous = self.nodes[index].previous;
        let next = self.nodes[index].next;
        if let Some(previous) = previous {
            self.nodes[previous].next = next;
        } else {
            self.heads[queue] = next;
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        }
        self.nodes[index] = QueueNode::default();
    }

    fn insert_front(&mut self, queue: usize, index: usize) {
        self.remove(index);
        let next = self.heads[queue];
        self.nodes[index] = QueueNode {
            queue: Some(queue),
            previous: None,
            next,
        };
        if let Some(next) = next {
            self.nodes[next].previous = Some(index);
        }
        self.heads[queue] = Some(index);
    }

    fn pop(&mut self, queue: usize) -> Option<usize> {
        let index = self.heads[queue]?;
        self.remove(index);
        Some(index)
    }

    fn leading_coordinates(&self, queue: usize, width: usize, limit: usize) -> Vec<MapCoordinate> {
        let mut result = Vec::with_capacity(limit);
        let mut current = self.heads[queue];
        while let Some(index) = current {
            if result.len() == limit {
                break;
            }
            result.push(MapCoordinate {
                x: (index % width) as u16,
                y: (index / width) as u16,
            });
            current = self.nodes[index].next;
        }
        result
    }
}

pub fn resolve_exact_cliff_state(
    semantic_program: &SemanticProgram,
    land: &ExactLandState,
    elevation: &ExactElevationState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactCliffState, GenerationError> {
    if land.dimensions != elevation.dimensions {
        return Err(invalid_request(
            "RMSGEN3201",
            "cliff input dimensions do not match",
        ));
    }
    let dimensions = land.dimensions;
    let mut restriction_zones = land.restriction_zones.clone();
    let tile_count = dimensions.tile_count()?;
    if land.terrain.len() != tile_count || elevation.elevation.len() != tile_count {
        return Err(invalid_request(
            "RMSGEN3201",
            "cliff input arrays are incomplete",
        ));
    }
    let configuration = collect_configuration(semantic_program)?;
    let mut auxiliary_rng = RmsRandom::from_state(land.auxiliary_rng_state);

    if !semantic_program
        .operations
        .iter()
        .any(|operation| operation.section == "cliff_generation")
    {
        return Ok(ExactCliffState {
            restriction_zones: land.restriction_zones.clone(),
            dimensions,
            configuration,
            terrain: land.terrain.clone(),
            deferred_primary_terrain: vec![u32::MAX; tile_count],
            tile_operation_indices: vec![u32::MAX; tile_count],
            layer: land.elevation_land_id.clone(),
            cliffs: Vec::new(),
            cliff_operation_indices: Vec::new(),
            piece_objects: Vec::new(),
            appearance_objects: Vec::new(),
            removed_land_appearances: BTreeSet::new(),
            master_facets: Vec::new(),
            next_instance_id: u32::try_from(land.appearance_objects.len()).map_err(|_| {
                invalid_request("RMSGEN3202", "cliff initial object count exceeds u32")
            })?,
            rng_state: rng.state(),
            auxiliary_rng_state: auxiliary_rng.state(),
            statistics: ExactCliffStatistics::default(),
        });
    }

    rng.next_u32();
    let coarse_width = usize::from(dimensions.width) / COARSE_TILE_SIZE;
    let coarse_height = usize::from(dimensions.height) / COARSE_TILE_SIZE;
    let coarse_count = coarse_width
        .checked_mul(coarse_height)
        .ok_or_else(|| invalid_request("RMSGEN3202", "cliff coarse grid overflow"))?;
    let main_queue = 0;
    let bucket_base = 1;
    let mut queues = CliffQueues::new(bucket_base + RANDOMIZATION_BUCKETS, coarse_count);
    let mut eligibility = vec![0_u8; coarse_count];
    let mut blocked_terrain = Vec::new();
    let mut work = 0_u64;
    let maximum_work = (tile_count as u64).saturating_mul(64).max(4096);

    for coarse_y in 0..coarse_height {
        for coarse_x in 0..coarse_width {
            work = bounded_work(work, maximum_work, cancellation)?;
            let mut base_elevation = None;
            let mut uniform = true;
            let mut blocked = false;
            for offset_y in 0..COARSE_TILE_SIZE {
                for offset_x in 0..COARSE_TILE_SIZE {
                    let x = coarse_x * COARSE_TILE_SIZE + offset_x;
                    let y = coarse_y * COARSE_TILE_SIZE + offset_y;
                    let index = y * usize::from(dimensions.width) + x;
                    blocked |= cliff_terrain_blocked(content, land.terrain[index])?;
                    let value = elevation.elevation[index];
                    if let Some(base) = base_elevation {
                        uniform &= value == base;
                    } else {
                        base_elevation = Some(value);
                    }
                }
            }
            let coarse_index = coarse_y * coarse_width + coarse_x;
            if !blocked && uniform {
                let value = base_elevation.unwrap_or_default().saturating_add(1);
                eligibility[coarse_index] = u8::try_from(value).unwrap_or(u8::MAX);
                queues.insert_front(main_queue, coarse_index);
            } else if blocked {
                blocked_terrain.push((coarse_x, coarse_y));
            }
        }
    }

    for (x, y) in blocked_terrain {
        clear_square(
            &mut eligibility,
            &mut queues,
            main_queue,
            coarse_width,
            coarse_height,
            x,
            y,
            configuration.minimum_terrain_distance,
        );
    }
    let centers = land
        .descriptors
        .iter()
        .map(|descriptor| descriptor.position)
        .collect::<BTreeSet<_>>();
    for center in centers {
        clear_square(
            &mut eligibility,
            &mut queues,
            main_queue,
            coarse_width,
            coarse_height,
            usize::from(center.x) / COARSE_TILE_SIZE,
            usize::from(center.y) / COARSE_TILE_SIZE,
            PLAYER_CLEARANCE_RADIUS,
        );
    }
    remove_isolated(
        &mut eligibility,
        &mut queues,
        main_queue,
        coarse_width,
        coarse_height,
    );

    let mut statistics = ExactCliffStatistics {
        candidate_count: eligibility.iter().filter(|value| **value != 0).count() as u64,
        ..ExactCliffStatistics::default()
    };
    randomize_queue(
        &mut queues,
        main_queue,
        bucket_base,
        coarse_width,
        &mut rng,
        &mut statistics,
    );
    let cliff_count = select_cliff_count(&configuration, &mut rng)?;
    let mut terrain = land.terrain.clone();
    let mut deferred_primary_terrain = vec![u32::MAX; tile_count];
    let mut tile_operation_indices = vec![u32::MAX; tile_count];
    let mut layer = land.elevation_land_id.clone();
    let mut cliffs = Vec::new();
    let mut cliff_operation_indices = Vec::new();
    let mut pieces =
        CliffPieces::new(u32::try_from(land.appearance_objects.len()).map_err(|_| {
            invalid_request("RMSGEN3202", "cliff initial object count exceeds u32")
        })?);
    let mut appearances = CliffAppearances {
        land_count: pieces.next_instance_id,
        ..CliffAppearances::default()
    };

    for attempt_index in 0..cliff_count {
        work = bounded_work(work, maximum_work, cancellation)?;
        let rng_draws_before = rng.state().draws();
        let auxiliary_rng_draws_before = auxiliary_rng.state().draws();
        let requested_length = wrapping_range_draw(
            &mut rng,
            configuration.minimum_length,
            configuration.maximum_length,
        );
        let mut start = None;
        let mut growth_path = Vec::new();
        let mut direction_samples = Vec::new();
        if requested_length >= 3 {
            while let Some(index) = queues.pop(main_queue) {
                if eligibility[index] == 0 {
                    continue;
                }
                start = Some(index);
                growth_path.push(index);
                eligibility[index] = 0;
                break;
            }
        }
        if let Some(start_index) = start {
            let target_value =
                eligibility_value_at_start(start_index, land, elevation, coarse_width);
            let mut direction = rng.bounded(4).result as i32;
            let mut current = start_index;
            let mut first_move = true;
            for _ in 0..requested_length {
                let curl = rng.bounded(100).result as u8;
                if i32::from(curl) < configuration.curliness >> 1 {
                    direction = (direction + 3) & 3;
                } else if i32::from(curl) < configuration.curliness {
                    direction = (direction + 1) & 3;
                }
                let mut next = None;
                let mut chosen_direction = None;
                let candidate_directions = if first_move {
                    [
                        direction,
                        fallback_clockwise(direction),
                        fallback_counterclockwise(direction),
                        fallback_opposite(direction),
                    ]
                } else {
                    [
                        direction,
                        fallback_clockwise(direction),
                        fallback_counterclockwise(direction),
                        direction,
                    ]
                };
                for (candidate_ordinal, candidate_direction) in
                    candidate_directions.into_iter().enumerate()
                {
                    if !first_move && candidate_ordinal == 3 {
                        break;
                    }
                    if let Some(index) =
                        neighbor(current, candidate_direction, coarse_width, coarse_height)
                        && eligibility[index] == target_value
                    {
                        next = Some(index);
                        chosen_direction = Some(candidate_direction as u8);
                        break;
                    }
                }
                direction_samples.push(ExactCliffDirectionSample {
                    curl,
                    heading: direction as u8,
                    chosen: chosen_direction,
                });
                let Some(next) = next else {
                    break;
                };
                eligibility[next] = 0;
                growth_path.push(next);
                current = next;
                first_move = false;
                if growth_path.len() > MAXIMUM_CLIFF_LENGTH + 1 {
                    return Err(invalid_request(
                        "RMSGEN3202",
                        "cliff path exceeded its bounded length",
                    ));
                }
            }

            let path = growth_path.iter().rev().copied().collect::<Vec<_>>();
            paint_path(
                &path,
                coarse_width,
                dimensions,
                configuration,
                &mut terrain,
                &mut deferred_primary_terrain,
                &mut tile_operation_indices,
                &mut cliffs,
                &mut cliff_operation_indices,
                content,
                &mut rng,
                &mut auxiliary_rng,
                &mut pieces,
                &elevation.elevation,
                cancellation,
                &mut restriction_zones,
                &mut appearances,
                &mut layer,
            )?;
            for index in &path {
                clear_square(
                    &mut eligibility,
                    &mut queues,
                    main_queue,
                    coarse_width,
                    coarse_height,
                    index % coarse_width,
                    index / coarse_width,
                    configuration.minimum_cliff_distance,
                );
            }
            let path_coordinates = path
                .into_iter()
                .map(|index| coarse_coordinate(index, coarse_width))
                .collect();
            statistics.attempts.push(ExactCliffAttempt {
                attempt_index: u16::try_from(attempt_index)
                    .expect("u16 cliff count keeps every attempt index representable"),
                requested_length,
                start: Some(coarse_coordinate(start_index, coarse_width)),
                path: path_coordinates,
                direction_samples,
                rng_draws_before,
                rng_draws_after: rng.state().draws(),
                auxiliary_rng_draws_before,
                auxiliary_rng_draws_after: auxiliary_rng.state().draws(),
            });
        } else {
            statistics.attempts.push(ExactCliffAttempt {
                attempt_index: u16::try_from(attempt_index)
                    .expect("u16 cliff count keeps every attempt index representable"),
                requested_length,
                start: None,
                path: Vec::new(),
                direction_samples,
                rng_draws_before,
                rng_draws_after: rng.state().draws(),
                auxiliary_rng_draws_before,
                auxiliary_rng_draws_after: auxiliary_rng.state().draws(),
            });
        }
    }

    let (piece_objects, master_facets, next_instance_id) = pieces.finish();
    Ok(ExactCliffState {
        restriction_zones,
        dimensions,
        configuration,
        terrain,
        deferred_primary_terrain,
        tile_operation_indices,
        layer,
        cliffs,
        cliff_operation_indices,
        piece_objects,
        appearance_objects: appearances.live.into_iter().collect(),
        removed_land_appearances: appearances.removed_land,
        master_facets,
        next_instance_id,
        rng_state: rng.state(),
        auxiliary_rng_state: auxiliary_rng.state(),
        statistics,
    })
}

fn wrapping_range_draw(rng: &mut RmsRandom, minimum: i32, maximum: i32) -> i32 {
    minimum.wrapping_add(rng.bounded(maximum.wrapping_sub(minimum) as u32).result as i32)
}

fn select_cliff_count(
    configuration: &ExactCliffConfiguration,
    rng: &mut RmsRandom,
) -> Result<usize, GenerationError> {
    let count = wrapping_range_draw(
        rng,
        configuration.minimum_count,
        configuration.maximum_count,
    );
    if count > MAXIMUM_CLIFF_ATTEMPTS {
        return Err(invalid_request(
            "RMSGEN3202",
            "the drawn cliff count exceeds the number of cliffs the preview can attempt",
        ));
    }
    Ok(count.max(0) as usize)
}

fn eligibility_value_at_start(
    coarse_index: usize,
    land: &ExactLandState,
    elevation: &ExactElevationState,
    coarse_width: usize,
) -> u8 {
    let coarse_x = coarse_index % coarse_width;
    let coarse_y = coarse_index / coarse_width;
    let x = coarse_x * COARSE_TILE_SIZE;
    let y = coarse_y * COARSE_TILE_SIZE;
    let index = y * usize::from(land.dimensions.width) + x;
    let _ = land;
    u8::try_from(elevation.elevation[index].saturating_add(1)).unwrap_or(u8::MAX)
}

fn randomize_queue(
    queues: &mut CliffQueues,
    main_queue: usize,
    bucket_base: usize,
    width: usize,
    rng: &mut RmsRandom,
    statistics: &mut ExactCliffStatistics,
) {
    for pass in 0..2 {
        while let Some(index) = queues.pop(main_queue) {
            if statistics.randomization_pass_leading_coordinates[pass].len() < 64 {
                statistics.randomization_pass_leading_coordinates[pass]
                    .push(coarse_coordinate(index, width));
            }
            let result = rng.bounded(RANDOMIZATION_BUCKETS as u32).result as u8;
            statistics.randomization_draws += 1;
            if statistics.randomization_pass_leading_samples[pass].len() < 64 {
                statistics.randomization_pass_leading_samples[pass].push(result);
            }
            queues.insert_front(bucket_base + usize::from(result), index);
        }
        for group in (0..RANDOMIZATION_BUCKETS).step_by(4) {
            drain_interleaved(
                queues,
                main_queue,
                bucket_base + group,
                bucket_base + group + 1,
            );
            drain_interleaved(
                queues,
                main_queue,
                bucket_base + group + 2,
                bucket_base + group + 3,
            );
        }
    }
    statistics.randomization_final_leading_coordinates =
        queues.leading_coordinates(main_queue, width, 64);
}

fn drain_interleaved(queues: &mut CliffQueues, destination: usize, first: usize, second: usize) {
    loop {
        let mut moved = false;
        for source in [first, second] {
            if let Some(index) = queues.pop(source) {
                queues.insert_front(destination, index);
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn clear_square(
    eligibility: &mut [u8],
    queues: &mut CliffQueues,
    main_queue: usize,
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    radius: i32,
) {
    let Ok(radius) = usize::try_from(radius) else {
        return;
    };
    for next_y in y.saturating_sub(radius)..=(y + radius).min(height.saturating_sub(1)) {
        for next_x in x.saturating_sub(radius)..=(x + radius).min(width.saturating_sub(1)) {
            let index = next_y * width + next_x;
            eligibility[index] = 0;
            if queues.nodes[index].queue == Some(main_queue) {
                queues.remove(index);
            }
        }
    }
}

fn remove_isolated(
    eligibility: &mut [u8],
    queues: &mut CliffQueues,
    main_queue: usize,
    width: usize,
    height: usize,
) {
    let before = eligibility.to_vec();
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if before[index] == 0 {
                continue;
            }
            let connected = [
                y.checked_sub(1).map(|next| next * width + x),
                x.checked_sub(1).map(|next| y * width + next),
                (y + 1 < height).then_some((y + 1) * width + x),
                (x + 1 < width).then_some(y * width + x + 1),
            ]
            .into_iter()
            .flatten()
            .any(|next| before[next] != 0);
            if !connected {
                eligibility[index] = 0;
                if queues.nodes[index].queue == Some(main_queue) {
                    queues.remove(index);
                }
            }
        }
    }
}

fn neighbor(index: usize, direction: i32, width: usize, height: usize) -> Option<usize> {
    let x = index % width;
    let y = index / width;
    match direction & 3 {
        0 => y.checked_sub(1).map(|next| next * width + x),
        1 => (x + 1 < width).then_some(y * width + x + 1),
        2 => (y + 1 < height).then_some((y + 1) * width + x),
        _ => x.checked_sub(1).map(|next| y * width + next),
    }
}

fn fallback_clockwise(direction: i32) -> i32 {
    match direction {
        3 => 1,
        _ => direction + 1,
    }
}

fn fallback_counterclockwise(direction: i32) -> i32 {
    match direction {
        0 => 2,
        _ => direction - 1,
    }
}

fn fallback_opposite(direction: i32) -> i32 {
    match direction {
        0 => 1,
        1 => 2,
        2 => 0,
        _ => 1,
    }
}

fn coarse_coordinate(index: usize, width: usize) -> MapCoordinate {
    MapCoordinate {
        x: (index % width) as u16,
        y: (index / width) as u16,
    }
}

#[derive(Default)]
struct CliffAppearances {
    land_count: u32,
    removed_land: BTreeSet<u32>,
    live: BTreeMap<u32, ExactAppearanceObject>,
}

impl CliffAppearances {
    #[allow(clippy::too_many_arguments)]
    fn refresh_tile(
        &mut self,
        index: usize,
        previous: TerrainId,
        dimensions: MapDimensions,
        terrain: &[TerrainId],
        elevation: &[i16],
        content: CompatibleContentView<'_>,
        rng: &mut RmsRandom,
        auxiliary: &mut RmsRandom,
        pieces: &mut CliffPieces,
        zones: &mut ExactRestrictionZones,
        cancellation: &dyn CancellationToken,
    ) -> Result<(), GenerationError> {
        let previous_frames = &content
            .terrain(previous)
            .ok_or(GenerationError::IncompatibleContent)?
            .appearances;
        let source = *terrain
            .get(index)
            .ok_or(GenerationError::IncompatibleContent)?;
        let frames = &content
            .terrain(source)
            .ok_or(GenerationError::IncompatibleContent)?
            .appearances;
        let width = usize::from(dimensions.width);
        let tile = MapCoordinate {
            x: (index % width) as u16,
            y: (index / width) as u16,
        };
        let attributes = zones.runtime_attributes();
        let roster = std::sync::Arc::make_mut(&mut zones.objects);
        let mut cursor = 0;
        while let Some(&identity) = roster.members(tile).get(cursor) {
            let object = roster
                .object(identity)
                .ok_or(GenerationError::IncompatibleContent)?;
            if object.object_id.0 == 0 {
                cursor += 1;
                continue;
            }
            let removed = previous_frames
                .iter()
                .any(|frame| frame.object_id == Some(object.object_id))
                || super::exact_object::topology_placement_rejects(
                    object,
                    dimensions,
                    terrain,
                    elevation,
                    content,
                    &attributes,
                )?;
            if removed {
                if identity < self.land_count {
                    self.removed_land.insert(identity);
                } else if self.live.remove(&identity).is_none() {
                    pieces.forget_destroyed(identity)?;
                }
                super::exact_object::destroy_world_object_on_terrain(
                    roster,
                    identity,
                    content,
                    &attributes,
                    true,
                    Some(terrain),
                )?;
            } else {
                cursor += 1;
            }
        }
        consume_terrain_appearances(
            frames,
            rng,
            auxiliary,
            GenerationStage::Terrain,
            cancellation,
            |candidate, auxiliary| {
                if !super::exact_object::appearance_candidate_allows_in_world(
                    index,
                    candidate,
                    dimensions,
                    &zones.objects,
                    terrain,
                    elevation,
                    content,
                    &attributes,
                )? {
                    return Ok(false);
                }
                let accepted = super::exact_appearance::AppearanceAcceptance {
                    object_id: candidate.object_id,
                    placement: candidate.placement,
                    x_sample: candidate.x_sample,
                    y_sample: candidate.y_sample,
                    auxiliary_sample: Some(auxiliary.next_u32()),
                };
                if let Some(appearance) =
                    ExactAppearanceObject::from_acceptance(index, source, accepted)
                {
                    let (x, y) = super::exact_object::appearance_position(
                        index,
                        appearance.placement,
                        appearance.x_sample,
                        appearance.y_sample,
                        dimensions,
                    )?;
                    let identity = pieces.next_instance_id;
                    let next = identity.checked_add(1).ok_or_else(|| {
                        invalid_request("RMSGEN3202", "cliff appearance identity exceeds u32")
                    })?;
                    let hit_points =
                        attributes.initial_hit_points(appearance.object_id, 0, content)?;
                    let definition = attributes
                        .definition(appearance.object_id, 0, content)
                        .ok_or(GenerationError::IncompatibleContent)?;
                    std::sync::Arc::make_mut(&mut zones.objects).birth_on_terrain(
                        identity,
                        appearance.object_id,
                        0,
                        definition.initial_lifecycle_state,
                        [x, y],
                        dimensions,
                        hit_points,
                        definition.pathing,
                        definition.collision_half_extents(),
                        definition.position_family,
                        Some(terrain),
                    )?;
                    zones.construct(appearance.object_id, 0, dimensions, terrain, content)?;
                    self.live.insert(identity, appearance);
                    pieces.next_instance_id = next;
                }
                Ok(true)
            },
        )?;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_path(
    path: &[usize],
    coarse_width: usize,
    dimensions: MapDimensions,
    configuration: ExactCliffConfiguration,
    terrain: &mut [TerrainId],
    deferred_primary_terrain: &mut [u32],
    tile_operation_indices: &mut [u32],
    cliffs: &mut Vec<CliffEdge>,
    cliff_operation_indices: &mut Vec<u32>,
    content: CompatibleContentView<'_>,
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    pieces: &mut CliffPieces,
    elevation: &[i16],
    cancellation: &dyn CancellationToken,
    restriction_zones: &mut ExactRestrictionZones,
    appearances: &mut CliffAppearances,
    layer: &mut [u16],
) -> Result<(), GenerationError> {
    let width = usize::from(dimensions.width);
    let topology = content.terrain_topology();
    let facet = topology.cliff_facet_terrain_id.ok_or_else(|| {
        invalid_request("RMSGEN3201", "content lacks a cliff facet terrain binding")
    })?;
    let overlay = topology.cliff_overlay_terrain_id.ok_or_else(|| {
        invalid_request(
            "RMSGEN3201",
            "content lacks a cliff overlay terrain binding",
        )
    })?;
    let mut incoming_side = None;
    for (ordinal, endpoint) in path.iter().enumerate() {
        let from = coarse_coordinate(path[ordinal.saturating_sub(1)], coarse_width);
        let to = coarse_coordinate(*endpoint, coarse_width);
        let from_tile = MapCoordinate {
            x: from.x * COARSE_TILE_SIZE as u16 + 1,
            y: from.y * COARSE_TILE_SIZE as u16 + 1,
        };
        let to_tile = MapCoordinate {
            x: to.x * COARSE_TILE_SIZE as u16 + 1,
            y: to.y * COARSE_TILE_SIZE as u16 + 1,
        };
        let minimum_x = usize::from(from_tile.x.min(to_tile.x));
        let maximum_x = usize::from(from_tile.x.max(to_tile.x));
        let minimum_y = usize::from(from_tile.y.min(to_tile.y));
        let maximum_y = usize::from(from_tile.y.max(to_tile.y));
        let bounds = [
            minimum_x as i32 - 3,
            minimum_y as i32 - 3,
            maximum_x as i32 + 3,
            maximum_y as i32 + 3,
        ];
        let dx = (i32::from(to_tile.x) - i32::from(from_tile.x)).signum();
        let dy = (i32::from(to_tile.y) - i32::from(from_tile.y)).signum();
        let steps = if ordinal == 0 { 0..=0 } else { 0..=3 };
        for step in steps {
            let x = (i32::from(from_tile.x) + dx * step) as usize;
            let y = (i32::from(from_tile.y) + dy * step) as usize;
            let index = y * width + x;
            let previous = terrain[index];
            if deferred_primary_terrain[index] == u32::MAX {
                deferred_primary_terrain[index] = previous.0;
            }
            if previous != overlay {
                appearances.refresh_tile(
                    index,
                    previous,
                    dimensions,
                    terrain,
                    elevation,
                    content,
                    rng,
                    auxiliary_rng,
                    pieces,
                    restriction_zones,
                    cancellation,
                )?;
            }
        }
        repair_cliff_terrain(
            dimensions,
            terrain,
            tile_operation_indices,
            configuration.operation_index,
            bounds,
            overlay,
            content,
            cancellation,
            |index, previous, current| {
                appearances.refresh_tile(
                    index,
                    previous,
                    dimensions,
                    current,
                    elevation,
                    content,
                    rng,
                    auxiliary_rng,
                    pieces,
                    restriction_zones,
                    cancellation,
                )
            },
            layer,
        )?;
        for y in minimum_y..=maximum_y {
            for x in minimum_x..=maximum_x {
                if x < width && y < usize::from(dimensions.height) {
                    let index = y * width + x;
                    layer[index] = u16::MAX;
                    let previous = terrain[index];
                    if previous != facet {
                        terrain[index] = facet;
                        tile_operation_indices[index] = configuration.operation_index;
                        appearances.refresh_tile(
                            index,
                            previous,
                            dimensions,
                            terrain,
                            elevation,
                            content,
                            rng,
                            auxiliary_rng,
                            pieces,
                            restriction_zones,
                            cancellation,
                        )?;
                    }
                }
            }
        }
        repair_cliff_terrain(
            dimensions,
            terrain,
            tile_operation_indices,
            configuration.operation_index,
            bounds,
            facet,
            content,
            cancellation,
            |index, previous, current| {
                appearances.refresh_tile(
                    index,
                    previous,
                    dimensions,
                    current,
                    elevation,
                    content,
                    rng,
                    auxiliary_rng,
                    pieces,
                    restriction_zones,
                    cancellation,
                )
            },
            layer,
        )?;
        if ordinal != 0 {
            let style = content
                .cliff(u32::from(configuration.cliff_type))
                .ok_or_else(|| {
                    invalid_request("RMSGEN3201", "content lacks the selected cliff style")
                })?;
            incoming_side = Some(pieces.join(
                from,
                to,
                incoming_side,
                style,
                dimensions,
                elevation,
                content,
                rng,
                restriction_zones,
                terrain,
            )?);
            cliffs.push(CliffEdge {
                from: from_tile,
                to: to_tile,
                cliff_type: u32::from(configuration.cliff_type),
            });
            cliff_operation_indices.push(configuration.operation_index);
        }
    }
    Ok(())
}

const NEIGHBORS: [(i32, i32); 8] = [
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];

fn terrain_class(content: CompatibleContentView<'_>, id: TerrainId) -> Result<u8, GenerationError> {
    content
        .terrain(id)
        .map(|terrain| terrain.placement_class)
        .ok_or_else(|| {
            invalid_request(
                "RMSGEN3201",
                "cliff cleanup terrain definition is unavailable",
            )
        })
}

#[allow(clippy::too_many_arguments)]
fn repair_cliff_terrain(
    dimensions: MapDimensions,
    terrain: &mut [TerrainId],
    tile_operation_indices: &mut [u32],
    operation_index: u32,
    bounds: [i32; 4],
    target: TerrainId,
    content: CompatibleContentView<'_>,
    cancellation: &dyn CancellationToken,
    mut refresh: impl FnMut(usize, TerrainId, &[TerrainId]) -> Result<(), GenerationError>,
    layer: &mut [u16],
) -> Result<(), GenerationError> {
    let width = i32::from(dimensions.width);
    let height = i32::from(dimensions.height);
    if terrain_class(content, target)? & 0x0f != 0 {
        return Err(invalid_request(
            "RMSGEN3201",
            "cliff brush binding must be non-water terrain",
        ));
    }
    let [mut left, mut top, mut right, mut bottom] = bounds;
    left = left.max(0);
    top = top.max(0);
    right = right.min(width - 1);
    bottom = bottom.min(height - 1);
    let mut previous_changes = 0;
    let mut repeated_counts = 0;
    let mut work = 0;
    let maximum_work = (terrain.len() as u64).saturating_mul(256).max(4096);
    loop {
        left = (left - 1).max(0);
        top = (top - 1).max(0);
        right = (right + 1).min(width - 1);
        bottom = (bottom + 1).min(height - 1);
        let mut changes = 0;
        for diagonal in [false, true] {
            for y in top..=bottom {
                for x in left..=right {
                    work = bounded_work(work, maximum_work, cancellation)?;
                    let index = (y * width + x) as usize;
                    if terrain_class(content, terrain[index])? & 0x0f != 0 {
                        continue;
                    }
                    let mut water = [false; 8];
                    for (ordinal, (dx, dy)) in NEIGHBORS.iter().enumerate() {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx >= 0 && ny >= 0 && nx < width && ny < height {
                            water[ordinal] =
                                terrain_class(content, terrain[(ny * width + nx) as usize])? & 0x0f
                                    != 0;
                        }
                    }
                    if exact_terrain::water_topology_bridge(water, diagonal) {
                        for ordinal in [7, 0, 1, 2, 3, 4, 5, 6] {
                            if water[ordinal] {
                                let (dx, dy) = NEIGHBORS[ordinal];
                                let next = ((y + dy) * width + x + dx) as usize;
                                let previous = terrain[next];
                                terrain[next] = target;
                                layer[next] = u16::MAX;
                                tile_operation_indices[next] = operation_index;
                                refresh(next, previous, terrain)?;
                            }
                        }
                        changes += 1;
                    }
                }
            }
        }
        if changes == previous_changes {
            repeated_counts += 1;
        }
        previous_changes = changes;
        if changes == 0 || repeated_counts >= 5 {
            break;
        }
    }
    let topology = content.terrain_topology();
    for y in top..=bottom {
        for x in left..=right {
            work = bounded_work(work, maximum_work, cancellation)?;
            let index = (y * width + x) as usize;
            let class = terrain_class(content, terrain[index])?;
            let mut adjacent_water = false;
            let mut adjacent_frozen = false;
            for (dx, dy) in NEIGHBORS {
                let (nx, ny) = (x + dx, y + dy);
                if nx >= 0 && ny >= 0 && nx < width && ny < height {
                    let id = terrain[(ny * width + nx) as usize];
                    let next_class = terrain_class(content, id)?;
                    adjacent_water |= next_class & 0x0f != 0
                        && next_class & 0x40 == 0
                        && topology
                            .excluded_shoreline_water_terrain_ids
                            .binary_search(&id)
                            .is_err();
                    adjacent_frozen |= next_class & 0x80 != 0;
                }
            }
            let frozen = class & 0xc0 != 0 || class & 0x10 != 0;
            let should_paint = if class & 0x40 != 0 {
                adjacent_water
            } else if class & 0x10 != 0 {
                adjacent_frozen
            } else {
                class & 0x0f == 0 && adjacent_water
            };
            if should_paint {
                layer[index] = u16::MAX;
                let replacement = if frozen {
                    topology.frozen_shoreline_terrain_id
                } else {
                    topology.default_shoreline_terrain_id
                }
                .ok_or_else(|| {
                    invalid_request(
                        "RMSGEN3201",
                        "cliff cleanup shoreline binding is unavailable",
                    )
                })?;
                if terrain[index] != replacement {
                    terrain[index] = replacement;
                    tile_operation_indices[index] = operation_index;
                }
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cliff_terrain_blocked(
    content: CompatibleContentView<'_>,
    terrain: TerrainId,
) -> Result<bool, GenerationError> {
    let definition = content.terrain(terrain).ok_or_else(|| {
        invalid_request(
            "RMSGEN3201",
            "cliff input terrain is absent from compatible content",
        )
    })?;
    Ok(definition.placement_class & 0x4f != 0)
}

fn collect_configuration(
    semantic_program: &SemanticProgram,
) -> Result<ExactCliffConfiguration, GenerationError> {
    let operations = semantic_program
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            operation.accepted_by_target_parser() && operation.section == "cliff_generation"
        })
        .collect::<Vec<_>>();
    let operation_index = operations
        .first()
        .map_or(u32::MAX, |(index, _)| *index as u32);
    let mut configuration = ExactCliffConfiguration {
        cliff_type: 0,
        minimum_count: DEFAULT_MINIMUM_CLIFF_COUNT,
        maximum_count: DEFAULT_MAXIMUM_CLIFF_COUNT,
        minimum_length: DEFAULT_MINIMUM_CLIFF_LENGTH,
        maximum_length: DEFAULT_MAXIMUM_CLIFF_LENGTH,
        curliness: DEFAULT_CLIFF_CURLINESS,
        minimum_cliff_distance: DEFAULT_MINIMUM_CLIFF_DISTANCE,
        minimum_terrain_distance: DEFAULT_MINIMUM_TERRAIN_DISTANCE,
        operation_index,
    };
    for (_, operation) in operations {
        match operation.name.as_str() {
            "cliff_type" => configuration.cliff_type = cliff_type(operation)?,
            "min_number_of_cliffs" => configuration.minimum_count = rounded_i32(operation)?,
            "max_number_of_cliffs" => configuration.maximum_count = rounded_i32(operation)?,
            "min_length_of_cliff" => configuration.minimum_length = rounded_i32(operation)?,
            "max_length_of_cliff" => configuration.maximum_length = rounded_i32(operation)?,
            "cliff_curliness" => configuration.curliness = rounded_i32(operation)?,
            "min_distance_cliffs" => {
                configuration.minimum_cliff_distance = rounded_i32(operation)?;
            }
            "min_terrain_distance" => {
                configuration.minimum_terrain_distance = rounded_i32(operation)?;
            }
            _ => {}
        }
    }
    Ok(configuration)
}

fn cliff_type(operation: &SemanticOperation) -> Result<u8, GenerationError> {
    argument(operation)?
        .parse::<f32>()
        .ok()
        .filter(|value| value.is_finite())
        .map(|value| {
            let truncated = if (-2_147_483_648.0..2_147_483_648.0).contains(&value) {
                value as i32
            } else {
                i32::MIN
            };
            truncated.clamp(0, 5) as u8
        })
        .ok_or_else(|| invalid_request("RMSGEN3201", "cliff_type must be a number"))
}

fn rounded_i32(operation: &SemanticOperation) -> Result<i32, GenerationError> {
    let value = argument(operation)?
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN3201", "cliff control is not numeric"))?
        .round();
    if !value.is_finite() || value < i32::MIN as f32 || value >= 2_147_483_648.0 {
        return Err(invalid_request(
            "RMSGEN3201",
            "cliff control exceeds the 32-bit range",
        ));
    }
    Ok(value as i32)
}

fn argument(operation: &SemanticOperation) -> Result<&str, GenerationError> {
    operation
        .arguments
        .first()
        .map(|argument| argument.value.as_str())
        .ok_or_else(|| invalid_request("RMSGEN3201", "cliff command is missing its argument"))
}

fn bounded_work(
    work: u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<u64, GenerationError> {
    let work = work.saturating_add(1);
    if work > maximum_work {
        return Err(invalid_request(
            "RMSGEN3202",
            "cliff generation exhausted its bounded work budget",
        ));
    }
    if work.is_multiple_of(1024) {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, work)?;
    }
    Ok(work)
}
