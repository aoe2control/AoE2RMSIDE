use super::*;
use rms_semantics::{ArgumentResolution, RmsRandom, RmsRngSample, RmsRngState, SemanticOperation};

const MAXIMUM_TERRAIN_LAYERS: usize = 4_096;
const MAXIMUM_TERRAIN_CLUMPS: usize = 999;
const MAXIMUM_SPECIFIC_SPACING_RULES: usize = 256;
const LEADING_RNG_SAMPLE_LIMIT: usize = 64;
const DEFAULT_CLUMPING_FACTOR: i32 = 20;
const PLAYER_START_AVOIDANCE_WEIGHT: i32 = 20;
const WATER_TOPOLOGY_CLASS_MASK: u8 = 0x0f;
const SHORELINE_EXCLUDED_WATER_CLASS_MASK: u8 = 0x40;
const SHORELINE_CANDIDATE_LOW_CLASS_MASK: u8 = 0x1f;
const FROZEN_SHORELINE_CLASS_MASK: u8 = 0xc0;
const SECONDARY_TERRAIN_INCOMPATIBLE_MASK: u8 = 0x10;

#[derive(Clone, Debug)]
pub(super) struct TerrainFinalizerRules {
    shoreline_water_ids: Vec<TerrainId>,
    shoreline_candidate_ids: Vec<TerrainId>,
    frozen_shoreline_source_ids: Vec<TerrainId>,
    fill_terrain_id: TerrainId,
    default_shoreline_terrain_id: TerrainId,
    frozen_shoreline_terrain_id: TerrainId,
}

impl TerrainFinalizerRules {
    pub(super) fn is_water(&self, terrain_id: TerrainId) -> bool {
        self.shoreline_water_ids.binary_search(&terrain_id).is_ok()
    }

