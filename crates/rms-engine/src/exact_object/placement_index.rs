use std::cell::{RefCell, RefMut};
use std::collections::BTreeSet;

use super::*;
use crate::placement_oracle::{self, AcceleratorFault, OracleCheck, PlacementCheckMode};

const BUCKET_TILES: usize = 8;
const OBSTRUCTION_MARGIN_TILES: f64 = 1.0;
const BUCKETED_HALF_EXTENT_LIMIT: f32 = 16.0;
const PREFILTER_MAGNITUDE_LIMIT: f32 = 1_000_000.0;
const WIDE_ACTOR_AREA_BUCKETS: usize = 64;

fn bucket_count(extent: u16) -> usize {
    usize::from(extent).div_ceil(BUCKET_TILES).max(1)
}

fn bounded(value: f32) -> bool {
    value.is_finite() && value.abs() <= PREFILTER_MAGNITUDE_LIMIT
}

fn bucket_of(value: f64, count: usize) -> usize {
    let bucket = (value / BUCKET_TILES as f64).floor();
    if bucket <= 0.0 {
        0
    } else {
        (bucket as usize).min(count - 1)
    }
}

#[derive(Clone, Copy, Debug)]
struct SpatialEntry {
    index: u32,
    center: [f32; 2],
    half_extents: [f32; 2],
}

enum Admission {
    Skip,
    Always,
    Footprint {
        center: [f32; 2],
        half_extents: [f32; 2],
    },
}

impl Admission {
    fn footprint(center: [f32; 2], half_extents: [f32; 2]) -> Self {
        if center.into_iter().chain(half_extents).all(bounded) {
            Self::Footprint {
                center,
                half_extents,
            }
        } else {
            Self::Always
        }
    }
}

#[derive(Default)]
struct SpatialList {
    columns: usize,
    rows: usize,
    buckets: Vec<Vec<SpatialEntry>>,
    wide: Vec<SpatialEntry>,
    always: Vec<u32>,
    maximum_half_extents: [f32; 2],
    indexed: usize,
}

impl SpatialList {
    fn new(dimensions: MapDimensions) -> Self {
        let columns = bucket_count(dimensions.width);
        let rows = bucket_count(dimensions.height);
        Self {
            columns,
            rows,
            buckets: vec![Vec::new(); columns * rows],
            ..Self::default()
        }
    }

    fn admit(&mut self, admission: Admission) {
        let index = self.indexed as u32;
        self.indexed += 1;
        match admission {
            Admission::Skip => {}
            Admission::Always => self.always.push(index),
            Admission::Footprint {
                center,
                half_extents,
            } => {
                let entry = SpatialEntry {
                    index,
                    center,
                    half_extents,
                };
                if half_extents[0] > BUCKETED_HALF_EXTENT_LIMIT
                    || half_extents[1] > BUCKETED_HALF_EXTENT_LIMIT
                {
                    self.wide.push(entry);
                    return;
                }
                self.maximum_half_extents = [
                    self.maximum_half_extents[0].max(half_extents[0]),
                    self.maximum_half_extents[1].max(half_extents[1]),
                ];
                let column = bucket_of(f64::from(center[0]), self.columns);
                let row = bucket_of(f64::from(center[1]), self.rows);
                self.buckets[row * self.columns + column].push(entry);
            }
        }
    }

    fn query(&self, center: [f32; 2], reach: [f32; 2], output: &mut Vec<u32>) {
        output.clear();
        output.extend_from_slice(&self.always);
        let ignore_footprints =
            placement_oracle::fault() == AcceleratorFault::ObstructionIgnoresFootprints;
        let can_overlap = |entry: &SpatialEntry| {
            (0..2).all(|axis| {
                let half = if ignore_footprints {
                    0.0
                } else {
                    f64::from(entry.half_extents[axis])
                };
                (f64::from(entry.center[axis]) - f64::from(center[axis])).abs()
                    <= f64::from(reach[axis]) + half + OBSTRUCTION_MARGIN_TILES
            })
        };
        output.extend(
            self.wide
                .iter()
                .filter(|entry| can_overlap(entry))
                .map(|entry| entry.index),
        );
        let span = |axis: usize| {
            f64::from(reach[axis])
                + f64::from(self.maximum_half_extents[axis])
                + OBSTRUCTION_MARGIN_TILES
        };
        let (span_x, span_y) = (span(0), span(1));
        if span_x >= 0.0 && span_y >= 0.0 {
            let first_column = bucket_of(f64::from(center[0]) - span_x, self.columns);
            let last_column = bucket_of(f64::from(center[0]) + span_x, self.columns);
            let first_row = bucket_of(f64::from(center[1]) - span_y, self.rows);
            let last_row = bucket_of(f64::from(center[1]) + span_y, self.rows);
            for row in first_row..=last_row {
                for bucket in &self.buckets
                    [row * self.columns + first_column..=row * self.columns + last_column]
                {
                    output.extend(
                        bucket
                            .iter()
                            .filter(|entry| can_overlap(entry))
                            .map(|entry| entry.index),
                    );
                }
            }
        }
        output.sort_unstable();
    }
}

#[derive(Default)]
pub(super) struct ObstructionIndex {
    state: RefCell<ObstructionIndexState>,
}

#[derive(Default)]
struct ObstructionIndexState {
    layout: Option<(MapDimensions, u32)>,
    objects: SpatialList,
    last_object_identity: Option<u32>,
    appearances: SpatialList,
    appearance_source: Option<(usize, usize, usize)>,
    object_visits: Vec<u32>,
    appearance_visits: Vec<u32>,
    roster: RosterIndex,
    roster_tiles: Vec<MapCoordinate>,
}

#[derive(Default)]
struct RosterIndex {
    layout: Option<(MapDimensions, u32)>,
    next_identity: u32,
    special_tiles: BTreeSet<MapCoordinate>,
    maximum_half_extents: [f32; 2],
}

pub(super) struct ObstructionVisits<'a> {
    state: RefMut<'a, ObstructionIndexState>,
}

impl ObstructionVisits<'_> {
    pub(super) fn objects(&self) -> &[u32] {
        &self.state.object_visits
    }

    pub(super) fn appearances(&self) -> &[u32] {
        &self.state.appearance_visits
    }
}

pub(super) struct RosterVisits<'a> {
    state: RefMut<'a, ObstructionIndexState>,
}

impl RosterVisits<'_> {
    pub(super) fn tiles(&self) -> &[MapCoordinate] {
        &self.state.roster_tiles
    }
}

#[derive(Clone, Copy)]
pub(super) struct RosterWorld<'a> {
    pub(super) roster: &'a super::super::exact_world::ObjectRoster,
    pub(super) gate_class: u32,
    pub(super) content: CompatibleContentView<'a>,
    pub(super) runtime_attributes: &'a ObjectRuntimeAttributes,
}

#[derive(Clone, Copy)]
pub(super) struct ObstructionWorld<'a> {
    pub(super) objects: &'a [PlacedObject],
    pub(super) construction_positions: &'a BTreeMap<usize, [u32; 2]>,
    pub(super) appearance_objects: &'a TerrainAppearanceObjects,
    pub(super) gate_class: u32,
    pub(super) content: CompatibleContentView<'a>,
    pub(super) runtime_attributes: &'a ObjectRuntimeAttributes,
}

