use super::exact_appearance::{
    AppearanceAcceptance, ExactAppearanceObject, consume_terrain_appearances,
};
use super::*;
use rms_content::{TerrainAppearanceDefinition, TerrainAppearancePlacement};
use rms_semantics::{RmsRandom, RmsRngPurpose, RmsRngState, SemanticOperation};

const SEARCH_UNOCCUPIED: u8 = 0xfe;
const SEARCH_REJECTED: u8 = 0xff;
const MAXIMUM_LAND_DESCRIPTORS: usize = 16_384;
const MAXIMUM_LAND_CANDIDATE_SAMPLES: usize = 20_000;
const MAXIMUM_LAND_LEADING_RNG_SAMPLES: usize = 64;
const LAND_AVOIDANCE_OFFSET_SCALE_BITS: u64 = 0x3fe5_5553_ef6b_5d46;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LandAssignmentOutcome {
    Selected(u8),
    Removed,
}

pub(super) struct LandAssignmentTracker {
    used_slots: BTreeSet<u8>,
    colors: BTreeMap<u8, u8>,
}

impl LandAssignmentTracker {
    pub(super) fn new(semantic_program: &SemanticProgram) -> Self {
        Self {
            used_slots: BTreeSet::new(),
            colors: semantic_program
                .execution_context
                .players
                .iter()
                .map(|player| (player.slot, player.color))
                .collect(),
        }
    }

    pub(super) fn resolve(
        &mut self,
        operation: &SemanticOperation,
        players: &[ExactSetupPlayer],
    ) -> Result<LandAssignmentOutcome, GenerationError> {
        let mode = match truncated_i32_argument(operation, 0)? {
            mode @ (1 | 2) => mode,
            _ => 0,
        };
        let selector = numeric_i32_argument(operation, 1)?;
        let first_eligible = numeric_i32_argument(operation, 2)? != 0;
        let reuse = numeric_i32_argument(operation, 3)?;
        let accepts_used = reuse == 1;
        let mut players = players.to_vec();
        players.sort_by_key(|player| player.slot);
        let team_values = compact_team_selector_values(&players);
        let mut candidates = Vec::new();
        match mode {
            2 => {
                let excluded = selector.checked_neg();
                for (player, team) in players.iter().zip(team_values) {
                    let selector_matches = if selector < 0 {
                        Some(team) != excluded
                    } else {
                        team == selector
                    };
                    if selector_matches && (accepts_used || !self.used_slots.contains(&player.slot))
                    {
                        candidates.push(player.slot);
                    }
                }
            }
            1 => {
                if let Some(player) = players.iter().find(|player| {
                    self.colors
                        .get(&player.slot)
                        .is_some_and(|color| i32::from(*color) + 1 == selector)
                        && (accepts_used || !self.used_slots.contains(&player.slot))
                }) {
                    candidates.push(player.slot);
                }
            }
            _ => {
                if selector >= 0
                    && selector <= players.len() as i32
                    && (accepts_used || !self.used_slots.contains(&(selector as u8)))
                {
                    candidates.push(selector as u8);
                }
            }
        }

        let selected = if mode != 2 || first_eligible {
            if !operation.parser_effect_rng_draws.is_empty() {
                return Err(invalid_request(
                    "RMSGEN3001",
                    "deterministic land assignment has unexpected parser RNG effects",
                ));
            }
            candidates.first().copied()
        } else if candidates.is_empty() {
            if !operation.parser_effect_rng_draws.is_empty() {
                return Err(invalid_request(
                    "RMSGEN3001",
                    "failed land assignment has unexpected parser RNG effects",
                ));
            }
            None
        } else {
            let [draw] = operation.parser_effect_rng_draws.as_slice() else {
                return Err(invalid_request(
                    "RMSGEN3001",
                    "random land assignment needs exactly one parser RNG effect",
                ));
            };
            let upper_exclusive = u32::try_from(candidates.len()).map_err(|_| {
                invalid_request(
                    "RMSGEN3001",
                    "land assignment candidate count exceeds its RNG range",
                )
            })?;
            if draw.purpose != RmsRngPurpose::LandAssignmentSelection
                || draw.sample.upper_exclusive != upper_exclusive
            {
                return Err(invalid_request(
                    "RMSGEN3001",
                    "land assignment parser effect identity differs",
                ));
            }
            candidates.get(draw.sample.result as usize).copied()
        };
        let Some(slot) = selected else {
            return Ok(LandAssignmentOutcome::Removed);
        };
        if reuse != 2 {
            self.used_slots.insert(slot);
        }
        Ok(LandAssignmentOutcome::Selected(slot))
    }
}

