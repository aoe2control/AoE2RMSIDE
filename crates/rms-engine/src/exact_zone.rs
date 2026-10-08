use super::*;
use std::sync::Arc;

pub(crate) const TERRAIN_SLOT_COUNT: usize = 200;
const MAXIMUM_ENTRIES: usize = 256;
const UNVISITED: u16 = 512;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Entry {
    allowed: Vec<bool>,
    labels: Arc<[u16]>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExactRestrictionZones {
    dimensions: Option<MapDimensions>,
    entries: Vec<Entry>,
    runtime_attributes: Arc<super::exact_object::ObjectRuntimeAttributes>,
    pub(super) objects: Arc<super::exact_world::ObjectRoster>,
}

impl ExactRestrictionZones {
    pub(super) fn runtime_attributes(&self) -> Arc<super::exact_object::ObjectRuntimeAttributes> {
        Arc::clone(&self.runtime_attributes)
    }

    pub(crate) fn anchored_lookup(
        &mut self,
        dimensions: MapDimensions,
        terrain: &[TerrainId],
        layer: &[u16],
        restriction: &rms_content::RestrictionDefinition,
        anchor: Option<MapCoordinate>,
    ) -> Result<Arc<[u16]>, GenerationError> {
        let (mut values, length) = permissions(restriction)?;
        let allowed = &mut values[..length];
        if let Some(anchor) = anchor {
            if anchor.x >= dimensions.width || anchor.y >= dimensions.height {
                return Err(zone_error(
                    "an object descriptor targets a land whose anchor lies outside the map; the game reads a missing tile there and crashes, so this map cannot be generated",
                ));
            }
            let index =
                usize::from(anchor.y) * usize::from(dimensions.width) + usize::from(anchor.x);
            let base = terrain
                .get(index)
                .ok_or_else(|| zone_error("anchor terrain is unavailable"))?;
            if let Some(enabled) = allowed.get_mut(base.0 as usize) {
                *enabled = true;
            }
            let layer = *layer
                .get(index)
                .ok_or_else(|| zone_error("anchor layer is unavailable"))?;
            if layer != u16::MAX
                && let Some(enabled) = allowed.get_mut(usize::from(layer as u8))
            {
                *enabled = true;
            }
        }
        self.lookup(dimensions, terrain, allowed, false)
    }

    pub(crate) fn new(
        operations: &[rms_semantics::SemanticOperation],
        content: CompatibleContentView<'_>,
        players: &[ExactSetupPlayer],
    ) -> Result<Self, GenerationError> {
        let mut attributes =
            super::exact_object::collect_runtime_object_attributes(operations, content)?;
        attributes.bind_owner_civilizations(players)?;
        Ok(Self {
            runtime_attributes: Arc::new(attributes),
            ..Self::default()
        })
    }

    pub(crate) fn construct(
        &mut self,
        object_id: rms_content::ObjectId,
        owner: u8,
        dimensions: MapDimensions,
        terrain: &[TerrainId],
        content: CompatibleContentView<'_>,
    ) -> Result<(), GenerationError> {
        if let Some(id) = self
            .runtime_attributes
            .construction_restriction(object_id, owner, content)?
        {
            let restriction = content
                .restriction(id)
                .ok_or(GenerationError::IncompatibleContent)?;
            let (allowed, length) = permissions(restriction)?;
            self.lookup(dimensions, terrain, &allowed[..length], false)?;
        }
        Ok(())
    }

    pub(crate) fn lookup(
        &mut self,
        dimensions: MapDimensions,
        terrain: &[TerrainId],
        allowed: &[bool],
        refresh: bool,
    ) -> Result<Arc<[u16]>, GenerationError> {
        if allowed.is_empty() || allowed.len() > 256 {
            return Err(zone_error(
                "restriction vector exceeds its supported domain",
            ));
        }
        if self.dimensions.is_some_and(|bound| bound != dimensions)
            || terrain.len() != dimensions.tile_count()?
        {
            return Err(zone_error("restriction cache dimensions disagree"));
        }
        if let Some(entry) = self.entries.iter_mut().find(|entry| {
            allowed.len() >= entry.allowed.len() && allowed.starts_with(&entry.allowed)
        }) {
            if refresh {
                entry.labels = component_labels(dimensions, terrain, &entry.allowed)?.into();
            }
            return Ok(Arc::clone(&entry.labels));
        }
        if self.entries.len() >= MAXIMUM_ENTRIES {
            return Err(zone_error("restriction cache entry bound exhausted"));
        }
        let labels: Arc<[u16]> = component_labels(dimensions, terrain, allowed)?.into();
        self.entries.push(Entry {
            allowed: allowed.to_vec(),
            labels: Arc::clone(&labels),
        });
        self.dimensions = Some(dimensions);
        Ok(labels)
    }
}

pub(crate) fn permissions(
    restriction: &rms_content::RestrictionDefinition,
) -> Result<([bool; 256], usize), GenerationError> {
    let mut values = [false; 256];
    if let Some(costs) = &restriction.traversal_cost_f32_bits {
        if costs.len() > values.len() {
            return Err(zone_error("restriction traversal cost bound exceeded"));
        }
        for (value, &bits) in values.iter_mut().zip(costs) {
            *value = f32::from_bits(bits) > 0.0;
        }
        return Ok((values, costs.len()));
    }
    for (index, value) in values.iter_mut().enumerate().take(TERRAIN_SLOT_COUNT) {
        let id = TerrainId(index as u32);
        *value = restriction.allowed_terrain_ids.binary_search(&id).is_ok()
            && restriction.blocked_terrain_ids.binary_search(&id).is_err();
    }
    Ok((values, TERRAIN_SLOT_COUNT))
}

pub(crate) fn component_labels(
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    allowed: &[bool],
) -> Result<Vec<u16>, GenerationError> {
    let width = usize::from(dimensions.width);
    let height = usize::from(dimensions.height);
    if terrain.len() != dimensions.tile_count()? {
        return Err(zone_error("restriction component input is incomplete"));
    }
    let allowed = |id: TerrainId| permitted_slot(allowed, id);
    let mut labels = vec![UNVISITED; terrain.len()];
    let mut pending = Vec::new();
    let mut label = 0_u16;
    for start in 0..terrain.len() {
        if labels[start] != UNVISITED {
            continue;
        }
        let permitted = allowed(terrain[start]);
        labels[start] = label;
        pending.push(start);
        while let Some(index) = pending.pop() {
            let x = index % width;
            let y = index / width;
            let mut visit = |neighbor: usize| {
                if labels[neighbor] == UNVISITED && allowed(terrain[neighbor]) == permitted {
                    labels[neighbor] = label;
                    pending.push(neighbor);
                }
            };
            if x > 0 {
                visit(index - 1);
            }
            if x + 1 < width {
                visit(index + 1);
            }
            if y > 0 {
                visit(index - width);
            }
            if y + 1 < height {
                visit(index + width);
            }
        }
        label = (label + 1) & 511;
    }
    Ok(labels)
}

pub(crate) fn slot_cost_bits(costs: &[u32], terrain: TerrainId) -> u32 {
    costs.get(terrain.0 as usize).copied().unwrap_or(0)
}

fn permitted_slot(allowed: &[bool], terrain: TerrainId) -> bool {
    allowed.get(terrain.0 as usize).copied().unwrap_or(false)
}

pub(crate) fn rejects_placement(
    restriction: &rms_content::RestrictionDefinition,
    terrain: TerrainId,
) -> Option<bool> {
    let costs = restriction.traversal_cost_f32_bits.as_deref()?;
    Some(f32::from_bits(slot_cost_bits(costs, terrain)) <= 0.05_f32)
}

pub(crate) fn refuse_terrain_past_restriction_tables(
    terrain: &[TerrainId],
    content: CompatibleContentView<'_>,
) -> Result<(), GenerationError> {
    let Some(covered) = content
        .restrictions()
        .iter()
        .filter_map(|restriction| restriction.traversal_cost_f32_bits.as_ref())
        .map(Vec::len)
        .min()
    else {
        return Ok(());
    };
    let Some(first) = terrain
        .iter()
        .filter(|id| id.0 as usize >= covered)
        .map(|id| id.0)
        .min()
    else {
        return Ok(());
    };
    Err(invalid_request(
        "RMSGEN7103",
        &format!(
            "the map uses terrain {first}, which the game's movement tables do not cover \
             (they end at terrain {}); the game then reads undefined memory, generates a \
             different map and crashes during the match, so this map cannot be previewed",
            covered - 1
        ),
    ))
}

fn zone_error(message: &str) -> GenerationError {
    invalid_request("RMSGEN7101", message)
}

pub(crate) fn anchor_matches(labels: &[u16], anchor: usize, candidate: usize) -> bool {
    labels[candidate] == u16::from(labels[anchor] as u8)
}