    pub(super) fn shoreline_terrain_id(&self, source: TerrainId) -> Option<TerrainId> {
        if self.shoreline_candidate_ids.binary_search(&source).is_err() {
            return None;
        }
        Some(
            if self
                .frozen_shoreline_source_ids
                .binary_search(&source)
                .is_ok()
            {
                self.frozen_shoreline_terrain_id
            } else {
                self.default_shoreline_terrain_id
            },
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactTerrainSpacingRule {
    pub terrain_id: TerrainId,
    pub distance: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactTerrainDescriptor {
    pub target_tiles: u32,
    pub percent_of_land: u32,
    pub terrain_id: TerrainId,
    pub clumps: u32,
    pub spacing_to_other_terrain_types: u16,
    pub base_terrain_id: TerrainId,
    pub clumping_factor: i32,
    pub avoid_start_mode: u8,
    pub avoid_start_distance: i32,
    pub minimum_height: i16,
    pub maximum_height: i16,
    pub flat_only: bool,
    pub generate_mode: u8,
    pub base_layer_terrain_id: i32,
    pub replacement_terrain_id: i32,
    pub mask_flags: u8,
    pub metadata: i32,
    pub layer_output: i32,
    pub specific_terrain_spacing: Vec<ExactTerrainSpacingRule>,
    pub operation_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactTerrainRngSample {
    pub upper_exclusive: u32,
    pub result: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactTerrainLayerStatistics {
    pub descriptor_index: u16,
    pub rng_draws_before: u64,
    pub rng_draws_after: u64,
    pub leading_rng_samples: Vec<ExactTerrainRngSample>,
    pub avoidance_rng_draws: u64,
    pub frontier_rng_draws_by_direction: [u64; 4],
    pub seed_coordinates: Vec<MapCoordinate>,
    pub accepted_tiles: u64,
    pub rejected_tiles: u64,
    pub drained_tiles: u64,
    pub terrain_before_hash: [u8; 32],
    pub terrain_after_hash: [u8; 32],
    pub terrain_zone_before_hash: [u8; 32],
    pub terrain_zone_after_hash: [u8; 32],
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactTerrainStatistics {
    pub layers: Vec<ExactTerrainLayerStatistics>,
    pub shoreline_tiles: u64,
    pub restored_facet_tiles: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactTerrainState {
    pub restriction_zones: ExactRestrictionZones,
    pub removed_land_appearances: BTreeSet<u32>,
    pub dimensions: MapDimensions,
    pub descriptors: Vec<ExactTerrainDescriptor>,
    pub terrain: Vec<TerrainId>,
    pub elevation: Vec<i16>,
    pub land_id: Vec<u16>,
    pub terrain_zone: Vec<u32>,
    pub tile_operation_indices: Vec<u32>,
    pub rng_state: RmsRngState,
    pub statistics: ExactTerrainStatistics,
}

impl ExactTerrainState {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-terrain-state-v2");
        writer.u32(self.removed_land_appearances.len() as u32);
        for ordinal in &self.removed_land_appearances {
            writer.u32(*ordinal);
        }
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        for terrain in &self.terrain {
            writer.u32(terrain.0);
        }
        for elevation in &self.elevation {
            writer.u32(*elevation as u32);
        }
        for land_id in &self.land_id {
            writer.u16(*land_id);
        }
        for terrain_zone in &self.terrain_zone {
            writer.u32(*terrain_zone);
        }
        writer.bytes(&self.rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

#[derive(Clone, Copy, Debug)]
struct QueueNode {
    queue: u32,
    previous: u32,
    next: u32,
    priority: i32,
}

const NO_NODE: u32 = u32::MAX;

impl Default for QueueNode {
    fn default() -> Self {
        Self {
            queue: NO_NODE,
            previous: NO_NODE,
            next: NO_NODE,
            priority: 0,
        }
    }
}

fn node_link(value: u32) -> Option<usize> {
    (value != NO_NODE).then_some(value as usize)
}

fn node_value(value: Option<usize>) -> u32 {
    value.map_or(NO_NODE, |value| {
        u32::try_from(value)
            .ok()
            .filter(|value| *value != NO_NODE)
            .expect("terrain queue index fits below the sentinel")
    })
}

struct TerrainQueues {
    heads: Vec<u32>,
    tails: Vec<u32>,
    nodes: Vec<QueueNode>,
}

impl TerrainQueues {
    fn new(queue_count: usize, node_count: usize) -> Self {
        assert!(
            queue_count < NO_NODE as usize && node_count < NO_NODE as usize,
            "terrain queue counts fit below the sentinel"
        );
        Self {
            heads: vec![NO_NODE; queue_count],
            tails: vec![NO_NODE; queue_count],
            nodes: vec![QueueNode::default(); node_count],
        }
    }

    fn remove(&mut self, index: usize) {
        let Some(queue) = node_link(self.nodes[index].queue) else {
            return;
        };
        let previous = node_link(self.nodes[index].previous);
        let next = node_link(self.nodes[index].next);
        if let Some(previous) = previous {
            self.nodes[previous].next = node_value(next);
        } else {
            self.heads[queue] = node_value(next);
        }
        if let Some(next) = next {
            self.nodes[next].previous = node_value(previous);
        } else {
            self.tails[queue] = node_value(previous);
        }
        self.nodes[index] = QueueNode::default();
    }

    fn insert_back(&mut self, queue: usize, index: usize) {
        self.remove(index);
        let previous = node_link(self.tails[queue]);
        self.nodes[index] = QueueNode {
            queue: node_value(Some(queue)),
            previous: node_value(previous),
            next: NO_NODE,
            priority: 0,
        };
        if let Some(previous) = previous {
            self.nodes[previous].next = node_value(Some(index));
        } else {
            self.heads[queue] = node_value(Some(index));
        }
        self.tails[queue] = node_value(Some(index));
    }

    fn insert_front(&mut self, queue: usize, index: usize) {
        self.remove(index);
        let next = node_link(self.heads[queue]);
        self.nodes[index] = QueueNode {
            queue: node_value(Some(queue)),
            previous: NO_NODE,
            next: node_value(next),
            priority: 0,
        };
        if let Some(next) = next {
            self.nodes[next].previous = node_value(Some(index));
        } else {
            self.tails[queue] = node_value(Some(index));
        }
        self.heads[queue] = node_value(Some(index));
    }

    fn insert_sorted(&mut self, queue: usize, index: usize, priority: i32) -> u64 {
        self.remove(index);
        let mut traversed = 0_u64;
        let mut current = node_link(self.heads[queue]);
        let mut previous = None;
        while let Some(existing) = current {
            traversed = traversed.saturating_add(1);
            if self.nodes[existing].priority >= priority {
                break;
            }
            previous = current;
            current = node_link(self.nodes[existing].next);
        }
        self.nodes[index] = QueueNode {
            queue: node_value(Some(queue)),
            previous: node_value(previous),
            next: node_value(current),
            priority,
        };
        if let Some(previous) = previous {
            self.nodes[previous].next = node_value(Some(index));
        } else {
            self.heads[queue] = node_value(Some(index));
        }
        if let Some(current) = current {
            self.nodes[current].previous = node_value(Some(index));
        } else {
            self.tails[queue] = node_value(Some(index));
        }
        traversed
    }

    fn pop(&mut self, queue: usize) -> Option<usize> {
        let index = node_link(self.heads[queue])?;
        self.remove(index);
        Some(index)
    }
}

pub fn resolve_exact_terrain_state(
    semantic_program: &SemanticProgram,
    land: &ExactLandState,
    elevation: &ExactElevationState,
    cliff: &ExactCliffState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactTerrainState, GenerationError> {
    if land.dimensions != elevation.dimensions || land.dimensions != cliff.dimensions {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain input dimensions do not match",
        ));
    }
    let dimensions = land.dimensions;
    let tile_count = dimensions.tile_count()?;
    if cliff.terrain.len() != tile_count
        || elevation.elevation.len() != tile_count
        || cliff.layer.len() != tile_count
    {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain input arrays are incomplete",
        ));
    }
    let descriptors = collect_descriptors(semantic_program, dimensions, content)?;
    if descriptors.len() > MAXIMUM_TERRAIN_LAYERS {
        return Err(invalid_request(
            "RMSGEN3302",
            "terrain layer count exceeds its bounded limit",
        ));
    }

    rng.next_u32();
    let mut terrain = cliff.terrain.clone();
    let elevation_values = elevation.elevation.clone();
    let mut land_id = cliff.layer.clone();
    let mut terrain_zone = vec![u32::MAX; tile_count];
    let mut tile_operation_indices = cliff.tile_operation_indices.clone();
    let mut statistics = ExactTerrainStatistics::default();
    let maximum_work = (tile_count as u64)
        .saturating_mul((descriptors.len() as u64).saturating_add(1))
        .saturating_mul(512)
        .max(16_384);
    let mut work = 0_u64;
    let finalizer_rules = terrain_finalizer_rules(content, "RMSGEN3301")?;

    for (descriptor_index, descriptor) in descriptors.iter().enumerate() {
        let terrain_before_hash = terrain_hash(&terrain)?;
        let terrain_zone_before_hash = terrain_zone_hash(&terrain_zone);
        let rng_draws_before = rng.state().draws();
        let mut layer_statistics = ExactTerrainLayerStatistics {
            descriptor_index: u16::try_from(descriptor_index)
                .map_err(|_| invalid_request("RMSGEN3302", "terrain layer ordinal exceeds u16"))?,
            rng_draws_before,
            rng_draws_after: rng_draws_before,
            leading_rng_samples: Vec::new(),
            avoidance_rng_draws: 0,
            frontier_rng_draws_by_direction: [0; 4],
            seed_coordinates: Vec::new(),
            accepted_tiles: 0,
            rejected_tiles: 0,
            drained_tiles: 0,
            terrain_before_hash,
            terrain_after_hash: terrain_before_hash,
            terrain_zone_before_hash,
            terrain_zone_after_hash: terrain_zone_before_hash,
        };
        resolve_layer(
            descriptor,
            dimensions,
            land,
            &elevation_values,
            &mut terrain,
            &mut land_id,
            &mut terrain_zone,
            &mut tile_operation_indices,
            &mut rng,
            &mut layer_statistics,
            &mut work,
            maximum_work,
            cancellation,
        )?;
        layer_statistics.rng_draws_after = rng.state().draws();
        layer_statistics.terrain_after_hash = terrain_hash(&terrain)?;
        layer_statistics.terrain_zone_after_hash = terrain_zone_hash(&terrain_zone);
        statistics.layers.push(layer_statistics);
    }

    let mut removed_land_appearances = cliff.removed_land_appearances.clone();
    let mut restriction_zones = cliff.restriction_zones.clone();
    let runtime_attributes = restriction_zones.runtime_attributes();
    apply_terrain_finalizer(
        dimensions,
        &cliff.deferred_primary_terrain,
        &mut terrain,
        &mut land_id,
        &terrain_zone,
        &mut tile_operation_indices,
        &finalizer_rules,
        &mut statistics,
        &mut work,
        maximum_work,
        cancellation,
        |index, previous, current_terrain| {
            super::exact_appearance::remove_replaced_appearances_on_terrain(
                &land.appearance_objects,
                &mut removed_land_appearances,
                std::sync::Arc::make_mut(&mut restriction_zones.objects),
                dimensions,
                index,
                previous,
                content,
                &runtime_attributes,
                |object| {
                    super::exact_object::topology_placement_rejects(
                        object,
                        dimensions,
                        current_terrain,
                        &elevation_values,
                        content,
                        &runtime_attributes,
                    )
                },
                Some(current_terrain),
            )
        },
    )?;

    Ok(ExactTerrainState {
        restriction_zones,
        removed_land_appearances,
        dimensions,
        descriptors,
        terrain,
        elevation: elevation_values,
        land_id,
        terrain_zone,
        tile_operation_indices,
        rng_state: rng.state(),
        statistics,
    })
}

#[allow(clippy::too_many_arguments)]
fn resolve_layer(
    descriptor: &ExactTerrainDescriptor,
    dimensions: MapDimensions,
    land: &ExactLandState,
    elevation: &[i16],
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    terrain_zone: &mut [u32],
    tile_operation_indices: &mut [u32],
    rng: &mut RmsRandom,
    statistics: &mut ExactTerrainLayerStatistics,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let tile_count = dimensions.tile_count()?;
    let clump_count = native_clump_count(descriptor.clumps);
    if descriptor.specific_terrain_spacing.len() > MAXIMUM_SPECIFIC_SPACING_RULES {
        return Err(invalid_request(
            "RMSGEN3302",
            "terrain spacing count exceeds its bounded limit",
        ));
    }
    if descriptor.minimum_height > descriptor.maximum_height {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain minimum height exceeds maximum height",
        ));
    }
    let main_queue = 0;
    let clump_queue_base = 1;
    let mut queues = TerrainQueues::new(clump_queue_base + clump_count, tile_count);
    for index in 0..tile_count {
        queues.insert_back(main_queue, index);
    }

    let shuffle_count = native_shuffle_count(tile_count);
    let x_upper = u32::from(dimensions.width.saturating_sub(1));
    let y_upper = u32::from(dimensions.height.saturating_sub(1));
    if x_upper == 0 || y_upper == 0 {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain generation requires dimensions of at least 2x2",
        ));
    }
    for _ in 0..shuffle_count {
        bounded_work(work, maximum_work, cancellation)?;
        let x = sampled(rng, x_upper, statistics) as usize;
        let y = sampled(rng, y_upper, statistics) as usize;
        queues.insert_front(main_queue, y * width + x);
    }
    if clump_count == 0 {
        return Ok(());
    }

    let seed_spacing = (((descriptor.target_tiles as f32) / (clump_count as f32))
        .sqrt()
        .trunc() as usize)
        .saturating_mul(2)
        .max(2);
    let (target_terrain, target_land_id, mask_flags) = effective_targets(descriptor);
    let start_penalty = start_penalty_map(
        descriptor,
        dimensions,
        land,
        work,
        maximum_work,
        cancellation,
    )?;
    let mut accepted = 0_u64;

    for clump in 0..clump_count {
        let queue = clump_queue_base + clump;
        let mut seed = None;
        while let Some(index) = queues.pop(main_queue) {
            bounded_work(work, maximum_work, cancellation)?;
            if !candidate_mask_matches(index, descriptor, mask_flags, terrain, land_id)
                || eligibility(
                    index,
                    descriptor,
                    target_terrain,
                    target_land_id,
                    mask_flags,
                    dimensions,
                    terrain,
                    land_id,
                    elevation,
                ) == 0
                || (descriptor.avoid_start_mode != 0 && start_penalty[index] != 0)
            {
                statistics.rejected_tiles = statistics.rejected_tiles.saturating_add(1);
                continue;
            }
            seed = Some(index);
            break;
        }
        let Some(index) = seed else {
            break;
        };
        remove_square(
            &mut queues,
            width,
            height,
            index % width,
            index / width,
            seed_spacing,
            work,
            maximum_work,
            cancellation,
        )?;
        paint(
            index,
            descriptor,
            target_terrain,
            target_land_id,
            terrain,
            land_id,
            terrain_zone,
            tile_operation_indices,
        );
        statistics.seed_coordinates.push(coordinate(index, width));
        statistics.accepted_tiles = statistics.accepted_tiles.saturating_add(1);
        accepted = accepted.saturating_add(1);
        enqueue_seed_neighbors(
            index,
            width,
            height,
            queue,
            &mut queues,
            work,
            maximum_work,
            cancellation,
        )?;
    }

    let active_clumps = statistics.seed_coordinates.len();
    'frontier: loop {
        if active_clumps == 0 || accepted >= u64::from(descriptor.target_tiles) {
            break;
        }
        let mut popped_any = false;
        for clump_index in 0..active_clumps {
            if accepted >= u64::from(descriptor.target_tiles) {
                break 'frontier;
            }
            let queue = clump_queue_base + clump_index;
            if let Some(index) = queues.pop(queue) {
                popped_any = true;
                bounded_work(work, maximum_work, cancellation)?;
                if descriptor.avoid_start_mode != 0 {
                    let threshold = sampled(rng, 100, statistics) as u8;
                    statistics.avoidance_rng_draws =
                        statistics.avoidance_rng_draws.saturating_add(1);
                    if start_penalty[index] > threshold {
                        statistics.rejected_tiles = statistics.rejected_tiles.saturating_add(1);
                        continue;
                    }
                }
                let match_count = eligibility(
                    index,
                    descriptor,
                    target_terrain,
                    target_land_id,
                    mask_flags,
                    dimensions,
                    terrain,
                    land_id,
                    elevation,
                );
                if match_count == 0
                    || !candidate_mask_matches(index, descriptor, mask_flags, terrain, land_id)
                {
                    statistics.rejected_tiles = statistics.rejected_tiles.saturating_add(1);
                    continue;
                }
                let priority_base = 250_i32
                    .saturating_sub(
                        descriptor
                            .clumping_factor
                            .saturating_mul(i32::from(match_count)),
                    )
                    .saturating_add(i32::from(start_penalty[index]));
                paint(
                    index,
                    descriptor,
                    target_terrain,
                    target_land_id,
                    terrain,
                    land_id,
                    terrain_zone,
                    tile_operation_indices,
                );
                enqueue_frontier_neighbors(
                    index,
                    width,
                    height,
                    queue,
                    descriptor,
                    mask_flags,
                    priority_base,
                    terrain,
                    land_id,
                    &mut queues,
                    rng,
                    statistics,
                    work,
                    maximum_work,
                    cancellation,
                )?;
                accepted = accepted.saturating_add(1);
                statistics.accepted_tiles = statistics.accepted_tiles.saturating_add(1);
            }
        }
        if !popped_any {
            break;
        }
    }

    for clump in 0..active_clumps {
        let queue = clump_queue_base + clump;
        while let Some(index) = queues.pop(queue) {
            bounded_work(work, maximum_work, cancellation)?;
            let x = index % width;
            if x > 0
                && x + 1 < width
                && terrain[index - 1] == target_terrain
                && terrain[index + 1] == target_terrain
                && land_id[index - 1] == target_land_id
                && land_id[index + 1] == target_land_id
            {
                paint_drained(
                    index,
                    descriptor,
                    target_terrain,
                    target_land_id,
                    terrain,
                    land_id,
                    terrain_zone,
                    tile_operation_indices,
                );
                statistics.drained_tiles = statistics.drained_tiles.saturating_add(1);
            }
        }
    }
    Ok(())
}

fn native_clump_count(authored: u32) -> usize {
    authored.min(MAXIMUM_TERRAIN_CLUMPS as u32) as usize
}

fn native_shuffle_count(tile_count: usize) -> usize {
    tile_count / 8
}

fn sampled(
    rng: &mut RmsRandom,
    upper_exclusive: u32,
    statistics: &mut ExactTerrainLayerStatistics,
) -> u32 {
    let sample = rng.bounded(upper_exclusive);
    record_sample(sample, statistics);
    sample.result
}

fn record_sample(sample: RmsRngSample, statistics: &mut ExactTerrainLayerStatistics) {
    if statistics.leading_rng_samples.len() < LEADING_RNG_SAMPLE_LIMIT {
        statistics.leading_rng_samples.push(ExactTerrainRngSample {
            upper_exclusive: sample.upper_exclusive,
            result: sample.result,
        });
    }
}

fn effective_targets(descriptor: &ExactTerrainDescriptor) -> (TerrainId, u16, u8) {
    let mut terrain = descriptor.terrain_id;
    let mut land = descriptor.replacement_terrain_id as u16;
    let mut flags = descriptor.mask_flags;
    if descriptor.generate_mode == 1 {
        terrain = descriptor.base_terrain_id;
        land = descriptor.terrain_id.0 as u16;
        flags |= 2;
    } else if descriptor.generate_mode == 2 {
        land = descriptor.base_terrain_id.0 as u16;
    }
    if flags == 0 {
        flags = 1;
    }
    (terrain, land, flags)
}

fn candidate_mask_matches(
    index: usize,
    descriptor: &ExactTerrainDescriptor,
    flags: u8,
    terrain: &[TerrainId],
    land_id: &[u16],
) -> bool {
    (flags & 1 == 0 || terrain[index] == descriptor.base_terrain_id)
        && (flags & 2 == 0 || land_id[index] == descriptor.base_layer_terrain_id as u16)
}

#[allow(clippy::too_many_arguments)]
fn eligibility(
    index: usize,
    descriptor: &ExactTerrainDescriptor,
    target_terrain: TerrainId,
    target_land_id: u16,
    flags: u8,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    land_id: &[u16],
    elevation: &[i16],
) -> u8 {
    if elevation[index] < descriptor.minimum_height || elevation[index] > descriptor.maximum_height
    {
        return 0;
    }
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let x = index % width;
    let y = index / width;
    let radius = usize::from(descriptor.spacing_to_other_terrain_types);
    if radius != 0 {
        for next_y in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
            for next_x in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
                let next = next_y * width + next_x;
                if flags & 1 != 0
                    && terrain[next] != descriptor.base_terrain_id
                    && terrain[next] != target_terrain
                {
                    return 0;
                }
                if flags & 2 != 0
                    && land_id[next] != descriptor.base_layer_terrain_id as u16
                    && land_id[next] != target_land_id
                {
                    return 0;
                }
                if descriptor.flat_only && terrain_shape_nonzero(next, elevation, width, height) {
                    return 0;
                }
            }
        }
    }
    if flags & 1 != 0 {
        for rule in &descriptor.specific_terrain_spacing {
            let distance = usize::from(rule.distance);
            for next_y in y.saturating_sub(distance)..=(y + distance).min(height - 1) {
                for next_x in x.saturating_sub(distance)..=(x + distance).min(width - 1) {
                    if terrain[next_y * width + next_x] == rule.terrain_id {
                        return 0;
                    }
                }
            }
        }
    }
    let mut matches = 1_u8;
    for next_y in y.saturating_sub(2)..=(y + 2).min(height - 1) {
        for next_x in x.saturating_sub(2)..=(x + 2).min(width - 1) {
            let next = next_y * width + next_x;
            if terrain[next] == target_terrain && land_id[next] == target_land_id {
                matches = matches.saturating_add(1);
            }
        }
    }
    matches
}

