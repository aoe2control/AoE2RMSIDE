use super::*;
use rms_semantics::{RmsRandom, RmsRngState, SemanticOperation};
use std::collections::BTreeSet;

const MAXIMUM_ELEVATION_DESCRIPTORS: usize = 4096;
const _: () = assert!(MAXIMUM_ELEVATION_DESCRIPTORS <= u16::MAX as usize + 1);
const MAXIMUM_ELEVATION_CLUMPS: usize = 999;
const MAXIMUM_ELEVATION_ATTEMPT_SAMPLES: usize = 262_144;
const RANDOMIZATION_BUCKETS: usize = 100;
const ELEVATION_CLEANUP_LIMIT: i16 = 8;
const PLAYER_AVOIDANCE_RADIUS: i32 = 13;
const PLAYER_AVOIDANCE_WEIGHT: i32 = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactElevationDescriptor {
    pub target_tiles: u32,
    pub height: u8,
    pub clumps: u16,
    pub spacing: u32,
    pub base_terrain_id: TerrainId,
    pub base_elevation: i16,
    pub base_layer: u16,
    pub balanced: bool,
    pub scaling: ExactElevationScaling,
    pub operation_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactElevationScaling {
    None,
    Size,
    Groups,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactElevationAttemptOutcome {
    Accepted,
    RejectedModifier,
    RejectedTerrainOrSpacing,
    RejectedBaseElevation,
}

impl ExactElevationAttemptOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::RejectedModifier => "rejected-modifier",
            Self::RejectedTerrainOrSpacing => "rejected-terrain-or-spacing",
            Self::RejectedBaseElevation => "rejected-base-elevation",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactElevationAttemptSample {
    pub descriptor_index: u16,
    pub x: i32,
    pub y: i32,
    pub match_count: u8,
    pub outcome: ExactElevationAttemptOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactElevationInitialPopSample {
    pub descriptor_index: u16,
    pub coordinate: MapCoordinate,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactElevationStatistics {
    pub initial_candidates: u64,
    pub initial_popped_candidates: u64,
    pub initial_seeds: u64,
    pub initial_seed_coordinates: Vec<MapCoordinate>,
    pub initial_pop_samples: Vec<ExactElevationInitialPopSample>,
    pub popped_candidates: u64,
    pub accepted_tiles: u64,
    pub rejected_modifier: u64,
    pub rejected_terrain_or_spacing: u64,
    pub rejected_base_elevation: u64,
    pub randomization_draws: u64,
    pub randomization_leading_samples: Vec<u8>,
    pub randomization_pass_leading_samples: [Vec<u8>; 2],
    pub randomization_pass_leading_coordinates: [Vec<MapCoordinate>; 2],
    pub randomization_final_leading_coordinates: Vec<MapCoordinate>,
    pub modifier_draws: u64,
    pub priority_draws: [u64; 4],
    pub attempt_samples: Vec<ExactElevationAttemptSample>,
    pub descriptor_boundaries: Vec<ExactElevationDescriptorBoundary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactElevationDescriptorBoundary {
    pub descriptor_index: u16,
    pub candidate_count: u64,
    pub initial_popped_candidates: u64,
    pub initial_seeds: u64,
    pub popped_candidates: u64,
    pub accepted_tiles: u64,
    pub rejected_modifier: u64,
    pub rejected_terrain_or_spacing: u64,
    pub rejected_base_elevation: u64,
    pub randomization_draws: u64,
    pub modifier_draws: u64,
    pub priority_draws: [u64; 4],
    pub rng_draws_before: u64,
    pub rng_draws_after: u64,
    pub elevation_before_hash: [u8; 32],
    pub elevation_after_descriptor_hash: [u8; 32],
    pub elevation_after_cleanup_hash: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactElevationState {
    pub dimensions: MapDimensions,
    pub descriptors: Vec<ExactElevationDescriptor>,
    pub modifier: Vec<u8>,
    pub elevation: Vec<i16>,
    pub tile_operation_indices: Vec<u32>,
    pub rng_state: RmsRngState,
    pub statistics: ExactElevationStatistics,
}

impl ExactElevationState {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-elevation-state-v1");
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.u32(self.elevation.len() as u32);
        writer.bytes(&self.modifier);
        for value in &self.elevation {
            writer.i16(*value);
        }
        writer.bytes(&self.rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

pub(crate) fn terrain_shape_code(
    index: usize,
    elevation: &[i16],
    width: usize,
    height: usize,
) -> Option<u8> {
    if width == 0
        || height == 0
        || elevation.len() != width.checked_mul(height)?
        || index >= elevation.len()
    {
        return None;
    }
    let x = index % width;
    let y = index / width;
    let center = elevation[index];
    let neighbour = |dx: isize, dy: isize| {
        let Some(nx) = x.checked_add_signed(dx) else {
            return center;
        };
        let Some(ny) = y.checked_add_signed(dy) else {
            return center;
        };
        if nx >= width || ny >= height {
            center
        } else {
            elevation[ny * width + nx]
        }
    };
    let higher = center.saturating_add(1);
    let lower = center.saturating_sub(1);
    let north_west = neighbour(-1, -1);
    let north = neighbour(0, -1);
    let north_east = neighbour(1, -1);
    let east = neighbour(1, 0);
    let south_east = neighbour(1, 1);
    let south = neighbour(0, 1);
    let south_west = neighbour(-1, 1);
    let west = neighbour(-1, 0);

    Some(if north == higher && east == higher {
        14
    } else if west == higher && south == higher {
        13
    } else if north == higher && west == higher {
        16
    } else if east == higher && south == higher {
        15
    } else if north == higher {
        6
    } else if east == higher {
        8
    } else if west == higher {
        5
    } else if south == higher {
        7
    } else if north_east == higher {
        if west == lower && south == lower {
            2
        } else {
            10
        }
    } else if south_west == higher {
        if north == lower && east == lower {
            1
        } else {
            9
        }
    } else if north_west == higher {
        if east == lower && south == lower {
            3
        } else {
            11
        }
    } else if south_east == higher {
        if north == lower && west == lower {
            4
        } else {
            12
        }
    } else {
        0
    })
}

fn terrain_shape_height_offset(shape: u8, x_fraction: f32, y_fraction: f32) -> f32 {
    debug_assert!((0.0..1.0).contains(&x_fraction));
    debug_assert!((0.0..1.0).contains(&y_fraction));
    let inverse_x = 1.0 - x_fraction;
    let inverse_y = 1.0 - y_fraction;
    match shape {
        1 => y_fraction.min(inverse_x),
        2 => x_fraction.min(inverse_y),
        3 => 1.0 - x_fraction.max(y_fraction),
        4 => x_fraction.min(y_fraction),
        5 => inverse_x,
        6 => inverse_y,
        7 => y_fraction,
        8 => x_fraction,
        9 => (y_fraction - x_fraction).max(0.0),
        10 => (x_fraction - y_fraction).max(0.0),
        11 => (1.0 - x_fraction - y_fraction).max(0.0),
        12 => (x_fraction + y_fraction - 1.0).max(0.0),
        13 => y_fraction.max(inverse_x),
        14 => x_fraction.max(inverse_y),
        15 => x_fraction.max(y_fraction),
        16 => 1.0 - x_fraction.min(y_fraction),
        _ => 0.0,
    }
}

pub(crate) fn terrain_height_f32(
    x: f32,
    y: f32,
    dimensions: MapDimensions,
    elevation: &[i16],
) -> Option<f32> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let tile_count = width.checked_mul(height)?;
    if width == 0
        || height == 0
        || elevation.len() != tile_count
        || !x.is_finite()
        || !y.is_finite()
    {
        return None;
    }
    let mut x = x.max(0.0);
    let mut y = y.max(0.0);
    let maximum_x = f32::from(dimensions.width);
    let maximum_y = f32::from(dimensions.height);
    if x >= maximum_x {
        x = maximum_x - 0.001;
    }
    if y >= maximum_y {
        y = maximum_y - 0.001;
    }
    let tile_x = x.trunc() as usize;
    let tile_y = y.trunc() as usize;
    let index = tile_y.checked_mul(width)?.checked_add(tile_x)?;
    let shape = terrain_shape_code(index, elevation, width, height)?;
    let x_fraction = x - tile_x as f32;
    let y_fraction = y - tile_y as f32;
    Some(elevation[index] as f32 + terrain_shape_height_offset(shape, x_fraction, y_fraction))
}

pub(crate) fn terrain_height_from_f32(
    x: f32,
    y: f32,
    dimensions: MapDimensions,
    elevation: &[i16],
) -> Option<i32> {
    terrain_height_f32(x, y, dimensions, elevation)
        .map(|projected| (f64::from(projected) * 256.0).round() as i32)
}

#[derive(Clone, Copy, Debug)]
enum ElevationPrevious {
    Header(usize),
    Node(usize),
}

#[derive(Clone, Debug, Default)]
struct ElevationNode {
    previous: Option<ElevationPrevious>,
    next: Option<usize>,
    total_cost_bits: u32,
}

struct ElevationQueues {
    heads: Vec<Option<usize>>,
    nodes: Vec<ElevationNode>,
}

impl ElevationQueues {
    fn new(queue_count: usize, tile_count: usize) -> Self {
        Self {
            heads: vec![None; queue_count],
            nodes: vec![ElevationNode::default(); tile_count],
        }
    }

    fn reset_head(&mut self, queue: usize) {
        self.heads[queue] = None;
    }

    fn clear_head_preserving_node_links(&mut self, queue: usize) {
        if let Some(head) = self.heads[queue] {
            self.nodes[head].previous = None;
            self.heads[queue] = None;
        }
    }

    fn remove(&mut self, index: usize) {
        let previous = self.nodes[index].previous;
        let next = self.nodes[index].next;
        match previous {
            Some(ElevationPrevious::Header(queue)) => self.heads[queue] = next,
            Some(ElevationPrevious::Node(previous)) => self.nodes[previous].next = next,
            None => {}
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        }
        self.nodes[index].previous = None;
        self.nodes[index].next = None;
    }

    fn insert_front(&mut self, queue: usize, index: usize) {
        self.remove(index);
        let next = self.heads[queue];
        self.nodes[index].previous = Some(ElevationPrevious::Header(queue));
        self.nodes[index].next = next;
        if let Some(next) = next {
            self.nodes[next].previous = Some(ElevationPrevious::Node(index));
        }
        self.heads[queue] = Some(index);
    }

    fn insert_priority(&mut self, queue: usize, index: usize, total_cost: f32) {
        self.remove(index);
        let mut previous = ElevationPrevious::Header(queue);
        let mut current = self.heads[queue];
        while let Some(item) = current {
            if f32::from_bits(self.nodes[item].total_cost_bits) >= total_cost {
                break;
            }
            previous = ElevationPrevious::Node(item);
            current = self.nodes[item].next;
        }
        self.nodes[index].previous = Some(previous);
        self.nodes[index].next = current;
        self.nodes[index].total_cost_bits = total_cost.to_bits();
        match previous {
            ElevationPrevious::Header(queue) => self.heads[queue] = Some(index),
            ElevationPrevious::Node(previous) => self.nodes[previous].next = Some(index),
        }
        if let Some(current) = current {
            self.nodes[current].previous = Some(ElevationPrevious::Node(index));
        }
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

pub fn resolve_exact_elevation_state(
    semantic_program: &SemanticProgram,
    land: &ExactLandState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactElevationState, GenerationError> {
    let dimensions = land.dimensions;
    let tile_count = dimensions.tile_count()?;
    let descriptors = collect_descriptors(semantic_program, dimensions, content)?;
    if descriptors.len() > MAXIMUM_ELEVATION_DESCRIPTORS {
        return Err(invalid_request(
            "RMSGEN3101",
            "elevation descriptor count exceeds its bounded limit",
        ));
    }

    if !semantic_program.has_section("elevation_generation") {
        return Ok(ExactElevationState {
            dimensions,
            descriptors,
            modifier: vec![0; tile_count],
            elevation: land.elevation.clone(),
            tile_operation_indices: vec![u32::MAX; tile_count],
            rng_state: rng.state(),
            statistics: ExactElevationStatistics::default(),
        });
    }

    rng.next_u32();

    let mut elevation = land.elevation.clone();
    let mut modifiers = build_modifiers(land, cancellation)?;
    let mut operation_indices = vec![u32::MAX; tile_count];
    let mut statistics = ExactElevationStatistics::default();
    const CLUMP_QUEUE_BASE: usize = 1;
    const BUCKET_QUEUE_BASE: usize = CLUMP_QUEUE_BASE + MAXIMUM_ELEVATION_CLUMPS;
    let mut queues = ElevationQueues::new(BUCKET_QUEUE_BASE + RANDOMIZATION_BUCKETS, tile_count);
    let maximum_work = (tile_count as u64)
        .saturating_mul(descriptors.len().max(1) as u64)
        .saturating_mul(256)
        .max(4096);
    let mut work = 0_u64;

    if descriptors.is_empty() {
        clean_elevation(
            &mut elevation,
            dimensions,
            &mut work,
            maximum_work,
            cancellation,
        )?;
    }

    for (descriptor_index, descriptor) in descriptors.iter().enumerate() {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, work)?;
        let statistics_before = (
            statistics.initial_popped_candidates,
            statistics.initial_seeds,
            statistics.popped_candidates,
            statistics.accepted_tiles,
            statistics.rejected_modifier,
            statistics.rejected_terrain_or_spacing,
            statistics.rejected_base_elevation,
            statistics.randomization_draws,
            statistics.modifier_draws,
            statistics.priority_draws,
        );
        let rng_draws_before = rng.state().draws();
        let elevation_before_hash = elevation_hash(&elevation);
        let candidate_count = generate_descriptor(
            descriptor_index,
            descriptor,
            land,
            &mut modifiers,
            &mut elevation,
            &mut operation_indices,
            &mut queues,
            &mut rng,
            &mut statistics,
            &mut work,
            maximum_work,
            cancellation,
        )?;
        let rng_draws_after = rng.state().draws();
        let elevation_after_descriptor_hash = elevation_hash(&elevation);
        clean_elevation(
            &mut elevation,
            dimensions,
            &mut work,
            maximum_work,
            cancellation,
        )?;
        statistics
            .descriptor_boundaries
            .push(ExactElevationDescriptorBoundary {
                descriptor_index: descriptor_index as u16,
                candidate_count,
                initial_popped_candidates: statistics
                    .initial_popped_candidates
                    .saturating_sub(statistics_before.0),
                initial_seeds: statistics.initial_seeds.saturating_sub(statistics_before.1),
                popped_candidates: statistics
                    .popped_candidates
                    .saturating_sub(statistics_before.2),
                accepted_tiles: statistics
                    .accepted_tiles
                    .saturating_sub(statistics_before.3),
                rejected_modifier: statistics
                    .rejected_modifier
                    .saturating_sub(statistics_before.4),
                rejected_terrain_or_spacing: statistics
                    .rejected_terrain_or_spacing
                    .saturating_sub(statistics_before.5),
                rejected_base_elevation: statistics
                    .rejected_base_elevation
                    .saturating_sub(statistics_before.6),
                randomization_draws: statistics
                    .randomization_draws
                    .saturating_sub(statistics_before.7),
                modifier_draws: statistics
                    .modifier_draws
                    .saturating_sub(statistics_before.8),
                priority_draws: std::array::from_fn(|direction| {
                    statistics.priority_draws[direction]
                        .saturating_sub(statistics_before.9[direction])
                }),
                rng_draws_before,
                rng_draws_after,
                elevation_before_hash,
                elevation_after_descriptor_hash,
                elevation_after_cleanup_hash: elevation_hash(&elevation),
            });
    }

    Ok(ExactElevationState {
        dimensions,
        descriptors,
        modifier: modifiers,
        elevation,
        tile_operation_indices: operation_indices,
        rng_state: rng.state(),
        statistics,
    })
}

#[allow(clippy::too_many_arguments)]
fn generate_descriptor(
    descriptor_index: usize,
    descriptor: &ExactElevationDescriptor,
    land: &ExactLandState,
    modifiers: &mut [u8],
    elevation: &mut [i16],
    operation_indices: &mut [u32],
    queues: &mut ElevationQueues,
    rng: &mut RmsRandom,
    statistics: &mut ExactElevationStatistics,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<u64, GenerationError> {
    let dimensions = land.dimensions;
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let clump_count = usize::from(descriptor.clumps).min(MAXIMUM_ELEVATION_CLUMPS);
    let main_queue = 0;
    let clump_queue_base = 1;
    let bucket_queue_base = clump_queue_base + MAXIMUM_ELEVATION_CLUMPS;
    queues.reset_head(main_queue);
    for queue in clump_queue_base..clump_queue_base + clump_count {
        queues.reset_head(queue);
    }
    let mut candidate_count = 0_u64;

    for y in 0..height {
        for x in 0..width {
            *work = bounded_work(*work, maximum_work, cancellation)?;
            let index = y * width + x;
            if land.terrain[index] == descriptor.base_terrain_id
                && elevation[index] == descriptor.base_elevation
                && land.elevation_land_id[index] == descriptor.base_layer
                && modifiers[index] == 0
            {
                queues.insert_front(main_queue, index);
                statistics.initial_candidates += 1;
                candidate_count += 1;
            }
        }
    }
    randomize_queue(
        queues,
        main_queue,
        bucket_queue_base,
        width,
        rng,
        statistics,
    );

    let removal_radius = initial_separation_radius(descriptor);
    let mut placed = 0_u32;
    let mut seeded_clumps = 0_usize;
    while seeded_clumps < clump_count {
        let Some(index) = queues.pop(main_queue) else {
            break;
        };
        statistics.initial_popped_candidates += 1;
        let x = index % width;
        let y = index / width;
        if statistics.initial_pop_samples.len() < MAXIMUM_ELEVATION_ATTEMPT_SAMPLES {
            statistics
                .initial_pop_samples
                .push(ExactElevationInitialPopSample {
                    descriptor_index: descriptor_index as u16,
                    coordinate: MapCoordinate {
                        x: x as u16,
                        y: y as u16,
                    },
                });
        }
        if modifiers[index] != 0
            || !matches_spacing(
                x,
                y,
                descriptor,
                land,
                elevation,
                usize::from(descriptor.spacing as u8),
            )
        {
            continue;
        }
        if !descriptor.balanced {
            unlink_square(queues, x, y, removal_radius, width, height);
        }
        elevation[index] = i16::from(descriptor.height);
        operation_indices[index] = descriptor.operation_index;
        placed = placed.saturating_add(1);
        statistics.initial_seeds += 1;
        statistics.initial_seed_coordinates.push(MapCoordinate {
            x: x as u16,
            y: y as u16,
        });
        statistics.accepted_tiles += 1;
        push_seed_neighbors(
            queues,
            clump_queue_base + seeded_clumps,
            x,
            y,
            width,
            height,
        );
        seeded_clumps += 1;
    }

    loop {
        if placed >= descriptor.target_tiles {
            break;
        }
        let mut popped_any = false;
        for clump in 0..clump_count {
            if placed >= descriptor.target_tiles {
                break;
            }
            let queue = clump_queue_base + clump;
            let Some(index) = queues.pop(queue) else {
                continue;
            };
            popped_any = true;
            *work = bounded_work(*work, maximum_work, cancellation)?;
            statistics.popped_candidates += 1;
            let x = index % width;
            let y = index / width;
            let modifier_draw = rng.bounded(100).result as u8;
            statistics.modifier_draws += 1;
            if !modifier_accepts(&mut modifiers[index], modifier_draw) {
                statistics.rejected_modifier += 1;
                record_attempt(
                    statistics,
                    descriptor_index,
                    x,
                    y,
                    0,
                    ExactElevationAttemptOutcome::RejectedModifier,
                );
                continue;
            }
            let match_count = match_count(x, y, descriptor, land, elevation);
            if match_count == 0 {
                statistics.rejected_terrain_or_spacing += 1;
                record_attempt(
                    statistics,
                    descriptor_index,
                    x,
                    y,
                    match_count,
                    ExactElevationAttemptOutcome::RejectedTerrainOrSpacing,
                );
                continue;
            }
            if elevation[index] != descriptor.base_elevation {
                statistics.rejected_base_elevation += 1;
                record_attempt(
                    statistics,
                    descriptor_index,
                    x,
                    y,
                    match_count,
                    ExactElevationAttemptOutcome::RejectedBaseElevation,
                );
                continue;
            }

            elevation[index] = i16::from(descriptor.height);
            operation_indices[index] = descriptor.operation_index;
            placed = placed.saturating_add(1);
            statistics.accepted_tiles += 1;
            record_attempt(
                statistics,
                descriptor_index,
                x,
                y,
                match_count,
                ExactElevationAttemptOutcome::Accepted,
            );
            let priority_base = 250_i32.saturating_sub(15_i32.saturating_mul(match_count.into()));
            for (direction, next) in [
                (0, x.checked_sub(1).map(|next_x| (next_x, y))),
                (1, (x + 1 < width).then_some((x + 1, y))),
                (2, y.checked_sub(1).map(|next_y| (x, next_y))),
                (3, (y + 1 < height).then_some((x, y + 1))),
            ] {
                let Some((next_x, next_y)) = next else {
                    continue;
                };
                let next_index = next_y * width + next_x;
                if elevation[next_index] != descriptor.base_elevation {
                    continue;
                }
                let draw = rng.bounded(100).result as i32;
                statistics.priority_draws[direction] += 1;
                queues.insert_priority(queue, next_index, (draw + priority_base) as f32);
            }
        }
        if !popped_any {
            break;
        }
    }
    for queue in clump_queue_base..clump_queue_base + clump_count {
        queues.clear_head_preserving_node_links(queue);
    }
    Ok(candidate_count)
}

fn modifier_accepts(modifier: &mut u8, draw: u8) -> bool {
    if *modifier <= draw {
        return true;
    }
    *modifier = 101;
    false
}

fn randomize_queue(
    queues: &mut ElevationQueues,
    main_queue: usize,
    bucket_queue_base: usize,
    width: usize,
    rng: &mut RmsRandom,
    statistics: &mut ExactElevationStatistics,
) {
    for bucket in 0..RANDOMIZATION_BUCKETS {
        queues.reset_head(bucket_queue_base + bucket);
    }
    for pass in 0..2 {
        while let Some(index) = queues.pop(main_queue) {
            if statistics.randomization_pass_leading_coordinates[pass].len() < 64 {
                statistics.randomization_pass_leading_coordinates[pass].push(MapCoordinate {
                    x: (index % width) as u16,
                    y: (index / width) as u16,
                });
            }
            let result = rng.bounded(RANDOMIZATION_BUCKETS as u32).result as u8;
            let bucket = usize::from(result);
            statistics.randomization_draws += 1;
            if statistics.randomization_leading_samples.len() < 64 {
                statistics.randomization_leading_samples.push(result);
            }
            if statistics.randomization_pass_leading_samples[pass].len() < 64 {
                statistics.randomization_pass_leading_samples[pass].push(result);
            }
            queues.insert_front(bucket_queue_base + bucket, index);
        }
        for group in (0..RANDOMIZATION_BUCKETS).step_by(4) {
            drain_interleaved_bucket_pair(
                queues,
                main_queue,
                bucket_queue_base + group,
                bucket_queue_base + group + 1,
            );
            drain_interleaved_bucket_pair(
                queues,
                main_queue,
                bucket_queue_base + group + 2,
                bucket_queue_base + group + 3,
            );
        }
    }
    if statistics
        .randomization_final_leading_coordinates
        .is_empty()
    {
        statistics.randomization_final_leading_coordinates =
            queues.leading_coordinates(main_queue, width, 64);
    }
}

fn drain_interleaved_bucket_pair(
    queues: &mut ElevationQueues,
    destination: usize,
    first: usize,
    second: usize,
) {
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

fn initial_separation_radius(descriptor: &ExactElevationDescriptor) -> usize {
    let per_clump = descriptor.target_tiles as f32 / f32::from(descriptor.clumps.max(1));
    ((per_clump.sqrt().trunc() as usize) / 2).max(2)
}

fn matches_spacing(
    x: usize,
    y: usize,
    descriptor: &ExactElevationDescriptor,
    land: &ExactLandState,
    elevation: &[i16],
    radius: usize,
) -> bool {
    let width = usize::from(land.dimensions.width);
    let height = usize::from(land.dimensions.height);
    for next_y in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
        for next_x in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
            let index = next_y * width + next_x;
            if land.terrain[index] != descriptor.base_terrain_id
                || land.elevation_land_id[index] != descriptor.base_layer
                || elevation[index] < descriptor.base_elevation
            {
                return false;
            }
        }
    }
    true
}

fn match_count(
    x: usize,
    y: usize,
    descriptor: &ExactElevationDescriptor,
    land: &ExactLandState,
    elevation: &[i16],
) -> u8 {
    if !matches_spacing(
        x,
        y,
        descriptor,
        land,
        elevation,
        descriptor.spacing as usize,
    ) {
        return 0;
    }
    let width = usize::from(land.dimensions.width);
    let height = usize::from(land.dimensions.height);
    let mut count = 0_u8;
    for next_y in y.saturating_sub(2)..=(y + 2).min(height - 1) {
        for next_x in x.saturating_sub(2)..=(x + 2).min(width - 1) {
            if elevation[next_y * width + next_x] == i16::from(descriptor.height) {
                count = count.saturating_add(1);
            }
        }
    }
    count
}

fn unlink_square(
    queues: &mut ElevationQueues,
    x: usize,
    y: usize,
    radius: usize,
    width: usize,
    height: usize,
) {
    let minimum_x = x.saturating_sub(radius);
    let maximum_x = (x + radius).min(width - 1);
    let minimum_y = y.saturating_sub(radius);
    let maximum_y = maximum_x.min(height - 1);
    if minimum_y > maximum_y {
        return;
    }
    for next_y in minimum_y..=maximum_y {
        for next_x in minimum_x..=maximum_x {
            queues.remove(next_y * width + next_x);
        }
    }
}

fn push_seed_neighbors(
    queues: &mut ElevationQueues,
    queue: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) {
    let neighbors = [
        (x > 0).then_some(y * width + x.saturating_sub(1)),
        (y > 0).then_some((y.saturating_sub(1)) * width + x),
        (x + 1 < width).then_some(y * width + x + 1),
        (y + 1 < height).then_some((y + 1) * width + x),
    ];
    for index in neighbors.into_iter().flatten() {
        queues.insert_priority(queue, index, 0.0);
    }
}

fn clean_elevation(
    elevation: &mut [i16],
    dimensions: MapDimensions,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    loop {
        while cleanup_cardinal_pinch_pass(
            elevation,
            width,
            height,
            work,
            maximum_work,
            cancellation,
        )? {}
        let topology_changed =
            cleanup_topology_pass(elevation, width, height, work, maximum_work, cancellation)?;
        let slope_changed =
            cleanup_slope_pass(elevation, width, height, work, maximum_work, cancellation)?;
        if !topology_changed && !slope_changed {
            break;
        }
    }
    Ok(())
}

fn cleanup_cardinal_pinch_pass(
    elevation: &mut [i16],
    width: usize,
    height: usize,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<bool, GenerationError> {
    let mut changed = false;
    for y in 0..height {
        for x in 0..width {
            *work = bounded_work(*work, maximum_work, cancellation)?;
            let index = y * width + x;
            let current = elevation[index];
            let north = y > 0 && elevation[index - width] > current;
            let south = y + 1 < height && elevation[index + width] > current;
            let west = x > 0 && elevation[index - 1] > current;
            let east = x + 1 < width && elevation[index + 1] > current;
            if (north && south) || (east && west) {
                if current < ELEVATION_CLEANUP_LIMIT {
                    elevation[index] = current + 1;
                    changed = true;
                } else {
                    changed |= lower_greater_neighbours(elevation, width, height, x, y, current);
                }
            }
        }
    }
    Ok(changed)
}

fn cleanup_topology_pass(
    elevation: &mut [i16],
    width: usize,
    height: usize,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<bool, GenerationError> {
    let mut changed = false;
    for y in 0..height {
        for x in 0..width {
            *work = bounded_work(*work, maximum_work, cancellation)?;
            let index = y * width + x;
            let current = elevation[index];
            let greater = |next_x: isize, next_y: isize| -> bool {
                let next_x = x as isize + next_x;
                let next_y = y as isize + next_y;
                next_x >= 0
                    && next_y >= 0
                    && (next_x as usize) < width
                    && (next_y as usize) < height
                    && elevation[next_y as usize * width + next_x as usize] > current
            };
            let nw = greater(-1, -1);
            let north = greater(0, -1);
            let ne = greater(1, -1);
            let east = greater(1, 0);
            let se = greater(1, 1);
            let south = greater(0, 1);
            let sw = greater(-1, 1);
            let west = greater(-1, 0);

            let mut fill = nw
                && ((ne && !north)
                    || (east && !ne)
                    || (sw && !west)
                    || (south && !sw)
                    || (se && !south && !east));
            fill |= ne
                && !fill
                && ((se && !east)
                    || (south && !se)
                    || (nw && !north)
                    || (west && !nw)
                    || (sw && !west && !south));
            fill |= se
                && !fill
                && ((sw && !south)
                    || (west && !sw)
                    || (ne && !east)
                    || (north && !ne)
                    || (nw && !north && !west));
            let southwest_preserves_topology = (!nw || west)
                && (!north || nw)
                && (!se || south)
                && (!east || se)
                && (!ne || east || north);
            fill |= sw && !fill && !southwest_preserves_topology;
            if fill {
                if current < ELEVATION_CLEANUP_LIMIT {
                    elevation[index] = current + 1;
                    changed = true;
                } else {
                    changed |= lower_greater_neighbours(elevation, width, height, x, y, current);
                }
            }
        }
    }
    Ok(changed)
}

fn lower_greater_neighbours(
    elevation: &mut [i16],
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    current: i16,
) -> bool {
    let mut changed = false;
    for next_y in y.saturating_sub(1)..=(y + 1).min(height - 1) {
        for next_x in x.saturating_sub(1)..=(x + 1).min(width - 1) {
            let next_index = next_y * width + next_x;
            if elevation[next_index] > current {
                elevation[next_index] = current;
                changed = true;
            }
        }
    }
    changed
}

fn cleanup_slope_pass(
    elevation: &mut [i16],
    width: usize,
    height: usize,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<bool, GenerationError> {
    let mut changed = false;
    for y in 0..height {
        for x in 0..width {
            *work = bounded_work(*work, maximum_work, cancellation)?;
            let index = y * width + x;
            let current = elevation[index];
            if current == ELEVATION_CLEANUP_LIMIT {
                continue;
            }
            let next = if current < ELEVATION_CLEANUP_LIMIT {
                current + 1
            } else {
                current - 1
            };
            let mut too_steep = false;
            for next_y in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for next_x in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    let neighbour = elevation[next_y * width + next_x];
                    too_steep |= if current < ELEVATION_CLEANUP_LIMIT {
                        neighbour > next
                    } else {
                        neighbour < next
                    };
                }
            }
            if too_steep {
                elevation[index] = next;
                changed = true;
            }
        }
    }
    Ok(changed)
}

fn build_modifiers(
    land: &ExactLandState,
    cancellation: &dyn CancellationToken,
) -> Result<Vec<u8>, GenerationError> {
    let width = usize::from(land.dimensions.width);
    let height = usize::from(land.dimensions.height);
    let centers = land
        .descriptors
        .iter()
        .filter_map(|descriptor| descriptor.assigned_slot.map(|_| descriptor.position))
        .collect::<BTreeSet<_>>();
    let mut modifiers = vec![0_u8; land.terrain.len()];
    for y in 0..height {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, y as u64)?;
        for x in 0..width {
            let mut modifier = 0_i32;
            for center in &centers {
                let delta_x = x as i32 - i32::from(center.x);
                let delta_y = y as i32 - i32::from(center.y);
                let squared = delta_x.saturating_mul(delta_x) + delta_y.saturating_mul(delta_y);
                let distance = (squared as f32).sqrt().trunc() as i32;
                let remaining = PLAYER_AVOIDANCE_RADIUS - distance;
                if remaining > 0 {
                    modifier =
                        modifier.saturating_add(PLAYER_AVOIDANCE_WEIGHT.saturating_mul(remaining));
                }
            }
            modifiers[y * width + x] = modifier.min(101) as u8;
        }
    }
    Ok(modifiers)
}

fn elevation_hash(elevation: &[i16]) -> [u8; 32] {
    let bytes = elevation
        .iter()
        .map(|value| u8::try_from(*value).unwrap_or(u8::MAX))
        .collect::<Vec<_>>();
    Sha256::digest(bytes).into()
}

fn record_attempt(
    statistics: &mut ExactElevationStatistics,
    descriptor_index: usize,
    x: usize,
    y: usize,
    match_count: u8,
    outcome: ExactElevationAttemptOutcome,
) {
    if statistics.attempt_samples.len() < MAXIMUM_ELEVATION_ATTEMPT_SAMPLES {
        statistics
            .attempt_samples
            .push(ExactElevationAttemptSample {
                descriptor_index: descriptor_index as u16,
                x: x as i32,
                y: y as i32,
                match_count,
                outcome,
            });
    }
}

const MAXIMUM_ELEVATION_LAYER_HEIGHT: u8 = 16;

fn collect_descriptors(
    semantic_program: &SemanticProgram,
    dimensions: MapDimensions,
    content: CompatibleContentView<'_>,
) -> Result<Vec<ExactElevationDescriptor>, GenerationError> {
    let default_terrain = native_generation_bindings(content)?.default_terrain_id;
    let mut descriptors = Vec::<ExactElevationDescriptor>::new();
    let mut range: Option<(usize, usize)> = None;
    for (operation_index, operation) in semantic_program.operations.iter().enumerate() {
        if !operation.accepted_by_target_parser() || operation.section != "elevation_generation" {
            continue;
        }
        if operation.depth == 0 {
            if operation.name != "create_elevation" {
                continue;
            }
            let height = numeric_i32(operation, 0)?;
            let start = descriptors.len();
            if height < 0 {
                let removed = height.unsigned_abs() as usize;
                if removed > start {
                    return Err(invalid_request(
                        "RMSGEN3101",
                        "create_elevation with a negative height larger than the elevations \
                         created before it makes the game fail; the preview cannot show it",
                    ));
                }
                descriptors.truncate(start - removed);
                range = Some((start, start));
                continue;
            }
            for layer in 1..=height {
                if descriptors.len() >= MAXIMUM_ELEVATION_DESCRIPTORS {
                    return Err(invalid_request(
                        "RMSGEN3101",
                        "elevation descriptor count exceeds its bounded limit",
                    ));
                }
                descriptors.push(ExactElevationDescriptor {
                    target_tiles: u32::from(dimensions.width),
                    height: layer.min(i32::from(MAXIMUM_ELEVATION_LAYER_HEIGHT)) as u8,
                    clumps: 1,
                    spacing: if layer == 1 { 2 } else { 1 },
                    base_terrain_id: default_terrain,
                    base_elevation: i16::try_from(layer - 1).map_err(|_| {
                        invalid_request("RMSGEN3101", "elevation layer exceeds i16")
                    })?,
                    base_layer: u16::MAX,
                    balanced: false,
                    scaling: ExactElevationScaling::None,
                    operation_index: operation_index as u32,
                });
            }
            range = Some((start, descriptors.len()));
            continue;
        }
        let Some((start, end)) = range.filter(|(_, end)| *end <= descriptors.len()) else {
            continue;
        };
        if operation.name == "spacing" {
            let spacing = numeric_i32(operation, 0)?;
            if spacing <= 0 {
                continue;
            }
            for descriptor in descriptors[start..end].iter_mut().skip(1) {
                descriptor.spacing = spacing as u32;
            }
            continue;
        }
        for descriptor in &mut descriptors[start..end] {
            apply_descriptor(descriptor, operation, content)?;
        }
    }
    for descriptor in &mut descriptors {
        apply_native_scaling(descriptor, dimensions)?;
    }
    Ok(descriptors)
}

fn apply_descriptor(
    descriptor: &mut ExactElevationDescriptor,
    operation: &SemanticOperation,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    match operation.name.as_str() {
        "number_of_tiles" => {
            descriptor.target_tiles = numeric_i32(operation, 0)? as u32;
        }
        "number_of_clumps" => {
            let clumps = numeric_value(operation, 0)?.round();
            if clumps < 0.0 {
                return Err(invalid_request(
                    "RMSGEN3101",
                    "elevation clump count cannot be negative",
                ));
            }
            descriptor.clumps = clumps.min(MAXIMUM_ELEVATION_CLUMPS as f32) as u16;
        }
        "base_terrain" => {
            descriptor.base_terrain_id =
                exact_terrain_argument(operation, 0, content, "RMSGEN3101")?
        }
        "base_layer" => {
            let layer = exact_terrain_argument(operation, 0, content, "RMSGEN3101")?;
            descriptor.base_layer = u16::try_from(layer.0)
                .map_err(|_| invalid_request("RMSGEN3101", "elevation base layer exceeds u16"))?;
        }
        "enable_balanced_elevation" => descriptor.balanced = true,
        "set_scale_by_groups" => descriptor.scaling = ExactElevationScaling::Groups,
        "set_scale_by_size" => descriptor.scaling = ExactElevationScaling::Size,
        _ => {}
    }
    Ok(())
}

fn apply_native_scaling(
    descriptor: &mut ExactElevationDescriptor,
    dimensions: MapDimensions,
) -> Result<(), GenerationError> {
    let map_area = u64::from(dimensions.width) * u64::from(dimensions.height);
    match descriptor.scaling {
        ExactElevationScaling::None => {}
        ExactElevationScaling::Size => {
            let target_tiles = u64::from(descriptor.target_tiles)
                .checked_mul(map_area)
                .ok_or_else(|| invalid_request("RMSGEN3102", "scaled elevation target overflow"))?
                / 10_000;
            descriptor.target_tiles = u32::try_from(target_tiles.min(map_area)).map_err(|_| {
                invalid_request("RMSGEN3102", "scaled elevation target exceeds u32")
            })?;
        }
        ExactElevationScaling::Groups => {
            let clumps = u64::from(descriptor.clumps)
                .checked_mul(map_area)
                .ok_or_else(|| {
                    invalid_request("RMSGEN3102", "scaled elevation clump count overflow")
                })?
                / 10_000;
            descriptor.clumps = u16::try_from(clumps).map_err(|_| {
                invalid_request("RMSGEN3102", "scaled elevation clump count exceeds u16")
            })?;
        }
    }
    Ok(())
}

fn numeric_i32(operation: &SemanticOperation, index: usize) -> Result<i32, GenerationError> {
    Ok(numeric_value(operation, index)?.round() as i32)
}

fn numeric_value(operation: &SemanticOperation, index: usize) -> Result<f32, GenerationError> {
    let value = operation
        .arguments
        .get(index)
        .ok_or_else(|| invalid_request("RMSGEN3101", "elevation operation is missing an argument"))?
        .value
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN3101", "elevation argument is not numeric"))?;
    if !value.is_finite() || value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request(
            "RMSGEN3101",
            "elevation argument exceeds i32",
        ));
    }
    Ok(value)
}

fn bounded_work(
    work: u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<u64, GenerationError> {
    let work = work.saturating_add(1);
    if work > maximum_work {
        return Err(invalid_request(
            "RMSGEN3102",
            "elevation generation exhausted its bounded work budget",
        ));
    }
    if work.is_multiple_of(1024) {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, work)?;
    }
    Ok(work)
}
