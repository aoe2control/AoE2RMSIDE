use super::exact_appearance::{
    AppearanceAcceptance, AppearanceCandidate, ExactAppearanceObject, consume_terrain_appearances,
};
use super::*;
use rms_content::{
    FoundationCell, NativeClassBindings, ObjectCreationRng, ObjectDefinition,
    ObjectGraphicReplacementFacet, ObjectNeighborFacing, ObjectNeighborFallback,
    ObjectPlacementCollision, ObjectPlacementFamily, ObjectPositionFamily, ObstructionKind,
    RestrictionId, TerrainAppearancePlacement,
};
use rms_profile::ObjectGroupRollFilter;
use rms_semantics::{ArgumentResolution, RmsRandom, RmsRngState, SemanticOperation};

const MAXIMUM_OBJECT_DESCRIPTORS: usize = 4_096;
const _: () = assert!(MAXIMUM_OBJECT_DESCRIPTORS <= u16::MAX as usize + 1);
const _: () = assert!(MAXIMUM_OBJECT_DESCRIPTORS <= MAXIMUM_QUALIFIED_EXACT_OPERATIONS);
const MAXIMUM_OBJECT_GROUPS: usize = 256;
const MAXIMUM_OBJECT_GROUP_ENTRIES: usize = 256;
const MAXIMUM_ACTOR_AREAS: usize = MAXIMUM_GENERATED_ACTOR_AREAS;
const MAXIMUM_GENERATED_ACTOR_AREAS: usize = MAXIMUM_CREATED_OBJECTS;
const MAXIMUM_CREATED_OBJECTS: usize = 65_536;
const MAXIMUM_CANDIDATE_WORK: u64 = 4_194_304;
const MAXIMUM_ACTOR_AREA_WEIGHT: u64 = i32::MAX as u64;
const MAXIMUM_FORCE_PLACEMENT_PASSES: u32 = 999;

