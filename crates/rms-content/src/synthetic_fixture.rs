use std::io::Write;

use crate::dat::synthetic::{encode_ver89, synthetic_document};
use crate::native_bindings::{NativeContentBindings, load_native_content_bindings};

pub const SYNTHETIC_DAT_PROFILE_ID: &str = "synthetic-dat-profile";

pub const SYNTHETIC_OBJECT_REPLACEMENTS: &str = r#"{"objects": [
    {"name": "chance", "object_id": 1, "object_override": {"replacement_object": 4, "chance": 50}},
    {"name": "gated", "object_id": 2, "object_override": {
        "replacement_object": 4, "required_attribute": 82,
        "technology": [3], "technology_state": 3}}
]}"#;

pub const SYNTHETIC_DEFINITIONS_SOURCE: &str = "#const SYNTHETIC_TREE 0\n";

pub fn synthetic_aoe2de_dat(compression_level: u32) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(
        Vec::new(),
        flate2::Compression::new(compression_level.min(9)),
    );
    encoder
        .write_all(&encode_ver89(&synthetic_document()))
        .expect("in-memory deflate");
    encoder.finish().expect("in-memory deflate")
}

pub fn synthetic_native_bindings() -> NativeContentBindings {
    let value = serde_json::json!({
        "$schema": "https://rmside.invalid/schemas/native-content-bindings/v1",
        "schemaVersion": "1.1.0",
        "compatibility": { "minimumMajor": 1, "maximumMajor": 1 },
        "behaviorProfileId": SYNTHETIC_DAT_PROFILE_ID,
        "terrainClassRestrictions": { "land": 7, "water": 19, "buildable": 4 },
        "terrainTopology": {
            "cliffFacetTerrainId": 16,
            "cliffOverlayTerrainId": 70,
            "defaultShorelineTerrainId": 2,
            "excludedShorelineWaterTerrainIds": [],
            "fillTerrainId": 0,
            "frozenShorelineTerrainId": 37
        },
        "nativeGenerationBindings": {
            "defaultTerrainId": 0,
            "flatOnlyTerrainId": 1,
            "wallAnchorObjectIds": [3],
            "classes": { "farm": 49, "tree": 15, "wall": 27, "gate": 39, "tower": 52 },
            "constructionSiteExemptions": { "objectIds": [], "classIds": [51, 54] }
        },
        "objectPlacementClasses": { "cliffZoneClassId": 34, "forestZoneClassId": 15 },
        "rmsPathReferenceObjectId": 2,
        "restrictionClassificationClassMasks": [1, 2],
        "cliffs": {
            "terrainId": 16,
            "styleBaseObjectIds": [0],
            "pieceRules": [{
                "edges": [-1, 0, -1, 0],
                "primary": { "slot": 0, "facet": 0 },
                "xOffset256": 384,
                "yOffset256": 384
            }]
        },
        "compositeTerrainRules": [],
        "foundationTerrainRules": [],
        "foundationOmittedCells": [],
        "gameModeTerrainRules": [],
        "gameModePlayerObjectRules": [],
        "wallPlacementRules": [],
        "constructionRetirementRequiresHeight": [],
        "restrictionZoneConstructor": { "objectIds": [], "excludedClassIds": [] },
        "constructorResourceOverride": {
            "classIds": [],
            "state": { "resourceType": 0, "quantityF32Bits": 0 }
        },
        "singleRequestCounts": []
    });
    load_native_content_bindings(
        &serde_json::to_vec(&value).expect("fixture bindings serialize"),
        SYNTHETIC_DAT_PROFILE_ID,
    )
    .expect("fixture bindings load")
}

pub mod art {
    use std::io::Write;

    use crate::dat::synthetic::{encode_ver89, synthetic_art_document};

    pub fn synthetic_game_art_dat() -> Vec<u8> {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder
            .write_all(&encode_ver89(&synthetic_art_document()))
            .expect("in-memory deflate");
        encoder.finish().expect("in-memory deflate")
    }

    pub fn synthetic_png(width: u32, height: u32, channels: u8) -> Vec<u8> {
        let mut pixels = Vec::new();
        for y in 0..height {
            for x in 0..width {
                for channel in 0..channels {
                    pixels.push((x * 17 + y * 31 + u32::from(channel) * 7) as u8);
                }
            }
        }
        crate::game_art::png::encode(&crate::game_art::Image {
            width,
            height,
            channels,
            pixels,
        })
        .expect("synthetic PNG encodes")
    }