impl ObstructionIndex {
    pub(super) fn visits(
        &self,
        center: [f32; 2],
        placement: [f32; 2],
        world: ObstructionWorld<'_>,
    ) -> Option<ObstructionVisits<'_>> {
        if !center.into_iter().chain(placement).all(bounded) {
            return None;
        }
        let mut state = self.state.try_borrow_mut().ok()?;
        state.synchronize(world);
        let state_ref = &mut *state;
        state_ref
            .objects
            .query(center, placement, &mut state_ref.object_visits);
        state_ref
            .appearances
            .query(center, placement, &mut state_ref.appearance_visits);
        Some(ObstructionVisits { state })
    }

    pub(super) fn roster_visits(
        &self,
        center: [f32; 2],
        placement: [f32; 2],
        world: RosterWorld<'_>,
    ) -> Option<RosterVisits<'_>> {
        if !center.into_iter().chain(placement).all(bounded) {
            return None;
        }
        let dimensions = world.roster.dimensions()?;
        if dimensions.width == 0 || dimensions.height == 0 {
            return None;
        }
        let mut state = self.state.try_borrow_mut().ok()?;
        let state_ref = &mut *state;
        state_ref.roster.synchronize(dimensions, world);
        let roster = &state_ref.roster;
        let ignore_footprints =
            placement_oracle::fault() == AcceleratorFault::ObstructionIgnoresFootprints;
        let window = |axis: usize, extent: u16| {
            let half = if ignore_footprints {
                0.0
            } else {
                f64::from(roster.maximum_half_extents[axis])
            };
            let reach = f64::from(placement[axis]) + half + OBSTRUCTION_MARGIN_TILES;
            let first = (f64::from(center[axis]) - reach).floor();
            let last = (f64::from(center[axis]) + reach).floor();
            let limit = f64::from(extent - 1);
            (reach >= 0.0 && last >= 0.0 && first <= limit)
                .then(|| (first.max(0.0) as u16, last.min(limit) as u16))
        };
        state_ref.roster_tiles.clear();
        if let (Some((first_x, last_x)), Some((first_y, last_y))) =
            (window(0, dimensions.width), window(1, dimensions.height))
        {
            world.roster.member_tiles_in(
                first_x..=last_x,
                first_y..=last_y,
                &mut state_ref.roster_tiles,
            );
        }
        if !roster.special_tiles.is_empty() {
            state_ref
                .roster_tiles
                .extend(roster.special_tiles.iter().copied());
            state_ref.roster_tiles.sort_unstable();
            state_ref.roster_tiles.dedup();
        }
        Some(RosterVisits { state })
    }
}

impl RosterIndex {
    fn synchronize(&mut self, dimensions: MapDimensions, world: RosterWorld<'_>) {
        let layout = Some((dimensions, world.gate_class));
        if self.layout != layout || world.roster.next_identity() < self.next_identity {
            *self = Self {
                layout,
                ..Self::default()
            };
        }
        for (_, object) in world.roster.objects_from(self.next_identity) {
            let definition =
                world
                    .runtime_attributes
                    .definition(object.object_id, object.owner, world.content);
            match master_admission(definition, world.gate_class) {
                Err(Admission::Skip) => {}
                Err(_) => {
                    self.special_tiles.insert(object.tile);
                }
                Ok(half_extents) => {
                    let position = object.position_bits.map(f32::from_bits);
                    if position.into_iter().chain(half_extents).all(bounded)
                        && half_extents[0] <= BUCKETED_HALF_EXTENT_LIMIT
                        && half_extents[1] <= BUCKETED_HALF_EXTENT_LIMIT
                    {
                        self.maximum_half_extents = [
                            self.maximum_half_extents[0].max(half_extents[0]),
                            self.maximum_half_extents[1].max(half_extents[1]),
                        ];
                    } else {
                        self.special_tiles.insert(object.tile);
                    }
                }
            }
        }
        self.next_identity = world.roster.next_identity();
    }
}

impl ObstructionIndexState {
    fn synchronize(&mut self, world: ObstructionWorld<'_>) {
        let dimensions = world.appearance_objects.dimensions;
        let layout = Some((dimensions, world.gate_class));
        if self.layout != layout {
            *self = Self {
                layout,
                objects: SpatialList::new(dimensions),
                appearances: SpatialList::new(dimensions),
                object_visits: std::mem::take(&mut self.object_visits),
                appearance_visits: std::mem::take(&mut self.appearance_visits),
                ..Self::default()
            };
        }
        let appearances = world.appearance_objects;
        let source = (
            std::ptr::from_ref(appearances) as usize,
            appearances.module_entry_objects.len(),
            appearances.objects.len(),
        );
        if self.appearance_source != Some(source) {
            self.appearances = SpatialList::new(dimensions);
            for appearance in appearances
                .module_entry_objects
                .iter()
                .chain(&appearances.objects)
            {
                self.appearances
                    .admit(appearance_admission(appearance, dimensions, world));
            }
            self.appearance_source = Some(source);
        }
        let indexed = self.objects.indexed;
        if indexed > world.objects.len()
            || (indexed > 0
                && Some(world.objects[indexed - 1].instance_id) != self.last_object_identity)
        {
            self.objects = SpatialList::new(dimensions);
            self.last_object_identity = None;
        }
        for index in self.objects.indexed..world.objects.len() {
            self.objects.admit(object_admission(index, world));
            self.last_object_identity = Some(world.objects[index].instance_id);
        }
    }
}

fn master_admission(
    definition: Option<&ObjectDefinition>,
    gate_class: u32,
) -> Result<[f32; 2], Admission> {
    let Some(definition) = definition else {
        return Err(Admission::Always);
    };
    if definition.class_id == gate_class {
        return Err(Admission::Always);
    }
    if definition.can_be_built_on {
        return Err(Admission::Skip);
    }
    let half_extents = definition.collision_half_extents();
    if half_extents[0] <= 0.0 || half_extents[1] <= 0.0 {
        return Err(Admission::Skip);
    }
    Ok(half_extents)
}

fn object_admission(index: usize, world: ObstructionWorld<'_>) -> Admission {
    let object = &world.objects[index];
    let definition =
        world
            .runtime_attributes
            .definition(object.object_id, object.owner, world.content);
    let half_extents = match master_admission(definition, world.gate_class) {
        Ok(half_extents) => half_extents,
        Err(admission) => return admission,
    };
    let center = world.construction_positions.get(&index).map_or(
        [object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0],
        |bits| bits.map(f32::from_bits),
    );
    Admission::footprint(center, half_extents)
}

fn appearance_admission(
    appearance: &ExactAppearanceObject,
    dimensions: MapDimensions,
    world: ObstructionWorld<'_>,
) -> Admission {
    if dimensions.width == 0 {
        return Admission::Always;
    }
    let definition = world
        .runtime_attributes
        .definition(appearance.object_id, 0, world.content);
    let half_extents = match master_admission(definition, world.gate_class) {
        Ok(half_extents) => half_extents,
        Err(admission) => return admission,
    };
    if !half_extents.into_iter().all(bounded) {
        return Admission::Always;
    }
    let width = u32::from(dimensions.width);
    let tile_x = appearance.tile_index % width;
    let tile_y = appearance.tile_index / width;
    let center = [
        tile_x as f32 + object_axis_center_offset_256(half_extents[0]) as f32 / 256.0,
        tile_y as f32 + object_axis_center_offset_256(half_extents[1]) as f32 / 256.0,
    ];
    Admission::footprint(center, half_extents)
}

pub(super) enum VisitOrder<'a> {
    All(std::ops::Range<usize>),
    Subset(std::slice::Iter<'a, u32>),
}