fn terrain_shape_nonzero(index: usize, elevation: &[i16], width: usize, height: usize) -> bool {
    super::exact_elevation::terrain_shape_code(index, elevation, width, height) != Some(0)
}

#[allow(clippy::too_many_arguments)]
fn paint(
    index: usize,
    descriptor: &ExactTerrainDescriptor,
    target_terrain: TerrainId,
    target_land_id: u16,
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    terrain_zone: &mut [u32],
    tile_operation_indices: &mut [u32],
) {
    let previous_terrain = terrain[index];
    match descriptor.generate_mode {
        1 => land_id[index] = descriptor.terrain_id.0 as u16,
        2 => {
            land_id[index] = previous_terrain.0 as u16;
            terrain[index] = descriptor.terrain_id;
        }
        _ => {
            terrain[index] = target_terrain;
            land_id[index] = target_land_id;
        }
    }
    terrain_zone[index] = if descriptor.layer_output == -1 {
        terrain[index].0
    } else {
        descriptor.layer_output as u32
    };
    tile_operation_indices[index] = descriptor.operation_index;
}

#[allow(clippy::too_many_arguments)]
fn paint_drained(
    index: usize,
    descriptor: &ExactTerrainDescriptor,
    target_terrain: TerrainId,
    target_land_id: u16,
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    terrain_zone: &mut [u32],
    tile_operation_indices: &mut [u32],
) {
    terrain[index] = target_terrain;
    land_id[index] = target_land_id;
    terrain_zone[index] = if descriptor.layer_output == -1 {
        target_terrain.0
    } else {
        descriptor.layer_output as u32
    };
    tile_operation_indices[index] = descriptor.operation_index;
}