    pub fn dds_header(width: u32, height: u32, levels: u32, four_cc: &[u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0_u8; 128];
        bytes[..4].copy_from_slice(b"DDS ");
        bytes[4..8].copy_from_slice(&124_u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&height.to_le_bytes());
        bytes[16..20].copy_from_slice(&width.to_le_bytes());
        bytes[28..32].copy_from_slice(&levels.to_le_bytes());
        bytes[76..80].copy_from_slice(&32_u32.to_le_bytes());
        bytes[80..84].copy_from_slice(&4_u32.to_le_bytes());
        bytes[84..88].copy_from_slice(four_cc);
        bytes
    }

    pub fn solid_bc1(color: u16) -> [u8; 8] {
        let [low, high] = color.to_le_bytes();
        [low, high, 0, 0, 0, 0, 0, 0]
    }

    pub fn synthetic_bc1_dds(width: u32, height: u32, levels: u32) -> Vec<u8> {
        let mut bytes = dds_header(width, height, levels, b"DXT1");
        for level in 0..levels {
            let blocks = ((width >> level).max(1) as usize).div_ceil(4)
                * ((height >> level).max(1) as usize).div_ceil(4);
            let color = if level == 0 { 0xf800 } else { 0x001f };
            for _ in 0..blocks {
                bytes.extend_from_slice(&solid_bc1(color));
            }
        }
        bytes
    }

    pub struct SyntheticFrame {
        pub canvas: (u16, u16),
        pub hotspot: (i16, i16),
        pub rect: [u16; 4],
        pub skip: u8,
        pub colors: Vec<u16>,
        pub reuse: bool,
        pub player: Option<u8>,
        pub shadow: bool,
    }

    fn layer(out: &mut Vec<u8>, header: &[u8], commands: &[(u8, u8)], blocks: &[[u8; 8]]) {
        let mut content = header.to_vec();
        content.extend_from_slice(&(commands.len() as u16).to_le_bytes());
        for (skip, draw) in commands {
            content.extend_from_slice(&[*skip, *draw]);
        }
        for block in blocks {
            content.extend_from_slice(block);
        }
        let length = content.len() + 4;
        out.extend_from_slice(&(length as u32).to_le_bytes());
        out.extend_from_slice(&content);
        out.resize(out.len() + (4 - length % 4) % 4, 0);
    }

    pub fn synthetic_sld(frames: &[SyntheticFrame]) -> Vec<u8> {
        let mut out = b"SLDX".to_vec();
        out.extend_from_slice(&4_u16.to_le_bytes());
        out.extend_from_slice(&(frames.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0, 0, 0x10, 0, 0, 0, 0, 0xff]);
        for (index, frame) in frames.iter().enumerate() {
            let mut kind = 0x01_u8;
            if frame.shadow {
                kind |= 0x02;
            }
            if frame.player.is_some() {
                kind |= 0x10;
            }
            out.extend_from_slice(&frame.canvas.0.to_le_bytes());
            out.extend_from_slice(&frame.canvas.1.to_le_bytes());
            out.extend_from_slice(&frame.hotspot.0.to_le_bytes());
            out.extend_from_slice(&frame.hotspot.1.to_le_bytes());
            out.extend_from_slice(&[kind, 1]);
            out.extend_from_slice(&(index as u16).to_le_bytes());
            let mut header = Vec::new();
            for value in frame.rect {
                header.extend_from_slice(&value.to_le_bytes());
            }
            header.extend_from_slice(&[u8::from(frame.reuse), 0]);
            let blocks: Vec<[u8; 8]> = frame.colors.iter().map(|c| solid_bc1(*c)).collect();
            layer(
                &mut out,
                &header,
                &[(frame.skip, frame.colors.len() as u8)],
                &blocks,
            );
            if frame.shadow {
                layer(&mut out, &header, &[(0, 1)], &[[9; 8]]);
            }
            if let Some(value) = frame.player {
                layer(
                    &mut out,
                    &[0, 0],
                    &[(frame.skip, frame.colors.len() as u8)],
                    &vec![[value, value, 0, 0, 0, 0, 0, 0]; frame.colors.len()],
                );
            }
        }
        out
    }
}