impl VisitOrder<'_> {
    pub(super) fn of(subset: Option<&[u32]>, count: usize) -> VisitOrder<'_> {
        subset.map_or(VisitOrder::All(0..count), |subset| {
            VisitOrder::Subset(subset.iter())
        })
    }
}

impl Iterator for VisitOrder<'_> {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        match self {
            Self::All(range) => range.next(),
            Self::Subset(indices) => indices.next().map(|index| *index as usize),
        }
    }
}

pub(super) enum RosterOrder<A, B> {
    All(A),
    Tiles(B),
}

impl<A, B, T> Iterator for RosterOrder<A, B>
where
    A: Iterator<Item = T>,
    B: Iterator<Item = T>,
{
    type Item = T;

    fn next(&mut self) -> Option<T> {
        match self {
            Self::All(members) => members.next(),
            Self::Tiles(members) => members.next(),
        }
    }
}

pub(super) fn decide<T: PartialEq + std::fmt::Debug>(
    check: OracleCheck,
    route: impl Fn(bool) -> T,
    context: impl FnOnce() -> String,
) -> T {
    match placement_oracle::mode() {
        PlacementCheckMode::Accelerated => route(true),
        PlacementCheckMode::Reference => route(false),
        PlacementCheckMode::Differential => {
            let reference = route(false);
            let accelerated = route(true);
            placement_oracle::compare(check, &reference, &accelerated, context);
            reference
        }
    }
}

pub(super) fn decide_obstruction(
    check: OracleCheck,
    index: Option<&ObstructionIndex>,
    scan: impl Fn(Option<&ObstructionIndex>) -> Result<bool, GenerationError>,
    context: impl FnOnce() -> String,
) -> Result<bool, GenerationError> {
    let Some(index) = index else {
        return scan(None);
    };
    match placement_oracle::mode() {
        PlacementCheckMode::Accelerated => scan(Some(index)),
        PlacementCheckMode::Reference => scan(None),
        PlacementCheckMode::Differential => {
            let reference = scan(None);
            let accelerated = scan(Some(index));
            placement_oracle::compare(check, &reference, &accelerated, context);
            reference
        }
    }
}

pub(super) struct WindowSums {
    width: usize,
    height: usize,
    sums: Vec<u32>,
    stale: bool,
    scanned: usize,
}

impl WindowSums {
    pub(super) fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            sums: Vec::new(),
            stale: true,
            scanned: 0,
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.stale = true;
    }

    pub(super) fn any(
        &mut self,
        [minimum_x, minimum_y]: [usize; 2],
        [maximum_x, mut maximum_y]: [usize; 2],
        count: impl Fn(usize) -> u32,
    ) -> bool {
        debug_assert!(minimum_x <= maximum_x && maximum_x < self.width);
        debug_assert!(minimum_y <= maximum_y && maximum_y < self.height);
        if placement_oracle::fault() == AcceleratorFault::WindowSumsDropLastRow
            && maximum_y > minimum_y
        {
            maximum_y -= 1;
        }
        if self.stale {
            let cells = (maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1);
            self.scanned = self.scanned.saturating_add(cells);
            if self.scanned < self.width * self.height {
                return (minimum_y..=maximum_y).any(|y| {
                    let row = y * self.width;
                    (row + minimum_x..=row + maximum_x).any(|tile| count(tile) > 0)
                });
            }
            self.rebuild(&count);
        }
        let stride = self.width + 1;
        let at = |x: usize, y: usize| self.sums[y * stride + x];
        let sum = at(maximum_x + 1, maximum_y + 1)
            .wrapping_sub(at(minimum_x, maximum_y + 1))
            .wrapping_sub(at(maximum_x + 1, minimum_y))
            .wrapping_add(at(minimum_x, minimum_y));
        sum > 0
    }

    fn rebuild(&mut self, count: &impl Fn(usize) -> u32) {
        let stride = self.width + 1;
        self.sums.clear();
        self.sums.resize(stride * (self.height + 1), 0);
        for y in 0..self.height {
            let mut row = 0_u32;
            for x in 0..self.width {
                row += u32::from(count(y * self.width + x) > 0);
                self.sums[(y + 1) * stride + x + 1] = self.sums[y * stride + x + 1] + row;
            }
        }
        self.stale = false;
        self.scanned = 0;
    }

    pub(super) fn build(&mut self, count: impl Fn(usize) -> u32) {
        self.rebuild(&count);
    }
}

#[derive(Default)]
pub(super) struct LiveClassIndex {
    state: RefCell<LiveClassState>,
}

#[derive(Default)]
struct LiveClassState {
    dimensions: Option<MapDimensions>,
    classes: BTreeMap<u32, LiveClassCounts>,
    next_identity: u32,
    incomplete_members: usize,
    destructions: usize,
    counted: BTreeMap<u32, (u32, usize)>,
}

struct LiveClassCounts {
    tiles: Vec<u16>,
    sums: WindowSums,
    bits: TileBits,
    version: u64,
}

impl LiveClassCounts {
    fn add(&mut self, tile: usize, delta: i32) {
        self.write(tile, (i32::from(self.tiles[tile]) + delta) as u16);
    }

    fn write(&mut self, tile: usize, count: u16) {
        self.tiles[tile] = count;
        self.sums.invalidate();
        if self.bits.get(tile) != (count > 0) {
            self.bits.set(tile, count > 0);
            self.version = super::candidate_mask::fresh_version();
        }
    }
}

pub(super) struct LiveClasses<'a> {
    state: RefMut<'a, LiveClassState>,
}

impl LiveClassIndex {
    pub(super) fn synchronized<'a>(
        &'a self,
        tracked_classes: impl Iterator<Item = u32> + Clone,
        roster: &'a super::super::exact_world::ObjectRoster,
        content: CompatibleContentView<'a>,
    ) -> Option<LiveClasses<'a>> {
        let dimensions = roster.dimensions()?;
        let tile_count = usize::from(dimensions.width) * usize::from(dimensions.height);
        let mut state = self.state.try_borrow_mut().ok()?;
        if state.dimensions != Some(dimensions)
            || roster.next_identity() < state.next_identity
            || roster.destruction_count() < state.destructions
            || !state.classes.keys().copied().eq(tracked_classes.clone())
        {
            *state = LiveClassState {
                dimensions: Some(dimensions),
                classes: tracked_classes
                    .map(|class| {
                        (
                            class,
                            LiveClassCounts {
                                tiles: vec![0; tile_count],
                                sums: WindowSums::new(
                                    usize::from(dimensions.width),
                                    usize::from(dimensions.height),
                                ),
                                bits: TileBits::for_dimensions(dimensions),
                                version: super::candidate_mask::fresh_version(),
                            },
                        )
                    })
                    .collect(),
                ..LiveClassState::default()
            };
        }
        let state_ref = &mut *state;
        let births = if roster.next_identity() > state_ref.next_identity {
            Some(roster.objects_from(state_ref.next_identity))
        } else {
            None
        };
        for (identity, object) in births.into_iter().flatten() {
            if !roster.members(object.tile).contains(&identity) {
                continue;
            }
            let Some(master) = content.object(object.object_id) else {
                state_ref.incomplete_members += 1;
                continue;
            };
            if let Some(counts) = state_ref.classes.get_mut(&master.class_id) {
                let tile = usize::from(object.tile.y) * usize::from(dimensions.width)
                    + usize::from(object.tile.x);
                if counts.tiles[tile] < u16::MAX {
                    counts.add(tile, 1);
                    state_ref.counted.insert(identity, (master.class_id, tile));
                } else {
                    state_ref.incomplete_members += 1;
                }
            }
        }
        state_ref.next_identity = roster.next_identity();
        let ignore_destructions =
            placement_oracle::fault() == AcceleratorFault::LiveClassCountsIgnoreSurvivors;
        for identity in roster.destructions_since(state_ref.destructions) {
            if let Some((class, tile)) = state_ref.counted.remove(identity)
                && let Some(counts) = state_ref.classes.get_mut(&class)
            {
                counts.add(tile, -1);
                if ignore_destructions {
                    counts.write(tile, 0);
                }
            }
        }
        state_ref.destructions = roster.destruction_count();
        (state_ref.incomplete_members == 0).then_some(LiveClasses { state })
    }
}

