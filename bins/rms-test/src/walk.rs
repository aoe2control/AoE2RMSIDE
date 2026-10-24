use std::collections::VecDeque;

use anyhow::{Result, anyhow, bail};
use rms_content::{
    BUILDING_CONSTRUCTOR_TYPE, CompatibleContentView, ObjectDefinition, ObjectId, TerrainId,
};
use rms_engine::GeneratedMap;
use sha2::{Digest, Sha256};

use crate::quality::WALK_RULES_ID;
use crate::{HOST_CHECK_INTERVAL, StopCheck};

pub(crate) const STRAIGHT_COST: u32 = 256;
pub(crate) const DIAGONAL_COST: u32 = 362;
const FARM_CLASS_ID: u32 = 49;

const OWNER_BITS: u16 = (1 << 9) - 1;
const STATIC_BLOCK: u16 = 1 << 9;
const TERRAIN_CLOSED: u16 = 1 << 10;
const OCCUPIED: u16 = 1 << 11;
const TERRAIN_NOT_BUILDABLE: u16 = 1 << 12;
const WALK_BLOCKERS: u16 = OWNER_BITS | STATIC_BLOCK | TERRAIN_CLOSED;
const BUILD_BLOCKERS: u16 = WALK_BLOCKERS | OCCUPIED | TERRAIN_NOT_BUILDABLE;

pub(crate) const MAX_PLAYER_SLOT: u8 = 8;