fn compact_team_selector_values(players: &[ExactSetupPlayer]) -> Vec<i32> {
    let mut next_team = 0_i32;
    let mut compact = BTreeMap::<u8, i32>::new();
    players
        .iter()
        .map(|player| {
            if player.team == 0
                || players
                    .iter()
                    .filter(|candidate| candidate.team == player.team)
                    .count()
                    < 2
            {
                0
            } else {
                *compact.entry(player.team).or_insert_with(|| {
                    next_team += 1;
                    next_team
                })
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AppliedLandCommand<'a> {
    pub operation_index: usize,
    pub operation: &'a SemanticOperation,
    pub range_position: usize,
    pub range_len: usize,
    pub assignment: Option<u8>,
}

#[derive(Clone, Debug)]
pub(super) struct NativeLandRecord<'a> {
    pub create_operation_index: usize,
    pub create_player_lands: bool,
    pub player_slot: Option<u8>,
    pub commands: Vec<AppliedLandCommand<'a>>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct NativeLandBlocks<'a> {
    pub records: Vec<NativeLandRecord<'a>>,
    pub ignored: Vec<(usize, &'a SemanticOperation)>,
    pub controller_commands: Vec<&'a SemanticOperation>,
}

pub(super) fn interpret_land_blocks<'a>(
    semantic_program: &'a SemanticProgram,
    players: &[ExactSetupPlayer],
) -> Result<NativeLandBlocks<'a>, GenerationError> {
    let mut blocks = NativeLandBlocks::default();
    let mut tracker = LandAssignmentTracker::new(semantic_program);
    let mut range: Option<(usize, usize)> = None;
    let mut single_land = false;
    for (operation_index, operation) in semantic_program.operations.iter().enumerate() {
        if !operation.accepted_by_target_parser() || operation.section != "land_generation" {
            continue;
        }
        if operation.depth == 0 {
            match operation.name.as_str() {
                "create_player_lands" => {
                    let start = blocks.records.len();
                    for player in players {
                        blocks.records.push(NativeLandRecord {
                            create_operation_index: operation_index,
                            create_player_lands: true,
                            player_slot: Some(player.slot),
                            commands: Vec::new(),
                        });
                    }
                    range = Some((start, blocks.records.len()));
                    single_land = false;
                }
                "create_land" => {
                    let start = blocks.records.len();
                    blocks.records.push(NativeLandRecord {
                        create_operation_index: operation_index,
                        create_player_lands: false,
                        player_slot: None,
                        commands: Vec::new(),
                    });
                    range = Some((start, start + 1));
                    single_land = true;
                }
                _ => {}
            }
            continue;
        }
        let Some((start, end)) = range.filter(|(_, end)| *end <= blocks.records.len()) else {
            blocks.ignored.push((operation_index, operation));
            continue;
        };
        let single = |assignment| AppliedLandCommand {
            operation_index,
            operation,
            range_position: 0,
            range_len: 1,
            assignment,
        };
        match operation.name.as_str() {
            "land_position" | "assign_to" | "assign_to_player" if !single_land => {
                blocks.ignored.push((operation_index, operation));
            }
            "land_position" => blocks.records[start].commands.push(single(None)),
            "assign_to_player" => {
                let value = numeric_i32_argument(operation, 0)?;
                if !(0..=9).contains(&value) {
                    blocks.ignored.push((operation_index, operation));
                } else if value == 0 || players.iter().any(|player| i32::from(player.slot) == value)
                {
                    blocks.records[start]
                        .commands
                        .push(single(Some(value as u8)));
                } else {
                    blocks.records.pop();
                    single_land = false;
                }
            }
            "assign_to" => match tracker.resolve(operation, players)? {
                LandAssignmentOutcome::Selected(slot)
                    if slot == 0 || players.iter().any(|player| player.slot == slot) =>
                {
                    blocks.records[start].commands.push(single(Some(slot)));
                }
                _ => {
                    blocks.records.pop();
                    range = start.checked_sub(1).map(|start| (start, end - 1));
                    single_land = false;
                }
            },
            "circle_radius" => blocks.controller_commands.push(operation),
            _ => {
                let range_len = end - start;
                if range_len == 0 {
                    blocks.ignored.push((operation_index, operation));
                }
                for (range_position, record) in blocks.records[start..end].iter_mut().enumerate() {
                    record.commands.push(AppliedLandCommand {
                        operation_index,
                        operation,
                        range_position,
                        range_len,
                        assignment: None,
                    });
                }
            }
        }
    }
    Ok(blocks)
}

#[derive(Clone, Debug)]
pub(super) struct PrePositionLandRandomization {
    pub rng: RmsRandom,
    zone_values_by_operation: BTreeMap<usize, Vec<u8>>,
}

pub(super) fn resolve_pre_position_land_randomization(
    semantic_program: &SemanticProgram,
    player_count: usize,
) -> Result<PrePositionLandRandomization, GenerationError> {
    let player_upper = u32::try_from(player_count).map_err(|_| {
        invalid_request(
            "RMSGEN3001",
            "player count exceeds the set-zone-randomly fixed-width range",
        )
    })?;
    if player_upper == 0 {
        return Err(invalid_request(
            "RMSGEN3001",
            "set-zone-randomly requires at least one active player",
        ));
    }

    let rng = RmsRandom::from_state(semantic_program.rng_state_after_parser);
    let mut zone_values_by_operation = BTreeMap::new();
    for (operation_index, operation) in semantic_program.operations.iter().enumerate() {
        if !operation.accepted_by_target_parser()
            || operation.section != "land_generation"
            || operation.depth == 0
            || operation.name != "set_zone_randomly"
        {
            continue;
        }
        let mut values = Vec::with_capacity(operation.parser_effect_rng_draws.len());
        for draw in &operation.parser_effect_rng_draws {
            if draw.purpose != RmsRngPurpose::LandZoneRandomization
                || draw.sample.upper_exclusive != player_upper
            {
                return Err(invalid_request(
                    "RMSGEN3001",
                    "set-zone-randomly parser effect identity differs",
                ));
            }
            let value = draw.sample.result.checked_add(2).ok_or_else(|| {
                invalid_request("RMSGEN3001", "random land zone exceeds its bounded range")
            })?;
            values.push(u8::try_from(value).map_err(|_| {
                invalid_request(
                    "RMSGEN3001",
                    "random land zone exceeds its fixed-width range",
                )
            })?);
        }
        zone_values_by_operation.insert(operation_index, values);
    }

    Ok(PrePositionLandRandomization {
        rng,
        zone_values_by_operation,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactLandDescriptor {
    pub assigned_slot: Option<u8>,
    pub object_placement_id: i32,
    pub target_tiles: u32,
    pub conformity_target_tiles: u32,
    pub terrain_id: TerrainId,
    pub authored_position: MapCoordinate,
    pub position: MapCoordinate,
    pub base_size: u16,
    pub base_elevation: i16,
    pub other_zone_avoidance_distance: u16,
    pub minimum_placement_distance: i32,
    pub zone: u8,
    pub clumping_factor: i32,
    pub left_border: i32,
    pub top_border: i32,
    pub right_border: i32,
    pub bottom_border: i32,
    pub border_fuzziness: i32,
    pub circular: bool,
    pub conformity: i32,
    pub generate_mode: i32,
    pub operation_index: u32,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactLandStatistics {
    pub accepted_tiles: u64,
    pub rejected_candidates: u64,
    pub popped_candidates: u64,
    pub cleanup_candidates: u64,
    pub border_draws: u64,
    pub conformity_draws: u64,
    pub priority_draws: [u64; 4],
    pub restored_base_terrain_tiles: u64,
    pub appearance_rng_draws: u64,
    pub auxiliary_rng_draws: u64,
    pub leading_rng_samples: Vec<ExactLandRngSample>,
    pub candidate_samples: Vec<ExactLandCandidateSample>,
    pub cleanup_samples: Vec<ExactLandCleanupSample>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactLandRngSample {
    pub upper_exclusive: u32,
    pub result: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactLandCandidateSample {
    pub descriptor_index: u8,
    pub x: i32,
    pub y: i32,
    pub cost: u8,
    pub frontier_total_cost_bits: u32,
    pub outcome: ExactLandCandidateOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactLandCandidateOutcome {
    Accepted,
    RejectedBorder,
    RejectedConformity,
    RejectedOccupied,
    RejectedZeroCost,
}

impl ExactLandCandidateOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::RejectedBorder => "rejected-border",
            Self::RejectedConformity => "rejected-conformity",
            Self::RejectedOccupied => "rejected-occupied",
            Self::RejectedZeroCost => "rejected-zero-cost",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactLandCleanupSample {
    pub descriptor_index: u8,
    pub x: i32,
    pub y: i32,
    pub outcome: ExactLandCleanupOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactLandCleanupOutcome {
    Painted,
    RejectedConformity,
    RejectedTopology,
}

impl ExactLandCleanupOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Painted => "painted",
            Self::RejectedConformity => "rejected-conformity",
            Self::RejectedTopology => "rejected-topology",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactLandState {
    pub restriction_zones: ExactRestrictionZones,
    pub dimensions: MapDimensions,
    pub base_terrain_id: TerrainId,
    pub descriptors: Vec<ExactLandDescriptor>,
    pub search_zone: Vec<u8>,
    pub land_zone: Vec<u32>,
    pub elevation_land_id: Vec<u16>,
    pub terrain: Vec<TerrainId>,
    pub elevation: Vec<i16>,
    pub tile_operation_indices: Vec<u32>,
    pub appearance_objects: Vec<ExactAppearanceObject>,
    pub rng_state: RmsRngState,
    pub auxiliary_rng_state: RmsRngState,
    pub statistics: ExactLandStatistics,
}

impl ExactLandState {
    pub fn search_zone_hash(&self) -> [u8; 32] {
        Sha256::digest(&self.search_zone).into()
    }

    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-land-state-v3");
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.u32(self.base_terrain_id.0);
        writer.u32(self.search_zone.len() as u32);
        writer.bytes(&self.search_zone);
        for value in &self.land_zone {
            writer.u32(*value);
        }
        for value in &self.elevation_land_id {
            writer.u16(*value);
        }
        for value in &self.terrain {
            writer.u32(value.0);
        }
        for value in &self.elevation {
            writer.i16(*value);
        }
        writer.u32(self.appearance_objects.len() as u32);
        for appearance in &self.appearance_objects {
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
        writer.bytes(&self.rng_state.checkpoint_hash());
        writer.bytes(&self.auxiliary_rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

pub(crate) fn project_search_zones(search_zone: &[u8]) -> Vec<u32> {
    search_zone.iter().copied().map(u32::from).collect()
}

#[derive(Clone, Debug, Default)]
struct FrontierNode {
    queue: Option<usize>,
    previous: Option<usize>,
    next: Option<usize>,
    cost: i32,
    total_cost_bits: u32,
}

#[derive(Debug)]
struct SharedFrontiers {
    heads: Vec<Option<usize>>,
    nodes: Vec<FrontierNode>,
}

impl SharedFrontiers {
    fn new(queue_count: usize, tile_count: usize) -> Self {
        Self {
            heads: vec![None; queue_count],
            nodes: vec![FrontierNode::default(); tile_count],
        }
    }

    fn remove(&mut self, node_index: usize) {
        let Some(queue) = self.nodes[node_index].queue else {
            return;
        };
        let previous = self.nodes[node_index].previous;
        let next = self.nodes[node_index].next;
        if let Some(previous) = previous {
            self.nodes[previous].next = next;
        } else {
            self.heads[queue] = next;
        }
        if let Some(next) = next {
            self.nodes[next].previous = previous;
        }
        self.nodes[node_index].queue = None;
        self.nodes[node_index].previous = None;
        self.nodes[node_index].next = None;
    }

    fn insert(&mut self, queue: usize, node_index: usize, cost: i32, total_cost: f32) {
        self.remove(node_index);
        let mut previous = None;
        let mut current = self.heads[queue];
        while let Some(index) = current {
            if f32::from_bits(self.nodes[index].total_cost_bits) >= total_cost {
                break;
            }
            previous = current;
            current = self.nodes[index].next;
        }
        self.nodes[node_index].queue = Some(queue);
        self.nodes[node_index].previous = previous;
        self.nodes[node_index].next = current;
        self.nodes[node_index].cost = cost;
        self.nodes[node_index].total_cost_bits = total_cost.to_bits();
        if let Some(previous) = previous {
            self.nodes[previous].next = Some(node_index);
        } else {
            self.heads[queue] = Some(node_index);
        }
        if let Some(current) = current {
            self.nodes[current].previous = Some(node_index);
        }
    }

    fn pop(&mut self, queue: usize) -> Option<(usize, i32, u32)> {
        let index = self.heads[queue]?;
        let cost = self.nodes[index].cost;
        let total_cost_bits = self.nodes[index].total_cost_bits;
        self.remove(index);
        Some((index, cost, total_cost_bits))
    }
}

pub fn resolve_exact_land_state(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactLandState, GenerationError> {
    let dimensions = setup.effective_dimensions;
    let tile_count = dimensions.tile_count()?;
    let (base_terrain_id, mut descriptors) = collect_descriptors(semantic_program, setup, content)?;
    let base_layer = resolve_land_base_layer(semantic_program, content)?;
    let base_appearances = &content
        .terrain(base_terrain_id)
        .ok_or(GenerationError::MissingContentDefinition {
            kind: ContentDefinitionKind::Terrain,
            id: base_terrain_id.0,
        })?
        .appearances;
    if descriptors.len() > MAXIMUM_LAND_DESCRIPTORS {
        return Err(invalid_request(
            "RMSGEN3001",
            "land descriptor count exceeds its bounded limit",
        ));
    }

    let mut restriction_zones =
        ExactRestrictionZones::new(&semantic_program.operations, content, &setup.players)?;
    let rules = generation_rules(&semantic_program.identity.profile)?;
    let path = restriction_zones
        .runtime_attributes()
        .initial_path_context(dimensions, content, rules)?;
    std::sync::Arc::make_mut(&mut restriction_zones.objects).path = path;
    resolve_omitted_land_positions(&mut descriptors, dimensions, &mut rng)?;

    rng.next_u32();
    let mut auxiliary_rng = RmsRandom::registered(semantic_program.execution_context.seed, 6)
        .ok_or_else(|| invalid_request("RMSGEN3001", "land auxiliary RNG registration failed"))?
        .with_observed_draw_count(5);
    let mut terrain = vec![base_terrain_id; tile_count];
    let mut elevation = vec![0_i16; tile_count];
    let mut search_zone = vec![SEARCH_UNOCCUPIED; tile_count];
    let mut tile_land_zone = vec![u32::from(SEARCH_UNOCCUPIED); tile_count];
    let mut elevation_land_id = vec![base_layer.unwrap_or(u16::MAX); tile_count];
    let mut operation_indices = vec![u32::MAX; tile_count];
    let mut frontiers = SharedFrontiers::new(descriptors.len(), tile_count);
    let mut land_sizes = vec![0_u32; descriptors.len().max(256)];
    let width = usize::from(dimensions.width);
    let maximum_x = i32::from(dimensions.width) - 1;
    let maximum_y = i32::from(dimensions.height) - 1;
    let mut statistics = ExactLandStatistics::default();

    for (descriptor_index, descriptor) in descriptors.iter().enumerate() {
        let base = if descriptor.conformity >= 100 {
            cleanup_radius(descriptor)
        } else {
            i32::from(descriptor.base_size)
        };
        let center_x = i32::from(descriptor.position.x);
        let center_y = i32::from(descriptor.position.y);
        let minimum_x = (center_x - base).max(0);
        let minimum_y = (center_y - base).max(0);
        let maximum_base_x = (center_x + base).min(maximum_x);
        let maximum_base_y = (center_y + base).min(maximum_y);
        for y in minimum_y..=maximum_base_y {
            for x in minimum_x..=maximum_base_x {
                let delta_x = x - center_x;
                let delta_y = y - center_y;
                let distance_squared =
                    delta_x.saturating_mul(delta_x) + delta_y.saturating_mul(delta_y);
                if descriptor.circular && distance_squared > base.saturating_mul(base) {
                    continue;
                }
                let index = tile_index(width, x, y);
                search_zone[index] = descriptor.zone;
                tile_land_zone[index] = u32::from(descriptor.zone);
                operation_indices[index] = descriptor.operation_index;
                elevation[index] = descriptor.base_elevation;
                if !descriptor.circular
                    || native_circular_terrain_contains(delta_x, delta_y, base as u16)
                {
                    terrain[index] = descriptor.terrain_id;
                    elevation_land_id[index] = u16::MAX;
                }
            }
        }
        let base_tiles = base_tile_count(minimum_x, minimum_y, maximum_base_x, maximum_base_y);
        let initial_size_index =
            initial_land_size_index(setup.behavior_version, descriptor_index, descriptor.zone);
        if let Some(initial_size_index) = initial_size_index {
            land_sizes[initial_size_index] = base_tiles;
        }

        if minimum_x > 0 {
            for y in minimum_y..=maximum_base_y {
                let index = tile_index(width, minimum_x - 1, y);
                frontiers.insert(descriptor_index, index, descriptor_index as i32, 0.0);
            }
        }
        if minimum_y > 0 {
            for x in minimum_x..=maximum_base_x {
                let index = tile_index(width, x, minimum_y - 1);
                frontiers.insert(descriptor_index, index, descriptor_index as i32, 0.0);
            }
        }
        if maximum_base_x < maximum_x {
            for y in minimum_y..=maximum_base_y {
                let index = tile_index(width, maximum_base_x + 1, y);
                frontiers.insert(descriptor_index, index, descriptor_index as i32, 0.0);
            }
        }
        if maximum_base_y < maximum_y {
            for x in minimum_x..=maximum_base_x {
                let index = tile_index(width, x, maximum_base_y + 1);
                frontiers.insert(descriptor_index, index, descriptor_index as i32, 0.0);
            }
        }
    }

    let maximum_work = (tile_count as u64)
        .saturating_mul(descriptors.len().max(1) as u64)
        .saturating_mul(64)
        .max(4096);
    let mut work = 0_u64;
    loop {
        let mut popped_any = false;
        for (descriptor_index, descriptor) in descriptors.iter().enumerate() {
            if descriptor.conformity >= 100
                || land_sizes[descriptor_index] >= descriptor.target_tiles
            {
                continue;
            }
            let Some((index, _, frontier_total_cost_bits)) = frontiers.pop(descriptor_index) else {
                continue;
            };
            popped_any = true;
            work = bounded_work(work, maximum_work, cancellation)?;
            statistics.popped_candidates += 1;
            let (x, y) = tile_coordinate(width, index);
            let cost = terrain_and_zone_cost(
                &descriptors,
                descriptor_index,
                x,
                y,
                dimensions,
                &search_zone,
            );
            let border_draw =
                land_bounded(&mut rng, 100, &mut statistics.leading_rng_samples) as i32;
            statistics.border_draws += 1;
            let chance = border_chance(descriptor, x, y, dimensions);
            if descriptor.conformity <= 0 && chance > border_draw {
                search_zone[index] = SEARCH_REJECTED;
                statistics.rejected_candidates += 1;
                record_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    cost,
                    frontier_total_cost_bits,
                    ExactLandCandidateOutcome::RejectedBorder,
                );
                continue;
            }

            let radius = growth_radius(descriptor);
            if !conforms(
                descriptor,
                x,
                y,
                radius,
                dimensions,
                &mut rng,
                &mut statistics.leading_rng_samples,
            ) {
                statistics.conformity_draws += 1;
                statistics.rejected_candidates += 1;
                record_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    cost,
                    frontier_total_cost_bits,
                    ExactLandCandidateOutcome::RejectedConformity,
                );
                continue;
            }
            statistics.conformity_draws += 1;
            if search_zone[index] != SEARCH_UNOCCUPIED {
                statistics.rejected_candidates += 1;
                record_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    cost,
                    frontier_total_cost_bits,
                    ExactLandCandidateOutcome::RejectedOccupied,
                );
                continue;
            }
            if cost == 0 {
                statistics.rejected_candidates += 1;
                record_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    cost,
                    frontier_total_cost_bits,
                    ExactLandCandidateOutcome::RejectedZeroCost,
                );
                continue;
            }

            search_zone[index] = descriptor.zone;
            tile_land_zone[index] = u32::from(descriptor.zone);
            operation_indices[index] = descriptor.operation_index;
            paint_accepted_growth_tile(
                &mut terrain,
                &mut elevation,
                &mut elevation_land_id,
                index,
                descriptor,
            );
            statistics.accepted_tiles += 1;
            record_candidate(
                &mut statistics,
                descriptor_index,
                x,
                y,
                cost,
                frontier_total_cost_bits,
                ExactLandCandidateOutcome::Accepted,
            );

            for (direction, (next_x, next_y)) in [
                (0, (x - 1, y)),
                (1, (x + 1, y)),
                (2, (x, y - 1)),
                (3, (x, y + 1)),
            ] {
                let permitted = conforms(
                    descriptor,
                    next_x,
                    next_y,
                    radius,
                    dimensions,
                    &mut rng,
                    &mut statistics.leading_rng_samples,
                );
                statistics.conformity_draws += 1;
                if !permitted
                    || next_x < 0
                    || next_x > maximum_x
                    || next_y < 0
                    || next_y > maximum_y
                {
                    continue;
                }
                let next_index = tile_index(width, next_x, next_y);
                if search_zone[next_index] != SEARCH_UNOCCUPIED {
                    continue;
                }
                let priority_draw =
                    land_bounded(&mut rng, 100, &mut statistics.leading_rng_samples) as i32;
                statistics.priority_draws[direction] += 1;
                let total_cost = (priority_draw
                    - descriptor.clumping_factor.saturating_mul(cost as i32)
                    + 250) as f32;
                frontiers.insert(descriptor_index, next_index, 0, total_cost);
            }
            land_sizes[descriptor_index] = land_sizes[descriptor_index].saturating_add(1);
        }
        if !popped_any {
            break;
        }
    }

    for (descriptor_index, descriptor) in descriptors.iter().enumerate() {
        let radius = cleanup_radius(descriptor);
        while let Some((index, _, _)) = frontiers.pop(descriptor_index) {
            work = bounded_work(work, maximum_work, cancellation)?;
            statistics.cleanup_candidates += 1;
            let (x, y) = tile_coordinate(width, index);
            if !conforms(
                descriptor,
                x,
                y,
                radius,
                dimensions,
                &mut rng,
                &mut statistics.leading_rng_samples,
            ) {
                statistics.conformity_draws += 1;
                record_cleanup_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    ExactLandCleanupOutcome::RejectedConformity,
                );
                continue;
            }
            statistics.conformity_draws += 1;
            let horizontal = x >= 1
                && x < maximum_x
                && search_zone[tile_index(width, x - 1, y)] == descriptor.zone
                && search_zone[tile_index(width, x + 1, y)] == descriptor.zone;
            let vertical = y >= 1
                && y < maximum_y
                && search_zone[tile_index(width, x, y - 1)] == descriptor.zone
                && search_zone[tile_index(width, x, y + 1)] == descriptor.zone;
            elevation[index] = descriptor.base_elevation;
            if horizontal || vertical {
                terrain[index] = descriptor.terrain_id;
                elevation_land_id[index] = u16::MAX;
                operation_indices[index] = descriptor.operation_index;
                record_cleanup_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    ExactLandCleanupOutcome::Painted,
                );
            } else {
                record_cleanup_candidate(
                    &mut statistics,
                    descriptor_index,
                    x,
                    y,
                    ExactLandCleanupOutcome::RejectedTopology,
                );
            }
        }
    }

    let mut appearance_objects = Vec::new();
    let cleanup_statistics = clean_base_terrain(
        &mut terrain,
        base_terrain_id,
        base_appearances,
        &mut rng,
        &mut auxiliary_rng,
        dimensions,
        &mut work,
        maximum_work,
        cancellation,
        &mut appearance_objects,
        &mut restriction_zones,
        content,
    )?;
    statistics.restored_base_terrain_tiles = cleanup_statistics.restored_tiles;
    statistics.appearance_rng_draws = cleanup_statistics.primary_draws;
    statistics.auxiliary_rng_draws = cleanup_statistics.auxiliary_draws;

    Ok(ExactLandState {
        restriction_zones,
        dimensions,
        base_terrain_id,
        descriptors,
        search_zone,
        land_zone: tile_land_zone,
        elevation_land_id,
        terrain,
        elevation,
        tile_operation_indices: operation_indices,
        appearance_objects,
        rng_state: rng.state(),
        auxiliary_rng_state: auxiliary_rng.state(),
        statistics,
    })
}

fn record_candidate(
    statistics: &mut ExactLandStatistics,
    descriptor_index: usize,
    x: i32,
    y: i32,
    cost: u8,
    frontier_total_cost_bits: u32,
    outcome: ExactLandCandidateOutcome,
) {
    if statistics.candidate_samples.len() < MAXIMUM_LAND_CANDIDATE_SAMPLES {
        statistics.candidate_samples.push(ExactLandCandidateSample {
            descriptor_index: descriptor_index as u8,
            x,
            y,
            cost,
            frontier_total_cost_bits,
            outcome,
        });
    }
}

fn record_cleanup_candidate(
    statistics: &mut ExactLandStatistics,
    descriptor_index: usize,
    x: i32,
    y: i32,
    outcome: ExactLandCleanupOutcome,
) {
    if statistics.cleanup_samples.len() < MAXIMUM_LAND_CANDIDATE_SAMPLES {
        statistics.cleanup_samples.push(ExactLandCleanupSample {
            descriptor_index: descriptor_index as u8,
            x,
            y,
            outcome,
        });
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BaseTerrainCleanupStatistics {
    restored_tiles: u64,
    primary_draws: u64,
    auxiliary_draws: u64,
}

#[allow(clippy::too_many_arguments)]
fn clean_base_terrain(
    terrain: &mut [TerrainId],
    base_terrain: TerrainId,
    appearances: &[TerrainAppearanceDefinition],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    dimensions: MapDimensions,
    work: &mut u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
    appearance_objects: &mut Vec<ExactAppearanceObject>,
    restriction_zones: &mut ExactRestrictionZones,
    content: CompatibleContentView<'_>,
) -> Result<BaseTerrainCleanupStatistics, GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    let mut statistics = BaseTerrainCleanupStatistics::default();
    let mut updated = true;
    while updated {
        updated = false;
        for pass in 0..2 {
            for y in 0..height {
                for x in 0..width {
                    *work = bounded_work(*work, maximum_work, cancellation)?;
                    let index = y * width + x;
                    if terrain[index] == base_terrain {
                        continue;
                    }
                    let top = y > 0 && terrain[index - width] == base_terrain;
                    let bottom = y + 1 < height && terrain[index + width] == base_terrain;
                    let left = x > 0 && terrain[index - 1] == base_terrain;
                    let right = x + 1 < width && terrain[index + 1] == base_terrain;
                    if pass == 0 {
                        if (top && bottom) || (right && left) {
                            terrain[index] = base_terrain;
                            consume_base_terrain_appearance(
                                index,
                                base_terrain,
                                appearances,
                                rng,
                                auxiliary_rng,
                                &mut statistics,
                                appearance_objects,
                                restriction_zones,
                                dimensions,
                                terrain,
                                content,
                            )?;
                            updated = true;
                        }
                        continue;
                    }

                    let top_left = x > 0 && y > 0 && terrain[index - width - 1] == base_terrain;
                    let top_right =
                        x + 1 < width && y > 0 && terrain[index - width + 1] == base_terrain;
                    let bottom_left =
                        x > 0 && y + 1 < height && terrain[index + width - 1] == base_terrain;
                    let bottom_right = x + 1 < width
                        && y + 1 < height
                        && terrain[index + width + 1] == base_terrain;
                    let mut should_update = top_left
                        && ((top_right && !top)
                            || (right && !top_right)
                            || (bottom_left && !left)
                            || (bottom && !bottom_left)
                            || (bottom_right && !bottom && !right));
                    if top_right
                        && !should_update
                        && ((top_left && !top)
                            || (left && !top_left)
                            || (bottom_right && !right)
                            || (bottom && !bottom_right)
                            || (bottom_left && !left && !bottom))
                    {
                        should_update = true;
                    }
                    if bottom_right
                        && !should_update
                        && ((top_right && !right)
                            || (top && !top_right)
                            || (bottom_left && !bottom)
                            || (left && !bottom_left)
                            || (top_left && !left && !top))
                    {
                        should_update = true;
                    }
                    if bottom_left {
                        should_update = should_update
                            || (top_left && !left)
                            || (top && !top_left)
                            || (bottom_right && !bottom)
                            || (right && !bottom_right)
                            || (top_right && !right && !top);
                    }
                    if should_update {
                        terrain[index] = base_terrain;
                        consume_base_terrain_appearance(
                            index,
                            base_terrain,
                            appearances,
                            rng,
                            auxiliary_rng,
                            &mut statistics,
                            appearance_objects,
                            restriction_zones,
                            dimensions,
                            terrain,
                            content,
                        )?;
                        updated = true;
                    }
                }
            }
        }
    }
    Ok(statistics)
}

#[allow(clippy::too_many_arguments)]
fn consume_base_terrain_appearance(
    tile_index: usize,
    source_terrain_id: TerrainId,
    appearances: &[TerrainAppearanceDefinition],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    statistics: &mut BaseTerrainCleanupStatistics,
    appearance_objects: &mut Vec<ExactAppearanceObject>,
    restriction_zones: &mut ExactRestrictionZones,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    statistics.restored_tiles = statistics.restored_tiles.saturating_add(1);
    let consumed = consume_terrain_appearances(
        appearances,
        rng,
        auxiliary_rng,
        GenerationStage::Land,
        &NeverCancelled,
        |candidate, auxiliary| {
            if !super::exact_object::appearance_candidate_allows(
                tile_index,
                candidate,
                dimensions,
                appearance_objects,
                &[],
                terrain,
                content,
                &restriction_zones.runtime_attributes(),
            )? {
                return Ok(false);
            }
            let acceptance = AppearanceAcceptance {
                object_id: candidate.object_id,
                placement: candidate.placement,
                x_sample: candidate.x_sample,
                y_sample: candidate.y_sample,
                auxiliary_sample: Some(auxiliary.next_u32()),
            };
            if let Some(appearance) =
                ExactAppearanceObject::from_acceptance(tile_index, source_terrain_id, acceptance)
            {
                let (x, y) = super::exact_object::appearance_position(
                    tile_index,
                    appearance.placement,
                    appearance.x_sample,
                    appearance.y_sample,
                    dimensions,
                )?;
                let lifecycle = restriction_zones
                    .runtime_attributes()
                    .definition(appearance.object_id, 0, content)
                    .ok_or(GenerationError::IncompatibleContent)?
                    .initial_lifecycle_state;
                let hit_points = restriction_zones.runtime_attributes().initial_hit_points(
                    appearance.object_id,
                    0,
                    content,
                )?;
                let attributes = restriction_zones.runtime_attributes();
                let definition = attributes
                    .definition(appearance.object_id, 0, content)
                    .ok_or(GenerationError::IncompatibleContent)?;
                std::sync::Arc::make_mut(&mut restriction_zones.objects).birth_on_terrain(
                    u32::try_from(appearance_objects.len())
                        .map_err(|_| GenerationError::IncompatibleContent)?,
                    appearance.object_id,
                    0,
                    lifecycle,
                    [x, y],
                    dimensions,
                    hit_points,
                    definition.pathing,
                    definition.collision_half_extents(),
                    definition.position_family,
                    Some(terrain),
                )?;
                restriction_zones.construct(
                    appearance.object_id,
                    0,
                    dimensions,
                    terrain,
                    content,
                )?;
                appearance_objects.push(appearance);
            }
            Ok(true)
        },
    )?;
    statistics.primary_draws = statistics
        .primary_draws
        .saturating_add(consumed.primary_draws);
    statistics.auxiliary_draws = statistics
        .auxiliary_draws
        .saturating_add(consumed.auxiliary_draws);
    Ok(())
}

fn bounded_work(
    work: u64,
    maximum_work: u64,
    cancellation: &dyn CancellationToken,
) -> Result<u64, GenerationError> {
    let work = work.saturating_add(1);
    if work > maximum_work {
        return Err(invalid_request(
            "RMSGEN3002",
            "land generation exhausted its bounded work budget",
        ));
    }
    if work.is_multiple_of(1024) {
        cancellation_checkpoint(cancellation, GenerationStage::Land, work)?;
    }
    Ok(work)
}

fn collect_descriptors(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
) -> Result<(TerrainId, Vec<ExactLandDescriptor>), GenerationError> {
    let pre_position_randomization =
        resolve_pre_position_land_randomization(semantic_program, setup.players.len())?;
    let operations = semantic_program
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            operation.accepted_by_target_parser() && operation.section == "land_generation"
        })
        .collect::<Vec<_>>();
    let default_terrain = native_generation_bindings(content)?.default_terrain_id;
    let mut base_terrain = default_terrain;
    for (_, operation) in &operations {
        if operation.depth == 0 && operation.name == "base_terrain" {
            base_terrain = exact_terrain_argument(operation, 0, content, "RMSGEN3001")?;
        }
    }
    let blocks = interpret_land_blocks(semantic_program, &setup.players)?;
    if let Some((_, operation)) = blocks
        .ignored
        .iter()
        .find(|(_, operation)| !operation.parser_effect_rng_draws.is_empty())
    {
        return Err(invalid_request(
            "RMSGEN3001",
            &format!(
                "the game ignores this {} because its land was removed or is not a single land, \
                 but the preview parser already drew a random number for it",
                operation.name
            ),
        ));
    }
    let mut player_position_index = 0_usize;
    let mut descriptors = Vec::with_capacity(blocks.records.len());
    for record in &blocks.records {
        let mut template = DescriptorTemplate::new(
            default_terrain,
            setup.effective_dimensions,
            u32::try_from(record.create_operation_index).map_err(|_| {
                invalid_request(
                    "RMSGEN3001",
                    "operation index exceeds its fixed-width range",
                )
            })?,
        )?;
        template.object_placement_id = if record.create_player_lands { 1 } else { -1 };
        template.assigned_slot = record.player_slot;
        for command in &record.commands {
            if let Some(slot) = command.assignment {
                template.assigned_slot = Some(slot);
                template.object_placement_id = if command.operation.name == "assign_to_player" {
                    1
                } else {
                    i32::from(slot > 0)
                };
                continue;
            }
            let random_zone_value = pre_position_randomization
                .zone_values_by_operation
                .get(&command.operation_index)
                .map(|values| {
                    if values.len() != command.range_len {
                        return Err(invalid_request(
                            "RMSGEN3001",
                            "random land zones do not cover the land range the command ran on",
                        ));
                    }
                    values.get(command.range_position).copied().ok_or_else(|| {
                        invalid_request(
                            "RMSGEN3001",
                            "random land zones do not cover every emitted descriptor",
                        )
                    })
                })
                .transpose()?;
            template.apply(
                command.operation,
                setup.effective_dimensions,
                content,
                random_zone_value,
                command.range_len,
            )?;
        }
        if land_terrain_clears_base_elevation(content, template.terrain_id) {
            template.base_elevation = 0;
        }
        let (assigned_slot, position) = if record.create_player_lands
            || template.assigned_slot.is_some_and(|slot| slot > 0)
        {
            let slot = template.assigned_slot.ok_or_else(|| {
                invalid_request("RMSGEN3001", "player-land ownership is unavailable")
            })?;
            let position = setup
                .player_positions
                .get(player_position_index)
                .filter(|position| position.slot == slot)
                .ok_or_else(|| {
                    invalid_request(
                        "RMSGEN3001",
                        "land assignment has no descriptor-ordered player position",
                    )
                })?;
            player_position_index += 1;
            (Some(slot), position.coordinate)
        } else {
            let position = if let Some((x_percent, y_percent)) = template.direct_position_percent {
                MapCoordinate {
                    x: percent_coordinate(x_percent, setup.effective_dimensions.width)?,
                    y: percent_coordinate(y_percent, setup.effective_dimensions.height)?,
                }
            } else {
                MapCoordinate {
                    x: u16::MAX,
                    y: u16::MAX,
                }
            };
            (None, position)
        };
        descriptors.push(template.finish(
            assigned_slot,
            position,
            record.create_player_lands,
            setup,
        )?);
    }
    if player_position_index != setup.player_positions.len() {
        return Err(invalid_request(
            "RMSGEN3001",
            "resolved player positions exceed the authored player-land descriptors",
        ));
    }
    Ok((base_terrain, descriptors))
}

const BASE_ELEVATION_CLEARING_TERRAIN_CLASS_MASK: u8 = 0x47;

fn land_terrain_clears_base_elevation(
    content: CompatibleContentView<'_>,
    terrain: TerrainId,
) -> bool {
    content.terrain(terrain).is_some_and(|definition| {
        definition.placement_class & BASE_ELEVATION_CLEARING_TERRAIN_CLASS_MASK != 0
    })
}

#[derive(Clone, Debug)]
struct DescriptorTemplate {
    object_placement_id: i32,
    target_tiles: u32,
    land_percent: Option<f32>,
    land_percent_divisor: usize,
    terrain_id: TerrainId,
    base_size: i32,
    base_elevation: i32,
    other_zone_avoidance_distance: i32,
    minimum_placement_distance: i32,
    zone: i32,
    zone_was_set: bool,
    zone_by_team: bool,
    team_zone_slot: Option<u8>,
    random_zone_value: Option<u8>,
    clumping_factor: i32,
    left_border: i32,
    top_border: i32,
    right_border: i32,
    bottom_border: i32,
    border_fuzziness: i32,
    circular: bool,
    conformity: i32,
    generate_mode: i32,
    assigned_slot: Option<u8>,
    direct_position_percent: Option<(f32, f32)>,
    operation_index: u32,
}

impl DescriptorTemplate {
    fn new(
        default_terrain: TerrainId,
        dimensions: MapDimensions,
        operation_index: u32,
    ) -> Result<Self, GenerationError> {
        Ok(Self {
            object_placement_id: -1,
            target_tiles: u32::try_from(dimensions.tile_count()?).expect("bounded map fits u32"),
            land_percent: None,
            land_percent_divisor: 1,
            terrain_id: default_terrain,
            base_size: 3,
            base_elevation: 0,
            other_zone_avoidance_distance: 0,
            minimum_placement_distance: -1,
            zone: 0,
            zone_was_set: false,
            zone_by_team: false,
            team_zone_slot: None,
            random_zone_value: None,
            clumping_factor: 8,
            left_border: 0,
            top_border: 0,
            right_border: i32::from(dimensions.width),
            bottom_border: i32::from(dimensions.height),
            border_fuzziness: 20,
            circular: false,
            conformity: 0,
            generate_mode: 0,
            assigned_slot: None,
            direct_position_percent: None,
            operation_index,
        })
    }

    fn apply(
        &mut self,
        operation: &SemanticOperation,
        dimensions: MapDimensions,
        content: CompatibleContentView<'_>,
        random_zone_value: Option<u8>,
        range_len: usize,
    ) -> Result<(), GenerationError> {
        match operation.name.as_str() {
            "terrain_type" => {
                self.terrain_id = exact_terrain_argument(operation, 0, content, "RMSGEN3001")?
            }
            "land_id" => {
                self.object_placement_id =
                    translated_object_placement_id(numeric_i32_argument(operation, 0)?)?;
            }
            "number_of_tiles" => {
                self.target_tiles = nonnegative_u32(operation, 0, "land tile target")?;
                self.land_percent = None;
            }
            "land_percent" => {
                let percent = numeric_argument(operation, 0)?;
                if !percent.is_finite() || percent < 0.0 {
                    return Err(invalid_request(
                        "RMSGEN3001",
                        "land percentage exceeds bounds",
                    ));
                }
                if percent < 100.0 {
                    self.target_tiles =
                        u32::try_from(dimensions.tile_count()?).expect("bounded map fits u32");
                    self.land_percent = Some(percent);
                    self.land_percent_divisor = range_len;
                } else if self.land_percent.is_none() {
                    self.land_percent = Some(100.0);
                    self.land_percent_divisor = range_len;
                }
            }
            "base_size" => self.base_size = numeric_i32_argument(operation, 0)?,
            "base_elevation" => self.base_elevation = numeric_i32_argument(operation, 0)?,
            "other_zone_avoidance_distance" => {
                self.other_zone_avoidance_distance = numeric_i32_argument(operation, 0)?;
            }
            "min_placement_distance" => {
                self.minimum_placement_distance = numeric_i32_argument(operation, 0)?;
            }
            "zone" => {
                self.zone = numeric_i32_argument(operation, 0)?;
                self.zone_was_set = true;
                self.zone_by_team = false;
                self.random_zone_value = None;
            }
            "set_zone_by_team" => {
                self.zone_by_team = true;
                self.team_zone_slot = self.assigned_slot;
                self.random_zone_value = None;
            }
            "set_zone_randomly" => {
                let value = random_zone_value.ok_or_else(|| {
                    invalid_request(
                        "RMSGEN3001",
                        "set-zone-randomly values were not resolved before setup",
                    )
                })?;
                self.zone_by_team = false;
                self.random_zone_value = Some(value);
            }
            "clumping_factor" => self.clumping_factor = numeric_i32_argument(operation, 0)?,
            "left_border" => {
                self.left_border = percentage_boundary(operation, 0, dimensions.width, false)?;
            }
            "right_border" => {
                self.right_border = percentage_boundary(operation, 0, dimensions.width, true)?;
            }
            "top_border" => {
                self.top_border = percentage_boundary(operation, 0, dimensions.height, false)?;
            }
            "bottom_border" => {
                self.bottom_border = percentage_boundary(operation, 0, dimensions.height, true)?;
            }
            "border_fuzziness" => self.border_fuzziness = numeric_i32_argument(operation, 0)?,
            "set_circular_base" => self.circular = true,
            "land_conformity" => self.conformity = truncated_i32_argument(operation, 0)?,
            "generate_mode" => self.generate_mode = truncated_i32_argument(operation, 0)?,
            "assign_to_player" => {
                self.assigned_slot = Some(u8_argument(operation, 0, "assigned player")?);
                self.object_placement_id = 1;
            }
            "assign_to" => {
                if !is_at_player_assignment(operation.arguments.first()) {
                    return Err(invalid_request(
                        "RMSGEN3001",
                        "the preview supports assign_to only with AT_PLAYER",
                    ));
                }
                let slot = u8_argument(operation, 1, "assigned player")?;
                self.assigned_slot = Some(slot);
                self.object_placement_id = i32::from(slot > 0);
            }
            "land_position" => {
                self.direct_position_percent = Some((
                    numeric_argument(operation, 0)?,
                    numeric_argument(operation, 1)?,
                ));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(
        &self,
        assigned_slot: Option<u8>,
        position: MapCoordinate,
        replicates_player_lands: bool,
        setup: &ExactSetupState,
    ) -> Result<ExactLandDescriptor, GenerationError> {
        let (target_tiles, conformity_target_tiles) = if let Some(percent) = self.land_percent {
            land_percent_descriptor_targets(
                self.target_tiles,
                percent,
                self.land_percent_divisor,
                replicates_player_lands,
            )?
        } else {
            (self.target_tiles, self.target_tiles)
        };
        let base_size = u16::try_from(self.base_size).map_err(|_| {
            invalid_request("RMSGEN3001", "land base size exceeds its fixed-width range")
        })?;
        let base_elevation = u8::try_from(self.base_elevation)
            .map(i16::from)
            .map_err(|_| {
                invalid_request(
                    "RMSGEN3001",
                    "the preview supports base_elevation only from 0 to 255",
                )
            })?;
        let other_zone_avoidance_distance = u16::try_from(self.other_zone_avoidance_distance)
            .map_err(|_| {
                invalid_request(
                    "RMSGEN3001",
                    "other-zone avoidance distance exceeds its fixed-width range",
                )
            })?;
        let zone = if let Some(random_zone_value) = self.random_zone_value {
            random_zone_value
        } else if self.zone_by_team {
            match self.team_zone_slot.filter(|slot| *slot > 1) {
                None => 2,
                Some(slot) => {
                    let representative = setup
                        .players
                        .iter()
                        .filter(|player| players_share_position_group(setup, slot, player.slot))
                        .map(|player| player.slot)
                        .min()
                        .ok_or_else(|| {
                            invalid_request("RMSGEN3001", "player team is unavailable")
                        })?;
                    representative.checked_add(1).ok_or_else(|| {
                        invalid_request(
                            "RMSGEN3001",
                            "team land zone exceeds its fixed-width range",
                        )
                    })?
                }
            }
        } else if replicates_player_lands && !self.zone_was_set {
            assigned_slot.ok_or_else(|| {
                invalid_request("RMSGEN3001", "player-land ownership is unavailable")
            })?
        } else {
            authored_descriptor_zone(self.zone, self.zone_was_set)?
        };
        Ok(ExactLandDescriptor {
            assigned_slot,
            object_placement_id: self.object_placement_id,
            target_tiles,
            conformity_target_tiles,
            terrain_id: self.terrain_id,
            authored_position: position,
            position,
            base_size,
            base_elevation,
            other_zone_avoidance_distance,
            minimum_placement_distance: self.minimum_placement_distance,
            zone,
            clumping_factor: self.clumping_factor,
            left_border: self.left_border,
            top_border: self.top_border,
            right_border: self.right_border,
            bottom_border: self.bottom_border,
            border_fuzziness: self.border_fuzziness,
            circular: self.circular,
            conformity: self.conformity,
            generate_mode: self.generate_mode,
            operation_index: self.operation_index,
        })
    }
}

fn translated_object_placement_id(authored: i32) -> Result<i32, GenerationError> {
    authored.checked_add(10).ok_or_else(|| {
        invalid_request(
            "RMSGEN3001",
            "object-placement land identity exceeds its fixed-width range",
        )
    })
}

fn authored_descriptor_zone(zone: i32, zone_was_set: bool) -> Result<u8, GenerationError> {
    if !zone_was_set {
        return Ok(0);
    }
    Ok((zone as u8).wrapping_add(10))
}

fn land_percent_target_tiles(
    map_tile_count: u32,
    percent: f32,
    placement_count: usize,
) -> Result<u32, GenerationError> {
    let percent = percent.min(100.0);
    let denominator = placement_count
        .checked_mul(100)
        .filter(|denominator| *denominator != 0)
        .ok_or_else(|| invalid_request("RMSGEN3001", "land percentage exceeds bounds"))?;
    let target = map_tile_count as f32 * percent / denominator as f32;
    if !target.is_finite() || target < 0.0 || target > u32::MAX as f32 {
        return Err(invalid_request(
            "RMSGEN3001",
            "land percentage exceeds bounds",
        ));
    }
    Ok(target.round() as u32)
}

fn land_percent_descriptor_targets(
    map_tile_count: u32,
    percent: f32,
    placement_count: usize,
    replicates_player_lands: bool,
) -> Result<(u32, u32), GenerationError> {
    let target_tiles = land_percent_target_tiles(map_tile_count, percent, placement_count)?;
    let conformity_target_tiles = if replicates_player_lands && percent >= 100.0 {
        map_tile_count
    } else {
        target_tiles
    };
    Ok((target_tiles, conformity_target_tiles))
}

fn base_tile_count(minimum_x: i32, minimum_y: i32, maximum_x: i32, maximum_y: i32) -> u32 {
    (maximum_x - minimum_x + 1).wrapping_mul(maximum_y - minimum_y + 1) as u32
}

fn initial_land_size_index(
    behavior_version: Option<i32>,
    descriptor_index: usize,
    zone: u8,
) -> Option<usize> {
    if behavior_version.unwrap_or(0) >= 1 {
        Some(descriptor_index)
    } else {
        let zone = usize::from(zone);
        (zone <= descriptor_index).then_some(zone)
    }
}

fn resolve_omitted_land_positions(
    descriptors: &mut [ExactLandDescriptor],
    dimensions: MapDimensions,
    rng: &mut RmsRandom,
) -> Result<(), GenerationError> {
    const MAXIMUM_CONFLICT_RETRIES: i32 = 990;
    const MAXIMUM_POSITION_DRAWS_PER_LAND: u64 = 2 * 64 * MAXIMUM_CONFLICT_RETRIES as u64;

    for current_index in 0..descriptors.len() {
        let authored_x = i32::from(descriptors[current_index].authored_position.x as i16);
        let authored_y = i32::from(descriptors[current_index].authored_position.y as i16);
        if authored_x >= 0 && authored_y >= 0 {
            continue;
        }

        let current = descriptors[current_index].clone();
        let base_size = i32::from(current.base_size);
        let available_width = (current.right_border - current.left_border - 2 * base_size).max(0);
        let available_height = (current.bottom_border - current.top_border - 2 * base_size).max(0);
        let (accepted_left, accepted_right, accepted_top, accepted_bottom) =
            if current.generate_mode == 1 {
                (-1, available_width, -1, available_height)
            } else {
                let middle_left = available_width / 3;
                let middle_top = available_height / 3;
                (
                    middle_left,
                    available_width - middle_left,
                    middle_top,
                    available_height - middle_top,
                )
            };
        let mut conflict_retries = MAXIMUM_CONFLICT_RETRIES;
        let mut position_draws = 0_u64;

        loop {
            position_draws = position_draws.saturating_add(2);
            if position_draws > MAXIMUM_POSITION_DRAWS_PER_LAND {
                return Err(invalid_request(
                    "RMSGEN3002",
                    "neutral land positioning exhausted its bounded work budget",
                ));
            }
            let candidate_x = rng.bounded(available_width as u32).result as i32;
            let candidate_y = rng.bounded(available_height as u32).result as i32;

            let x_is_middle = candidate_x >= accepted_left && candidate_x <= accepted_right;
            let y_is_middle = candidate_y >= accepted_top && candidate_y <= accepted_bottom;
            if !x_is_middle && !y_is_middle {
                continue;
            }

            let effective_x = candidate_x + base_size + current.left_border;
            let effective_y = candidate_y + base_size + current.top_border;
            let mut conflicts = false;
            for (other_index, other) in descriptors.iter().enumerate() {
                if other_index == current_index {
                    continue;
                }
                let other_x = i32::from(other.position.x as i16);
                let other_y = i32::from(other.position.y as i16);
                if other_x < 0 || effective_y < 0 {
                    continue;
                }
                let minimum_distance = if current.minimum_placement_distance < 0 {
                    let selected_avoidance = if current.other_zone_avoidance_distance
                        <= other.other_zone_avoidance_distance
                    {
                        other.other_zone_avoidance_distance
                    } else {
                        current.other_zone_avoidance_distance
                    };
                    i32::from(selected_avoidance) + i32::from(other.base_size) + base_size
                } else {
                    current.minimum_placement_distance
                };
                if effective_x.abs_diff(other_x) < minimum_distance as u32
                    && effective_y.abs_diff(other_y) < minimum_distance as u32
                {
                    conflicts = true;
                    break;
                }
            }

            if !conflicts {
                descriptors[current_index].position = MapCoordinate {
                    x: u16::try_from(effective_x).map_err(|_| {
                        invalid_request(
                            "RMSGEN3001",
                            "resolved neutral land x coordinate exceeds its fixed-width range",
                        )
                    })?,
                    y: u16::try_from(effective_y).map_err(|_| {
                        invalid_request(
                            "RMSGEN3001",
                            "resolved neutral land y coordinate exceeds its fixed-width range",
                        )
                    })?,
                };
                break;
            }

            conflict_retries -= 1;
            if conflict_retries <= 0 {
                descriptors[current_index].position = MapCoordinate {
                    x: dimensions.width / 2,
                    y: dimensions.height / 2,
                };
                break;
            }
        }
    }
    Ok(())
}

fn numeric_argument(operation: &SemanticOperation, index: usize) -> Result<f32, GenerationError> {
    let value = operation
        .arguments
        .get(index)
        .ok_or_else(|| invalid_request("RMSGEN3001", "land operation is missing an argument"))?
        .value
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN3001", "land operation argument is not numeric"))?;
    if !value.is_finite() {
        return Err(invalid_request(
            "RMSGEN3001",
            "land argument must be finite",
        ));
    }
    Ok(value)
}

fn numeric_i32_argument(
    operation: &SemanticOperation,
    index: usize,
) -> Result<i32, GenerationError> {
    let value = numeric_argument(operation, index)?;
    if value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request("RMSGEN3001", "land argument exceeds i32"));
    }
    Ok(value.round() as i32)
}

fn truncated_i32_argument(
    operation: &SemanticOperation,
    index: usize,
) -> Result<i32, GenerationError> {
    let value = numeric_argument(operation, index)?;
    if value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request("RMSGEN3001", "land argument exceeds i32"));
    }
    Ok(value.trunc() as i32)
}

fn nonnegative_u32(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u32, GenerationError> {
    u32::try_from(numeric_i32_argument(operation, index)?)
        .map_err(|_| invalid_request("RMSGEN3001", &format!("{description} cannot be negative")))
}

fn u8_argument(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u8, GenerationError> {
    u8::try_from(numeric_i32_argument(operation, index)?).map_err(|_| {
        invalid_request(
            "RMSGEN3001",
            &format!("{description} exceeds its byte range"),
        )
    })
}

fn percentage_boundary(
    operation: &SemanticOperation,
    index: usize,
    dimension: u16,
    from_far_edge: bool,
) -> Result<i32, GenerationError> {
    let percent = numeric_argument(operation, index)?;
    if !percent.is_finite() {
        return Err(invalid_request(
            "RMSGEN3001",
            "land border percentage is not finite",
        ));
    }
    native_border_tile(percent, dimension, from_far_edge)
        .ok_or_else(|| invalid_request("RMSGEN3001", "land border exceeds its fixed-width range"))
}

pub(crate) fn native_border_tile(percent: f32, dimension: u16, from_far_edge: bool) -> Option<i32> {
    let distance = f32::from(dimension) * percent / 100.0;
    let boundary = if from_far_edge {
        f32::from(dimension) - distance
    } else {
        distance
    };
    if !boundary.is_finite() || boundary < i32::MIN as f32 || boundary > i32::MAX as f32 {
        return None;
    }
    Some(boundary.round() as i32)
}

fn growth_radius(descriptor: &ExactLandDescriptor) -> i32 {
    cleanup_radius(descriptor)
}

fn cleanup_radius(descriptor: &ExactLandDescriptor) -> i32 {
    if descriptor.conformity_target_tiles == 0 {
        return i32::from(descriptor.base_size) / 2;
    }
    let target = descriptor.conformity_target_tiles as f32;
    let approximate = if descriptor.circular {
        (target / std::f32::consts::PI).sqrt().trunc() as i32
    } else {
        target.sqrt().trunc() as i32
    };
    let target = descriptor.conformity_target_tiles.min(i32::MAX as u32) as i32;
    let base = i32::from(descriptor.base_size);
    let median = target.saturating_add(approximate).saturating_add(base)
        - target.min(approximate).min(base)
        - target.max(approximate).max(base);
    median / 2
}

fn conforms(
    descriptor: &ExactLandDescriptor,
    x: i32,
    y: i32,
    radius: i32,
    dimensions: MapDimensions,
    rng: &mut RmsRandom,
    leading_rng_samples: &mut Vec<ExactLandRngSample>,
) -> bool {
    let draw = land_bounded(rng, 100, leading_rng_samples);
    if draw as i32 > descriptor.conformity {
        return true;
    }
    let center_x = i32::from(descriptor.position.x);
    let center_y = i32::from(descriptor.position.y);
    if descriptor.circular {
        let delta_x = x.saturating_sub(center_x);
        let delta_y = y.saturating_sub(center_y);
        return delta_x
            .saturating_mul(delta_x)
            .saturating_add(delta_y.saturating_mul(delta_y))
            <= radius.saturating_mul(radius);
    }
    let minimum_x = center_x.saturating_sub(radius).max(0);
    let maximum_x = center_x
        .saturating_add(radius)
        .min(i32::from(dimensions.width) - 1);
    let minimum_y = center_y.saturating_sub(radius).max(0);
    let maximum_y = center_y
        .saturating_add(radius)
        .min(i32::from(dimensions.height) - 1);
    x >= minimum_x && x <= maximum_x && y >= minimum_y && y <= maximum_y
}

fn land_bounded(
    rng: &mut RmsRandom,
    upper_exclusive: u32,
    leading_rng_samples: &mut Vec<ExactLandRngSample>,
) -> u32 {
    let result = rng.bounded(upper_exclusive).result;
    if leading_rng_samples.len() < MAXIMUM_LAND_LEADING_RNG_SAMPLES {
        leading_rng_samples.push(ExactLandRngSample {
            upper_exclusive,
            result,
        });
    }
    result
}

fn terrain_and_zone_cost(
    descriptors: &[ExactLandDescriptor],
    descriptor_index: usize,
    x: i32,
    y: i32,
    dimensions: MapDimensions,
    search_zone: &[u8],
) -> u8 {
    let descriptor = &descriptors[usize::from(descriptor_index as u8)];
    let width = usize::from(dimensions.width);
    let maximum_x = i32::from(dimensions.width);
    let maximum_y = i32::from(dimensions.height);
    let index = tile_index(width, x, y);
    if search_zone[index] != SEARCH_UNOCCUPIED {
        return 0;
    }
    let area = i32::from(descriptor.other_zone_avoidance_distance);
    let mut count = 0_i32;
    let offset = land_avoidance_offset(area);
    let mut minimum_x = x - offset;
    let mut maximum_scan_x = x + offset;
    for current_y in y.saturating_sub(area.max(2))..=y.saturating_add(area.max(2)) {
        if current_y < 0 {
            if current_y >= y {
                count += 3;
            }
        } else if current_y >= maximum_y {
            if current_y <= y {
                count += 3;
            }
        } else {
            for current_x in minimum_x..=maximum_scan_x {
                if current_x < 0 {
                    if current_x >= x {
                        count += 1;
                    }
                    continue;
                }
                if current_x >= maximum_x {
                    if current_x <= x {
                        count += 1;
                    }
                    continue;
                }
                let zone = search_zone[tile_index(width, current_x, current_y)];
                if zone == descriptor.zone {
                    if current_y >= y - 2
                        && current_y <= y + 2
                        && current_x >= x - 2
                        && current_x <= x + 2
                    {
                        count += 1;
                    }
                } else if zone < SEARCH_UNOCCUPIED
                    && current_x >= x - area
                    && current_x <= x + area
                    && current_y >= y - area
                    && current_y <= y + area
                {
                    return 0;
                }
            }
        }

        if current_y < y - offset || current_y > y + offset {
            minimum_x -= 1;
            maximum_scan_x += 1;
        }
    }
    count.clamp(0, i32::from(u8::MAX)) as u8
}

fn land_avoidance_offset(area: i32) -> i32 {
    ((f64::from(area) * f64::from_bits(LAND_AVOIDANCE_OFFSET_SCALE_BITS)).trunc() as i32).max(2)
}

fn border_chance(
    descriptor: &ExactLandDescriptor,
    x: i32,
    y: i32,
    dimensions: MapDimensions,
) -> i32 {
    if descriptor.border_fuzziness == 0 {
        return 0;
    }
    let left = descriptor.left_border;
    let right = descriptor.right_border;
    let top = descriptor.top_border;
    let bottom = descriptor.bottom_border;
    let horizontal = 0.max((left - x).max(x - right));

    let horizontal_span_quarter = (right - left) / 4;
    let right_projection = (horizontal_span_quarter.min(i32::from(dimensions.width) - right))
        .saturating_add(x - right);
    let left_projection = horizontal_span_quarter.min(left).saturating_add(left - x);
    let corner_projection = right_projection.max(left_projection);
    let vertical_adjustment = if corner_projection > 0 {
        corner_projection.min((bottom - top) / 3)
    } else {
        0
    };
    let vertical = 0.max(
        top.saturating_sub(y)
            .saturating_add(vertical_adjustment)
            .max(y.saturating_sub(bottom).saturating_add(vertical_adjustment)),
    );
    let chance = descriptor
        .border_fuzziness
        .saturating_mul(horizontal.saturating_add(vertical));
    if chance >= 100 { 101 } else { chance }
}

fn tile_index(width: usize, x: i32, y: i32) -> usize {
    y as usize * width + x as usize
}

fn tile_coordinate(width: usize, index: usize) -> (i32, i32) {
    ((index % width) as i32, (index / width) as i32)
}

fn paint_accepted_growth_tile(
    terrain: &mut [TerrainId],
    elevation: &mut [i16],
    layer: &mut [u16],
    index: usize,
    descriptor: &ExactLandDescriptor,
) {
    terrain[index] = descriptor.terrain_id;
    elevation[index] = descriptor.base_elevation;
    layer[index] = u16::MAX;
}

fn resolve_land_base_layer(
    semantic_program: &SemanticProgram,
    content: CompatibleContentView<'_>,
) -> Result<Option<u16>, GenerationError> {
    let mut layer = Some(TerrainId(0));
    for operation in semantic_program.operations.iter().filter(|operation| {
        operation.accepted_by_target_parser()
            && operation.section == "land_generation"
            && operation.depth == 0
    }) {
        match operation.name.as_str() {
            "base_terrain" => layer = None,
            "base_layer" => {
                layer = Some(exact_terrain_argument(operation, 0, content, "RMSGEN3001")?)
            }
            _ => {}
        }
    }
    Ok(layer
        .filter(|terrain| content.terrain(*terrain).is_some())
        .map(|terrain| terrain.0 as u16))
}

fn native_circular_terrain_contains(delta_x: i32, delta_y: i32, radius: u16) -> bool {
    let delta_x = i32::from(delta_x as i16);
    let delta_y = i32::from(delta_y as i16);
    let radius = i32::from(radius as i16);
    let radius_squared = i32::from(radius.wrapping_mul(radius) as i16);
    delta_x.wrapping_mul(delta_x) + delta_y.wrapping_mul(delta_y) <= radius_squared
}