impl LiveClasses<'_> {
    pub(super) fn presence(&self, class_id: u32) -> Option<(u64, &TileBits)> {
        let counts = self.state.classes.get(&class_id)?;
        Some((counts.version, &counts.bits))
    }

    pub(super) fn any_in_window(
        &mut self,
        class_id: u32,
        [minimum_x, minimum_y]: [u32; 2],
        [maximum_x, maximum_y]: [u32; 2],
    ) -> Option<bool> {
        let dimensions = self.state.dimensions?;
        if minimum_x > maximum_x
            || minimum_y > maximum_y
            || maximum_x >= u32::from(dimensions.width)
            || maximum_y >= u32::from(dimensions.height)
        {
            return None;
        }
        let LiveClassCounts { tiles, sums, .. } = self.state.classes.get_mut(&class_id)?;
        Some(sums.any(
            [minimum_x as usize, minimum_y as usize],
            [maximum_x as usize, maximum_y as usize],
            |tile| u32::from(tiles[tile]),
        ))
    }
}

#[derive(Default)]
pub(super) struct ActorAreaIndex {
    dimensions: Option<MapDimensions>,
    columns: usize,
    rows: usize,
    buckets: Vec<Vec<u32>>,
    wide: Vec<u32>,
    by_id: BTreeMap<i32, AreaIdLists>,
    rasters: BTreeMap<i32, Vec<u32>>,
    raster_ids: BTreeSet<i32>,
    list_slots: RefCell<BTreeMap<Vec<i32>, usize>>,
    list_rasters: RefCell<Vec<ListRaster>>,
    raster_cells: std::cell::Cell<usize>,
    areas: Vec<ExactActorArea>,
    invalid: bool,
    avoid_masks: RefCell<Vec<AvoidMask>>,
}

struct AvoidMask {
    ids: Option<Vec<i32>>,
    painted: usize,
    last: Option<ExactActorArea>,
    bits: std::rc::Rc<TileBits>,
}

const AVOID_MASKS: usize = 32;

const RASTER_MINIMUM_AREAS: usize = 8;
const MAXIMUM_RASTER_CELLS: usize = 16 * 1024 * 1024;

struct ListRaster {
    ids: Vec<i32>,
    cells: ListCells,
}

enum ListCells {
    Unpainted,
    Painted(Vec<u32>),
    Refused,
}

#[derive(Default)]
pub(super) struct AreaIdLists {
    buckets: Vec<Vec<u32>>,
    wide: Vec<u32>,
    areas: usize,
}

fn filed_area(area: &ExactActorArea) -> (i32, i32) {
    let id = if placement_oracle::fault() == AcceleratorFault::ActorAreaIdBucketsMisfiled {
        area.id.wrapping_add(1)
    } else {
        area.id
    };
    let radius = if placement_oracle::fault() == AcceleratorFault::ActorAreaIgnoresRadius {
        0
    } else {
        area.radius
    };
    (id, radius)
}

impl ActorAreaIndex {
    pub(super) fn push(&mut self, area: ExactActorArea, dimensions: MapDimensions) {
        if self.invalid {
            return;
        }
        if self.dimensions.is_none() {
            self.dimensions = Some(dimensions);
            self.columns = bucket_count(dimensions.width);
            self.rows = bucket_count(dimensions.height);
            self.buckets = vec![Vec::new(); self.columns * self.rows];
        }
        let (Some(indexed), Ok(index)) = (self.dimensions, u32::try_from(self.areas.len())) else {
            self.invalid = true;
            return;
        };
        if indexed != dimensions || dimensions.width == 0 || dimensions.height == 0 {
            self.invalid = true;
            return;
        }
        self.areas.push(area);
        let (filed_id, radius) = filed_area(&area);
        for raster in self.list_rasters.get_mut() {
            if let ListCells::Painted(cells) = &mut raster.cells
                && raster.ids.binary_search(&filed_id).is_ok()
            {
                paint_containment(cells, index, area.center, radius, dimensions);
            }
        }
        if let Some(raster) = self.rasters.get_mut(&filed_id) {
            paint_containment(raster, index, area.center, radius, dimensions);
        } else if self.raster_ids.contains(&filed_id)
            && self
                .by_id
                .get(&filed_id)
                .is_some_and(|lists| lists.areas + 1 >= RASTER_MINIMUM_AREAS)
        {
            self.add_raster(filed_id, dimensions);
        }
        let cells = self.columns * self.rows;
        let id_lists = self.by_id.entry(filed_id).or_default();
        id_lists.areas += 1;
        let Some([minimum_x, maximum_x, minimum_y, maximum_y]) =
            super::actor_area_tile_bounds(area.center, radius, dimensions)
        else {
            self.wide.push(index);
            id_lists.wide.push(index);
            return;
        };
        let minimum_x = usize::from(minimum_x) / BUCKET_TILES;
        let minimum_y = usize::from(minimum_y) / BUCKET_TILES;
        let maximum_x = usize::from(maximum_x) / BUCKET_TILES;
        let maximum_y = usize::from(maximum_y) / BUCKET_TILES;
        let covered = (maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1);
        if covered > WIDE_ACTOR_AREA_BUCKETS {
            self.wide.push(index);
            id_lists.wide.push(index);
            return;
        }
        if id_lists.buckets.is_empty() {
            id_lists.buckets = vec![Vec::new(); cells];
        }
        for row in minimum_y..=maximum_y {
            for column in minimum_x..=maximum_x {
                self.buckets[row * self.columns + column].push(index);
                id_lists.buckets[row * self.columns + column].push(index);
            }
        }
    }

    pub(super) fn enable_rasters(&mut self, ids: impl IntoIterator<Item = i32>) {
        self.raster_ids.extend(ids);
        let ready: Vec<i32> = self
            .by_id
            .iter()
            .filter(|(id, lists)| {
                self.raster_ids.contains(id) && lists.areas >= RASTER_MINIMUM_AREAS
            })
            .map(|(id, _)| *id)
            .collect();
        if let Some(dimensions) = self.dimensions.filter(|_| !self.invalid) {
            for id in ready {
                self.add_raster(id, dimensions);
            }
        }
    }

    fn add_raster(&mut self, id: i32, dimensions: MapDimensions) {
        let cells = usize::from(dimensions.width) * usize::from(dimensions.height);
        if self.rasters.contains_key(&id)
            || self.raster_cells.get().saturating_add(cells) > MAXIMUM_RASTER_CELLS
        {
            return;
        }
        self.raster_cells.set(self.raster_cells.get() + cells);
        let mut raster = vec![u32::MAX; cells];
        for (index, area) in self.areas.iter().enumerate() {
            let (filed_id, radius) = filed_area(area);
            if filed_id == id {
                paint_containment(&mut raster, index as u32, area.center, radius, dimensions);
            }
        }
        self.rasters.insert(id, raster);
    }