pub const OBJECT_FLAG_GAIA_UNCONVERTIBLE: u16 = 1 << 0;
pub const OBJECT_FLAG_BUILDING_CAPTURABLE: u16 = 1 << 1;
pub const OBJECT_FLAG_INDESTRUCTIBLE: u16 = 1 << 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactObjectGrouping {
    Default,
    Loose,
    Tight,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactObjectScaling {
    None,
    MapSize,
    PlayerCount,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ExactObjectDistancePreference {
    Nearest = 1,
    Farthest = 2,
}

#[derive(Clone, Copy)]
enum CandidatePriority {
    Anchor,
    MapCenter(ExactObjectDistancePreference),
    MapEdge(ExactObjectDistancePreference),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectGroupEntry {
    pub object_id: ObjectId,
    pub weight: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectGroup {
    pub name: String,
    pub entries: Vec<ExactObjectGroupEntry>,
    pub operation_index: u32,
    pub roll_filter: ObjectGroupRollFilter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactActorArea {
    pub id: i32,
    pub center: ActorAreaCenter,
    pub radius: i32,
    pub player_slot: Option<u8>,
    pub operation_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActorAreaCenter {
    pub x: i32,
    pub y: i32,
}

impl From<MapCoordinate> for ActorAreaCenter {
    fn from(coordinate: MapCoordinate) -> Self {
        Self {
            x: i32::from(coordinate.x),
            y: i32::from(coordinate.y),
        }
    }
}

pub(crate) fn actor_area_tile_bounds(
    center: ActorAreaCenter,
    radius: i32,
    dimensions: MapDimensions,
) -> Option<[u16; 4]> {
    let axis = |center: i32, extent: u16| {
        let minimum = center.wrapping_sub(radius).max(0);
        let maximum = center.wrapping_add(radius).min(i32::from(extent) - 1);
        (minimum <= maximum).then_some((minimum as u16, maximum as u16))
    };
    let (minimum_x, maximum_x) = axis(center.x, dimensions.width)?;
    let (minimum_y, maximum_y) = axis(center.y, dimensions.height)?;
    Some([minimum_x, maximum_x, minimum_y, maximum_y])
}

#[derive(Default)]
struct ActorAreaState {
    logical: Vec<ExactActorArea>,
    index: ActorAreaIndex,
    records: Vec<ActorAreaRecord>,
    current_land_context: Option<u8>,
    current_land_center: Option<MapCoordinate>,
}

struct ActorAreaRecord {
    id: i32,
    land_context: Option<u8>,
    radius: i32,
    tiles: Vec<ActorAreaRecordTile>,
    index_by_tile: std::collections::BTreeMap<usize, usize>,
    total_weight: u64,
}

struct ActorAreaRecordTile {
    tile_index: usize,
    weight: u32,
}

impl ActorAreaState {
    fn new(
        logical: Vec<ExactActorArea>,
        dimensions: MapDimensions,
    ) -> Result<Self, GenerationError> {
        Self::with_land_context(logical, dimensions, None, None)
    }

    fn with_land_context(
        logical: Vec<ExactActorArea>,
        dimensions: MapDimensions,
        initial_land_context: Option<u8>,
        initial_land_center: Option<MapCoordinate>,
    ) -> Result<Self, GenerationError> {
        let mut state = Self {
            logical: Vec::with_capacity(logical.len()),
            index: ActorAreaIndex::default(),
            records: Vec::new(),
            current_land_context: initial_land_context,
            current_land_center: initial_land_center,
        };
        for area in logical {
            state.register(area, dimensions)?;
        }
        Ok(state)
    }

    fn register(
        &mut self,
        area: ExactActorArea,
        dimensions: MapDimensions,
    ) -> Result<(), GenerationError> {
        let current_land_context = self.current_land_context;
        let record_index =
            if let Some(index) = self.records.iter().position(|record| {
                record.id == area.id && record.land_context == current_land_context
            }) {
                index
            } else {
                self.records.push(ActorAreaRecord {
                    id: area.id,
                    land_context: current_land_context,
                    radius: area.radius,
                    tiles: Vec::new(),
                    index_by_tile: std::collections::BTreeMap::new(),
                    total_weight: 0,
                });
                self.records.sort_by_key(|record| record.id);
                self.records
                    .iter()
                    .position(|record| {
                        record.id == area.id && record.land_context == current_land_context
                    })
                    .expect("the inserted actor-area record remains present")
            };
        let record = &mut self.records[record_index];
        let effective_area = ExactActorArea {
            radius: record.radius,
            ..area
        };
        let map_width = usize::from(dimensions.width);
        let [minimum_x, maximum_x, minimum_y, maximum_y] =
            actor_area_tile_bounds(effective_area.center, effective_area.radius, dimensions)
                .unwrap_or([1, 0, 1, 0]);
        for x in minimum_x..=maximum_x {
            for y in minimum_y..=maximum_y {
                record.total_weight = record.total_weight.saturating_add(1);
                let tile_index = usize::from(y) * map_width + usize::from(x);
                if let Some(&index) = record.index_by_tile.get(&tile_index) {
                    record.tiles[index].weight = record.tiles[index]
                        .weight
                        .checked_add(1)
                        .ok_or_else(|| invalid_object("actor-area tile weight exceeds u32"))?;
                } else {
                    let index = record.tiles.len();
                    record.index_by_tile.insert(tile_index, index);
                    record.tiles.push(ActorAreaRecordTile {
                        tile_index,
                        weight: 1,
                    });
                }
            }
        }
        self.index.push(effective_area, dimensions);
        self.logical.push(effective_area);
        Ok(())
    }

    fn view(&self) -> ActorAreas<'_> {
        ActorAreas::indexed(&self.logical, &self.index)
    }

    fn record_index(&self, id: i32) -> Option<usize> {
        self.records.iter().position(|record| {
            record.id == id
                && (record.land_context.is_none()
                    || record.land_context == self.current_land_context)
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactObjectClassConstraint {
    pub class_id: u32,
    pub radius: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExactObjectClassFilterMode {
    Require,
    Exclude,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectClassFilter {
    pub mode: ExactObjectClassFilterMode,
    pub constraints: Vec<ExactObjectClassConstraint>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectDescriptor {
    pub object_id: Option<ObjectId>,
    pub object_group_name: Option<String>,
    pub number_of_groups: u32,
    pub number_of_objects: u32,
    pub group_variance: u32,
    pub group_placement_radius: u16,
    pub grouping: ExactObjectGrouping,
    pub scaling: ExactObjectScaling,
    pub place_for_every_player: bool,
    pub gaia_object_only: bool,
    pub explicit_facet: Option<u16>,
    pub second_object_id: Option<ObjectId>,
    pub second_object_group_name: Option<String>,
    pub resource_delta: i32,
    pub behavior_flags: u16,
    pub terrain_to_place_on: Option<TerrainId>,
    pub layer_to_place_on: Option<TerrainId>,
    pub specific_land_id: Option<u16>,
    pub ignore_terrain_restrictions: bool,
    pub player_distance_command: bool,
    pub minimum_player_distance_command: bool,
    pub minimum_distance_to_players: u16,
    pub maximum_distance_to_players: Option<u16>,
    pub minimum_distance_to_map_edge: u16,
    pub maximum_distance_to_other_zones: Option<u16>,
    pub minimum_group_distance: u16,
    pub temporary_minimum_group_distance: u16,
    pub minimum_connected_tiles: i32,
    pub override_actor_radius_if_required: bool,
    pub avoid_other_land_zones: bool,
    pub avoid_other_land_zones_distance: i32,
    pub path_requirement: i32,
    pub actor_area: Option<i32>,
    pub actor_area_to_place_in: Option<i32>,
    pub avoid_actor_areas: Vec<i32>,
    pub avoid_all_actor_areas: bool,
    pub actor_area_radius: u16,
    pub object_class_filter: Option<ExactObjectClassFilter>,
    pub find_closest: bool,
    pub find_closest_to_map_center: Option<ExactObjectDistancePreference>,
    pub find_closest_to_map_edge: Option<ExactObjectDistancePreference>,
    pub circular_placement: bool,
    pub tile_shuffling: bool,
    pub force_placement: bool,
    pub remove_obstructions: bool,
    pub generate_for_first_land_only: bool,
    pub operation_index: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectAttempt {
    pub descriptor_index: u16,
    pub player_slot: Option<u8>,
    pub candidate_count: u32,
    pub candidate_shuffle_iterations: u32,
    pub candidate_collection_rng_draws: u64,
    pub candidate_shuffle_rng_draws: u64,
    pub groups_requested: u32,
    pub groups_accepted: u32,
    pub objects_created: u32,
    pub exhausted: bool,
    pub primary_rng_draws_before: u64,
    pub primary_rng_draws_after: u64,
    pub auxiliary_rng_draws_before: u64,
    pub auxiliary_rng_draws_after: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactObjectStatistics {
    pub stage_entry_rng_draws: u64,
    pub appearance_rng_draws: u64,
    pub candidate_tiles: u64,
    pub candidate_shuffle_iterations: u64,
    pub candidate_rng_draws: u64,
    pub placement_rng_draws: u64,
    pub auxiliary_rng_draws: u64,
    pub rejected_groups: u64,
    pub exhausted_descriptors: u64,
    pub foundation_tiles_painted: u64,
    pub attempts: Vec<ExactObjectAttempt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectState {
    pub dimensions: MapDimensions,
    pub terrain: Vec<TerrainId>,
    pub land_id: Vec<u16>,
    pub tile_operation_indices: Vec<u32>,
    pub gaia_civilization_id: CivilizationId,
    pub actor_areas: Vec<ExactActorArea>,
    pub object_groups: Vec<ExactObjectGroup>,
    pub descriptors: Vec<ExactObjectDescriptor>,
    pub objects: Vec<PlacedObject>,
    pub object_operation_indices: Vec<u32>,
    scripted_position_overrides: BTreeMap<usize, [u32; 2]>,
    pub rng_state: RmsRngState,
    pub auxiliary_rng_state: RmsRngState,
    pub statistics: ExactObjectStatistics,
    module_entry_appearances: Vec<ExactAppearanceObject>,
    module_entry_cliff_appearances: Vec<(u32, ExactAppearanceObject)>,
    module_entry_cliff_retired: Vec<bool>,
    module_entry_removed: BTreeSet<u32>,
    module_entry_pieces: Vec<PlacedObject>,
    module_exit_pieces: Vec<PlacedObject>,
    module_entry_next_instance_id: u32,
    module_entry_retired: Vec<bool>,
    terrain_appearances: TerrainAppearanceObjects,
    runtime_attributes: std::sync::Arc<ObjectRuntimeAttributes>,
    restriction_zones: ExactRestrictionZones,
    post_rms_next_instance_id: u32,
    post_rms_objects: Vec<PlacedObject>,
    post_rms_positions: BTreeMap<usize, [u32; 2]>,
    automatic_technologies: Option<AutomaticTechnologyState>,
    foundation_terrain_remap: rms_profile::FoundationTerrainRemap,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectLifecycle {
    pub module_entry: Vec<PlacedObject>,
    pub module_entry_tiles: Vec<u32>,
    pub terrain_appearance: Vec<PlacedObject>,
    pub terrain_appearance_tiles: Vec<u32>,
    pub scripted_tiles: Vec<u32>,
    pub module_exit_appearance: Vec<PlacedObject>,
    pub position_f32_bits: ExactObjectLifecyclePositionBits,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactObjectLifecyclePositionBits {
    pub module_entry: Vec<[u32; 3]>,
    pub terrain_appearance: Vec<[u32; 3]>,
    pub scripted: Vec<[u32; 3]>,
    pub module_exit_appearance: Vec<[u32; 3]>,
}

impl ExactObjectState {
    pub fn module_exit_pieces(&self) -> &[PlacedObject] {
        &self.module_exit_pieces
    }

    pub fn standing_appearance_objects(&self) -> Vec<(ObjectId, [u32; 2])> {
        let prelude_end = u32::try_from(self.terrain_appearances.objects.len())
            .ok()
            .and_then(|count| self.module_entry_next_instance_id.checked_add(count))
            .unwrap_or(u32::MAX);
        let pieces: BTreeSet<u32> = self
            .module_entry_pieces
            .iter()
            .chain(&self.module_exit_pieces)
            .map(|piece| piece.instance_id)
            .collect();
        self.restriction_zones
            .objects
            .live_objects_in(0..prelude_end)
            .filter(|(identity, object)| {
                object.owner == 0 && object.lifecycle < 7 && !pieces.contains(identity)
            })
            .map(|(_, object)| (object.object_id, object.position_bits))
            .collect()
    }

    pub fn scripted_construction_position_f32_bits(&self, index: usize) -> Option<[u32; 2]> {
        self.objects.get(index).map(|object| {
            self.scripted_position_overrides
                .get(&index)
                .copied()
                .unwrap_or_else(|| {
                    [object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0].map(f32::to_bits)
                })
        })
    }

    fn lifecycle_appearance_position(
        &self,
        object: &PlacedObject,
    ) -> Result<[f32; 2], GenerationError> {
        let appearance = self
            .module_entry_appearances
            .get(object.instance_id as usize)
            .or_else(|| {
                self.module_entry_cliff_appearances
                    .binary_search_by_key(&object.instance_id, |(identity, _)| *identity)
                    .ok()
                    .map(|index| &self.module_entry_cliff_appearances[index].1)
            })
            .or_else(|| {
                object
                    .instance_id
                    .checked_sub(self.module_entry_next_instance_id)
                    .and_then(|index| self.terrain_appearances.objects.get(index as usize))
            });
        if let Some(appearance) = appearance {
            let (x, y) = appearance_position(
                appearance.tile_index as usize,
                appearance.placement,
                appearance.x_sample,
                appearance.y_sample,
                self.dimensions,
            )?;
            return Ok([x, y]);
        }
        if self
            .module_entry_pieces
            .iter()
            .any(|piece| piece.instance_id == object.instance_id)
        {
            return Ok([object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0]);
        }
        Err(invalid_object("appearance construction position is absent"))
    }

    fn lifecycle_position_f32_bits(
        &self,
        object: &PlacedObject,
        elevation: &[i16],
    ) -> Result<[u32; 3], GenerationError> {
        let [x, y] = self.lifecycle_appearance_position(object)?;
        let z = super::exact_elevation::terrain_height_f32(x, y, self.dimensions, elevation)
            .ok_or_else(|| invalid_object("object elevation lookup lies outside map"))?;
        Ok([x.to_bits(), y.to_bits(), z.to_bits()])
    }

    pub fn materialize_lifecycle(
        &self,
        elevation: &[i16],
        content: CompatibleContentView<'_>,
    ) -> Result<ExactObjectLifecycle, GenerationError> {
        if elevation.len() != self.dimensions.tile_count()? {
            return Err(invalid_object(
                "object lifecycle elevation does not match map dimensions",
            ));
        }
        let mut next_instance_id = 0_u32;
        let mut module_entry = materialize_appearance_objects(
            &self.module_entry_appearances,
            self.dimensions,
            elevation,
            content,
            &self.runtime_attributes,
            &mut next_instance_id,
        )?;
        if module_entry.len() != self.module_entry_retired.len() {
            return Err(invalid_object(
                "object lifecycle retirement state is incomplete",
            ));
        }
        for (object, retired) in module_entry
            .iter_mut()
            .zip(self.module_entry_retired.iter().copied())
        {
            if retired {
                object.status = 7;
                object.death_state = 7;
            }
        }
        module_entry.retain(|object| !self.module_entry_removed.contains(&object.instance_id));
        if self.module_entry_cliff_appearances.len() != self.module_entry_cliff_retired.len() {
            return Err(invalid_object(
                "cliff appearance retirement state is incomplete",
            ));
        }
        for ((identity, appearance), retired) in self
            .module_entry_cliff_appearances
            .iter()
            .zip(&self.module_entry_cliff_retired)
        {
            let mut object = materialize_appearance_object(
                appearance,
                *identity,
                self.dimensions,
                elevation,
                content,
                &self.runtime_attributes,
            )?;
            if *retired {
                object.status = 7;
                object.death_state = 7;
            }
            module_entry.push(object);
        }
        module_entry.extend(self.module_entry_pieces.iter().cloned());
        module_entry.sort_unstable_by_key(|object| object.instance_id);
        next_instance_id = self.module_entry_next_instance_id;
        let terrain_appearance = materialize_appearance_objects(
            &self.terrain_appearances.objects,
            self.dimensions,
            elevation,
            content,
            &self.runtime_attributes,
            &mut next_instance_id,
        )?;
        let mut module_exit_appearance =
            module_exit_appearances(&module_entry, &terrain_appearance);
        for piece in &self.module_exit_pieces {
            let entry = module_exit_appearance
                .iter_mut()
                .find(|object| object.instance_id == piece.instance_id)
                .ok_or_else(|| invalid_object("cliff lifecycle identity is absent at entry"))?;
            *entry = piece.clone();
        }
        if self.objects.len() != self.object_operation_indices.len() {
            return Err(invalid_object(
                "scripted lifecycle operation provenance is incomplete",
            ));
        }
        module_exit_appearance.retain(|object| {
            !self
                .restriction_zones
                .objects
                .was_destroyed(object.instance_id)
        });
        synchronize_lifecycle(&mut module_exit_appearance, &self.restriction_zones.objects)?;
        for object in &self.objects {
            while next_instance_id < object.instance_id
                && self
                    .restriction_zones
                    .objects
                    .was_destroyed(next_instance_id)
            {
                next_instance_id += 1;
            }
            if object.instance_id != next_instance_id {
                return Err(invalid_object(
                    "scripted object identities do not follow the appearance prelude",
                ));
            }
            next_instance_id = next_instance_id
                .checked_add(1)
                .ok_or_else(|| invalid_object("scripted lifecycle identity overflow"))?;
        }
        let module_entry_tiles = module_entry
            .iter()
            .map(|object| {
                let [x, y] = self.lifecycle_appearance_position(object)?;
                Ok((y as u32) * u32::from(self.dimensions.width) + x as u32)
            })
            .collect::<Result<Vec<_>, GenerationError>>()?;
        let module_entry_position_f32_bits = module_entry
            .iter()
            .map(|object| self.lifecycle_position_f32_bits(object, elevation))
            .collect::<Result<Vec<_>, _>>()?;
        let terrain_appearance_position_f32_bits = terrain_appearance
            .iter()
            .map(|object| self.lifecycle_position_f32_bits(object, elevation))
            .collect::<Result<Vec<_>, _>>()?;
        let scripted_position_f32_bits = self
            .objects
            .iter()
            .enumerate()
            .map(|(index, object)| {
                let [x_bits, y_bits] = self
                    .scripted_position_overrides
                    .get(&index)
                    .copied()
                    .unwrap_or_else(|| {
                        [object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0].map(f32::to_bits)
                    });
                let (x, y) = (f32::from_bits(x_bits), f32::from_bits(y_bits));
                let z =
                    super::exact_elevation::terrain_height_f32(x, y, self.dimensions, elevation)
                        .ok_or_else(|| {
                            invalid_object("object elevation lookup lies outside map")
                        })?;
                Ok([x_bits, y_bits, z.to_bits()])
            })
            .collect::<Result<Vec<_>, GenerationError>>()?;
        let module_exit_appearance_position_f32_bits = module_exit_appearance
            .iter()
            .map(|object| self.lifecycle_position_f32_bits(object, elevation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ExactObjectLifecycle {
            module_entry,
            module_entry_tiles,
            terrain_appearance,
            terrain_appearance_tiles: self
                .terrain_appearances
                .objects
                .iter()
                .map(|appearance| appearance.tile_index)
                .collect(),
            scripted_tiles: self
                .objects
                .iter()
                .enumerate()
                .map(|(index, object)| {
                    let [x, y] =
                        construction_position(index, object, &self.scripted_position_overrides);
                    (y as u32) * u32::from(self.dimensions.width) + x as u32
                })
                .collect(),
            module_exit_appearance,
            position_f32_bits: ExactObjectLifecyclePositionBits {
                module_entry: module_entry_position_f32_bits,
                terrain_appearance: terrain_appearance_position_f32_bits,
                scripted: scripted_position_f32_bits,
                module_exit_appearance: module_exit_appearance_position_f32_bits,
            },
        })
    }

    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-object-state-v13");
        writer.u32(self.module_entry_cliff_appearances.len() as u32);
        for (identity, appearance) in &self.module_entry_cliff_appearances {
            writer.u32(*identity);
            write_appearance(&mut writer, appearance);
        }
        writer.u32(self.module_entry_cliff_retired.len() as u32);
        for retired in &self.module_entry_cliff_retired {
            writer.u8(u8::from(*retired));
        }
        writer.u32(self.module_entry_removed.len() as u32);
        for ordinal in &self.module_entry_removed {
            writer.u32(*ordinal);
        }
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.u32(self.terrain.len() as u32);
        for terrain in &self.terrain {
            writer.u32(terrain.0);
        }
        writer.u32(self.land_id.len() as u32);
        for land_id in &self.land_id {
            writer.u16(*land_id);
        }
        writer.u32(self.tile_operation_indices.len() as u32);
        for operation_index in &self.tile_operation_indices {
            writer.u32(*operation_index);
        }
        writer.u32(self.gaia_civilization_id.0);
        writer.u32(self.actor_areas.len() as u32);
        for area in &self.actor_areas {
            writer.u32(area.id as u32);
            match (
                u16::try_from(area.center.x),
                u16::try_from(area.center.y),
                u16::try_from(area.radius),
            ) {
                (Ok(x), Ok(y), Ok(radius)) => {
                    writer.u16(x);
                    writer.u16(y);
                    writer.u16(radius);
                }
                _ => {
                    writer.u16(u16::MAX);
                    writer.u16(u16::MAX);
                    writer.u16(u16::MAX);
                    writer.u32(area.center.x as u32);
                    writer.u32(area.center.y as u32);
                    writer.u32(area.radius as u32);
                }
            }
            writer.u32(area.player_slot.map_or(u32::MAX, u32::from));
            writer.u32(area.operation_index);
        }
        writer.u32(self.object_groups.len() as u32);
        for group in &self.object_groups {
            writer.string(&group.name);
            writer.u32(group.entries.len() as u32);
            for entry in &group.entries {
                writer.u32(entry.object_id.0);
                writer.u32(entry.weight);
            }
            writer.u32(group.operation_index);
        }
        writer.u32(self.descriptors.len() as u32);
        for descriptor in &self.descriptors {
            writer.u32(descriptor.object_id.map_or(u32::MAX, |id| id.0));
            writer.string(descriptor.object_group_name.as_deref().unwrap_or(""));
            writer.u32(descriptor.number_of_groups);
            writer.u32(descriptor.number_of_objects);
            writer.u32(descriptor.group_variance);
            writer.u16(descriptor.group_placement_radius);
            writer.u8(match descriptor.grouping {
                ExactObjectGrouping::Default => 0,
                ExactObjectGrouping::Loose => 1,
                ExactObjectGrouping::Tight => 2,
            });
            writer.u8(match descriptor.scaling {
                ExactObjectScaling::None => 0,
                ExactObjectScaling::MapSize => 1,
                ExactObjectScaling::PlayerCount => 2,
            });
            writer.u8(u8::from(descriptor.place_for_every_player));
            writer.u8(u8::from(descriptor.gaia_object_only));
            writer.u32(descriptor.explicit_facet.map_or(u32::MAX, u32::from));
            writer.u32(descriptor.second_object_id.map_or(u32::MAX, |id| id.0));
            if let Some(name) = &descriptor.second_object_group_name {
                writer.string(name);
            }
            writer.u32(descriptor.resource_delta as u32);
            writer.u16(descriptor.behavior_flags);
            writer.u32(descriptor.terrain_to_place_on.map_or(u32::MAX, |id| id.0));
            writer.u32(descriptor.layer_to_place_on.map_or(u32::MAX, |id| id.0));
            writer.u32(descriptor.specific_land_id.map_or(u32::MAX, u32::from));
            writer.u8(u8::from(descriptor.ignore_terrain_restrictions));
            writer.u8(u8::from(descriptor.player_distance_command));
            writer.u8(u8::from(descriptor.minimum_player_distance_command));
            writer.u16(descriptor.minimum_distance_to_players);
            writer.u32(
                descriptor
                    .maximum_distance_to_players
                    .map_or(u32::MAX, u32::from),
            );
            writer.u16(descriptor.minimum_distance_to_map_edge);
            writer.u32(
                descriptor
                    .maximum_distance_to_other_zones
                    .map_or(u32::MAX, u32::from),
            );
            writer.u16(descriptor.minimum_group_distance);
            writer.u16(descriptor.temporary_minimum_group_distance);
            writer.u32(descriptor.minimum_connected_tiles as u32);
            writer.u8(0);
            writer.u8(u8::from(descriptor.avoid_other_land_zones));
            writer.u32(descriptor.avoid_other_land_zones_distance as u32);
            writer.u32(descriptor.path_requirement as u32);
            writer.u32(descriptor.actor_area.map_or(u32::MAX, |id| id as u32));
            writer.u32(
                descriptor
                    .actor_area_to_place_in
                    .map_or(u32::MAX, |id| id as u32),
            );
            writer.u32(descriptor.avoid_actor_areas.len() as u32);
            for id in &descriptor.avoid_actor_areas {
                writer.u32(*id as u32);
            }
            writer.u8(u8::from(descriptor.avoid_all_actor_areas));
            writer.u16(descriptor.actor_area_radius);
            match &descriptor.object_class_filter {
                None => writer.u8(0),
                Some(filter) => {
                    writer.u8(match filter.mode {
                        ExactObjectClassFilterMode::Require => 1,
                        ExactObjectClassFilterMode::Exclude => 2,
                    });
                    writer.u32(filter.constraints.len() as u32);
                    for constraint in &filter.constraints {
                        writer.u32(constraint.class_id);
                        writer.u16(constraint.radius);
                    }
                }
            }
            writer.u8(u8::from(descriptor.find_closest));
            writer.u8(descriptor
                .find_closest_to_map_center
                .map_or(0, |value| value as u8));
            writer.u8(descriptor
                .find_closest_to_map_edge
                .map_or(0, |value| value as u8));
            writer.u8(u8::from(descriptor.circular_placement));
            writer.u8(u8::from(descriptor.tile_shuffling));
            writer.u8(u8::from(descriptor.force_placement));
            writer.u8(u8::from(descriptor.remove_obstructions));
            if descriptor.generate_for_first_land_only {
                writer.u8(1);
            }
            if descriptor.override_actor_radius_if_required {
                writer.string("override-actor-radius");
            }
            writer.u32(descriptor.operation_index);
        }
        writer.u32(self.objects.len() as u32);
        for object in &self.objects {
            write_object(&mut writer, object);
        }
        writer.u32(self.scripted_position_overrides.len() as u32);
        for (index, position) in &self.scripted_position_overrides {
            writer.u32(*index as u32);
            writer.u32(position[0]);
            writer.u32(position[1]);
        }
        writer.u32(self.module_entry_next_instance_id);
        for pieces in [&self.module_entry_pieces, &self.module_exit_pieces] {
            writer.u32(pieces.len() as u32);
            for piece in pieces {
                write_object(&mut writer, piece);
            }
        }
        self.restriction_zones.objects.write_lifecycle(&mut writer);
        writer.bytes(&self.rng_state.checkpoint_hash());
        writer.bytes(&self.auxiliary_rng_state.checkpoint_hash());
        Sha256::digest(writer.finish()).into()
    }
}

fn module_exit_appearances(
    module_entry: &[PlacedObject],
    terrain_appearance: &[PlacedObject],
) -> Vec<PlacedObject> {
    module_entry
        .iter()
        .chain(terrain_appearance)
        .cloned()
        .collect()
}

struct FoundationMap<'a> {
    restriction_zones: ExactRestrictionZones,
    next_instance_id: u32,
    dimensions: MapDimensions,
    generation_program_mode: NativeGenerationProgramMode,
    automatic_technologies: Option<AutomaticTechnologyState>,
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    terrain: &'a mut [TerrainId],
    land_id: &'a mut [u16],
    operation_indices: &'a mut [u32],
    work: u64,
    painted: u64,
    construction_positions: BTreeMap<usize, [u32; 2]>,
    pending_neighbor_completion: Vec<usize>,
    obstruction_index: ObstructionIndex,
    lifecycle_projection: LifecycleProjection,
    list_classes: ListClassIndex,
    stale_links: StaleHeaderLinks,
    foundation_terrain_remap: rms_profile::FoundationTerrainRemap,
    viewing_player: Option<u8>,
    deferred_foundations: DeferredFoundations,
}

const DEFERRED_FOUNDATION_MASTERS: [ObjectId; 2] = [ObjectId(357), ObjectId(1188)];

fn foundation_paint_is_deferred(object_id: ObjectId, comparison_terrain: TerrainId) -> bool {
    DEFERRED_FOUNDATION_MASTERS.contains(&object_id)
        || matches!(comparison_terrain.0, 7 | 8 | 29..=31 | 63..=67 | 117..=121)
}

const DEFERRED_FOUNDATION_WATER_TERRAIN: TerrainId = TerrainId(63);
const DEFERRED_FOUNDATION_LAND_TERRAIN: TerrainId = TerrainId(7);

#[derive(Clone, Debug, Default)]
struct DeferredFoundations {
    enabled: bool,
    tiles: Vec<usize>,
}

impl DeferredFoundations {
    fn object_module() -> Self {
        Self {
            enabled: true,
            tiles: Vec::new(),
        }
    }

    fn immediate() -> Self {
        Self::default()
    }
}

impl FoundationMap<'_> {
    fn paint_deferred_foundations(&mut self) {
        for index in std::mem::take(&mut self.deferred_foundations.tiles) {
            let water = self
                .content
                .terrain(self.terrain[index])
                .is_some_and(|terrain| terrain.placement_class & 7 != 0);
            let painted = if water {
                DEFERRED_FOUNDATION_WATER_TERRAIN
            } else {
                DEFERRED_FOUNDATION_LAND_TERRAIN
            };
            if self.terrain[index] != painted {
                self.terrain[index] = painted;
                self.painted = self.painted.saturating_add(1);
            }
            self.land_id[index] = u16::MAX;
        }
    }
}

fn viewing_player(setup: &ExactSetupState) -> Option<u8> {
    setup.players.iter().map(|player| player.slot).min()
}

const FOUNDATION_PROTECTED_TERRAINS: [TerrainId; 2] = [TerrainId(47), TerrainId(69)];

fn native_foundation_target(
    remap: rms_profile::FoundationTerrainRemap,
    terrain_id: TerrainId,
    owner: u8,
    viewing_player: Option<u8>,
) -> TerrainId {
    if remap == rms_profile::FoundationTerrainRemap::None || viewing_player == Some(owner) {
        return terrain_id;
    }
    match terrain_id.0 {
        8 => TerrainId(27),
        64 => TerrainId(54),
        _ => terrain_id,
    }
}

fn building_completes_at_creation(
    object_id: ObjectId,
    owner: u8,
    definition: &ObjectDefinition,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    if definition.constructor_type != Some(rms_content::BUILDING_CONSTRUCTOR_TYPE)
        || runtime_attributes.initial_hit_points(object_id, owner, content)? >= 1
    {
        return Ok(true);
    }
    let exemptions = content
        .native_generation_bindings()
        .and_then(|bindings| bindings.construction_site_exemptions.as_ref());
    match (exemptions, definition.building_construction) {
        (Some(exemptions), Some(facts)) => {
            Ok(exemptions.starts_as_construction_site(definition.id, definition.class_id, facts))
        }
        _ => Err(invalid_object(
            "building construction-site metadata is unavailable",
        )),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AutomaticTechnologyState {
    researched: BTreeMap<u8, BTreeSet<u16>>,
    variant_rng: RmsRandom,
    spawn_placement: rms_profile::BuildingSpawnPlacement,
    spawn_ring_work: u64,
}

impl AutomaticTechnologyState {
    fn new(setup: &ExactSetupState, content: CompatibleContentView<'_>, seed: u32) -> Option<Self> {
        if content.automatic_spawn_technologies().is_empty()
            && content
                .native_generation_bindings()
                .is_none_or(|bindings| bindings.player_start_bindings.is_none())
        {
            return None;
        }
        let initial: BTreeSet<u16> = content
            .initial_automatic_technology_ids()
            .iter()
            .copied()
            .collect();
        let researched = setup
            .players
            .iter()
            .map(|player| (player.slot, initial.clone()))
            .collect();
        Some(Self {
            researched,
            variant_rng: RmsRandom::registered(seed, 7)
                .expect("the native variant stream has a valid registration ordinal"),
            spawn_placement: rms_profile::BuildingSpawnPlacement::InnerTileFallback,
            spawn_ring_work: 0,
        })
    }
}

#[derive(Clone, Copy)]
struct NeighborOccupant {
    index: Option<usize>,
    master: ObjectId,
    class: u32,
    owner: u8,
    facing: Option<ObjectNeighborFacing>,
}

fn select_neighbor(
    occupants: impl Iterator<Item = Result<NeighborOccupant, GenerationError>> + Clone,
    source: NeighborOccupant,
) -> Result<Option<usize>, GenerationError> {
    fn first_building(
        occupants: impl Iterator<Item = Result<NeighborOccupant, GenerationError>>,
        matches: impl Fn(NeighborOccupant) -> bool,
    ) -> Result<Option<NeighborOccupant>, GenerationError> {
        for occupant in occupants {
            let occupant = occupant?;
            if matches(occupant) {
                return Ok(occupant.facing.is_some().then_some(occupant));
            }
        }
        Ok(None)
    }
    let Some(facing) = source.facing else {
        return Ok(None);
    };
    let same = first_building(occupants.clone(), |o| o.master == source.master)?;
    let candidate = if same.is_some() {
        same
    } else {
        match facing.fallback {
            Some(ObjectNeighborFallback::Class { class_id }) => {
                first_building(occupants, |o| o.class == class_id)?
            }
            Some(ObjectNeighborFallback::LinkedObject) => {
                if let Some(linked) = facing.linked_object_id {
                    first_building(occupants, |o| o.master == linked)?
                        .filter(|o| o.facing.is_some_and(|f| f.accepts_linked_neighbor))
                } else {
                    None
                }
            }
            Some(ObjectNeighborFallback::LinkingClass { class_id }) => {
                first_building(occupants, |o| o.class == class_id)?.filter(|o| {
                    o.facing
                        .is_some_and(|f| f.linked_object_id == Some(source.master))
                })
            }
            None => None,
        }
    };
    Ok(candidate
        .filter(|o| o.owner == source.owner)
        .and_then(|o| o.index))
}

fn connected_object_facet([n, s, w, e, nw, ne, sw, se]: [bool; 8]) -> u16 {
    if n && s && !w && !e {
        1
    } else if w && e && !n && !s {
        0
    } else if nw && se && !ne && !sw {
        3
    } else if ne && sw && !nw && !se {
        4
    } else {
        2
    }
}

fn construction_position(
    index: usize,
    object: &PlacedObject,
    overrides: &BTreeMap<usize, [u32; 2]>,
) -> [f32; 2] {
    overrides.get(&index).map_or_else(
        || [object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0],
        |bits| bits.map(f32::from_bits),
    )
}

impl FoundationMap<'_> {
    fn birth(&mut self, object: &PlacedObject, position: [f32; 2]) -> Result<(), GenerationError> {
        if object.instance_id != self.next_instance_id {
            return Err(invalid_object(
                "construction identity disagrees with live world",
            ));
        }
        let hit_points = self.runtime_attributes.initial_hit_points(
            object.object_id,
            object.owner,
            self.content,
        )?;
        let definition = self
            .runtime_attributes
            .definition(object.object_id, object.owner, self.content)
            .ok_or_else(|| missing_object_definition(object.object_id))?;
        std::sync::Arc::make_mut(&mut self.restriction_zones.objects).birth_on_terrain(
            object.instance_id,
            object.object_id,
            object.owner,
            u8::try_from(object.status)
                .map_err(|_| invalid_object("construction lifecycle exceeds u8"))?,
            position,
            self.dimensions,
            hit_points,
            definition.pathing,
            definition.collision_half_extents(),
            definition.position_family,
            Some(self.terrain),
        )?;
        self.next_instance_id = self
            .next_instance_id
            .checked_add(1)
            .ok_or_else(|| invalid_object("object construction identity exceeds u32"))?;
        Ok(())
    }

    fn neighbor_occupant(
        &self,
        index: usize,
        object: &PlacedObject,
    ) -> Result<NeighborOccupant, GenerationError> {
        self.neighbor_metadata(Some(index), object.object_id, object.owner)
    }

    fn neighbor_metadata(
        &self,
        index: Option<usize>,
        object_id: ObjectId,
        owner: u8,
    ) -> Result<NeighborOccupant, GenerationError> {
        let definition = self
            .runtime_attributes
            .definition(object_id, owner, self.content)
            .ok_or_else(|| missing_object_definition(object_id))?;
        let source = self
            .content
            .object(object_id)
            .ok_or_else(|| missing_object_definition(object_id))?;
        let mut facing = definition.neighbor_facing;
        if source.class_id != definition.class_id
            && let Some(adopted) = facing.as_mut()
        {
            let classes = native_generation_bindings(self.content)?.classes;
            if [source.class_id, definition.class_id]
                .iter()
                .any(|class| *class == classes.gate || *class == classes.wall)
            {
                adopted.preserve_facet = source.class_id == classes.gate;
                adopted.fallback = if source.class_id == classes.wall {
                    Some(ObjectNeighborFallback::Class {
                        class_id: classes.gate,
                    })
                } else if source.class_id == classes.gate {
                    Some(ObjectNeighborFallback::Class {
                        class_id: classes.wall,
                    })
                } else {
                    match adopted.fallback {
                        Some(ObjectNeighborFallback::Class { .. }) => None,
                        other => other,
                    }
                };
            }
        }
        Ok(NeighborOccupant {
            index,
            master: object_id,
            class: source.class_id,
            owner,
            facing,
        })
    }

    fn neighbors(
        &self,
        index: usize,
        objects: &[PlacedObject],
        source: NeighborOccupant,
    ) -> Result<[Option<usize>; 8], GenerationError> {
        let world = &self.restriction_zones.objects;
        let current = world
            .object(objects[index].instance_id)
            .ok_or_else(|| invalid_object("neighbor source is not live"))?;
        if current.object_id != source.master || current.owner != source.owner {
            return Err(invalid_object("neighbor source disagrees with live world"));
        }
        let [x, y] = current
            .position_bits
            .map(|bits| f32::from_bits(bits) as i32);
        let mut result = [None; 8];
        for (slot, (dx, dy)) in [
            (0, -1),
            (0, 1),
            (-1, 0),
            (1, 0),
            (-1, -1),
            (1, -1),
            (-1, 1),
            (1, 1),
        ]
        .into_iter()
        .enumerate()
        {
            let (x, y) = (x + dx, y + dy);
            if x < 0
                || y < 0
                || x >= i32::from(self.dimensions.width)
                || y >= i32::from(self.dimensions.height)
            {
                continue;
            }
            let occupants = world
                .members(MapCoordinate {
                    x: x as u16,
                    y: y as u16,
                })
                .iter()
                .map(|&identity| {
                    let object = world
                        .object(identity)
                        .ok_or_else(|| invalid_object("neighbor tile member is not live"))?;
                    let index = objects
                        .binary_search_by_key(&identity, |o| o.instance_id)
                        .ok();
                    let occupant = self.neighbor_metadata(index, object.object_id, object.owner)?;
                    if occupant.index.is_none() && occupant.facing.is_some() {
                        return Err(invalid_object(
                            "building-backed prelude neighbor lifecycle is unsupported",
                        ));
                    }
                    Ok(occupant)
                });
            result[slot] = select_neighbor(occupants, source)?;
        }
        Ok(result)
    }

    fn update_neighbors(
        &mut self,
        index: usize,
        objects: &mut [PlacedObject],
    ) -> Result<(), GenerationError> {
        let source = self.neighbor_occupant(index, &objects[index])?;
        if !source
            .facing
            .is_some_and(|f| f.updates_neighbors && f.has_graphic)
        {
            return Ok(());
        }
        let neighbors = self.neighbors(index, objects, source)?;
        if !source.facing.expect("source participates").preserve_facet {
            objects[index].facet = connected_object_facet(neighbors.map(|o| o.is_some()));
        }
        for neighbor in neighbors.into_iter().flatten() {
            let target = self.neighbor_occupant(neighbor, &objects[neighbor])?;
            if target
                .facing
                .is_some_and(|f| f.has_graphic && !f.preserve_facet)
            {
                objects[neighbor].facet = connected_object_facet(
                    self.neighbors(neighbor, objects, target)?
                        .map(|o| o.is_some()),
                );
            }
        }
        Ok(())
    }

    fn apply(
        &mut self,
        object: &PlacedObject,
        definition: &ObjectDefinition,
        operation_index: u32,
        completes: bool,
    ) -> Result<(), GenerationError> {
        let Some(foundation) = &definition.foundation else {
            return Ok(());
        };
        if !completes {
            return Ok(());
        }
        if self.generation_program_mode == NativeGenerationProgramMode::ExplicitMaximumSeed
            && native_generation_bindings(self.content)?
                .explicit_maximum_seed_foundation_object_ids
                .binary_search(&object.object_id)
                .is_err()
        {
            return Ok(());
        }
        let target_terrain = native_foundation_target(
            self.foundation_terrain_remap,
            foundation.terrain_id,
            object.owner,
            self.viewing_player,
        );
        let compatibility_rule = self.content.foundation_terrain_rule(target_terrain);
        let map_width = usize::from(self.dimensions.width);
        let anchor_index = usize::try_from(object.y_256 / 256)
            .ok()
            .and_then(|row| row.checked_mul(map_width))
            .and_then(|row| {
                usize::try_from(object.x_256 / 256)
                    .ok()
                    .and_then(|column| row.checked_add(column))
            })
            .filter(|index| *index < self.terrain.len() && *index < self.land_id.len())
            .ok_or_else(|| invalid_object("foundation anchor is outside the map"))?;
        let anchor_primary_class = self
            .content
            .terrain(self.terrain[anchor_index])
            .map_or(0, |terrain| terrain.placement_class);
        let anchor_secondary_id = TerrainId(u32::from(self.land_id[anchor_index] as u8));
        let anchor_secondary_class = self
            .content
            .terrain(anchor_secondary_id)
            .map_or(0, |terrain| terrain.placement_class);
        let class_replacement = compatibility_rule
            .and_then(|rule| rule.anchor_class_replacement)
            .filter(|replacement| {
                (anchor_primary_class | anchor_secondary_class)
                    & replacement.anchor_placement_class_mask
                    != 0
            });
        let (comparison_terrain, replacement_primary, replacement_secondary) = class_replacement
            .map_or((target_terrain, target_terrain, u16::MAX), |replacement| {
                (
                    replacement.comparison_terrain_id,
                    replacement.primary_terrain_id,
                    replacement.secondary_terrain_id,
                )
            });
        let width = i64::from(object.footprint_width_256);
        let height = i64::from(object.footprint_height_256);
        let x_twice = i64::from(object.x_256) * 2;
        let y_twice = i64::from(object.y_256) * 2;
        let maximum_x = i64::from(self.dimensions.width) - 1;
        let maximum_y = i64::from(self.dimensions.height) - 1;
        let minimum_x = ((x_twice - width) / 512).clamp(0, maximum_x);
        let minimum_y = ((y_twice - height) / 512).clamp(0, maximum_y);
        let maximum_x = ((x_twice + width - 1) / 512).clamp(0, maximum_x);
        let maximum_y = ((y_twice + height - 1) / 512).clamp(0, maximum_y);
        if minimum_x > maximum_x || minimum_y > maximum_y {
            return Ok(());
        }
        let columns = u64::try_from(maximum_x - minimum_x + 1)
            .map_err(|_| invalid_object("foundation width is invalid"))?;
        let rows = u64::try_from(maximum_y - minimum_y + 1)
            .map_err(|_| invalid_object("foundation height is invalid"))?;
        self.work = self.work.saturating_add(columns.saturating_mul(rows));
        if self.work > MAXIMUM_CANDIDATE_WORK {
            return Err(GenerationError::ResourceLimit {
                resource: "object foundation work".to_owned(),
                limit: MAXIMUM_CANDIDATE_WORK,
            });
        }
        for y in minimum_y..=maximum_y {
            for x in minimum_x..=maximum_x {
                let cell = FoundationCell {
                    x: u16::try_from(x - minimum_x)
                        .map_err(|_| invalid_object("foundation X offset exceeds u16"))?,
                    y: u16::try_from(y - minimum_y)
                        .map_err(|_| invalid_object("foundation Y offset exceeds u16"))?,
                };
                if foundation.omitted_cells.binary_search(&cell).is_ok() {
                    continue;
                }
                let index = usize::try_from(y)
                    .ok()
                    .and_then(|row| row.checked_mul(map_width))
                    .and_then(|row| {
                        usize::try_from(x)
                            .ok()
                            .and_then(|column| row.checked_add(column))
                    })
                    .ok_or_else(|| invalid_object("foundation tile index overflow"))?;
                let prior_terrain = self.terrain[index];
                let prior_land_id = self.land_id[index];
                if FOUNDATION_PROTECTED_TERRAINS.contains(&prior_terrain) {
                    continue;
                }
                if compatibility_rule.is_some_and(|rule| {
                    rule.protected_source_terrain_ids
                        .binary_search(&prior_terrain)
                        .is_ok()
                }) {
                    continue;
                }
                if class_replacement.is_some() {
                    if prior_terrain == comparison_terrain {
                        continue;
                    }
                } else if let Some(rule) = compatibility_rule {
                    let terrain_compatible = rule
                        .compatible_source_terrain_ids
                        .binary_search(&prior_terrain)
                        .is_ok();
                    let signed_land_id = prior_land_id as i16;
                    let land_compatible = signed_land_id < 0
                        || rule
                            .compatible_source_terrain_ids
                            .binary_search(&TerrainId(signed_land_id as u32))
                            .is_ok();
                    if !terrain_compatible || !land_compatible {
                        continue;
                    }
                } else if prior_terrain == target_terrain {
                    continue;
                }
                self.land_id[index] = replacement_secondary;
                if self.deferred_foundations.enabled
                    && foundation_paint_is_deferred(object.object_id, comparison_terrain)
                {
                    self.deferred_foundations.tiles.push(index);
                } else if prior_terrain != replacement_primary {
                    self.terrain[index] = replacement_primary;
                    self.painted = self.painted.saturating_add(1);
                }
                self.operation_indices[index] = operation_index;
            }
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub fn resolve_exact_object_state(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    land: &ExactLandState,
    cliff: &ExactCliffState,
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    rng: RmsRandom,
    auxiliary_rng: RmsRandom,
    cancellation: &dyn CancellationToken,
) -> Result<ExactObjectState, GenerationError> {
    resolve_exact_object_state_with_substages(
        semantic_program,
        setup,
        land,
        cliff,
        connection,
        content,
        rng,
        auxiliary_rng,
        cancellation,
        &mut |_, _| {},
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_exact_object_state_with_substages(
    semantic_program: &SemanticProgram,
    setup: &ExactSetupState,
    land: &ExactLandState,
    cliff: &ExactCliffState,
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    mut rng: RmsRandom,
    mut auxiliary_rng: RmsRandom,
    cancellation: &dyn CancellationToken,
    substage: &mut dyn FnMut(&[TerrainId], &[PlacedObject]),
) -> Result<ExactObjectState, GenerationError> {
    if setup.effective_dimensions != connection.dimensions
        || land.dimensions != connection.dimensions
        || cliff.dimensions != connection.dimensions
    {
        return Err(invalid_object("object inputs disagree on map dimensions"));
    }
    let tile_count = connection.dimensions.tile_count()?;
    if connection.terrain.len() != tile_count
        || connection.elevation.len() != tile_count
        || connection.land_id.len() != tile_count
        || connection.terrain_zone.len() != tile_count
    {
        return Err(invalid_object(
            "object input columns do not match map dimensions",
        ));
    }
    validate_terrain_content(connection, content)?;
    let _queue_buffers = QueueBufferScope::enter();
    let (gaia_civilization_id, actor_areas, object_groups, mut descriptors) =
        collect_object_program(semantic_program, setup, content)?;
    let runtime_attributes =
        object_stage_runtime_attributes(&connection.restriction_zones, &cliff.master_facets);
    if cliff.next_instance_id
        < u32::try_from(land.appearance_objects.len())
            .map_err(|_| invalid_object("land appearance identities exceed u32"))?
        || cliff
            .piece_objects
            .iter()
            .any(|object| object.instance_id >= cliff.next_instance_id)
        || cliff.appearance_objects.iter().any(|(identity, _)| {
            *identity < land.appearance_objects.len() as u32 || *identity >= cliff.next_instance_id
        })
        || cliff
            .appearance_objects
            .windows(2)
            .any(|pair| pair[0].0 >= pair[1].0)
    {
        return Err(invalid_object(
            "cliff world identity cursor is inconsistent",
        ));
    }
    let mut module_entry_pieces =
        surviving_cliff_pieces(&cliff.piece_objects, &connection.restriction_zones)?;
    let module_entry_cliff_appearances = cliff
        .appearance_objects
        .iter()
        .filter_map(|(identity, seed)| {
            connection
                .restriction_zones
                .objects
                .object(*identity)
                .map(|object| {
                    if object.object_id != seed.object_id || object.owner != 0 {
                        Err(invalid_object(
                            "cliff appearance live identity differs from its construction seed",
                        ))
                    } else {
                        Ok((*identity, *seed))
                    }
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut actor_areas = ActorAreaState::with_land_context(
        actor_areas,
        connection.dimensions,
        land.descriptors
            .first()
            .and_then(|descriptor| descriptor.assigned_slot)
            .filter(|slot| *slot != 0),
        land.descriptors
            .first()
            .map(|descriptor| descriptor.position),
    )?;
    actor_areas.index.enable_rasters(
        descriptors
            .iter()
            .flat_map(|descriptor| descriptor.avoid_actor_areas.iter().copied()),
    );
    validate_object_content(&descriptors, &object_groups, content)?;
    validate_replacement_gates(semantic_program, content)?;

    rng.next_u32();
    let appearance_before = rng.state().draws();
    let mut restriction_zones = connection.restriction_zones.clone();
    let mut retained_module_entry_appearances = Vec::new();
    let mut blocking_module_entry_appearances = Vec::new();
    for (identity, appearance) in land
        .appearance_objects
        .iter()
        .enumerate()
        .map(|(identity, appearance)| (identity as u32, appearance))
        .chain(
            module_entry_cliff_appearances
                .iter()
                .map(|(identity, appearance)| (*identity, appearance)),
        )
    {
        let Some(object) = restriction_zones.objects.object(identity) else {
            continue;
        };
        if object.object_id != appearance.object_id || object.owner != 0 {
            return Err(invalid_object(
                "module-entry appearance differs from its live world identity",
            ));
        }
        if object.lifecycle < 7 {
            let rebased = rebase_module_entry_appearance(
                *appearance,
                object.tile,
                connection.dimensions,
                &connection.terrain,
            )?;
            if module_entry_appearance_blocks_refresh(*appearance, rebased) {
                blocking_module_entry_appearances.push(rebased);
            }
            retained_module_entry_appearances.push(rebased);
        }
    }
    let appearance_objects = consume_terrain_appearance_rng(
        connection,
        &module_entry_pieces,
        &retained_module_entry_appearances,
        &blocking_module_entry_appearances,
        cliff.next_instance_id,
        content,
        &runtime_attributes,
        &mut restriction_zones,
        &mut rng,
        &mut auxiliary_rng,
        cancellation,
    )?;
    let appearance_rng_draws = rng.state().draws() - appearance_before;
    synchronize_lifecycle(&mut module_entry_pieces, &restriction_zones.objects)?;
    let module_entry_cliff_retired = module_entry_retirement_mask(
        module_entry_cliff_appearances
            .iter()
            .map(|(identity, _)| *identity),
        &BTreeSet::new(),
        &restriction_zones.objects,
    )?;
    let module_entry_retired = module_entry_retirement_mask(
        0..land.appearance_objects.len() as u32,
        &connection.removed_land_appearances,
        &restriction_zones.objects,
    )?;
    if connection
        .removed_land_appearances
        .iter()
        .any(|ordinal| *ordinal as usize >= land.appearance_objects.len())
    {
        return Err(invalid_object(
            "removed land appearance identity is outside its construction sequence",
        ));
    }

    let auxiliary_observed_entry_draws = auxiliary_rng.state().draws();

    let piece_count = module_entry_pieces.len();
    let mut objects = module_entry_pieces.clone();
    let mut object_operation_indices = vec![u32::MAX; piece_count];
    let mut placed_object_classes =
        PlacedObjectClassGrid::new(connection.dimensions, &descriptors)?;
    placed_object_classes.register(&objects, 0, &BTreeMap::new(), content, &runtime_attributes)?;
    let mut candidate_availability = CandidateAvailability::new(connection.dimensions, tile_count);
    let mut terrain = connection.terrain.clone();
    let mut land_id = connection.land_id.clone();
    let mut tile_operation_indices = connection.tile_operation_indices.clone();
    require_standard_start_research(setup, content)?;
    let generation_rules = generation_rules(&semantic_program.identity.profile)?;
    let spawn_placement = generation_rules.building_spawn_placement;
    let foundation_terrain_remap = generation_rules.foundation_terrain_remap;
    let mut foundation_map = FoundationMap {
        restriction_zones,
        next_instance_id: cliff
            .next_instance_id
            .checked_add(
                u32::try_from(appearance_objects.objects.len())
                    .map_err(|_| invalid_object("appearance identity count exceeds u32"))?,
            )
            .ok_or_else(|| invalid_object("object construction identity exceeds u32"))?,
        dimensions: connection.dimensions,
        generation_program_mode: NativeGenerationProgramMode::for_explicit_seed(
            semantic_program.execution_context.seed,
        ),
        automatic_technologies: AutomaticTechnologyState::new(
            setup,
            content,
            semantic_program.execution_context.seed,
        )
        .map(|mut state| {
            state.spawn_placement = spawn_placement;
            state
        }),
        content,
        runtime_attributes: &runtime_attributes,
        terrain: &mut terrain,
        land_id: &mut land_id,
        operation_indices: &mut tile_operation_indices,
        work: 0,
        painted: 0,
        construction_positions: BTreeMap::new(),
        pending_neighbor_completion: Vec::new(),
        obstruction_index: ObstructionIndex::default(),
        lifecycle_projection: LifecycleProjection::default(),
        list_classes: ListClassIndex::default(),
        stale_links: StaleHeaderLinks::default(),
        foundation_terrain_remap,
        viewing_player: viewing_player(setup),
        deferred_foundations: DeferredFoundations::object_module(),
    };
    let mut statistics = ExactObjectStatistics {
        stage_entry_rng_draws: 1,
        appearance_rng_draws,
        ..ExactObjectStatistics::default()
    };
    let mut wall_path_cache = None;
    for (descriptor_index, descriptor) in descriptors.iter_mut().enumerate() {
        cancellation_checkpoint(cancellation, GenerationStage::Objects, rng.state().draws())?;
        let land_local_dispatch =
            descriptor.specific_land_id.is_some() || descriptor.place_for_every_player;
        let (placements, final_land_cursor) =
            descriptor_dispatch_placements(descriptor, &land.descriptors);
        for player in placements {
            if land_local_dispatch {
                actor_areas.current_land_context =
                    player.map(|value| value.0).filter(|slot| *slot != 0);
                actor_areas.current_land_center = player.map(|(_, center)| center);
            }
            let objects_before = objects.len();
            place_descriptor(
                descriptor_index,
                descriptor,
                player,
                setup,
                &land.descriptors,
                connection,
                &land.land_zone,
                content,
                &runtime_attributes,
                &appearance_objects,
                &placed_object_classes,
                &mut candidate_availability,
                &mut actor_areas,
                &object_groups,
                &mut rng,
                &mut auxiliary_rng,
                &mut objects,
                &mut object_operation_indices,
                &mut foundation_map,
                &mut wall_path_cache,
                &mut statistics,
                cancellation,
            )?;
            placed_object_classes.register(
                &objects[objects_before..],
                objects_before,
                &foundation_map.construction_positions,
                content,
                &runtime_attributes,
            )?;
        }
        if land_local_dispatch && let Some(cursor) = final_land_cursor {
            let cursor_land = &land.descriptors[cursor];
            actor_areas.current_land_context = cursor_land.assigned_slot.filter(|slot| *slot != 0);
            actor_areas.current_land_center = Some(cursor_land.position);
        }
        substage(&foundation_map.terrain[..], &objects);
    }
    statistics.auxiliary_rng_draws = auxiliary_rng
        .state()
        .draws()
        .saturating_sub(auxiliary_observed_entry_draws);
    foundation_map.paint_deferred_foundations();
    statistics.foundation_tiles_painted = foundation_map.painted;
    let mut scripted_position_overrides = foundation_map
        .construction_positions
        .into_iter()
        .map(|(index, position)| (index - piece_count, position))
        .collect();
    let prelude_count = usize::try_from(cliff.next_instance_id)
        .map_err(|_| invalid_object("cliff identity exceeds usize"))?
        .checked_add(appearance_objects.objects.len())
        .ok_or_else(|| invalid_object("object instance count overflow"))?;
    let scripted_objects = objects.split_off(piece_count);
    let mut module_exit_pieces = objects;
    let mut objects = scripted_objects;
    let mut object_operation_indices = object_operation_indices.split_off(piece_count);
    for (ordinal, object) in objects.iter_mut().enumerate() {
        let expected_identity = u32::try_from(prelude_count.saturating_add(ordinal))
            .map_err(|_| invalid_object("object instance identity exceeds u32"))?;
        if object.instance_id != expected_identity {
            return Err(invalid_object("object identity changed after construction"));
        }
        object.z_256 = object_elevation_256(
            construction_position(ordinal, object, &scripted_position_overrides),
            connection.dimensions,
            &connection.elevation,
        )?;
    }
    compact_destroyed_projection(
        &mut objects,
        &mut object_operation_indices,
        &mut scripted_position_overrides,
        &foundation_map.restriction_zones.objects,
    )?;
    module_exit_pieces.retain(|object| {
        !foundation_map
            .restriction_zones
            .objects
            .was_destroyed(object.instance_id)
    });
    apply_gaia_master_graphic_replacements(&mut objects, gaia_civilization_id, content)?;
    let restriction_zones = foundation_map.restriction_zones;
    let post_rms_next_instance_id = foundation_map.next_instance_id;
    let automatic_technologies = foundation_map.automatic_technologies;
    Ok(ExactObjectState {
        dimensions: connection.dimensions,
        terrain,
        land_id,
        tile_operation_indices,
        gaia_civilization_id,
        actor_areas: actor_areas.logical,
        object_groups,
        descriptors,
        objects,
        object_operation_indices,
        scripted_position_overrides,
        rng_state: rng.state(),
        auxiliary_rng_state: auxiliary_rng.state(),
        statistics,
        module_entry_appearances: land.appearance_objects.clone(),
        module_entry_cliff_appearances,
        module_entry_cliff_retired,
        module_entry_removed: connection.removed_land_appearances.clone(),
        module_entry_pieces,
        module_exit_pieces,
        module_entry_next_instance_id: cliff.next_instance_id,
        module_entry_retired,
        terrain_appearances: appearance_objects,
        runtime_attributes,
        restriction_zones,
        post_rms_next_instance_id,
        post_rms_objects: Vec::new(),
        post_rms_positions: BTreeMap::new(),
        automatic_technologies,
        foundation_terrain_remap,
    })
}

const DESCENDING_IDENTITY_CONSTRUCTOR_TYPES: [u8; 2] = [25, 60];

pub(crate) fn native_identity_order(
    objects: &[PlacedObject],
    content: CompatibleContentView<'_>,
) -> Option<Vec<usize>> {
    let descending = |object: &PlacedObject| {
        content
            .object(object.object_id)
            .and_then(|definition| definition.constructor_type)
            .is_some_and(|kind| DESCENDING_IDENTITY_CONSTRUCTOR_TYPES.contains(&kind))
    };
    if !objects.iter().any(descending) {
        return None;
    }
    let mut order = (0..objects.len())
        .rev()
        .filter(|&index| descending(&objects[index]))
        .collect::<Vec<_>>();
    order.extend((0..objects.len()).filter(|&index| !descending(&objects[index])));
    Some(order)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finalize_game_mode_player_objects(
    state: &mut ExactObjectState,
    setup: &ExactSetupState,
    land: &ExactLandState,
    connection: &ExactConnectionState,
    generation_program_mode: NativeGenerationProgramMode,
    content: CompatibleContentView<'_>,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let Some(rule) = content.game_mode_player_object_rule(setup.game_mode.native_value()) else {
        return Ok(());
    };
    if state.dimensions != setup.effective_dimensions
        || state.dimensions != land.dimensions
        || state.dimensions != connection.dimensions
    {
        return Err(invalid_object(
            "game-mode object inputs disagree on map dimensions",
        ));
    }

    let mut players = setup.players.iter().collect::<Vec<_>>();
    players.sort_by_key(|player| player.slot);
    let mut placements = Vec::with_capacity(players.len());
    for player in players {
        let anchor_id = content.substituted_object(player.civilization_id, rule.anchor_object_id);
        let Some(coordinate) = game_mode_player_anchor_coordinate(
            &state
                .objects
                .iter()
                .chain(&state.post_rms_objects)
                .cloned()
                .collect::<Vec<_>>(),
            player.slot,
            anchor_id,
            state.dimensions,
        )?
        else {
            continue;
        };
        placements.push((player.slot, coordinate));
    }
    if placements.is_empty() {
        return Ok(());
    }

    let mut descriptors = placements
        .iter()
        .map(|_| game_mode_player_object_descriptor(rule))
        .collect::<Vec<_>>();
    validate_object_content(&descriptors, &[], content)?;

    let mut placement_objects = Vec::with_capacity(
        state
            .module_exit_pieces
            .len()
            .saturating_add(state.objects.len())
            .saturating_add(placements.len()),
    );
    placement_objects.extend(state.module_exit_pieces.iter().cloned());
    placement_objects.extend(state.objects.iter().cloned());
    placement_objects.extend(state.post_rms_objects.iter().cloned());
    let piece_count = state.module_exit_pieces.len();
    let mut construction_positions = state
        .scripted_position_overrides
        .iter()
        .map(|(index, position)| (piece_count + index, *position))
        .collect::<BTreeMap<_, _>>();
    construction_positions.extend(
        state
            .post_rms_positions
            .iter()
            .map(|(index, position)| (piece_count + state.objects.len() + index, *position)),
    );
    let mut operation_indices = vec![u32::MAX; placement_objects.len()];
    let mut placed_object_classes = PlacedObjectClassGrid::new(state.dimensions, &descriptors)?;
    placed_object_classes.register(
        &placement_objects,
        0,
        &construction_positions,
        content,
        state.runtime_attributes.as_ref(),
    )?;
    let mut candidate_availability =
        CandidateAvailability::new(state.dimensions, state.dimensions.tile_count()?);
    let mut actor_areas = ActorAreaState::new(Vec::new(), state.dimensions)?;
    let mut rng = RmsRandom::from_state(state.rng_state);
    let mut auxiliary_rng = RmsRandom::from_state(state.auxiliary_rng_state);
    let mut wall_path_cache = None;
    let mut statistics = ExactObjectStatistics::default();
    let runtime_attributes = state.runtime_attributes.as_ref();
    let terrain_appearances = &state.terrain_appearances;
    let mut foundation_map = FoundationMap {
        restriction_zones: state.restriction_zones.clone(),
        next_instance_id: state.post_rms_next_instance_id,
        dimensions: state.dimensions,
        generation_program_mode,
        automatic_technologies: state.automatic_technologies.take(),
        content,
        runtime_attributes,
        terrain: &mut state.terrain,
        land_id: &mut state.land_id,
        operation_indices: &mut state.tile_operation_indices,
        work: 0,
        painted: 0,
        construction_positions,
        pending_neighbor_completion: Vec::new(),
        obstruction_index: ObstructionIndex::default(),
        lifecycle_projection: LifecycleProjection::default(),
        list_classes: ListClassIndex::default(),
        stale_links: StaleHeaderLinks::default(),
        foundation_terrain_remap: state.foundation_terrain_remap,
        viewing_player: viewing_player(setup),
        deferred_foundations: DeferredFoundations::immediate(),
    };

    for (descriptor_index, ((slot, center), descriptor)) in placements
        .into_iter()
        .zip(descriptors.iter_mut())
        .enumerate()
    {
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Finalize,
            descriptor_index as u64,
        )?;
        let objects_before = placement_objects.len();
        place_descriptor(
            descriptor_index,
            descriptor,
            Some((slot, center)),
            setup,
            &land.descriptors,
            connection,
            &land.land_zone,
            content,
            runtime_attributes,
            terrain_appearances,
            &placed_object_classes,
            &mut candidate_availability,
            &mut actor_areas,
            &[],
            &mut rng,
            &mut auxiliary_rng,
            &mut placement_objects,
            &mut operation_indices,
            &mut foundation_map,
            &mut wall_path_cache,
            &mut statistics,
            cancellation,
        )?;
        placed_object_classes.register(
            &placement_objects[objects_before..],
            objects_before,
            &foundation_map.construction_positions,
            content,
            runtime_attributes,
        )?;
    }
    state.restriction_zones = foundation_map.restriction_zones;
    state.automatic_technologies = foundation_map.automatic_technologies;
    compact_destroyed_projection(
        &mut state.objects,
        &mut state.object_operation_indices,
        &mut state.scripted_position_overrides,
        &state.restriction_zones.objects,
    )?;
    state.module_exit_pieces.retain(|object| {
        !state
            .restriction_zones
            .objects
            .was_destroyed(object.instance_id)
    });
    Ok(())
}

fn compact_destroyed_projection(
    objects: &mut Vec<PlacedObject>,
    operations: &mut Vec<u32>,
    positions: &mut BTreeMap<usize, [u32; 2]>,
    roster: &super::exact_world::ObjectRoster,
) -> Result<(), GenerationError> {
    if objects.len() != operations.len() || positions.keys().any(|index| *index >= objects.len()) {
        return Err(invalid_object("object survivor projection is not aligned"));
    }
    if !roster.has_destroyed() {
        return Ok(());
    }
    for object in objects.iter() {
        if !roster.was_destroyed(object.instance_id) && roster.object(object.instance_id).is_none()
        {
            return Err(invalid_object(
                "object survivor identity has no birth or destruction",
            ));
        }
    }
    let old_positions = std::mem::take(positions);
    let mut kept = 0;
    for index in 0..objects.len() {
        if roster.was_destroyed(objects[index].instance_id) {
            continue;
        }
        objects.swap(kept, index);
        operations.swap(kept, index);
        if let Some(position) = old_positions.get(&index) {
            positions.insert(kept, *position);
        }
        kept += 1;
    }
    objects.truncate(kept);
    operations.truncate(kept);
    synchronize_lifecycle(objects, roster)
}

fn game_mode_player_anchor_coordinate(
    objects: &[PlacedObject],
    player_slot: u8,
    anchor_id: ObjectId,
    dimensions: MapDimensions,
) -> Result<Option<MapCoordinate>, GenerationError> {
    let Some(anchor) = objects
        .iter()
        .find(|object| object.owner == player_slot && object.object_id == anchor_id)
    else {
        return Ok(None);
    };
    let x = u16::try_from(anchor.x_256 / 256)
        .map_err(|_| invalid_object("game-mode object anchor X exceeds u16"))?;
    let y = u16::try_from(anchor.y_256 / 256)
        .map_err(|_| invalid_object("game-mode object anchor Y exceeds u16"))?;
    let coordinate = MapCoordinate { x, y };
    if coordinate.x >= dimensions.width || coordinate.y >= dimensions.height {
        return Err(invalid_object(
            "game-mode object anchor lies outside map dimensions",
        ));
    }
    Ok(Some(coordinate))
}

fn game_mode_player_object_descriptor(
    rule: rms_content::GameModePlayerObjectRule,
) -> ExactObjectDescriptor {
    ExactObjectDescriptor {
        object_id: Some(rule.object_id),
        object_group_name: None,
        number_of_groups: 1,
        number_of_objects: 1,
        group_variance: 1,
        group_placement_radius: 2,
        grouping: ExactObjectGrouping::Default,
        scaling: ExactObjectScaling::None,
        place_for_every_player: false,
        gaia_object_only: false,
        explicit_facet: None,
        second_object_id: None,
        second_object_group_name: None,
        resource_delta: 0,
        behavior_flags: 0,
        terrain_to_place_on: None,
        layer_to_place_on: None,
        specific_land_id: None,
        ignore_terrain_restrictions: false,
        player_distance_command: false,
        minimum_player_distance_command: false,
        minimum_distance_to_players: rule.inner_radius,
        maximum_distance_to_players: Some(rule.outer_radius),
        minimum_distance_to_map_edge: 0,
        maximum_distance_to_other_zones: None,
        minimum_group_distance: 0,
        temporary_minimum_group_distance: 0,
        minimum_connected_tiles: -1,
        override_actor_radius_if_required: false,
        avoid_other_land_zones: false,
        avoid_other_land_zones_distance: 0,
        path_requirement: 0,
        actor_area: None,
        actor_area_to_place_in: None,
        avoid_actor_areas: Vec::new(),
        avoid_all_actor_areas: false,
        actor_area_radius: 1,
        object_class_filter: None,
        find_closest: false,
        find_closest_to_map_center: None,
        find_closest_to_map_edge: None,
        circular_placement: false,
        tile_shuffling: false,
        force_placement: false,
        remove_obstructions: false,
        generate_for_first_land_only: false,
        operation_index: u32::MAX,
    }
}

fn surviving_cliff_pieces(
    pieces: &[PlacedObject],
    zones: &ExactRestrictionZones,
) -> Result<Vec<PlacedObject>, GenerationError> {
    pieces
        .iter()
        .filter_map(|piece| {
            zones.objects.object(piece.instance_id).map(|object| {
                if object.object_id != piece.object_id || object.owner != piece.owner {
                    Err(invalid_object(
                        "cliff piece live identity differs from its construction state",
                    ))
                } else {
                    Ok(piece.clone())
                }
            })
        })
        .collect()
}

fn descriptor_dispatch_placements(
    descriptor: &ExactObjectDescriptor,
    land_descriptors: &[ExactLandDescriptor],
) -> (Vec<Option<(u8, MapCoordinate)>>, Option<usize>) {
    if descriptor.specific_land_id.is_none() && !descriptor.place_for_every_player {
        return (vec![None], None);
    }
    let mut placed_player_indices = [false; 8];
    let mut placements = Vec::new();
    let mut cursor = land_descriptors.len().checked_sub(1);
    for (land_index, land) in land_descriptors.iter().enumerate() {
        let player_index = descriptor
            .generate_for_first_land_only
            .then(|| first_land_player_index(descriptor, land));
        if player_index.is_some_and(|index| placed_player_indices[index]) {
            cursor = Some(land_index);
            break;
        }
        let placement = if let Some(specific_land_id) = descriptor.specific_land_id {
            (land.object_placement_id == i32::from(specific_land_id))
                .then(|| (land.assigned_slot.unwrap_or(0), land.position))
        } else {
            (land.object_placement_id == 1)
                .then_some(land.assigned_slot)
                .flatten()
                .map(|slot| (slot, land.position))
        };
        let Some(placement) = placement else {
            continue;
        };
        placements.push(Some(placement));
        if let Some(index) = player_index {
            placed_player_indices[index] = true;
        }
    }
    (placements, cursor)
}

fn first_land_player_index(
    descriptor: &ExactObjectDescriptor,
    land: &ExactLandDescriptor,
) -> usize {
    if descriptor.gaia_object_only {
        return 0;
    }
    usize::from(land.assigned_slot.unwrap_or(0))
        .checked_sub(1)
        .filter(|index| *index < 8)
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn place_descriptor(
    descriptor_index: usize,
    descriptor: &mut ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    setup: &ExactSetupState,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    land_zones: &[u32],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    appearance_objects: &TerrainAppearanceObjects,
    placed_object_classes: &PlacedObjectClassGrid,
    candidate_availability: &mut CandidateAvailability,
    actor_areas: &mut ActorAreaState,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
    wall_path_cache: &mut Option<WallPathCache>,
    statistics: &mut ExactObjectStatistics,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let before_primary = rng.state().draws();
    let before_auxiliary = auxiliary_rng.state().draws();
    let mut attempt = ExactObjectAttempt {
        descriptor_index: u16::try_from(descriptor_index)
            .map_err(|_| invalid_object("object descriptor index exceeds u16"))?,
        player_slot: player.map(|value| value.0),
        candidate_count: 0,
        candidate_shuffle_iterations: 0,
        candidate_collection_rng_draws: 0,
        candidate_shuffle_rng_draws: 0,
        groups_requested: effective_group_count(
            descriptor,
            setup,
            connection.dimensions,
            object_groups,
            content,
        )?,
        groups_accepted: 0,
        objects_created: 0,
        exhausted: false,
        primary_rng_draws_before: before_primary,
        primary_rng_draws_after: before_primary,
        auxiliary_rng_draws_before: before_auxiliary,
        auxiliary_rng_draws_after: before_auxiliary,
    };

    let empty_request = attempt.groups_requested == 0;
    let owner = if descriptor.gaia_object_only {
        0
    } else {
        player.map_or(0, |value| value.0)
    };

    if !empty_request
        && let Some(center) = direct_zero_radius_anchor(
            descriptor,
            player,
            connection.dimensions,
            object_groups,
            content,
        )
    {
        let restriction = candidate_restriction(
            descriptor,
            object_groups,
            content,
            runtime_attributes,
            owner,
        );
        let candidate_definition = descriptor_runtime_object_definition(
            descriptor,
            object_groups,
            content,
            runtime_attributes,
            owner,
        );
        let restriction_zones = restriction_zone_labels(
            descriptor,
            connection.dimensions,
            foundation_map.terrain,
            restriction,
            &mut foundation_map.restriction_zones,
        )?;
        let accepted = candidate_predicates_match(
            descriptor,
            player,
            center,
            land_descriptors,
            connection,
            foundation_map.terrain,
            foundation_map.land_id,
            restriction,
            restriction_zones.as_deref(),
            candidate_definition,
            actor_areas.view(),
            appearance_objects,
            objects,
            content,
            true,
            &foundation_map.restriction_zones.objects,
            Some(&foundation_map.list_classes),
        );
        attempt.candidate_count = u32::from(accepted);
        if accepted {
            let created_before = objects.len();
            place_group(
                descriptor,
                center,
                None,
                player,
                land_zones,
                owner,
                setup,
                connection,
                content,
                runtime_attributes,
                appearance_objects,
                actor_areas,
                candidate_availability,
                None,
                object_groups,
                rng,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
                cancellation,
            )?;
            let created = objects.len() - created_before;
            attempt.groups_accepted = u32::from(created > 0);
            attempt.objects_created = u32::try_from(created).unwrap_or(u32::MAX);
            if created > 0 {
                candidate_availability.invalidate_for_anchor(
                    center,
                    descriptor.minimum_group_distance,
                    objects.get(created_before).map(|object| object.object_id),
                    foundation_map.terrain,
                    content,
                    runtime_attributes,
                );
            }
        } else {
            attempt.exhausted = true;
            statistics.exhausted_descriptors += 1;
            statistics.rejected_groups += u64::from(attempt.groups_requested);
        }
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt);
        return Ok(());
    }

    let villager_groups = if empty_request {
        None
    } else {
        starting_villager_group_count(
            descriptor,
            player.is_some(),
            attempt.groups_requested,
            owner,
            content,
            runtime_attributes,
        )
    };
    if let Some(expanded_groups) = villager_groups
        && !(descriptor.number_of_objects == 1 && descriptor.group_variance == 0)
    {
        attempt.groups_requested = expanded_groups;
    }
    if let Some(expanded_count) = villager_groups
        && descriptor.number_of_objects == 1
        && descriptor.group_variance == 0
    {
        place_expanded_single_request(
            descriptor,
            player,
            expanded_count,
            setup,
            land_descriptors,
            connection,
            content,
            runtime_attributes,
            appearance_objects,
            placed_object_classes,
            candidate_availability,
            actor_areas,
            object_groups,
            rng,
            auxiliary_rng,
            objects,
            operation_indices,
            foundation_map,
            statistics,
            cancellation,
            &mut attempt,
        )?;
        return Ok(());
    }

    let queue_actor_area_count = actor_areas.logical.len();
    let candidate_window =
        CandidateWindow::for_descriptor(descriptor, player, connection.dimensions);
    let candidate_collection_rng_before = rng.state().draws();
    let class_filter_master =
        ClassFilterMaster::for_request(descriptor, object_groups, content, runtime_attributes);
    let actor_area_route = actor_area_queue_route(descriptor, actor_areas);
    let masks = (!actor_area_route)
        .then(|| {
            RequestMask::build(
                descriptor,
                player,
                connection.dimensions,
                actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
                    .for_request(&descriptor.avoid_actor_areas),
                candidate_availability,
                &class_filter_master,
                ClassInputs {
                    placed_object_classes,
                    appearance_objects,
                    terrain: foundation_map.terrain,
                    terrain_writes: foundation_map.painted,
                    content,
                    roster: &foundation_map.restriction_zones.objects,
                },
            )
        })
        .flatten();
    let (candidates, shuffle_iterations, actor_area_route) = if actor_area_route {
        let (candidates, iterations) = collect_actor_area_candidates(
            descriptor,
            player,
            setup,
            connection,
            foundation_map.terrain,
            content,
            runtime_attributes,
            owner,
            actor_areas,
            object_groups,
            candidate_availability,
            appearance_objects,
            objects,
            rng,
            cancellation,
            &foundation_map.restriction_zones.objects,
            Some(&foundation_map.list_classes),
        )?;
        (candidates, iterations, true)
    } else {
        let candidates = collect_candidates(
            descriptor,
            player,
            setup,
            connection,
            foundation_map.terrain,
            foundation_map.painted,
            runtime_attributes,
            actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
                .for_request(&descriptor.avoid_actor_areas),
            object_groups,
            candidate_availability,
            appearance_objects,
            placed_object_classes,
            content,
            foundation_map.restriction_zones.objects.as_ref(),
            &class_filter_master,
            masks.as_ref(),
            rng,
        )?;
        (candidates, 0, false)
    };
    attempt.candidate_collection_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(candidate_collection_rng_before);
    attempt.candidate_count = candidates.len() as u32;
    statistics.candidate_tiles = statistics
        .candidate_tiles
        .saturating_add(candidates.len() as u64);
    if actor_area_route {
        attempt.candidate_shuffle_iterations = shuffle_iterations;
        statistics.candidate_shuffle_iterations += u64::from(shuffle_iterations);
        statistics.candidate_rng_draws += u64::from(shuffle_iterations);
    }
    let dynamic_class_filter = descriptor.object_class_filter.is_some();
    let candidate_shuffle_rng_before = rng.state().draws();
    let shuffle_actor_areas = actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
        .for_request(&descriptor.avoid_actor_areas);
    let accepts = |present: bool, coordinate: MapCoordinate, rng: &mut RmsRandom| {
        if !dynamic_class_filter || actor_area_route {
            return Ok(present);
        }
        candidate_mask::sample_with_masks(
            masks.as_ref(),
            coordinate,
            &class_filter_master,
            object_groups,
            setup,
            content,
            runtime_attributes,
            rng,
            |rng| {
                candidate_matches_resolving_class_filter(
                    descriptor,
                    player,
                    coordinate,
                    runtime_attributes,
                    setup,
                    connection,
                    foundation_map.terrain,
                    foundation_map.painted,
                    shuffle_actor_areas,
                    object_groups,
                    candidate_availability,
                    appearance_objects,
                    placed_object_classes,
                    content,
                    &class_filter_master,
                    rng,
                    &foundation_map.restriction_zones.objects,
                )
            },
        )
    };
    let global_header = player.is_none();
    let (mut queue, generic_shuffle_iterations) =
        if global_header && !foundation_map.stale_links.is_empty() {
            CandidateQueue::new_over_stale_links(
                connection.dimensions,
                candidate_window,
                candidates,
                false,
                !actor_area_route,
                rng,
                cancellation,
                accepts,
                &mut foundation_map.stale_links,
            )?
        } else {
            let built = CandidateQueue::new_with_shuffle_predicate(
                connection.dimensions,
                candidate_window,
                candidates,
                false,
                !actor_area_route,
                rng,
                cancellation,
                accepts,
            )?;
            foundation_map.stale_links.release_linked(&built.0, None);
            built
        };
    attempt.candidate_shuffle_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(candidate_shuffle_rng_before);
    if !actor_area_route {
        attempt.candidate_shuffle_iterations = generic_shuffle_iterations;
        statistics.candidate_shuffle_iterations += u64::from(generic_shuffle_iterations);
        statistics.candidate_rng_draws += u64::from(generic_shuffle_iterations) * 2;
    }

    let priority_shuffle_rng_before = rng.state().draws();
    let priority_shuffle_iterations =
        prioritize_descriptor_queue(&mut queue, descriptor, player, connection.dimensions, rng);
    let priority_shuffle_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(priority_shuffle_rng_before);
    attempt.candidate_shuffle_iterations = attempt
        .candidate_shuffle_iterations
        .saturating_add(priority_shuffle_iterations);
    attempt.candidate_shuffle_rng_draws = attempt
        .candidate_shuffle_rng_draws
        .saturating_add(priority_shuffle_rng_draws);
    statistics.candidate_shuffle_iterations += u64::from(priority_shuffle_iterations);
    statistics.candidate_rng_draws += priority_shuffle_rng_draws;

    let initial_object_id =
        if descriptor.object_id.is_some() || descriptor.object_group_name.is_some() {
            let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            Some(resolve_object_replacement(
                source_object_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?)
        } else {
            None
        };
    let source_definition = initial_object_id
        .and_then(|object_id| content.object(object_id))
        .or_else(|| descriptor_object_definition(descriptor, object_groups, content));
    let candidate_definition = initial_object_id
        .and_then(|object_id| runtime_attributes.definition(object_id, owner, content))
        .or_else(|| descriptor_object_definition(descriptor, object_groups, content));
    if let Some(object_id) = initial_object_id
        && !object_available_to_owner(object_id, owner, setup, content)?
    {
        if global_header {
            foundation_map.stale_links.abandon(&queue);
        }
        statistics.rejected_groups += u64::from(attempt.groups_requested);
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt);
        return Ok(());
    }
    let wall_class = native_generation_bindings(content)?.classes.wall;
    if let Some(player @ (slot, center)) = player
        && source_definition.is_some_and(|definition| definition.class_id == wall_class)
    {
        let created_before = objects.len();
        let inner_radius = descriptor.minimum_distance_to_players;
        let outer_radius = descriptor
            .maximum_distance_to_players
            .unwrap_or(inner_radius);
        ensure_wall_path_cache(
            wall_path_cache,
            inner_radius,
            outer_radius,
            &native_generation_bindings(content)?.wall_anchor_object_ids,
            setup,
            connection.dimensions,
            objects,
            &foundation_map.restriction_zones.objects,
            foundation_map.terrain,
            content,
        )?;
        if owner != 0 {
            let segments = wall_path_cache
                .as_ref()
                .expect("wall path cache was just prepared")
                .segments(slot, center)?;
            place_wall_ring(
                descriptor,
                player,
                owner,
                connection.dimensions,
                segments,
                setup,
                content,
                object_groups,
                rng,
                actor_areas,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
            )?;
        }
        let created = objects.len().saturating_sub(created_before);
        if created > 0 {
            attempt.groups_accepted = 1;
            attempt.objects_created = u32::try_from(created).unwrap_or(u32::MAX);
        }
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt);
        return Ok(());
    }
    if let Some(source_object_id) = descriptor.object_id {
        let _count_object_id = resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?;
    }
    if attempt.candidate_count == 0 && !empty_request {
        attempt.exhausted = true;
        statistics.exhausted_descriptors += 1;
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt);
        return Ok(());
    }
    if empty_request {
        if player.is_none() {
            let _ = queue.pop_front();
        }
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt);
        return Ok(());
    }
    let placement_restriction = source_definition
        .and_then(|definition| {
            initial_object_id.and_then(|object_id| {
                runtime_attributes.restriction_id(object_id, owner, definition)
            })
        })
        .and_then(|id| content.restriction(id));
    let master_restriction_id = candidate_definition.and_then(|definition| {
        initial_object_id.and_then(|object_id| {
            runtime_attributes.master_restriction_id(object_id, owner, definition)
        })
    });
    let placement_restriction_zones = master_restriction_id
        .and_then(|id| content.restriction(id))
        .map(|restriction| {
            foundation_map.restriction_zones.anchored_lookup(
                connection.dimensions,
                foundation_map.terrain,
                foundation_map.land_id,
                restriction,
                player.map(|(_, center)| center),
            )
        })
        .transpose()?;
    let connected_minimum = if descriptor.grouping == ExactObjectGrouping::Default {
        1
    } else {
        descriptor.minimum_connected_tiles
    };
    let mut connected_candidates = (connected_minimum > 1).then(ConnectedCandidatePool::default);
    let mut force_candidates = (descriptor.force_placement && player.is_some()).then(Vec::new);
    let mut group_ordinal = 0_u32;
    while group_ordinal < attempt.groups_requested {
        cancellation_checkpoint(cancellation, GenerationStage::Objects, group_ordinal as u64)?;
        let Some(mut anchor) = queue.pop_front() else {
            if force_candidates.is_none() {
                attempt.exhausted = true;
                statistics.exhausted_descriptors += 1;
                statistics.rejected_groups +=
                    u64::from(attempt.groups_requested.saturating_sub(group_ordinal));
            }
            break;
        };
        if !descriptor.ignore_terrain_restrictions
            && let Some((_, center)) = player
            && let Some(zones) = &placement_restriction_zones
        {
            let width = usize::from(connection.dimensions.width);
            let index = |point: MapCoordinate| usize::from(point.y) * width + usize::from(point.x);
            if !super::exact_zone::anchor_matches(zones, index(center), index(anchor)) {
                statistics.rejected_groups += 1;
                continue;
            }
        }
        if !candidate_predicates_before_land_zones(
            descriptor,
            player,
            anchor,
            land_descriptors,
            connection,
            foundation_map.terrain,
            foundation_map.land_id,
            placement_restriction,
            placement_restriction_zones.as_deref(),
            consumption_applies_maximum_player_distance(actor_area_route),
        ) {
            statistics.rejected_groups += 1;
            continue;
        }
        if !avoid_other_land_zones_constraint(
            descriptor,
            player,
            anchor,
            connection.dimensions,
            land_zones,
        ) {
            if let Some((_, center)) = player
                && let Some(removed) =
                    land_zone_rejection_removal(descriptor, center, anchor, connection.dimensions)?
            {
                foundation_map.stale_links.remove_node(&mut queue, removed);
            }
            statistics.rejected_groups += 1;
            continue;
        }
        let master_terrain_allows_anchor = candidate_definition.is_none_or(|definition| {
            master_terrain_allows_coordinate(
                anchor,
                definition,
                connection.dimensions,
                foundation_map.terrain,
                content,
                outer_master_ignores_terrain_restrictions(descriptor, player),
                master_restriction_id,
            ) && master_slope_allows_coordinate(
                anchor,
                definition,
                owner,
                connection.dimensions,
                &connection.elevation,
                runtime_attributes,
            )
        });
        let master_obstruction_allows_anchor = if let Some(definition) = candidate_definition {
            master_obstruction_allows_coordinate_with_positions(
                anchor,
                definition,
                owner,
                appearance_objects,
                objects,
                &foundation_map.construction_positions,
                foundation_map.terrain,
                content,
                runtime_attributes,
                Some(Class39PlacementContext {
                    setup,
                    roster: foundation_map.restriction_zones.objects.as_ref(),
                    master_restriction: master_restriction_id,
                }),
                Some(&foundation_map.obstruction_index),
            )?
        } else {
            true
        };
        let master_allows_anchor = master_terrain_allows_anchor && master_obstruction_allows_anchor;
        let descriptor_restriction = placement_restriction.filter(|_| player.is_some());
        let descriptor_matches = candidate_predicates_match_without_object_class_filter(
            descriptor,
            player,
            anchor,
            land_descriptors,
            connection,
            foundation_map.terrain,
            foundation_map.land_id,
            descriptor_restriction,
            placement_restriction_zones.as_deref(),
            actor_area_queue_snapshot(actor_areas, queue_actor_area_count),
            player.is_some() && consumption_applies_maximum_player_distance(actor_area_route),
            false,
        );
        if !descriptor_matches {
            statistics.rejected_groups += 1;
            continue;
        }
        let farm_class = native_generation_bindings(content)?.classes.farm;
        let exhausted_queue_fallback = !master_allows_anchor
            && player.is_some()
            && queue.is_empty()
            && descriptor.grouping == ExactObjectGrouping::Default
            && !descriptor.force_placement
            && candidate_definition.is_none_or(|definition| definition.class_id != farm_class);
        if !master_allows_anchor && !exhausted_queue_fallback {
            statistics.rejected_groups += 1;
            continue;
        }
        if master_allows_anchor && let Some(pool) = &mut connected_candidates {
            let Some(selected) =
                pool.select(anchor, connected_minimum, descriptor.find_closest, rng)
            else {
                statistics.rejected_groups += 1;
                continue;
            };
            anchor = selected;
        }
        if let Some(candidates) = &mut force_candidates {
            candidates.push(anchor);
        }
        if !exhausted_queue_fallback {
            foundation_map.stale_links.remove_square(
                &mut queue,
                anchor,
                descriptor.minimum_group_distance,
                global_header,
            );
            foundation_map.stale_links.remove_square(
                &mut queue,
                anchor,
                descriptor.temporary_minimum_group_distance,
                global_header,
            );
            if let Some(pool) = &mut connected_candidates {
                pool.remove_group_square(anchor, descriptor.group_placement_radius);
            }
            if descriptor.number_of_objects == 1 && descriptor.group_variance == 0 {
                descriptor.grouping = ExactObjectGrouping::Default;
            }
        }
        if let Some((_, origin)) = player
            && !exhausted_queue_fallback
            && descriptor.path_requirement != 0
        {
            let allowed = match runtime_attributes.path_reference(owner, content)? {
                None => false,
                Some((costs, clearance)) => {
                    std::sync::Arc::make_mut(&mut foundation_map.restriction_zones.objects)
                        .path
                        .allows(
                            costs,
                            clearance,
                            descriptor.path_requirement,
                            anchor,
                            origin,
                        )?
                }
            };
            if !allowed {
                statistics.rejected_groups += 1;
                continue;
            }
        }
        let primary_before_group = rng.state().draws();
        let created_before = objects.len();
        if exhausted_queue_fallback {
            foundation_map.stale_links.remove_square(
                &mut queue,
                anchor,
                descriptor.minimum_group_distance,
                false,
            );
            let relocated = match candidate_definition {
                Some(definition) if descriptor.override_actor_radius_if_required => {
                    let ignore_restriction =
                        outer_master_ignores_terrain_restrictions(descriptor, player);
                    override_actor_radius_tile(anchor, definition, |position| {
                        Ok(master_terrain_rejection_at_position(
                            position,
                            definition,
                            connection.dimensions,
                            foundation_map.terrain,
                            content,
                            ignore_restriction,
                            master_restriction_id,
                        )
                        .is_none()
                            && master_slope_allows_position(
                                position,
                                definition,
                                owner,
                                connection.dimensions,
                                &connection.elevation,
                                runtime_attributes,
                            )
                            && master_obstruction_allows_position_with_positions(
                                position,
                                definition,
                                owner,
                                appearance_objects,
                                objects,
                                &foundation_map.construction_positions,
                                foundation_map.terrain,
                                content,
                                runtime_attributes,
                                Some(Class39PlacementContext {
                                    setup,
                                    roster: foundation_map.restriction_zones.objects.as_ref(),
                                    master_restriction: master_restriction_id,
                                }),
                                Some(&foundation_map.obstruction_index),
                            )?)
                    })?
                }
                _ => None,
            };
            let source = descriptor_object_id(descriptor, object_groups, rng)?;
            let object_id = resolve_object_replacement(
                source,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            let fixed_position = relocated
                .map(|tile| {
                    tile_center_position_256(tile, object_id, owner, setup, content, foundation_map)
                })
                .transpose()?;
            place_one(
                object_id,
                anchor,
                owner,
                descriptor,
                setup,
                content,
                auxiliary_rng,
                fixed_position,
                objects,
                operation_indices,
                foundation_map,
            )?;
            register_actor_area(
                descriptor,
                player,
                anchor,
                connection.dimensions,
                actor_areas,
            )?;
        } else {
            place_group(
                descriptor,
                anchor,
                initial_object_id,
                player,
                land_zones,
                owner,
                setup,
                connection,
                content,
                runtime_attributes,
                appearance_objects,
                actor_areas,
                candidate_availability,
                Some(&mut queue),
                object_groups,
                rng,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
                cancellation,
            )?;
        }
        statistics.placement_rng_draws += rng.state().draws() - primary_before_group;
        let created = objects.len() - created_before;
        if created > 0 {
            attempt.groups_accepted += 1;
            attempt.objects_created = attempt
                .objects_created
                .saturating_add(u32::try_from(created).unwrap_or(u32::MAX));
        }
        let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
        let invalidation_object_id = Some(resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?);
        candidate_availability.invalidate_for_anchor(
            anchor,
            descriptor.minimum_group_distance,
            invalidation_object_id,
            foundation_map.terrain,
            content,
            runtime_attributes,
        );
        group_ordinal = group_ordinal.saturating_add(1);
        if objects.len() > MAXIMUM_CREATED_OBJECTS {
            return Err(GenerationError::ResourceLimit {
                resource: "placed objects".to_owned(),
                limit: MAXIMUM_CREATED_OBJECTS as u64,
            });
        }
    }
    if group_ordinal < attempt.groups_requested
        && let Some(force_candidates) = force_candidates.as_deref()
    {
        force_place_remaining_groups(
            descriptor,
            player,
            candidate_definition,
            master_restriction_id,
            owner,
            setup,
            connection,
            content,
            runtime_attributes,
            appearance_objects,
            force_candidates,
            object_groups,
            rng,
            auxiliary_rng,
            objects,
            operation_indices,
            foundation_map,
            &mut group_ordinal,
            &mut attempt,
            statistics,
            cancellation,
        )?;
    }
    attempt.primary_rng_draws_after = rng.state().draws();
    attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
    statistics.attempts.push(attempt);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn force_place_remaining_groups(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    candidate_definition: Option<&ObjectDefinition>,
    master_restriction_id: Option<RestrictionId>,
    owner: u8,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    appearance_objects: &TerrainAppearanceObjects,
    candidates: &[MapCoordinate],
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
    group_ordinal: &mut u32,
    attempt: &mut ExactObjectAttempt,
    statistics: &mut ExactObjectStatistics,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let force_rng_before = rng.state().draws();
    'passes: for pass in 1..=MAXIMUM_FORCE_PLACEMENT_PASSES {
        cancellation_checkpoint(cancellation, GenerationStage::Objects, u64::from(pass))?;
        for candidate in candidates.iter().rev() {
            if *group_ordinal >= attempt.groups_requested {
                break 'passes;
            }
            let position = if pass >= 10 && rng.next_u32().is_multiple_of(5) {
                [f32::from(candidate.x) + 0.5, f32::from(candidate.y) + 0.5]
            } else {
                [
                    f32::from(candidate.x) + (rng.next_u32() & 1) as f32,
                    f32::from(candidate.y) + (rng.next_u32() & 1) as f32,
                ]
            };
            let master_allows_position = if let Some(definition) = candidate_definition {
                master_terrain_rejection_at_position(
                    position,
                    definition,
                    connection.dimensions,
                    foundation_map.terrain,
                    content,
                    outer_master_ignores_terrain_restrictions(descriptor, player),
                    master_restriction_id,
                )
                .is_none()
                    && master_slope_allows_position(
                        position,
                        definition,
                        owner,
                        connection.dimensions,
                        &connection.elevation,
                        runtime_attributes,
                    )
                    && master_obstruction_allows_position_with_positions(
                        position,
                        definition,
                        owner,
                        appearance_objects,
                        objects,
                        &foundation_map.construction_positions,
                        foundation_map.terrain,
                        content,
                        runtime_attributes,
                        Some(Class39PlacementContext {
                            setup,
                            roster: foundation_map.restriction_zones.objects.as_ref(),
                            master_restriction: master_restriction_id,
                        }),
                        Some(&foundation_map.obstruction_index),
                    )?
            } else {
                true
            };
            if !master_allows_position {
                statistics.rejected_groups += 1;
                continue;
            }

            let created_before = objects.len();
            let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            let primary_object_id = resolve_object_replacement(
                source_object_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            construct_source_one_at(
                primary_object_id,
                position,
                owner,
                descriptor,
                setup,
                content,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
            )?;
            if let Some(second_object_id) =
                constructed_second_object_id(descriptor, object_groups, content, rng)?
            {
                let second_object_id = resolve_object_replacement(
                    second_object_id,
                    owner,
                    setup,
                    content,
                    foundation_map.runtime_attributes,
                    rng,
                )?;
                let mut second_descriptor = descriptor.clone();
                second_descriptor.explicit_facet = None;
                second_descriptor.resource_delta = 0;
                construct_source_one_at(
                    second_object_id,
                    position,
                    owner,
                    &second_descriptor,
                    setup,
                    content,
                    auxiliary_rng,
                    objects,
                    operation_indices,
                    foundation_map,
                )?;
            }
            let created = objects.len().saturating_sub(created_before);
            if created > 0 {
                attempt.groups_accepted = attempt.groups_accepted.saturating_add(1);
                attempt.objects_created = attempt
                    .objects_created
                    .saturating_add(u32::try_from(created).unwrap_or(u32::MAX));
                *group_ordinal = group_ordinal.saturating_add(1);
            }
        }
    }
    statistics.placement_rng_draws += rng.state().draws().saturating_sub(force_rng_before);
    if *group_ordinal < attempt.groups_requested {
        attempt.exhausted = true;
        statistics.exhausted_descriptors += 1;
        statistics.rejected_groups +=
            u64::from(attempt.groups_requested.saturating_sub(*group_ordinal));
    }
    Ok(())
}

fn prioritize_descriptor_queue(
    queue: &mut CandidateQueue,
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    dimensions: MapDimensions,
    rng: &mut RmsRandom,
) -> u32 {
    let Some((_, center)) = player else {
        return 0;
    };
    let priority = if descriptor.find_closest {
        CandidatePriority::Anchor
    } else if let Some(preference) = descriptor.find_closest_to_map_center {
        CandidatePriority::MapCenter(preference)
    } else if let Some(preference) = descriptor.find_closest_to_map_edge {
        CandidatePriority::MapEdge(preference)
    } else {
        return 0;
    };
    let anchor = if descriptor.find_closest {
        center
    } else {
        object_placement_center(player, dimensions)
    };
    queue.prioritize_closest_to(
        priority,
        anchor,
        closest_priority_inner_radius(descriptor),
        descriptor.circular_placement,
        descriptor.tile_shuffling,
        rng,
    )
}

#[allow(clippy::too_many_arguments)]
fn place_expanded_single_request(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    expanded_count: u32,
    setup: &ExactSetupState,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    appearance_objects: &TerrainAppearanceObjects,
    placed_object_classes: &PlacedObjectClassGrid,
    candidate_availability: &mut CandidateAvailability,
    actor_areas: &mut ActorAreaState,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
    statistics: &mut ExactObjectStatistics,
    cancellation: &dyn CancellationToken,
    attempt: &mut ExactObjectAttempt,
) -> Result<(), GenerationError> {
    let source_object_id = descriptor
        .object_id
        .ok_or_else(|| invalid_object("single-request expansion requires one object identity"))?;
    let owner = if descriptor.gaia_object_only {
        0
    } else {
        player.map_or(0, |value| value.0)
    };
    attempt.groups_requested = expanded_count;
    let queue_actor_area_count = actor_areas.logical.len();
    let window = CandidateWindow::for_descriptor(descriptor, player, connection.dimensions);
    let candidate_collection_rng_before = rng.state().draws();
    let class_filter_master =
        ClassFilterMaster::for_request(descriptor, object_groups, content, runtime_attributes);
    let actor_area_route = actor_area_queue_route(descriptor, actor_areas);
    let masks = (!actor_area_route)
        .then(|| {
            RequestMask::build(
                descriptor,
                player,
                connection.dimensions,
                actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
                    .for_request(&descriptor.avoid_actor_areas),
                candidate_availability,
                &class_filter_master,
                ClassInputs {
                    placed_object_classes,
                    appearance_objects,
                    terrain: foundation_map.terrain,
                    terrain_writes: foundation_map.painted,
                    content,
                    roster: &foundation_map.restriction_zones.objects,
                },
            )
        })
        .flatten();
    let (candidates, sampled_iterations, actor_area_route) = if actor_area_route {
        let (candidates, iterations) = collect_actor_area_candidates(
            descriptor,
            player,
            setup,
            connection,
            foundation_map.terrain,
            content,
            runtime_attributes,
            owner,
            actor_areas,
            object_groups,
            candidate_availability,
            appearance_objects,
            objects,
            rng,
            cancellation,
            &foundation_map.restriction_zones.objects,
            Some(&foundation_map.list_classes),
        )?;
        (candidates, iterations, true)
    } else {
        let candidates = collect_candidates(
            descriptor,
            player,
            setup,
            connection,
            foundation_map.terrain,
            foundation_map.painted,
            runtime_attributes,
            actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
                .for_request(&descriptor.avoid_actor_areas),
            object_groups,
            candidate_availability,
            appearance_objects,
            placed_object_classes,
            content,
            foundation_map.restriction_zones.objects.as_ref(),
            &class_filter_master,
            masks.as_ref(),
            rng,
        )?;
        (candidates, 0, false)
    };
    attempt.candidate_collection_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(candidate_collection_rng_before);
    attempt.candidate_count = u32::try_from(candidates.len()).unwrap_or(u32::MAX);
    statistics.candidate_tiles = statistics
        .candidate_tiles
        .saturating_add(candidates.len() as u64);
    let dynamic_class_filter = descriptor.object_class_filter.is_some();
    let candidate_shuffle_rng_before = rng.state().draws();
    let shuffle_actor_areas = actor_area_queue_snapshot(actor_areas, queue_actor_area_count)
        .for_request(&descriptor.avoid_actor_areas);
    let (mut queue, mut shuffle_iterations) = CandidateQueue::new_with_shuffle_predicate(
        connection.dimensions,
        window,
        candidates,
        false,
        !actor_area_route,
        rng,
        cancellation,
        |present, coordinate, rng| {
            if !dynamic_class_filter || actor_area_route {
                return Ok(present);
            }
            candidate_mask::sample_with_masks(
                masks.as_ref(),
                coordinate,
                &class_filter_master,
                object_groups,
                setup,
                content,
                runtime_attributes,
                rng,
                |rng| {
                    candidate_matches_resolving_class_filter(
                        descriptor,
                        player,
                        coordinate,
                        runtime_attributes,
                        setup,
                        connection,
                        foundation_map.terrain,
                        foundation_map.painted,
                        shuffle_actor_areas,
                        object_groups,
                        candidate_availability,
                        appearance_objects,
                        placed_object_classes,
                        content,
                        &class_filter_master,
                        rng,
                        &foundation_map.restriction_zones.objects,
                    )
                },
            )
        },
    )?;
    drop(masks);
    foundation_map.stale_links.release_linked(&queue, None);
    attempt.candidate_shuffle_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(candidate_shuffle_rng_before);
    if actor_area_route {
        shuffle_iterations = sampled_iterations;
        statistics.candidate_rng_draws += u64::from(sampled_iterations);
    } else {
        statistics.candidate_rng_draws += u64::from(shuffle_iterations) * 2;
    }
    let priority_shuffle_rng_before = rng.state().draws();
    let priority_shuffle_iterations =
        prioritize_descriptor_queue(&mut queue, descriptor, player, connection.dimensions, rng);
    let priority_shuffle_rng_draws = rng
        .state()
        .draws()
        .saturating_sub(priority_shuffle_rng_before);
    attempt.candidate_shuffle_rng_draws = attempt
        .candidate_shuffle_rng_draws
        .saturating_add(priority_shuffle_rng_draws);
    statistics.candidate_rng_draws += priority_shuffle_rng_draws;
    shuffle_iterations = shuffle_iterations.saturating_add(priority_shuffle_iterations);
    attempt.candidate_shuffle_iterations = shuffle_iterations;
    statistics.candidate_shuffle_iterations += u64::from(shuffle_iterations);

    let initial_object_id = resolve_object_replacement(
        source_object_id,
        owner,
        setup,
        content,
        foundation_map.runtime_attributes,
        rng,
    )?;
    if !object_available_to_owner(initial_object_id, owner, setup, content)? {
        statistics.rejected_groups += u64::from(attempt.groups_requested);
        attempt.primary_rng_draws_after = rng.state().draws();
        attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
        statistics.attempts.push(attempt.clone());
        return Ok(());
    }
    let _count_object_id = resolve_object_replacement(
        source_object_id,
        owner,
        setup,
        content,
        foundation_map.runtime_attributes,
        rng,
    )?;
    let source_definition = content.object(initial_object_id);
    let candidate_definition = runtime_attributes.definition(initial_object_id, owner, content);
    let restriction = source_definition
        .and_then(|definition| {
            runtime_attributes.restriction_id(initial_object_id, owner, definition)
        })
        .and_then(|id| content.restriction(id));
    let master_restriction_id = candidate_definition.and_then(|definition| {
        runtime_attributes.master_restriction_id(initial_object_id, owner, definition)
    });
    let restriction_zones = restriction_zone_labels(
        descriptor,
        connection.dimensions,
        foundation_map.terrain,
        restriction,
        &mut foundation_map.restriction_zones,
    )?;

    while attempt.groups_accepted < expanded_count {
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Objects,
            u64::from(attempt.groups_accepted),
        )?;
        let Some(anchor) = queue.pop_front() else {
            attempt.exhausted = true;
            statistics.exhausted_descriptors += 1;
            statistics.rejected_groups +=
                u64::from(expanded_count.saturating_sub(attempt.groups_accepted));
            break;
        };
        let descriptor_matches = if actor_area_route {
            candidate_predicates_match_without_object_class_filter(
                descriptor,
                player,
                anchor,
                land_descriptors,
                connection,
                foundation_map.terrain,
                foundation_map.land_id,
                restriction,
                restriction_zones.as_deref(),
                actor_area_queue_snapshot(actor_areas, queue_actor_area_count),
                consumption_applies_maximum_player_distance(true),
                false,
            )
        } else if dynamic_class_filter {
            candidate_availability.is_available(anchor)
                && candidate_predicates_match_without_object_class_filter(
                    descriptor,
                    player,
                    anchor,
                    land_descriptors,
                    connection,
                    foundation_map.terrain,
                    foundation_map.land_id,
                    restriction,
                    restriction_zones.as_deref(),
                    actor_area_queue_snapshot(actor_areas, queue_actor_area_count),
                    true,
                    false,
                )
        } else {
            candidate_matches(
                descriptor,
                player,
                anchor,
                land_descriptors,
                connection,
                foundation_map.terrain,
                foundation_map.land_id,
                restriction,
                restriction_zones.as_deref(),
                candidate_definition,
                actor_area_queue_snapshot(actor_areas, queue_actor_area_count),
                candidate_availability,
                appearance_objects,
                objects,
                content,
                &foundation_map.restriction_zones.objects,
                Some(&foundation_map.list_classes),
            )
        };
        let master_allows = if let Some(definition) = candidate_definition {
            (master_terrain_allows_coordinate(
                anchor,
                definition,
                connection.dimensions,
                foundation_map.terrain,
                content,
                outer_master_ignores_terrain_restrictions(descriptor, player),
                master_restriction_id,
            )) && master_slope_allows_coordinate(
                anchor,
                definition,
                owner,
                connection.dimensions,
                &connection.elevation,
                runtime_attributes,
            ) && master_obstruction_allows_coordinate_with_positions(
                anchor,
                definition,
                owner,
                appearance_objects,
                objects,
                &foundation_map.construction_positions,
                foundation_map.terrain,
                content,
                runtime_attributes,
                Some(Class39PlacementContext {
                    setup,
                    roster: foundation_map.restriction_zones.objects.as_ref(),
                    master_restriction: master_restriction_id,
                }),
                Some(&foundation_map.obstruction_index),
            )?
        } else {
            true
        };
        if !master_allows || !descriptor_matches {
            continue;
        }

        let primary_before_group = rng.state().draws();
        let _diagnostic_object_id = resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?;
        let object_id = resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?;
        let primary_object_index = objects.len();
        place_one(
            object_id,
            anchor,
            owner,
            descriptor,
            setup,
            content,
            auxiliary_rng,
            None,
            objects,
            operation_indices,
            foundation_map,
        )?;
        let second_created_before = objects.len();
        if let Some(second) = constructed_second_object_id(descriptor, object_groups, content, rng)?
        {
            let primary_position = objects
                .get(primary_object_index)
                .map(|object| (object.x_256, object.y_256))
                .ok_or_else(|| invalid_object("expanded primary object was not created"))?;
            let second = resolve_object_replacement(
                second,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            let mut second_descriptor = descriptor.clone();
            second_descriptor.explicit_facet = None;
            second_descriptor.resource_delta = 0;
            place_one(
                second,
                anchor,
                owner,
                &second_descriptor,
                setup,
                content,
                auxiliary_rng,
                Some(primary_position),
                objects,
                operation_indices,
                foundation_map,
            )?;
        }
        register_actor_area(
            descriptor,
            player,
            anchor,
            connection.dimensions,
            actor_areas,
        )?;
        let invalidation_object_id = resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?;
        statistics.placement_rng_draws += rng.state().draws() - primary_before_group;
        attempt.groups_accepted += 1;
        attempt.objects_created = attempt.objects_created.saturating_add(
            1 + u32::try_from(objects.len() - second_created_before).unwrap_or(u32::MAX - 1),
        );
        candidate_availability.invalidate_for_anchor(
            anchor,
            descriptor.minimum_group_distance,
            Some(invalidation_object_id),
            foundation_map.terrain,
            content,
            runtime_attributes,
        );
        foundation_map.stale_links.remove_square(
            &mut queue,
            anchor,
            descriptor.minimum_group_distance,
            false,
        );
        foundation_map.stale_links.remove_square(
            &mut queue,
            anchor,
            descriptor.temporary_minimum_group_distance,
            false,
        );
    }

    attempt.primary_rng_draws_after = rng.state().draws();
    attempt.auxiliary_rng_draws_after = auxiliary_rng.state().draws();
    statistics.attempts.push(attempt.clone());
    Ok(())
}

pub(crate) fn initial_object_resources(
    definition: &ObjectDefinition,
) -> Result<rms_content::ObjectResourceState, GenerationError> {
    definition.initial_resources().ok_or_else(|| {
        GenerationError::InvalidContent(format!(
            "resource slots are unavailable for object {}",
            definition.id.0
        ))
    })
}

fn adjust_object_resource(object: &mut PlacedObject) {
    let mut resources = rms_content::ObjectResourceState {
        resource_type: object.resource_type,
        quantity_f32_bits: object.resource_quantity_f32_bits,
    };
    resources.adjust_quantity(object.resource_delta);
    object.resource_quantity_f32_bits = resources.quantity_f32_bits;
}

enum GroupCandidates {
    Offsets(std::vec::IntoIter<(i32, i32)>),
    Local(CandidateQueue),
    Tight(TightCandidates),
}

impl GroupCandidates {
    fn next_coordinate(
        &mut self,
        anchor: MapCoordinate,
        dimensions: MapDimensions,
    ) -> Result<Option<MapCoordinate>, GenerationError> {
        match self {
            Self::Offsets(offsets) => offsets
                .next()
                .map(|offset| offset_coordinate(anchor, offset, dimensions))
                .transpose(),
            Self::Local(queue) => Ok(queue.pop_front()),
            Self::Tight(queue) => Ok(queue.pop_front()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn place_group(
    descriptor: &ExactObjectDescriptor,
    anchor: MapCoordinate,
    initial_object_id: Option<ObjectId>,
    player: Option<(u8, MapCoordinate)>,
    land_zones: &[u32],
    owner: u8,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    appearance_objects: &TerrainAppearanceObjects,
    actor_areas: &mut ActorAreaState,
    candidate_availability: &mut CandidateAvailability,
    mut parent_queue: Option<&mut CandidateQueue>,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    let grouping = if descriptor.number_of_objects == 1 && descriptor.group_variance == 0 {
        ExactObjectGrouping::Default
    } else {
        descriptor.grouping
    };
    let promoted_default_members = default_members_use_outer_anchors(descriptor);
    let local_validation_object_id = if grouping == ExactObjectGrouping::Tight {
        let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
        Some(resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?)
    } else {
        None
    };
    let count_object_id = if !promoted_default_members
        && grouping != ExactObjectGrouping::Default
        && !loose_group_uses_local_queue(descriptor)
        && let Some(source_object_id) = descriptor.object_id
    {
        Some(resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            foundation_map.runtime_attributes,
            rng,
        )?)
    } else {
        None
    };
    if let Some(object_id) = local_validation_object_id
        .or(initial_object_id)
        .or(count_object_id)
        && !object_available_to_owner(object_id, owner, setup, content)?
    {
        return Ok(());
    }
    let mut candidate_definition = local_validation_object_id
        .or(initial_object_id)
        .or(count_object_id)
        .and_then(|object_id| runtime_attributes.definition(object_id, owner, content))
        .or_else(|| descriptor_object_definition(descriptor, object_groups, content));
    let mut master_restriction = candidate_definition.and_then(|definition| {
        runtime_attributes.master_restriction_id(
            local_validation_object_id
                .or(initial_object_id)
                .or(count_object_id)
                .unwrap_or(definition.id),
            owner,
            definition,
        )
    });
    let (count, mut candidates) = match grouping {
        _ if descriptor.number_of_objects == 1 && descriptor.group_variance == 0 => {
            (1, GroupCandidates::Offsets(vec![(0, 0)].into_iter()))
        }
        ExactObjectGrouping::Default => (1, GroupCandidates::Offsets(vec![(0, 0)].into_iter())),
        ExactObjectGrouping::Tight => (
            effective_group_member_count(descriptor, rng)?.max(1),
            GroupCandidates::Tight(TightCandidates::new(
                anchor,
                descriptor.group_placement_radius,
                connection.dimensions,
            )),
        ),
        ExactObjectGrouping::Loose => {
            let (count, queue, local_master) = if actor_area_queue_route(descriptor, actor_areas) {
                let (candidates, _) = collect_actor_area_candidates(
                    descriptor,
                    player,
                    setup,
                    connection,
                    foundation_map.terrain,
                    content,
                    runtime_attributes,
                    owner,
                    actor_areas,
                    object_groups,
                    candidate_availability,
                    appearance_objects,
                    objects,
                    rng,
                    cancellation,
                    &foundation_map.restriction_zones.objects,
                    Some(&foundation_map.list_classes),
                )?;
                let (queue, _) = CandidateQueue::new_with_shuffle_predicate(
                    connection.dimensions,
                    CandidateWindow::for_descriptor(descriptor, player, connection.dimensions),
                    candidates,
                    false,
                    false,
                    rng,
                    cancellation,
                    |present, _, _| Ok(present),
                )?;
                let (count, local_master) = resolve_local_group_master_and_count(
                    descriptor,
                    owner,
                    setup,
                    content,
                    foundation_map.runtime_attributes,
                    object_groups,
                    rng,
                )?;
                (count, queue, Some(local_master))
            } else {
                local_group_queue(
                    anchor,
                    descriptor,
                    owner,
                    setup,
                    connection,
                    content,
                    runtime_attributes,
                    object_groups,
                    player,
                    actor_areas.view(),
                    candidate_availability,
                    appearance_objects,
                    objects,
                    foundation_map.terrain,
                    rng,
                    cancellation,
                    &foundation_map.restriction_zones.objects,
                    Some(&foundation_map.list_classes),
                )?
            };
            let live = if player.is_none() {
                parent_queue.as_deref_mut()
            } else {
                None
            };
            foundation_map.stale_links.release_linked(&queue, live);
            if let Some(parent_queue) = parent_queue.as_deref_mut() {
                queue.detach_present_from(parent_queue);
            }
            if let Some(object_id) = local_master {
                if !object_available_to_owner(object_id, owner, setup, content)? {
                    return Ok(());
                }
                candidate_definition = runtime_attributes.definition(object_id, owner, content);
                master_restriction = candidate_definition.and_then(|definition| {
                    runtime_attributes.master_restriction_id(object_id, owner, definition)
                });
            }
            (count, GroupCandidates::Local(queue))
        }
    };

    let is_named_group = descriptor.object_group_name.is_some();
    let checks_local_members = matches!(candidates, GroupCandidates::Local(_));
    let checks_tight_land_zones = matches!(candidates, GroupCandidates::Tight(_));
    let mut placed_members = 0_u32;
    while let Some(coordinate) = candidates.next_coordinate(anchor, connection.dimensions)? {
        if placed_members >= count {
            break;
        }
        if checks_tight_land_zones
            && !avoid_other_land_zones_constraint(
                descriptor,
                player,
                coordinate,
                connection.dimensions,
                land_zones,
            )
        {
            continue;
        }
        if checks_local_members
            && !local_group_member_matches(
                coordinate,
                descriptor,
                candidate_definition,
                owner,
                connection.dimensions,
                appearance_objects,
                objects,
                &foundation_map.construction_positions,
                foundation_map.terrain,
                &connection.elevation,
                foundation_map.land_id,
                content,
                master_restriction,
                runtime_attributes,
                setup,
                foundation_map.restriction_zones.objects.as_ref(),
                Some(&foundation_map.obstruction_index),
            )?
        {
            continue;
        }
        let object_id = if is_named_group {
            if player.is_some()
                && grouping == ExactObjectGrouping::Default
                && !checks_local_members
                && !checks_tight_land_zones
            {
                let _diagnostic_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            }
            let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            resolve_object_replacement(
                source_object_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?
        } else {
            let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            if player.is_some() && grouping == ExactObjectGrouping::Default && !checks_local_members
            {
                let _diagnostic_object_id = resolve_object_replacement(
                    source_object_id,
                    owner,
                    setup,
                    content,
                    foundation_map.runtime_attributes,
                    rng,
                )?;
            }
            resolve_object_replacement(
                source_object_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?
        };
        let primary_object_index = objects.len();
        place_one(
            object_id,
            coordinate,
            owner,
            descriptor,
            setup,
            content,
            auxiliary_rng,
            None,
            objects,
            operation_indices,
            foundation_map,
        )?;
        let primary_position = objects
            .get(primary_object_index)
            .map(|object| (object.x_256, object.y_256))
            .ok_or_else(|| invalid_object("primary group object was not created"))?;
        register_actor_area(
            descriptor,
            player,
            coordinate,
            connection.dimensions,
            actor_areas,
        )?;
        if let Some(second) = constructed_second_object_id(descriptor, object_groups, content, rng)?
        {
            let second = resolve_object_replacement(
                second,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            let mut second_descriptor = descriptor.clone();
            second_descriptor.explicit_facet = None;
            second_descriptor.resource_delta = 0;
            place_one(
                second,
                coordinate,
                owner,
                &second_descriptor,
                setup,
                content,
                auxiliary_rng,
                Some(primary_position),
                objects,
                operation_indices,
                foundation_map,
            )?;
        }
        if let GroupCandidates::Tight(queue) = &mut candidates {
            candidate_availability.consume_tile(coordinate);
            let linked = queue.expand_from(
                coordinate,
                rng,
                |neighbor| {
                    let Some(definition) = candidate_definition else {
                        return Ok(true);
                    };
                    Ok((master_terrain_allows_coordinate(
                        neighbor,
                        definition,
                        connection.dimensions,
                        foundation_map.terrain,
                        content,
                        member_master_ignores_terrain_restrictions(descriptor),
                        master_restriction,
                    )) && master_slope_allows_coordinate(
                        neighbor,
                        definition,
                        owner,
                        connection.dimensions,
                        &connection.elevation,
                        runtime_attributes,
                    ) && master_obstruction_allows_coordinate_with_positions(
                        neighbor,
                        definition,
                        owner,
                        appearance_objects,
                        objects,
                        &foundation_map.construction_positions,
                        foundation_map.terrain,
                        content,
                        runtime_attributes,
                        Some(Class39PlacementContext {
                            setup,
                            roster: foundation_map.restriction_zones.objects.as_ref(),
                            master_restriction,
                        }),
                        Some(&foundation_map.obstruction_index),
                    )?)
                },
                parent_queue.as_deref_mut(),
            )?;
            for neighbor in linked {
                let index = usize::from(neighbor.y) * usize::from(connection.dimensions.width)
                    + usize::from(neighbor.x);
                if let Some(new_head) = foundation_map.stale_links.unlink(index)
                    && player.is_none()
                    && let Some(live) = parent_queue.as_deref_mut()
                {
                    foundation_map
                        .stale_links
                        .redirect_live_queue(live, new_head);
                }
            }
        }
        placed_members = placed_members.saturating_add(1);
    }
    Ok(())
}

fn descriptor_object_id(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
) -> Result<ObjectId, GenerationError> {
    if let Some(id) = descriptor.object_id {
        return Ok(id);
    }
    let group_name = descriptor
        .object_group_name
        .as_deref()
        .ok_or_else(|| invalid_object("object descriptor has no content identity"))?;
    let group = object_groups
        .iter()
        .find(|group| group.name == group_name)
        .ok_or_else(|| invalid_object("object group is unresolved"))?;
    if group.entries.is_empty() {
        return Err(invalid_object("object group has no entries"));
    }
    let sample = rng.bounded(100).result;
    Ok(group_entry_for_sample(&group.entries, group.roll_filter, sample).object_id)
}

fn constructed_second_object_id(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    content: CompatibleContentView<'_>,
    rng: &mut RmsRandom,
) -> Result<Option<ObjectId>, GenerationError> {
    Ok(descriptor_second_object_id(descriptor, object_groups, rng)?
        .filter(|id| content.object(*id).is_some()))
}

fn descriptor_second_object_id(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
) -> Result<Option<ObjectId>, GenerationError> {
    if let Some(id) = descriptor.second_object_id {
        return Ok(Some(id));
    }
    let Some(group_name) = descriptor.second_object_group_name.as_deref() else {
        return Ok(None);
    };
    let group = object_groups
        .iter()
        .find(|group| group.name == group_name)
        .ok_or_else(|| invalid_object("secondary object group is unresolved"))?;
    if group.entries.is_empty() {
        return Err(invalid_object("secondary object group has no entries"));
    }
    let sample = rng.bounded(100).result;
    Ok(Some(
        group_entry_for_sample(&group.entries, group.roll_filter, sample).object_id,
    ))
}

fn group_entry_for_sample(
    entries: &[ExactObjectGroupEntry],
    filter: ObjectGroupRollFilter,
    sample: u32,
) -> &ExactObjectGroupEntry {
    let eligible = entries
        .iter()
        .filter(|entry| filter.keeps(entry.weight, sample))
        .count();
    if eligible == 0 {
        return &entries[0];
    }
    entries
        .iter()
        .filter(|entry| filter.keeps(entry.weight, sample))
        .nth(sample as usize % eligible)
        .expect("eligible count and selection use the same predicate")
}

fn override_actor_radius_tile(
    anchor: MapCoordinate,
    definition: &ObjectDefinition,
    mut master_fits: impl FnMut([f32; 2]) -> Result<bool, GenerationError>,
) -> Result<Option<MapCoordinate>, GenerationError> {
    let [half_x, half_y] = definition.collision_half_extents();
    let window = 4 * (((half_y + 0.5_f32) * (half_x + 0.5_f32)) as i32);
    if master_fits([f32::from(anchor.x) + 0.5, f32::from(anchor.y) + 0.5])? {
        return Ok(Some(anchor));
    }
    if window / 2 - 1 > 0 {
        return Err(invalid_object(
            "the preview does not support override_actor_radius_if_required when the object does not fit on its first tile",
        ));
    }
    Ok(None)
}

fn tile_center_position_256(
    tile: MapCoordinate,
    source_object_id: ObjectId,
    owner: u8,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    foundation_map: &FoundationMap<'_>,
) -> Result<(u32, u32), GenerationError> {
    let object_id = substituted_object_for_owner(source_object_id, owner, setup, content)?;
    let definition = foundation_map
        .runtime_attributes
        .definition(object_id, owner, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    let [half_x, half_y] = definition.collision_half_extents();
    Ok((
        clamp_axis_position_256(
            u32::from(tile.x) * 256 + 128,
            half_x,
            foundation_map.dimensions.width,
            definition.edge_margin_256,
        ),
        clamp_axis_position_256(
            u32::from(tile.y) * 256 + 128,
            half_y,
            foundation_map.dimensions.height,
            definition.edge_margin_256,
        ),
    ))
}

#[allow(clippy::too_many_arguments)]
fn place_one(
    source_object_id: ObjectId,
    coordinate: MapCoordinate,
    owner: u8,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    fixed_position: Option<(u32, u32)>,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    let object_id = substituted_object_for_owner(source_object_id, owner, setup, content)?;
    let definition = foundation_map
        .runtime_attributes
        .definition(object_id, owner, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    let footprint_position = || {
        (
            object_axis_position_256(
                coordinate.x,
                definition.collision_half_extents()[0],
                foundation_map.dimensions.width,
                definition.edge_margin_256,
            ),
            object_axis_position_256(
                coordinate.y,
                definition.collision_half_extents()[1],
                foundation_map.dimensions.height,
                definition.edge_margin_256,
            ),
        )
    };
    let (x_256, y_256) = fixed_position.unwrap_or_else(footprint_position);
    construct_one_at(
        object_id,
        [x_256 as f32 / 256.0, y_256 as f32 / 256.0],
        owner,
        descriptor,
        setup,
        content,
        auxiliary_rng,
        objects,
        operation_indices,
        foundation_map,
        0,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn construct_source_one_at(
    source_object_id: ObjectId,
    position: [f32; 2],
    owner: u8,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    let object_id = substituted_object_for_owner(source_object_id, owner, setup, content)?;
    construct_one_at(
        object_id,
        position,
        owner,
        descriptor,
        setup,
        content,
        auxiliary_rng,
        objects,
        operation_indices,
        foundation_map,
        0,
        None,
    )
}

fn substituted_object_for_owner(
    source_object_id: ObjectId,
    owner: u8,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
) -> Result<ObjectId, GenerationError> {
    let civilization = if owner == 0 {
        setup.gaia_civilization_id
    } else {
        setup
            .players
            .iter()
            .find(|player| player.slot == owner)
            .map(|player| player.civilization_id)
            .ok_or_else(|| invalid_object("object owner is absent from setup"))?
    };
    Ok(content.substituted_object(civilization, source_object_id))
}

#[allow(clippy::too_many_arguments)]
fn construct_one_at(
    object_id: ObjectId,
    input_position: [f32; 2],
    owner: u8,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
    depth: usize,
    parent_completes: Option<bool>,
) -> Result<(), GenerationError> {
    if depth >= 16 || objects.len() >= MAXIMUM_CREATED_OBJECTS {
        return Err(object_limit(
            "object construction expansion",
            MAXIMUM_CREATED_OBJECTS,
        ));
    }
    let definition = foundation_map
        .runtime_attributes
        .definition(object_id, owner, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    if definition.disappears_when_built && building_stack_unit(definition).is_some() {
        return Err(invalid_object(
            "constructing a building that is replaced by its stack unit when built is unsupported",
        ));
    }
    let completes = match parent_completes {
        Some(completes) => completes,
        None => building_completes_at_creation(
            object_id,
            owner,
            definition,
            content,
            foundation_map.runtime_attributes,
        )?,
    };
    let position_family = content
        .object(object_id)
        .ok_or_else(|| missing_object_definition(object_id))?
        .position_family;
    let position = transfer_constructed_position(
        input_position,
        position_family,
        foundation_map
            .runtime_attributes
            .movement_speed_bits(object_id, owner, content),
        definition.collision_half_extents(),
        foundation_map.dimensions,
    )?;
    let creation_rng = foundation_map
        .runtime_attributes
        .creation_rng(object_id, definition, owner, content)?;
    let constructed_facet = construct_object_facet(creation_rng, auxiliary_rng);
    let facet = if depth == 0 {
        descriptor.explicit_facet.unwrap_or(constructed_facet)
    } else {
        constructed_facet
    };
    let resources = foundation_map
        .runtime_attributes
        .initial_resources(definition, owner, content)?;
    let placed = PlacedObject {
        instance_id: foundation_map.next_instance_id,
        object_id,
        x_256: (position[0] * 256.0).round() as u32,
        y_256: (position[1] * 256.0).round() as u32,
        z_256: 0,
        owner,
        facet,
        footprint_width_256: definition.footprint_width_256,
        footprint_height_256: definition.footprint_height_256,
        presentation_kind: 0,
        resource_type: resources.resource_type,
        resource_quantity_f32_bits: resources.quantity_f32_bits,
        resource_delta: if depth == 0 {
            descriptor.resource_delta
        } else {
            0
        },
        status: i32::from(definition.initial_lifecycle_state),
        death_state: i8::from_ne_bytes([definition.initial_lifecycle_state]),
        data_status: definition.data_status,
        selection_flags: 0,
        behavior_flags: descriptor.behavior_flags,
    };
    retire_construction_overlaps_on_terrain(
        &placed,
        position,
        objects,
        content,
        foundation_map.runtime_attributes,
        std::sync::Arc::make_mut(&mut foundation_map.restriction_zones.objects),
        Some(foundation_map.terrain),
        foundation_map.generation_program_mode,
        &mut foundation_map.lifecycle_projection,
    )?;
    foundation_map.restriction_zones.construct(
        placed.object_id,
        placed.owner,
        foundation_map.dimensions,
        foundation_map.terrain,
        content,
    )?;
    foundation_map.birth(&placed, position)?;
    foundation_map.apply(&placed, definition, descriptor.operation_index, completes)?;
    if position.map(f32::to_bits)
        != [placed.x_256 as f32 / 256.0, placed.y_256 as f32 / 256.0].map(f32::to_bits)
    {
        foundation_map
            .construction_positions
            .insert(objects.len(), position.map(f32::to_bits));
    }
    let constructed_index = objects.len();
    objects.push(placed);
    operation_indices.push(descriptor.operation_index);
    if definition
        .neighbor_facing
        .is_some_and(|f| f.updates_neighbors)
    {
        foundation_map.update_neighbors(constructed_index, objects)?;
    }
    for child in &definition.construction_attachments {
        if !object_available_to_owner(child.object_id, owner, setup, content)? {
            continue;
        }
        let child_position = [
            input_position[0] + f32::from_bits(child.x_offset_f32_bits),
            input_position[1] + f32::from_bits(child.y_offset_f32_bits),
        ];
        construct_one_at(
            child.object_id,
            child_position,
            owner,
            descriptor,
            setup,
            content,
            auxiliary_rng,
            objects,
            operation_indices,
            foundation_map,
            depth + 1,
            Some(completes),
        )?;
    }
    if definition.neighbor_facing.is_some() {
        foundation_map
            .pending_neighbor_completion
            .push(constructed_index);
    }
    if depth == 0 {
        for completion in 0..foundation_map.pending_neighbor_completion.len() {
            let index = foundation_map.pending_neighbor_completion[completion];
            foundation_map.update_neighbors(index, objects)?;
        }
        foundation_map.pending_neighbor_completion.clear();
        if let Some(facet) = descriptor.explicit_facet {
            objects[constructed_index].facet = facet;
        }
        adjust_object_resource(&mut objects[constructed_index]);
        let constructed_end = objects.len();
        for index in (constructed_index..constructed_end).filter(|_| completes) {
            farm_completion::complete_farm(
                index,
                descriptor,
                setup,
                content,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
            )?;
            complete_building_technology(
                index,
                descriptor,
                setup,
                content,
                auxiliary_rng,
                objects,
                operation_indices,
                foundation_map,
            )?;
            retire_completed_disappearing_building(index, content, objects, foundation_map)?;
        }
    }
    Ok(())
}

fn building_stack_unit(definition: &ObjectDefinition) -> Option<ObjectId> {
    definition
        .neighbor_facing
        .and_then(|facing| facing.linked_object_id)
}

fn retire_completed_disappearing_building(
    index: usize,
    content: CompatibleContentView<'_>,
    objects: &mut [PlacedObject],
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    let object = &objects[index];
    if object.status != 2
        || !foundation_map
            .runtime_attributes
            .definition(object.object_id, object.owner, content)
            .ok_or_else(|| missing_object_definition(object.object_id))?
            .disappears_when_built
    {
        return Ok(());
    }
    let identity = object.instance_id;
    let roster = std::sync::Arc::make_mut(&mut foundation_map.restriction_zones.objects);
    roster.retire(identity)?;
    project_construction_lifecycle(objects, roster, &mut foundation_map.lifecycle_projection)
}

#[allow(clippy::too_many_arguments)]
fn complete_building_technology(
    index: usize,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    if foundation_map.automatic_technologies.is_none() || objects[index].status != 2 {
        return Ok(());
    }
    let owner = objects[index].owner;
    let Some(player) = setup.players.iter().find(|player| player.slot == owner) else {
        return Ok(());
    };
    let Some(technology_id) =
        content.building_technology_trigger(player.civilization_id, objects[index].object_id)
    else {
        return Ok(());
    };
    foundation_map
        .automatic_technologies
        .as_mut()
        .expect("checked above")
        .researched
        .entry(owner)
        .or_default()
        .insert(technology_id);
    loop {
        let next = content
            .automatic_spawn_technologies()
            .iter()
            .find(|technology| {
                if technology
                    .civilization_id
                    .is_some_and(|civilization| civilization != player.civilization_id)
                {
                    return false;
                }
                let researched = &foundation_map
                    .automatic_technologies
                    .as_ref()
                    .expect("technology state remains installed")
                    .researched[&owner];
                !researched.contains(&technology.technology_id)
                    && technology
                        .required_technology_ids
                        .iter()
                        .all(|id| researched.contains(id))
            });
        let Some(technology) = next else {
            break;
        };
        foundation_map
            .automatic_technologies
            .as_mut()
            .expect("technology state remains installed")
            .researched
            .get_mut(&owner)
            .expect("owner was initialized")
            .insert(technology.technology_id);
        for command in &technology.commands {
            if foundation_map.generation_program_mode
                == NativeGenerationProgramMode::ExplicitMaximumSeed
            {
                continue;
            }
            let anchors = objects
                .iter()
                .enumerate()
                .filter(|(_, object)| {
                    object.owner == owner
                        && object.object_id == command.building_object_id
                        && object.status == 2
                        && foundation_map
                            .restriction_zones
                            .objects
                            .object(object.instance_id)
                            .is_some()
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            for anchor in anchors {
                for _ in 0..command.count {
                    let mut spawned_id = command.spawned_object_id;
                    if let Some(rule) = content.building_spawn_variant_rule(spawned_id) {
                        let sample = foundation_map
                            .automatic_technologies
                            .as_mut()
                            .expect("technology state remains installed")
                            .variant_rng
                            .next_u32()
                            & 0x7fff;
                        let sample = sample % 100;
                        if sample >= u32::from(rule.alternate_from_percent) {
                            spawned_id = rule.alternate_object_id;
                        }
                    }
                    let spawn_placement = foundation_map
                        .automatic_technologies
                        .as_ref()
                        .expect("technology state remains installed")
                        .spawn_placement;
                    let position = match spawn_placement {
                        rms_profile::BuildingSpawnPlacement::InnerTileFallback => {
                            building_spawn_fallback_position(
                                &objects[anchor],
                                content,
                                foundation_map,
                            )?
                        }
                        rms_profile::BuildingSpawnPlacement::UnitRingNearestDefault => {
                            let Some(position) = building_spawn_ring_position(
                                anchor,
                                spawned_id,
                                owner,
                                objects,
                                content,
                                foundation_map,
                            )?
                            else {
                                continue;
                            };
                            position
                        }
                    };
                    let mut spawn_descriptor = descriptor.clone();
                    spawn_descriptor.explicit_facet = None;
                    spawn_descriptor.resource_delta = 0;
                    spawn_descriptor.behavior_flags = 0;
                    construct_one_at(
                        spawned_id,
                        position,
                        owner,
                        &spawn_descriptor,
                        setup,
                        content,
                        auxiliary_rng,
                        objects,
                        operation_indices,
                        foundation_map,
                        1,
                        None,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn building_spawn_ring_position(
    anchor: usize,
    spawned_id: ObjectId,
    owner: u8,
    objects: &[PlacedObject],
    content: CompatibleContentView<'_>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<Option<[f32; 2]>, GenerationError> {
    let building = &objects[anchor];
    let attributes = foundation_map.runtime_attributes;
    let building_definition = attributes
        .definition(building.object_id, building.owner, content)
        .ok_or_else(|| missing_object_definition(building.object_id))?;
    let unit = attributes
        .definition(spawned_id, owner, content)
        .ok_or_else(|| missing_object_definition(spawned_id))?;
    let [bx, by] = foundation_map
        .construction_positions
        .get(&anchor)
        .map(|bits| bits.map(f32::from_bits))
        .unwrap_or([building.x_256 as f32 / 256.0, building.y_256 as f32 / 256.0]);
    let [bhx, bhy] = building_definition.collision_half_extents();
    let [ux, uy] = unit.collision_half_extents();
    let search = BuildingSpawnRingSearch::new([bx, by], [bhx, bhy], [ux, uy])?;
    let gate = SpawnReachGate::new(
        [bx - bhx, by - bhy],
        search.footprint,
        spawned_id,
        owner,
        unit,
        content,
        foundation_map,
    );
    let restriction = attributes.master_restriction_id(spawned_id, owner, unit);
    let mut work = foundation_map
        .automatic_technologies
        .as_ref()
        .expect("building spawn search requires technology state")
        .spawn_ring_work;
    let result = search.nearest(&mut work, |x: f32, y: f32| -> bool {
        if !gate.reaches(x, y) {
            return false;
        }
        if master_terrain_rejection_at_position(
            [x, y],
            unit,
            foundation_map.dimensions,
            foundation_map.terrain,
            content,
            false,
            restriction,
        )
        .is_some()
        {
            return false;
        }
        !spawn_position_obstructed([x, y], [ux, uy], content, foundation_map)
    });
    foundation_map
        .automatic_technologies
        .as_mut()
        .expect("building spawn search retains technology state")
        .spawn_ring_work = work;
    result
}

const MAXIMUM_BUILDING_SPAWN_SEARCH_WORK: u64 = 4_194_304;
const MAXIMUM_BUILDING_SPAWN_GENERATION_WORK: u64 = 33_554_432;

struct BuildingSpawnRingSearch {
    center: [f32; 2],
    target: [f32; 2],
    first: [f32; 2],
    step: [f32; 2],
    footprint: [i32; 2],
    outward: i32,
    inward: i32,
}

impl BuildingSpawnRingSearch {
    fn new(
        [bx, by]: [f32; 2],
        [bhx, bhy]: [f32; 2],
        [ux, uy]: [f32; 2],
    ) -> Result<Self, GenerationError> {
        if ![bx, by].into_iter().all(f32::is_finite)
            || ![bhx, bhy, ux, uy]
                .into_iter()
                .all(|value| value.is_finite() && value >= 0.0)
        {
            return Err(invalid_object("building spawn search geometry is invalid"));
        }
        let target = [bx - (bhx + ux), (bhy + uy) + by];
        let first_x = (ux + 0.01_f32) + bhx;
        let first_y = (uy + 0.01_f32) + bhy;
        let step_x = (ux + ux) + 1.0e-4_f32;
        let step_y = (uy + uy) + 1.0e-4_f32;
        let diameter = 2.0_f32 * ux.max(uy).max(0.1_f32);
        let outward = (2.0_f32 / diameter) as i32;
        let footprint_width = (((bx + bhx) - (bx - bhx)) + 0.999_f32) as i32;
        let footprint_height = (((by + bhy) - (by - bhy)) + 0.999_f32) as i32;
        let inward = (footprint_width.min(footprint_height) as f32 / diameter) as i32;
        if ![
            target[0], target[1], first_x, first_y, step_x, step_y, diameter,
        ]
        .into_iter()
        .all(f32::is_finite)
            || step_x <= 0.0
            || step_y <= 0.0
        {
            return Err(invalid_object("building spawn search geometry is invalid"));
        }
        Ok(Self {
            center: [bx, by],
            target,
            first: [first_x, first_y],
            step: [step_x, step_y],
            footprint: [footprint_width, footprint_height],
            outward,
            inward,
        })
    }

    fn nearest(
        &self,
        generation_work: &mut u64,
        mut accepts: impl FnMut(f32, f32) -> bool,
    ) -> Result<Option<[f32; 2]>, GenerationError> {
        let [bx, by] = self.center;
        let [first_x, first_y] = self.first;
        let [step_x, step_y] = self.step;
        let target = self.target;
        let mut search_work = 0_u64;
        for ring in 0..self.outward.saturating_add(self.inward).max(0) {
            let (offset_x, offset_y) = if ring < self.outward {
                let ring = ring as f32;
                (step_x * ring + first_x, ring * step_y + first_y)
            } else {
                let ring = (ring - self.outward) as f32;
                (first_x - ring * step_x, first_y - ring * step_y)
            };
            let left = bx - offset_x;
            let right = offset_x + bx;
            let bottom = by - offset_y;
            let top = by + offset_y;
            if ![left, right, bottom, top].into_iter().all(f32::is_finite) {
                return Err(invalid_object("building spawn ring is not finite"));
            }
            let mut best: Option<([f32; 2], f32)> = None;
            let mut visit = |x: f32, y: f32| -> Result<(), GenerationError> {
                if search_work >= MAXIMUM_BUILDING_SPAWN_SEARCH_WORK {
                    return Err(object_limit(
                        "building spawn search work",
                        MAXIMUM_BUILDING_SPAWN_SEARCH_WORK as usize,
                    ));
                }
                if *generation_work >= MAXIMUM_BUILDING_SPAWN_GENERATION_WORK {
                    return Err(object_limit(
                        "building spawn generation work",
                        MAXIMUM_BUILDING_SPAWN_GENERATION_WORK as usize,
                    ));
                }
                search_work += 1;
                *generation_work += 1;
                if accepts(x, y) {
                    let key = (target[1] - y) * (target[1] - y) + (target[0] - x) * (target[0] - x);
                    if best.is_none_or(|(_, current)| key < current) {
                        best = Some(([x, y], key));
                    }
                }
                Ok(())
            };
            let mut x = right;
            while x >= left + step_x {
                visit(x, bottom)?;
                x = building_spawn_ring_step(x, x - step_x, false)?;
            }
            let mut y = bottom + step_y;
            while top >= y {
                visit(right, y)?;
                y = building_spawn_ring_step(y, y + step_y, true)?;
            }
            let mut x = left;
            while right - step_x >= x {
                visit(x, top)?;
                x = building_spawn_ring_step(x, x + step_x, true)?;
            }
            let mut y = top - step_y;
            while y >= bottom {
                visit(left, y)?;
                y = building_spawn_ring_step(y, y - step_y, false)?;
            }
            if let Some((position, _)) = best {
                return Ok(Some(position));
            }
        }
        Ok(None)
    }
}

fn building_spawn_ring_step(
    value: f32,
    next: f32,
    ascending: bool,
) -> Result<f32, GenerationError> {
    if !next.is_finite() || (ascending && next <= value) || (!ascending && next >= value) {
        return Err(invalid_object("building spawn ring step does not progress"));
    }
    Ok(next)
}

struct SpawnReachGate {
    origin: [f32; 2],
    size: [i32; 2],
    distance: Vec<u8>,
}

impl SpawnReachGate {
    fn new(
        lower: [f32; 2],
        footprint: [i32; 2],
        spawned_id: ObjectId,
        owner: u8,
        unit: &ObjectDefinition,
        content: CompatibleContentView<'_>,
        foundation_map: &FoundationMap<'_>,
    ) -> Self {
        const UNREACHED: u8 = u8::MAX;
        let origin = [lower[0] - 2.0, lower[1] - 2.0];
        let base = [origin[0].floor() as i32, origin[1].floor() as i32];
        let size = [footprint[0].max(1) + 4, footprint[1].max(1) + 4];
        let dimensions = foundation_map.dimensions;
        let restriction = foundation_map
            .runtime_attributes
            .master_restriction_id(spawned_id, owner, unit)
            .and_then(|id| content.restriction(id));
        let permitted =
            restriction.and_then(|restriction| super::exact_zone::permissions(restriction).ok());
        let passable = |cell_x: i32, cell_y: i32| -> bool {
            let (x, y) = (base[0] + cell_x, base[1] + cell_y);
            if x < 0
                || y < 0
                || x >= i32::from(dimensions.width)
                || y >= i32::from(dimensions.height)
            {
                return false;
            }
            let terrain =
                foundation_map.terrain[y as usize * usize::from(dimensions.width) + x as usize];
            permitted.is_none_or(|(values, length)| {
                (terrain.0 as usize) < length && values[terrain.0 as usize]
            })
        };
        let cells = (size[0] * size[1]) as usize;
        let mut distance = vec![UNREACHED; cells];
        let mut queue = std::collections::VecDeque::new();
        let (first, last) = ([1, 1], [footprint[0].max(1) + 2, footprint[1].max(1) + 2]);
        for cell_y in first[1]..=last[1] {
            for cell_x in first[0]..=last[0] {
                if !passable(cell_x, cell_y) {
                    continue;
                }
                let corner_x = cell_x == first[0] || cell_x == last[0];
                let corner_y = cell_y == first[1] || cell_y == last[1];
                if corner_x && corner_y {
                    let inward_x = if cell_x == first[0] {
                        cell_x + 1
                    } else {
                        cell_x - 1
                    };
                    let inward_y = if cell_y == first[1] {
                        cell_y + 1
                    } else {
                        cell_y - 1
                    };
                    if !passable(inward_x, cell_y) && !passable(cell_x, inward_y) {
                        continue;
                    }
                }
                distance[(cell_y * size[0] + cell_x) as usize] = 0;
                queue.push_back((cell_x, cell_y));
            }
        }
        while let Some((cell_x, cell_y)) = queue.pop_front() {
            let next = distance[(cell_y * size[0] + cell_x) as usize] + 1;
            if next > 2 {
                continue;
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (x, y) = (cell_x + dx, cell_y + dy);
                if x < 0 || y < 0 || x >= size[0] || y >= size[1] || !passable(x, y) {
                    continue;
                }
                let slot = &mut distance[(y * size[0] + x) as usize];
                if *slot == UNREACHED {
                    *slot = next;
                    queue.push_back((x, y));
                }
            }
        }
        Self {
            origin,
            size,
            distance,
        }
    }

    fn reaches(&self, x: f32, y: f32) -> bool {
        let cell_x = (x - self.origin[0]) as i32;
        let cell_y = (y - self.origin[1]) as i32;
        if x < self.origin[0]
            || y < self.origin[1]
            || cell_x >= self.size[0]
            || cell_y >= self.size[1]
        {
            return false;
        }
        self.distance[(cell_y * self.size[0] + cell_x) as usize] <= 2
    }
}

fn spawn_position_obstructed(
    [x, y]: [f32; 2],
    [ux, uy]: [f32; 2],
    content: CompatibleContentView<'_>,
    foundation_map: &FoundationMap<'_>,
) -> bool {
    let roster = &foundation_map.restriction_zones.objects;
    let dimensions = foundation_map.dimensions;
    let window = |center: f32, limit: u16| {
        let low = (center as i32 - 8).clamp(0, i32::from(limit) - 1) as u16;
        let high = (center as i32 + 8).clamp(0, i32::from(limit) - 1) as u16;
        low..=high
    };
    let mut tiles = Vec::new();
    roster.member_tiles_in(
        window(x, dimensions.width),
        window(y, dimensions.height),
        &mut tiles,
    );
    roster.registered_objects_on(&tiles).any(|(_, object)| {
        let Some(definition) =
            foundation_map
                .runtime_attributes
                .definition(object.object_id, object.owner, content)
        else {
            return false;
        };
        let [rx, ry] = definition.collision_half_extents();
        let height = definition
            .pathing
            .is_none_or(|pathing| pathing.vertical_extent() > 0.0);
        let [ox, oy] = object.position_bits.map(f32::from_bits);
        rx > 0.0 && ry > 0.0 && height && (ux + rx) > (ox - x).abs() && (uy + ry) > (oy - y).abs()
    })
}

fn building_spawn_fallback_position(
    anchor: &PlacedObject,
    content: CompatibleContentView<'_>,
    foundation_map: &FoundationMap<'_>,
) -> Result<[f32; 2], GenerationError> {
    let definition = foundation_map
        .runtime_attributes
        .definition(anchor.object_id, anchor.owner, content)
        .ok_or_else(|| missing_object_definition(anchor.object_id))?;
    let [half_x, half_y] = definition.collision_half_extents();
    if half_x < 0.5 || half_y < 0.5 {
        return Err(invalid_object("building spawn perimeter has no interior"));
    }
    let center = [anchor.x_256 as f32 / 256.0, anchor.y_256 as f32 / 256.0];
    let left = center[0] - (half_x - 0.5);
    let right = center[0] + (half_x - 0.5);
    let bottom = center[1] - (half_y - 0.5);
    let top = center[1] + (half_y - 0.5);
    let mut best = None;
    let mut minimum = 255_usize;
    let mut visited = 0_usize;
    let mut visit = |position: [f32; 2]| -> Result<(), GenerationError> {
        visited += 1;
        if visited > 256 {
            return Err(object_limit("building spawn perimeter", 256));
        }
        let [x, y] = position;
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x >= f32::from(foundation_map.dimensions.width)
            || y >= f32::from(foundation_map.dimensions.height)
        {
            return Err(invalid_object("building spawn perimeter leaves map"));
        }
        let tile = MapCoordinate {
            x: x as u16,
            y: y as u16,
        };
        let count = foundation_map.restriction_zones.objects.members(tile).len();
        if count < minimum {
            minimum = count;
            best = Some(position);
        }
        Ok(())
    };
    let mut x = left;
    while x <= right {
        visit([x, top])?;
        x += 1.0;
    }
    let mut y = top - 1.0;
    while y >= bottom {
        visit([left, y])?;
        y -= 1.0;
    }
    let mut y = top - 1.0;
    while y >= bottom {
        visit([right, y])?;
        y -= 1.0;
    }
    let mut x = left + 1.0;
    while x <= right {
        visit([x, bottom])?;
        x += 1.0;
    }
    best.ok_or_else(|| invalid_object("building spawn perimeter has no eligible tile"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WallSegmentAxis {
    Horizontal,
    Vertical,
    NorthEast,
    SouthEast,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WallSegment {
    start: MapCoordinate,
    end: MapCoordinate,
}

impl WallSegment {
    fn span(self) -> u16 {
        self.end
            .x
            .abs_diff(self.start.x)
            .max(self.end.y.abs_diff(self.start.y))
    }

    fn axis(self) -> WallSegmentAxis {
        if self.start.y > self.end.y {
            WallSegmentAxis::NorthEast
        } else if self.start.x < self.end.x && self.start.y < self.end.y {
            WallSegmentAxis::SouthEast
        } else if self.start.x >= self.end.x {
            WallSegmentAxis::Vertical
        } else {
            WallSegmentAxis::Horizontal
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WallPathCache {
    inner_radius: u16,
    outer_radius: u16,
    players: BTreeMap<(u8, MapCoordinate), Vec<WallSegment>>,
}

impl WallPathCache {
    fn segments(&self, slot: u8, center: MapCoordinate) -> Result<&[WallSegment], GenerationError> {
        self.players
            .get(&(slot, center))
            .map(Vec::as_slice)
            .ok_or_else(|| invalid_object("wall path cache has no active player-land anchor"))
    }
}

fn wall_segment_coordinate(segment: WallSegment, offset: u16) -> MapCoordinate {
    let advance = |start: u16, end: u16| match start.cmp(&end) {
        std::cmp::Ordering::Less => start + offset,
        std::cmp::Ordering::Greater => start - offset,
        std::cmp::Ordering::Equal => start,
    };
    MapCoordinate {
        x: advance(segment.start.x, segment.end.x),
        y: advance(segment.start.y, segment.end.y),
    }
}

const WALL_ROUTE_AVOIDED_TERRAINS: [u32; 4] = [26, 35, 37, 127];
const WALL_ROUTE_SLOW_TERRAINS: [u32; 15] =
    [4, 26, 54, 55, 59, 63, 64, 65, 66, 67, 90, 93, 94, 111, 115];
const WALL_ROUTE_RESOURCE_CLASSES: [u32; 3] = [8, 32, 63];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WallBand {
    Left,
    Right,
    Top,
    Bottom,
}

impl WallBand {
    const ORDER: [Self; 4] = [Self::Left, Self::Right, Self::Top, Self::Bottom];

    fn corners(self, center: MapCoordinate, inner: u16, outer: u16) -> [i16; 4] {
        let offset = |value: u16, delta: u16, add: bool| {
            if add {
                value.wrapping_add(delta) as i16
            } else {
                value.wrapping_sub(delta) as i16
            }
        };
        let (x, y) = (center.x, center.y);
        match self {
            Self::Left => [
                offset(x, outer, false),
                offset(y, outer, false),
                offset(x, inner, false),
                offset(y, outer, true),
            ],
            Self::Right => [
                offset(x, inner, true),
                offset(y, outer, false),
                offset(x, outer, true),
                offset(y, outer, true),
            ],
            Self::Top => [
                offset(x, outer, false),
                offset(y, outer, false),
                offset(x, outer, true),
                offset(y, inner, false),
            ],
            Self::Bottom => [
                offset(x, outer, false),
                offset(y, inner, true),
                offset(x, outer, true),
                offset(y, outer, true),
            ],
        }
    }

    fn crosses_y(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

struct WallRouteWorld<'a> {
    width: u16,
    height: u16,
    terrain: &'a [TerrainId],
    connected: &'a [bool],
    roster: &'a super::exact_world::ObjectRoster,
    content: CompatibleContentView<'a>,
}

impl WallRouteWorld<'_> {
    fn index(&self, x: i32, y: i32) -> usize {
        y as usize * usize::from(self.width) + x as usize
    }

    fn has_resource(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= i32::from(self.width) || y >= i32::from(self.height) {
            return false;
        }
        let tile = MapCoordinate {
            x: x as u16,
            y: y as u16,
        };
        self.roster.members(tile).iter().any(|&identity| {
            self.roster
                .object(identity)
                .and_then(|object| self.content.object(object.object_id))
                .is_some_and(|definition| {
                    WALL_ROUTE_RESOURCE_CLASSES.contains(&definition.class_id)
                })
        })
    }

    fn step_cost(
        &self,
        x: i32,
        y: i32,
        diagonal: bool,
        band: WallBand,
        bounds: [i32; 4],
        masks: &[u8],
    ) -> i32 {
        let index = self.index(x, y);
        let terrain = self.terrain[index].0;
        let [low_x, low_y, high_x, high_y] = bounds;
        let cost = if WALL_ROUTE_AVOIDED_TERRAINS.contains(&terrain) {
            600
        } else if x == 0
            || y == 0
            || x == i32::from(self.width) - 1
            || y == i32::from(self.height) - 1
        {
            10
        } else if self.connected[index] {
            let base = if WALL_ROUTE_SLOW_TERRAINS.contains(&terrain) {
                300
            } else {
                100
            };
            base + if diagonal { 10 } else { 0 }
        } else if [(0, 0), (1, 0), (0, 1), (-1, 0), (0, -1)]
            .into_iter()
            .any(|(dx, dy)| self.has_resource(x + dx, y + dy))
        {
            300
        } else {
            10 + match band {
                WallBand::Top => y - low_y,
                WallBand::Left => x - low_x,
                WallBand::Right => high_x - x,
                WallBand::Bottom => high_y - y,
            }
        };
        if masks[index] != 0 { 2000 } else { cost }
    }
}

#[derive(Clone, Copy, Debug)]
struct WallRouteNode {
    x: i32,
    y: i32,
    cost: i32,
    parent: Option<usize>,
}

fn route_wall_band(
    world: &WallRouteWorld<'_>,
    masks: &mut [u8],
    seen: &mut [bool],
    painted: &mut BTreeSet<usize>,
    bit: u8,
    band: WallBand,
    corners: [i16; 4],
) {
    let width = i32::from(world.width);
    let height = i32::from(world.height);
    let [min_x, min_y, max_x, max_y] = corners.map(i32::from);
    if min_x >= width || max_x < 0 || min_y >= height || max_y <= 0 {
        return;
    }
    let last = width - 1;
    let bounds = [
        min_x.max(0),
        min_y.max(0),
        max_x.min(last),
        max_y.min(last).min(height - 1),
    ];
    let [low_x, low_y, high_x, high_y] = bounds;
    let (start_x, start_y) = match band {
        WallBand::Top => (low_x, high_y),
        WallBand::Left => (high_x, low_y),
        WallBand::Right | WallBand::Bottom => (low_x, low_y),
    };
    let (starting, goal_edge) = if band.crosses_y() {
        (low_y, high_y)
    } else {
        (low_x, high_x)
    };
    let mut nodes = vec![WallRouteNode {
        x: start_x,
        y: start_y,
        cost: 0,
        parent: None,
    }];
    let mut touched = vec![world.index(start_x, start_y)];
    seen[touched[0]] = true;
    let mut open = std::collections::BinaryHeap::from([std::cmp::Reverse((0_i32, usize::MAX))]);
    let mut goal = None;
    while let Some(std::cmp::Reverse((_, sequence))) = open.pop() {
        let current = usize::MAX - sequence;
        let node = nodes[current];
        if (if band.crosses_y() { node.y } else { node.x }) == goal_edge {
            goal = Some(current);
            break;
        }
        for (dx, dy, diagonal) in [
            (1, 1, true),
            (-1, 1, true),
            (1, -1, true),
            (-1, -1, true),
            (1, 0, false),
            (-1, 0, false),
            (0, 1, false),
            (0, -1, false),
        ] {
            let (x, y) = (node.x + dx, node.y + dy);
            if x < low_x || x > high_x || y < low_y || y > high_y {
                continue;
            }
            let index = world.index(x, y);
            if seen[index] {
                continue;
            }
            let along = if band.crosses_y() { y } else { x };
            let cost = if along == goal_edge {
                node.cost - 100
            } else if along != starting {
                node.cost + world.step_cost(x, y, diagonal, band, bounds, masks)
            } else {
                node.cost
            };
            let priority = cost + (goal_edge - along);
            open.push(std::cmp::Reverse((priority, usize::MAX - nodes.len())));
            nodes.push(WallRouteNode {
                x,
                y,
                cost,
                parent: Some(current),
            });
            seen[index] = true;
            touched.push(index);
        }
    }
    for index in touched {
        seen[index] = false;
    }
    let mut next = goal;
    while let Some(current) = next {
        let node = nodes[current];
        let index = world.index(node.x, node.y);
        masks[index] |= bit;
        painted.insert(index);
        next = node.parent;
    }
}

fn extract_wall_runs(
    masks: &[u8],
    connected: &[bool],
    dimensions: MapDimensions,
) -> [Vec<(WallSegment, bool)>; 8] {
    let width = usize::from(dimensions.width);
    let last_x = dimensions.width - 1;
    let last_y = dimensions.height - 1;
    let index = |x: u16, y: u16| usize::from(y) * width + usize::from(x);
    let mut unconsumed = vec![true; masks.len()];
    let mut runs: [Vec<(WallSegment, bool)>; 8] = Default::default();
    for x in 0..dimensions.width {
        for y in 0..dimensions.height {
            let mask = masks[index(x, y)];
            if !unconsumed[index(x, y)] || mask == 0 {
                continue;
            }
            for (bit_index, list) in runs.iter_mut().enumerate() {
                let bit = 1_u8 << bit_index;
                if mask & bit == 0 {
                    continue;
                }
                let available = connected[index(x, y)];
                let continues = |nx: u16, ny: u16| {
                    masks[index(nx, ny)] == bit && connected[index(nx, ny)] == available
                };
                let direction = if x < last_x && continues(x + 1, y) {
                    4
                } else if x < last_x && y < last_y && continues(x + 1, y + 1) {
                    12
                } else if y < last_y && continues(x, y + 1) {
                    8
                } else if y > 0 && x < last_x && continues(x + 1, y - 1) {
                    5
                } else {
                    0
                };
                let start = MapCoordinate { x, y };
                let mut point = start;
                let mut end = start;
                loop {
                    if connected[index(point.x, point.y)] != available {
                        break;
                    }
                    unconsumed[index(point.x, point.y)] = false;
                    end = point;
                    let mut moved = false;
                    if direction & 4 != 0 && point.x < last_x {
                        point.x += 1;
                        moved = true;
                    }
                    if direction & 8 != 0 && point.y < last_y {
                        point.y += 1;
                        moved = true;
                    }
                    if direction & 1 != 0 && point.y > 0 {
                        point.y -= 1;
                    } else if !moved {
                        break;
                    }
                    if masks[index(point.x, point.y)] & bit != bit {
                        break;
                    }
                }
                list.push((WallSegment { start, end }, available));
            }
        }
    }
    for list in &mut runs {
        list.reverse();
    }
    runs
}

#[allow(clippy::too_many_arguments)]
fn ensure_wall_path_cache(
    cache: &mut Option<WallPathCache>,
    inner_radius: u16,
    outer_radius: u16,
    anchor_masters: &[ObjectId],
    setup: &ExactSetupState,
    dimensions: MapDimensions,
    objects: &[PlacedObject],
    roster: &super::exact_world::ObjectRoster,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if cache.as_ref().is_some_and(|cache| {
        cache.inner_radius == inner_radius && cache.outer_radius == outer_radius
    }) {
        return Ok(());
    }

    let count = dimensions.tile_count()?;
    if terrain.len() != count {
        return Err(invalid_object("wall terrain does not match map dimensions"));
    }
    let connected = roster
        .path
        .connected_tiles()
        .ok_or_else(|| invalid_object("wall placement requires a path context"))?;
    if connected.len() != count {
        return Err(invalid_object(
            "wall connectivity does not match map dimensions",
        ));
    }
    let mut anchors = BTreeMap::new();
    let mut centers = BTreeMap::new();
    for position in &setup.player_positions {
        let key = (position.slot, position.coordinate);
        if anchors.contains_key(&key) {
            continue;
        }
        let center = wall_player_center(
            position.slot,
            position.coordinate,
            anchor_masters,
            objects,
            roster,
        )?;
        anchors.insert(key, center);
        centers.insert((position.slot, center), BTreeSet::new());
    }

    let world = WallRouteWorld {
        width: dimensions.width,
        height: dimensions.height,
        terrain,
        connected: &connected,
        roster,
        content,
    };
    let mut masks = vec![0_u8; count];
    let mut seen = vec![false; count];
    for (&(slot, center), painted) in &mut centers {
        let bit = 1_u8 << (slot - 1);
        for band in WallBand::ORDER {
            route_wall_band(
                &world,
                &mut masks,
                &mut seen,
                painted,
                bit,
                band,
                band.corners(center, inner_radius, outer_radius),
            );
        }
    }

    let mut inside = vec![0_u8; count];
    for &(slot, center) in centers.keys() {
        let bit = 1_u8 << (slot - 1);
        let reached = roster
            .path
            .cardinal_reachable(center, terrain, |index| masks[index] & bit != 0)?
            .ok_or_else(|| invalid_object("wall placement requires a path context"))?;
        for (mask, reached) in inside.iter_mut().zip(reached) {
            if reached {
                *mask |= bit;
            }
        }
    }
    for (mask, inside) in masks.iter_mut().zip(inside) {
        *mask &= inside;
    }

    let mut outside = vec![0_u8; count];
    for &(slot, center) in centers.keys() {
        let enemies = setup
            .players
            .iter()
            .filter(|player| !owners_have_pathing_relationship(setup, slot, player.slot))
            .fold(0_u8, |mask, player| mask | (1_u8 << (player.slot - 1)));
        let reached = roster
            .path
            .cardinal_reachable(center, terrain, |index| masks[index] & enemies != 0)?
            .ok_or_else(|| invalid_object("wall placement requires a path context"))?;
        for (mask, reached) in outside.iter_mut().zip(reached) {
            if reached {
                *mask |= enemies;
            }
        }
    }
    for (mask, outside) in masks.iter_mut().zip(outside) {
        *mask &= outside;
    }

    let runs = extract_wall_runs(&masks, &connected, dimensions);
    let width = usize::from(dimensions.width);
    let mut players = BTreeMap::new();
    for (&key, &center) in &anchors {
        let painted = &centers[&(key.0, center)];
        let segments = runs[usize::from(key.0 - 1)]
            .iter()
            .filter(|(segment, built)| {
                *built
                    && painted.contains(
                        &(usize::from(segment.start.y) * width + usize::from(segment.start.x)),
                    )
            })
            .map(|&(segment, _)| segment)
            .collect();
        players.insert(key, segments);
    }
    *cache = Some(WallPathCache {
        inner_radius,
        outer_radius,
        players,
    });
    Ok(())
}

fn wall_player_center(
    slot: u8,
    fallback: MapCoordinate,
    anchors: &[ObjectId],
    objects: &[PlacedObject],
    roster: &super::exact_world::ObjectRoster,
) -> Result<MapCoordinate, GenerationError> {
    for &master in anchors {
        for object in objects
            .iter()
            .filter(|object| object.owner == slot && object.object_id == master)
        {
            if roster.was_destroyed(object.instance_id) {
                continue;
            }
            let live = roster
                .object(object.instance_id)
                .ok_or_else(|| invalid_object("wall anchor is absent from the live roster"))?;
            if live.lifecycle == 2 {
                return Ok(MapCoordinate {
                    x: f32::from_bits(live.position_bits[0]) as u16,
                    y: f32::from_bits(live.position_bits[1]) as u16,
                });
            }
        }
    }
    Ok(fallback)
}

fn native_wall_gates(gate_key: Option<ObjectId>, axis: WallSegmentAxis) -> (ObjectId, ObjectId) {
    let row: [(u32, u32); 4] = match gate_key.map(|id| id.0) {
        Some(72 | 119 | 1062) => [(801, 803), (797, 799), (789, 791), (793, 795)],
        Some(155) => [(668, 672), (660, 664), (63, 80), (85, 92)],
        Some(370) => [(1591, 1593), (1587, 1589), (1579, 1581), (1583, 1585)],
        Some(788) => [(1391, 1393), (1387, 1389), (1379, 1381), (1383, 1385)],
        Some(2678) => [(2691, 2693), (2687, 2689), (2679, 2681), (2683, 2685)],
        _ => [(667, 671), (659, 663), (64, 81), (88, 95)],
    };
    let (center, flank) = row[match axis {
        WallSegmentAxis::NorthEast => 0,
        WallSegmentAxis::SouthEast => 1,
        WallSegmentAxis::Horizontal => 2,
        WallSegmentAxis::Vertical => 3,
    }];
    (ObjectId(center), ObjectId(flank))
}

fn wall_gate_tiles(segment: WallSegment) -> [MapCoordinate; 3] {
    let half = segment.span() / 2;
    let along = |offset| wall_segment_coordinate(segment, offset);
    match segment.axis() {
        WallSegmentAxis::Horizontal | WallSegmentAxis::SouthEast => {
            [along(half), along(half - 2), along(half + 1)]
        }
        WallSegmentAxis::Vertical => [along(half), along(half + 1), along(half - 2)],
        WallSegmentAxis::NorthEast => {
            let center = MapCoordinate {
                x: segment.start.x + half,
                y: segment.start.y - 1,
            };
            [
                center,
                MapCoordinate {
                    x: center.x + 1,
                    y: center.y - 2,
                },
                MapCoordinate {
                    x: center.x - 2,
                    y: center.y + 1,
                },
            ]
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn place_wall_ring(
    descriptor: &ExactObjectDescriptor,
    player: (u8, MapCoordinate),
    owner: u8,
    dimensions: MapDimensions,
    segments: &[WallSegment],
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
    actor_areas: &mut ActorAreaState,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    for &segment in segments {
        let span = segment.span();
        let gate_start = (span / 2).saturating_sub(2);
        if span >= 4 {
            let (gate_center_id, gate_flank_id) =
                native_wall_gates(descriptor.object_id, segment.axis());
            let gate_center_id = resolve_object_replacement(
                gate_center_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            let [gate_center, first_flank, second_flank] = wall_gate_tiles(segment);
            push_wall_component(
                gate_center_id,
                gate_center,
                owner,
                7,
                descriptor,
                content,
                objects,
                operation_indices,
                foundation_map,
            )?;
            auxiliary_rng.next_u32();
            for flank in [first_flank, second_flank] {
                push_wall_component(
                    gate_flank_id,
                    flank,
                    owner,
                    7,
                    descriptor,
                    content,
                    objects,
                    operation_indices,
                    foundation_map,
                )?;
                auxiliary_rng.next_u32();
            }
            register_actor_area(
                descriptor,
                Some(player),
                segment.start,
                dimensions,
                actor_areas,
            )?;
        }
        for offset in 0..=span {
            if span >= 4 && (gate_start..gate_start + 4).contains(&offset) {
                continue;
            }
            let coordinate = wall_segment_coordinate(segment, offset);
            let facet = if offset == 0 || offset == span {
                2
            } else {
                match segment.axis() {
                    WallSegmentAxis::Horizontal => 0,
                    WallSegmentAxis::Vertical => 1,
                    WallSegmentAxis::NorthEast => 4,
                    WallSegmentAxis::SouthEast => 3,
                }
            };
            let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
            let wall_object_id = resolve_object_replacement(
                source_object_id,
                owner,
                setup,
                content,
                foundation_map.runtime_attributes,
                rng,
            )?;
            push_wall_component(
                wall_object_id,
                coordinate,
                owner,
                facet,
                descriptor,
                content,
                objects,
                operation_indices,
                foundation_map,
            )?;
            auxiliary_rng.next_u32();
            auxiliary_rng.next_u32();
            register_actor_area(
                descriptor,
                Some(player),
                coordinate,
                dimensions,
                actor_areas,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn push_wall_component(
    object_id: ObjectId,
    coordinate: MapCoordinate,
    owner: u8,
    facet: u16,
    descriptor: &ExactObjectDescriptor,
    content: CompatibleContentView<'_>,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    if objects.len() >= MAXIMUM_CREATED_OBJECTS {
        return Err(object_limit("placed objects", MAXIMUM_CREATED_OBJECTS));
    }
    let definition = foundation_map
        .runtime_attributes
        .definition(object_id, owner, content)
        .ok_or_else(|| missing_object_definition(object_id))?;
    let resources = foundation_map
        .runtime_attributes
        .initial_resources(definition, owner, content)?;
    let mut placed = PlacedObject {
        instance_id: foundation_map.next_instance_id,
        object_id,
        x_256: object_axis_position_256(
            coordinate.x,
            definition.collision_half_extents()[0],
            foundation_map.dimensions.width,
            definition.edge_margin_256,
        ),
        y_256: object_axis_position_256(
            coordinate.y,
            definition.collision_half_extents()[1],
            foundation_map.dimensions.height,
            definition.edge_margin_256,
        ),
        z_256: 0,
        owner,
        facet,
        footprint_width_256: definition.footprint_width_256,
        footprint_height_256: definition.footprint_height_256,
        presentation_kind: 0,
        resource_type: resources.resource_type,
        resource_quantity_f32_bits: resources.quantity_f32_bits,
        resource_delta: descriptor.resource_delta,
        status: i32::from(definition.initial_lifecycle_state),
        death_state: i8::from_ne_bytes([definition.initial_lifecycle_state]),
        data_status: definition.data_status,
        selection_flags: 0,
        behavior_flags: descriptor.behavior_flags,
    };
    retire_construction_overlaps_on_terrain(
        &placed,
        [placed.x_256 as f32 / 256.0, placed.y_256 as f32 / 256.0],
        objects,
        content,
        foundation_map.runtime_attributes,
        std::sync::Arc::make_mut(&mut foundation_map.restriction_zones.objects),
        Some(foundation_map.terrain),
        foundation_map.generation_program_mode,
        &mut foundation_map.lifecycle_projection,
    )?;
    foundation_map.restriction_zones.construct(
        placed.object_id,
        placed.owner,
        foundation_map.dimensions,
        foundation_map.terrain,
        content,
    )?;
    foundation_map.birth(
        &placed,
        [placed.x_256 as f32 / 256.0, placed.y_256 as f32 / 256.0],
    )?;
    let completes = building_completes_at_creation(
        object_id,
        owner,
        definition,
        content,
        foundation_map.runtime_attributes,
    )?;
    foundation_map.apply(&placed, definition, descriptor.operation_index, completes)?;
    adjust_object_resource(&mut placed);
    objects.push(placed);
    operation_indices.push(descriptor.operation_index);
    foundation_map.update_neighbors(objects.len() - 1, objects)?;
    Ok(())
}

fn construct_object_facet(profile: ObjectCreationRng, rng: &mut RmsRandom) -> u16 {
    let mut facet = 0;
    if profile.random_facet {
        let sample = rng.next_u32() & 0x7fff;
        let scaled = u32::from(profile.facet_count) * sample / 0x7fff;
        facet = scaled.min(u32::from(profile.facet_count - 1)) as u16;
    }
    if profile.random_angle {
        let sample = rng.next_u32() & 0x7fff;
        facet = sampled_angle_facet(profile.facet_count, sample);
    }
    if profile.random_combat_seed {
        rng.next_u32();
    }
    profile.fixed_facet.unwrap_or(facet)
}

fn sampled_angle_facet(graphic_directions: u16, sample: u32) -> u16 {
    let sector = u32::from(graphic_directions) * sample / 0x7fff;
    let full_turn = std::f32::consts::TAU;
    let mut angle = (full_turn / f32::from(graphic_directions)) * sector as f32;
    if angle > full_turn {
        angle -= full_turn;
    }
    let facing_directions = f32::from(graphic_directions.max(8));
    let shifted = ((angle - std::f32::consts::FRAC_PI_4) * facing_directions) / full_turn;
    let mut rounded = shifted + 0.5;
    if rounded < 0.0 {
        rounded += facing_directions;
    }
    rounded as u16
}

fn object_available_to_owner(
    object_id: ObjectId,
    owner: u8,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
) -> Result<bool, GenerationError> {
    let civilization_id = if owner == 0 {
        setup.gaia_civilization_id
    } else {
        setup
            .players
            .iter()
            .find(|player| player.slot == owner)
            .map(|player| player.civilization_id)
            .ok_or_else(|| invalid_object("object owner is absent from setup"))?
    };
    let object_id = content.substituted_object(civilization_id, object_id);
    let Some(definition) = content.object(object_id) else {
        return Ok(false);
    };
    let master_table_id = if owner == 0 {
        CivilizationId(0)
    } else {
        civilization_id
    };
    let Some(civilizations) = &definition.available_civilizations else {
        return Ok(true);
    };
    if owner != 0 && civilization_id == CivilizationId(0) {
        if civilizations.iter().all(|id| *id == CivilizationId(0)) {
            return Ok(false);
        }
        return Err(invalid_object(
            "civilization-scoped object availability requires an effective player civilization",
        ));
    }
    Ok(civilizations.binary_search(&master_table_id).is_ok())
}

fn resolve_object_replacement(
    source_object_id: ObjectId,
    owner: u8,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    rng: &mut RmsRandom,
) -> Result<ObjectId, GenerationError> {
    let Some(rule) = content.object_replacement_rule(source_object_id) else {
        return Ok(source_object_id);
    };
    let civilization_id = owner_civilization(owner, setup)?;
    if rule.technology_gate.is_some() && later_starting_age(setup) {
        return Err(invalid_object(
            "object replacement technology gate under a later starting age is unsupported",
        ));
    }
    if rule.technology_gate.is_some() && setup.lobby_options.changes_technology_state() {
        return Err(invalid_object(
            "object replacement technology gate under the full tech tree or antiquity mode is unsupported",
        ));
    }
    if !replacement_gates_pass(rule, owner, civilization_id, content, runtime_attributes)? {
        return Ok(source_object_id);
    }
    let roll = rng.bounded(100).result as u8;
    let mut target = source_object_id;
    if let Some(object_id) = rule.replacement_object_id
        && object_available_to_owner(object_id, owner, setup, content)?
    {
        target = object_id;
    } else if let Some(attribute_id) = rule.replacement_attribute_id {
        let table_object_id = content
            .civilization_object_attribute(
                owner_resource_civilization(owner, civilization_id),
                attribute_id,
            )
            .ok_or_else(|| {
                invalid_object("object replacement attribute is absent for the owner civilization")
            })?;
        let object_id = if resource_rule_disabled(ResourceRuleSwitch::LiveReplacementResources) {
            if runtime_attributes.replacement_input_may_change(
                owner,
                attribute_id.0,
                table_object_id.0 as f32,
            ) {
                return Err(invalid_object(
                    "object replacement resource input changed by an RMS effect is unsupported",
                ));
            }
            Some(table_object_id)
        } else {
            let live = runtime_attributes.effective_player_resource(
                owner,
                attribute_id.0,
                table_object_id.0 as f32,
            );
            u32::try_from(truncate_f32_to_i32(live)).ok().map(ObjectId)
        };
        if let Some(object_id) = object_id
            && object_available_to_owner(object_id, owner, setup, content)?
        {
            target = object_id;
        }
    }
    if rule
        .maximum_roll_inclusive
        .is_none_or(|maximum| roll <= maximum)
    {
        Ok(target)
    } else {
        Ok(source_object_id)
    }
}

fn later_starting_age(setup: &ExactSetupState) -> bool {
    !matches!(
        setup.starting_age,
        StartingAge::Standard | StartingAge::DarkAge
    )
}

fn require_standard_start_research(
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let unlockable = later_starting_age(setup)
        && content
            .setup_dependent_spawn_technologies()
            .iter()
            .any(|technology| {
                setup.players.iter().any(|player| {
                    technology
                        .civilization_id
                        .is_none_or(|civilization| civilization == player.civilization_id)
                })
            });
    if unlockable {
        return Err(invalid_object(
            "automatic spawn research a later starting age can unlock is unsupported",
        ));
    }
    Ok(())
}

fn owner_civilization(
    owner: u8,
    setup: &ExactSetupState,
) -> Result<CivilizationId, GenerationError> {
    if owner == 0 {
        Ok(setup.gaia_civilization_id)
    } else {
        setup
            .players
            .iter()
            .find(|player| player.slot == owner)
            .map(|player| player.civilization_id)
            .ok_or_else(|| invalid_object("object owner is absent from setup"))
    }
}

fn owner_generation_technology_state(
    technology_id: u16,
    owner: u8,
    civilization_id: CivilizationId,
    content: CompatibleContentView<'_>,
) -> Result<i16, GenerationError> {
    let owner = if owner == 0 {
        rms_content::TechnologyStateOwner::Gaia
    } else {
        rms_content::TechnologyStateOwner::Player(civilization_id)
    };
    content
        .generation_start_technology_state(technology_id, owner)
        .map_err(|error| match error {
            rms_content::TechnologyStateError::Unavailable => GenerationError::IncompatibleContent,
            rms_content::TechnologyStateError::Undetermined => invalid_object(
                "a Gaia object replacement that depends on a technology needing no earlier technology is unsupported",
            ),
        })
}

fn owner_resource_civilization(owner: u8, civilization_id: CivilizationId) -> CivilizationId {
    if owner == 0 {
        CivilizationId(0)
    } else {
        civilization_id
    }
}

fn replacement_gates_pass(
    rule: &rms_content::ObjectReplacementRule,
    owner: u8,
    civilization_id: CivilizationId,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    if let Some(gate) = &rule.technology_gate {
        let mut matched = false;
        for &technology_id in &gate.technology_ids {
            if owner_generation_technology_state(technology_id, owner, civilization_id, content)?
                == gate.state
            {
                matched = true;
                break;
            }
        }
        if !matched {
            return Ok(false);
        }
    }
    if let Some(attribute_id) = rule.required_attribute_id {
        let value = content
            .civilization_attribute_value(
                owner_resource_civilization(owner, civilization_id),
                attribute_id,
            )
            .ok_or(GenerationError::IncompatibleContent)?;
        let value = if resource_rule_disabled(ResourceRuleSwitch::LiveReplacementResources) {
            value
        } else {
            runtime_attributes.effective_player_resource(owner, attribute_id.0, value)
        };
        if value <= 0.0 {
            return Ok(false);
        }
    }
    if rule.excludes_computer_players && owner != 0 {
        return Err(invalid_object(
            "object replacement excluding computer players needs player controller types",
        ));
    }
    Ok(true)
}

fn validate_replacement_gates(
    semantic_program: &SemanticProgram,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let gated = content
        .object_replacement_rules()
        .iter()
        .filter(|rule| rule.required_attribute_id.is_some() || rule.technology_gate.is_some())
        .collect::<Vec<_>>();
    if gated.is_empty() {
        return Ok(());
    }
    let mut dynamic = content
        .automatic_spawn_technologies()
        .iter()
        .map(|technology| technology.technology_id)
        .collect::<BTreeSet<_>>();
    dynamic.extend(content.building_technology_trigger_ids());
    for rule in &gated {
        for &technology_id in rule
            .technology_gate
            .iter()
            .flat_map(|gate| &gate.technology_ids)
        {
            let state = content
                .technology_state_rule(technology_id)
                .ok_or(GenerationError::IncompatibleContent)?;
            if dynamic.contains(&technology_id)
                || state
                    .required_technology_ids
                    .iter()
                    .any(|id| dynamic.contains(id))
            {
                return Err(invalid_object(
                    "object replacement technology gate can change during generation",
                ));
            }
        }
    }
    let mut attributes = BTreeSet::new();
    let mut technologies = BTreeSet::new();
    for rule in &gated {
        attributes.extend(
            rule.required_attribute_id
                .map(|attribute| attribute.0 as i32),
        );
        for &technology_id in rule
            .technology_gate
            .iter()
            .flat_map(|gate| &gate.technology_ids)
        {
            technologies.insert(i32::from(technology_id));
            if let Some(state) = content.technology_state_rule(technology_id) {
                technologies.extend(
                    state
                        .required_technology_ids
                        .iter()
                        .map(|id| i32::from(*id)),
                );
            }
        }
    }
    let effect_ids = |names: &[&str]| {
        names
            .iter()
            .filter_map(|name| content.rms_implicit_definition(name))
            .collect::<BTreeSet<_>>()
    };
    let resource_effects = effect_ids(&[
        "MOD_RESOURCE",
        "MUL_RESOURCE",
        "GAIA_MOD_RESOURCE",
        "GAIA_MUL_RESOURCE",
    ]);
    let technology_effects = effect_ids(&[
        "DISABLE_TECH",
        "GAIA_DISABLE_TECH",
        "MODIFY_TECH",
        "GAIA_MODIFY_TECH",
    ]);
    let changes_gate_state = semantic_program.operations.iter().any(|operation| {
        if !operation.accepted_by_target_parser()
            || !matches!(operation.name.as_str(), "effect_amount" | "effect_percent")
        {
            return false;
        }
        let Ok(effect) = numeric_i32(operation, 0) else {
            return false;
        };
        let operand = |index| numeric_i32(operation, index).ok();
        (resource_rule_disabled(ResourceRuleSwitch::LiveReplacementResources)
            && resource_effects.contains(&effect)
            && operand(1).is_some_and(|attribute| attributes.contains(&attribute)))
            || (technology_effects.contains(&effect)
                && [operand(1), operand(3)]
                    .into_iter()
                    .flatten()
                    .any(|technology| technologies.contains(&technology)))
    });
    if changes_gate_state {
        return Err(invalid_object(
            "object replacement gate state changed by an RMS effect is unsupported",
        ));
    }
    Ok(())
}

fn object_axis_center_offset_256(half_extent: f32) -> u32 {
    if half_extent.fract() == 0.0 { 0 } else { 128 }
}

fn object_axis_position_256(
    coordinate: u16,
    half_extent: f32,
    map_extent: u16,
    edge_margin_256: u8,
) -> u32 {
    clamp_axis_position_256(
        u32::from(coordinate) * 256 + object_axis_center_offset_256(half_extent),
        half_extent,
        map_extent,
        edge_margin_256,
    )
}

fn clamp_axis_position_256(
    aligned: u32,
    half_extent: f32,
    map_extent: u16,
    edge_margin_256: u8,
) -> u32 {
    let footprint_extent_256 = (half_extent * 512.0).round() as u16;
    if footprint_extent_256 == 0 {
        return aligned;
    }
    let minimum = u32::from(footprint_extent_256).div_ceil(2) + u32::from(edge_margin_256);
    let maximum = u32::from(map_extent)
        .saturating_mul(256)
        .saturating_sub(minimum);
    aligned.clamp(minimum.min(maximum), maximum.max(minimum))
}

fn is_zero_sized_non_obstructing(definition: &ObjectDefinition) -> bool {
    definition.footprint_width_256 == 0
        && definition.footprint_height_256 == 0
        && definition.obstruction == ObstructionKind::None
        && definition.foundation.is_none()
}

#[allow(clippy::too_many_arguments)]
fn collect_actor_area_candidates(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    owner: u8,
    actor_areas: &mut ActorAreaState,
    object_groups: &[ExactObjectGroup],
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    rng: &mut RmsRandom,
    cancellation: &dyn CancellationToken,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> Result<(Vec<usize>, u32), GenerationError> {
    let Some(actor_area_id) = descriptor.actor_area_to_place_in else {
        return Ok((Vec::new(), 0));
    };
    let distance_center = if actor_area_distance_rule_disabled_for_attribution() {
        Some(object_placement_center(player, connection.dimensions))
    } else {
        actor_areas.current_land_center
    };
    if distance_center.is_none()
        && descriptor
            .maximum_distance_to_players
            .is_some_and(|radius| radius > 0)
    {
        return Err(GenerationError::InvalidMap(
            "an actor-area placement measures its player distance from a land, and the map has no land"
                .to_owned(),
        ));
    }
    let tile_count = connection.dimensions.tile_count()?;
    let map_width = usize::from(connection.dimensions.width);
    let Some(record_index) = actor_areas.record_index(actor_area_id) else {
        return Ok((Vec::new(), 0));
    };
    let record = &mut actor_areas.records[record_index];
    let requested_iterations = record.total_weight.max(u64::from(effective_group_count(
        descriptor,
        setup,
        connection.dimensions,
        object_groups,
        content,
    )?));
    if requested_iterations > MAXIMUM_ACTOR_AREA_WEIGHT {
        return Err(GenerationError::ResourceLimit {
            resource: "actor-area candidate work".to_owned(),
            limit: MAXIMUM_ACTOR_AREA_WEIGHT,
        });
    }
    let iterations = u32::try_from(requested_iterations)
        .map_err(|_| invalid_object("actor-area candidate work exceeds u32"))?;
    if iterations == 0 {
        return Ok((Vec::new(), 0));
    }

    let fixed_candidate_definition = descriptor_runtime_object_definition(
        descriptor,
        object_groups,
        content,
        runtime_attributes,
        owner,
    );
    let class_filter_master =
        ClassFilterMaster::for_request(descriptor, object_groups, content, runtime_attributes);
    let logical_areas = ActorAreas::indexed(&actor_areas.logical, &actor_areas.index)
        .for_request(&descriptor.avoid_actor_areas);
    let mut sampler = WeightedSampler::new(record.tiles.iter().map(|tile| tile.weight).collect());
    let mut last_selected = vec![u32::MAX; tile_count];
    let mut remaining = record.total_weight;
    let mut restored = vec![0_u32; record.tiles.len()];
    let mut completed_iterations = 0_u32;
    for iteration in 0..iterations {
        if iteration % 1024 == 0 {
            cancellation_checkpoint(cancellation, GenerationStage::Objects, u64::from(iteration))?;
        }
        if remaining == 0 {
            break;
        }
        let record_index = sampler.select(rng.bounded(remaining as u32).result);
        restored[record_index] += 1;
        completed_iterations += 1;
        let tile_index = record.tiles[record_index].tile_index;
        let coordinate = MapCoordinate {
            x: (tile_index % map_width) as u16,
            y: (tile_index / map_width) as u16,
        };
        if !candidate_availability.is_available(coordinate) {
            continue;
        }
        sampler.remove_one(record_index);
        remaining -= 1;
        let resolved_candidate_definition = if descriptor.object_class_filter.is_some() {
            class_filter_master.resolve(
                descriptor,
                object_groups,
                setup,
                content,
                runtime_attributes,
                rng,
            )?
        } else {
            fixed_candidate_definition
        };
        if actor_area_queue_candidate_matches(
            descriptor,
            distance_center,
            coordinate,
            connection,
            resolved_candidate_definition,
            logical_areas,
            appearance_objects,
            objects,
            terrain,
            content,
            roster,
            list_classes,
        ) {
            last_selected[tile_index] = iteration;
        }
    }

    for ((tile, weight), count) in record
        .tiles
        .iter_mut()
        .zip(sampler.into_weights())
        .zip(restored)
    {
        tile.weight = weight
            .checked_add(count)
            .ok_or_else(|| invalid_object("actor-area tile weight exceeds u32"))?;
        remaining = remaining.saturating_add(u64::from(count));
    }
    record.total_weight = remaining;

    let mut candidates: Vec<_> = record
        .tiles
        .iter()
        .map(|tile| tile.tile_index)
        .filter(|&tile_index| last_selected[tile_index] != u32::MAX)
        .collect();
    candidates.sort_unstable_by(|left, right| last_selected[*right].cmp(&last_selected[*left]));
    Ok((candidates, completed_iterations))
}

struct WeightedRecordSampler {
    weights: Vec<u32>,
    ends: Vec<u64>,
    guide: Vec<u32>,
    shift: u32,
    removed: Vec<usize>,
}

impl WeightedRecordSampler {
    const REMOVALS_PER_SNAPSHOT: usize = 64;

    fn new(weights: Vec<u32>) -> Self {
        let mut sampler = Self {
            weights,
            ends: Vec::new(),
            guide: Vec::new(),
            shift: 0,
            removed: Vec::new(),
        };
        sampler.snapshot();
        sampler
    }

    fn snapshot(&mut self) {
        let mut total = 0_u64;
        self.ends.clear();
        self.ends.extend(self.weights.iter().map(|&weight| {
            total += u64::from(weight);
            total
        }));
        let buckets = (self.ends.len() as u64).saturating_mul(4).max(1);
        self.shift = 0;
        while (total >> self.shift) > buckets {
            self.shift += 1;
        }
        self.guide.clear();
        let mut entry = 0_usize;
        for bucket in 0..=(total >> self.shift) {
            let start = bucket << self.shift;
            while entry + 1 < self.ends.len() && self.ends[entry] <= start {
                entry += 1;
            }
            self.guide.push(entry as u32);
        }
        self.removed.clear();
    }

    fn select(&self, draw: u32) -> usize {
        let draw = u64::from(draw);
        let mut entry = self.guide[(draw >> self.shift) as usize] as usize;
        let mut removed = self.removed.partition_point(|&index| index < entry);
        loop {
            while self.removed.get(removed) == Some(&entry) {
                removed += 1;
            }
            if self.ends[entry] - removed as u64 > draw {
                return entry;
            }
            entry += 1;
        }
    }

    fn remove_one(&mut self, entry: usize) {
        self.weights[entry] -= 1;
        let at = self.removed.partition_point(|&index| index <= entry);
        self.removed.insert(at, entry);
        if self.removed.len() >= Self::REMOVALS_PER_SNAPSHOT {
            self.snapshot();
        }
    }
}

struct WeightedSampler {
    reference: Option<WeightedRecordSampler>,
    accelerated: Option<RemovalCountSampler>,
}

impl WeightedSampler {
    fn new(weights: Vec<u32>) -> Self {
        use crate::placement_oracle::PlacementCheckMode;
        let mode = crate::placement_oracle::mode();
        Self {
            reference: (mode != PlacementCheckMode::Accelerated)
                .then(|| WeightedRecordSampler::new(weights.clone())),
            accelerated: (mode != PlacementCheckMode::Reference)
                .then(|| RemovalCountSampler::new(weights)),
        }
    }

    fn select(&self, draw: u32) -> usize {
        match (&self.reference, &self.accelerated) {
            (Some(reference), Some(accelerated)) => {
                let expected = reference.select(draw);
                crate::placement_oracle::compare(
                    crate::placement_oracle::OracleCheck::WeightedSample,
                    &expected,
                    &accelerated.select(draw),
                    || format!("weighted actor-area sample of draw {draw}"),
                );
                expected
            }
            (Some(reference), None) => reference.select(draw),
            (None, Some(accelerated)) => accelerated.select(draw),
            (None, None) => unreachable!("one route always exists"),
        }
    }

    fn remove_one(&mut self, entry: usize) {
        if let Some(reference) = &mut self.reference {
            reference.remove_one(entry);
        }
        if let Some(accelerated) = &mut self.accelerated {
            accelerated.remove_one(entry);
        }
    }

    fn into_weights(self) -> Vec<u32> {
        match (self.reference, self.accelerated) {
            (Some(reference), _) => reference.weights,
            (None, Some(accelerated)) => accelerated.weights,
            (None, None) => unreachable!("one route always exists"),
        }
    }
}

struct RemovalCountSampler {
    weights: Vec<u32>,
    ends: Vec<u64>,
    guide: Vec<u32>,
    shift: u32,
    removed: Vec<u32>,
    tree: Vec<u64>,
    pending: u64,
    threshold: u64,
}

impl RemovalCountSampler {
    fn new(weights: Vec<u32>) -> Self {
        let length = weights.len();
        let mut sampler = Self {
            weights,
            ends: Vec::with_capacity(length),
            guide: Vec::new(),
            shift: 0,
            removed: vec![0; length],
            tree: vec![0; length + 1],
            pending: 0,
            threshold: 0,
        };
        sampler.snapshot();
        sampler
    }

    fn snapshot(&mut self) {
        let mut total = 0_u64;
        self.ends.clear();
        self.ends.extend(self.weights.iter().map(|&weight| {
            total += u64::from(weight);
            total
        }));
        let buckets = (self.ends.len() as u64).saturating_mul(4).max(1);
        self.shift = 0;
        while (total >> self.shift) > buckets {
            self.shift += 1;
        }
        self.guide.clear();
        let mut entry = 0_usize;
        for bucket in 0..=(total >> self.shift) {
            let start = bucket << self.shift;
            while entry + 1 < self.ends.len() && self.ends[entry] <= start {
                entry += 1;
            }
            self.guide.push(entry as u32);
        }
        if self.pending > 0 {
            self.removed.fill(0);
            self.tree.fill(0);
        }
        self.pending = 0;
        self.threshold = (2 * (self.ends.len() as u64).isqrt()).max(64);
    }

    fn removed_before(&self, entry: usize) -> u64 {
        let mut sum = 0_u64;
        let mut position = entry;
        while position > 0 {
            sum += self.tree[position];
            position &= position - 1;
        }
        sum
    }

    fn select(&self, draw: u32) -> usize {
        let draw = u64::from(draw);
        let mut entry = self.guide[(draw >> self.shift) as usize] as usize;
        let mut removed = self.removed_before(entry);
        loop {
            removed += u64::from(self.removed[entry]);
            if self.ends[entry] - removed > draw {
                return entry;
            }
            entry += 1;
        }
    }

    fn remove_one(&mut self, entry: usize) {
        self.weights[entry] -= 1;
        self.removed[entry] += 1;
        let mut position = entry + 1;
        while position < self.tree.len() {
            self.tree[position] += 1;
            position += position & position.wrapping_neg();
        }
        self.pending += 1;
        if self.pending >= self.threshold {
            self.snapshot();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_candidates<'a>(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    terrain_writes: u64,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    actor_areas: ActorAreas<'_>,
    object_groups: &[ExactObjectGroup],
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    placed_object_classes: &PlacedObjectClassGrid,
    content: CompatibleContentView<'a>,
    roster: &super::exact_world::ObjectRoster,
    class_filter_master: &ClassFilterMaster<'a>,
    masks: Option<&RequestMask<'a>>,
    rng: &mut RmsRandom,
) -> Result<Vec<usize>, GenerationError> {
    let candidate_window =
        CandidateWindow::for_descriptor(descriptor, player, connection.dimensions);
    if descriptor.minimum_distance_to_map_edge >= connection.dimensions.width
        || descriptor.minimum_distance_to_map_edge >= connection.dimensions.height
    {
        return Ok(Vec::new());
    }
    let reference = |rng: &mut RmsRandom| {
        let mut candidates = Vec::with_capacity(
            (usize::from(
                candidate_window
                    .maximum_x
                    .saturating_sub(candidate_window.minimum_x),
            ) + 1)
                * (usize::from(
                    candidate_window
                        .maximum_y
                        .saturating_sub(candidate_window.minimum_y),
                ) + 1),
        );
        let width = usize::from(connection.dimensions.width);
        for y in candidate_window.minimum_y..=candidate_window.maximum_y {
            for x in candidate_window.minimum_x..=candidate_window.maximum_x {
                let coordinate = MapCoordinate { x, y };
                let index = usize::from(y) * width + usize::from(x);
                let accepted = if descriptor.object_class_filter.is_none() {
                    candidate_availability.is_available(coordinate)
                        && candidate_queue_predicates_match_without_object_class_filter(
                            descriptor,
                            player,
                            coordinate,
                            connection,
                            actor_areas,
                        )
                } else {
                    candidate_matches_resolving_class_filter(
                        descriptor,
                        player,
                        coordinate,
                        runtime_attributes,
                        setup,
                        connection,
                        terrain,
                        terrain_writes,
                        actor_areas,
                        object_groups,
                        candidate_availability,
                        appearance_objects,
                        placed_object_classes,
                        content,
                        class_filter_master,
                        rng,
                        roster,
                    )?
                };
                if accepted {
                    candidates.push(index);
                }
            }
        }
        Ok(candidates)
    };
    candidate_mask::collect_with_masks(
        masks,
        class_filter_master,
        object_groups,
        setup,
        content,
        runtime_attributes,
        rng,
        reference,
    )
}

fn candidate_restriction<'a>(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    content: CompatibleContentView<'a>,
    runtime_attributes: &ObjectRuntimeAttributes,
    owner: u8,
) -> Option<&'a RestrictionDefinition> {
    descriptor_object_identity(descriptor, object_groups)
        .and_then(|object_id| {
            content.object(object_id).and_then(|definition| {
                runtime_attributes.restriction_id(object_id, owner, definition)
            })
        })
        .and_then(|id| content.restriction(id))
}

fn descriptor_object_identity(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
) -> Option<ObjectId> {
    descriptor.object_id.or_else(|| {
        descriptor.object_group_name.as_deref().and_then(|name| {
            object_groups
                .iter()
                .find(|group| group.name == name)
                .and_then(|group| group.entries.first())
                .map(|entry| entry.object_id)
        })
    })
}

fn descriptor_object_definition<'a>(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    content: CompatibleContentView<'a>,
) -> Option<&'a ObjectDefinition> {
    descriptor_object_identity(descriptor, object_groups).and_then(|id| content.object(id))
}

fn descriptor_runtime_object_definition<'a>(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    owner: u8,
) -> Option<&'a ObjectDefinition> {
    descriptor_object_identity(descriptor, object_groups)
        .and_then(|id| runtime_attributes.definition(id, owner, content))
}

fn resolve_class_filter_definition<'a>(
    descriptor: &ExactObjectDescriptor,
    object_groups: &[ExactObjectGroup],
    setup: &ExactSetupState,
    content: CompatibleContentView<'a>,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    rng: &mut RmsRandom,
) -> Result<Option<&'a ObjectDefinition>, GenerationError> {
    let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
    let object_id =
        resolve_object_replacement(source_object_id, 0, setup, content, runtime_attributes, rng)?;
    Ok(runtime_attributes.definition(object_id, 0, content))
}

struct ClassFilterMaster<'a> {
    fixed: Option<Option<&'a ObjectDefinition>>,
    group: Option<GroupMasters<'a>>,
}

struct GroupMasters<'a> {
    by_sample: Vec<(ObjectId, Option<Option<&'a ObjectDefinition>>)>,
}

impl<'a> GroupMasters<'a> {
    fn for_request(
        descriptor: &ExactObjectDescriptor,
        object_groups: &[ExactObjectGroup],
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
    ) -> Option<Self> {
        if descriptor.object_id.is_some() {
            return None;
        }
        let name = descriptor.object_group_name.as_deref()?;
        let group = object_groups.iter().find(|group| group.name == name)?;
        if group.entries.is_empty() {
            return None;
        }
        let by_sample = (0..100)
            .map(|sample| {
                let id =
                    group_entry_for_sample(&group.entries, group.roll_filter, sample).object_id;
                let master = content
                    .object_replacement_rule(id)
                    .is_none()
                    .then(|| runtime_attributes.definition(id, 0, content));
                (id, master)
            })
            .collect();
        Some(Self { by_sample })
    }

    fn resolve(
        &self,
        setup: &ExactSetupState,
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
        rng: &mut RmsRandom,
    ) -> Result<Option<&'a ObjectDefinition>, GenerationError> {
        let mut sample = rng.bounded(100).result as usize;
        if crate::placement_oracle::fault()
            == crate::placement_oracle::AcceleratorFault::GroupMastersShiftSamples
        {
            sample = (sample + 1) % self.by_sample.len();
        }
        let (id, master) = self.by_sample[sample];
        if let Some(master) = master {
            return Ok(master);
        }
        let object_id = resolve_object_replacement(id, 0, setup, content, runtime_attributes, rng)?;
        Ok(runtime_attributes.definition(object_id, 0, content))
    }
}

impl<'a> ClassFilterMaster<'a> {
    fn for_request(
        descriptor: &ExactObjectDescriptor,
        object_groups: &[ExactObjectGroup],
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
    ) -> Self {
        let mut source = descriptor.object_id;
        if source.is_none()
            && crate::placement_oracle::fault()
                == crate::placement_oracle::AcceleratorFault::ClassFilterMasterCachesGroups
        {
            source = descriptor_object_identity(descriptor, object_groups);
        }
        let fixed = source
            .filter(|id| content.object_replacement_rule(*id).is_none())
            .map(|id| runtime_attributes.definition(id, 0, content));
        let group = fixed
            .is_none()
            .then(|| {
                GroupMasters::for_request(descriptor, object_groups, content, runtime_attributes)
            })
            .flatten();
        Self { fixed, group }
    }

    fn resolve(
        &self,
        descriptor: &ExactObjectDescriptor,
        object_groups: &[ExactObjectGroup],
        setup: &ExactSetupState,
        content: CompatibleContentView<'a>,
        runtime_attributes: &'a ObjectRuntimeAttributes,
        rng: &mut RmsRandom,
    ) -> Result<Option<&'a ObjectDefinition>, GenerationError> {
        use crate::placement_oracle::{OracleCheck, PlacementCheckMode};
        let identity = |definition: Option<&ObjectDefinition>| {
            definition.map(|definition| std::ptr::from_ref(definition) as usize)
        };
        let Some(fixed) = self.fixed else {
            let Some(group) = &self.group else {
                return resolve_class_filter_definition(
                    descriptor,
                    object_groups,
                    setup,
                    content,
                    runtime_attributes,
                    rng,
                );
            };
            return match crate::placement_oracle::mode() {
                PlacementCheckMode::Accelerated => {
                    group.resolve(setup, content, runtime_attributes, rng)
                }
                PlacementCheckMode::Reference => resolve_class_filter_definition(
                    descriptor,
                    object_groups,
                    setup,
                    content,
                    runtime_attributes,
                    rng,
                ),
                PlacementCheckMode::Differential => {
                    let mut memo_rng = rng.clone();
                    let memo = group.resolve(setup, content, runtime_attributes, &mut memo_rng);
                    let reference = resolve_class_filter_definition(
                        descriptor,
                        object_groups,
                        setup,
                        content,
                        runtime_attributes,
                        rng,
                    );
                    let outcome = |answer: &Result<Option<&ObjectDefinition>, GenerationError>,
                                   rng: &RmsRandom| {
                        (
                            answer
                                .as_ref()
                                .map(|definition| identity(*definition))
                                .map_err(|error| format!("{error:?}")),
                            rng.state(),
                        )
                    };
                    crate::placement_oracle::compare(
                        OracleCheck::GroupMaster,
                        &outcome(&reference, rng),
                        &outcome(&memo, &memo_rng),
                        || {
                            format!(
                                "group class-filter master of operation {}",
                                descriptor.operation_index
                            )
                        },
                    );
                    reference
                }
            };
        };
        match crate::placement_oracle::mode() {
            PlacementCheckMode::Accelerated => Ok(fixed),
            PlacementCheckMode::Reference => resolve_class_filter_definition(
                descriptor,
                object_groups,
                setup,
                content,
                runtime_attributes,
                rng,
            ),
            PlacementCheckMode::Differential => {
                let reference = resolve_class_filter_definition(
                    descriptor,
                    object_groups,
                    setup,
                    content,
                    runtime_attributes,
                    rng,
                );
                crate::placement_oracle::compare(
                    OracleCheck::ClassFilterMaster,
                    &reference
                        .as_ref()
                        .ok()
                        .map(|definition| identity(*definition)),
                    &Some(identity(fixed)),
                    || {
                        format!(
                            "class-filter master of operation {}",
                            descriptor.operation_index
                        )
                    },
                );
                reference
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn candidate_matches(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    layer_id: &[u16],
    restriction: Option<&RestrictionDefinition>,
    restriction_zones: Option<&[u16]>,
    candidate_definition: Option<&ObjectDefinition>,
    actor_areas: ActorAreas<'_>,
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    content: CompatibleContentView<'_>,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> bool {
    candidate_availability.is_available(coordinate)
        && candidate_predicates_match_with_avoidance(
            descriptor,
            player,
            coordinate,
            land_descriptors,
            connection,
            terrain,
            layer_id,
            restriction,
            restriction_zones,
            candidate_definition,
            actor_areas,
            appearance_objects,
            objects,
            content,
            false,
            roster,
            list_classes,
        )
}

#[allow(clippy::too_many_arguments)]
fn actor_area_queue_candidate_matches(
    descriptor: &ExactObjectDescriptor,
    distance_center: Option<MapCoordinate>,
    coordinate: MapCoordinate,
    connection: &ExactConnectionState,
    candidate_definition: Option<&ObjectDefinition>,
    actor_areas: ActorAreas<'_>,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> bool {
    if descriptor
        .maximum_distance_to_players
        .is_some_and(|radius| {
            radius > 0
                && distance_center.is_some_and(|center| {
                    coordinate.x.abs_diff(center.x) >= radius
                        || coordinate.y.abs_diff(center.y) >= radius
                })
        })
    {
        return false;
    }
    if !actor_area_avoidance_matches(descriptor, coordinate, actor_areas) {
        return false;
    }
    let edge = descriptor.minimum_distance_to_map_edge;
    if edge >= connection.dimensions.width
        || edge >= connection.dimensions.height
        || coordinate.x < edge
        || coordinate.y < edge
        || u32::from(coordinate.x) >= u32::from(connection.dimensions.width) - u32::from(edge)
        || u32::from(coordinate.y) >= u32::from(connection.dimensions.height) - u32::from(edge)
    {
        return false;
    }
    object_class_filter_allows(
        descriptor,
        coordinate,
        candidate_definition,
        appearance_objects,
        objects,
        terrain,
        content,
        roster,
        list_classes,
    )
}

#[allow(clippy::too_many_arguments)]
fn candidate_matches_resolving_class_filter<'a>(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    runtime_attributes: &'a ObjectRuntimeAttributes,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    terrain_writes: u64,
    actor_areas: ActorAreas<'_>,
    object_groups: &[ExactObjectGroup],
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    placed_object_classes: &PlacedObjectClassGrid,
    content: CompatibleContentView<'a>,
    master: &ClassFilterMaster<'a>,
    rng: &mut RmsRandom,
    roster: &super::exact_world::ObjectRoster,
) -> Result<bool, GenerationError> {
    if !candidate_availability.is_available(coordinate) {
        return Ok(false);
    }
    if !candidate_queue_geometry_matches(descriptor, player, coordinate, connection) {
        return Ok(false);
    }
    let filter_definition = master.resolve(
        descriptor,
        object_groups,
        setup,
        content,
        runtime_attributes,
        rng,
    )?;
    let allowed = indexed_object_class_filter_allows(
        descriptor,
        coordinate,
        filter_definition,
        appearance_objects,
        placed_object_classes,
        terrain,
        terrain_writes,
        content,
        roster,
    );
    Ok(allowed && actor_area_constraints(descriptor, player, coordinate, actor_areas))
}

#[allow(clippy::too_many_arguments)]
fn candidate_predicates_match(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    layer_id: &[u16],
    restriction: Option<&RestrictionDefinition>,
    restriction_zones: Option<&[u16]>,
    candidate_definition: Option<&ObjectDefinition>,
    actor_areas: ActorAreas<'_>,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    content: CompatibleContentView<'_>,
    zero_maximum_is_direct_start: bool,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> bool {
    candidate_predicates_match_with_avoidance(
        descriptor,
        player,
        coordinate,
        land_descriptors,
        connection,
        terrain,
        layer_id,
        restriction,
        restriction_zones,
        candidate_definition,
        actor_areas,
        appearance_objects,
        objects,
        content,
        zero_maximum_is_direct_start,
        roster,
        list_classes,
    )
}

#[allow(clippy::too_many_arguments)]
fn candidate_predicates_match_with_avoidance(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    layer_id: &[u16],
    restriction: Option<&RestrictionDefinition>,
    restriction_zones: Option<&[u16]>,
    filter_definition: Option<&ObjectDefinition>,
    actor_areas: ActorAreas<'_>,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    content: CompatibleContentView<'_>,
    zero_maximum_is_direct_start: bool,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> bool {
    candidate_predicates_match_without_object_class_filter(
        descriptor,
        player,
        coordinate,
        land_descriptors,
        connection,
        terrain,
        layer_id,
        restriction,
        restriction_zones,
        actor_areas,
        true,
        zero_maximum_is_direct_start,
    ) && object_class_filter_allows(
        descriptor,
        coordinate,
        filter_definition,
        appearance_objects,
        objects,
        terrain,
        content,
        roster,
        list_classes,
    )
}

#[allow(clippy::too_many_arguments)]
fn candidate_predicates_match_without_object_class_filter(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    layer_id: &[u16],
    restriction: Option<&RestrictionDefinition>,
    restriction_zones: Option<&[u16]>,
    actor_areas: ActorAreas<'_>,
    apply_maximum_player_distance: bool,
    zero_maximum_is_direct_start: bool,
) -> bool {
    let index = usize::from(coordinate.y) * usize::from(connection.dimensions.width)
        + usize::from(coordinate.x);
    let candidate_terrain = terrain[index];
    (!apply_maximum_player_distance
        || candidate_queue_geometry_matches(descriptor, player, coordinate, connection))
        && actor_area_constraints(descriptor, player, coordinate, actor_areas)
        && !descriptor
            .terrain_to_place_on
            .is_some_and(|required| required != candidate_terrain)
        && layer_constraint_matches(descriptor, layer_id[index])
        && (descriptor.ignore_terrain_restrictions
            || anchored_zero_radius_placement(descriptor, player)
            || descriptor
                .maximum_distance_to_other_zones
                .is_some_and(|distance| distance > 0)
                && descriptor.actor_area_to_place_in.is_none()
            || !restriction.is_some_and(|restriction| {
                !route_restriction_allows(
                    restriction,
                    candidate_terrain,
                    player,
                    connection.dimensions,
                    terrain,
                    layer_id,
                )
            }))
        && minimum_distance_constraints(
            descriptor,
            player,
            coordinate,
            land_descriptors,
            connection,
        )
        && (!apply_maximum_player_distance
            || maximum_distance_constraint(
                descriptor,
                player,
                coordinate,
                connection,
                zero_maximum_is_direct_start,
            ))
        && restriction_zone_distance_constraint(
            descriptor,
            coordinate,
            connection.dimensions,
            restriction_zones,
        )
}

#[allow(clippy::too_many_arguments)]
fn candidate_predicates_before_land_zones(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
    terrain: &[TerrainId],
    layer_id: &[u16],
    restriction: Option<&RestrictionDefinition>,
    restriction_zones: Option<&[u16]>,
    apply_maximum_player_distance: bool,
) -> bool {
    let index = usize::from(coordinate.y) * usize::from(connection.dimensions.width)
        + usize::from(coordinate.x);
    !descriptor
        .terrain_to_place_on
        .is_some_and(|required| required != terrain[index])
        && layer_constraint_matches(descriptor, layer_id[index])
        && source_restriction_allows_before_master(
            descriptor,
            player,
            terrain[index],
            restriction,
            connection.dimensions,
            terrain,
            layer_id,
        )
        && (player.is_none()
            || minimum_distance_constraints(
                descriptor,
                player,
                coordinate,
                land_descriptors,
                connection,
            ) && (!apply_maximum_player_distance
                || maximum_distance_constraint(descriptor, player, coordinate, connection, false)))
        && restriction_zone_distance_constraint(
            descriptor,
            coordinate,
            connection.dimensions,
            restriction_zones,
        )
}

fn land_zone_rejection_removal(
    descriptor: &ExactObjectDescriptor,
    center: MapCoordinate,
    coordinate: MapCoordinate,
    dimensions: MapDimensions,
) -> Result<Option<usize>, GenerationError> {
    let distance = descriptor.avoid_other_land_zones_distance;
    if !descriptor.avoid_other_land_zones || distance <= 0 {
        return Ok(None);
    }
    let dx = i32::from(center.x).wrapping_sub(i32::from(coordinate.x));
    let dy = i32::from(center.y).wrapping_sub(i32::from(coordinate.y));
    let squared = dx.wrapping_mul(dx).wrapping_add(dy.wrapping_mul(dy));
    let minimum = i32::from(descriptor.minimum_distance_to_players);
    let minimum = minimum.wrapping_mul(minimum);
    let maximum = descriptor
        .maximum_distance_to_players
        .map_or(i32::MAX, |maximum| {
            i32::from(maximum).wrapping_mul(i32::from(maximum))
        });
    if squared <= distance.wrapping_mul(distance) || squared < minimum || squared > maximum {
        return Ok(None);
    }
    let step = |toward: i32| {
        if toward > 0 {
            distance
        } else {
            distance.wrapping_neg()
        }
    };
    let x = i32::from(coordinate.x).wrapping_add(step(dx));
    let y = i32::from(coordinate.y).wrapping_add(step(dy));
    if !(0..i32::from(dimensions.width)).contains(&x)
        || !(0..i32::from(dimensions.height)).contains(&y)
    {
        return Err(invalid_object(
            "land-zone avoidance moved a queued tile outside the map",
        ));
    }
    Ok(Some(
        y as usize * usize::from(dimensions.width) + x as usize,
    ))
}

fn source_restriction_allows_before_master(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    candidate_terrain: TerrainId,
    restriction: Option<&RestrictionDefinition>,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    layer_id: &[u16],
) -> bool {
    player.is_none()
        || descriptor.ignore_terrain_restrictions
        || anchored_zero_radius_placement(descriptor, player)
        || descriptor
            .maximum_distance_to_other_zones
            .is_some_and(|distance| distance > 0)
            && descriptor.actor_area_to_place_in.is_none()
        || !restriction.is_some_and(|restriction| {
            !route_restriction_allows(
                restriction,
                candidate_terrain,
                player,
                dimensions,
                terrain,
                layer_id,
            )
        })
}

fn route_restriction_allows(
    restriction: &RestrictionDefinition,
    candidate_terrain: TerrainId,
    player: Option<(u8, MapCoordinate)>,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    layer_id: &[u16],
) -> bool {
    if restriction_allows(restriction, candidate_terrain) {
        return true;
    }
    let Some((_, anchor)) = player else {
        return false;
    };
    let index = usize::from(anchor.y) * usize::from(dimensions.width) + usize::from(anchor.x);
    terrain.get(index) == Some(&candidate_terrain)
        || layer_id.get(index).is_some_and(|&layer| {
            layer != u16::MAX && u32::from(layer as u8) == candidate_terrain.0
        })
}

fn layer_constraint_matches(descriptor: &ExactObjectDescriptor, layer_id: u16) -> bool {
    descriptor
        .layer_to_place_on
        .is_none_or(|required| i64::from(layer_id as i16) == i64::from(required.0))
}

#[allow(clippy::too_many_arguments)]
fn candidate_queue_predicates_match_without_object_class_filter(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    connection: &ExactConnectionState,
    actor_areas: ActorAreas<'_>,
) -> bool {
    candidate_queue_geometry_matches(descriptor, player, coordinate, connection)
        && actor_area_constraints(descriptor, player, coordinate, actor_areas)
}

fn candidate_queue_geometry_matches(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    connection: &ExactConnectionState,
) -> bool {
    if descriptor.circular_placement && player.is_some() {
        descriptor.maximum_distance_to_players.is_none_or(|radius| {
            let center = object_placement_center(player, connection.dimensions);
            let dx = u32::from(coordinate.x.abs_diff(center.x));
            let dy = u32::from(coordinate.y.abs_diff(center.y));
            dx * dx + dy * dy <= u32::from(radius) * u32::from(radius)
        })
    } else {
        true
    }
}

fn restriction_zone_labels(
    descriptor: &ExactObjectDescriptor,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    restriction: Option<&RestrictionDefinition>,
    cache: &mut ExactRestrictionZones,
) -> Result<Option<std::sync::Arc<[u16]>>, GenerationError> {
    if !descriptor
        .maximum_distance_to_other_zones
        .is_some_and(|distance| distance > 0)
    {
        return Ok(None);
    }
    restriction
        .map(|restriction| {
            let (allowed, length) = super::exact_zone::permissions(restriction)?;
            cache.lookup(dimensions, terrain, &allowed[..length], false)
        })
        .transpose()
}

fn restriction_zone_distance_constraint(
    descriptor: &ExactObjectDescriptor,
    coordinate: MapCoordinate,
    dimensions: MapDimensions,
    zones: Option<&[u16]>,
) -> bool {
    let Some(distance) = descriptor.maximum_distance_to_other_zones else {
        return true;
    };
    if distance == 0 {
        return true;
    }
    let Some(zones) = zones else {
        return true;
    };

    let diagonal = u32::from(distance) * 10 / 14;
    let cardinal = i32::from(distance);
    let diagonal = i32::try_from(diagonal).unwrap_or(i32::MAX);
    let center = restriction_zone_at_clamped(
        zones,
        dimensions,
        i32::from(coordinate.x),
        i32::from(coordinate.y),
    ) as u8;
    [
        (0, -cardinal),
        (diagonal, -diagonal),
        (cardinal, 0),
        (diagonal, diagonal),
        (0, cardinal),
        (-diagonal, diagonal),
        (-cardinal, 0),
        (-diagonal, -diagonal),
    ]
    .into_iter()
    .all(|(dx, dy)| {
        restriction_zone_at_clamped(
            zones,
            dimensions,
            i32::from(coordinate.x) + dx,
            i32::from(coordinate.y) + dy,
        ) as u8
            == center
    })
}

fn restriction_zone_at_clamped(zones: &[u16], dimensions: MapDimensions, x: i32, y: i32) -> u16 {
    let x = x.clamp(0, i32::from(dimensions.width - 1)) as usize;
    let y = y.clamp(0, i32::from(dimensions.height - 1)) as usize;
    zones[y * usize::from(dimensions.width) + x]
}

fn avoid_other_land_zones_constraint(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    dimensions: MapDimensions,
    land_zones: &[u32],
) -> bool {
    if !descriptor.avoid_other_land_zones {
        return true;
    }
    let Some((_, player_center)) = player else {
        return true;
    };

    let player_zone = land_zone_at_clamped(
        land_zones,
        dimensions,
        i32::from(player_center.x),
        i32::from(player_center.y),
    );
    if land_zone_at_clamped(
        land_zones,
        dimensions,
        i32::from(coordinate.x),
        i32::from(coordinate.y),
    ) != player_zone
    {
        return false;
    }
    let distance = descriptor.avoid_other_land_zones_distance;
    if distance == 0 {
        return true;
    }
    let step = distance.wrapping_add(1);
    [(1_i32, 0_i32), (-1, 0), (0, 1), (0, -1)]
        .into_iter()
        .all(|(dx, dy)| {
            let x = i32::from(coordinate.x).wrapping_add(dx.wrapping_mul(step));
            let y = i32::from(coordinate.y).wrapping_add(dy.wrapping_mul(step));
            land_zone_at_clamped(land_zones, dimensions, x, y) == player_zone
        })
}

fn land_zone_at_clamped(land_zones: &[u32], dimensions: MapDimensions, x: i32, y: i32) -> u8 {
    let x = x.clamp(0, i32::from(dimensions.width - 1)) as usize;
    let y = y.clamp(0, i32::from(dimensions.height - 1)) as usize;
    land_zones[y * usize::from(dimensions.width) + x] as u8
}

fn consumption_applies_maximum_player_distance(actor_area_route: bool) -> bool {
    !actor_area_route || actor_area_distance_rule_disabled_for_attribution()
}

#[cfg(any(test, feature = "placement-oracle"))]
fn actor_area_distance_rule_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_ACTOR_AREA_DISTANCE_RULE").is_some()
}

#[cfg(not(any(test, feature = "placement-oracle")))]
fn actor_area_distance_rule_disabled_for_attribution() -> bool {
    false
}

fn minimum_distance_constraints(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    land_descriptors: &[ExactLandDescriptor],
    connection: &ExactConnectionState,
) -> bool {
    let edge = coordinate
        .x
        .min(coordinate.y)
        .min(connection.dimensions.width - 1 - coordinate.x)
        .min(connection.dimensions.height - 1 - coordinate.y);
    if edge < descriptor.minimum_distance_to_map_edge {
        return false;
    }
    let below_minimum = |position: MapCoordinate| {
        let dx = coordinate.x.abs_diff(position.x);
        let dy = coordinate.y.abs_diff(position.y);
        if descriptor.circular_placement {
            u32::from(dx) * u32::from(dx) + u32::from(dy) * u32::from(dy)
                < u32::from(descriptor.minimum_distance_to_players)
                    * u32::from(descriptor.minimum_distance_to_players)
        } else {
            dx.max(dy) < descriptor.minimum_distance_to_players
        }
    };
    for position in land_descriptors
        .iter()
        .filter(|land| {
            !descriptor.player_distance_command || land.assigned_slot.is_some_and(|slot| slot != 0)
        })
        .map(|land| land.position)
    {
        if below_minimum(position) {
            return false;
        }
    }
    if !descriptor.circular_placement && player.is_some_and(|(_, center)| below_minimum(center)) {
        return false;
    }
    true
}

fn maximum_distance_constraint(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    connection: &ExactConnectionState,
    zero_maximum_is_direct_start: bool,
) -> bool {
    if let Some(maximum) = descriptor.maximum_distance_to_players {
        if maximum == 0 && player.is_none() && !zero_maximum_is_direct_start {
            return false;
        }
        let center = object_placement_center(player, connection.dimensions);
        let dx = coordinate.x.abs_diff(center.x);
        let dy = coordinate.y.abs_diff(center.y);
        let above_maximum = if descriptor.circular_placement {
            u32::from(dx) * u32::from(dx) + u32::from(dy) * u32::from(dy)
                > u32::from(maximum) * u32::from(maximum)
        } else {
            dx.max(dy) > maximum
        };
        if above_maximum {
            return false;
        }
    }
    true
}

fn object_placement_center(
    player: Option<(u8, MapCoordinate)>,
    dimensions: MapDimensions,
) -> MapCoordinate {
    player.map_or(
        MapCoordinate {
            x: dimensions.width / 2,
            y: dimensions.height / 2,
        },
        |(_, center)| center,
    )
}

fn direct_zero_radius_anchor(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    dimensions: MapDimensions,
    object_groups: &[ExactObjectGroup],
    content: CompatibleContentView<'_>,
) -> Option<MapCoordinate> {
    (descriptor.maximum_distance_to_players == Some(0)
        && descriptor_object_definition(descriptor, object_groups, content)
            .is_some_and(is_zero_sized_non_obstructing))
    .then(|| object_placement_center(player, dimensions))
}

fn anchored_zero_radius_placement(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
) -> bool {
    player.is_some() && descriptor.maximum_distance_to_players == Some(0)
}

fn outer_master_ignores_terrain_restrictions(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
) -> bool {
    player.is_some() && descriptor.ignore_terrain_restrictions
}

fn member_master_ignores_terrain_restrictions(descriptor: &ExactObjectDescriptor) -> bool {
    descriptor.ignore_terrain_restrictions
}

fn actor_area_queue_route(
    descriptor: &ExactObjectDescriptor,
    actor_areas: &ActorAreaState,
) -> bool {
    descriptor
        .actor_area_to_place_in
        .is_some_and(|id| id != 0 || actor_areas.record_index(id).is_some())
}

fn actor_area_queue_snapshot(
    actor_areas: &ActorAreaState,
    logical_count_at_queue_build: usize,
) -> ActorAreas<'_> {
    debug_assert!(logical_count_at_queue_build <= actor_areas.logical.len());
    ActorAreas::indexed(
        &actor_areas.logical[..logical_count_at_queue_build],
        &actor_areas.index,
    )
}

fn actor_area_contains(area: &ExactActorArea, coordinate: MapCoordinate) -> bool {
    let within = |tile: u16, center: i32| {
        let tile = i32::from(tile);
        center.wrapping_sub(area.radius) <= tile && tile <= center.wrapping_add(area.radius)
    };
    within(coordinate.x, area.center.x) && within(coordinate.y, area.center.y)
}

fn actor_area_constraints<'a>(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    coordinate: MapCoordinate,
    areas: impl Into<ActorAreas<'a>>,
) -> bool {
    let areas = areas.into();
    if let Some(id) = descriptor.actor_area_to_place_in
        && !areas.decide(coordinate, |candidates| {
            candidates.with_id(id).any(|area| {
                area.id == id
                    && (player.is_none()
                        || area.player_slot.is_none()
                        || area.player_slot == player.map(|value| value.0))
                    && actor_area_contains(area, coordinate)
            })
        })
    {
        return false;
    }
    actor_area_avoidance_matches(descriptor, coordinate, areas)
}

fn actor_area_avoidance_matches(
    descriptor: &ExactObjectDescriptor,
    coordinate: MapCoordinate,
    areas: ActorAreas<'_>,
) -> bool {
    if descriptor.avoid_actor_areas.is_empty() && !descriptor.avoid_all_actor_areas {
        return true;
    }
    areas.decide(coordinate, |candidates| {
        let avoided =
            |area: &ExactActorArea, id: i32| area.id == id && actor_area_contains(area, coordinate);
        if let Some(mut witness) = candidates.containing_any_id(&descriptor.avoid_actor_areas) {
            if witness.any(|area| {
                descriptor
                    .avoid_actor_areas
                    .iter()
                    .any(|id| avoided(area, *id))
            }) {
                return false;
            }
        } else if descriptor.avoid_actor_areas.iter().any(|id| {
            candidates
                .containing_with_id(*id)
                .any(|area| avoided(area, *id))
        }) {
            return false;
        }
        if descriptor.avoid_all_actor_areas
            && candidates
                .iter()
                .any(|area| actor_area_contains(area, coordinate))
        {
            return false;
        }
        true
    })
}

fn register_actor_area(
    descriptor: &ExactObjectDescriptor,
    player: Option<(u8, MapCoordinate)>,
    center: MapCoordinate,
    dimensions: MapDimensions,
    actor_areas: &mut ActorAreaState,
) -> Result<(), GenerationError> {
    let Some(id) = descriptor.actor_area else {
        return Ok(());
    };
    if id <= 0 {
        return Ok(());
    }
    if actor_areas.logical.len() >= MAXIMUM_GENERATED_ACTOR_AREAS {
        return Err(object_limit(
            "generated actor areas",
            MAXIMUM_GENERATED_ACTOR_AREAS,
        ));
    }
    actor_areas.register(
        ExactActorArea {
            id,
            center: center.into(),
            radius: i32::from(descriptor.actor_area_radius),
            player_slot: descriptor
                .place_for_every_player
                .then(|| player.map(|value| value.0))
                .flatten(),
            operation_index: descriptor.operation_index,
        },
        dimensions,
    )
}

#[allow(clippy::too_many_arguments)]
fn object_class_filter_allows(
    descriptor: &ExactObjectDescriptor,
    coordinate: MapCoordinate,
    candidate_definition: Option<&ObjectDefinition>,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> bool {
    if roster.has_destroyed() {
        return live_object_class_filter_allows(
            descriptor,
            coordinate,
            candidate_definition,
            roster,
            content,
            None,
        );
    }
    let Some(filter) = &descriptor.object_class_filter else {
        return true;
    };
    let Some(definition) = candidate_definition else {
        return false;
    };
    let Some(list_classes) = list_classes else {
        return list_object_class_filter_allows(
            filter,
            coordinate,
            definition,
            appearance_objects,
            objects,
            terrain,
            content,
            None,
        );
    };
    placement_index::decide(
        crate::placement_oracle::OracleCheck::ListClassFilter,
        |accelerated| {
            list_object_class_filter_allows(
                filter,
                coordinate,
                definition,
                appearance_objects,
                objects,
                terrain,
                content,
                accelerated.then_some(list_classes),
            )
        },
        || {
            format!(
                "list class filter at {coordinate:?}, {} objects",
                objects.len()
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn list_object_class_filter_allows(
    filter: &ExactObjectClassFilter,
    coordinate: MapCoordinate,
    definition: &ObjectDefinition,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    accelerated: Option<&ListClassIndex>,
) -> bool {
    let mut content_complete = true;
    let any_match = filter.constraints.iter().any(|constraint| {
        let (negative_extent, positive_extent) =
            object_class_filter_extents(definition, constraint.radius);
        if appearance_class_in_window(
            appearance_objects,
            coordinate,
            [negative_extent, positive_extent],
            constraint.class_id,
            terrain,
            content,
            accelerated.map(|index| &index.appearances),
            None,
        ) {
            return true;
        }
        let visits = accelerated.and_then(|index| {
            index.visits(
                objects,
                content,
                appearance_objects.dimensions,
                constraint.class_id,
                coordinate,
                [negative_extent, positive_extent],
            )
        });
        for index in VisitOrder::of(
            visits.as_ref().map(|visits| visits.indices()),
            objects.len(),
        ) {
            let object = &objects[index];
            let Some(existing) = content.object(object.object_id) else {
                content_complete = false;
                return false;
            };
            if existing.class_id != constraint.class_id {
                continue;
            }
            let object_x = object.x_256 / 256;
            let object_y = object.y_256 / 256;
            let candidate_x = u32::from(coordinate.x);
            let candidate_y = u32::from(coordinate.y);
            let x_matches = if object_x <= candidate_x {
                candidate_x - object_x <= negative_extent
            } else {
                object_x - candidate_x <= positive_extent
            };
            let y_matches = if object_y <= candidate_y {
                candidate_y - object_y <= negative_extent
            } else {
                object_y - candidate_y <= positive_extent
            };
            if x_matches && y_matches {
                return true;
            }
        }
        false
    });
    content_complete
        && match filter.mode {
            ExactObjectClassFilterMode::Require => any_match,
            ExactObjectClassFilterMode::Exclude => !any_match,
        }
}

#[allow(clippy::too_many_arguments)]
fn appearance_class_in_window(
    appearance_objects: &TerrainAppearanceObjects,
    coordinate: MapCoordinate,
    [negative_extent, positive_extent]: [u32; 2],
    class_id: u32,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    index: Option<&AppearanceClassIndex>,
    terrain_writes: Option<u64>,
) -> bool {
    let route = |index: Option<&AppearanceClassIndex>| {
        appearance_objects.any_of_class_in_window(
            coordinate,
            negative_extent,
            positive_extent,
            class_id,
            terrain,
            content,
            index,
            terrain_writes,
        )
    };
    match index {
        None => route(None),
        Some(index) => placement_index::decide(
            crate::placement_oracle::OracleCheck::AppearanceWindow,
            |accelerated| route(accelerated.then_some(index)),
            || format!("appearance class {class_id} window at {coordinate:?}"),
        ),
    }
}

fn object_class_filter_extents(definition: &ObjectDefinition, avoidance_radius: u16) -> (u32, u32) {
    let half_extent = definition.collision_half_extents()[0];
    let whole_half_tiles = half_extent as u32;
    let has_fractional_half_tile = half_extent > whole_half_tiles as f32;
    let radius = u32::from(avoidance_radius);
    let negative_extent = radius.saturating_add(whole_half_tiles);
    let positive_extent =
        radius
            .max(whole_half_tiles)
            .saturating_add(if has_fractional_half_tile {
                whole_half_tiles
            } else {
                0
            });
    (negative_extent, positive_extent)
}

#[allow(clippy::too_many_arguments)]
fn indexed_object_class_filter_allows(
    descriptor: &ExactObjectDescriptor,
    coordinate: MapCoordinate,
    candidate_definition: Option<&ObjectDefinition>,
    appearance_objects: &TerrainAppearanceObjects,
    placed_object_classes: &PlacedObjectClassGrid,
    terrain: &[TerrainId],
    terrain_writes: u64,
    content: CompatibleContentView<'_>,
    roster: &super::exact_world::ObjectRoster,
) -> bool {
    if roster.has_destroyed() {
        return placement_index::decide(
            crate::placement_oracle::OracleCheck::ClassFilter,
            |accelerated| {
                live_object_class_filter_allows(
                    descriptor,
                    coordinate,
                    candidate_definition,
                    roster,
                    content,
                    accelerated.then_some(placed_object_classes),
                )
            },
            || format!("live class filter at {coordinate:?}"),
        );
    }
    let Some(filter) = &descriptor.object_class_filter else {
        return true;
    };
    let Some(definition) = candidate_definition else {
        return false;
    };
    let any_match = filter.constraints.iter().any(|constraint| {
        let (negative_extent, positive_extent) =
            object_class_filter_extents(definition, constraint.radius);
        appearance_class_in_window(
            appearance_objects,
            coordinate,
            [negative_extent, positive_extent],
            constraint.class_id,
            terrain,
            content,
            Some(&placed_object_classes.appearances),
            Some(terrain_writes),
        ) || placement_index::decide(
            crate::placement_oracle::OracleCheck::PlacedClassWindow,
            |accelerated| {
                if accelerated {
                    placed_object_classes.any_in_window_sums(
                        constraint.class_id,
                        coordinate,
                        negative_extent,
                        positive_extent,
                    )
                } else {
                    placed_object_classes.any_in_window(
                        constraint.class_id,
                        coordinate,
                        negative_extent,
                        positive_extent,
                    )
                }
            },
            || {
                format!(
                    "placed class {} window at {coordinate:?}",
                    constraint.class_id
                )
            },
        )
    });
    match filter.mode {
        ExactObjectClassFilterMode::Require => any_match,
        ExactObjectClassFilterMode::Exclude => !any_match,
    }
}

fn live_object_class_filter_allows(
    descriptor: &ExactObjectDescriptor,
    coordinate: MapCoordinate,
    definition: Option<&ObjectDefinition>,
    roster: &super::exact_world::ObjectRoster,
    content: CompatibleContentView<'_>,
    accelerated: Option<&PlacedObjectClassGrid>,
) -> bool {
    let Some(filter) = &descriptor.object_class_filter else {
        return true;
    };
    let Some(definition) = definition else {
        return false;
    };
    let Some(dimensions) = roster.dimensions() else {
        return false;
    };
    let mut live = accelerated.and_then(|grid| {
        grid.live
            .synchronized(grid.tiles_by_class.keys().copied(), roster, content)
    });
    let mut complete = true;
    let found = filter.constraints.iter().any(|constraint| {
        let (negative, positive) = object_class_filter_extents(definition, constraint.radius);
        let min_x = u32::from(coordinate.x).saturating_sub(negative);
        let min_y = u32::from(coordinate.y).saturating_sub(negative);
        let max_x = u32::from(coordinate.x)
            .saturating_add(positive)
            .min(u32::from(dimensions.width - 1));
        let max_y = u32::from(coordinate.y)
            .saturating_add(positive)
            .min(u32::from(dimensions.height - 1));
        if let Some(found) = live.as_mut().and_then(|live| {
            live.any_in_window(constraint.class_id, [min_x, min_y], [max_x, max_y])
        }) {
            return found;
        }
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                for identity in roster.members(MapCoordinate {
                    x: x as u16,
                    y: y as u16,
                }) {
                    let Some(object) = roster.object(*identity) else {
                        complete = false;
                        return false;
                    };
                    let Some(master) = content.object(object.object_id) else {
                        complete = false;
                        return false;
                    };
                    if master.class_id == constraint.class_id {
                        return true;
                    }
                }
            }
        }
        false
    });
    complete
        && match filter.mode {
            ExactObjectClassFilterMode::Require => found,
            ExactObjectClassFilterMode::Exclude => !found,
        }
}

struct PlacedObjectClassGrid {
    dimensions: MapDimensions,
    tiles_by_class: std::collections::BTreeMap<u32, Vec<bool>>,
    sums: std::collections::BTreeMap<u32, std::cell::RefCell<WindowSums>>,
    live: LiveClassIndex,
    appearances: AppearanceClassIndex,
    bits_by_class: std::collections::BTreeMap<u32, (u64, TileBits)>,
    window_masks: std::cell::RefCell<Vec<CachedWindowMask>>,
}

struct CachedWindowMask {
    key: (bool, u32, u32, u32),
    versions: (u64, u64),
    mask: std::rc::Rc<TileBits>,
}

const CACHED_WINDOW_MASKS: usize = 64;

impl PlacedObjectClassGrid {
    fn new(
        dimensions: MapDimensions,
        descriptors: &[ExactObjectDescriptor],
    ) -> Result<Self, GenerationError> {
        let tile_count = dimensions.tile_count()?;
        let mut tiles_by_class = std::collections::BTreeMap::new();
        for descriptor in descriptors {
            if let Some(filter) = &descriptor.object_class_filter {
                for constraint in &filter.constraints {
                    tiles_by_class
                        .entry(constraint.class_id)
                        .or_insert_with(|| vec![false; tile_count]);
                }
            }
        }
        Ok(Self::from_planes(dimensions, tiles_by_class))
    }

    fn register(
        &mut self,
        objects: &[PlacedObject],
        object_offset: usize,
        construction_positions: &BTreeMap<usize, [u32; 2]>,
        content: CompatibleContentView<'_>,
        runtime_attributes: &ObjectRuntimeAttributes,
    ) -> Result<(), GenerationError> {
        let width = usize::from(self.dimensions.width);
        let height = u32::from(self.dimensions.height);
        for (ordinal, object) in objects.iter().enumerate() {
            let definition = runtime_attributes
                .definition(object.object_id, object.owner, content)
                .ok_or_else(|| {
                    invalid_object("placed object is missing from the active content pack")
                })?;
            let Some(tiles) = self.tiles_by_class.get_mut(&definition.class_id) else {
                continue;
            };
            let position = construction_positions
                .get(&(object_offset + ordinal))
                .map(|bits| bits.map(f32::from_bits));
            let x = position.map_or(object.x_256 / 256, |value| value[0] as u32);
            let y = position.map_or(object.y_256 / 256, |value| value[1] as u32);
            if x >= u32::from(self.dimensions.width) || y >= height {
                return Err(invalid_object("a placed object lies outside the map"));
            }
            let tile = &mut tiles[y as usize * width + x as usize];
            if !*tile {
                *tile = true;
                if let Some(sums) = self.sums.get(&definition.class_id) {
                    sums.borrow_mut().invalidate();
                }
                if let Some((version, bits)) = self.bits_by_class.get_mut(&definition.class_id) {
                    bits.set(y as usize * width + x as usize, true);
                    *version = candidate_mask::fresh_version();
                }
            }
        }
        Ok(())
    }

    fn from_planes(
        dimensions: MapDimensions,
        tiles_by_class: std::collections::BTreeMap<u32, Vec<bool>>,
    ) -> Self {
        let sums = tiles_by_class
            .keys()
            .map(|class_id| {
                (
                    *class_id,
                    std::cell::RefCell::new(WindowSums::new(
                        usize::from(dimensions.width),
                        usize::from(dimensions.height),
                    )),
                )
            })
            .collect();
        let (width, height) = (
            usize::from(dimensions.width),
            usize::from(dimensions.height),
        );
        let bits_by_class = tiles_by_class
            .iter()
            .map(|(class_id, tiles)| {
                (
                    *class_id,
                    (
                        candidate_mask::fresh_version(),
                        TileBits::from_fn(width, height, |tile| tiles[tile]),
                    ),
                )
            })
            .collect();
        Self {
            dimensions,
            tiles_by_class,
            sums,
            live: LiveClassIndex::default(),
            appearances: AppearanceClassIndex::default(),
            bits_by_class,
            window_masks: std::cell::RefCell::new(Vec::new()),
        }
    }

    fn class_window_mask(
        &self,
        class_id: u32,
        (negative, positive): (u32, u32),
        inputs: &ClassInputs<'_>,
    ) -> Option<std::rc::Rc<TileBits>> {
        let live_route = inputs.roster.has_destroyed();
        let key = (live_route, class_id, negative, positive);
        let cacheable = crate::placement_oracle::fault()
            != crate::placement_oracle::AcceleratorFault::ClassMaskShrinksWindow;
        let lookup = |versions: (u64, u64)| {
            self.window_masks
                .borrow()
                .iter()
                .find(|cached| cacheable && cached.key == key && cached.versions == versions)
                .map(|cached| cached.mask.clone())
        };
        let (versions, mask) = if live_route {
            let live = self.live.synchronized(
                self.tiles_by_class.keys().copied(),
                inputs.roster,
                inputs.content,
            )?;
            let (version, presence) = live.presence(class_id)?;
            let versions = (version, 0);
            if let Some(mask) = lookup(versions) {
                return Some(mask);
            }
            (versions, presence.dilated(negative, positive))
        } else {
            let terrain = inputs.terrain;
            let (appearance_version, appearances) = self.appearances.presence(
                inputs.appearance_objects,
                class_id,
                |appearance, tile| {
                    appearance_matches(
                        appearance,
                        tile,
                        &|definition: &ObjectDefinition| definition.class_id == class_id,
                        terrain,
                        inputs.content,
                    )
                },
                inputs.content,
                TerrainVersion::of(terrain, inputs.terrain_writes),
            )?;
            if !appearances.has_shape(self.dimensions) {
                return None;
            }
            let placed = self.bits_by_class.get(&class_id);
            let versions = (
                placed.map_or(0, |(version, _)| *version),
                appearance_version,
            );
            if let Some(mask) = lookup(versions) {
                return Some(mask);
            }
            let mut presence = (*appearances).clone();
            if let Some((_, bits)) = placed {
                presence.or_assign(bits);
            }
            (versions, presence.dilated(negative, positive))
        };
        let mask = std::rc::Rc::new(mask);
        if !cacheable {
            return Some(mask);
        }
        let mut cached = self.window_masks.borrow_mut();
        if let Some(entry) = cached.iter_mut().find(|cached| cached.key == key) {
            entry.versions = versions;
            entry.mask = mask.clone();
        } else {
            if cached.len() >= CACHED_WINDOW_MASKS {
                cached.remove(0);
            }
            cached.push(CachedWindowMask {
                key,
                versions,
                mask: mask.clone(),
            });
        }
        Some(mask)
    }

    fn any_in_window_sums(
        &self,
        class_id: u32,
        coordinate: MapCoordinate,
        negative_extent: u32,
        positive_extent: u32,
    ) -> bool {
        let (Some(tiles), Some(sums)) =
            (self.tiles_by_class.get(&class_id), self.sums.get(&class_id))
        else {
            return false;
        };
        let maximum_x = u32::from(self.dimensions.width.saturating_sub(1));
        let maximum_y = u32::from(self.dimensions.height.saturating_sub(1));
        let minimum_x = u32::from(coordinate.x).saturating_sub(negative_extent);
        let minimum_y = u32::from(coordinate.y).saturating_sub(negative_extent);
        let maximum_x = u32::from(coordinate.x)
            .saturating_add(positive_extent)
            .min(maximum_x);
        let maximum_y = u32::from(coordinate.y)
            .saturating_add(positive_extent)
            .min(maximum_y);
        sums.borrow_mut().any(
            [minimum_x as usize, minimum_y as usize],
            [maximum_x as usize, maximum_y as usize],
            |tile| u32::from(tiles[tile]),
        )
    }

    fn any_in_window(
        &self,
        class_id: u32,
        coordinate: MapCoordinate,
        negative_extent: u32,
        positive_extent: u32,
    ) -> bool {
        let Some(tiles) = self.tiles_by_class.get(&class_id) else {
            return false;
        };
        let width = usize::from(self.dimensions.width);
        let maximum_x = u32::from(self.dimensions.width.saturating_sub(1));
        let maximum_y = u32::from(self.dimensions.height.saturating_sub(1));
        let minimum_x = u32::from(coordinate.x).saturating_sub(negative_extent);
        let minimum_y = u32::from(coordinate.y).saturating_sub(negative_extent);
        let maximum_x = u32::from(coordinate.x)
            .saturating_add(positive_extent)
            .min(maximum_x);
        let maximum_y = u32::from(coordinate.y)
            .saturating_add(positive_extent)
            .min(maximum_y);
        (minimum_y..=maximum_y).any(|y| {
            let row = y as usize * width;
            (minimum_x..=maximum_x).any(|x| tiles[row + x as usize])
        })
    }
}

struct CandidateAvailability {
    dimensions: MapDimensions,
    tiles: Vec<bool>,
    bits: TileBits,
}

impl CandidateAvailability {
    fn new(dimensions: MapDimensions, tile_count: usize) -> Self {
        let width = usize::from(dimensions.width);
        let height = usize::from(dimensions.height);
        let bits = if width * height == tile_count {
            TileBits::from_fn(width, height, |_| true)
        } else {
            TileBits::new(0, 0)
        };
        Self {
            dimensions,
            tiles: vec![true; tile_count],
            bits,
        }
    }

    fn is_available(&self, coordinate: MapCoordinate) -> bool {
        self.tiles[usize::from(coordinate.y) * usize::from(self.dimensions.width)
            + usize::from(coordinate.x)]
    }

    fn set_tile(&mut self, index: usize, available: bool) {
        self.tiles[index] = available;
        if self.bits.has_shape(self.dimensions) {
            self.bits.set(index, available);
        }
    }

    fn consume_tile(&mut self, coordinate: MapCoordinate) {
        self.set_tile(
            usize::from(coordinate.y) * usize::from(self.dimensions.width)
                + usize::from(coordinate.x),
            false,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn invalidate_for_anchor(
        &mut self,
        anchor: MapCoordinate,
        radius: u16,
        object_id: Option<ObjectId>,
        terrain: &[TerrainId],
        content: CompatibleContentView<'_>,
        runtime_attributes: &ObjectRuntimeAttributes,
    ) {
        if radius == 0 {
            return;
        }
        let Some(restriction) = object_id
            .and_then(|id| runtime_attributes.invalidation_restriction_id(id, content))
            .and_then(|id| content.restriction(id))
        else {
            return;
        };
        let minimum_x = anchor.x.saturating_sub(radius);
        let maximum_x = anchor
            .x
            .saturating_add(radius)
            .min(self.dimensions.width.saturating_sub(1));
        let minimum_y = anchor.y.saturating_sub(radius);
        let maximum_y = anchor
            .y
            .saturating_add(radius)
            .min(self.dimensions.height.saturating_sub(1));
        let width = usize::from(self.dimensions.width);
        for y in minimum_y..=maximum_y {
            for x in minimum_x..=maximum_x {
                let index = usize::from(y) * width + usize::from(x);
                if restriction_allows(restriction, terrain[index]) {
                    self.set_tile(index, false);
                }
            }
        }
    }
}

fn restriction_allows(restriction: &RestrictionDefinition, terrain: TerrainId) -> bool {
    restriction
        .allowed_terrain_ids
        .binary_search(&terrain)
        .is_ok()
        && restriction
            .blocked_terrain_ids
            .binary_search(&terrain)
            .is_err()
}

mod candidate_mask;
mod candidate_queue;
mod player_starts;
use candidate_mask::{ClassInputs, RequestMask, TileBits};
use candidate_queue::*;
pub(super) use player_starts::finalize_player_starts;

mod appearance_lifecycle;
use appearance_lifecycle::*;

mod placement_index;
pub(super) use appearance_lifecycle::{
    appearance_candidate_allows, appearance_candidate_allows_in_world, appearance_position,
    write_appearance, write_legacy_appearance,
};
use placement_index::{
    ActorAreaIndex, ActorAreas, AppearanceAdmission, AppearanceClassIndex,
    AppearanceObstructionIndex, LifecycleProjection, ListClassIndex, LiveClassIndex,
    ObstructionIndex, RosterOrder, TerrainVersion, VisitOrder, WindowSums,
};

fn object_elevation_256(
    position: [f32; 2],
    dimensions: MapDimensions,
    elevation: &[i16],
) -> Result<i32, GenerationError> {
    super::exact_elevation::terrain_height_from_f32(position[0], position[1], dimensions, elevation)
        .ok_or_else(|| invalid_object("object elevation lookup lies outside map"))
}

fn apply_gaia_master_graphic_replacements(
    objects: &mut [PlacedObject],
    gaia_civilization: CivilizationId,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    if gaia_civilization == CivilizationId(0) {
        return Ok(());
    }
    for object in objects.iter_mut().filter(|object| object.owner == 0) {
        let definition = content
            .object(object.object_id)
            .ok_or_else(|| missing_object_definition(object.object_id))?;
        match definition.graphic_replacement_facet_for(gaia_civilization) {
            Some(ObjectGraphicReplacementFacet::ResetZero) => object.facet = 0,
            Some(ObjectGraphicReplacementFacet::Preserve) | None => {}
        }
    }
    Ok(())
}

type ExactObjectProgram = (
    CivilizationId,
    Vec<ExactActorArea>,
    Vec<ExactObjectGroup>,
    Vec<ExactObjectDescriptor>,
);

fn object_stage_runtime_attributes(
    zones: &ExactRestrictionZones,
    facets: &[(ObjectId, u8)],
) -> std::sync::Arc<ObjectRuntimeAttributes> {
    let mut attributes = zones.runtime_attributes();
    if !facets.is_empty() {
        std::sync::Arc::make_mut(&mut attributes)
            .gaia_preset_facets
            .extend(facets.iter().copied());
    }
    attributes
}

mod attributes;
mod farm_completion;
use attributes::AttributeMutation;
pub(super) use attributes::ObjectRuntimeAttributes;
use attributes::{
    PlayerResourceWrite, ResourceRuleSwitch, resource_rule_disabled, truncate_f32_to_i32,
};

mod program;
pub(super) use program::collect_runtime_object_attributes;
use program::*;

#[derive(Clone, Copy)]
struct TightCandidate {
    coordinate: MapCoordinate,
    score: u32,
}

struct TightCandidates {
    queue: Vec<TightCandidate>,
    minimum_x: u16,
    maximum_x: u16,
    minimum_y: u16,
    maximum_y: u16,
}

impl TightCandidates {
    fn new(anchor: MapCoordinate, radius: u16, dimensions: MapDimensions) -> Self {
        Self {
            queue: vec![TightCandidate {
                coordinate: anchor,
                score: 0,
            }],
            minimum_x: anchor.x.saturating_sub(radius),
            maximum_x: anchor.x.saturating_add(radius).min(dimensions.width - 1),
            minimum_y: anchor.y.saturating_sub(radius),
            maximum_y: anchor.y.saturating_add(radius).min(dimensions.height - 1),
        }
    }

    fn pop_front(&mut self) -> Option<MapCoordinate> {
        if self.queue.is_empty() {
            return None;
        }
        let candidate = self.queue.remove(0);
        Some(candidate.coordinate)
    }

    fn expand_from(
        &mut self,
        coordinate: MapCoordinate,
        rng: &mut RmsRandom,
        mut candidate_is_placeable: impl FnMut(MapCoordinate) -> Result<bool, GenerationError>,
        mut parent_queue: Option<&mut CandidateQueue>,
    ) -> Result<Vec<MapCoordinate>, GenerationError> {
        let mut linked = Vec::new();
        let mut neighbors = [None; 4];
        if coordinate.x > self.minimum_x {
            neighbors[0] = Some(MapCoordinate {
                x: coordinate.x - 1,
                y: coordinate.y,
            });
        }
        if coordinate.x < self.maximum_x {
            neighbors[1] = Some(MapCoordinate {
                x: coordinate.x + 1,
                y: coordinate.y,
            });
        }
        if coordinate.y > self.minimum_y {
            neighbors[2] = Some(MapCoordinate {
                x: coordinate.x,
                y: coordinate.y - 1,
            });
        }
        if coordinate.y < self.maximum_y {
            neighbors[3] = Some(MapCoordinate {
                x: coordinate.x,
                y: coordinate.y + 1,
            });
        }
        for neighbor in neighbors.into_iter().flatten() {
            if !candidate_is_placeable(neighbor)? {
                continue;
            }
            if let Some(parent_queue) = parent_queue.as_deref_mut() {
                debug_assert!(self.maximum_x < parent_queue.dimensions.width);
                debug_assert!(self.maximum_y < parent_queue.dimensions.height);
                let index = usize::from(neighbor.y) * usize::from(parent_queue.dimensions.width)
                    + usize::from(neighbor.x);
                parent_queue.remove(index);
            }
            linked.push(neighbor);
            let score = rng.next_u32() & 0x7fff;
            if let Some(existing) = self
                .queue
                .iter()
                .position(|entry| entry.coordinate == neighbor)
            {
                self.queue.remove(existing);
            }
            let insertion = self
                .queue
                .iter()
                .position(|entry| entry.score >= score)
                .unwrap_or(self.queue.len());
            self.queue.insert(
                insertion,
                TightCandidate {
                    coordinate: neighbor,
                    score,
                },
            );
        }
        Ok(linked)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MasterTerrainRejection {
    OutsideMap,
    RequiredTerrain,
    TerrainRestriction,
}

fn master_terrain_allows_coordinate(
    coordinate: MapCoordinate,
    definition: &ObjectDefinition,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    ignore_restriction: bool,
    effective_restriction: Option<RestrictionId>,
) -> bool {
    master_terrain_rejection(
        coordinate,
        definition,
        dimensions,
        terrain,
        content,
        ignore_restriction,
        effective_restriction,
    )
    .is_none()
}

fn master_terrain_rejection(
    coordinate: MapCoordinate,
    definition: &ObjectDefinition,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    ignore_restriction: bool,
    effective_restriction: Option<RestrictionId>,
) -> Option<MasterTerrainRejection> {
    let collision = definition.collision_half_extents();
    let center_x =
        f32::from(coordinate.x) + object_axis_center_offset_256(collision[0]) as f32 / 256.0;
    let center_y =
        f32::from(coordinate.y) + object_axis_center_offset_256(collision[1]) as f32 / 256.0;
    master_terrain_rejection_at_position(
        [center_x, center_y],
        definition,
        dimensions,
        terrain,
        content,
        ignore_restriction,
        effective_restriction,
    )
}

fn master_terrain_rejection_at_position(
    [center_x, center_y]: [f32; 2],
    definition: &ObjectDefinition,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    ignore_restriction: bool,
    effective_restriction: Option<RestrictionId>,
) -> Option<MasterTerrainRejection> {
    if !center_x.is_finite() || !center_y.is_finite() {
        return Some(MasterTerrainRejection::OutsideMap);
    }
    let placement = definition.placement_half_extents();
    let lower_x = center_x - placement[0];
    let lower_y = center_y - placement[1];
    let upper_x = (placement[0] + center_x) - 0.001_f32;
    let upper_y = (placement[1] + center_y) - 0.001_f32;
    if lower_x < 0.0 || lower_y < 0.0 {
        return Some(MasterTerrainRejection::OutsideMap);
    }
    if upper_x >= f32::from(dimensions.width) || upper_y >= f32::from(dimensions.height) {
        return Some(MasterTerrainRejection::OutsideMap);
    }
    let minimum_x = lower_x as i64;
    let minimum_y = lower_y as i64;
    let maximum_x = upper_x as i64;
    let maximum_y = upper_y as i64;

    let width = usize::from(dimensions.width);
    let terrain_at = |x: i64, y: i64| {
        if x < 0 || y < 0 || x >= i64::from(dimensions.width) || y >= i64::from(dimensions.height) {
            return None;
        }
        terrain.get(y as usize * width + x as usize).copied()
    };

    let center_terrain_ids = &definition.placement_center_terrain_ids;
    if !center_terrain_ids.is_empty() {
        let Some(actual) = terrain_at(center_x as i64, center_y as i64) else {
            return Some(MasterTerrainRejection::RequiredTerrain);
        };
        if !placement_center_terrain_matches(center_terrain_ids, actual, content) {
            return Some(MasterTerrainRejection::RequiredTerrain);
        }
    }

    let side_terrain_ids = &definition.placement_side_terrain_ids;
    let (side_minimum_x, side_minimum_y, side_maximum_x, side_maximum_y) =
        if center_terrain_ids.is_empty() {
            (minimum_x, minimum_y, maximum_x, maximum_y)
        } else {
            let x = center_x as i64;
            let y = center_y as i64;
            (x, y, x, y)
        };
    let matches = |x, y| {
        terrain_at(x, y)
            .is_some_and(|actual| placement_side_terrain_matches(side_terrain_ids, actual, content))
    };
    if !side_terrain_ids.is_empty()
        && !(side_minimum_x..=side_maximum_x).any(|x| matches(x, side_minimum_y - 1))
        && !(side_minimum_y..=side_maximum_y).any(|y| matches(side_maximum_x + 1, y))
        && !(side_minimum_x..=side_maximum_x).any(|x| matches(x, side_maximum_y + 1))
        && !(side_minimum_y..=side_maximum_y).any(|y| matches(side_minimum_x - 1, y))
    {
        return Some(MasterTerrainRejection::RequiredTerrain);
    }

    if !ignore_restriction && let Some(restriction_id) = effective_restriction {
        let Some(restriction) = content.restriction(restriction_id) else {
            return Some(MasterTerrainRejection::TerrainRestriction);
        };
        if !(minimum_y..=maximum_y).all(|y| {
            (minimum_x..=maximum_x).all(|x| {
                terrain_at(x, y).is_some_and(|terrain_id| {
                    super::exact_zone::rejects_placement(restriction, terrain_id)
                        .is_some_and(|rejected| !rejected)
                })
            })
        }) {
            return Some(MasterTerrainRejection::TerrainRestriction);
        }
    }
    None
}

pub(super) fn topology_placement_rejects(
    object: super::exact_world::WorldObject,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    elevation: &[i16],
    content: CompatibleContentView<'_>,
    attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    let definition = attributes
        .definition(object.object_id, object.owner, content)
        .ok_or_else(|| missing_object_definition(object.object_id))?;
    let rules = definition
        .placement_rules_for(
            attributes
                .owner_civilizations
                .get(usize::from(object.owner))
                .copied()
                .flatten(),
        )
        .ok_or_else(|| invalid_object("topology placement rules are unavailable"))?;
    let count = dimensions.tile_count()?;
    if terrain.len() != count || elevation.len() != count {
        return Err(invalid_object("topology placement map is incomplete"));
    }
    let position = object.position_bits.map(f32::from_bits);
    if master_terrain_rejection_at_position(
        position, definition, dimensions, terrain, content, true, None,
    )
    .is_some()
    {
        return Ok(true);
    }
    let extents = definition.placement_half_extents();
    let lower = [position[0] - extents[0], position[1] - extents[1]].map(|v| v as i64);
    let upper = [
        (position[0] + extents[0]) - 0.001_f32,
        (position[1] + extents[1]) - 0.001_f32,
    ]
    .map(|v| v as i64);
    let width = usize::from(dimensions.width);
    let index = |x: i64, y: i64| y as usize * width + x as usize;
    let restriction = attributes
        .master_restriction_id(object.object_id, object.owner, definition)
        .and_then(|id| content.restriction(id));
    for x in lower[0]..=upper[0] {
        for y in lower[1]..=upper[1] {
            let tile = index(x, y);
            let rejected = restriction
                .and_then(|r| super::exact_zone::rejects_placement(r, terrain[tile]))
                .ok_or_else(|| {
                    invalid_object("numeric topology restriction input is unavailable")
                })?;
            if rejected {
                return Ok(true);
            }
            let slope_rejected = match rules.slope_mode {
                1 | 2 => {
                    let shape = super::exact_elevation::terrain_shape_code(
                        tile,
                        elevation,
                        width,
                        usize::from(dimensions.height),
                    )
                    .ok_or_else(|| invalid_object("topology slope shape is unavailable"))?;
                    shape != 0 && (rules.slope_mode == 2 || !(5..=8).contains(&shape))
                }
                3 if x == lower[0] || y == upper[1] => {
                    let reference = i32::from(elevation[index(lower[0], upper[1])]);
                    !(reference - 1..=reference + 1).contains(&i32::from(elevation[tile]))
                }
                _ => false,
            };
            if slope_rejected {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn placement_center_terrain_matches(
    configured: &[TerrainId],
    actual: TerrainId,
    content: CompatibleContentView<'_>,
) -> bool {
    if configured.contains(&actual) {
        return true;
    }
    let Some(actual_class) = content
        .terrain(actual)
        .map(|terrain| terrain.placement_class)
    else {
        return false;
    };
    configured.iter().any(|terrain_id| {
        content.terrain(*terrain_id).is_some_and(|terrain| {
            let configured_class = terrain.placement_class;
            (configured_class & 0x04 != 0 && actual_class & 0x04 != 0)
                || (configured_class & 0x08 != 0 && actual_class & 0x08 != 0)
        })
    })
}

fn placement_side_terrain_matches(
    configured: &[TerrainId],
    actual: TerrainId,
    content: CompatibleContentView<'_>,
) -> bool {
    if configured.contains(&actual) {
        return true;
    }
    let Some(actual_class) = content
        .terrain(actual)
        .map(|terrain| terrain.placement_class)
    else {
        return false;
    };
    configured.iter().any(|terrain_id| {
        content.terrain(*terrain_id).is_some_and(|terrain| {
            let configured_class = terrain.placement_class;
            (configured_class & 0x40 != 0 && actual_class & 0x40 != 0)
                || (configured_class & 0x10 != 0 && actual_class & 0x10 != 0)
        })
    })
}

fn master_slope_allows_coordinate(
    coordinate: MapCoordinate,
    definition: &ObjectDefinition,
    owner: u8,
    dimensions: MapDimensions,
    elevation: &[i16],
    runtime_attributes: &ObjectRuntimeAttributes,
) -> bool {
    let collision = definition.collision_half_extents();
    let position = [
        f32::from(coordinate.x) + object_axis_center_offset_256(collision[0]) as f32 / 256.0,
        f32::from(coordinate.y) + object_axis_center_offset_256(collision[1]) as f32 / 256.0,
    ];
    master_slope_allows_position(
        position,
        definition,
        owner,
        dimensions,
        elevation,
        runtime_attributes,
    )
}

fn master_slope_allows_position(
    [center_x, center_y]: [f32; 2],
    definition: &ObjectDefinition,
    owner: u8,
    dimensions: MapDimensions,
    elevation: &[i16],
    runtime_attributes: &ObjectRuntimeAttributes,
) -> bool {
    let civilization = runtime_attributes
        .owner_civilizations
        .get(usize::from(owner))
        .copied()
        .flatten();
    let slope_mode = definition
        .placement_rules_for(civilization)
        .map_or(0, |rules| rules.slope_mode);
    if slope_mode == 0 {
        return true;
    }

    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    if elevation.len() != width * height {
        return false;
    }
    let placement = definition.placement_half_extents();
    let lower_x = center_x - placement[0];
    let lower_y = center_y - placement[1];
    let upper_x = (placement[0] + center_x) - 0.001_f32;
    let upper_y = (placement[1] + center_y) - 0.001_f32;
    if lower_x < 0.0
        || lower_y < 0.0
        || upper_x >= f32::from(dimensions.width)
        || upper_y >= f32::from(dimensions.height)
    {
        return false;
    }
    let minimum_x = lower_x as usize;
    let minimum_y = lower_y as usize;
    let maximum_x = upper_x as usize;
    let maximum_y = upper_y as usize;
    let index = |x: usize, y: usize| y * width + x;
    let reference = i32::from(elevation[index(minimum_x, maximum_y)]);

    for x in minimum_x..=maximum_x {
        for y in minimum_y..=maximum_y {
            let tile = index(x, y);
            let rejected = match slope_mode {
                1 | 2 => {
                    let Some(shape) =
                        super::exact_elevation::terrain_shape_code(tile, elevation, width, height)
                    else {
                        return false;
                    };
                    shape != 0 && (slope_mode == 2 || !(5..=8).contains(&shape))
                }
                3 if x == minimum_x || y == maximum_y => {
                    !(reference - 1..=reference + 1).contains(&i32::from(elevation[tile]))
                }
                _ => false,
            };
            if rejected {
                return false;
            }
        }
    }
    true
}

#[derive(Clone, Copy)]
struct Class39PlacementContext<'a> {
    setup: &'a ExactSetupState,
    roster: &'a super::exact_world::ObjectRoster,
    master_restriction: Option<RestrictionId>,
}

fn owners_have_pathing_relationship(setup: &ExactSetupState, left: u8, right: u8) -> bool {
    let player = |owner| {
        (owner == 0).then_some(0).or_else(|| {
            setup
                .players
                .iter()
                .find(|player| player.slot == owner)
                .map(|player| player.team)
        })
    };
    let (Some(left_team), Some(right_team)) = (player(left), player(right)) else {
        return false;
    };
    left == right || (left_team != 0 && left_team == right_team)
}

fn class39_pathing_exempts_object(
    tile: MapCoordinate,
    candidate_owner: u8,
    context: Class39PlacementContext<'_>,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<bool, GenerationError> {
    let restriction_id = context.master_restriction.ok_or_else(|| {
        GenerationError::InvalidContent(
            "class-39 placement candidate has no effective restriction".to_owned(),
        )
    })?;
    let restriction = content.restriction(restriction_id).ok_or_else(|| {
        GenerationError::InvalidContent(format!(
            "class-39 placement restriction {} is unavailable",
            restriction_id.0
        ))
    })?;
    let mask = restriction.placement_pathing_mask_i32.ok_or_else(|| {
        GenerationError::InvalidContent(format!(
            "restriction {} lacks its class-39 placement pathing mask",
            restriction_id.0
        ))
    })? as i64 as u64;
    let (word, source_identity) = context.roster.placement_pathing_word(tile)?;
    if word & mask == 0 {
        return Ok(true);
    }
    if word & 0x3f00 != 0x500 {
        return Ok(false);
    }
    let word_owner = ((word >> 16) & 0x7f) as u8;
    if !owners_have_pathing_relationship(context.setup, candidate_owner, word_owner) {
        return Ok(false);
    }
    let source_identity = source_identity
        .ok_or_else(|| invalid_object("kind-five pathing word has no source identity"))?;
    let source = context
        .roster
        .object(source_identity)
        .ok_or_else(|| invalid_object("pathing word source is absent from the live roster"))?;
    let gate_class = native_generation_bindings(content)?.classes.gate;
    for &identity in context.roster.members(source.tile) {
        let member = context
            .roster
            .object(identity)
            .ok_or_else(|| invalid_object("class-39 tile member is absent from the live roster"))?;
        let definition = runtime_attributes
            .definition(member.object_id, member.owner, content)
            .ok_or_else(|| missing_object_definition(member.object_id))?;
        if definition.class_id != gate_class {
            continue;
        }
        let gate = definition.class39_pathing_gate.ok_or_else(|| {
            GenerationError::InvalidContent(format!(
                "class-39 object {} lacks its live pathing predicate",
                definition.id.0
            ))
        })?;
        if member.lifecycle > 2 || !gate {
            return Ok(false);
        }
        return Ok(owners_have_pathing_relationship(
            context.setup,
            candidate_owner,
            member.owner,
        ));
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
fn master_obstruction_allows_coordinate_with_positions(
    coordinate: MapCoordinate,
    definition: &ObjectDefinition,
    owner: u8,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    construction_positions: &BTreeMap<usize, [u32; 2]>,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    class39_context: Option<Class39PlacementContext<'_>>,
    obstruction_index: Option<&ObstructionIndex>,
) -> Result<bool, GenerationError> {
    let collision = definition.collision_half_extents();
    let position = [
        f32::from(coordinate.x) + object_axis_center_offset_256(collision[0]) as f32 / 256.0,
        f32::from(coordinate.y) + object_axis_center_offset_256(collision[1]) as f32 / 256.0,
    ];
    master_obstruction_allows_position_with_positions(
        position,
        definition,
        owner,
        appearance_objects,
        objects,
        construction_positions,
        terrain,
        content,
        runtime_attributes,
        class39_context,
        obstruction_index,
    )
}

#[allow(clippy::too_many_arguments)]
fn master_obstruction_allows_position_with_positions(
    candidate_center: [f32; 2],
    definition: &ObjectDefinition,
    owner: u8,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    construction_positions: &BTreeMap<usize, [u32; 2]>,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    class39_context: Option<Class39PlacementContext<'_>>,
    obstruction_index: Option<&ObstructionIndex>,
) -> Result<bool, GenerationError> {
    let route = if class39_context.is_some_and(|context| context.roster.has_destroyed()) {
        crate::placement_oracle::OracleCheck::RosterObstruction
    } else {
        crate::placement_oracle::OracleCheck::Obstruction
    };
    placement_index::decide_obstruction(
        route,
        obstruction_index,
        |subset| {
            master_obstruction_scan(
                candidate_center,
                definition,
                owner,
                appearance_objects,
                objects,
                construction_positions,
                terrain,
                content,
                runtime_attributes,
                class39_context,
                ObstructionCallMode::Rms,
                subset,
            )
        },
        || {
            format!(
                "candidate master {} owner {owner} at {candidate_center:?}, {} placed objects",
                definition.id.0,
                objects.len()
            )
        },
    )
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ObstructionCallMode {
    Rms,
    FallbackStart,
}

#[allow(clippy::too_many_arguments)]
fn master_obstruction_scan(
    [candidate_center_x, candidate_center_y]: [f32; 2],
    definition: &ObjectDefinition,
    owner: u8,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    construction_positions: &BTreeMap<usize, [u32; 2]>,
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    class39_context: Option<Class39PlacementContext<'_>>,
    call_mode: ObstructionCallMode,
    subset: Option<&ObstructionIndex>,
) -> Result<bool, GenerationError> {
    let mut live_definition = runtime_attributes.scan_definition_lookup(content);
    let classes = native_generation_bindings(content)?.classes;
    let placement = definition.placement_half_extents();
    let civilization = runtime_attributes
        .owner_civilizations
        .get(usize::from(owner))
        .copied()
        .flatten();
    let occupancy_extension = definition
        .placement_rules_for(civilization)
        .is_some_and(|rules| rules.family == ObjectPlacementFamily::Occupancy);
    let collision_extension = definition.placement_collision != ObjectPlacementCollision::None
        && !(occupancy_extension && call_mode == ObstructionCallMode::FallbackStart)
        && definition
            .pathing
            .is_none_or(|pathing| pathing.vertical_extent() > 0.0)
        && placement.iter().any(|extent| *extent > 0.0);
    if !collision_extension && !occupancy_extension {
        return Ok(true);
    }
    let overlaps = |existing_center_x: f32,
                    existing_center_y: f32,
                    existing: &ObjectDefinition,
                    birth_id: ObjectId,
                    existing_owner: u8,
                    lifecycle: u8,
                    path_exempt: bool,
                    resource: Option<rms_content::ObjectResourceState>,
                    live_identity: Option<u32>|
     -> Result<bool, GenerationError> {
        if existing.can_be_built_on {
            return Ok(false);
        }
        let existing_extents = existing.collision_half_extents();
        if existing_extents[0] <= 0.0
            || existing_extents[1] <= 0.0
            || (existing_center_x - candidate_center_x).abs() >= placement[0] + existing_extents[0]
            || (existing_center_y - candidate_center_y).abs() >= placement[1] + existing_extents[1]
        {
            return Ok(false);
        }
        let existing_has_vertical_extent = existing
            .pathing
            .is_none_or(|pathing| pathing.vertical_extent() > 0.0);
        let tree_over_farm =
            definition.class_id == classes.tree && existing.class_id == classes.farm;
        let base_collision = !path_exempt
            && collision_extension
            && existing.placement_collision != ObjectPlacementCollision::None
            && (existing_has_vertical_extent || tree_over_farm);
        if base_collision {
            return Ok(true);
        }
        let foreign_unrevealed = existing_owner != owner
            && (owner == 0 || call_mode == ObstructionCallMode::FallbackStart);
        if !occupancy_extension || foreign_unrevealed {
            return Ok(false);
        }
        let occupancy_height = existing_has_vertical_extent
            || existing.position_family == Some(ObjectPositionFamily::Building)
            || {
                let resource = resource.or_else(|| {
                    live_identity.and_then(|identity| {
                        objects
                            .binary_search_by_key(&identity, |object| object.instance_id)
                            .ok()
                            .map(|index| rms_content::ObjectResourceState {
                                resource_type: objects[index].resource_type,
                                quantity_f32_bits: objects[index].resource_quantity_f32_bits,
                            })
                    })
                });
                let resource = match resource {
                    Some(resource) => resource,
                    None => {
                        runtime_attributes.initial_resources(existing, existing_owner, content)?
                    }
                };
                matches!(resource.resource_type, 0..=3 | 15..=17)
                    && f32::from_bits(resource.quantity_f32_bits) > 0.0
            };
        if !occupancy_height {
            return Ok(false);
        }
        let birth_definition = content
            .object(birth_id)
            .ok_or_else(|| missing_object_definition(birth_id))?;
        Ok(!occupancy_exempts_moving_instance(
            definition,
            existing,
            birth_definition,
            owner,
            existing_owner,
            lifecycle,
            class39_context.map(|context| context.setup),
            runtime_attributes.movement_speed_bits(birth_id, existing_owner, content),
        )?)
    };

    if let Some(context) = class39_context.filter(|context| context.roster.has_destroyed()) {
        let visits = subset.and_then(|index| {
            index.roster_visits(
                [candidate_center_x, candidate_center_y],
                placement,
                placement_index::RosterWorld {
                    roster: context.roster,
                    gate_class: classes.gate,
                    content,
                    runtime_attributes,
                },
            )
        });
        let members = match &visits {
            Some(visits) => {
                RosterOrder::Tiles(context.roster.registered_objects_on(visits.tiles()))
            }
            None => RosterOrder::All(context.roster.registered_objects()),
        };
        for (identity, live) in members {
            let existing = live_definition(live.object_id, live.owner)
                .ok_or_else(|| missing_object_definition(live.object_id))?;
            let path_exempt = collision_extension
                && existing.class_id == classes.gate
                && class39_pathing_exempts_object(
                    live.tile,
                    owner,
                    context,
                    content,
                    runtime_attributes,
                )?;
            let [x, y] = live.position_bits.map(f32::from_bits);
            if overlaps(
                x,
                y,
                existing,
                live.object_id,
                live.owner,
                live.lifecycle,
                path_exempt,
                None,
                Some(identity),
            )? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    let visits = subset.and_then(|index| {
        index.visits(
            [candidate_center_x, candidate_center_y],
            placement,
            placement_index::ObstructionWorld {
                objects,
                construction_positions,
                appearance_objects,
                gate_class: classes.gate,
                content,
                runtime_attributes,
            },
        )
    });
    for index in VisitOrder::of(
        visits.as_ref().map(|visits| visits.objects()),
        objects.len(),
    ) {
        let object = &objects[index];
        let Some(existing) = live_definition(object.object_id, object.owner) else {
            return Ok(false);
        };
        let path_exempt = if collision_extension
            && existing.class_id == classes.gate
            && let Some(context) = class39_context
        {
            let live = context
                .roster
                .object(object.instance_id)
                .ok_or(GenerationError::IncompatibleContent)?;
            class39_pathing_exempts_object(live.tile, owner, context, content, runtime_attributes)?
        } else {
            false
        };
        let position = construction_positions.get(&index).map_or(
            [object.x_256 as f32 / 256.0, object.y_256 as f32 / 256.0],
            |bits| bits.map(f32::from_bits),
        );
        if overlaps(
            position[0],
            position[1],
            existing,
            object.object_id,
            object.owner,
            object.death_state as u8,
            path_exempt,
            Some(rms_content::ObjectResourceState {
                resource_type: object.resource_type,
                quantity_f32_bits: object.resource_quantity_f32_bits,
            }),
            None,
        )? {
            return Ok(false);
        }
    }
    let module_entry_count = appearance_objects.module_entry_objects.len();
    for index in VisitOrder::of(
        visits.as_ref().map(|visits| visits.appearances()),
        module_entry_count + appearance_objects.objects.len(),
    ) {
        let appearance = if index < module_entry_count {
            &appearance_objects.module_entry_objects[index]
        } else {
            &appearance_objects.objects[index - module_entry_count]
        };
        let Ok(tile_index) = usize::try_from(appearance.tile_index) else {
            return Ok(false);
        };
        if terrain.get(tile_index) != Some(&appearance.source_terrain_id) {
            continue;
        }
        let Some(existing) = live_definition(appearance.object_id, 0) else {
            return Ok(false);
        };
        let width = u32::from(appearance_objects.dimensions.width);
        let tile_x = appearance.tile_index % width;
        let tile_y = appearance.tile_index / width;
        let path_exempt = if collision_extension
            && existing.class_id == classes.gate
            && let Some(context) = class39_context
        {
            class39_pathing_exempts_object(
                MapCoordinate {
                    x: tile_x as u16,
                    y: tile_y as u16,
                },
                owner,
                context,
                content,
                runtime_attributes,
            )?
        } else {
            false
        };
        let existing_extents = existing.collision_half_extents();
        let existing_center_x =
            tile_x as f32 + object_axis_center_offset_256(existing_extents[0]) as f32 / 256.0;
        let existing_center_y =
            tile_y as f32 + object_axis_center_offset_256(existing_extents[1]) as f32 / 256.0;
        if overlaps(
            existing_center_x,
            existing_center_y,
            existing,
            appearance.object_id,
            0,
            existing.initial_lifecycle_state,
            path_exempt,
            None,
            None,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn occupancy_exempts_moving_instance(
    candidate: &ObjectDefinition,
    existing: &ObjectDefinition,
    birth_definition: &ObjectDefinition,
    owner: u8,
    existing_owner: u8,
    lifecycle: u8,
    setup: Option<&ExactSetupState>,
    movement_speed_f32_bits: Option<u32>,
) -> Result<bool, GenerationError> {
    let uses_speed = birth_definition
        .occupancy_uses_movement_speed
        .ok_or_else(|| {
            GenerationError::InvalidContent(format!(
                "object {} lacks occupancy speed eligibility",
                birth_definition.id.0,
            ))
        })?;
    if !uses_speed {
        return Ok(false);
    }
    let speed = movement_speed_f32_bits.ok_or_else(|| {
        GenerationError::InvalidContent(format!(
            "object {} lacks its occupancy movement speed",
            existing.id.0,
        ))
    })?;
    if f32::from_bits(speed) <= 0.0 {
        return Ok(false);
    }
    let action = candidate
        .pathing
        .ok_or_else(|| {
            GenerationError::InvalidContent(format!(
                "object {} lacks its occupancy action",
                candidate.id.0,
            ))
        })?
        .action;
    Ok(matches!(action, 0 | 12)
        || lifecycle == 2
            && (existing_owner == 0
                || owner == existing_owner
                || setup.is_some_and(|setup| {
                    owners_have_pathing_relationship(setup, owner, existing_owner)
                })))
}

fn collision_footprints_overlap(
    first_position: [f32; 2],
    first_half_extents: [f32; 2],
    second_position: [f32; 2],
    second_half_extents: [f32; 2],
) -> bool {
    (first_position[0] - second_position[0]).abs() < first_half_extents[0] + second_half_extents[0]
        && (first_position[1] - second_position[1]).abs()
            < first_half_extents[1] + second_half_extents[1]
}

#[allow(clippy::too_many_arguments)]
fn retire_construction_overlaps_on_terrain(
    constructed: &PlacedObject,
    constructed_position: [f32; 2],
    existing_objects: &mut [PlacedObject],
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    roster: &mut super::exact_world::ObjectRoster,
    terrain: Option<&[TerrainId]>,
    generation_program_mode: NativeGenerationProgramMode,
    projection: &mut LifecycleProjection,
) -> Result<(), GenerationError> {
    let constructed_definition = runtime_attributes
        .definition(constructed.object_id, constructed.owner, content)
        .ok_or_else(|| missing_object_definition(constructed.object_id))?;
    let Some(dimensions) = roster.dimensions() else {
        return if existing_objects.is_empty() {
            Ok(())
        } else {
            Err(invalid_object("construction cleanup world is absent"))
        };
    };
    let bounds = construction_cleanup_bounds(constructed_position, dimensions);
    let classes = native_generation_bindings(content)?.classes;
    let destructive = generation_program_mode == NativeGenerationProgramMode::ExplicitMaximumSeed;
    for y in bounds[1].clone() {
        for x in bounds[0].clone() {
            let tile = MapCoordinate {
                x: x as u16,
                y: y as u16,
            };
            let mut ordinal = 0;
            while ordinal < roster.members(tile).len() {
                let identity = roster.members(tile)[ordinal];
                let existing = roster
                    .object(identity)
                    .ok_or_else(|| invalid_object("construction cleanup identity is not live"))?;
                let definition = runtime_attributes
                    .definition(existing.object_id, existing.owner, content)
                    .ok_or_else(|| missing_object_definition(existing.object_id))?;
                if (destructive || construction_retirement_height_allows(definition))
                    && construction_cleanup_matches(
                        existing.object_id,
                        existing.owner,
                        definition,
                        constructed.object_id,
                        constructed.owner,
                        constructed_definition,
                        f32::from_bits(existing.hit_points_f32_bits),
                        classes,
                    )
                    && collision_footprints_overlap(
                        existing.position_bits.map(f32::from_bits),
                        definition.collision_half_extents(),
                        constructed_position,
                        constructed_definition.collision_half_extents(),
                    )
                {
                    if destructive {
                        destroy_world_object_on_terrain(
                            roster,
                            identity,
                            content,
                            runtime_attributes,
                            true,
                            terrain,
                        )?;
                        continue;
                    }
                    roster.finish_overlap_cleanup_on_terrain(
                        identity,
                        definition.pathing,
                        definition.collision_half_extents(),
                        terrain,
                    )?;
                }
                ordinal += 1;
            }
        }
    }
    project_construction_lifecycle(existing_objects, roster, projection)
}

fn project_all_construction_lifecycles(
    existing_objects: &mut [PlacedObject],
    roster: &super::exact_world::ObjectRoster,
) -> Result<(), GenerationError> {
    if roster.has_destroyed() {
        for object in existing_objects
            .iter_mut()
            .filter(|object| !roster.was_destroyed(object.instance_id))
        {
            synchronize_lifecycle(std::slice::from_mut(object), roster)?;
        }
    } else {
        synchronize_lifecycle(existing_objects, roster)?;
    }
    Ok(())
}

fn project_construction_lifecycle(
    existing_objects: &mut [PlacedObject],
    roster: &super::exact_world::ObjectRoster,
    projection: &mut LifecycleProjection,
) -> Result<(), GenerationError> {
    fn projections(objects: &[PlacedObject]) -> Vec<(i32, i8)> {
        objects
            .iter()
            .map(|object| (object.status, object.death_state))
            .collect()
    }
    match crate::placement_oracle::mode() {
        crate::placement_oracle::PlacementCheckMode::Accelerated => {
            if projection.project(existing_objects, roster) {
                return Ok(());
            }
            projection.reset();
            project_all_construction_lifecycles(existing_objects, roster)
        }
        crate::placement_oracle::PlacementCheckMode::Reference => {
            project_all_construction_lifecycles(existing_objects, roster)
        }
        crate::placement_oracle::PlacementCheckMode::Differential => {
            let before = projections(existing_objects);
            let accelerated = projection
                .project(existing_objects, roster)
                .then(|| projections(existing_objects));
            if accelerated.is_none() {
                projection.reset();
            }
            for (object, (status, death_state)) in existing_objects.iter_mut().zip(before) {
                object.status = status;
                object.death_state = death_state;
            }
            let result = project_all_construction_lifecycles(existing_objects, roster);
            let reference = (result.is_ok(), projections(existing_objects));
            crate::placement_oracle::compare(
                crate::placement_oracle::OracleCheck::LifecycleProjection,
                &reference,
                &accelerated.map_or_else(|| reference.clone(), |values| (true, values)),
                || format!("{} objects", existing_objects.len()),
            );
            result
        }
    }
}

pub(super) fn destroy_world_object_on_terrain(
    roster: &mut super::exact_world::ObjectRoster,
    identity: u32,
    content: CompatibleContentView<'_>,
    attributes: &ObjectRuntimeAttributes,
    tile_owned: bool,
    terrain: Option<&[TerrainId]>,
) -> Result<(), GenerationError> {
    let object = roster
        .object(identity)
        .ok_or_else(|| invalid_object("destroyed world identity is absent"))?;
    let definition = attributes
        .definition(object.object_id, object.owner, content)
        .ok_or_else(|| missing_object_definition(object.object_id))?;
    if let Some(terrain) = terrain {
        roster.destroy_on_terrain(
            identity,
            definition.pathing,
            definition.collision_half_extents(),
            tile_owned,
            terrain,
        )
    } else if tile_owned {
        roster.destroy_with_pathing(
            identity,
            definition.pathing,
            definition.collision_half_extents(),
        )
    } else {
        roster.destroy_from_object_with_pathing(
            identity,
            definition.pathing,
            definition.collision_half_extents(),
        )
    }
}

fn synchronize_lifecycle(
    objects: &mut [PlacedObject],
    roster: &super::exact_world::ObjectRoster,
) -> Result<(), GenerationError> {
    for object in objects {
        let live = roster
            .object(object.instance_id)
            .ok_or_else(|| invalid_object("lifecycle projection identity is not live"))?;
        if live.object_id != object.object_id || live.owner != object.owner {
            return Err(invalid_object(
                "lifecycle projection master or owner differs",
            ));
        }
        object.status = i32::from(live.lifecycle);
        object.death_state = i8::from_ne_bytes([live.lifecycle]);
    }
    Ok(())
}

fn construction_cleanup_bounds(
    position: [f32; 2],
    dimensions: MapDimensions,
) -> [std::ops::RangeInclusive<i16>; 2] {
    [
        (position[0], dimensions.width),
        (position[1], dimensions.height),
    ]
    .map(|(center, extent)| {
        ((center - 4.0) as i32 as i16).max(0)
            ..=((center + 4.0) as i32 as i16).min(extent as i16 - 1)
    })
}

fn construction_retirement_height_allows(definition: &ObjectDefinition) -> bool {
    !definition.construction_retirement_requires_height
        || definition
            .pathing
            .is_some_and(|pathing| pathing.vertical_extent() > 0.0)
}

#[allow(clippy::too_many_arguments)]
fn construction_cleanup_matches(
    object_id: ObjectId,
    owner: u8,
    definition: &ObjectDefinition,
    constructed_object_id: ObjectId,
    constructed_owner: u8,
    constructed_definition: &ObjectDefinition,
    current_hit_points: f32,
    classes: NativeClassBindings,
) -> bool {
    if object_id == constructed_object_id
        || !constructed_definition
            .collision_half_extents()
            .into_iter()
            .any(|extent| extent > 0.0)
    {
        return false;
    }
    definition.can_be_built_on
        || (owner == constructed_owner
            && (constructed_definition.class_id == classes.gate
                || constructed_definition.class_id == classes.tower)
            && definition.class_id == classes.wall)
        || (definition.class_id == classes.tree && current_hit_points <= 1.0)
}

#[allow(clippy::too_many_arguments)]
fn local_group_queue(
    anchor: MapCoordinate,
    descriptor: &ExactObjectDescriptor,
    owner: u8,
    setup: &ExactSetupState,
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    object_groups: &[ExactObjectGroup],
    player: Option<(u8, MapCoordinate)>,
    actor_areas: ActorAreas<'_>,
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    terrain: &[TerrainId],
    rng: &mut RmsRandom,
    cancellation: &dyn CancellationToken,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> Result<(u32, CandidateQueue, Option<ObjectId>), GenerationError> {
    let dimensions = connection.dimensions;
    let edge = descriptor.minimum_distance_to_map_edge;
    let maximum_x = dimensions.width.saturating_sub(edge.saturating_add(1));
    let maximum_y = dimensions.height.saturating_sub(edge.saturating_add(1));
    let window = CandidateWindow {
        minimum_x: anchor
            .x
            .saturating_sub(descriptor.group_placement_radius)
            .max(edge),
        maximum_x: anchor
            .x
            .saturating_add(descriptor.group_placement_radius)
            .min(maximum_x),
        minimum_y: anchor
            .y
            .saturating_sub(descriptor.group_placement_radius)
            .max(edge),
        maximum_y: anchor
            .y
            .saturating_add(descriptor.group_placement_radius)
            .min(maximum_y),
    };
    let mut candidates = Vec::new();
    let radius_squared = u32::from(descriptor.group_placement_radius).pow(2);
    for y in window.minimum_y..=window.maximum_y {
        for x in window.minimum_x..=window.maximum_x {
            let coordinate = MapCoordinate { x, y };
            if !local_group_queue_candidate_matches(
                coordinate,
                anchor,
                radius_squared,
                descriptor,
                runtime_attributes,
                setup,
                content,
                object_groups,
                player,
                actor_areas,
                candidate_availability,
                appearance_objects,
                objects,
                terrain,
                rng,
                roster,
                list_classes,
            )? {
                continue;
            }
            candidates.push(usize::from(y) * usize::from(dimensions.width) + usize::from(x));
        }
    }
    let (queue, _) = CandidateQueue::new_with_shuffle_predicate(
        dimensions,
        window,
        candidates,
        false,
        true,
        rng,
        cancellation,
        |_, coordinate, rng| {
            let accepted = local_group_queue_candidate_matches(
                coordinate,
                anchor,
                radius_squared,
                descriptor,
                runtime_attributes,
                setup,
                content,
                object_groups,
                player,
                actor_areas,
                candidate_availability,
                appearance_objects,
                objects,
                terrain,
                rng,
                roster,
                list_classes,
            )?;
            Ok(accepted)
        },
    )?;
    let (count, local_master) = resolve_local_group_master_and_count(
        descriptor,
        owner,
        setup,
        content,
        runtime_attributes,
        object_groups,
        rng,
    )?;
    Ok((count, queue, Some(local_master)))
}

fn resolve_local_group_master_and_count(
    descriptor: &ExactObjectDescriptor,
    owner: u8,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
    object_groups: &[ExactObjectGroup],
    rng: &mut RmsRandom,
) -> Result<(u32, ObjectId), GenerationError> {
    let source_object_id = descriptor_object_id(descriptor, object_groups, rng)?;
    let local_master = if descriptor.object_id.is_some() {
        resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            runtime_attributes,
            rng,
        )?
    } else {
        source_object_id
    };
    if let Some(source_object_id) = descriptor.object_id {
        let _count_object_id = resolve_object_replacement(
            source_object_id,
            owner,
            setup,
            content,
            runtime_attributes,
            rng,
        )?;
    }
    let count = effective_group_member_count(descriptor, rng)?;
    Ok((count, local_master))
}

#[allow(clippy::too_many_arguments)]
fn local_group_member_matches(
    coordinate: MapCoordinate,
    descriptor: &ExactObjectDescriptor,
    candidate_definition: Option<&ObjectDefinition>,
    owner: u8,
    dimensions: MapDimensions,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    construction_positions: &BTreeMap<usize, [u32; 2]>,
    terrain: &[TerrainId],
    elevation: &[i16],
    layer_id: &[u16],
    content: CompatibleContentView<'_>,
    master_restriction: Option<RestrictionId>,
    runtime_attributes: &ObjectRuntimeAttributes,
    setup: &ExactSetupState,
    roster: &super::exact_world::ObjectRoster,
    obstruction_index: Option<&ObstructionIndex>,
) -> Result<bool, GenerationError> {
    let index =
        usize::from(coordinate.y) * usize::from(dimensions.width) + usize::from(coordinate.x);
    if !descriptor
        .terrain_to_place_on
        .is_none_or(|required| terrain[index] == required)
        || !layer_constraint_matches(descriptor, layer_id[index])
    {
        return Ok(false);
    }
    let Some(definition) = candidate_definition else {
        return Ok(true);
    };
    if !master_terrain_allows_coordinate(
        coordinate,
        definition,
        dimensions,
        terrain,
        content,
        member_master_ignores_terrain_restrictions(descriptor),
        master_restriction,
    ) || !master_slope_allows_coordinate(
        coordinate,
        definition,
        owner,
        dimensions,
        elevation,
        runtime_attributes,
    ) {
        return Ok(false);
    }
    master_obstruction_allows_coordinate_with_positions(
        coordinate,
        definition,
        owner,
        appearance_objects,
        objects,
        construction_positions,
        terrain,
        content,
        runtime_attributes,
        Some(Class39PlacementContext {
            setup,
            roster,
            master_restriction,
        }),
        obstruction_index,
    )
}

#[allow(clippy::too_many_arguments)]
fn local_group_queue_candidate_matches(
    coordinate: MapCoordinate,
    anchor: MapCoordinate,
    radius_squared: u32,
    descriptor: &ExactObjectDescriptor,
    runtime_attributes: &ObjectRuntimeAttributes,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    object_groups: &[ExactObjectGroup],
    player: Option<(u8, MapCoordinate)>,
    actor_areas: ActorAreas<'_>,
    candidate_availability: &CandidateAvailability,
    appearance_objects: &TerrainAppearanceObjects,
    objects: &[PlacedObject],
    terrain: &[TerrainId],
    rng: &mut RmsRandom,
    roster: &super::exact_world::ObjectRoster,
    list_classes: Option<&ListClassIndex>,
) -> Result<bool, GenerationError> {
    if !candidate_availability.is_available(coordinate) {
        return Ok(false);
    }
    if descriptor.circular_placement {
        let dx = u32::from(coordinate.x.abs_diff(anchor.x));
        let dy = u32::from(coordinate.y.abs_diff(anchor.y));
        if dx * dx + dy * dy > radius_squared {
            return Ok(false);
        }
    }
    let class_filter_allows = if descriptor.object_class_filter.is_some() {
        let definition = resolve_class_filter_definition(
            descriptor,
            object_groups,
            setup,
            content,
            runtime_attributes,
            rng,
        )?;
        object_class_filter_allows(
            descriptor,
            coordinate,
            definition,
            appearance_objects,
            objects,
            terrain,
            content,
            roster,
            list_classes,
        )
    } else {
        true
    };
    Ok(class_filter_allows && actor_area_constraints(descriptor, player, coordinate, actor_areas))
}

fn offset_coordinate(
    anchor: MapCoordinate,
    offset: (i32, i32),
    dimensions: MapDimensions,
) -> Result<MapCoordinate, GenerationError> {
    let x = i32::from(anchor.x).saturating_add(offset.0);
    let y = i32::from(anchor.y).saturating_add(offset.1);
    if x < 0 || y < 0 || x >= i32::from(dimensions.width) || y >= i32::from(dimensions.height) {
        return Err(invalid_object(
            "forced object coordinate lies outside the map",
        ));
    }
    Ok(MapCoordinate {
        x: x as u16,
        y: y as u16,
    })
}

fn validate_terrain_content(
    connection: &ExactConnectionState,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    for terrain in &connection.terrain {
        if content.terrain(*terrain).is_none() {
            return Err(GenerationError::MissingContentDefinition {
                kind: ContentDefinitionKind::Terrain,
                id: terrain.0,
            });
        }
    }
    Ok(())
}

fn validate_object_content(
    descriptors: &[ExactObjectDescriptor],
    groups: &[ExactObjectGroup],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let mut ids = Vec::new();
    for descriptor in descriptors {
        if descriptor
            .object_id
            .is_some_and(|id| content.object(id).is_none())
        {
            continue;
        }
        ids.extend(descriptor.object_id);
        if descriptor.number_of_groups != 0
            && (descriptor.number_of_objects != 0
                || descriptor.scaling == ExactObjectScaling::MapSize)
        {
            ids.extend(
                descriptor
                    .second_object_id
                    .filter(|id| content.object(*id).is_some()),
            );
        }
    }
    for group in groups {
        ids.extend(group.entries.iter().map(|entry| entry.object_id));
    }
    let mut validated = BTreeSet::new();
    while let Some(id) = ids.pop() {
        if !validated.insert(id) {
            continue;
        }
        let definition = content
            .object(id)
            .ok_or_else(|| missing_object_definition(id))?;
        validate_object_definition(definition, content)?;
        ids.extend(
            definition
                .construction_attachments
                .iter()
                .map(|child| child.object_id),
        );
    }
    Ok(())
}

pub(crate) fn undefined_object_identities(
    descriptors: &[ExactObjectDescriptor],
    content: CompatibleContentView<'_>,
) -> Vec<ObjectId> {
    descriptors
        .iter()
        .flat_map(|descriptor| [descriptor.object_id, descriptor.second_object_id])
        .flatten()
        .filter(|id| content.object(*id).is_none())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn missing_object_definition(id: ObjectId) -> GenerationError {
    GenerationError::MissingContentDefinition {
        kind: ContentDefinitionKind::Object,
        id: id.0,
    }
}

fn validate_object_definition(
    definition: &ObjectDefinition,
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let zero_sized_non_obstructing = is_zero_sized_non_obstructing(definition);
    if (definition.footprint_width_256 == 0 || definition.footprint_height_256 == 0)
        && !zero_sized_non_obstructing
    {
        return Err(GenerationError::IncompatibleContent);
    }
    if let Some(restriction_id) = definition.restriction_id {
        let Some(restriction) = content.restriction(restriction_id) else {
            return Err(GenerationError::IncompatibleContent);
        };
        if restriction.traversal_cost_f32_bits.is_none() {
            return Err(GenerationError::IncompatibleContent);
        }
    }
    Ok(())
}

pub(super) fn write_object(writer: &mut CanonicalWriter, object: &PlacedObject) {
    writer.u32(object.instance_id);
    writer.u32(object.object_id.0);
    writer.u32(object.x_256);
    writer.u32(object.y_256);
    writer.u32(object.z_256 as u32);
    writer.u8(object.owner);
    writer.u16(object.facet);
    writer.u16(object.footprint_width_256);
    writer.u16(object.footprint_height_256);
    writer.u8(object.presentation_kind);
    writer.u16(object.resource_type as u16);
    writer.u32(object.resource_quantity_f32_bits);
    writer.u32(object.resource_delta as u32);
    writer.u32(object.status as u32);
    writer.u8(object.death_state as u8);
    writer.u16(object.data_status as u16);
    writer.u8(object.selection_flags);
    writer.u16(object.behavior_flags);
}

fn object_argument(
    operation: &SemanticOperation,
    index: usize,
    content: CompatibleContentView<'_>,
) -> Result<ObjectId, GenerationError> {
    let identity = text_argument(operation, index)?;
    parse_object(identity, content)
        .ok_or_else(|| invalid_object(&format!("object identity {identity:?} is unresolved")))
}

fn parse_object(value: &str, content: CompatibleContentView<'_>) -> Option<ObjectId> {
    value
        .parse::<u32>()
        .ok()
        .map(ObjectId)
        .or_else(|| content.object_by_rms_name(value).map(|object| object.id))
}

fn text_argument(operation: &SemanticOperation, index: usize) -> Result<&str, GenerationError> {
    operation
        .arguments
        .get(index)
        .map(|argument| argument.value.as_str())
        .ok_or_else(|| invalid_object("object operation is missing an argument"))
}

fn numeric_i32(operation: &SemanticOperation, index: usize) -> Result<i32, GenerationError> {
    let value = text_argument(operation, index)?
        .parse::<f32>()
        .map_err(|_| invalid_object("object argument is not numeric"))?;
    if !value.is_finite() || value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_object("object argument exceeds i32"));
    }
    Ok(value.trunc() as i32)
}

fn object_class_filter_radius(operation: &SemanticOperation) -> Result<u16, GenerationError> {
    let value = if operation.arguments.is_empty() {
        1
    } else {
        rounded_numeric_i32(operation, 0)?.max(1)
    };
    u16::try_from(value).map_err(|_| invalid_object("object-class avoidance radius exceeds u16"))
}

fn rounded_numeric_i32(
    operation: &SemanticOperation,
    index: usize,
) -> Result<i32, GenerationError> {
    let value = text_argument(operation, index)?
        .parse::<f32>()
        .map_err(|_| invalid_object("object argument is not numeric"))?
        .round();
    if !value.is_finite()
        || f64::from(value) < f64::from(i32::MIN)
        || f64::from(value) > f64::from(i32::MAX)
    {
        return Err(invalid_object("rounded object argument exceeds i32"));
    }
    Ok(value as i32)
}

fn rounded_nonnegative_u32(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u32, GenerationError> {
    u32::try_from(rounded_numeric_i32(operation, index)?)
        .map_err(|_| invalid_object(&format!("{description} cannot be negative")))
}

fn nonnegative_u32(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u32, GenerationError> {
    u32::try_from(numeric_i32(operation, index)?)
        .map_err(|_| invalid_object(&format!("{description} cannot be negative")))
}

fn u16_value(
    operation: &SemanticOperation,
    index: usize,
    description: &str,
) -> Result<u16, GenerationError> {
    u16::try_from(rounded_numeric_i32(operation, index)?)
        .map_err(|_| invalid_object(&format!("{description} exceeds u16")))
}

fn invalid_object(message: &str) -> GenerationError {
    invalid_request("RMSGEN8001", message)
}

fn object_limit(resource: &str, limit: usize) -> GenerationError {
    GenerationError::ResourceLimit {
        resource: resource.to_owned(),
        limit: limit as u64,
    }
}