#[allow(clippy::too_many_arguments)]
fn enqueue_seed_neighbors(
    index: usize,
    width: usize,
    height: usize,
    queue: usize,
    queues: &mut TerrainQueues,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    for neighbor in seed_neighbors(index, width, height) {
        bounded_work(work, maximum_work, cancellation)?;
        *work = work.saturating_add(queues.insert_sorted(queue, neighbor, 0));
    }
    Ok(())
}

fn seed_neighbors(index: usize, width: usize, height: usize) -> Vec<usize> {
    let x = index % width;
    let y = index / width;
    let mut neighbors = Vec::with_capacity(4);
    if x > 0 {
        neighbors.push(index - 1);
    }
    if y > 0 {
        neighbors.push(index - width);
    }
    if x + 1 < width {
        neighbors.push(index + 1);
    }
    if y + 1 < height {
        neighbors.push(index + width);
    }
    neighbors
}

#[allow(clippy::too_many_arguments)]
fn enqueue_frontier_neighbors(
    index: usize,
    width: usize,
    height: usize,
    queue: usize,
    descriptor: &ExactTerrainDescriptor,
    mask_flags: u8,
    priority_base: i32,
    terrain: &[TerrainId],
    land_id: &[u16],
    queues: &mut TerrainQueues,
    rng: &mut RmsRandom,
    statistics: &mut ExactTerrainLayerStatistics,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    for (direction, neighbor) in cardinal_neighbors(index, width, height) {
        bounded_work(work, maximum_work, cancellation)?;
        if !candidate_mask_matches(neighbor, descriptor, mask_flags, terrain, land_id) {
            continue;
        }
        let priority = priority_base.saturating_add(sampled(rng, 100, statistics) as i32);
        statistics.frontier_rng_draws_by_direction[direction] =
            statistics.frontier_rng_draws_by_direction[direction].saturating_add(1);
        *work = work.saturating_add(queues.insert_sorted(queue, neighbor, priority));
        if *work > maximum_work {
            return Err(invalid_request(
                "RMSGEN3302",
                "terrain generation exhausted its bounded work budget",
            ));
        }
    }
    Ok(())
}

