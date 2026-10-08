use super::*;

const NO_NODE: u32 = u32::MAX;

pub(super) struct CandidateQueue {
    pub(super) dimensions: MapDimensions,
    pub(super) present: Vec<bool>,
    previous: Vec<u32>,
    next: Vec<u32>,
    head: Option<usize>,
    tail: Option<usize>,
    touched: Vec<u32>,
    len: usize,
}

struct QueueBuffers {
    present: Vec<bool>,
    previous: Vec<u32>,
    next: Vec<u32>,
    touched: Vec<u32>,
}

#[derive(Default)]
struct QueuePool {
    scopes: usize,
    buffers: Vec<QueueBuffers>,
}

const POOLED_QUEUES: usize = 4;

thread_local! {
    static QUEUE_POOL: std::cell::RefCell<QueuePool> =
        std::cell::RefCell::new(QueuePool::default());
}

pub(super) struct QueueBufferScope(());

impl QueueBufferScope {
    pub(super) fn enter() -> Self {
        QUEUE_POOL.with(|pool| pool.borrow_mut().scopes += 1);
        Self(())
    }
}

impl Drop for QueueBufferScope {
    fn drop(&mut self) {
        let _ = QUEUE_POOL.try_with(|pool| {
            if let Ok(mut pool) = pool.try_borrow_mut() {
                pool.scopes = pool.scopes.saturating_sub(1);
                if pool.scopes == 0 {
                    pool.buffers.clear();
                }
            }
        });
    }
}

impl QueueBuffers {
    fn acquire(tile_count: usize) -> Self {
        let reused = QUEUE_POOL
            .try_with(|pool| {
                let mut pool = pool.try_borrow_mut().ok()?;
                let position = pool
                    .buffers
                    .iter()
                    .position(|buffers| buffers.present.len() == tile_count)?;
                Some(pool.buffers.swap_remove(position))
            })
            .ok()
            .flatten();
        reused.unwrap_or_else(|| Self {
            present: vec![false; tile_count],
            previous: vec![NO_NODE; tile_count],
            next: vec![NO_NODE; tile_count],
            touched: Vec::new(),
        })
    }
}

impl Drop for CandidateQueue {
    fn drop(&mut self) {
        let mut buffers = QueueBuffers {
            present: std::mem::take(&mut self.present),
            previous: std::mem::take(&mut self.previous),
            next: std::mem::take(&mut self.next),
            touched: std::mem::take(&mut self.touched),
        };
        let _ = QUEUE_POOL.try_with(|pool| {
            let Ok(mut pool) = pool.try_borrow_mut() else {
                return;
            };
            if pool.scopes == 0 || pool.buffers.len() >= POOLED_QUEUES {
                return;
            }
            for &tile in &buffers.touched {
                buffers.present[tile as usize] = false;
            }
            buffers.touched.clear();
            pool.buffers.push(buffers);
        });
    }
}

fn link(index: Option<usize>) -> u32 {
    index.map_or(NO_NODE, |index| index as u32)
}

