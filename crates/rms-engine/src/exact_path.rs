#[path = "exact_path/search.rs"]
mod search;

use super::{GenerationError, MapCoordinate, MapDimensions, TerrainId, invalid_request};
use search::hierarchy::Hierarchy;
pub(super) use search::hierarchy::Rectangle;
use std::collections::VecDeque;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) enum PathContext {
    #[default]
    Unavailable,
    Absent,
    Ready {
        costs: Vec<u32>,
        walkable: Vec<bool>,
        hierarchy: Hierarchy,
        terrain_seen: TerrainSeen,
        no_route: u8,
    },
}

#[derive(Clone, Debug, Default)]
pub(super) struct TerrainSeen(Vec<u32>);

impl PartialEq for TerrainSeen {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl Eq for TerrainSeen {}

const TERRAIN_CHUNK_TILES: usize = 64;

impl PathContext {
    pub fn with_rules(
        dimensions: MapDimensions,
        costs: Option<&[u32]>,
        rules: rms_profile::GenerationRules,
    ) -> Result<Self, GenerationError> {
        let Some(costs) = costs else {
            return Ok(Self::Absent);
        };
        let first = costs
            .first()
            .ok_or_else(|| path_error("initial traversal costs are empty"))?;
        let walkable = vec![f32::from_bits(*first) > 0.0; dimensions.tile_count()?];
        let hierarchy =
            Hierarchy::new(dimensions.width, dimensions.height, &walkable).map_err(path_error)?;
        Ok(Self::Ready {
            costs: costs.to_vec(),
            walkable,
            hierarchy,
            terrain_seen: TerrainSeen::default(),
            no_route: rules.path_no_route_result,
        })
    }

    pub fn invalidate(&mut self) {
        *self = Self::Unavailable;
    }

    pub fn world_changed(
        &mut self,
        rectangle: Rectangle,
        terrain: Option<&[TerrainId]>,
        words: Option<&[u64]>,
    ) {
        let Self::Ready {
            costs,
            walkable,
            hierarchy,
            terrain_seen,
            ..
        } = self
        else {
            return;
        };
        let count = usize::from(hierarchy.width) * usize::from(hierarchy.height);
        let Some(terrain) = terrain.filter(|tiles| tiles.len() == count) else {
            self.invalidate();
            return;
        };
        if words.is_some_and(|words| words.len() != count) {
            self.invalidate();
            return;
        }
        let refreshed = match crate::placement_oracle::mode() {
            crate::placement_oracle::PlacementCheckMode::Accelerated => {
                refresh_walkable_incrementally(
                    costs,
                    walkable,
                    terrain_seen,
                    hierarchy.width,
                    rectangle,
                    terrain,
                    words,
                )
            }
            crate::placement_oracle::PlacementCheckMode::Reference => {
                terrain_seen.0.clear();
                refresh_walkable(costs, walkable, terrain, words)
            }
            crate::placement_oracle::PlacementCheckMode::Differential => {
                let mut incremental = walkable.clone();
                let accelerated = refresh_walkable_incrementally(
                    costs,
                    &mut incremental,
                    terrain_seen,
                    hierarchy.width,
                    rectangle,
                    terrain,
                    words,
                );
                let reference = refresh_walkable(costs, walkable, terrain, words);
                crate::placement_oracle::compare(
                    crate::placement_oracle::OracleCheck::PathWalkable,
                    &(reference, !reference || *walkable == incremental),
                    &(accelerated, true),
                    || format!("walkable refresh of {rectangle:?}"),
                );
                reference
            }
        };
        if !refreshed || hierarchy.refresh(walkable, rectangle).is_err() {
            self.invalidate();
        }
    }
}

fn refresh_walkable(
    costs: &[u32],
    walkable: &mut [bool],
    terrain: &[TerrainId],
    words: Option<&[u64]>,
) -> bool {
    for index in 0..terrain.len() {
        if !refresh_walkable_tile(costs, walkable, terrain, words, index) {
            return false;
        }
    }
    true
}

fn refresh_walkable_tile(
    costs: &[u32],
    walkable: &mut [bool],
    terrain: &[TerrainId],
    words: Option<&[u64]>,
    index: usize,
) -> bool {
    let cost = super::exact_zone::slot_cost_bits(costs, terrain[index]);
    let word = words.map_or(0, |words| words[index]);
    walkable[index] = f32::from_bits(cost) > 0.0 && word & 0x4000 == 0;
    true
}

fn refresh_walkable_incrementally(
    costs: &[u32],
    walkable: &mut [bool],
    terrain_seen: &mut TerrainSeen,
    width: u16,
    rectangle: Rectangle,
    terrain: &[TerrainId],
    words: Option<&[u64]>,
) -> bool {
    let seen = &mut terrain_seen.0;
    if seen.len() != terrain.len() {
        seen.clear();
        if !refresh_walkable(costs, walkable, terrain, words) {
            return false;
        }
        seen.extend(terrain.iter().map(|tile| tile.0));
        return true;
    }
    let ignore_terrain = crate::placement_oracle::fault()
        == crate::placement_oracle::AcceleratorFault::WalkableIgnoresTerrainChanges;
    for (chunk, (current, previous)) in terrain
        .chunks(TERRAIN_CHUNK_TILES)
        .zip(seen.chunks_mut(TERRAIN_CHUNK_TILES))
        .enumerate()
        .filter(|_| !ignore_terrain)
    {
        let changed = current
            .iter()
            .zip(previous.iter())
            .fold(0, |difference, (tile, seen_tile)| {
                difference | (tile.0 ^ seen_tile)
            });
        if changed == 0 {
            continue;
        }
        for (offset, (tile, seen_tile)) in current.iter().zip(previous.iter_mut()).enumerate() {
            if tile.0 != *seen_tile {
                let index = chunk * TERRAIN_CHUNK_TILES + offset;
                if !refresh_walkable_tile(costs, walkable, terrain, words, index) {
                    return false;
                }
                *seen_tile = tile.0;
            }
        }
    }
    let width = i32::from(width);
    let height = i32::try_from(terrain.len()).unwrap_or(i32::MAX) / width.max(1);
    let (left, right) = (
        rectangle.left.min(rectangle.right),
        rectangle.left.max(rectangle.right),
    );
    let (top, bottom) = (
        rectangle.top.min(rectangle.bottom),
        rectangle.top.max(rectangle.bottom),
    );
    let left = i32::from(left).max(0);
    let top = i32::from(top).max(0);
    let right = i32::from(right).min(width - 1);
    let bottom = i32::from(bottom).min(height - 1);
    for y in top..=bottom {
        for x in left..=right {
            let index = (y * width + x) as usize;
            if !refresh_walkable_tile(costs, walkable, terrain, words, index) {
                return false;
            }
        }
    }
    true
}

impl PathContext {
    pub fn connected_tiles(&self) -> Option<Vec<bool>> {
        let Self::Ready { hierarchy, .. } = self else {
            return None;
        };
        let mut connected =
            Vec::with_capacity(usize::from(hierarchy.width) * usize::from(hierarchy.height));
        for y in 0..hierarchy.height {
            for x in 0..hierarchy.width {
                connected.push(hierarchy.cell(0, x, y).connections != 0);
            }
        }
        Some(connected)
    }