fn cardinal_neighbors(index: usize, width: usize, height: usize) -> Vec<(usize, usize)> {
    let x = index % width;
    let y = index / width;
    let mut neighbors = Vec::with_capacity(4);
    if x > 0 {
        neighbors.push((0, index - 1));
    }
    if x + 1 < width {
        neighbors.push((1, index + 1));
    }
    if y > 0 {
        neighbors.push((2, index - width));
    }
    if y + 1 < height {
        neighbors.push((3, index + width));
    }
    neighbors
}

#[allow(clippy::too_many_arguments)]
fn remove_square(
    queues: &mut TerrainQueues,
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    radius: usize,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    for next_y in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
        for next_x in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
            bounded_work(work, maximum_work, cancellation)?;
            queues.remove(next_y * width + next_x);
        }
    }
    Ok(())
}

fn start_penalty_map(
    descriptor: &ExactTerrainDescriptor,
    dimensions: MapDimensions,
    land: &ExactLandState,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<Vec<u8>, GenerationError> {
    let tile_count = dimensions.tile_count()?;
    let mut result = vec![0_u8; tile_count];
    if descriptor.avoid_start_mode == 0 {
        return Ok(result);
    }
    let width = usize::from(dimensions.width);
    let distance = descriptor.avoid_start_distance;
    for y in 0..usize::from(dimensions.height) {
        for x in 0..width {
            bounded_work(work, maximum_work, cancellation)?;
            result[y * width + x] = start_penalty_at(x, y, distance, &land.descriptors);
        }
    }
    Ok(result)
}

fn start_penalty_at(
    x: usize,
    y: usize,
    distance: i32,
    land_descriptors: &[ExactLandDescriptor],
) -> u8 {
    let mut penalty = 0_i32;
    for land_descriptor in land_descriptors
        .iter()
        .filter(|descriptor| descriptor.assigned_slot.is_some())
    {
        let dx = (x as i32 - i32::from(land_descriptor.position.x)).unsigned_abs();
        let dy = (y as i32 - i32::from(land_descriptor.position.y)).unsigned_abs();
        let squared = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
        let radius = (squared as f32).sqrt().trunc() as i32;
        let influence = distance.saturating_sub(radius).max(0);
        penalty = penalty.saturating_add(PLAYER_START_AVOIDANCE_WEIGHT.saturating_mul(influence));
    }
    penalty.min(101) as u8
}

#[allow(clippy::too_many_arguments)]
fn apply_terrain_finalizer(
    dimensions: MapDimensions,
    deferred_primary_terrain: &[u32],
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    terrain_zone: &[u32],
    tile_operation_indices: &mut [u32],
    rules: &TerrainFinalizerRules,
    statistics: &mut ExactTerrainStatistics,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
    replace_occupants: impl FnMut(usize, TerrainId, &[TerrainId]) -> Result<(), GenerationError>,
) -> Result<(), GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let tile_count = dimensions.tile_count()?;
    if deferred_primary_terrain.len() != tile_count
        || terrain.len() != tile_count
        || land_id.len() != tile_count
        || terrain_zone.len() != tile_count
        || tile_operation_indices.len() != tile_count
    {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain finalizer input arrays are incomplete",
        ));
    }
    for y in 0..height {
        for x in 0..width {
            bounded_work(work, maximum_work, cancellation)?;
            let index = y * width + x;
            if deferred_primary_terrain[index] != u32::MAX {
                terrain[index] = TerrainId(deferred_primary_terrain[index]);
                tile_operation_indices[index] = u32::MAX;
                statistics.restored_facet_tiles = statistics.restored_facet_tiles.saturating_add(1);
            }
        }
    }

    fill_water_topology(
        dimensions,
        terrain,
        land_id,
        rules,
        cancellation,
        replace_occupants,
    )?;

    let before = terrain.to_vec();
    for y in 0..height {
        for x in 0..width {
            bounded_work(work, maximum_work, cancellation)?;
            let index = y * width + x;
            if rules.is_water(before[index]) {
                continue;
            }
            let Some(default_shoreline_terrain_id) = rules.shoreline_terrain_id(before[index])
            else {
                continue;
            };
            let adjacent_water = y.saturating_sub(1)..=(y + 1).min(height - 1);
            if adjacent_water.clone().any(|next_y| {
                (x.saturating_sub(1)..=(x + 1).min(width - 1)).any(|next_x| {
                    (next_x != x || next_y != y) && rules.is_water(before[next_y * width + next_x])
                })
            }) {
                let shoreline_terrain_id = if (terrain_zone[index] as i32) < 0 {
                    default_shoreline_terrain_id
                } else {
                    TerrainId(terrain_zone[index])
                };
                terrain[index] = shoreline_terrain_id;
                statistics.shoreline_tiles = statistics.shoreline_tiles.saturating_add(1);
            }
        }
    }
    Ok(())
}