fn node(link: u32) -> Option<usize> {
    (link != NO_NODE).then_some(link as usize)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ConnectedCandidate {
    pub(super) coordinate: MapCoordinate,
    pub(super) component: i32,
}

#[derive(Debug, Default)]
pub(super) struct ConnectedCandidatePool {
    pub(super) next_component: i32,
    pub(super) candidates: Vec<ConnectedCandidate>,
}

impl ConnectedCandidatePool {
    pub(super) fn select(
        &mut self,
        candidate: MapCoordinate,
        minimum_connected_tiles: i32,
        find_closest: bool,
        rng: &mut RmsRandom,
    ) -> Option<MapCoordinate> {
        if minimum_connected_tiles <= 1 {
            return Some(candidate);
        }

        let mut neighboring_components = [0_i32; 4];
        let mut neighboring_count = 0_usize;
        for retained in &self.candidates {
            if !cardinally_adjacent(retained.coordinate, candidate)
                || neighboring_components[..neighboring_count].contains(&retained.component)
            {
                continue;
            }
            neighboring_components[neighboring_count] = retained.component;
            neighboring_count += 1;
        }
        neighboring_components[..neighboring_count].sort_unstable();

        if neighboring_count == 0 {
            self.next_component = self.next_component.wrapping_add(1);
            self.candidates.push(ConnectedCandidate {
                coordinate: candidate,
                component: self.next_component,
            });
            return None;
        }

        let component = neighboring_components[0];
        let mut connected_count = 1_u32;
        for retained in &mut self.candidates {
            if neighboring_components[..neighboring_count].contains(&retained.component) {
                retained.component = component;
                connected_count = connected_count.saturating_add(1);
            }
        }
        if connected_count < minimum_connected_tiles as u32 {
            self.candidates.push(ConnectedCandidate {
                coordinate: candidate,
                component,
            });
            return None;
        }

        let selected = if find_closest {
            0
        } else {
            rng.bounded(connected_count).result
        };
        let mut matching_ordinal = 0_u32;
        for index in 0..self.candidates.len() {
            if self.candidates[index].component != component {
                continue;
            }
            if matching_ordinal == selected {
                return Some(self.candidates.remove(index).coordinate);
            }
            matching_ordinal += 1;
        }
        Some(candidate)
    }

    pub(super) fn remove_group_square(&mut self, center: MapCoordinate, radius: u16) {
        self.candidates.retain(|candidate| {
            candidate.coordinate.x.abs_diff(center.x) > radius
                || candidate.coordinate.y.abs_diff(center.y) > radius
        });
    }
}

pub(super) fn cardinally_adjacent(left: MapCoordinate, right: MapCoordinate) -> bool {
    (left.x == right.x && left.y.abs_diff(right.y) == 1)
        || (left.y == right.y && left.x.abs_diff(right.x) == 1)
}

#[derive(Clone, Copy)]
pub(super) struct CandidateWindow {
    pub(super) minimum_x: u16,
    pub(super) maximum_x: u16,
    pub(super) minimum_y: u16,
    pub(super) maximum_y: u16,
}

impl CandidateWindow {
    pub(super) fn for_descriptor(
        descriptor: &ExactObjectDescriptor,
        player: Option<(u8, MapCoordinate)>,
        dimensions: MapDimensions,
    ) -> Self {
        let minimum_x = descriptor
            .minimum_distance_to_map_edge
            .min(dimensions.width - 1);
        let maximum_x =
            (dimensions.width - 1).saturating_sub(descriptor.minimum_distance_to_map_edge);
        let minimum_y = descriptor
            .minimum_distance_to_map_edge
            .min(dimensions.height - 1);
        let maximum_y =
            (dimensions.height - 1).saturating_sub(descriptor.minimum_distance_to_map_edge);
        if let Some(radius) = descriptor.maximum_distance_to_players
            && player.is_some()
        {
            let center = object_placement_center(player, dimensions);
            return Self {
                minimum_x: center.x.saturating_sub(radius).max(minimum_x),
                maximum_x: center.x.saturating_add(radius).min(maximum_x),
                minimum_y: center.y.saturating_sub(radius).max(minimum_y),
                maximum_y: center.y.saturating_add(radius).min(maximum_y),
            };
        }
        Self {
            minimum_x,
            maximum_x,
            minimum_y,
            maximum_y,
        }
    }

    pub(super) fn shuffle_shape(self) -> Option<(u32, u32, u32)> {
        let x_range = u32::from(
            self.maximum_x
                .saturating_sub(self.minimum_x)
                .saturating_sub(1),
        );
        let y_range = u32::from(
            self.maximum_y
                .saturating_sub(self.minimum_y)
                .saturating_sub(1),
        );
        if x_range <= 1 || y_range <= 1 {
            return None;
        }
        let iterations = u32::try_from(u64::from(x_range) * u64::from(y_range) / 4).ok()?;
        Some((x_range, y_range, iterations))
    }
}

pub(super) fn closest_priority_inner_radius(descriptor: &ExactObjectDescriptor) -> i32 {
    if descriptor.minimum_player_distance_command {
        i32::from(descriptor.minimum_distance_to_players)
    } else {
        -1
    }
}

impl CandidateQueue {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new_with_shuffle_predicate(
        dimensions: MapDimensions,
        window: CandidateWindow,
        candidates: Vec<usize>,
        reverse_scan_order: bool,
        shuffle: bool,
        rng: &mut RmsRandom,
        cancellation: &dyn CancellationToken,
        accepts: impl FnMut(bool, MapCoordinate, &mut RmsRandom) -> Result<bool, GenerationError>,
    ) -> Result<(Self, u32), GenerationError> {
        let tile_count = dimensions.tile_count()?;
        let buffers = QueueBuffers::acquire(tile_count);
        let mut queue = Self {
            dimensions,
            present: buffers.present,
            previous: buffers.previous,
            next: buffers.next,
            head: None,
            tail: None,
            touched: buffers.touched,
            len: 0,
        };
        for index in candidates {
            queue.mark_present(index);
            if reverse_scan_order {
                queue.push_front(index);
            } else {
                queue.push_back(index);
            }
        }
        if !shuffle || dimensions.width < 3 || dimensions.height < 3 {
            return Ok((queue, 0));
        }
        let Some((_, _, iterations)) = window.shuffle_shape() else {
            return Ok((queue, 0));
        };
        if u64::from(iterations) > MAXIMUM_CANDIDATE_WORK {
            return Err(GenerationError::ResourceLimit {
                resource: "object candidate shuffle".to_owned(),
                limit: MAXIMUM_CANDIDATE_WORK,
            });
        }
        queue.shuffle(window, rng, cancellation, accepts)?;
        Ok((queue, iterations))
    }

    pub(super) fn shuffle(
        &mut self,
        window: CandidateWindow,
        rng: &mut RmsRandom,
        cancellation: &dyn CancellationToken,
        mut accepts: impl FnMut(bool, MapCoordinate, &mut RmsRandom) -> Result<bool, GenerationError>,
    ) -> Result<u32, GenerationError> {
        if self.dimensions.width < 3 || self.dimensions.height < 3 {
            return Ok(0);
        }
        let Some((x_range, y_range, iterations)) = window.shuffle_shape() else {
            return Ok(0);
        };
        if u64::from(iterations) > MAXIMUM_CANDIDATE_WORK {
            return Err(GenerationError::ResourceLimit {
                resource: "object candidate shuffle".to_owned(),
                limit: MAXIMUM_CANDIDATE_WORK,
            });
        }
        for iteration in 0..iterations {
            if iteration % 1024 == 0 {
                cancellation_checkpoint(
                    cancellation,
                    GenerationStage::Objects,
                    u64::from(iteration),
                )?;
            }
            let x = window.minimum_x + rng.bounded(x_range).result as u16;
            let y = window.minimum_y + rng.bounded(y_range).result as u16;
            let coordinate = MapCoordinate { x, y };
            let index = usize::from(y) * usize::from(self.dimensions.width) + usize::from(x);
            let present = self.present[index];
            if accepts(present, coordinate, rng)? {
                if present {
                    self.move_to_front(index);
                } else {
                    self.mark_present(index);
                    self.push_front(index);
                }
            }
        }
        Ok(iterations)
    }

    fn mark_present(&mut self, index: usize) {
        self.present[index] = true;
        self.touched.push(index as u32);
    }

    pub(super) fn push_front(&mut self, index: usize) {
        self.len += 1;
        self.previous[index] = NO_NODE;
        self.next[index] = link(self.head);
        if let Some(head) = self.head {
            self.previous[head] = index as u32;
        } else {
            self.tail = Some(index);
        }
        self.head = Some(index);
    }

    pub(super) fn push_back(&mut self, index: usize) {
        self.len += 1;
        self.next[index] = NO_NODE;
        self.previous[index] = link(self.tail);
        if let Some(tail) = self.tail {
            self.next[tail] = index as u32;
        } else {
            self.head = Some(index);
        }
        self.tail = Some(index);
    }

    pub(super) fn move_to_front(&mut self, index: usize) {
        if self.head == Some(index) {
            return;
        }
        let previous = node(self.previous[index]);
        let next = node(self.next[index]);
        if let Some(previous) = previous {
            self.next[previous] = link(next);
        }
        if let Some(next) = next {
            self.previous[next] = link(previous);
        } else {
            self.tail = previous;
        }
        self.previous[index] = NO_NODE;
        self.next[index] = link(self.head);
        if let Some(head) = self.head {
            self.previous[head] = index as u32;
        }
        self.head = Some(index);
    }

    pub(super) fn prioritize_closest_to(
        &mut self,
        priority: CandidatePriority,
        anchor: MapCoordinate,
        minimum_distance: i32,
        circular: bool,
        shuffle_equal_distances: bool,
        rng: &mut RmsRandom,
    ) -> u32 {
        use crate::placement_oracle::{OracleCheck, PlacementCheckMode};
        let arguments = (
            priority,
            anchor,
            minimum_distance,
            circular,
            shuffle_equal_distances,
        );
        match crate::placement_oracle::mode() {
            PlacementCheckMode::Accelerated => self.prioritize_in_place(arguments, rng),
            PlacementCheckMode::Reference => self.prioritize_by_pops(arguments, rng),
            PlacementCheckMode::Differential => {
                let mut copy = Self::from_order(self.dimensions, &self.linked_order());
                let mut copy_rng = rng.clone();
                let accelerated = copy.prioritize_in_place(arguments, &mut copy_rng);
                let reference = self.prioritize_by_pops(arguments, rng);
                let outcome = |queue: &Self, rng: &RmsRandom, iterations: u32| {
                    let order = queue.linked_order();
                    let present = order.iter().all(|&index| queue.present[index])
                        && queue.present.iter().filter(|present| **present).count() == order.len();
                    (order, queue.len, present, rng.state(), iterations)
                };
                crate::placement_oracle::compare(
                    OracleCheck::ClosestQueue,
                    &outcome(self, rng, reference),
                    &outcome(&copy, &copy_rng, accelerated),
                    || format!("closest-first queue of {} candidates", self.len),
                );
                reference
            }
        }
    }

    fn closest_key(
        &self,
        (priority, anchor, minimum_distance, circular, _): ClosestArguments,
        coordinate: MapCoordinate,
    ) -> Option<(u32, ExactObjectDistancePreference)> {
        let squared_distance = |point: MapCoordinate, reference: MapCoordinate| {
            let dx = u32::from(point.x.abs_diff(reference.x));
            let dy = u32::from(point.y.abs_diff(reference.y));
            dx * dx + dy * dy
        };
        let circular_filter = circular && !matches!(priority, CandidatePriority::MapEdge(_));
        let minimum_key = if circular_filter {
            minimum_distance
        } else {
            minimum_distance.wrapping_mul(minimum_distance)
        };
        let squared = squared_distance(coordinate, anchor);
        let filter_distance = if circular_filter {
            circular_priority_distance(squared)
        } else {
            squared
        };
        if i32::try_from(filter_distance).unwrap_or(i32::MAX) < minimum_key {
            return None;
        }
        Some(match priority {
            CandidatePriority::Anchor => (filter_distance, ExactObjectDistancePreference::Nearest),
            CandidatePriority::MapCenter(preference) => {
                let midpoint = self.dimensions.width / 2;
                let squared = squared_distance(
                    coordinate,
                    MapCoordinate {
                        x: midpoint,
                        y: midpoint,
                    },
                );
                let distance = if circular {
                    circular_priority_distance(squared)
                } else {
                    squared
                };
                (distance, preference)
            }
            CandidatePriority::MapEdge(preference) => (
                u32::from(
                    coordinate
                        .x
                        .min(self.dimensions.width - 1 - coordinate.x)
                        .min(coordinate.y)
                        .min(self.dimensions.height - 1 - coordinate.y),
                ),
                preference,
            ),
        })
    }

    fn prioritize_by_pops(&mut self, arguments: ClosestArguments, rng: &mut RmsRandom) -> u32 {
        let shuffle_equal_distances = arguments.4;
        let mut ordered = Vec::with_capacity(self.len);
        while let Some(coordinate) = self.pop_front() {
            let Some((distance, preference)) = self.closest_key(arguments, coordinate) else {
                continue;
            };
            let key = match preference {
                ExactObjectDistancePreference::Nearest => i64::from(distance),
                ExactObjectDistancePreference::Farthest => -i64::from(distance),
            };
            let index = usize::from(coordinate.y) * usize::from(self.dimensions.width)
                + usize::from(coordinate.x);
            ordered.push((key, ordered.len(), index));
        }
        let mut ordered = placement_index::decide(
            crate::placement_oracle::OracleCheck::ClosestOrder,
            |accelerated| {
                if accelerated {
                    closest_order_by_radix(&ordered)
                } else {
                    closest_order_by_comparison(&ordered)
                }
            },
            || format!("closest-first order of {} candidates", ordered.len()),
        );
        let mut shuffle_iterations = 0_u32;
        if shuffle_equal_distances {
            let mut start = 0_usize;
            while start < ordered.len() {
                let distance = ordered[start].0;
                let mut end = start + 1;
                while end < ordered.len() && ordered[end].0 == distance {
                    end += 1;
                }
                shuffle_iterations = shuffle_iterations
                    .saturating_add(native_shuffle(&mut ordered[start..end], rng));
                start = end;
            }
        }
        for (_, _, index) in ordered {
            self.mark_present(index);
            self.push_front(index);
        }
        shuffle_iterations
    }

    fn prioritize_in_place(&mut self, arguments: ClosestArguments, rng: &mut RmsRandom) -> u32 {
        let shuffle_equal_distances = arguments.4;
        let mut tiles: Vec<u32> = Vec::with_capacity(self.len);
        let mut distances: Vec<u32> = Vec::with_capacity(self.len);
        let mut farthest = None;
        let width = usize::from(self.dimensions.width);
        let mut current = self.head;
        while let Some(index) = current {
            current = node(self.next[index]);
            let coordinate = MapCoordinate {
                x: (index % width) as u16,
                y: (index / width) as u16,
            };
            let Some((distance, preference)) = self.closest_key(arguments, coordinate) else {
                self.present[index] = false;
                continue;
            };
            farthest.get_or_insert(preference == ExactObjectDistancePreference::Farthest);
            tiles.push(index as u32);
            distances.push(distance);
        }
        let farthest = farthest.unwrap_or(false);
        let maximum = distances.iter().copied().max().unwrap_or(0);
        let mut keys: Vec<u64> = distances
            .iter()
            .enumerate()
            .map(|(ordinal, &distance)| {
                let rank = if farthest {
                    distance
                } else {
                    maximum - distance
                };
                (u64::from(rank) << 32) | ordinal as u64
            })
            .collect();
        if crate::placement_oracle::fault()
            == crate::placement_oracle::AcceleratorFault::ClosestQueueReversesTies
        {
            keys.reverse();
        }
        sort_rank_keys(&mut keys, u32::BITS - maximum.leading_zeros());
        let mut ordered: Vec<u32> = keys
            .iter()
            .map(|key| tiles[(key & u64::from(u32::MAX)) as usize])
            .collect();
        let mut shuffle_iterations = 0_u32;
        if shuffle_equal_distances {
            let mut start = 0_usize;
            while start < ordered.len() {
                let rank = keys[start] >> 32;
                let mut end = start + 1;
                while end < ordered.len() && keys[end] >> 32 == rank {
                    end += 1;
                }
                shuffle_iterations = shuffle_iterations
                    .saturating_add(native_shuffle(&mut ordered[start..end], rng));
                start = end;
            }
        }
        self.len = ordered.len();
        self.head = ordered.last().map(|&index| index as usize);
        self.tail = ordered.first().map(|&index| index as usize);
        for (position, &index) in ordered.iter().enumerate() {
            let index = index as usize;
            self.next[index] = if position == 0 {
                NO_NODE
            } else {
                ordered[position - 1]
            };
            self.previous[index] = ordered.get(position + 1).copied().unwrap_or(NO_NODE);
        }
        shuffle_iterations
    }

    pub(super) fn pop_front(&mut self) -> Option<MapCoordinate> {
        let index = self.head?;
        self.len = self.len.saturating_sub(1);
        self.head = node(self.next[index]);
        if let Some(head) = self.head {
            self.previous[head] = NO_NODE;
        } else {
            self.tail = None;
        }
        self.present[index] = false;
        self.previous[index] = NO_NODE;
        self.next[index] = NO_NODE;
        Some(MapCoordinate {
            x: (index % usize::from(self.dimensions.width)) as u16,
            y: (index / usize::from(self.dimensions.width)) as u16,
        })
    }

    pub(super) fn is_empty(&self) -> bool {
        self.head.is_none()
    }

    pub(super) fn remove_square(&mut self, center: MapCoordinate, radius: u16) {
        let minimum_x = center.x.saturating_sub(radius);
        let maximum_x = center
            .x
            .saturating_add(radius)
            .min(self.dimensions.width - 1);
        let minimum_y = center.y.saturating_sub(radius);
        let maximum_y = center
            .y
            .saturating_add(radius)
            .min(self.dimensions.height - 1);
        for y in minimum_y..=maximum_y {
            for x in minimum_x..=maximum_x {
                let index = usize::from(y) * usize::from(self.dimensions.width) + usize::from(x);
                self.remove(index);
            }
        }
    }

    pub(super) fn remove(&mut self, index: usize) {
        if !self.present[index] {
            return;
        }
        self.len = self.len.saturating_sub(1);
        let previous = node(self.previous[index]);
        let next = node(self.next[index]);
        if let Some(previous) = previous {
            self.next[previous] = link(next);
        } else {
            self.head = next;
        }
        if let Some(next) = next {
            self.previous[next] = link(previous);
        } else {
            self.tail = previous;
        }
        self.present[index] = false;
        self.previous[index] = NO_NODE;
        self.next[index] = NO_NODE;
    }

    pub(super) fn detach_present_from(&self, parent: &mut Self) {
        debug_assert_eq!(self.dimensions, parent.dimensions);
        let mut current = self.head;
        while let Some(index) = current {
            parent.remove(index);
            current = node(self.next[index]);
        }
    }
}

fn closest_order_by_comparison(entries: &[(i64, usize, usize)]) -> Vec<(i64, usize, usize)> {
    let mut ordered = entries.to_vec();
    ordered.sort_unstable_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    ordered
}

fn closest_order_by_radix(entries: &[(i64, usize, usize)]) -> Vec<(i64, usize, usize)> {
    let farthest = entries.iter().any(|entry| entry.0 < 0);
    let mixed = farthest && entries.iter().any(|entry| entry.0 > 0);
    let maximum = entries
        .iter()
        .map(|entry| entry.0.unsigned_abs())
        .max()
        .unwrap_or(0);
    if mixed || maximum > u64::from(u32::MAX) || entries.len() > u32::MAX as usize {
        return closest_order_by_comparison(entries);
    }
    let rank = |entry: &(i64, usize, usize)| {
        let distance = entry.0.unsigned_abs();
        if farthest {
            distance
        } else {
            maximum - distance
        }
    };
    let reverse_ties = crate::placement_oracle::fault()
        == crate::placement_oracle::AcceleratorFault::ClosestOrderReversesTies;
    let pack =
        |(position, entry): (usize, &(i64, usize, usize))| (rank(entry) << 32) | position as u64;
    let mut keys: Vec<u64> = if reverse_ties {
        entries.iter().enumerate().rev().map(pack).collect()
    } else {
        entries.iter().enumerate().map(pack).collect()
    };
    sort_rank_keys(&mut keys, u64::BITS - maximum.leading_zeros());
    keys.iter()
        .map(|key| entries[(key & u64::from(u32::MAX)) as usize])
        .collect()
}

type ClosestArguments = (CandidatePriority, MapCoordinate, i32, bool, bool);

fn sort_rank_keys(keys: &mut Vec<u64>, rank_bits: u32) {
    const DIGIT_BITS: u32 = 11;
    let mut scratch = vec![0_u64; keys.len()];
    let mut shift = 32;
    while shift < 32 + rank_bits {
        let digit = |key: u64| ((key >> shift) & ((1 << DIGIT_BITS) - 1)) as usize;
        let mut starts = [0_u32; 1 << DIGIT_BITS];
        for &key in keys.iter() {
            starts[digit(key)] += 1;
        }
        let mut position = 0_u32;
        for start in &mut starts {
            let size = *start;
            *start = position;
            position += size;
        }
        for &key in keys.iter() {
            let slot = &mut starts[digit(key)];
            scratch[*slot as usize] = key;
            *slot += 1;
        }
        std::mem::swap(keys, &mut scratch);
        shift += DIGIT_BITS;
    }
}

pub(super) fn circular_priority_distance(squared: u32) -> u32 {
    (squared as f32).sqrt() as u32
}

pub(super) fn native_shuffle<T>(values: &mut [T], rng: &mut RmsRandom) -> u32 {
    for position in 1..values.len() {
        let range = u32::try_from(position + 1)
            .expect("an exact object candidate run fits in the u32 map tile count");
        let maximum_quotient = u32::MAX / range;
        let maximum_remainder = u32::MAX % range;
        let selected = loop {
            let raw = rng.next_u32();
            if maximum_remainder == range - 1 || raw / range < maximum_quotient {
                break (raw % range) as usize;
            }
        };
        values.swap(position, selected);
    }
    u32::try_from(values.len().saturating_sub(1))
        .expect("an exact object candidate run fits in the u32 map tile count")
}

const HEADER: u32 = u32::MAX - 1;

#[derive(Debug, Default)]
pub(super) struct StaleHeaderLinks {
    previous: Vec<u32>,
    next: Vec<u32>,
    member: Vec<bool>,
    members: usize,
}

impl StaleHeaderLinks {
    pub(super) fn is_empty(&self) -> bool {
        self.members == 0
    }

    pub(super) fn contains(&self, index: usize) -> bool {
        self.member.get(index).copied().unwrap_or(false)
    }

    fn allocate(&mut self, tile_count: usize) {
        if self.member.len() != tile_count {
            self.previous = vec![NO_NODE; tile_count];
            self.next = vec![NO_NODE; tile_count];
            self.member = vec![false; tile_count];
            self.members = 0;
        }
    }

    pub(super) fn abandon(&mut self, queue: &CandidateQueue) {
        let order = queue.linked_order();
        if order.is_empty() {
            return;
        }
        self.allocate(queue.present.len());
        let mut previous = HEADER;
        for &index in &order {
            if self.member[index] {
                let _ = self.unlink(index);
            }
            self.member[index] = true;
            self.members += 1;
            self.previous[index] = previous;
            if previous != HEADER {
                self.next[previous as usize] = index as u32;
            }
            previous = index as u32;
        }
        self.next[previous as usize] = NO_NODE;
    }

    pub(super) fn unlink(&mut self, index: usize) -> Option<Option<usize>> {
        if !self.contains(index) {
            return None;
        }
        self.member[index] = false;
        self.members -= 1;
        let previous = self.previous[index];
        let next = self.next[index];
        self.previous[index] = NO_NODE;
        self.next[index] = NO_NODE;
        if next != NO_NODE {
            self.previous[next as usize] = previous;
        }
        if previous == HEADER {
            return Some(node(next));
        }
        if previous != NO_NODE {
            self.next[previous as usize] = next;
        }
        None
    }

    fn take_chain(&mut self, start: Option<usize>) -> Vec<usize> {
        let mut chain = Vec::new();
        let mut current = start;
        while let Some(index) = current {
            if !self.contains(index) {
                break;
            }
            current = node(self.next[index]);
            self.member[index] = false;
            self.members -= 1;
            self.previous[index] = NO_NODE;
            self.next[index] = NO_NODE;
            chain.push(index);
        }
        chain
    }

    pub(super) fn redirect_live_queue(
        &mut self,
        live: &mut CandidateQueue,
        new_head: Option<usize>,
    ) {
        let continued = self.take_chain(new_head);
        let orphaned = live.linked_order();
        live.replace_contents(&continued);
        if orphaned.is_empty() {
            return;
        }
        let orphan = CandidateQueue::from_order(live.dimensions, &orphaned);
        self.abandon(&orphan);
    }

    pub(super) fn remove_square(
        &mut self,
        queue: &mut CandidateQueue,
        center: MapCoordinate,
        radius: u16,
        header_is_live: bool,
    ) {
        if self.is_empty() {
            queue.remove_square(center, radius);
            return;
        }
        let dimensions = queue.dimensions;
        let maximum_x = center.x.saturating_add(radius).min(dimensions.width - 1);
        let maximum_y = center.y.saturating_add(radius).min(dimensions.height - 1);
        for y in center.y.saturating_sub(radius)..=maximum_y {
            for x in center.x.saturating_sub(radius)..=maximum_x {
                let index = usize::from(y) * usize::from(dimensions.width) + usize::from(x);
                if queue.present[index] {
                    queue.remove(index);
                } else if let Some(new_head) = self.unlink(index)
                    && header_is_live
                {
                    self.redirect_live_queue(queue, new_head);
                }
            }
        }
    }

    pub(super) fn remove_node(&mut self, queue: &mut CandidateQueue, index: usize) {
        if queue.present[index] {
            queue.remove(index);
        } else {
            let _ = self.unlink(index);
        }
    }

    pub(super) fn release_linked(
        &mut self,
        queue: &CandidateQueue,
        mut live: Option<&mut CandidateQueue>,
    ) {
        if self.is_empty() {
            return;
        }
        for index in queue.linked_order() {
            if let Some(new_head) = self.unlink(index)
                && let Some(live) = live.as_deref_mut()
            {
                self.redirect_live_queue(live, new_head);
            }
        }
    }
}

impl CandidateQueue {
    pub(super) fn linked_order(&self) -> Vec<usize> {
        let mut order = Vec::with_capacity(self.len);
        let mut current = self.head;
        while let Some(index) = current {
            order.push(index);
            current = node(self.next[index]);
        }
        order
    }

    pub(super) fn from_order(dimensions: MapDimensions, order: &[usize]) -> Self {
        let tile_count = usize::from(dimensions.width) * usize::from(dimensions.height);
        let buffers = QueueBuffers::acquire(tile_count);
        let mut queue = Self {
            dimensions,
            present: buffers.present,
            previous: buffers.previous,
            next: buffers.next,
            head: None,
            tail: None,
            touched: buffers.touched,
            len: 0,
        };
        queue.replace_contents(order);
        queue
    }

    pub(super) fn replace_contents(&mut self, order: &[usize]) {
        while self.pop_front().is_some() {}
        for &index in order {
            if !self.present[index] {
                self.mark_present(index);
                self.push_back(index);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn new_over_stale_links(
        dimensions: MapDimensions,
        window: CandidateWindow,
        candidates: Vec<usize>,
        reverse_scan_order: bool,
        shuffle: bool,
        rng: &mut RmsRandom,
        cancellation: &dyn CancellationToken,
        mut accepts: impl FnMut(bool, MapCoordinate, &mut RmsRandom) -> Result<bool, GenerationError>,
        stale: &mut StaleHeaderLinks,
    ) -> Result<(Self, u32), GenerationError> {
        let tile_count = dimensions.tile_count()?;
        stale.allocate(tile_count);
        let mut header_next = NO_NODE;
        let mut candidate = vec![false; tile_count];
        let mut after = HEADER;
        for index in candidates {
            candidate[index] = true;
            if reverse_scan_order {
                stale.insert_after(&mut header_next, HEADER, index);
            } else {
                stale.insert_after(&mut header_next, after, index);
                after = index as u32;
            }
        }
        let mut iterations = 0;
        if shuffle
            && dimensions.width >= 3
            && dimensions.height >= 3
            && let Some((x_range, y_range, count)) = window.shuffle_shape()
        {
            if u64::from(count) > MAXIMUM_CANDIDATE_WORK {
                return Err(GenerationError::ResourceLimit {
                    resource: "object candidate shuffle".to_owned(),
                    limit: MAXIMUM_CANDIDATE_WORK,
                });
            }
            for iteration in 0..count {
                if iteration % 1024 == 0 {
                    cancellation_checkpoint(
                        cancellation,
                        GenerationStage::Objects,
                        u64::from(iteration),
                    )?;
                }
                let x = window.minimum_x + rng.bounded(x_range).result as u16;
                let y = window.minimum_y + rng.bounded(y_range).result as u16;
                let index = usize::from(y) * usize::from(dimensions.width) + usize::from(x);
                if accepts(candidate[index], MapCoordinate { x, y }, rng)? {
                    candidate[index] = true;
                    stale.insert_after(&mut header_next, HEADER, index);
                }
            }
            iterations = count;
        }
        let reached = stale.take_chain(node(header_next));
        let queue = Self::from_order(dimensions, &reached);
        Ok((queue, iterations))
    }
}

impl StaleHeaderLinks {
    fn insert_after(&mut self, header_next: &mut u32, after: u32, index: usize) {
        if self.member[index] {
            let previous = self.previous[index];
            let next = self.next[index];
            if previous == HEADER {
                *header_next = next;
            } else if previous != NO_NODE {
                self.next[previous as usize] = next;
            }
            if next != NO_NODE {
                self.previous[next as usize] = previous;
            }
        } else {
            self.member[index] = true;
            self.members += 1;
        }
        let following = if after == HEADER {
            *header_next
        } else {
            self.next[after as usize]
        };
        self.next[index] = following;
        self.previous[index] = after;
        if following != NO_NODE {
            self.previous[following as usize] = index as u32;
        }
        if after == HEADER {
            *header_next = index as u32;
        } else {
            self.next[after as usize] = index as u32;
        }
    }
}
