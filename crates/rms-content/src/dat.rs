use crate::ContentError;

pub(crate) const REVIEWED_DAT_HEADER: &[u8; 8] = b"VER 8.9\0";

const MAXIMUM_RESTRICTIONS: usize = 1024;
const MAXIMUM_RESTRICTION_TERRAINS: usize = 256;
const MAXIMUM_TABLE_ROWS: usize = 65_536;
const MAXIMUM_OBJECT_SLOTS: usize = 65_536;
const MAXIMUM_CIVILIZATIONS: usize = 256;
pub(crate) const MAXIMUM_TOTAL_OBJECT_SLOTS: usize = 1 << 20;
const MAXIMUM_NESTED_ROWS: usize = 4096;
const MAXIMUM_DEBUG_STRING_BYTES: usize = 4096;
const DEBUG_STRING_MARKER: u16 = 0x0a60;
const TERRAIN_SLOTS: usize = 200;
const TERRAIN_APPEARANCE_SLOTS: usize = 30;
pub(crate) const MAXIMUM_ART_NAME_BYTES: usize = 64;

pub(crate) fn is_art_name(name: &[u8]) -> bool {
    !name.is_empty()
        && name.len() <= MAXIMUM_ART_NAME_BYTES
        && name[0] != b'.'
        && !name.windows(2).any(|pair| pair == b"..")
        && name
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], ContentError> {
        let end = self
            .at
            .checked_add(count)
            .ok_or(ContentError::Truncated("DAT field offset"))?;
        let bytes = self
            .bytes
            .get(self.at..end)
            .ok_or(ContentError::Truncated("DAT field"))?;
        self.at = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8, ContentError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ContentError> {
        Ok(u16_at(self.take(2)?, 0))
    }

    fn i16(&mut self) -> Result<i16, ContentError> {
        Ok(i16_at(self.take(2)?, 0))
    }

    fn u32(&mut self) -> Result<u32, ContentError> {
        Ok(u32_at(self.take(4)?, 0))
    }

    fn count_u8(&mut self, maximum: usize, name: &'static str) -> Result<usize, ContentError> {
        bounded(usize::from(self.u8()?), maximum, name)
    }

    fn count_u16(&mut self, maximum: usize, name: &'static str) -> Result<usize, ContentError> {
        bounded(usize::from(self.u16()?), maximum, name)
    }

    fn count_u32(&mut self, maximum: usize, name: &'static str) -> Result<usize, ContentError> {
        let count = usize::try_from(self.u32()?).map_err(|_| ContentError::ResourceLimit(name))?;
        bounded(count, maximum, name)
    }

    fn capacity(&self, count: usize, record_bytes: usize) -> usize {
        count.min((self.bytes.len() - self.at) / record_bytes.max(1))
    }

    fn skip(&mut self, count: usize, width: usize) -> Result<(), ContentError> {
        let length = count
            .checked_mul(width)
            .ok_or(ContentError::Truncated("DAT table length"))?;
        self.take(length).map(|_| ())
    }

    fn skip_debug_string(&mut self) -> Result<(), ContentError> {
        self.debug_string().map(|_| ())
    }

    fn debug_string(&mut self) -> Result<&'a [u8], ContentError> {
        if self.u16()? != DEBUG_STRING_MARKER {
            return Err(unsupported("debug-string marker"));
        }
        let length = self.count_u16(MAXIMUM_DEBUG_STRING_BYTES, "DAT debug string")?;
        self.take(length)
    }

    fn art_name(&mut self) -> Result<String, ContentError> {
        let bytes = self.debug_string()?;
        Ok(if is_art_name(bytes) {
            String::from_utf8_lossy(bytes).into_owned()
        } else {
            String::new()
        })
    }

    fn u32_array(&mut self, count: usize) -> Result<Vec<u32>, ContentError> {
        (0..count).map(|_| self.u32()).collect()
    }

    fn i16_array<const N: usize>(&mut self) -> Result<[i16; N], ContentError> {
        let bytes = self.take(N * 2)?;
        Ok(std::array::from_fn(|index| i16_at(bytes, index * 2)))
    }
}

fn bounded(count: usize, maximum: usize, name: &'static str) -> Result<usize, ContentError> {
    if count > maximum {
        Err(ContentError::ResourceLimit(name))
    } else {
        Ok(count)
    }
}