pub(super) fn fill_water_topology(
    dimensions: MapDimensions,
    terrain: &mut [TerrainId],
    land_id: &mut [u16],
    rules: &TerrainFinalizerRules,
    cancellation: &dyn CancellationToken,
    mut replace_occupants: impl FnMut(usize, TerrainId, &[TerrainId]) -> Result<(), GenerationError>,
) -> Result<(), GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let tile_count = dimensions.tile_count()?;
    if terrain.len() != tile_count || land_id.len() != tile_count {
        return Err(invalid_request(
            "RMSGEN3301",
            "connection water-topology input is incomplete",
        ));
    }
    let mut work = 0_u64;

    for _ in 0..=tile_count {
        let mut changed = false;
        for pass in 0..2 {
            for y in 0..height {
                for x in 0..width {
                    cancellation_checkpoint(cancellation, GenerationStage::Terrain, work)?;
                    work = work.saturating_add(1);
                    let index = y * width + x;
                    let is_fill = |index: usize| terrain[index] == rules.fill_terrain_id;
                    if is_fill(index) {
                        continue;
                    }
                    let north = y > 0 && is_fill((y - 1) * width + x);
                    let south = y + 1 < height && is_fill((y + 1) * width + x);
                    let west = x > 0 && is_fill(y * width + x - 1);
                    let east = x + 1 < width && is_fill(y * width + x + 1);
                    let northwest = x > 0 && y > 0 && is_fill((y - 1) * width + x - 1);
                    let northeast = x + 1 < width && y > 0 && is_fill((y - 1) * width + x + 1);
                    let southwest = x > 0 && y + 1 < height && is_fill((y + 1) * width + x - 1);
                    let southeast =
                        x + 1 < width && y + 1 < height && is_fill((y + 1) * width + x + 1);
                    let fill = water_topology_bridge(
                        [
                            north, northeast, east, southeast, south, southwest, west, northwest,
                        ],
                        pass != 0,
                    );
                    if fill {
                        let previous = terrain[index];
                        terrain[index] = rules.fill_terrain_id;
                        land_id[index] = u16::MAX;
                        replace_occupants(index, previous, terrain)?;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            return Ok(());
        }
    }

    Err(invalid_request(
        "RMSGEN3302",
        "connection water topology exhausted its bounded convergence limit",
    ))
}

pub(super) fn water_topology_bridge(neighbors: [bool; 8], diagonal: bool) -> bool {
    let [n, ne, e, se, s, sw, w, nw] = neighbors;
    if !diagonal {
        return (n && s) || (w && e);
    }
    (nw && ((ne && !n) || (e && !ne) || (sw && !w) || (s && !sw) || (se && !s && !e)))
        || (ne && ((nw && !n) || (w && !nw) || (se && !e) || (s && !se) || (sw && !w && !s)))
        || (se && ((ne && !e) || (n && !ne) || (sw && !s) || (w && !sw) || (nw && !w && !n)))
        || (sw && ((nw && !w) || (n && !nw) || (se && !s) || (e && !se) || (ne && !e && !n)))
}

pub(super) fn terrain_finalizer_rules(
    content: CompatibleContentView<'_>,
    error_code: &'static str,
) -> Result<TerrainFinalizerRules, GenerationError> {
    let topology = content.terrain_topology();
    let shoreline_water_ids = content
        .terrains()
        .iter()
        .filter(|terrain| {
            terrain.placement_class & WATER_TOPOLOGY_CLASS_MASK != 0
                && terrain.placement_class & SHORELINE_EXCLUDED_WATER_CLASS_MASK == 0
                && topology
                    .excluded_shoreline_water_terrain_ids
                    .binary_search(&terrain.id)
                    .is_err()
        })
        .map(|terrain| terrain.id)
        .collect::<Vec<_>>();
    let shoreline_candidate_ids = content
        .terrains()
        .iter()
        .filter(|terrain| {
            terrain.placement_class & SHORELINE_EXCLUDED_WATER_CLASS_MASK != 0
                || terrain.placement_class & SHORELINE_CANDIDATE_LOW_CLASS_MASK == 0
        })
        .map(|terrain| terrain.id)
        .collect::<Vec<_>>();
    let frozen_shoreline_source_ids = content
        .terrains()
        .iter()
        .filter(|terrain| terrain.placement_class & FROZEN_SHORELINE_CLASS_MASK != 0)
        .map(|terrain| terrain.id)
        .collect::<Vec<_>>();
    let fill_terrain_id = topology.fill_terrain_id.ok_or_else(|| {
        invalid_request(error_code, "content lacks a topology fill terrain binding")
    })?;
    if shoreline_water_ids.binary_search(&fill_terrain_id).is_err() {
        return Err(invalid_request(
            error_code,
            "content topology fill terrain is not shoreline water",
        ));
    }
    let default_shoreline_terrain_id = topology.default_shoreline_terrain_id.ok_or_else(|| {
        invalid_request(
            error_code,
            "content lacks a default shoreline terrain binding",
        )
    })?;
    let frozen_shoreline_terrain_id = match topology.frozen_shoreline_terrain_id {
        Some(terrain_id) => terrain_id,
        None if frozen_shoreline_source_ids.is_empty() => default_shoreline_terrain_id,
        None => {
            return Err(invalid_request(
                error_code,
                "content lacks an ice shoreline terrain binding",
            ));
        }
    };
    Ok(TerrainFinalizerRules {
        shoreline_water_ids,
        shoreline_candidate_ids,
        frozen_shoreline_source_ids,
        fill_terrain_id,
        default_shoreline_terrain_id,
        frozen_shoreline_terrain_id,
    })
}

pub(super) fn finalize_composite_terrain(
    terrain: &mut [TerrainId],
    secondary_terrain: &mut [u16],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if terrain.len() != secondary_terrain.len() {
        return Err(invalid_request(
            "RMSGEN3303",
            "composite terrain columns disagree on tile count",
        ));
    }

    for (primary, secondary) in terrain.iter_mut().zip(secondary_terrain) {
        if let Some(rule) = content.composite_terrain_rule(*primary) {
            *primary = rule.primary_terrain_id;
            *secondary = rule.secondary_terrain_id.0 as u16;
        }

        if *secondary == u16::MAX {
            continue;
        }
        let primary_definition = content.terrain(*primary).ok_or_else(|| {
            invalid_request(
                "RMSGEN3303",
                "final terrain references unavailable content metadata",
            )
        })?;
        if primary_definition.placement_class & SECONDARY_TERRAIN_INCOMPATIBLE_MASK != 0 {
            *secondary = u16::MAX;
            continue;
        }

        let secondary_id = TerrainId(u32::from(*secondary));
        if let Some(rule) = content.composite_terrain_rule(secondary_id) {
            *primary = rule.primary_terrain_id;
            *secondary = rule.secondary_terrain_id.0 as u16;
        }
    }
    Ok(())
}

pub(super) fn finalize_game_mode_terrain(
    dimensions: MapDimensions,
    terrain: &mut [TerrainId],
    secondary_terrain: &mut [u16],
    game_mode_raw: u8,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if terrain.len() != dimensions.tile_count()? || secondary_terrain.len() != terrain.len() {
        return Err(invalid_request(
            "RMSGEN3304",
            "game-mode terrain columns disagree on tile count",
        ));
    }
    let Some(rule) = content.game_mode_terrain_rule(game_mode_raw) else {
        return Ok(());
    };
    let hill = game_mode_raw == GameMode::KingOfTheHill.native_value();
    if !hill && rule.boundary_terrain_id.is_none() {
        return Err(invalid_request(
            "RMSGEN3305",
            "game-mode terrain rule lacks its content-bound boundary terrain",
        ));
    }
    let excluded_class = WATER_TOPOLOGY_CLASS_MASK
        | if hill {
            SHORELINE_EXCLUDED_WATER_CLASS_MASK
        } else {
            0
        };
    let center_x = dimensions.width / 2 + dimensions.width % 2;
    let center_y = dimensions.height / 2 + dimensions.height % 2;
    let minimum_x = center_x.saturating_sub(rule.radius);
    let maximum_x = center_x
        .saturating_add(rule.radius)
        .min(dimensions.width.saturating_sub(1));
    let minimum_y = center_y.saturating_sub(rule.radius);
    let maximum_y = center_y
        .saturating_add(rule.radius)
        .min(dimensions.height.saturating_sub(1));
    let width = usize::from(dimensions.width);
    for y in minimum_y..=maximum_y {
        for x in minimum_x..=maximum_x {
            let index = usize::from(y) * width + usize::from(x);
            let distance = if hill {
                x.abs_diff(center_x).max(y.abs_diff(center_y))
            } else {
                native_objective_axis_distance(x, dimensions.width)
                    .max(native_objective_axis_distance(y, dimensions.height))
            };
            let source = content.terrain(terrain[index]).ok_or_else(|| {
                invalid_request(
                    "RMSGEN3306",
                    "game-mode terrain brush encountered an unknown terrain identity",
                )
            })?;
            let replacement = if source.placement_class & excluded_class == 0
                || distance <= rule.radius.saturating_sub(2)
            {
                Some(rule.terrain_id)
            } else if !hill && distance == rule.radius.saturating_sub(1) {
                rule.boundary_terrain_id
            } else {
                None
            };
            let Some(replacement) = replacement else {
                continue;
            };
            terrain[index] = replacement;
            secondary_terrain[index] = u16::MAX;
        }
    }
    Ok(())
}

fn native_objective_axis_distance(coordinate: u16, dimension: u16) -> u16 {
    let coordinate_twice = u32::from(coordinate) * 2;
    let center_twice = u32::from(dimension) + 1;
    (coordinate_twice.abs_diff(center_twice) / 2) as u16
}

fn collect_descriptors(
    semantic_program: &SemanticProgram,
    dimensions: MapDimensions,
    content: CompatibleContentView<'_>,
) -> Result<Vec<ExactTerrainDescriptor>, GenerationError> {
    let operations = semantic_program
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            operation.accepted_by_target_parser() && operation.section == "terrain_generation"
        })
        .collect::<Vec<_>>();
    let native = native_generation_bindings(content)?;
    let mut descriptors = Vec::<ExactTerrainDescriptor>::new();
    for (operation_index, create) in operations {
        if create.depth != 0 {
            if let Some(descriptor) = descriptors.last_mut() {
                apply_descriptor(descriptor, create, content)?;
            }
            continue;
        }
        if create.name != "create_terrain" {
            continue;
        }
        let terrain_id = exact_terrain_argument(create, 0, content, "RMSGEN3301")?;
        descriptors.push(ExactTerrainDescriptor {
            target_tiles: u32::from(dimensions.width),
            percent_of_land: 0,
            terrain_id,
            clumps: 1,
            spacing_to_other_terrain_types: 0,
            base_terrain_id: native.default_terrain_id,
            clumping_factor: DEFAULT_CLUMPING_FACTOR,
            avoid_start_mode: 0,
            avoid_start_distance: 0,
            minimum_height: 0,
            maximum_height: 255,
            flat_only: native.flat_only_terrain_id == Some(terrain_id),
            generate_mode: 0,
            base_layer_terrain_id: -1,
            replacement_terrain_id: -1,
            mask_flags: 0,
            metadata: 0,
            layer_output: -2,
            specific_terrain_spacing: Vec::new(),
            operation_index: operation_index as u32,
        });
    }
    for descriptor in &mut descriptors {
        apply_native_scaling(descriptor, dimensions)?;
    }
    Ok(descriptors)
}