    pub fn cardinal_reachable(
        &self,
        start: MapCoordinate,
        terrain: &[TerrainId],
        stop_at: impl Fn(usize) -> bool,
    ) -> Result<Option<Vec<bool>>, GenerationError> {
        let Self::Ready {
            costs, hierarchy, ..
        } = self
        else {
            return match self {
                Self::Absent => Ok(None),
                _ => Err(path_error("required path world state is unavailable")),
            };
        };
        let width = usize::from(hierarchy.width);
        let height = usize::from(hierarchy.height);
        if usize::from(start.x) >= width || usize::from(start.y) >= height {
            return Err(path_error("path origin is outside the current map"));
        }
        if terrain.len() != width * height {
            return Err(path_error("wall terrain does not match the current map"));
        }

        let mut reachable = vec![false; terrain.len()];
        let start_index = usize::from(start.y) * width + usize::from(start.x);
        reachable[start_index] = true;
        let mut pending = VecDeque::from([start]);
        while let Some(point) = pending.pop_front() {
            let mut visit = |x: u16, y: u16| {
                let index = usize::from(y) * width + usize::from(x);
                if !reachable[index]
                    && f32::from_bits(super::exact_zone::slot_cost_bits(costs, terrain[index]))
                        > 0.0
                {
                    reachable[index] = true;
                    if !stop_at(index) {
                        pending.push_back(MapCoordinate { x, y });
                    }
                }
            };
            if point.x > 0 {
                visit(point.x - 1, point.y);
            }
            if usize::from(point.x) + 1 < width {
                visit(point.x + 1, point.y);
            }
            if point.y > 0 {
                visit(point.x, point.y - 1);
            }
            if usize::from(point.y) + 1 < height {
                visit(point.x, point.y + 1);
            }
        }
        Ok(Some(reachable))
    }

    pub fn allows(
        &mut self,
        costs: &[u32],
        clearance: f32,
        requirement: i32,
        candidate: MapCoordinate,
        anchor: MapCoordinate,
    ) -> Result<bool, GenerationError> {
        if requirement == 0 {
            return Ok(true);
        }
        let Self::Ready {
            costs: copied,
            walkable: _,
            hierarchy,
            terrain_seen: _,
            no_route,
        } = self
        else {
            return match self {
                Self::Absent => Ok(false),
                _ => Err(path_error("required path world state is unavailable")),
            };
        };
        if copied.len() == costs.len()
            && !copied
                .iter()
                .zip(costs)
                .all(|(left, right)| f32::from_bits(*left) == f32::from_bits(*right))
        {
            return Ok(false);
        }
        let center = |point: MapCoordinate| [f32::from(point.x) + 0.5, f32::from(point.y) + 0.5];
        let result = search::search(
            hierarchy,
            center(candidate),
            center(anchor),
            clearance,
            0.0,
            search::Limits {
                nodes: 1_000_000,
                buckets: 1_000_000,
            },
            *no_route,
        )
        .map_err(path_error)?;
        if result.status >= 2 {
            return Ok(false);
        }
        if requirement <= 1 {
            return Ok(true);
        }
        let dx = i32::from(anchor.x).wrapping_sub(i32::from(candidate.x));
        let dy = i32::from(anchor.y).wrapping_sub(i32::from(candidate.y));
        let squared = dx.wrapping_mul(dx).wrapping_add(dy.wrapping_mul(dy));
        let straight = truncate((squared as f32).sqrt());
        Ok(truncate(result.length) <= straight.wrapping_add(requirement).wrapping_sub(1))
    }
}

fn truncate(value: f32) -> i32 {
    if !(-2147483648.0..2147483648.0).contains(&value) {
        i32::MIN
    } else {
        value as i32
    }
}

fn path_error(message: &'static str) -> GenerationError {
    invalid_request("RMSGEN3304", message)
}