pub(crate) const WALK_DATA_UNAVAILABLE: &str = "Walking distances need the villager's terrain rules, which the selected game data does not include";
pub(crate) const BUILD_DATA_UNAVAILABLE: &str =
    "Buildable tiles need the house's terrain rules, which the selected game data does not include";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Blocking {
    None,
    Static,
    Owned,
    Occupies,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ObjectRule {
    pub blocking: Blocking,
    half_width_256: f64,
    half_height_256: f64,
}

impl ObjectRule {
    fn of(definition: &ObjectDefinition) -> Option<Self> {
        let pathing = definition.pathing?;
        let [half_width, half_height] = pathing.outline_half_extents();
        let outline = half_width > 0.0 && half_height > 0.0;
        let blocking = match pathing.kind {
            _ if !outline => Blocking::None,
            1 | 6 => Blocking::Static,
            3..=5 => Blocking::Owned,
            0 if definition.constructor_type == Some(BUILDING_CONSTRUCTOR_TYPE) => {
                if definition.class_id == FARM_CLASS_ID {
                    Blocking::Occupies
                } else {
                    Blocking::Owned
                }
            }
            _ => Blocking::None,
        };
        Some(Self {
            blocking,
            half_width_256: f64::from(half_width) * 256.0,
            half_height_256: f64::from(half_height) * 256.0,
        })
    }

    pub(crate) fn covered(
        &self,
        x_256: u32,
        y_256: u32,
        width: u16,
        height: u16,
    ) -> (u16, u16, u16, u16) {
        let (x0, x1) = covered_axis(x_256, self.half_width_256, width);
        let (y0, y1) = covered_axis(y_256, self.half_height_256, height);
        (x0, y0, x1, y1)
    }
}

fn covered_axis(centre_256: u32, half_256: f64, extent: u16) -> (u16, u16) {
    let last = u32::from(extent.max(1)) - 1;
    let containing = (centre_256 / 256).min(last);
    let span = (half_256 / 256.0).ceil().min(f64::from(u16::MAX)) as u32 + 1;
    let centre = f64::from(centre_256);
    let inside = |tile: u32| (f64::from(tile * 256 + 128) - centre).abs() < half_256;
    let low = containing.saturating_sub(span);
    let high = containing.saturating_add(span).min(last);
    let mut range: Option<(u32, u32)> = None;
    for tile in low..=high {
        if inside(tile) {
            range = Some(range.map_or((tile, tile), |(first, _)| (first, tile)));
        }
    }
    let (first, end) = range.unwrap_or((containing, containing));
    (first as u16, end as u16)
}

#[derive(Debug)]
pub(crate) struct WalkRules {
    walk_terrain: Vec<bool>,
    build_terrain: Option<Vec<bool>>,
    objects: Vec<(u32, Option<ObjectRule>)>,
}

impl WalkRules {
    pub(crate) fn new(content: CompatibleContentView<'_>, house: Option<u32>) -> Result<Self> {
        let terrain_table = |object: ObjectId| -> Option<Vec<bool>> {
            let restriction = content
                .object(object)?
                .restriction_for(None)
                .and_then(|id| content.restriction(id))?;
            let count = content
                .terrains()
                .iter()
                .map(|terrain| terrain.id.0 as usize + 1)
                .max()
                .unwrap_or(0);
            Some(
                (0..count)
                    .map(|terrain| {
                        restriction
                            .allows_terrain(TerrainId(terrain as u32))
                            .unwrap_or(false)
                    })
                    .collect(),
            )
        };
        let walk_terrain = content
            .rms_path_reference_object_id()
            .and_then(terrain_table)
            .ok_or_else(|| anyhow!(WALK_DATA_UNAVAILABLE))?;
        let build_terrain = house.and_then(|house| terrain_table(ObjectId(house)));
        let objects = content
            .objects()
            .iter()
            .map(|definition| (definition.id.0, ObjectRule::of(definition)))
            .collect::<Vec<_>>();
        debug_assert!(objects.windows(2).all(|pair| pair[0].0 < pair[1].0));
        Ok(Self {
            walk_terrain,
            build_terrain,
            objects,
        })
    }

    pub(crate) fn object(&self, object_id: u32) -> Result<ObjectRule> {
        self.objects
            .binary_search_by_key(&object_id, |(id, _)| *id)
            .ok()
            .and_then(|index| self.objects[index].1)
            .ok_or_else(|| {
                anyhow!("object {object_id} has no walking data in the selected game data")
            })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WalkGrid {
    pub width: u16,
    pub height: u16,
    cells: Vec<u16>,
    buildable_known: bool,
    hash: [u8; 32],
}

impl WalkGrid {
    pub(crate) fn build(
        rules: &WalkRules,
        map: &GeneratedMap,
        stop: &dyn StopCheck,
    ) -> Result<Self> {
        let width = map.dimensions.width;
        let height = map.dimensions.height;
        let mut cells = Vec::with_capacity(map.terrain.len());
        for (index, terrain) in map.terrain.iter().enumerate() {
            if index.is_multiple_of(HOST_CHECK_INTERVAL) {
                stop.check()?;
            }
            let terrain = terrain.0 as usize;
            let mut cell = 0;
            if !rules.walk_terrain.get(terrain).copied().unwrap_or(false) {
                cell |= TERRAIN_CLOSED;
            }
            if let Some(build) = &rules.build_terrain
                && !build.get(terrain).copied().unwrap_or(false)
            {
                cell |= TERRAIN_NOT_BUILDABLE;
            }
            cells.push(cell);
        }
        let mut grid = Self {
            width,
            height,
            cells,
            buildable_known: rules.build_terrain.is_some(),
            hash: [0; 32],
        };
        let mut visits = 0_usize;
        let mut mark = |object_id: u32, owner: Option<u8>, x_256: u32, y_256: u32| -> Result<()> {
            visits += 1;
            if visits.is_multiple_of(HOST_CHECK_INTERVAL) {
                stop.check()?;
            }
            let rule = rules.object(object_id)?;
            let bit = match (rule.blocking, owner) {
                (Blocking::None, _) => return Ok(()),
                (Blocking::Static, _) | (Blocking::Owned, None) => STATIC_BLOCK,
                (Blocking::Owned, Some(owner)) if owner <= MAX_PLAYER_SLOT => 1 << owner,
                (Blocking::Owned, Some(_)) => STATIC_BLOCK,
                (Blocking::Occupies, _) => OCCUPIED,
            };
            grid.mark(rule.covered(x_256, y_256, width, height), bit);
            Ok(())
        };
        for appearance in &map.appearance_objects {
            mark(
                appearance.object_id.0,
                None,
                appearance.x_256,
                appearance.y_256,
            )?;
        }
        for piece in &map.cliff_pieces {
            mark(piece.object_id.0, None, piece.x_256, piece.y_256)?;
        }
        for object in &map.objects {
            mark(
                object.object_id.0,
                Some(object.owner),
                object.x_256,
                object.y_256,
            )?;
        }
        grid.hash = grid.digest();
        Ok(grid)
    }

    fn mark(&mut self, (x0, y0, x1, y1): (u16, u16, u16, u16), bit: u16) {
        let width = usize::from(self.width);
        for y in y0..=y1 {
            for x in x0..=x1 {
                self.cells[usize::from(y) * width + usize::from(x)] |= bit;
            }
        }
    }

    fn digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"rms-walk-grid-v1\0");
        hasher.update(WALK_RULES_ID.as_bytes());
        hasher.update([0]);
        hasher.update(self.width.to_le_bytes());
        hasher.update(self.height.to_le_bytes());
        hasher.update([u8::from(self.buildable_known)]);
        for cell in &self.cells {
            hasher.update(cell.to_le_bytes());
        }
        hasher.finalize().into()
    }

    pub(crate) fn hash(&self) -> [u8; 32] {
        self.hash
    }

    pub(crate) fn tile_count(&self) -> usize {
        self.cells.len()
    }

    pub(crate) fn heap_bytes(&self) -> u64 {
        (self.cells.capacity() * std::mem::size_of::<u16>()) as u64
    }

    pub(crate) fn walker(&self, open_for: Option<u8>) -> Walker<'_> {
        Walker {
            cells: &self.cells,
            mask: WALK_BLOCKERS & !open_for.map_or(0, |slot| 1 << slot),
            cleared: None,
            closed: None,
            width: usize::from(self.width),
            height: usize::from(self.height),
        }
    }

    pub(crate) fn clearing_walker<'a>(
        &'a self,
        open_for: Option<u8>,
        cleared: &'a [bool],
    ) -> Walker<'a> {
        Walker {
            cleared: Some(cleared),
            ..self.walker(open_for)
        }
    }

    pub(crate) fn closing_walker<'a>(
        &'a self,
        open_for: Option<u8>,
        closed: &'a [bool],
    ) -> Walker<'a> {
        Walker {
            closed: Some(closed),
            ..self.walker(open_for)
        }
    }

    pub(crate) fn walkable(&self, index: usize) -> bool {
        self.cells[index] & WALK_BLOCKERS == 0
    }

    pub(crate) fn buildable(&self, index: usize) -> bool {
        self.buildable_known && self.cells[index] & BUILD_BLOCKERS == 0
    }

    pub(crate) fn require_buildable(&self) -> Result<()> {
        if self.buildable_known {
            Ok(())
        } else {
            bail!(BUILD_DATA_UNAVAILABLE)
        }
    }
}

