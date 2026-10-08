use super::*;
use rms_content::{ObjectId, ObjectPathing, ObjectPositionFamily};

#[path = "exact_footprint.rs"]
mod footprint;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PrimaryRecord {
    Unavailable,
    Absent,
    Present(u8),
}

impl PrimaryRecord {
    fn positioned(pathing: Option<ObjectPathing>, lifecycle: u8) -> Self {
        if lifecycle >= 7 {
            return Self::Absent;
        }
        let Some(pathing) = pathing else {
            return Self::Unavailable;
        };
        if pathing.vertical_extent() <= 0.0
            || pathing.kind == 0
            || matches!(pathing.action, 0 | 1 | 12)
        {
            Self::Absent
        } else {
            Self::Present(if pathing.action == 10 {
                2
            } else {
                pathing.action
            })
        }
    }

    fn removed(self, pathing: Option<ObjectPathing>) -> Self {
        let Some(pathing) = pathing else {
            return Self::Unavailable;
        };
        if (pathing.vertical_extent() <= 0.0 && self == Self::Absent)
            || matches!(pathing.action, 0 | 1 | 12)
        {
            self
        } else {
            Self::Absent
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct WorldObject {
    pub object_id: ObjectId,
    pub position_family: Option<ObjectPositionFamily>,
    pub owner: u8,
    pub lifecycle: u8,
    pub hit_points_f32_bits: u32,
    pub position_bits: [u32; 2],
    pub tile: MapCoordinate,
    pub primary_record: PrimaryRecord,
    pub suppression: u8,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
enum Occupancy {
    #[default]
    Empty,
    Unavailable,
    Words(Vec<u64>),
}

#[derive(Clone, Copy, Debug)]
struct OccupancyBounds {
    left: u16,
    top: u16,
    right: u16,
    bottom: u16,
}

impl OccupancyBounds {
    fn new(
        position: [f32; 2],
        radius: [f32; 2],
        dimensions: MapDimensions,
    ) -> Result<Self, GenerationError> {
        let coordinate = |value: f32, length: u16| {
            if !value.is_finite() || !(-2147483648.0..2147483648.0).contains(&value) || length == 0
            {
                return Err(world_error("occupancy coordinate exceeds signed32 domain"));
            }
            Ok((value as i32).clamp(0, i32::from(length) - 1) as u16)
        };
        if radius
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(world_error("occupancy radius is invalid"));
        }
        Ok(Self {
            left: coordinate(position[0] - radius[0], dimensions.width)?,
            top: coordinate(position[1] - radius[1], dimensions.height)?,
            right: coordinate((position[0] + radius[0]) - 0.001, dimensions.width)?,
            bottom: coordinate((position[1] + radius[1]) - 0.001, dimensions.height)?,
        })
    }
}

fn word_bounds(
    pathing: ObjectPathing,
    position: [f32; 2],
    collision_radius: [f32; 2],
    dimensions: MapDimensions,
) -> Result<Option<OccupancyBounds>, GenerationError> {
    if !matches!(pathing.action, 1 | 2 | 10 | 11 | 13) {
        return Ok(None);
    }
    OccupancyBounds::new(
        position,
        if pathing.action == 11 {
            pathing.outline_half_extents()
        } else {
            collision_radius
        },
        dimensions,
    )
    .map(Some)
}

impl Occupancy {
    fn insert(
        &mut self,
        bounds: OccupancyBounds,
        dimensions: MapDimensions,
        owner: u8,
        kind: u8,
        identity: u32,
        sources: &mut Vec<u32>,
    ) {
        if matches!(self, Self::Empty) {
            *self = Self::Words(vec![
                0;
                usize::from(dimensions.width)
                    * usize::from(dimensions.height)
            ]);
        }
        let Self::Words(words) = self else {
            return;
        };
        if sources.len() != words.len() {
            *sources = vec![u32::MAX; words.len()];
        }
        let flags = u64::from((u32::from(kind & 63) | (u32::from(owner) << 8) | 0x40) << 8)
            | (0x80_0000_u64 << owner)
            | if kind == 5 { 0x8000 } else { 0 };
        for y in bounds.top..=bounds.bottom {
            for x in bounds.left..=bounds.right {
                let word =
                    &mut words[usize::from(y) * usize::from(dimensions.width) + usize::from(x)];
                if *word < 0x80_0000 {
                    *word = flags | (*word & 0xffff_ffff_ff00_00ff);
                    sources[usize::from(y) * usize::from(dimensions.width) + usize::from(x)] =
                        identity;
                }
            }
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct ObjectRoster {
    dimensions: Option<MapDimensions>,
    next_identity: u32,
    objects: BTreeMap<u32, WorldObject>,
    destroyed: BTreeSet<u32>,
    tiles: BTreeMap<MapCoordinate, Vec<u32>>,
    occupancy: Occupancy,
    occupancy_sources: Vec<u32>,
    footprints: footprint::Footprints,
    pub(super) path: super::exact_path::PathContext,
    history: RosterHistory,
}

#[derive(Clone, Debug, Default)]
struct RosterHistory {
    lifecycle: Vec<u32>,
    destroyed: Vec<u32>,
}

impl PartialEq for RosterHistory {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl Eq for RosterHistory {}

impl ObjectRoster {
    #[allow(clippy::too_many_arguments)]
    pub fn birth_on_terrain(
        &mut self,
        identity: u32,
        object_id: ObjectId,
        owner: u8,
        lifecycle: u8,
        position: [f32; 2],
        dimensions: MapDimensions,
        hit_points: i16,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
        position_family: Option<ObjectPositionFamily>,
        terrain: Option<&[TerrainId]>,
    ) -> Result<(), GenerationError> {
        if self.dimensions.is_some_and(|value| value != dimensions)
            || dimensions.width == 0
            || dimensions.height == 0
            || dimensions.width > 480
            || dimensions.height > 480
            || owner > 8
            || identity < self.next_identity
            || position
                .iter()
                .any(|value| !value.is_finite() || *value < 0.0)
            || position[0] >= f32::from(dimensions.width)
            || position[1] >= f32::from(dimensions.height)
        {
            return Err(world_error("invalid object birth identity or position"));
        }
        let next = identity
            .checked_add(1)
            .ok_or_else(|| world_error("world identity exhausted"))?;
        let tile = MapCoordinate {
            x: position[0] as u16,
            y: position[1] as u16,
        };
        let bounds = match pathing {
            Some(master) if lifecycle < 7 && master.vertical_extent() > 0.0 && master.kind != 0 => {
                word_bounds(master, position, collision_radius, dimensions)?
            }
            _ => None,
        };
        let publication = if bounds.is_some() && pathing.is_some_and(|master| master.action == 10) {
            footprint::Region::prepare(position, collision_radius, dimensions, true)?
        } else {
            None
        };
        let record = PrimaryRecord::positioned(pathing, lifecycle);
        self.objects.insert(
            identity,
            WorldObject {
                object_id,
                position_family,
                owner,
                lifecycle,
                hit_points_f32_bits: f32::from(hit_points).to_bits(),
                position_bits: position.map(f32::to_bits),
                tile,
                primary_record: PrimaryRecord::Absent,
                suppression: 0,
            },
        );
        let members = self.tiles.entry(tile).or_default();
        if members.len() < 250 {
            members.push(identity);
        }
        self.dimensions = Some(dimensions);
        self.next_identity = next;
        match pathing {
            None if lifecycle < 7 => {
                self.occupancy = Occupancy::Unavailable;
                self.footprints.invalidate();
                self.path.invalidate();
            }
            Some(master) => {
                if let Some(region) = publication {
                    self.footprints.insert(region, dimensions);
                }
                if let Some(bounds) = bounds {
                    self.occupancy.insert(
                        bounds,
                        dimensions,
                        owner,
                        master.kind,
                        identity,
                        &mut self.occupancy_sources,
                    );
                    self.refresh_path(bounds, terrain);
                }
            }
            _ => {}
        }
        let object = self
            .objects
            .get_mut(&identity)
            .expect("just allocated object");
        object.primary_record = record;
        Ok(())
    }

    pub fn object(&self, identity: u32) -> Option<WorldObject> {
        self.objects.get(&identity).copied()
    }

    pub fn was_destroyed(&self, identity: u32) -> bool {
        self.destroyed.contains(&identity)
    }

    pub fn has_destroyed(&self) -> bool {
        !self.destroyed.is_empty()
    }

    pub fn live_objects_in(
        &self,
        identities: std::ops::Range<u32>,
    ) -> impl Iterator<Item = (u32, WorldObject)> + '_ {
        self.objects
            .range(identities)
            .map(|(identity, object)| (*identity, *object))
    }

    pub fn registered_objects(&self) -> impl Iterator<Item = (u32, WorldObject)> + '_ {
        self.tiles.values().flatten().map(|identity| {
            (
                *identity,
                *self.objects.get(identity).expect("live tile member"),
            )
        })
    }

    pub fn members(&self, tile: MapCoordinate) -> &[u32] {
        self.tiles.get(&tile).map_or(&[], Vec::as_slice)
    }

    pub fn registered_objects_on<'a>(
        &'a self,
        tiles: &'a [MapCoordinate],
    ) -> impl Iterator<Item = (u32, WorldObject)> + 'a {
        tiles.iter().flat_map(|tile| {
            self.members(*tile).iter().map(|identity| {
                (
                    *identity,
                    *self.objects.get(identity).expect("live tile member"),
                )
            })
        })
    }

    pub fn member_tiles_in(
        &self,
        columns: std::ops::RangeInclusive<u16>,
        rows: std::ops::RangeInclusive<u16>,
        output: &mut Vec<MapCoordinate>,
    ) {
        let (first_row, last_row) = (*rows.start(), *rows.end());
        for x in columns {
            output.extend(
                self.tiles
                    .range(MapCoordinate { x, y: first_row }..=MapCoordinate { x, y: last_row })
                    .map(|(tile, _)| *tile),
            );
        }
    }

    pub fn objects_from(&self, first: u32) -> impl Iterator<Item = (u32, WorldObject)> + '_ {
        self.objects
            .range(first..)
            .map(|(identity, object)| (*identity, *object))
    }

    pub fn next_identity(&self) -> u32 {
        self.next_identity
    }

    pub fn placement_pathing_word(
        &self,
        tile: MapCoordinate,
    ) -> Result<(u64, Option<u32>), GenerationError> {
        let dimensions = self
            .dimensions
            .ok_or_else(|| world_error("placement pathing world is uninitialized"))?;
        if tile.x >= dimensions.width || tile.y >= dimensions.height {
            return Err(world_error(
                "placement pathing coordinate is outside the map",
            ));
        }
        match &self.occupancy {
            Occupancy::Empty => Ok((0, None)),
            Occupancy::Unavailable => Err(world_error("placement pathing words are unavailable")),
            Occupancy::Words(words) => {
                let index =
                    usize::from(tile.y) * usize::from(dimensions.width) + usize::from(tile.x);
                if self.occupancy_sources.len() != words.len() {
                    return Err(world_error("placement pathing source map is unavailable"));
                }
                let source = self.occupancy_sources[index];
                Ok((words[index], (source != u32::MAX).then_some(source)))
            }
        }
    }

    pub fn retire_tile_members_matching(
        &mut self,
        tile: MapCoordinate,
        owner: u8,
        mut matches: impl FnMut(ObjectId) -> bool,
    ) -> Result<(), GenerationError> {
        let Some(members) = self.tiles.get(&tile) else {
            return Ok(());
        };
        for identity in members {
            let object = self
                .objects
                .get_mut(identity)
                .ok_or_else(|| world_error("tile member is absent from the live roster"))?;
            if object.owner == owner && object.lifecycle < 7 && matches(object.object_id) {
                object.hit_points_f32_bits = 0.0_f32.to_bits();
                object.lifecycle = 7;
                self.history.lifecycle.push(*identity);
            }
        }
        Ok(())
    }

    pub fn dimensions(&self) -> Option<MapDimensions> {
        self.dimensions
    }

    pub fn write_lifecycle(&self, writer: &mut CanonicalWriter) {
        writer.u32(self.objects.len() as u32);
        for (identity, object) in &self.objects {
            writer.u32(*identity);
            writer.u8(object.lifecycle);
            writer.u32(object.hit_points_f32_bits);
        }
    }

    pub fn retire(&mut self, identity: u32) -> Result<(), GenerationError> {
        let object = self
            .objects
            .get_mut(&identity)
            .ok_or_else(|| world_error("retired object is not live"))?;
        if object.lifecycle < 7 {
            object.hit_points_f32_bits = 0.0_f32.to_bits();
            object.lifecycle = 7;
            self.history.lifecycle.push(identity);
        }
        Ok(())
    }

    pub fn lifecycle_change_count(&self) -> usize {
        self.history.lifecycle.len()
    }

    pub fn lifecycle_changes_since(&self, position: usize) -> &[u32] {
        self.history.lifecycle.get(position..).unwrap_or(&[])
    }

    pub fn destruction_count(&self) -> usize {
        self.history.destroyed.len()
    }

    pub fn destructions_since(&self, position: usize) -> &[u32] {
        self.history.destroyed.get(position..).unwrap_or(&[])
    }

    pub fn finish_overlap_cleanup_on_terrain(
        &mut self,
        identity: u32,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
        terrain: Option<&[TerrainId]>,
    ) -> Result<(), GenerationError> {
        let object = self
            .object(identity)
            .ok_or_else(|| world_error("cleaned object is not live"))?;
        let bounds = match pathing {
            Some(master)
                if object.suppression != 1
                    && !(master.vertical_extent() <= 0.0
                        && object.primary_record == PrimaryRecord::Absent) =>
            {
                word_bounds(
                    master,
                    object.position_bits.map(f32::from_bits),
                    collision_radius,
                    self.dimensions.expect("live object dimensions"),
                )?
            }
            _ => None,
        };
        let removal = if bounds.is_some() && pathing.is_some_and(|master| master.action == 10) {
            footprint::Region::prepare(
                object.position_bits.map(f32::from_bits),
                collision_radius,
                self.dimensions.expect("live object dimensions"),
                false,
            )?
        } else {
            None
        };
        self.retire(identity)?;
        if object.suppression != 1 {
            if pathing.is_none() {
                self.occupancy = Occupancy::Unavailable;
                self.footprints.invalidate();
                self.path.invalidate();
            } else if let Some(bounds) = bounds {
                if let Some(region) = removal {
                    self.footprints
                        .remove(region, self.dimensions.expect("live object dimensions"));
                }
                self.remove_occupancy(identity, Some(object.owner), bounds);
                self.refresh_path(bounds, terrain);
            }
        }
        let object = self
            .objects
            .get_mut(&identity)
            .expect("validated live cleanup identity");
        if object.suppression != 1 {
            object.primary_record = object.primary_record.removed(pathing);
        }
        object.suppression = 1;
        Ok(())
    }

    fn remove_occupancy(&mut self, identity: u32, owner: Option<u8>, bounds: OccupancyBounds) {
        let width = usize::from(self.dimensions.expect("live object dimensions").width);
        for y in bounds.top..=bounds.bottom {
            for x in bounds.left..=bounds.right {
                let mut blocked = false;
                for member in self.members(MapCoordinate { x, y }) {
                    if *member == identity {
                        continue;
                    }
                    match self.objects[member].primary_record {
                        PrimaryRecord::Present(0..=2 | 11 | 13) => {
                            blocked = true;
                            break;
                        }
                        PrimaryRecord::Unavailable => {
                            self.occupancy = Occupancy::Unavailable;
                            self.path.invalidate();
                            return;
                        }
                        _ => {}
                    }
                }
                if !blocked && let Occupancy::Words(words) = &mut self.occupancy {
                    let word = &mut words[usize::from(y) * width + usize::from(x)];
                    if owner.is_none_or(|owner| *word >> 23 == 1_u64 << owner) {
                        *word &= 0xff;
                        self.occupancy_sources[usize::from(y) * width + usize::from(x)] = u32::MAX;
                    }
                }
            }
        }
    }

    pub fn destroy_with_pathing(
        &mut self,
        identity: u32,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
    ) -> Result<(), GenerationError> {
        self.destroy_member(identity, pathing, collision_radius, false, None)
    }

    pub fn destroy_from_object_with_pathing(
        &mut self,
        identity: u32,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
    ) -> Result<(), GenerationError> {
        self.destroy_member(identity, pathing, collision_radius, true, None)
    }

    pub fn destroy_on_terrain(
        &mut self,
        identity: u32,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
        tile_owned: bool,
        terrain: &[TerrainId],
    ) -> Result<(), GenerationError> {
        self.destroy_member(
            identity,
            pathing,
            collision_radius,
            !tile_owned,
            Some(terrain),
        )
    }

    fn destroy_member(
        &mut self,
        identity: u32,
        pathing: Option<ObjectPathing>,
        collision_radius: [f32; 2],
        unlink_before_cleanup: bool,
        terrain: Option<&[TerrainId]>,
    ) -> Result<(), GenerationError> {
        let object = self
            .object(identity)
            .ok_or_else(|| world_error("destroyed object is not live"))?;
        let bounds = pathing
            .filter(|master| {
                object.suppression != 1
                    && !(master.vertical_extent() <= 0.0
                        && object.primary_record == PrimaryRecord::Absent)
            })
            .map(|master| {
                word_bounds(
                    master,
                    object.position_bits.map(f32::from_bits),
                    collision_radius,
                    self.dimensions.expect("live object dimensions"),
                )
            })
            .transpose()?
            .flatten();
        let removal = if bounds.is_some() && pathing.is_some_and(|master| master.action == 10) {
            footprint::Region::prepare(
                object.position_bits.map(f32::from_bits),
                collision_radius,
                self.dimensions.expect("live object dimensions"),
                false,
            )?
        } else {
            None
        };
        if unlink_before_cleanup {
            self.unlink_member(identity, object.tile);
        }
        if object.suppression != 1 && pathing.is_none() {
            self.occupancy = Occupancy::Unavailable;
            self.footprints.invalidate();
            self.path.invalidate();
        } else if let Some(bounds) = bounds {
            if let Some(region) = removal {
                self.footprints
                    .remove(region, self.dimensions.expect("live object dimensions"));
            }
            self.remove_occupancy(identity, None, bounds);
            self.refresh_path(bounds, terrain);
        }
        if !unlink_before_cleanup {
            self.unlink_member(identity, object.tile);
        }
        self.objects.remove(&identity);
        self.destroyed.insert(identity);
        self.history.destroyed.push(identity);
        Ok(())
    }

    fn unlink_member(&mut self, identity: u32, tile: MapCoordinate) {
        if let Some(members) = self.tiles.get_mut(&tile) {
            if let Some(index) = members.iter().position(|&member| member == identity) {
                members.swap_remove(index);
            }
            if members.is_empty() {
                self.tiles.remove(&tile);
            }
        }
    }

    fn refresh_path(&mut self, bounds: OccupancyBounds, terrain: Option<&[TerrainId]>) {
        let words = match &self.occupancy {
            Occupancy::Unavailable => {
                self.path.invalidate();
                return;
            }
            Occupancy::Empty => None,
            Occupancy::Words(words) => Some(words.as_slice()),
        };
        self.path.world_changed(
            super::exact_path::Rectangle {
                left: bounds.left as i16,
                top: bounds.top as i16,
                right: bounds.right as i16,
                bottom: bounds.bottom as i16,
            },
            terrain,
            words,
        );
    }
}

fn world_error(message: &'static str) -> GenerationError {
    invalid_request("RMSGEN7102", message)
}