fn unsupported(field: &str) -> ContentError {
    ContentError::UnsupportedLayout(format!(
        "VER 8.9 {field} does not match the reviewed layout"
    ))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn i16_at(bytes: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatRestriction {
    pub(crate) multiplier_bits: Vec<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatGraphicDelta {
    pub(crate) graphic_id: i16,
    pub(crate) offset_x: i16,
    pub(crate) offset_y: i16,
    pub(crate) display_angle: i16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatGraphic {
    pub(crate) file_name: String,
    pub(crate) layer: u8,
    pub(crate) frame_count: u16,
    pub(crate) angle_count: u16,
    pub(crate) sequence_flags: u8,
    pub(crate) mirroring_mode: u8,
    pub(crate) deltas: Vec<DatGraphicDelta>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatTerrainAppearance {
    pub(crate) object_id: i16,
    pub(crate) density: i16,
    pub(crate) masked_density: i16,
    pub(crate) centering: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatTerrain {
    pub(crate) enabled: u8,
    pub(crate) name_string_id: i32,
    pub(crate) random: u8,
    pub(crate) placement_class: u8,
    pub(crate) minimap_color_indices: [u8; 5],
    pub(crate) passable_terrain: u8,
    pub(crate) impassable_terrain: u8,
    pub(crate) texture_name: String,
    pub(crate) blend_priority: i32,
    pub(crate) blend_type: i32,
    pub(crate) overlay_mask_name: String,
    pub(crate) terrain_to_draw: i16,
    pub(crate) appearances: Vec<DatTerrainAppearance>,
    pub(crate) active_appearances: i16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DatEffectCommand {
    pub(crate) kind: u8,
    pub(crate) a: i16,
    pub(crate) b: i16,
    pub(crate) c: i16,
    pub(crate) d_bits: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DatResearchLocation {
    pub(crate) location_unit_id: i16,
    pub(crate) research_time: i16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatTechnology {
    pub(crate) required_technologies: [i16; 6],
    pub(crate) required_count: i16,
    pub(crate) civilization: i16,
    pub(crate) full_tech_mode: i16,
    pub(crate) effect_id: i16,
    pub(crate) research_locations: Vec<DatResearchLocation>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DatResourceStorage {
    pub(crate) resource_type: i16,
    pub(crate) quantity_bits: u32,
    pub(crate) mode: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DatAnnex {
    pub(crate) object_id: i16,
    pub(crate) x_offset_bits: u32,
    pub(crate) y_offset_bits: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatBuilding {
    pub(crate) construction_graphic_id: i16,
    pub(crate) snow_graphic_id: i16,
    pub(crate) adjacent_mode: u8,
    pub(crate) graphics_angle: i16,
    pub(crate) disappears_when_built: u8,
    pub(crate) stack_unit_id: i16,
    pub(crate) foundation_terrain_id: i16,
    pub(crate) old_overlap_id: i16,
    pub(crate) technology_id: i16,
    pub(crate) annexes: [DatAnnex; 4],
    pub(crate) head_unit_id: i16,
    pub(crate) transform_unit_id: i16,
    pub(crate) pile_unit_id: i16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatTrainLocation {
    pub(crate) build_time: i16,
    pub(crate) unit_id: i16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatMaster {
    pub(crate) kind: u8,
    pub(crate) name_string_id: i32,
    pub(crate) class: i16,
    pub(crate) standing_graphics: [i16; 2],
    pub(crate) dying_graphic: i16,
    pub(crate) hit_points: i16,
    pub(crate) collision_bits: [u32; 3],
    pub(crate) dead_unit_id: i16,
    pub(crate) blood_unit_id: i16,
    pub(crate) can_be_built_on: u8,
    pub(crate) hide_in_editor: u8,
    pub(crate) enabled: u8,
    pub(crate) disabled: u8,
    pub(crate) placement_side_terrains: [i16; 2],
    pub(crate) placement_terrains: [i16; 2],
    pub(crate) clearance_bits: [u32; 2],
    pub(crate) slope_mode: u8,
    pub(crate) fog_visibility: u8,
    pub(crate) restriction: i16,
    pub(crate) fly_mode: u8,
    pub(crate) resource_capacity: i16,
    pub(crate) interaction_mode: u8,
    pub(crate) minimap_mode: u8,
    pub(crate) interface_kind: u8,
    pub(crate) minimap_color_index: u8,
    pub(crate) occlusion_mode: u8,
    pub(crate) obstruction_type: u8,
    pub(crate) obstruction_class: u8,
    pub(crate) trait_bits: u8,
    pub(crate) civilization: u8,
    pub(crate) outline_bits: [u32; 3],
    pub(crate) resources: [DatResourceStorage; 3],
    pub(crate) damage_graphic_count: usize,
    pub(crate) convert_terrain: u8,
    pub(crate) copy_id: i16,
    pub(crate) base_id: i16,
    pub(crate) speed_bits: Option<u32>,
    pub(crate) tracking_unit_id: Option<i16>,
    pub(crate) projectile_unit_id: Option<i16>,
    pub(crate) train_locations: Vec<DatTrainLocation>,
    pub(crate) creatable_type: Option<u8>,
    pub(crate) building: Option<DatBuilding>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatCivilization {
    pub(crate) technology_tree_effect: i16,
    pub(crate) team_bonus_effect: i16,
    pub(crate) resource_bits: Vec<u32>,
    pub(crate) masters: Vec<Option<Box<DatMaster>>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatDocument {
    pub(crate) restrictions: Vec<DatRestriction>,
    pub(crate) graphics: Vec<Option<DatGraphic>>,
    pub(crate) terrains: Vec<DatTerrain>,
    pub(crate) effects: Vec<Vec<DatEffectCommand>>,
    pub(crate) civilizations: Vec<DatCivilization>,
    pub(crate) technologies: Vec<DatTechnology>,
}

pub(crate) fn decode_ver89(decompressed: &[u8]) -> Result<DatDocument, ContentError> {
    let mut cursor = Cursor::new(decompressed);
    if cursor.take(8)? != REVIEWED_DAT_HEADER {
        return Err(unsupported("header"));
    }
    let restrictions = read_restrictions(&mut cursor)?;
    let player_colours = cursor.count_u16(256, "DAT player colours")?;
    cursor.skip(player_colours, 36)?;
    skip_sounds(&mut cursor)?;
    let graphics = read_graphics(&mut cursor)?;
    let terrains = read_terrain_block(&mut cursor)?;
    skip_random_maps(&mut cursor)?;
    let effects = read_effects(&mut cursor)?;
    skip_unit_headers(&mut cursor)?;
    let civilization_count = cursor.count_u16(MAXIMUM_CIVILIZATIONS, "DAT civilizations")?;
    if civilization_count == 0 {
        return Err(unsupported("civilization table"));
    }
    let mut civilizations = Vec::with_capacity(civilization_count);
    let mut slot_count = None;
    for _ in 0..civilization_count {
        civilizations.push(read_civilization(
            &mut cursor,
            civilization_count,
            &mut slot_count,
        )?);
    }
    let technologies = read_technologies(&mut cursor)?;
    cursor.skip(7, 4)?;
    skip_technology_tree(&mut cursor)?;
    if cursor.at != decompressed.len() {
        return Err(unsupported("trailing technology-tree data"));
    }
    Ok(DatDocument {
        restrictions,
        graphics,
        terrains,
        effects,
        civilizations,
        technologies,
    })
}

fn read_restrictions(cursor: &mut Cursor<'_>) -> Result<Vec<DatRestriction>, ContentError> {
    let count = cursor.count_u16(MAXIMUM_RESTRICTIONS, "DAT restrictions")?;
    let terrains = cursor.count_u16(MAXIMUM_RESTRICTION_TERRAINS, "DAT restriction terrains")?;
    cursor.skip(count, 4)?;
    cursor.skip(count, 4)?;
    let mut rows = Vec::with_capacity(count);
    for _ in 0..count {
        let multiplier_bits = cursor.u32_array(terrains)?;
        cursor.skip(terrains, 16)?;
        rows.push(DatRestriction { multiplier_bits });
    }
    Ok(rows)
}

fn skip_sounds(cursor: &mut Cursor<'_>) -> Result<(), ContentError> {
    let sounds = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT sounds")?;
    for _ in 0..sounds {
        cursor.skip(1, 4)?;
        let items = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT sound items")?;
        cursor.skip(1, 6)?;
        for _ in 0..items {
            cursor.skip_debug_string()?;
            cursor.skip(1, 10)?;
        }
    }
    Ok(())
}

fn read_graphics(cursor: &mut Cursor<'_>) -> Result<Vec<Option<DatGraphic>>, ContentError> {
    let count = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT graphics")?;
    let pointers = cursor.u32_array(count)?;
    let mut graphics = Vec::with_capacity(count);
    for pointer in pointers {
        graphics.push(if pointer == 0 {
            None
        } else {
            Some(read_graphic(cursor)?)
        });
    }
    Ok(graphics)
}

fn read_graphic(cursor: &mut Cursor<'_>) -> Result<DatGraphic, ContentError> {
    cursor.skip_debug_string()?;
    let file_name = cursor.art_name()?;
    cursor.skip_debug_string()?;
    cursor.skip(1, 4)?;
    let layer = cursor.take(3)?[2];
    cursor.skip(1, 2)?;
    cursor.skip(1, 1)?;
    cursor.skip(4, 2)?;
    let delta_count = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT graphic deltas")?;
    cursor.skip(1, 2)?;
    cursor.skip(1, 4)?;
    let angle_sounds = cursor.u8()? != 0;
    let frame_count = cursor.u16()?;
    let angle_count = cursor.u16()?;
    cursor.skip(3, 4)?;
    let sequence_flags = cursor.u8()?;
    cursor.skip(1, 2)?;
    let mirroring_mode = cursor.u8()?;
    cursor.skip(1, 1)?;
    let mut deltas = Vec::with_capacity(cursor.capacity(delta_count, 16));
    for _ in 0..delta_count {
        let record = cursor.take(16)?;
        deltas.push(DatGraphicDelta {
            graphic_id: i16_at(record, 0),
            offset_x: i16_at(record, 8),
            offset_y: i16_at(record, 10),
            display_angle: i16_at(record, 12),
        });
    }
    if angle_sounds {
        let angles = bounded(
            usize::from(angle_count),
            MAXIMUM_NESTED_ROWS,
            "DAT angle sounds",
        )?;
        cursor.skip(angles, 24)?;
    }
    Ok(DatGraphic {
        file_name,
        layer,
        frame_count,
        angle_count,
        sequence_flags,
        mirroring_mode,
        deltas,
    })
}

fn read_terrain_block(cursor: &mut Cursor<'_>) -> Result<Vec<DatTerrain>, ContentError> {
    cursor.skip(1, 24)?;
    cursor.skip(19, 6)?;
    cursor.skip(1, 2)?;
    let mut terrains = Vec::with_capacity(TERRAIN_SLOTS);
    for _ in 0..TERRAIN_SLOTS {
        terrains.push(read_terrain(cursor)?);
    }
    cursor.skip(1, 63)?;
    Ok(terrains)
}

fn read_terrain(cursor: &mut Cursor<'_>) -> Result<DatTerrain, ContentError> {
    let flags = cursor.take(4)?;
    let name_string_id = cursor.u32()? as i32;
    cursor.skip_debug_string()?;
    let texture_name = cursor.art_name()?;
    let art = cursor.take(28)?;
    let blend_priority = i32::from_le_bytes([art[20], art[21], art[22], art[23]]);
    let blend_type = i32::from_le_bytes([art[24], art[25], art[26], art[27]]);
    let overlay_mask_name = cursor.art_name()?;
    let palette = cursor.take(8)?;
    cursor.skip(1, 22)?;
    cursor.skip(19, 6)?;
    let terrain_to_draw = cursor.i16()?;
    cursor.skip(2, 2)?;
    let masked = cursor.i16_array::<TERRAIN_APPEARANCE_SLOTS>()?;
    let ids = cursor.i16_array::<TERRAIN_APPEARANCE_SLOTS>()?;
    let densities = cursor.i16_array::<TERRAIN_APPEARANCE_SLOTS>()?;
    let centering = cursor.take(TERRAIN_APPEARANCE_SLOTS)?;
    let active_appearances = cursor.i16()?;
    cursor.skip(1, 2)?;
    Ok(DatTerrain {
        enabled: flags[0],
        name_string_id,
        random: flags[1],
        placement_class: flags[2],
        minimap_color_indices: [palette[0], palette[1], palette[2], palette[3], palette[4]],
        passable_terrain: palette[5],
        impassable_terrain: palette[6],
        texture_name,
        blend_priority,
        blend_type,
        overlay_mask_name,
        terrain_to_draw,
        appearances: (0..TERRAIN_APPEARANCE_SLOTS)
            .map(|index| DatTerrainAppearance {
                object_id: ids[index],
                density: densities[index],
                masked_density: masked[index],
                centering: centering[index],
            })
            .collect(),
        active_appearances,
    })
}

fn skip_random_maps(cursor: &mut Cursor<'_>) -> Result<(), ContentError> {
    let count = cursor.count_u32(MAXIMUM_NESTED_ROWS, "DAT random maps")?;
    cursor.skip(1, 4)?;
    for _ in 0..count * 2 {
        cursor.skip(1, 40)?;
        for width in [44, 24, 44, 24] {
            let rows = cursor.count_u32(MAXIMUM_NESTED_ROWS, "DAT random-map rows")?;
            cursor.skip(1, 4)?;
            cursor.skip(rows, width)?;
        }
    }
    Ok(())
}

fn read_effects(cursor: &mut Cursor<'_>) -> Result<Vec<Vec<DatEffectCommand>>, ContentError> {
    let count = cursor.count_u32(MAXIMUM_TABLE_ROWS, "DAT effects")?;
    let mut effects = Vec::with_capacity(cursor.capacity(count, 6));
    for _ in 0..count {
        cursor.skip_debug_string()?;
        let commands = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT effect commands")?;
        let mut rows = Vec::with_capacity(cursor.capacity(commands, 11));
        for _ in 0..commands {
            let bytes = cursor.take(11)?;
            rows.push(DatEffectCommand {
                kind: bytes[0],
                a: i16_at(bytes, 1),
                b: i16_at(bytes, 3),
                c: i16_at(bytes, 5),
                d_bits: u32_at(bytes, 7),
            });
        }
        effects.push(rows);
    }
    Ok(effects)
}

fn skip_unit_headers(cursor: &mut Cursor<'_>) -> Result<(), ContentError> {
    let count = cursor.count_u32(MAXIMUM_OBJECT_SLOTS, "DAT unit headers")?;
    for _ in 0..count {
        if cursor.u8()? != 0 {
            let tasks = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT unit-header tasks")?;
            cursor.skip(tasks, 69)?;
        }
    }
    Ok(())
}

fn read_civilization(
    cursor: &mut Cursor<'_>,
    civilization_count: usize,
    slot_count: &mut Option<usize>,
) -> Result<DatCivilization, ContentError> {
    cursor.skip(1, 1)?;
    cursor.skip_debug_string()?;
    let resources = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT civilization resources")?;
    let technology_tree_effect = cursor.i16()?;
    let team_bonus_effect = cursor.i16()?;
    let resource_bits = cursor.u32_array(resources)?;
    cursor.skip(1, 1)?;
    let slots = cursor.count_u16(MAXIMUM_OBJECT_SLOTS, "DAT object slots")?;
    match *slot_count {
        Some(expected) if expected != slots => {
            return Err(unsupported("owner-table object slot count"));
        }
        Some(_) => {}
        None => {
            bounded(
                civilization_count.saturating_mul(slots),
                MAXIMUM_TOTAL_OBJECT_SLOTS,
                "DAT owner-table object slots",
            )?;
            *slot_count = Some(slots);
        }
    }
    let pointers = cursor.u32_array(slots)?;
    let mut masters = Vec::with_capacity(slots);
    for (slot, pointer) in pointers.into_iter().enumerate() {
        masters.push(if pointer == 0 {
            None
        } else {
            Some(Box::new(read_master(cursor, slot)?))
        });
    }
    Ok(DatCivilization {
        technology_tree_effect,
        team_bonus_effect,
        resource_bits,
        masters,
    })
}

fn read_master(cursor: &mut Cursor<'_>, slot: usize) -> Result<DatMaster, ContentError> {
    let header = cursor.take(136)?;
    let kind = header[0];
    if usize::try_from(i16_at(header, 1)).ok() != Some(slot) {
        return Err(unsupported("object master identity"));
    }
    let storage = cursor.take(21)?;
    let resources = std::array::from_fn(|index| {
        let at = index * 7;
        DatResourceStorage {
            resource_type: i16_at(storage, at),
            quantity_bits: u32_at(storage, at + 2),
            mode: storage[at + 6],
        }
    });
    let damage_graphic_count = cursor.count_u8(usize::from(u8::MAX), "DAT damage graphics")?;
    cursor.skip(damage_graphic_count, 5)?;
    let sounds_and_terrain = cursor.take(22)?;
    cursor.skip_debug_string()?;
    let copy_id = cursor.i16()?;
    let base_id = cursor.i16()?;
    let mut master = DatMaster {
        kind,
        name_string_id: i32::from_le_bytes([header[3], header[4], header[5], header[6]]),
        class: i16_at(header, 11),
        standing_graphics: [i16_at(header, 13), i16_at(header, 15)],
        dying_graphic: i16_at(header, 17),
        hit_points: i16_at(header, 22),
        collision_bits: [u32_at(header, 29), u32_at(header, 33), u32_at(header, 37)],
        dead_unit_id: i16_at(header, 45),
        blood_unit_id: i16_at(header, 47),
        can_be_built_on: header[50],
        hide_in_editor: header[53],
        enabled: header[56],
        disabled: header[57],
        placement_side_terrains: [i16_at(header, 58), i16_at(header, 60)],
        placement_terrains: [i16_at(header, 62), i16_at(header, 64)],
        clearance_bits: [u32_at(header, 66), u32_at(header, 70)],
        slope_mode: header[74],
        fog_visibility: header[75],
        restriction: i16_at(header, 76),
        fly_mode: header[78],
        resource_capacity: i16_at(header, 79),
        interaction_mode: header[87],
        minimap_mode: header[88],
        interface_kind: header[89],
        minimap_color_index: header[94],
        occlusion_mode: header[107],
        obstruction_type: header[108],
        obstruction_class: header[109],
        trait_bits: header[110],
        civilization: header[111],
        outline_bits: [
            u32_at(header, 116),
            u32_at(header, 120),
            u32_at(header, 124),
        ],
        resources,
        damage_graphic_count,
        convert_terrain: sounds_and_terrain[21],
        copy_id,
        base_id,
        speed_bits: None,
        tracking_unit_id: None,
        projectile_unit_id: None,
        train_locations: Vec::new(),
        creatable_type: None,
        building: None,
    };
    if kind == 90 || kind < 20 {
        return Ok(master);
    }
    master.speed_bits = Some(cursor.u32()?);
    if kind >= 30 {
        let movement = cursor.take(41)?;
        master.tracking_unit_id = Some(i16_at(movement, 9));
    }
    if kind >= 40 {
        skip_task_bearing_actor(cursor)?;
    }
    if kind >= 50 {
        master.projectile_unit_id = Some(skip_combat(cursor)?);
    }
    if kind == 60 {
        cursor.skip(1, 9)?;
    }
    if kind >= 70 {
        let (train_locations, creatable_type) = read_creatable(cursor)?;
        master.train_locations = train_locations;
        master.creatable_type = Some(creatable_type);
    }
    if kind == 80 {
        master.building = Some(read_building(cursor)?);
    }
    Ok(master)
}

fn skip_task_bearing_actor(cursor: &mut Cursor<'_>) -> Result<(), ContentError> {
    cursor.skip(1, 10)?;
    let drop_sites = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT drop sites")?;
    cursor.skip(drop_sites, 2)?;
    cursor.skip(1, 14)?;
    let tasks = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT object tasks")?;
    cursor.skip(tasks, 69)
}

fn skip_combat(cursor: &mut Cursor<'_>) -> Result<i16, ContentError> {
    cursor.skip(1, 2)?;
    let attacks = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT attacks")?;
    cursor.skip(attacks, 4)?;
    let armours = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT armours")?;
    cursor.skip(armours, 4)?;
    let tail = cursor.take(80)?;
    Ok(i16_at(tail, 18))
}

fn read_creatable(cursor: &mut Cursor<'_>) -> Result<(Vec<DatTrainLocation>, u8), ContentError> {
    cursor.skip(3, 6)?;
    let locations = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT train locations")?;
    let mut train_locations = Vec::with_capacity(cursor.capacity(locations, 9));
    for _ in 0..locations {
        let row = cursor.take(9)?;
        train_locations.push(DatTrainLocation {
            build_time: i16_at(row, 0),
            unit_id: i16_at(row, 2),
        });
    }
    let tail = cursor.take(97)?;
    Ok((train_locations, tail[8]))
}

fn read_building(cursor: &mut Cursor<'_>) -> Result<DatBuilding, ContentError> {
    let head = cursor.take(25)?;
    let mut annexes = [DatAnnex {
        object_id: -1,
        x_offset_bits: 0,
        y_offset_bits: 0,
    }; 4];
    for annex in &mut annexes {
        let row = cursor.take(10)?;
        *annex = DatAnnex {
            object_id: i16_at(row, 0),
            x_offset_bits: u32_at(row, 2),
            y_offset_bits: u32_at(row, 6),
        };
    }
    let tail = cursor.take(33)?;
    Ok(DatBuilding {
        construction_graphic_id: i16_at(head, 0),
        snow_graphic_id: i16_at(head, 2),
        adjacent_mode: head[12],
        graphics_angle: i16_at(head, 13),
        disappears_when_built: head[15],
        stack_unit_id: i16_at(head, 16),
        foundation_terrain_id: i16_at(head, 18),
        old_overlap_id: i16_at(head, 20),
        technology_id: i16_at(head, 22),
        annexes,
        head_unit_id: i16_at(tail, 0),
        transform_unit_id: i16_at(tail, 2),
        pile_unit_id: i16_at(tail, 25),
    })
}

fn read_technologies(cursor: &mut Cursor<'_>) -> Result<Vec<DatTechnology>, ContentError> {
    let count = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT technologies")?;
    let mut technologies = Vec::with_capacity(cursor.capacity(count, 60));
    for _ in 0..count {
        let required_technologies = cursor.i16_array::<6>()?;
        cursor.skip(3, 5)?;
        let required_count = cursor.i16()?;
        let civilization = cursor.i16()?;
        let full_tech_mode = cursor.i16()?;
        cursor.skip(2, 4)?;
        let effect_id = cursor.i16()?;
        cursor.skip(2, 2)?;
        cursor.skip(2, 4)?;
        cursor.skip_debug_string()?;
        cursor.skip(1, 1)?;
        let locations = cursor.count_u16(MAXIMUM_NESTED_ROWS, "DAT research locations")?;
        let mut research_locations = Vec::with_capacity(cursor.capacity(locations, 9));
        for _ in 0..locations {
            let row = cursor.take(9)?;
            research_locations.push(DatResearchLocation {
                location_unit_id: i16_at(row, 0),
                research_time: i16_at(row, 2),
            });
        }
        technologies.push(DatTechnology {
            required_technologies,
            required_count,
            civilization,
            full_tech_mode,
            effect_id,
            research_locations,
        });
    }
    Ok(technologies)
}

fn skip_technology_tree(cursor: &mut Cursor<'_>) -> Result<(), ContentError> {
    let ages = cursor.count_u8(usize::from(u8::MAX), "DAT tree ages")?;
    let buildings = cursor.count_u8(usize::from(u8::MAX), "DAT tree buildings")?;
    let units = cursor.count_u16(MAXIMUM_TABLE_ROWS, "DAT tree units")?;
    let research = cursor.count_u8(usize::from(u8::MAX), "DAT tree research")?;
    cursor.skip(1, 4)?;
    for _ in 0..ages {
        cursor.skip(1, 5)?;
        skip_identity_lists(cursor, 3)?;
        cursor.skip(1, 84)?;
        cursor.skip(1, 22)?;
        cursor.skip(1, 4)?;
    }
    for _ in 0..buildings {
        cursor.skip(1, 5)?;
        skip_identity_lists(cursor, 3)?;
        cursor.skip(1, 84)?;
        cursor.skip(1, 11)?;
        cursor.skip(2, 4)?;
    }
    for _ in 0..units {
        cursor.skip(1, 9)?;
        cursor.skip(1, 84)?;
        cursor.skip(1, 4)?;
        skip_identity_lists(cursor, 1)?;
        cursor.skip(4, 4)?;
    }
    for _ in 0..research {
        cursor.skip(1, 9)?;
        skip_identity_lists(cursor, 3)?;
        cursor.skip(1, 84)?;
        cursor.skip(3, 4)?;
    }
    Ok(())
}

fn skip_identity_lists(cursor: &mut Cursor<'_>, lists: usize) -> Result<(), ContentError> {
    for _ in 0..lists {
        let count = cursor.count_u8(usize::from(u8::MAX), "DAT tree identity list")?;
        cursor.skip(count, 4)?;
    }
    Ok(())
}

#[cfg(any(test, feature = "synthetic-dat-fixture"))]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod synthetic {
    use super::*;

    #[derive(Default)]
    struct Writer(Vec<u8>);

    impl Writer {
        fn u8(&mut self, value: u8) {
            self.0.push(value);
        }
        fn u16(&mut self, value: u16) {
            self.0.extend_from_slice(&value.to_le_bytes());
        }
        fn i16(&mut self, value: i16) {
            self.0.extend_from_slice(&value.to_le_bytes());
        }
        fn u32(&mut self, value: u32) {
            self.0.extend_from_slice(&value.to_le_bytes());
        }
        fn zeros(&mut self, count: usize) {
            self.0.resize(self.0.len() + count, 0);
        }
        fn debug_string(&mut self) {
            self.named_string("");
        }
        fn named_string(&mut self, value: &str) {
            self.u16(DEBUG_STRING_MARKER);
            self.u16(value.len() as u16);
            self.0.extend_from_slice(value.as_bytes());
        }
        fn record(&mut self, width: usize, fill: impl FnOnce(&mut [u8])) {
            let mut bytes = vec![0; width];
            fill(&mut bytes);
            self.0.extend_from_slice(&bytes);
        }
    }

    fn put_i16(bytes: &mut [u8], offset: usize, value: i16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn encode_ver89(document: &DatDocument) -> Vec<u8> {
        encode_with_identities(document, |slot| slot)
    }

    pub(crate) fn encode_with_identities(
        document: &DatDocument,
        identity: impl Fn(usize) -> usize,
    ) -> Vec<u8> {
        let mut out = Writer::default();
        out.0.extend_from_slice(REVIEWED_DAT_HEADER);
        let terrains = document
            .restrictions
            .first()
            .map_or(0, |row| row.multiplier_bits.len());
        out.u16(document.restrictions.len() as u16);
        out.u16(terrains as u16);
        out.zeros(document.restrictions.len() * 8);
        for row in &document.restrictions {
            assert_eq!(row.multiplier_bits.len(), terrains);
            for bits in &row.multiplier_bits {
                out.u32(*bits);
            }
            out.zeros(terrains * 16);
        }
        out.u16(0);
        out.u16(0);
        out.u16(document.graphics.len() as u16);
        for graphic in &document.graphics {
            out.u32(u32::from(graphic.is_some()));
        }
        for graphic in document.graphics.iter().flatten() {
            out.debug_string();
            out.named_string(&graphic.file_name);
            out.debug_string();
            out.zeros(4 + 2);
            out.u8(graphic.layer);
            out.zeros(2 + 1 + 8);
            out.u16(graphic.deltas.len() as u16);
            out.zeros(2 + 4);
            out.u8(0);
            out.u16(graphic.frame_count);
            out.u16(graphic.angle_count);
            out.zeros(12);
            out.u8(graphic.sequence_flags);
            out.zeros(2);
            out.u8(graphic.mirroring_mode);
            out.zeros(1);
            for delta in &graphic.deltas {
                out.record(16, |bytes| {
                    put_i16(bytes, 0, delta.graphic_id);
                    put_i16(bytes, 8, delta.offset_x);
                    put_i16(bytes, 10, delta.offset_y);
                    put_i16(bytes, 12, delta.display_angle);
                });
            }
        }
        assert_eq!(document.terrains.len(), TERRAIN_SLOTS);
        out.zeros(24 + 19 * 6 + 2);
        for terrain in &document.terrains {
            out.record(4, |bytes| {
                bytes[0] = terrain.enabled;
                bytes[1] = terrain.random;
                bytes[2] = terrain.placement_class;
            });
            out.u32(terrain.name_string_id as u32);
            out.debug_string();
            out.named_string(&terrain.texture_name);
            out.zeros(20);
            out.u32(terrain.blend_priority as u32);
            out.u32(terrain.blend_type as u32);
            out.named_string(&terrain.overlay_mask_name);
            out.record(8, |bytes| {
                bytes[..5].copy_from_slice(&terrain.minimap_color_indices);
                bytes[5] = terrain.passable_terrain;
                bytes[6] = terrain.impassable_terrain;
            });
            out.zeros(22 + 19 * 6);
            out.i16(terrain.terrain_to_draw);
            out.zeros(4);
            assert_eq!(terrain.appearances.len(), TERRAIN_APPEARANCE_SLOTS);
            for appearance in &terrain.appearances {
                out.i16(appearance.masked_density);
            }
            for appearance in &terrain.appearances {
                out.i16(appearance.object_id);
            }
            for appearance in &terrain.appearances {
                out.i16(appearance.density);
            }
            for appearance in &terrain.appearances {
                out.u8(appearance.centering);
            }
            out.i16(terrain.active_appearances);
            out.zeros(2);
        }
        out.zeros(63);
        out.u32(0);
        out.zeros(4);
        out.u32(document.effects.len() as u32);
        for commands in &document.effects {
            out.debug_string();
            out.u16(commands.len() as u16);
            for command in commands {
                out.u8(command.kind);
                out.i16(command.a);
                out.i16(command.b);
                out.i16(command.c);
                out.u32(command.d_bits);
            }
        }
        out.u32(0);
        out.u16(document.civilizations.len() as u16);
        for civilization in &document.civilizations {
            out.zeros(1);
            out.debug_string();
            out.u16(civilization.resource_bits.len() as u16);
            out.i16(civilization.technology_tree_effect);
            out.i16(civilization.team_bonus_effect);
            for bits in &civilization.resource_bits {
                out.u32(*bits);
            }
            out.zeros(1);
            out.u16(civilization.masters.len() as u16);
            for master in &civilization.masters {
                out.u32(u32::from(master.is_some()));
            }
            for (slot, master) in civilization.masters.iter().enumerate() {
                if let Some(master) = master {
                    encode_master(&mut out, identity(slot), master);
                }
            }
        }
        out.u16(document.technologies.len() as u16);
        for technology in &document.technologies {
            for required in technology.required_technologies {
                out.i16(required);
            }
            out.zeros(15);
            out.i16(technology.required_count);
            out.i16(technology.civilization);
            out.i16(technology.full_tech_mode);
            out.zeros(8);
            out.i16(technology.effect_id);
            out.zeros(4 + 8);
            out.debug_string();
            out.zeros(1);
            out.u16(technology.research_locations.len() as u16);
            for location in &technology.research_locations {
                out.record(9, |bytes| {
                    put_i16(bytes, 0, location.location_unit_id);
                    put_i16(bytes, 2, location.research_time);
                });
            }
        }
        out.zeros(7 * 4);
        out.u8(0);
        out.u8(0);
        out.u16(0);
        out.u8(0);
        out.zeros(4);
        out.0
    }

    fn encode_master(out: &mut Writer, slot: usize, master: &DatMaster) {
        out.record(136, |header| {
            header[0] = master.kind;
            put_i16(header, 1, slot as i16);
            put_u32(header, 3, master.name_string_id as u32);
            put_i16(header, 11, master.class);
            put_i16(header, 13, master.standing_graphics[0]);
            put_i16(header, 15, master.standing_graphics[1]);
            put_i16(header, 17, master.dying_graphic);
            put_i16(header, 22, master.hit_points);
            for (index, bits) in master.collision_bits.iter().enumerate() {
                put_u32(header, 29 + index * 4, *bits);
            }
            put_i16(header, 45, master.dead_unit_id);
            put_i16(header, 47, master.blood_unit_id);
            header[50] = master.can_be_built_on;
            header[53] = master.hide_in_editor;
            header[56] = master.enabled;
            header[57] = master.disabled;
            put_i16(header, 58, master.placement_side_terrains[0]);
            put_i16(header, 60, master.placement_side_terrains[1]);
            put_i16(header, 62, master.placement_terrains[0]);
            put_i16(header, 64, master.placement_terrains[1]);
            put_u32(header, 66, master.clearance_bits[0]);
            put_u32(header, 70, master.clearance_bits[1]);
            header[74] = master.slope_mode;
            header[75] = master.fog_visibility;
            put_i16(header, 76, master.restriction);
            header[78] = master.fly_mode;
            put_i16(header, 79, master.resource_capacity);
            header[87] = master.interaction_mode;
            header[88] = master.minimap_mode;
            header[94] = master.minimap_color_index;
            header[89] = master.interface_kind;
            header[107] = master.occlusion_mode;
            header[108] = master.obstruction_type;
            header[109] = master.obstruction_class;
            header[110] = master.trait_bits;
            header[111] = master.civilization;
            for (index, bits) in master.outline_bits.iter().enumerate() {
                put_u32(header, 116 + index * 4, *bits);
            }
        });
        for storage in &master.resources {
            out.i16(storage.resource_type);
            out.u32(storage.quantity_bits);
            out.u8(storage.mode);
        }
        out.u8(master.damage_graphic_count as u8);
        out.zeros(master.damage_graphic_count * 5);
        out.record(22, |bytes| bytes[21] = master.convert_terrain);
        out.debug_string();
        out.i16(master.copy_id);
        out.i16(master.base_id);
        let kind = master.kind;
        if kind == 90 || kind < 20 {
            return;
        }
        out.u32(master.speed_bits.expect("moving masters carry a speed"));
        if kind >= 30 {
            out.record(41, |bytes| {
                put_i16(bytes, 9, master.tracking_unit_id.expect("tracking unit"))
            });
        }
        if kind >= 40 {
            out.zeros(10);
            out.u16(0);
            out.zeros(14);
            out.u16(0);
        }
        if kind >= 50 {
            out.zeros(2);
            out.u16(0);
            out.u16(0);
            out.record(80, |bytes| {
                put_i16(
                    bytes,
                    18,
                    master.projectile_unit_id.expect("projectile unit"),
                )
            });
        }
        if kind == 60 {
            out.zeros(9);
        }
        if kind >= 70 {
            out.zeros(18);
            out.u16(master.train_locations.len() as u16);
            for location in &master.train_locations {
                out.record(9, |bytes| {
                    put_i16(bytes, 0, location.build_time);
                    put_i16(bytes, 2, location.unit_id);
                });
            }
            out.record(97, |bytes| {
                bytes[8] = master.creatable_type.expect("creatable type")
            });
        }
        if kind == 80 {
            let building = master.building.as_ref().expect("building section");
            out.record(25, |bytes| {
                put_i16(bytes, 0, building.construction_graphic_id);
                put_i16(bytes, 2, building.snow_graphic_id);
                bytes[12] = building.adjacent_mode;
                put_i16(bytes, 13, building.graphics_angle);
                bytes[15] = building.disappears_when_built;
                put_i16(bytes, 16, building.stack_unit_id);
                put_i16(bytes, 18, building.foundation_terrain_id);
                put_i16(bytes, 20, building.old_overlap_id);
                put_i16(bytes, 22, building.technology_id);
            });
            for annex in &building.annexes {
                out.i16(annex.object_id);
                out.u32(annex.x_offset_bits);
                out.u32(annex.y_offset_bits);
            }
            out.record(33, |bytes| {
                put_i16(bytes, 0, building.head_unit_id);
                put_i16(bytes, 2, building.transform_unit_id);
                put_i16(bytes, 25, building.pile_unit_id);
            });
        }
    }

    fn f(value: f32) -> u32 {
        value.to_bits()
    }

    fn master(kind: u8, class: i16) -> DatMaster {
        let moving = !(kind == 90 || kind < 20);
        DatMaster {
            kind,
            name_string_id: 5000 + i32::from(kind),
            class,
            standing_graphics: [-1, -1],
            dying_graphic: -1,
            hit_points: 10,
            collision_bits: [f(0.25), f(0.25), f(1.0)],
            dead_unit_id: -1,
            blood_unit_id: -1,
            can_be_built_on: 0,
            hide_in_editor: 0,
            enabled: 1,
            disabled: 0,
            placement_side_terrains: [-1, -1],
            placement_terrains: [-1, -1],
            clearance_bits: [f(0.25), f(0.25)],
            slope_mode: 0,
            fog_visibility: 0,
            restriction: 0,
            fly_mode: 0,
            resource_capacity: 0,
            interaction_mode: 0,
            minimap_mode: 0,
            interface_kind: 0,
            minimap_color_index: 0,
            occlusion_mode: 0,
            obstruction_type: 2,
            obstruction_class: 1,
            trait_bits: 0,
            civilization: 0,
            outline_bits: [0; 3],
            resources: [DatResourceStorage {
                resource_type: -1,
                quantity_bits: 0,
                mode: 0,
            }; 3],
            damage_graphic_count: 0,
            convert_terrain: 0,
            copy_id: -1,
            base_id: -1,
            speed_bits: moving.then(|| f(1.0)),
            tracking_unit_id: (moving && kind >= 30).then_some(-1),
            projectile_unit_id: (moving && kind >= 50).then_some(-1),
            train_locations: Vec::new(),
            creatable_type: (moving && kind >= 70).then_some(1),
            building: None,
        }
    }

    fn technology(
        required: &[i16],
        required_count: i16,
        civilization: i16,
        effect_id: i16,
        automatic: bool,
    ) -> DatTechnology {
        let mut required_technologies = [-1; 6];
        required_technologies[..required.len()].copy_from_slice(required);
        DatTechnology {
            required_technologies,
            required_count,
            civilization,
            full_tech_mode: 0,
            effect_id,
            research_locations: vec![if automatic {
                DatResearchLocation {
                    location_unit_id: -1,
                    research_time: 0,
                }
            } else {
                DatResearchLocation {
                    location_unit_id: 3,
                    research_time: 30,
                }
            }],
        }
    }

    pub(crate) fn synthetic_art_document() -> DatDocument {
        let mut document = synthetic_document();
        document.terrains[0].texture_name = "synthetic_land".to_owned();
        document.terrains[0].blend_priority = 110;
        document.terrains[0].blend_type = 0;
        document.terrains[0].overlay_mask_name = "synthetic_mask.png".to_owned();
        document.terrains[1].texture_name = "synthetic_water".to_owned();
        document.terrains[1].blend_priority = 170;
        document.terrains[1].blend_type = 3;
        document.terrains[1].placement_class = 4;
        document.terrains[2].texture_name = "..\\escape".to_owned();
        document.terrains[3].enabled = 0;
        document.terrains[3].texture_name = "synthetic_disabled".to_owned();
        let graphics = &mut document.graphics;
        let tree = graphics[0].as_mut().unwrap();
        tree.file_name = "synthetic_tree_x1".to_owned();
        tree.layer = 20;
        let unit = graphics[2].as_mut().unwrap();
        unit.file_name = "synthetic_unit_x1".to_owned();
        unit.deltas = vec![
            DatGraphicDelta {
                graphic_id: 0,
                offset_x: 4,
                offset_y: -2,
                display_angle: -1,
            },
            DatGraphicDelta {
                graphic_id: -1,
                offset_x: 0,
                offset_y: 0,
                display_angle: -1,
            },
            DatGraphicDelta {
                graphic_id: 2,
                offset_x: 0,
                offset_y: 0,
                display_angle: -1,
            },
        ];
        for civilization in &mut document.civilizations {
            if let Some(tree) = civilization.masters[0].as_mut() {
                tree.standing_graphics = [0, -1];
            }
            if let Some(unit) = civilization.masters[1].as_mut() {
                unit.standing_graphics = [2, -1];
            }
        }
        document
    }

    pub(crate) fn synthetic_document() -> DatDocument {
        let mut restrictions = vec![
            DatRestriction {
                multiplier_bits: vec![0; TERRAIN_SLOTS],
            };
            20
        ];
        restrictions[0].multiplier_bits = vec![f(1.0); TERRAIN_SLOTS];
        for (row, terrains) in [(7, [0, 2]), (19, [1, 2]), (4, [0, 0])] {
            for terrain in terrains {
                restrictions[row].multiplier_bits[terrain] = f(1.0);
            }
        }
        let graphic = |angle_count, sequence_flags| DatGraphic {
            file_name: String::new(),
            layer: 0,
            frame_count: 10,
            angle_count,
            sequence_flags,
            mirroring_mode: 0,
            deltas: vec![DatGraphicDelta {
                graphic_id: -1,
                offset_x: 1,
                offset_y: -1,
                display_angle: -1,
            }],
        };
        let empty_appearance = DatTerrainAppearance {
            object_id: -1,
            density: 0,
            masked_density: 0,
            centering: 0,
        };
        let mut terrains = vec![
            DatTerrain {
                enabled: 1,
                name_string_id: 10_000,
                random: 0,
                placement_class: 0,
                minimap_color_indices: [0; 5],
                passable_terrain: 0,
                impassable_terrain: 0,
                texture_name: String::new(),
                blend_priority: 0,
                blend_type: 0,
                overlay_mask_name: String::new(),
                terrain_to_draw: -1,
                appearances: vec![empty_appearance.clone(); TERRAIN_APPEARANCE_SLOTS],
                active_appearances: 0,
            };
            TERRAIN_SLOTS
        ];
        terrains[0].placement_class = 1;
        terrains[0].appearances[0] = DatTerrainAppearance {
            object_id: 0,
            density: 100,
            masked_density: 0,
            centering: 1,
        };
        terrains[0].active_appearances = 1;
        let spawn = |spawned, building, count| DatEffectCommand {
            kind: 7,
            a: spawned,
            b: building,
            c: count,
            d_bits: 0,
        };
        let effects = vec![
            vec![DatEffectCommand {
                kind: 102,
                a: -1,
                b: -1,
                c: -1,
                d_bits: f(3.0),
            }],
            vec![spawn(4, 3, 2)],
            vec![spawn(4, 3, 1)],
        ];
        let mut tree = master(10, 15);
        tree.standing_graphics = [0, -1];
        tree.resources[0] = DatResourceStorage {
            resource_type: 0,
            quantity_bits: f(100.0),
            mode: 1,
        };
        let mut building = master(80, 3);
        building.building = Some(DatBuilding {
            construction_graphic_id: -1,
            snow_graphic_id: -1,
            adjacent_mode: 0,
            graphics_angle: 0,
            disappears_when_built: 0,
            stack_unit_id: -1,
            foundation_terrain_id: -1,
            old_overlap_id: -1,
            technology_id: 2,
            annexes: [
                DatAnnex {
                    object_id: 4,
                    x_offset_bits: f(1.0),
                    y_offset_bits: f(-1.0),
                },
                DatAnnex {
                    object_id: 6,
                    x_offset_bits: 0,
                    y_offset_bits: 0,
                },
                DatAnnex {
                    object_id: -1,
                    x_offset_bits: 0,
                    y_offset_bits: 0,
                },
                DatAnnex {
                    object_id: -1,
                    x_offset_bits: 0,
                    y_offset_bits: 0,
                },
            ],
            head_unit_id: -1,
            transform_unit_id: -1,
            pile_unit_id: -1,
        });
        let mut villager = master(70, 4);
        villager.train_locations = vec![DatTrainLocation {
            build_time: 0,
            unit_id: 3,
        }];
        let gaia_masters = vec![
            Some(Box::new(tree.clone())),
            Some(Box::new(master(30, 6))),
            Some(Box::new(villager.clone())),
            Some(Box::new(building.clone())),
            Some(Box::new(master(70, 6))),
            None,
            None,
            Some(Box::new(master(10, -1))),
        ];
        let mut player_masters = gaia_masters.clone();
        player_masters[5] = Some(Box::new(master(70, 6)));
        let mut sloped = player_masters.clone();
        sloped[0].as_mut().unwrap().slope_mode = 2;
        let mut resource_bits = vec![0; 100];
        resource_bits[82] = f(1.0);
        let civilization =
            |technology_tree_effect, resource_bits: Vec<u32>, masters| DatCivilization {
                technology_tree_effect,
                team_bonus_effect: 0,
                resource_bits,
                masters,
            };
        DatDocument {
            restrictions,
            graphics: vec![Some(graphic(8, 0)), None, Some(graphic(16, 0x06))],
            terrains,
            effects,
            civilizations: vec![
                civilization(-1, vec![0; 100], gaia_masters),
                civilization(-1, resource_bits, player_masters),
                civilization(0, vec![0; 100], sloped),
            ],
            technologies: vec![
                technology(&[], 0, -1, -1, true),
                technology(&[0, 2], 2, -1, 1, true),
                technology(&[], 0, -1, -1, false),
                technology(&[0], 1, -1, -1, false),
                technology(&[], 0, -1, -1, false),
                technology(&[0, 9], 2, 1, 2, true),
                technology(&[], 0, -1, -1, false),
                technology(&[], 0, -1, -1, false),
                technology(&[], 0, -1, -1, false),
                technology(&[], 0, -1, -1, false),
            ],
        }
    }
}