    fn list_witness(&self, ids: &[i32], tile: usize) -> Option<u32> {
        let slot = self.list_slot(ids)?;
        self.slot_witness(slot, tile)
    }

    fn list_slot(&self, ids: &[i32]) -> Option<usize> {
        self.dimensions?;
        let mut slots = self.list_slots.try_borrow_mut().ok()?;
        if let Some(&slot) = slots.get(ids) {
            return Some(slot);
        }
        let mut rasters = self.list_rasters.try_borrow_mut().ok()?;
        let mut sorted = ids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        rasters.push(ListRaster {
            ids: sorted,
            cells: ListCells::Unpainted,
        });
        slots.insert(ids.to_vec(), rasters.len() - 1);
        Some(rasters.len() - 1)
    }

    fn slot_witness(&self, slot: usize, tile: usize) -> Option<u32> {
        let dimensions = self.dimensions?;
        let mut rasters = self.list_rasters.try_borrow_mut().ok()?;
        let raster = rasters.get_mut(slot)?;
        if matches!(raster.cells, ListCells::Unpainted) {
            let cells = usize::from(dimensions.width) * usize::from(dimensions.height);
            raster.cells = if self.raster_cells.get().saturating_add(cells) <= MAXIMUM_RASTER_CELLS
            {
                self.raster_cells.set(self.raster_cells.get() + cells);
                let mut painted = vec![u32::MAX; cells];
                for (index, area) in self.areas.iter().enumerate() {
                    let (filed_id, radius) = filed_area(area);
                    if raster.ids.binary_search(&filed_id).is_ok() {
                        paint_containment(
                            &mut painted,
                            index as u32,
                            area.center,
                            radius,
                            dimensions,
                        );
                    }
                }
                ListCells::Painted(painted)
            } else {
                ListCells::Refused
            };
        }
        match &raster.cells {
            ListCells::Painted(cells) => cells.get(tile).copied(),
            ListCells::Unpainted | ListCells::Refused => None,
        }
    }

    fn describes_prefix(&self, areas: &[ExactActorArea]) -> bool {
        !self.invalid
            && areas.len() <= self.areas.len()
            && areas.last()
                == areas
                    .len()
                    .checked_sub(1)
                    .and_then(|last| self.areas.get(last))
    }

    fn bucket_position(&self, coordinate: MapCoordinate) -> Option<usize> {
        let dimensions = self.dimensions?;
        if coordinate.x >= dimensions.width || coordinate.y >= dimensions.height {
            return None;
        }
        let column = usize::from(coordinate.x) / BUCKET_TILES;
        let row = usize::from(coordinate.y) / BUCKET_TILES;
        let position = row * self.columns + column;
        (position < self.buckets.len()).then_some(position)
    }
}

#[derive(Clone, Copy)]
pub(super) struct ActorAreas<'a> {
    areas: &'a [ExactActorArea],
    index: Option<&'a ActorAreaIndex>,
    avoid: Option<AvoidList<'a>>,
}

#[derive(Clone, Copy)]
pub(super) struct AvoidList<'a> {
    ids: &'a [i32],
    slot: usize,
}

impl<'a> ActorAreas<'a> {
    pub(super) fn reference(areas: &'a [ExactActorArea]) -> Self {
        Self {
            areas,
            index: None,
            avoid: None,
        }
    }

    pub(super) fn indexed(areas: &'a [ExactActorArea], index: &'a ActorAreaIndex) -> Self {
        Self {
            areas,
            index: Some(index),
            avoid: None,
        }
    }

    pub(super) fn for_request(mut self, ids: &'a [i32]) -> Self {
        if let Some(index) = self.index
            && !ids.is_empty()
            && let Some(mut slot) = index.list_slot(ids)
        {
            if placement_oracle::fault() == AcceleratorFault::AvoidListResolvesStale {
                slot = 0;
            }
            self.avoid = Some(AvoidList { ids, slot });
        }
        self
    }

    pub(super) fn blocked_mask(
        self,
        ids: &[i32],
        all: bool,
        dimensions: MapDimensions,
    ) -> std::rc::Rc<TileBits> {
        let key = (!all).then(|| {
            let mut sorted = ids.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            sorted
        });
        let avoided = |area: &ExactActorArea| {
            key.as_ref()
                .is_none_or(|ids| ids.binary_search(&area.id).is_ok())
        };
        let paint = |bits: &mut TileBits, areas: &[ExactActorArea]| {
            for area in areas.iter().filter(|area| avoided(area)) {
                if let Some([minimum_x, maximum_x, minimum_y, maximum_y]) =
                    super::actor_area_tile_bounds(area.center, area.radius, dimensions)
                {
                    for y in minimum_y..=maximum_y {
                        bits.fill_span(
                            usize::from(y),
                            usize::from(minimum_x),
                            usize::from(maximum_x),
                        );
                    }
                }
            }
        };
        let areas = self.areas;
        if placement_oracle::fault() == AcceleratorFault::AvoidMaskSkipsNewestArea {
            let mut bits = TileBits::for_dimensions(dimensions);
            paint(&mut bits, &areas[..areas.len().saturating_sub(1)]);
            return std::rc::Rc::new(bits);
        }
        let fresh = || {
            let mut bits = TileBits::for_dimensions(dimensions);
            paint(&mut bits, areas);
            std::rc::Rc::new(bits)
        };
        let Some(mut masks) = self
            .index
            .and_then(|index| index.avoid_masks.try_borrow_mut().ok())
        else {
            return fresh();
        };
        let position = masks.iter().position(|mask| mask.ids == key);
        if let Some(mask) = position.map(|position| &mut masks[position])
            && mask.bits.has_shape(dimensions)
            && mask.painted <= areas.len()
            && mask.last.as_ref() == mask.painted.checked_sub(1).map(|last| &areas[last])
        {
            if mask.painted < areas.len() {
                paint(
                    std::rc::Rc::make_mut(&mut mask.bits),
                    &areas[mask.painted..],
                );
                mask.painted = areas.len();
                mask.last = areas.last().copied();
            }
            return mask.bits.clone();
        }
        let bits = fresh();
        let entry = AvoidMask {
            ids: key.clone(),
            painted: areas.len(),
            last: areas.last().copied(),
            bits: bits.clone(),
        };
        match position {
            Some(position) => masks[position] = entry,
            None => {
                if masks.len() >= AVOID_MASKS {
                    masks.remove(0);
                }
                masks.push(entry);
            }
        }
        bits
    }

    pub(super) fn decide(
        self,
        coordinate: MapCoordinate,
        predicate: impl Fn(AreaCandidates<'a>) -> bool,
    ) -> bool {
        let full = AreaCandidates::All(self.areas);
        let indexed = self.index.and_then(|index| {
            if !index.describes_prefix(self.areas) {
                return None;
            }
            let position = index.bucket_position(coordinate)?;
            Some(AreaCandidates::Indexed {
                areas: self.areas,
                bucket: &index.buckets[position],
                wide: &index.wide,
                by_id: Some(IdLookup {
                    index,
                    bucket: position,
                    tile: usize::from(coordinate.y) * usize::from(index.dimensions?.width)
                        + usize::from(coordinate.x),
                    avoid: self.avoid,
                }),
            })
        });
        let Some(indexed) = indexed else {
            return predicate(full);
        };
        match placement_oracle::mode() {
            PlacementCheckMode::Accelerated => predicate(indexed),
            PlacementCheckMode::Reference => predicate(full),
            PlacementCheckMode::Differential => {
                let reference = predicate(full);
                let accelerated = predicate(indexed);
                placement_oracle::compare(OracleCheck::ActorArea, &reference, &accelerated, || {
                    format!("coordinate {coordinate:?}, {} areas", self.areas.len())
                });
                reference
            }
        }
    }
}

impl<'a> From<&'a [ExactActorArea]> for ActorAreas<'a> {
    fn from(areas: &'a [ExactActorArea]) -> Self {
        Self::reference(areas)
    }
}