fn apply_descriptor(
    descriptor: &mut ExactTerrainDescriptor,
    operation: &SemanticOperation,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    match operation.name.as_str() {
        "number_of_tiles" => {
            set_signed_target(descriptor, numeric_i32(operation, 0)?);
        }
        "percent_of_land" => {}
        "land_percent" => {
            set_signed_target(descriptor, numeric_i32(operation, 0)?.saturating_neg());
        }
        "number_of_clumps" => {
            descriptor.clumps = rounded_nonnegative_u32(operation, 0, "terrain clump count")?;
        }
        "spacing_to_other_terrain_types" => {
            if !operation.arguments.is_empty() {
                descriptor.spacing_to_other_terrain_types =
                    rounded_nonnegative_u16(operation, 0, "terrain spacing")?;
            }
        }
        "base_terrain" => {
            descriptor.base_terrain_id = native_terrain_byte_argument(operation, 0, content)?;
            if operation.arguments[0].resolution == ArgumentResolution::UndefinedNumericFallback {
                descriptor.mask_flags &= !1;
            } else {
                descriptor.mask_flags |= 1;
            }
        }
        "clumping_factor" => descriptor.clumping_factor = numeric_i32(operation, 0)?,
        "set_avoid_player_start_areas" => {
            let distance = if operation.arguments.is_empty() {
                0
            } else {
                let rounded = numeric_value(operation, 0)?.round();
                if f64::from(rounded) > f64::from(i32::MAX) {
                    return Err(invalid_request(
                        "RMSGEN3301",
                        "terrain start distance exceeds i32",
                    ));
                }
                rounded as i32
            };
            descriptor.avoid_start_mode = 1;
            descriptor.avoid_start_distance = if distance == 0 { 13 } else { distance };
        }
        "height_limits" => {
            descriptor.minimum_height = numeric_i16(operation, 0, "terrain minimum height")?;
            descriptor.maximum_height = numeric_i16(operation, 1, "terrain maximum height")?;
        }
        "set_flat_terrain_only" => descriptor.flat_only = true,
        "generate_mode" => {}
        "base_layer" => {
            descriptor.base_layer_terrain_id =
                exact_terrain_argument(operation, 0, content, "RMSGEN3301")?.0 as i32;
            descriptor.mask_flags |= 2;
        }
        "terrain_mask" => {
            descriptor.generate_mode =
                u8::try_from(rounded_nonnegative_u32(operation, 0, "terrain mask")?)
                    .map_err(|_| invalid_request("RMSGEN3301", "terrain mask exceeds u8"))?;
        }
        "beach_terrain" => {
            descriptor.layer_output =
                exact_terrain_argument(operation, 0, content, "RMSGEN3301")?.0 as i32;
        }
        "spacing_to_specific_terrain" => {
            let terrain_id = native_terrain_byte_argument(operation, 0, content)?;
            if terrain_id.0 < 200 {
                descriptor
                    .specific_terrain_spacing
                    .push(ExactTerrainSpacingRule {
                        terrain_id,
                        distance: rounded_nonnegative_u16(
                            operation,
                            1,
                            "specific terrain spacing",
                        )?,
                    });
            }
        }
        "set_scale_by_groups" => descriptor.metadata = 2,
        "set_scale_by_size" => descriptor.metadata = 1,
        _ => {}
    }
    Ok(())
}

