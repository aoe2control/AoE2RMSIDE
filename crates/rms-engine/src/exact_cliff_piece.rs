use super::*;
use rms_content::{CliffDefinition, ObjectId};
use rms_semantics::RmsRandom;
use std::sync::Arc;

const DIRECTIONS: [(i16, i16); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

#[derive(Clone, Debug)]
struct Piece {
    edges: [i8; 4],
    object: PlacedObject,
}

#[derive(Default)]
pub(super) struct CliffPieces {
    pieces: BTreeMap<MapCoordinate, Piece>,
    pub next_instance_id: u32,
    master_facets: BTreeMap<ObjectId, u8>,
}

impl CliffPieces {
    pub fn new(next_instance_id: u32) -> Self {
        Self {
            next_instance_id,
            ..Self::default()
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn join(
        &mut self,
        from: MapCoordinate,
        to: MapCoordinate,
        incoming_side: Option<usize>,
        style: &CliffDefinition,
        dimensions: MapDimensions,
        elevation: &[i16],
        content: CompatibleContentView<'_>,
        rng: &mut RmsRandom,
        restriction_zones: &mut ExactRestrictionZones,
        terrain: &[TerrainId],
    ) -> Result<usize, GenerationError> {
        let delta = (
            i32::from(to.x) - i32::from(from.x),
            i32::from(to.y) - i32::from(from.y),
        );
        let direction = DIRECTIONS
            .iter()
            .position(|&(x, y)| (i32::from(x), i32::from(y)) == delta)
            .ok_or_else(|| piece_error("cliff piece segment is not coarse-adjacent"))?;
        if self.pieces.contains_key(&to) {
            return Err(piece_error(
                "cliff piece path revisits an occupied coarse node",
            ));
        }
        let mut edges = match self.pieces.remove(&from) {
            Some(piece) => {
                let attributes = restriction_zones.runtime_attributes();
                super::exact_object::destroy_world_object_on_terrain(
                    Arc::make_mut(&mut restriction_zones.objects),
                    piece.object.instance_id,
                    content,
                    &attributes,
                    false,
                    Some(terrain),
                )?;
                piece.edges
            }
            None => [0; 4],
        };
        if edges[direction] != 0 {
            return Err(piece_error("cliff continuation repeats an existing leg"));
        }
        if let Some(incoming) = incoming_side {
            for (side, &(dx, dy)) in DIRECTIONS.iter().enumerate() {
                if side == incoming {
                    continue;
                }
                edges[side] = 0;
                let Some(x) = from.x.checked_add_signed(dx) else {
                    continue;
                };
                let Some(y) = from.y.checked_add_signed(dy) else {
                    continue;
                };
                let neighbor = MapCoordinate { x, y };
                if let Some(piece) = self.pieces.remove(&neighbor) {
                    let attributes = restriction_zones.runtime_attributes();
                    super::exact_object::destroy_world_object_on_terrain(
                        Arc::make_mut(&mut restriction_zones.objects),
                        piece.object.instance_id,
                        content,
                        &attributes,
                        false,
                        Some(terrain),
                    )?;
                    let mut remaining = piece.edges;
                    remaining[(side + 2) % 4] = 0;
                    self.construct(
                        neighbor,
                        remaining,
                        style,
                        dimensions,
                        elevation,
                        content,
                        rng,
                        restriction_zones,
                        terrain,
                    )?;
                }
            }
        }
        edges[direction] = 1;
        if style.piece_rule(edges).is_none() {
            edges[direction] = -1;
        }
        if style.piece_rule(edges).is_none() {
            return Err(piece_error("content lacks the required signed cliff join"));
        }
        let reverse = (direction + 2) % 4;
        let mut endpoint = [0; 4];
        endpoint[reverse] = edges[direction];
        self.construct(
            from,
            edges,
            style,
            dimensions,
            elevation,
            content,
            rng,
            restriction_zones,
            terrain,
        )?;
        self.construct(
            to,
            endpoint,
            style,
            dimensions,
            elevation,
            content,
            rng,
            restriction_zones,
            terrain,
        )?;
        Ok(reverse)
    }

    #[allow(clippy::too_many_arguments)]
    fn construct(
        &mut self,
        point: MapCoordinate,
        edges: [i8; 4],
        style: &CliffDefinition,
        dimensions: MapDimensions,
        elevation: &[i16],
        content: CompatibleContentView<'_>,
        rng: &mut RmsRandom,
        restriction_zones: &mut ExactRestrictionZones,
        terrain: &[TerrainId],
    ) -> Result<(), GenerationError> {
        if edges == [0; 4] {
            return Ok(());
        }
        let rule = style
            .piece_rule(edges)
            .ok_or_else(|| piece_error("content lacks a cliff piece shape"))?;
        let variant = match rule.alternate {
            Some(alternate) if rng.next_u32() & 1 != 0 => alternate,
            _ => rule.primary,
        };
        let definition = content
            .object(variant.object_id)
            .ok_or_else(|| piece_error("cliff piece master is unavailable"))?;
        if definition
            .available_civilizations
            .as_ref()
            .is_some_and(|ids| ids.binary_search(&CivilizationId(0)).is_err())
            || content.object_placement_classes().cliff_zone_class_id != Some(definition.class_id)
            || definition.creation_rng.random_angle
            || definition.creation_rng.random_combat_seed
        {
            return Err(piece_error(
                "cliff piece construction metadata is incompatible",
            ));
        }
        let x_256 = u32::from(point.x) * 768 + u32::from(rule.x_offset_256);
        restriction_zones.construct(variant.object_id, 0, dimensions, terrain, content)?;
        let y_256 = u32::from(point.y) * 768 + u32::from(rule.y_offset_256);
        let z_256 = super::exact_elevation::terrain_height_from_f32(
            x_256 as f32 / 256.0,
            y_256 as f32 / 256.0,
            dimensions,
            elevation,
        )
        .ok_or_else(|| piece_error("cliff piece position lies outside the map"))?;
        let instance_id = self.next_instance_id;
        let hit_points = restriction_zones.runtime_attributes().initial_hit_points(
            variant.object_id,
            0,
            content,
        )?;
        let position_family = restriction_zones
            .runtime_attributes()
            .definition(variant.object_id, 0, content)
            .ok_or_else(|| piece_error("effective cliff piece master is unavailable"))?
            .position_family;
        Arc::make_mut(&mut restriction_zones.objects).birth_on_terrain(
            instance_id,
            variant.object_id,
            0,
            definition.initial_lifecycle_state,
            [x_256 as f32 / 256.0, y_256 as f32 / 256.0],
            dimensions,
            hit_points,
            definition.pathing,
            definition.collision_half_extents(),
            position_family,
            Some(terrain),
        )?;
        self.next_instance_id = instance_id
            .checked_add(1)
            .ok_or_else(|| piece_error("cliff construction identity exceeds u32"))?;
        self.master_facets.insert(variant.object_id, variant.facet);
        let resources = super::exact_object::initial_object_resources(definition)?;
        let object = PlacedObject {
            instance_id,
            object_id: variant.object_id,
            x_256,
            y_256,
            z_256,
            owner: 0,
            facet: u16::from(variant.facet),
            footprint_width_256: definition.footprint_width_256,
            footprint_height_256: definition.footprint_height_256,
            presentation_kind: 0,
            resource_type: resources.resource_type,
            resource_quantity_f32_bits: resources.quantity_f32_bits,
            resource_delta: 0,
            status: i32::from(definition.initial_lifecycle_state),
            death_state: i8::from_ne_bytes([definition.initial_lifecycle_state]),
            data_status: definition.data_status,
            selection_flags: 0,
            behavior_flags: 0,
        };
        self.pieces.insert(point, Piece { edges, object });
        Ok(())
    }

    pub fn finish(self) -> (Vec<PlacedObject>, Vec<(ObjectId, u8)>, u32) {
        let mut objects = self
            .pieces
            .into_values()
            .map(|piece| piece.object)
            .collect::<Vec<_>>();
        objects.sort_by_key(|object| object.instance_id);
        (
            objects,
            self.master_facets.into_iter().collect(),
            self.next_instance_id,
        )
    }

    pub fn forget_destroyed(&mut self, identity: u32) -> Result<(), GenerationError> {
        let point = self
            .pieces
            .iter()
            .find_map(|(point, piece)| (piece.object.instance_id == identity).then_some(*point))
            .ok_or_else(|| piece_error("destroyed cliff occupant has no lifecycle owner"))?;
        self.pieces.remove(&point);
        Ok(())
    }
}

fn piece_error(message: &'static str) -> GenerationError {
    invalid_request("RMSGEN3201", message)
}