impl<'a> From<&'a Vec<ExactActorArea>> for ActorAreas<'a> {
    fn from(areas: &'a Vec<ExactActorArea>) -> Self {
        Self::reference(areas)
    }
}

impl<'a, const N: usize> From<&'a [ExactActorArea; N]> for ActorAreas<'a> {
    fn from(areas: &'a [ExactActorArea; N]) -> Self {
        Self::reference(areas)
    }
}

#[derive(Clone, Copy)]
pub(super) enum AreaCandidates<'a> {
    All(&'a [ExactActorArea]),
    Indexed {
        areas: &'a [ExactActorArea],
        bucket: &'a [u32],
        wide: &'a [u32],
        by_id: Option<IdLookup<'a>>,
    },
}

#[derive(Clone, Copy)]
pub(super) struct IdLookup<'a> {
    index: &'a ActorAreaIndex,
    bucket: usize,
    tile: usize,
    avoid: Option<AvoidList<'a>>,
}

fn paint_containment(
    raster: &mut [u32],
    index: u32,
    center: ActorAreaCenter,
    radius: i32,
    dimensions: MapDimensions,
) {
    let width = usize::from(dimensions.width);
    let Some([minimum_x, maximum_x, minimum_y, maximum_y]) =
        super::actor_area_tile_bounds(center, radius, dimensions)
    else {
        return;
    };
    for y in minimum_y..=maximum_y {
        let row = usize::from(y) * width;
        for cell in &mut raster[row + usize::from(minimum_x)..=row + usize::from(maximum_x)] {
            *cell = (*cell).min(index);
        }
    }
}

impl<'a> AreaCandidates<'a> {
    pub(super) fn with_id(self, id: i32) -> impl Iterator<Item = &'a ExactActorArea> {
        let (all, indexed) = match self {
            Self::Indexed {
                areas,
                by_id: Some(lookup),
                ..
            } => {
                let lists = lookup.index.by_id.get(&id);
                let bucket = lists
                    .and_then(|lists| lists.buckets.get(lookup.bucket))
                    .map_or(&[][..], Vec::as_slice);
                let wide = lists.map_or(&[][..], |lists| lists.wide.as_slice());
                (None, Some((areas, bucket, wide)))
            }
            other => (Some(other), None),
        };
        all.into_iter()
            .flat_map(Self::iter)
            .chain(indexed.into_iter().flat_map(|(areas, bucket, wide)| {
                bucket
                    .iter()
                    .chain(wide)
                    .filter_map(move |index| areas.get(*index as usize))
            }))
    }

    pub(super) fn containing_with_id(self, id: i32) -> impl Iterator<Item = &'a ExactActorArea> {
        let witness = match self {
            Self::Indexed {
                areas,
                by_id: Some(lookup),
                ..
            } => lookup.index.rasters.get(&id).map(|raster| {
                raster
                    .get(lookup.tile)
                    .and_then(|&index| areas.get(index as usize))
            }),
            Self::All(_) | Self::Indexed { by_id: None, .. } => None,
        };
        let (lists, witness) = match witness {
            Some(witness) => (None, witness),
            None => (Some(self.with_id(id)), None),
        };
        lists.into_iter().flatten().chain(witness)
    }

    pub(super) fn containing_any_id(
        self,
        ids: &[i32],
    ) -> Option<impl Iterator<Item = &'a ExactActorArea>> {
        let Self::Indexed {
            areas,
            by_id: Some(lookup),
            ..
        } = self
        else {
            return None;
        };
        if ids.is_empty() {
            return None;
        }
        let witness = match lookup.avoid {
            Some(avoid) if std::ptr::eq(avoid.ids, ids) => {
                lookup.index.slot_witness(avoid.slot, lookup.tile)?
            }
            _ => lookup.index.list_witness(ids, lookup.tile)?,
        };
        Some(areas.get(witness as usize).into_iter())
    }

    pub(super) fn iter(self) -> impl Iterator<Item = &'a ExactActorArea> {
        let (all, indexed) = match self {
            Self::All(areas) => (areas, None),
            Self::Indexed {
                areas,
                bucket,
                wide,
                ..
            } => (&[][..], Some((areas, bucket, wide))),
        };
        all.iter()
            .chain(indexed.into_iter().flat_map(|(areas, bucket, wide)| {
                bucket
                    .iter()
                    .chain(wide)
                    .filter_map(move |index| areas.get(*index as usize))
            }))
    }
}

#[derive(Default)]
pub(super) struct LifecycleProjection {
    projected: usize,
    last_identity: Option<u32>,
    changes: usize,
    targets: Vec<usize>,
}

impl LifecycleProjection {
    pub(super) fn reset(&mut self) {
        let targets = std::mem::take(&mut self.targets);
        *self = Self {
            targets,
            ..Self::default()
        };
    }

    pub(super) fn project(
        &mut self,
        objects: &mut [PlacedObject],
        roster: &super::super::exact_world::ObjectRoster,
    ) -> bool {
        let change_count = roster.lifecycle_change_count();
        if self.projected > objects.len()
            || self.changes > change_count
            || (self.projected > 0
                && Some(objects[self.projected - 1].instance_id) != self.last_identity)
        {
            self.reset();
        }
        let ignore_changes =
            placement_oracle::fault() == AcceleratorFault::LifecycleProjectionIgnoresChanges;
        let mut targets = std::mem::take(&mut self.targets);
        targets.clear();
        if !ignore_changes {
            let projected = &objects[..self.projected];
            for identity in roster.lifecycle_changes_since(self.changes) {
                if let Ok(index) =
                    projected.binary_search_by_key(identity, |object| object.instance_id)
                {
                    targets.push(index);
                }
            }
        }
        for index in self.projected..objects.len() {
            if index > 0 && objects[index - 1].instance_id >= objects[index].instance_id {
                self.targets = targets;
                return false;
            }
            targets.push(index);
        }
        for &index in &targets {
            let object = &objects[index];
            if roster.was_destroyed(object.instance_id) {
                continue;
            }
            let Some(live) = roster.object(object.instance_id) else {
                self.targets = targets;
                return false;
            };
            if live.object_id != object.object_id || live.owner != object.owner {
                self.targets = targets;
                return false;
            }
        }
        for &index in &targets {
            let object = &mut objects[index];
            if let Some(live) = roster.object(object.instance_id) {
                object.status = i32::from(live.lifecycle);
                object.death_state = i8::from_ne_bytes([live.lifecycle]);
            }
        }
        self.projected = objects.len();
        self.last_identity = objects.last().map(|object| object.instance_id);
        self.changes = change_count;
        self.targets = targets;
        true
    }
}

#[derive(Default)]
pub(super) struct ListClassIndex {
    state: RefCell<ListClassState>,
    pub(super) appearances: AppearanceClassIndex,
}

#[derive(Default)]
struct ListClassState {
    dimensions: Option<MapDimensions>,
    columns: usize,
    rows: usize,
    entries: Vec<Option<(u32, [u32; 2])>>,
    last_identity: Option<u32>,
    incomplete: usize,
    classes: BTreeMap<u32, ClassBuckets>,
    visits: Vec<u32>,
}

