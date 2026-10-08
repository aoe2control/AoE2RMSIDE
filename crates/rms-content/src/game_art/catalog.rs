use std::collections::BTreeSet;

use serde::Serialize;

use crate::dat::{DatDocument, DatGraphic, decode_ver89};
use crate::{ContentError, DatImportLimits, inflate_aoe2de_dat};

pub const GAME_ART_BLEND_ATLASES: [&str; 9] = [
    "waterwater",
    "watershore",
    "landland",
    "farmland",
    "snowland",
    "icewater",
    "roadland",
    "shallowswater",
    "reserved",
];

pub const MAXIMUM_OBJECT_ART_PARTS: usize = 64;
const MAXIMUM_DELTA_DEPTH: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtTerrain {
    pub id: u32,
    pub texture: String,
    pub blend_priority: i32,
    pub blend_type: i32,
    pub overlay_mask: String,
    pub water_class: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtDelta {
    pub graphic: Option<u32>,
    pub offset_x: i16,
    pub offset_y: i16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtGraphic {
    pub id: u32,
    pub file: String,
    pub layer: u8,
    pub frame_count: u16,
    pub angle_count: u16,
    pub mirroring: u8,
    pub deltas: Vec<ArtDelta>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtAnnex {
    pub object: u32,
    pub offset_x: f32,
    pub offset_y: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArtMaster {
    pub standing_graphic: Option<u32>,
    pub foundation_terrain: Option<u32>,
    pub annexes: Vec<ArtAnnex>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtPart {
    pub graphic: u32,
    pub offset_x: i32,
    pub offset_y: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectArt {
    pub object: u32,
    pub civilization: u32,
    pub table: u32,
    pub parts: Vec<ArtPart>,
    pub foundation_terrain: Option<u32>,
    pub annexes: Vec<ArtAnnex>,
    pub invisible: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GameArtCatalog {
    pub terrains: Vec<ArtTerrain>,
    graphics: Vec<Option<ArtGraphic>>,
    civilizations: Vec<Vec<Option<ArtMaster>>>,
}

pub fn read_aoe2de_dat_game_art(
    compressed: &[u8],
    limits: DatImportLimits,
) -> Result<GameArtCatalog, ContentError> {
    let (_, decompressed) = inflate_aoe2de_dat(compressed, limits)?;
    let document = decode_ver89(&decompressed)?;
    drop(decompressed);
    Ok(GameArtCatalog::from_document(&document))
}

fn slot(value: i16) -> Option<u32> {
    u32::try_from(value).ok()
}

impl GameArtCatalog {
    pub(crate) fn from_document(document: &DatDocument) -> Self {
        let terrains = document
            .terrains
            .iter()
            .enumerate()
            .filter(|(_, terrain)| terrain.enabled != 0 && !terrain.texture_name.is_empty())
            .map(|(id, terrain)| ArtTerrain {
                id: id as u32,
                texture: terrain.texture_name.clone(),
                blend_priority: terrain.blend_priority,
                blend_type: terrain.blend_type,
                overlay_mask: terrain.overlay_mask_name.clone(),
                water_class: terrain.placement_class,
            })
            .collect();
        let graphics = document
            .graphics
            .iter()
            .enumerate()
            .map(|(id, graphic)| graphic.as_ref().map(|graphic| art_graphic(id, graphic)))
            .collect();
        let civilizations = document
            .civilizations
            .iter()
            .map(|civilization| {
                civilization
                    .masters
                    .iter()
                    .map(|master| {
                        master.as_ref().map(|master| ArtMaster {
                            standing_graphic: slot(master.standing_graphics[0]),
                            foundation_terrain: master
                                .building
                                .as_ref()
                                .and_then(|building| slot(building.foundation_terrain_id)),
                            annexes: master
                                .building
                                .as_ref()
                                .map(|building| {
                                    building
                                        .annexes
                                        .iter()
                                        .filter_map(|annex| {
                                            Some(ArtAnnex {
                                                object: slot(annex.object_id)?,
                                                offset_x: f32::from_bits(annex.x_offset_bits),
                                                offset_y: f32::from_bits(annex.y_offset_bits),
                                            })
                                        })
                                        .filter(|annex| {
                                            annex.offset_x.is_finite() && annex.offset_y.is_finite()
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .collect();
        Self {
            terrains,
            graphics,
            civilizations,
        }
    }

    #[must_use]
    pub fn terrain_textures(&self) -> BTreeSet<String> {
        self.terrains
            .iter()
            .map(|terrain| terrain.texture.clone())
            .collect()
    }

    #[must_use]
    pub fn overlay_masks(&self) -> BTreeSet<String> {
        self.terrains
            .iter()
            .filter(|terrain| !terrain.overlay_mask.is_empty())
            .map(|terrain| terrain.overlay_mask.clone())
            .collect()
    }

    #[must_use]
    pub fn graphic(&self, id: u32) -> Option<&ArtGraphic> {
        self.graphics.get(id as usize)?.as_ref()
    }

    #[must_use]
    pub fn civilization_count(&self) -> usize {
        self.civilizations.len()
    }

    #[must_use]
    pub fn master(&self, object: u32, civilization: u32) -> Option<(u32, &ArtMaster)> {
        let lookup = |table: u32| {
            self.civilizations
                .get(table as usize)?
                .get(object as usize)?
                .as_ref()
                .map(|master| (table, master))
        };
        lookup(civilization).or_else(|| lookup(0))
    }

    #[must_use]
    pub fn object_art(&self, object: u32, civilization: u32) -> Option<ObjectArt> {
        let (table, master) = self.master(object, civilization)?;
        let mut parts = Vec::new();
        if let Some(graphic) = master.standing_graphic {
            self.collect_parts(graphic, 0, 0, 0, &mut parts);
        }
        let invisible = parts.is_empty()
            && master.annexes.is_empty()
            && master
                .standing_graphic
                .is_some_and(|graphic| self.placeholder_only(graphic, 0));
        Some(ObjectArt {
            object,
            civilization,
            table,
            parts,
            foundation_terrain: master.foundation_terrain,
            annexes: master.annexes.clone(),
            invisible,
        })
    }

    fn placeholder_only(&self, id: u32, depth: usize) -> bool {
        let Some(graphic) = self.graphic(id) else {
            return false;
        };
        graphic.file.is_empty()
            && graphic.deltas.iter().all(|delta| match delta.graphic {
                None => true,
                Some(child) if child == id => true,
                Some(child) => {
                    depth < MAXIMUM_DELTA_DEPTH && self.placeholder_only(child, depth + 1)
                }
            })
    }

    fn collect_parts(&self, id: u32, x: i32, y: i32, depth: usize, parts: &mut Vec<ArtPart>) {
        let Some(graphic) = self.graphic(id) else {
            return;
        };
        if graphic.deltas.is_empty() {
            if !graphic.file.is_empty() && parts.len() < MAXIMUM_OBJECT_ART_PARTS {
                parts.push(ArtPart {
                    graphic: id,
                    offset_x: x,
                    offset_y: y,
                });
            }
            return;
        }
        for delta in &graphic.deltas {
            let (dx, dy) = (x + i32::from(delta.offset_x), y + i32::from(delta.offset_y));
            match delta.graphic {
                None => {
                    if !graphic.file.is_empty() && parts.len() < MAXIMUM_OBJECT_ART_PARTS {
                        parts.push(ArtPart {
                            graphic: id,
                            offset_x: dx,
                            offset_y: dy,
                        });
                    }
                }
                Some(child) if depth < MAXIMUM_DELTA_DEPTH && child != id => {
                    self.collect_parts(child, dx, dy, depth + 1, parts);
                }
                Some(_) => {}
            }
        }
    }
}

fn art_graphic(id: usize, graphic: &DatGraphic) -> ArtGraphic {
    ArtGraphic {
        id: id as u32,
        file: if graphic.file_name.eq_ignore_ascii_case("none") {
            String::new()
        } else {
            graphic.file_name.clone()
        },
        layer: graphic.layer,
        frame_count: graphic.frame_count,
        angle_count: graphic.angle_count,
        mirroring: graphic.mirroring_mode,
        deltas: graphic
            .deltas
            .iter()
            .map(|delta| ArtDelta {
                graphic: slot(delta.graphic_id),
                offset_x: delta.offset_x,
                offset_y: delta.offset_y,
            })
            .collect(),
    }
}