fn set_signed_target(descriptor: &mut ExactTerrainDescriptor, value: i32) {
    if value < 0 {
        descriptor.percent_of_land = value.unsigned_abs();
        descriptor.target_tiles = 0;
    } else {
        descriptor.percent_of_land = 0;
        descriptor.target_tiles = value as u32;
    }
}

fn apply_native_scaling(
    descriptor: &mut ExactTerrainDescriptor,
    dimensions: MapDimensions,
) -> Result<(), GenerationError> {
    let map_area = u64::from(dimensions.width) * u64::from(dimensions.height);
    if descriptor.percent_of_land > 0 {
        let target_tiles = u64::from(descriptor.percent_of_land)
            .checked_mul(map_area)
            .ok_or_else(|| invalid_request("RMSGEN3302", "terrain percentage overflow"))?
            / 100;
        descriptor.target_tiles = u32::try_from(target_tiles)
            .map_err(|_| invalid_request("RMSGEN3302", "terrain percentage target exceeds u32"))?;
    } else if (descriptor.metadata == 1 || descriptor.metadata == 2) && descriptor.target_tiles > 0
    {
        let target_tiles = u64::from(descriptor.target_tiles)
            .checked_mul(map_area)
            .ok_or_else(|| invalid_request("RMSGEN3302", "scaled terrain target overflow"))?
            / 10_000;
        descriptor.target_tiles = u32::try_from(target_tiles)
            .map_err(|_| invalid_request("RMSGEN3302", "scaled terrain target exceeds u32"))?;
    }
    if descriptor.metadata == 2 {
        let clumps = u64::from(descriptor.clumps)
            .checked_mul(map_area)
            .ok_or_else(|| invalid_request("RMSGEN3302", "scaled terrain clump count overflow"))?
            / 10_000;
        descriptor.clumps = u32::try_from(clumps)
            .map_err(|_| invalid_request("RMSGEN3302", "scaled terrain clump count exceeds u32"))?;
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
        .ok_or_else(|| {
            invalid_request(
                "RMSGEN3301",
                &format!(
                    "terrain operation `{}` is missing argument {index}",
                    operation.name
                ),
            )
        })?
        .value
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN3301", "terrain argument is not numeric"))?;
    if !value.is_finite() || value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request(
            "RMSGEN3301",
            "terrain argument exceeds i32",
        ));
    }
    Ok(value)
}

fn rounded_nonnegative_u32(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u32, GenerationError> {
    let value = numeric_value(operation, index)?.round();
    if value < 0.0 || f64::from(value) > f64::from(i32::MAX) {
        return Err(invalid_request(
            "RMSGEN3301",
            &format!("{description} exceeds signed descriptor bounds"),
        ));
    }
    Ok(value as u32)
}

fn rounded_nonnegative_u16(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u16, GenerationError> {
    let value = numeric_value(operation, index)?.round();
    if value < 0.0 {
        return Err(invalid_request(
            "RMSGEN3301",
            &format!("{description} cannot be negative"),
        ));
    }
    if value > f32::from(u16::MAX) {
        return Err(invalid_request(
            "RMSGEN3301",
            &format!("{description} exceeds u16"),
        ));
    }
    Ok(value as u16)
}

fn numeric_i16(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<i16, GenerationError> {
    i16::try_from(numeric_i32(operation, index)?)
        .map_err(|_| invalid_request("RMSGEN3301", &format!("{description} exceeds i16")))
}

fn native_terrain_byte_argument(
    operation: &SemanticOperation,
    index: usize,
    content: CompatibleContentView<'_>,
) -> Result<TerrainId, GenerationError> {
    let value = operation
        .arguments
        .get(index)
        .ok_or_else(|| invalid_request("RMSGEN3301", "terrain operation is missing an argument"))?
        .value
        .as_str();
    match value.parse::<f32>() {
        Ok(number) if number.is_finite() => Ok(TerrainId(u32::from((number as i32) as u8))),
        _ => exact_terrain_argument(operation, index, content, "RMSGEN3301"),
    }
}

fn coordinate(index: usize, width: usize) -> MapCoordinate {
    MapCoordinate {
        x: (index % width) as u16,
        y: (index / width) as u16,
    }
}

fn terrain_hash(terrain: &[TerrainId]) -> Result<[u8; 32], GenerationError> {
    let values = terrain
        .iter()
        .map(|value| {
            u8::try_from(value.0).map_err(|_| {
                invalid_request(
                    "RMSGEN3301",
                    "terrain id exceeds the target profile byte range",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Sha256::digest(values).into())
}

fn terrain_zone_hash(terrain_zone: &[u32]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for value in terrain_zone {
        digest.update(value.to_le_bytes());
    }
    digest.finalize().into()
}

fn bounded_work(
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    *work = work.saturating_add(1);
    if *work > maximum_work {
        return Err(invalid_request(
            "RMSGEN3302",
            "terrain generation exhausted its bounded work budget",
        ));
    }
    if (*work).is_multiple_of(1024) {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, *work)?;
    }
    Ok(())
}