#[derive(Default)]
struct ClassBuckets {
    buckets: Vec<Vec<u32>>,
    outside: Vec<u32>,
}

impl ListClassState {
    fn file(&mut self, class_id: u32, index: usize) {
        let Some(Some((class, tile))) = self.entries.get(index).copied() else {
            return;
        };
        let Some(buckets) = self.classes.get_mut(&class) else {
            return;
        };
        debug_assert_eq!(class, class_id);
        let (column, row) = (
            tile[0] as usize / BUCKET_TILES,
            tile[1] as usize / BUCKET_TILES,
        );
        if column < self.columns && row < self.rows {
            buckets.buckets[row * self.columns + column].push(index as u32);
        } else {
            buckets.outside.push(index as u32);
        }
    }
}

pub(super) struct ListClassVisits<'a> {
    state: RefMut<'a, ListClassState>,
}

impl ListClassVisits<'_> {
    pub(super) fn indices(&self) -> &[u32] {
        &self.state.visits
    }
}

impl ListClassIndex {
    pub(super) fn visits(
        &self,
        objects: &[PlacedObject],
        content: CompatibleContentView<'_>,
        dimensions: MapDimensions,
        class_id: u32,
        coordinate: MapCoordinate,
        [negative, positive]: [u32; 2],
    ) -> Option<ListClassVisits<'_>> {
        let mut state = self.state.try_borrow_mut().ok()?;
        let indexed = state.entries.len();
        if state.dimensions != Some(dimensions)
            || indexed > objects.len()
            || (indexed > 0 && Some(objects[indexed - 1].instance_id) != state.last_identity)
        {
            let visits = std::mem::take(&mut state.visits);
            *state = ListClassState {
                dimensions: Some(dimensions),
                columns: usize::from(dimensions.width) / BUCKET_TILES + 1,
                rows: usize::from(dimensions.height) / BUCKET_TILES + 1,
                visits,
                ..ListClassState::default()
            };
        }
        let state_ref = &mut *state;
        let indexed = state_ref.entries.len();
        for (index, object) in objects.iter().enumerate().skip(indexed) {
            let entry = content
                .object(object.object_id)
                .map(|master| (master.class_id, [object.x_256 / 256, object.y_256 / 256]));
            state_ref.entries.push(entry);
            state_ref.last_identity = Some(object.instance_id);
            match entry {
                None => state_ref.incomplete += 1,
                Some((class, _)) => state_ref.file(class, index),
            }
        }
        if state_ref.incomplete > 0 {
            return None;
        }
        if !state_ref.classes.contains_key(&class_id) {
            state_ref.classes.insert(
                class_id,
                ClassBuckets {
                    buckets: vec![Vec::new(); state_ref.columns * state_ref.rows],
                    outside: Vec::new(),
                },
            );
            for index in 0..state_ref.entries.len() {
                if state_ref.entries[index].is_some_and(|(class, _)| class == class_id) {
                    state_ref.file(class_id, index);
                }
            }
        }
        let (negative, positive) =
            if placement_oracle::fault() == AcceleratorFault::ListClassFilterIgnoresWindow {
                (0, 0)
            } else {
                (negative, positive)
            };
        let bucket_range = |center: u16, count: usize| {
            let first = u32::from(center).saturating_sub(negative) as usize / BUCKET_TILES;
            let last =
                (u32::from(center).saturating_add(positive) as usize / BUCKET_TILES).min(count - 1);
            (first <= last).then_some(first..=last)
        };
        let buckets = &state_ref.classes[&class_id];
        state_ref.visits.clear();
        state_ref.visits.extend_from_slice(&buckets.outside);
        if let (Some(columns), Some(rows)) = (
            bucket_range(coordinate.x, state_ref.columns),
            bucket_range(coordinate.y, state_ref.rows),
        ) {
            for row in rows {
                for column in columns.clone() {
                    state_ref
                        .visits
                        .extend_from_slice(&buckets.buckets[row * state_ref.columns + column]);
                }
            }
        }
        state_ref.visits.sort_unstable();
        Some(ListClassVisits { state })
    }
}

#[derive(Default)]
pub(super) struct AppearanceClassIndex {
    state: RefCell<AppearanceClassState>,
}

#[derive(Default)]
struct AppearanceClassState {
    source: Option<(usize, usize, usize)>,
    sorted: bool,
    width: usize,
    height: usize,
    columns: usize,
    starts: [Vec<u32>; 2],
    classes: BTreeMap<u32, AppearanceClassCounts>,
}

struct AppearanceClassCounts {
    tiles: Vec<u16>,
    buckets: Vec<u32>,
    sums: WindowSums,
    current: WindowSums,
    current_version: Option<TerrainVersion>,
    occupied: Vec<u32>,
    presence: Option<(TerrainVersion, u64, std::rc::Rc<TileBits>)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TerrainVersion {
    writes: u64,
    address: usize,
    len: usize,
}

impl TerrainVersion {
    pub(super) fn of(terrain: &[TerrainId], writes: u64) -> Self {
        Self {
            writes,
            address: terrain.as_ptr() as usize,
            len: terrain.len(),
        }
    }
}

impl AppearanceClassIndex {
    fn prepared(
        &self,
        appearances: &TerrainAppearanceObjects,
        class_id: u32,
        content: CompatibleContentView<'_>,
    ) -> Option<RefMut<'_, AppearanceClassState>> {
        let dimensions = appearances.dimensions;
        if dimensions.width == 0 || dimensions.height == 0 {
            return None;
        }
        let mut state = self.state.try_borrow_mut().ok()?;
        let lists = [&appearances.module_entry_objects, &appearances.objects];
        let source = (
            std::ptr::from_ref(appearances) as usize,
            lists[0].len(),
            lists[1].len(),
        );
        if state.source != Some(source) {
            let width = usize::from(dimensions.width);
            let height = usize::from(dimensions.height);
            let tile_count = width * height;
            let ascending = |list: &[ExactAppearanceObject]| {
                list.windows(2)
                    .all(|pair| pair[0].tile_index <= pair[1].tile_index)
            };
            let sorted = ascending(lists[0]) && ascending(lists[1]);
            let starts = if sorted {
                lists.map(|list| {
                    (0..=tile_count)
                        .map(|tile| {
                            list.partition_point(|appearance| {
                                (appearance.tile_index as usize) < tile
                            }) as u32
                        })
                        .collect()
                })
            } else {
                [Vec::new(), Vec::new()]
            };
            *state = AppearanceClassState {
                source: Some(source),
                sorted,
                width,
                height,
                columns: bucket_count(dimensions.width),
                starts,
                classes: BTreeMap::new(),
            };
        }
        if !state.sorted {
            return None;
        }
        let (width, height, columns) = (state.width, state.height, state.columns);
        state.classes.entry(class_id).or_insert_with(|| {
            let mut counts = AppearanceClassCounts {
                tiles: vec![0; width * height],
                buckets: vec![0; columns * bucket_count(dimensions.height)],
                sums: WindowSums::new(width, height),
                current: WindowSums::new(width, height),
                current_version: None,
                occupied: Vec::new(),
                presence: None,
            };
            for appearance in lists.iter().flat_map(|list| list.iter()) {
                let tile = appearance.tile_index as usize;
                if tile >= width * height
                    || content
                        .object(appearance.object_id)
                        .is_none_or(|master| master.class_id != class_id)
                {
                    continue;
                }
                counts.tiles[tile] = counts.tiles[tile].saturating_add(1);
                counts.buckets
                    [(tile / width) / BUCKET_TILES * columns + (tile % width) / BUCKET_TILES] += 1;
            }
            counts.occupied = (0..width * height)
                .filter(|&tile| counts.tiles[tile] > 0)
                .map(|tile| tile as u32)
                .collect();
            let tiles = &counts.tiles;
            counts.sums.build(|tile| u32::from(tiles[tile]));
            counts
        });
        Some(state)
    }

