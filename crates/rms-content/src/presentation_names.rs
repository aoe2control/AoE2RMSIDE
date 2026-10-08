use crate::dat::{DatDocument, DatMaster, decode_ver89};
use crate::{ContentError, DatImportLimits, inflate_aoe2de_dat};

pub const MAXIMUM_PRESENTATION_STRING_ID: u32 = 16_777_215;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationStringId {
    pub id: u32,
    pub string_id: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationObjectSlot {
    pub id: u32,
    pub standing_graphic: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationTerrainMinimapIndices {
    pub id: u32,
    pub high_index: u8,
    pub medium_index: u8,
    pub low_index: u8,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DatPresentationStringIds {
    pub objects: Vec<PresentationStringId>,
    pub terrains: Vec<PresentationStringId>,
    pub object_slots: Vec<PresentationObjectSlot>,
    pub terrain_slot_count: u32,
    pub terrain_minimap_indices: Vec<PresentationTerrainMinimapIndices>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DatMinimapIndices {
    pub terrains: Vec<DatTerrainMinimapIndices>,
    pub objects: Vec<DatObjectMinimapIndex>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DatTerrainMinimapIndices {
    pub id: u32,
    pub high_index: u8,
    pub medium_index: u8,
    pub low_index: u8,
    pub cliff_left_index: u8,
    pub cliff_right_index: u8,
}

impl DatTerrainMinimapIndices {
    #[must_use]
    pub fn has_dedicated_color(&self) -> bool {
        self.high_index != 0 || self.medium_index != 0 || self.low_index != 0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DatObjectMinimapIndex {
    pub id: u32,
    pub minimap_mode: u8,
    pub color_index: u8,
}

impl DatObjectMinimapIndex {
    #[must_use]
    pub fn has_dedicated_color(&self) -> bool {
        self.minimap_mode != 0 && self.color_index != 0
    }
}

pub fn read_aoe2de_dat_minimap_indices(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<DatMinimapIndices, ContentError> {
    let (_, decompressed) = inflate_aoe2de_dat(compressed, limits)?;
    let document = decode_ver89(&decompressed)?;
    drop(decompressed);
    Ok(DatMinimapIndices {
        terrains: terrain_minimap_indices(&document)?,
        objects: first_owners(&document)
            .into_iter()
            .map(|(id, master)| DatObjectMinimapIndex {
                id,
                minimap_mode: master.minimap_mode,
                color_index: master.minimap_color_index,
            })
            .collect(),
    })
}

fn terrain_minimap_indices(
    document: &DatDocument,
) -> Result<Vec<DatTerrainMinimapIndices>, ContentError> {
    document
        .terrains
        .iter()
        .enumerate()
        .map(|(slot, terrain)| {
            let [high, medium, low, left, right] = terrain.minimap_color_indices;
            Ok(DatTerrainMinimapIndices {
                id: u32::try_from(slot)
                    .map_err(|_| ContentError::ResourceLimit("terrain slots"))?,
                high_index: high,
                medium_index: medium,
                low_index: low,
                cliff_left_index: left,
                cliff_right_index: right,
            })
        })
        .collect()
}

fn first_owners(document: &DatDocument) -> Vec<(u32, &DatMaster)> {
    let slots = document
        .civilizations
        .iter()
        .map(|civilization| civilization.masters.len())
        .max()
        .unwrap_or(0);
    (0..slots)
        .filter_map(|slot| {
            let master = document
                .civilizations
                .iter()
                .find_map(|civilization| civilization.masters.get(slot)?.as_deref())?;
            Some((u32::try_from(slot).ok()?, master))
        })
        .collect()
}

pub fn read_aoe2de_dat_presentation_string_ids(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<DatPresentationStringIds, ContentError> {
    let (_, decompressed) = inflate_aoe2de_dat(compressed, limits)?;
    let document = decode_ver89(&decompressed)?;
    drop(decompressed);
    let usable = |value: i32| {
        u32::try_from(value)
            .ok()
            .filter(|value| (1..=MAXIMUM_PRESENTATION_STRING_ID).contains(value))
    };
    let terrains = document
        .terrains
        .iter()
        .enumerate()
        .filter_map(|(slot, terrain)| {
            Some(PresentationStringId {
                id: u32::try_from(slot).ok()?,
                string_id: usable(terrain.name_string_id)?,
            })
        })
        .collect();
    let first_owners = first_owners(&document);
    let objects = first_owners
        .iter()
        .filter_map(|(id, master)| {
            Some(PresentationStringId {
                id: *id,
                string_id: usable(master.name_string_id)?,
            })
        })
        .collect();
    let object_slots = first_owners
        .iter()
        .map(|(id, master)| PresentationObjectSlot {
            id: *id,
            standing_graphic: master.standing_graphics[0] >= 0,
        })
        .collect();
    let terrain_slot_count = u32::try_from(document.terrains.len())
        .map_err(|_| ContentError::ResourceLimit("terrain slots"))?;
    let terrain_minimap_indices = terrain_minimap_indices(&document)?
        .into_iter()
        .filter(DatTerrainMinimapIndices::has_dedicated_color)
        .map(|terrain| PresentationTerrainMinimapIndices {
            id: terrain.id,
            high_index: terrain.high_index,
            medium_index: terrain.medium_index,
            low_index: terrain.low_index,
        })
        .collect();
    Ok(DatPresentationStringIds {
        objects,
        terrains,
        object_slots,
        terrain_slot_count,
        terrain_minimap_indices,
    })
}