const DIRECTIONS: [(i32, i32); 8] = [
    (0, -1),
    (1, 0),
    (0, 1),
    (-1, 0),
    (1, -1),
    (1, 1),
    (-1, 1),
    (-1, -1),
];

const fn opposite(direction: usize) -> usize {
    if direction < 4 {
        (direction + 2) % 4
    } else {
        4 + (direction - 4 + 2) % 4
    }
}

pub(crate) struct Walker<'a> {
    cells: &'a [u16],
    mask: u16,
    cleared: Option<&'a [bool]>,
    closed: Option<&'a [bool]>,
    width: usize,
    height: usize,
}

impl Walker<'_> {
    pub(crate) fn open(&self, index: usize) -> bool {
        let cell = self.cells[index];
        if self.closed.is_some_and(|closed| closed[index]) {
            return false;
        }
        cell & self.mask == 0
            || self
                .cleared
                .is_some_and(|cleared| cleared[index] && cell & self.mask & !STATIC_BLOCK == 0)
    }

    fn neighbour(&self, index: usize, direction: usize) -> Option<usize> {
        let (dx, dy) = DIRECTIONS[direction];
        let x = (index % self.width) as i32 + dx;
        let y = (index / self.width) as i32 + dy;
        (x >= 0 && y >= 0 && (x as usize) < self.width && (y as usize) < self.height)
            .then(|| y as usize * self.width + x as usize)
    }

    fn step(&self, index: usize, direction: usize) -> Option<usize> {
        let next = self.neighbour(index, direction)?;
        if !self.open(next) {
            return None;
        }
        if direction >= 4 {
            let (dx, dy) = DIRECTIONS[direction];
            let x = index % self.width;
            let y = index / self.width;
            let beside = y * self.width + (x as i32 + dx) as usize;
            let above = (y as i32 + dy) as usize * self.width + x;
            if !self.open(beside) || !self.open(above) {
                return None;
            }
        }
        Some(next)
    }

    pub(crate) fn place_tiles(&self, (x0, y0, x1, y1): (u16, u16, u16, u16)) -> Vec<usize> {
        let (x0, y0, x1, y1) = (
            usize::from(x0),
            usize::from(y0),
            usize::from(x1),
            usize::from(y1),
        );
        let mut tiles = Vec::new();
        for y in y0..=y1 {
            for x in x0..=x1 {
                let index = y * self.width + x;
                if self.open(index) {
                    tiles.push(index);
                }
            }
        }
        if !tiles.is_empty() {
            return tiles;
        }
        let (rx0, ry0) = (x0.saturating_sub(1), y0.saturating_sub(1));
        let (rx1, ry1) = ((x1 + 1).min(self.width - 1), (y1 + 1).min(self.height - 1));
        for y in ry0..=ry1 {
            for x in rx0..=rx1 {
                let inside = (x0..=x1).contains(&x) && (y0..=y1).contains(&y);
                let index = y * self.width + x;
                if !inside && self.open(index) {
                    tiles.push(index);
                }
            }
        }
        tiles
    }
}