    pub(super) fn presence(
        &self,
        appearances: &TerrainAppearanceObjects,
        class_id: u32,
        matches: impl Fn(&ExactAppearanceObject, usize) -> bool,
        content: CompatibleContentView<'_>,
        version: TerrainVersion,
    ) -> Option<(u64, std::rc::Rc<TileBits>)> {
        let lists = [&appearances.module_entry_objects, &appearances.objects];
        let mut state = self.prepared(appearances, class_id, content)?;
        let state = &mut *state;
        let (width, height) = (state.width, state.height);
        let starts = &state.starts;
        let counts = state.classes.get_mut(&class_id)?;
        if let Some((known, presence_version, bits)) = &counts.presence
            && *known == version
        {
            return Some((*presence_version, bits.clone()));
        }
        let mut bits = TileBits::new(width, height);
        for &tile in &counts.occupied {
            let tile = tile as usize;
            if lists.iter().zip(starts).any(|(list, starts)| {
                list[starts[tile] as usize..starts[tile + 1] as usize]
                    .iter()
                    .any(|appearance| matches(appearance, tile))
            }) {
                bits.set(tile, true);
            }
        }
        let presence = (
            super::candidate_mask::fresh_version(),
            std::rc::Rc::new(bits),
        );
        counts.presence = Some((version, presence.0, presence.1.clone()));
        Some(presence)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn any_in_window(
        &self,
        appearances: &TerrainAppearanceObjects,
        class_id: u32,
        coordinate: MapCoordinate,
        [minimum_x, minimum_y]: [u32; 2],
        [maximum_x, maximum_y]: [u32; 2],
        matches: impl Fn(&ExactAppearanceObject, usize) -> bool,
        content: CompatibleContentView<'_>,
        version: Option<TerrainVersion>,
    ) -> Option<bool> {
        let lists = [&appearances.module_entry_objects, &appearances.objects];
        let mut state = self.prepared(appearances, class_id, content)?;
        let state = &mut *state;
        let (width, height, columns) = (state.width, state.height, state.columns);
        let counts = state.classes.get_mut(&class_id)?;
        let (minimum_x, maximum_x, minimum_y, maximum_y) =
            if placement_oracle::fault() == AcceleratorFault::AppearanceClassIndexIgnoresWindow {
                let (x, y) = (u32::from(coordinate.x), u32::from(coordinate.y));
                (x, x, y, y)
            } else {
                (minimum_x, maximum_x, minimum_y, maximum_y)
            };
        if minimum_x > maximum_x
            || minimum_y > maximum_y
            || maximum_x as usize >= width
            || maximum_y as usize >= height
        {
            return None;
        }
        let (minimum_x, maximum_x) = (minimum_x as usize, maximum_x as usize);
        let (minimum_y, maximum_y) = (minimum_y as usize, maximum_y as usize);
        let tiles = &counts.tiles;
        if !counts
            .sums
            .any([minimum_x, minimum_y], [maximum_x, maximum_y], |tile| {
                u32::from(tiles[tile])
            })
        {
            return Some(false);
        }
        if let Some(version) = version {
            if counts.current_version != Some(version) {
                counts.current.invalidate();
                counts.current_version = Some(version);
            }
            let starts = &state.starts;
            let matching = |tile: usize| {
                u32::from(
                    tiles[tile] > 0
                        && lists.iter().zip(starts).any(|(list, starts)| {
                            list[starts[tile] as usize..starts[tile + 1] as usize]
                                .iter()
                                .any(|appearance| matches(appearance, tile))
                        }),
                )
            };
            return Some(counts.current.any(
                [minimum_x, minimum_y],
                [maximum_x, maximum_y],
                matching,
            ));
        }
        for row in minimum_y / BUCKET_TILES..=maximum_y / BUCKET_TILES {
            for column in minimum_x / BUCKET_TILES..=maximum_x / BUCKET_TILES {
                if counts.buckets[row * columns + column] == 0 {
                    continue;
                }
                let ys = (row * BUCKET_TILES).max(minimum_y)
                    ..=(row * BUCKET_TILES + BUCKET_TILES - 1).min(maximum_y);
                let xs = (column * BUCKET_TILES).max(minimum_x)
                    ..=(column * BUCKET_TILES + BUCKET_TILES - 1).min(maximum_x);
                for y in ys {
                    for x in xs.clone() {
                        let tile = y * width + x;
                        if counts.tiles[tile] == 0 {
                            continue;
                        }
                        for (list, starts) in lists.iter().zip(&state.starts) {
                            let run = starts[tile] as usize..starts[tile + 1] as usize;
                            if list[run].iter().any(|appearance| matches(appearance, tile)) {
                                return Some(true);
                            }
                        }
                    }
                }
            }
        }
        Some(false)
    }
}

#[derive(Default)]
pub(super) struct AppearanceObstructionIndex {
    state: RefCell<AppearanceObstructionState>,
}

#[derive(Default)]
struct AppearanceObstructionState {
    dimensions: Option<MapDimensions>,
    list: SpatialList,
    last: Option<ExactAppearanceObject>,
    visits: Vec<u32>,
}

pub(super) enum AppearanceAdmission {
    Skip,
    Always,
    Footprint {
        center: [f32; 2],
        half_extents: [f32; 2],
    },
}

pub(super) struct AppearanceObstructionVisits<'a> {
    state: RefMut<'a, AppearanceObstructionState>,
}

impl AppearanceObstructionVisits<'_> {
    pub(super) fn indices(&self) -> &[u32] {
        &self.state.visits
    }
}

impl AppearanceObstructionIndex {
    pub(super) fn visits(
        &self,
        existing: &[ExactAppearanceObject],
        dimensions: MapDimensions,
        center: [f32; 2],
        placement: [f32; 2],
        admission: impl Fn(&ExactAppearanceObject) -> AppearanceAdmission,
    ) -> Option<AppearanceObstructionVisits<'_>> {
        if !center.into_iter().chain(placement).all(bounded) {
            return None;
        }
        let mut state = self.state.try_borrow_mut().ok()?;
        let indexed = state.list.indexed;
        if state.dimensions != Some(dimensions)
            || indexed > existing.len()
            || (indexed > 0 && Some(existing[indexed - 1]) != state.last)
        {
            let visits = std::mem::take(&mut state.visits);
            *state = AppearanceObstructionState {
                dimensions: Some(dimensions),
                list: SpatialList::new(dimensions),
                last: None,
                visits,
            };
        }
        let state_ref = &mut *state;
        for appearance in &existing[state_ref.list.indexed..] {
            state_ref.list.admit(match admission(appearance) {
                AppearanceAdmission::Skip => Admission::Skip,
                AppearanceAdmission::Always => Admission::Always,
                AppearanceAdmission::Footprint {
                    center,
                    half_extents,
                } => Admission::footprint(center, half_extents),
            });
            state_ref.last = Some(*appearance);
        }
        state_ref
            .list
            .query(center, placement, &mut state_ref.visits);
        Some(AppearanceObstructionVisits { state })
    }
}