const UNREACHED: u32 = u32::MAX;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Field {
    costs: Vec<u32>,
}

impl Field {
    pub(crate) fn cost(&self, index: usize) -> Option<u32> {
        let cost = self.costs[index];
        (cost != UNREACHED).then_some(cost)
    }

    pub(crate) fn least(&self, tiles: &[usize]) -> Option<u32> {
        tiles.iter().filter_map(|&tile| self.cost(tile)).min()
    }

    pub(crate) fn heap_bytes(&self) -> u64 {
        (self.costs.capacity() * std::mem::size_of::<u32>()) as u64
    }
}

pub(crate) fn whole_tiles(cost: u32) -> u32 {
    cost.saturating_add(STRAIGHT_COST / 2) / STRAIGHT_COST
}

pub(crate) fn cost_within(tiles: u32) -> u32 {
    tiles
        .saturating_mul(STRAIGHT_COST)
        .saturating_add(STRAIGHT_COST / 2 - 1)
}

fn dial(
    walker: &Walker<'_>,
    sources: &[usize],
    max_cost: Option<u32>,
    targets: Option<&[bool]>,
    stop: &dyn StopCheck,
) -> Result<(Vec<u32>, Option<u32>)> {
    const BUCKETS: usize = DIAGONAL_COST as usize + 1;
    let mut costs = vec![UNREACHED; walker.cells.len()];
    let mut buckets = vec![Vec::<u32>::new(); BUCKETS];
    let mut pending = 0_usize;
    for &source in sources {
        if walker.open(source) && costs[source] == UNREACHED {
            costs[source] = 0;
            buckets[0].push(source as u32);
            pending += 1;
        }
    }
    let limit = max_cost.unwrap_or(u32::MAX - DIAGONAL_COST);
    let mut current = 0_u32;
    let mut settled = 0_usize;
    while pending > 0 {
        let slot = current as usize % BUCKETS;
        let mut bucket = std::mem::take(&mut buckets[slot]);
        pending -= bucket.len();
        for &tile in &bucket {
            let tile = tile as usize;
            if costs[tile] != current {
                continue;
            }
            settled += 1;
            if settled.is_multiple_of(HOST_CHECK_INTERVAL) {
                stop.check()?;
            }
            if targets.is_some_and(|targets| targets[tile]) {
                return Ok((costs, Some(current)));
            }
            for direction in 0..DIRECTIONS.len() {
                let Some(next) = walker.step(tile, direction) else {
                    continue;
                };
                let cost = current
                    + if direction < 4 {
                        STRAIGHT_COST
                    } else {
                        DIAGONAL_COST
                    };
                if cost <= limit && cost < costs[next] {
                    costs[next] = cost;
                    buckets[cost as usize % BUCKETS].push(next as u32);
                    pending += 1;
                }
            }
        }
        bucket.clear();
        buckets[slot] = bucket;
        current += 1;
    }
    Ok((costs, None))
}

pub(crate) fn distance_field(
    walker: &Walker<'_>,
    sources: &[usize],
    max_cost: Option<u32>,
    stop: &dyn StopCheck,
) -> Result<Field> {
    let (costs, _) = dial(walker, sources, max_cost, None, stop)?;
    Ok(Field { costs })
}

pub(crate) fn walk_cost(
    walker: &Walker<'_>,
    sources: &[usize],
    targets: &[usize],
    stop: &dyn StopCheck,
) -> Result<Option<u32>> {
    if targets.is_empty() {
        return Ok(None);
    }
    let mut mask = vec![false; walker.cells.len()];
    for &target in targets {
        mask[target] = true;
    }
    Ok(dial(walker, sources, None, Some(&mask), stop)?.1)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Passage {
    pub width: u32,
    pub tile: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PassageResult {
    Capped,
    Cut { width: u32, passages: Vec<Passage> },
}

const NONE: u8 = 0;
const SOURCE: u8 = 1;
const SINK: u8 = 2;
const NO_PARENT: u32 = u32::MAX;

pub(crate) fn narrowest_passage(
    walker: &Walker<'_>,
    sources: &[usize],
    sinks: &[usize],
    limit: u32,
    stop: &dyn StopCheck,
) -> Result<PassageResult> {
    let tiles = walker.cells.len();
    let mut role = vec![NONE; tiles];
    for &source in sources {
        role[source] = SOURCE;
    }
    for &sink in sinks {
        if role[sink] == SOURCE {
            return Ok(PassageResult::Capped);
        }
        role[sink] = SINK;
    }
    if sources.is_empty() || sinks.is_empty() {
        return Ok(PassageResult::Cut {
            width: 0,
            passages: Vec::new(),
        });
    }
    for &source in sources {
        if (0..DIRECTIONS.len()).any(|direction| {
            walker
                .step(source, direction)
                .is_some_and(|next| role[next] == SINK)
        }) {
            return Ok(PassageResult::Capped);
        }
    }
    let mut carried = vec![[0_u8; 8]; tiles];
    let mut through = vec![false; tiles];
    let mut stamp = vec![0_u32; 2 * tiles];
    let mut parent = vec![NO_PARENT; 2 * tiles];
    let mut queue = VecDeque::<u32>::new();
    let mut epoch = 0_u32;
    let mut width = 0_u32;
    let mut visits = 0_usize;
    loop {
        epoch += 1;
        queue.clear();
        for &source in sources {
            let node = 2 * source + 1;
            stamp[node] = epoch;
            parent[node] = NO_PARENT;
            queue.push_back(node as u32);
        }
        let mut found = None;
        'search: while let Some(node) = queue.pop_front() {
            visits += 1;
            if visits.is_multiple_of(HOST_CHECK_INTERVAL) {
                stop.check()?;
            }
            let node = node as usize;
            let tile = node / 2;
            let mut visit = |next: usize, queue: &mut VecDeque<u32>| {
                if stamp[next] != epoch {
                    stamp[next] = epoch;
                    parent[next] = node as u32;
                    queue.push_back(next as u32);
                }
            };
            if node % 2 == 1 {
                for direction in 0..DIRECTIONS.len() {
                    let Some(next) = walker.step(tile, direction) else {
                        continue;
                    };
                    match role[next] {
                        SOURCE => {}
                        SINK => {
                            found = Some((next, node));
                            break 'search;
                        }
                        _ => visit(2 * next, &mut queue),
                    }
                }
                if role[tile] == NONE && through[tile] {
                    visit(2 * tile, &mut queue);
                }
            } else {
                if !through[tile] {
                    visit(2 * tile + 1, &mut queue);
                }
                for direction in 0..DIRECTIONS.len() {
                    if let Some(next) = walker.neighbour(tile, direction)
                        && role[next] == NONE
                        && carried[next][opposite(direction)] > 0
                    {
                        visit(2 * next + 1, &mut queue);
                    }
                }
            }
        }
        let Some((sink, last)) = found else {
            break;
        };
        let mut current = 2 * sink;
        let mut previous = last;
        loop {
            let (from, to) = (previous / 2, current / 2);
            if from == to {
                through[from] = previous % 2 == 0;
            } else {
                let direction = (0..DIRECTIONS.len())
                    .find(|&direction| walker.neighbour(from, direction) == Some(to))
                    .ok_or_else(|| anyhow!("narrowest passage walked between distant tiles"))?;
                let (move_flow, moved) = if previous % 2 == 1 {
                    let flow = &mut carried[from][direction];
                    (flow.checked_add(1), flow)
                } else {
                    let flow = &mut carried[to][opposite(direction)];
                    (flow.checked_sub(1), flow)
                };
                *moved =
                    move_flow.ok_or_else(|| anyhow!("narrowest passage flow left its bounds"))?;
            }
            if parent[previous] == NO_PARENT {
                break;
            }
            current = previous;
            previous = parent[previous] as usize;
        }
        width += 1;
        if width >= limit {
            return Ok(PassageResult::Capped);
        }
    }
    let cut = (0..tiles)
        .filter(|&tile| {
            role[tile] == NONE && stamp[2 * tile] == epoch && stamp[2 * tile + 1] != epoch
        })
        .collect::<Vec<_>>();
    if cut.len() != width as usize {
        bail!("narrowest passage cut does not match its width");
    }
    Ok(PassageResult::Cut {
        width,
        passages: passages(walker, &cut),
    })
}

fn passages(walker: &Walker<'_>, cut: &[usize]) -> Vec<Passage> {
    let mut grouped = vec![false; cut.len()];
    let mut result = Vec::<(Passage, usize)>::new();
    for start in 0..cut.len() {
        if grouped[start] {
            continue;
        }
        grouped[start] = true;
        let mut members = vec![cut[start]];
        let mut next = 0;
        while next < members.len() {
            let tile = members[next];
            next += 1;
            for direction in 0..DIRECTIONS.len() {
                if let Some(neighbour) = walker.neighbour(tile, direction)
                    && let Ok(position) = cut.binary_search(&neighbour)
                    && !grouped[position]
                {
                    grouped[position] = true;
                    members.push(neighbour);
                }
            }
        }
        members.sort_unstable();
        let count = members.len() as i64;
        let (sum_x, sum_y) = members.iter().fold((0_i64, 0_i64), |(x, y), &tile| {
            (
                x + (tile % walker.width) as i64,
                y + (tile / walker.width) as i64,
            )
        });
        let tile = *members
            .iter()
            .min_by_key(|&&tile| {
                let dx = count * (tile % walker.width) as i64 - sum_x;
                let dy = count * (tile / walker.width) as i64 - sum_y;
                (dx * dx + dy * dy, tile)
            })
            .expect("a passage has a tile");
        result.push((
            Passage {
                width: members.len() as u32,
                tile,
            },
            members[0],
        ));
    }
    result.sort_by_key(|(passage, first)| (passage.width, *first));
    result.into_iter().map(|(passage, _)| passage).collect()
}
