use super::dds::blit_block;
use super::{GameArtError, Image, Reader};

pub const MAXIMUM_SLD_BYTES: usize = 256 * 1024 * 1024;
pub const MAXIMUM_SLD_FRAMES: usize = 16_384;
pub const MAXIMUM_SLD_CANVAS: u16 = 4_096;
const MAXIMUM_REUSE_CHAIN: usize = 256;

const MAIN: u8 = 0x01;
const SHADOW: u8 = 0x02;
const UNKNOWN: u8 = 0x04;
const DAMAGE: u8 = 0x08;
const PLAYER: u8 = 0x10;
const LAYERS: [u8; 5] = [MAIN, SHADOW, UNKNOWN, DAMAGE, PLAYER];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LayerRef {
    commands: usize,
    end: usize,
    rect: [u16; 4],
    flags: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FrameRef {
    canvas_width: u16,
    canvas_height: u16,
    hotspot_x: i16,
    hotspot_y: i16,
    main: Option<LayerRef>,
    player: Option<LayerRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SldLayer {
    pub x: u16,
    pub y: u16,
    pub image: Image,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SldFrame {
    pub canvas_width: u16,
    pub canvas_height: u16,
    pub hotspot_x: i16,
    pub hotspot_y: i16,
    pub main: Option<SldLayer>,
    pub player: Option<SldLayer>,
}

#[derive(Debug)]
pub struct SldFile<'a> {
    bytes: &'a [u8],
    frames: Vec<FrameRef>,
}

impl<'a> SldFile<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, GameArtError> {
        if bytes.len() > MAXIMUM_SLD_BYTES {
            return Err(GameArtError::Limit("SLD file"));
        }
        let reader = Reader::new(bytes, "SLD file");
        if reader.slice(0, 4)? != b"SLDX" {
            return Err(GameArtError::Unsupported("SLD signature".to_owned()));
        }
        let version = reader.u16(4)?;
        if version != 4 {
            return Err(GameArtError::Unsupported(format!("SLD version {version}")));
        }
        let count = usize::from(reader.u16(6)?);
        if count > MAXIMUM_SLD_FRAMES {
            return Err(GameArtError::Limit("SLD frames"));
        }
        let mut frames = Vec::with_capacity(count);
        let mut at = 16;
        for _ in 0..count {
            let canvas_width = reader.u16(at)?;
            let canvas_height = reader.u16(at + 2)?;
            let hotspot_x = reader.i16(at + 4)?;
            let hotspot_y = reader.i16(at + 6)?;
            let kind = reader.u8(at + 8)?;
            at += 12;
            if canvas_width > MAXIMUM_SLD_CANVAS || canvas_height > MAXIMUM_SLD_CANVAS {
                return Err(GameArtError::Limit("SLD canvas"));
            }
            if kind & !(MAIN | SHADOW | UNKNOWN | DAMAGE | PLAYER) != 0 {
                return Err(GameArtError::Unsupported(format!(
                    "SLD frame type {kind:#04x}"
                )));
            }
            let mut frame = FrameRef {
                canvas_width,
                canvas_height,
                hotspot_x,
                hotspot_y,
                main: None,
                player: None,
            };
            let mut main_rect = None;
            for layer in LAYERS {
                if kind & layer == 0 {
                    continue;
                }
                let length = reader.u32(at)? as usize;
                let end = at
                    .checked_add(length)
                    .filter(|end| length >= 4 && *end <= bytes.len())
                    .ok_or(GameArtError::Truncated("SLD layer"))?;
                let full = matches!(layer, MAIN | SHADOW | UNKNOWN);
                let (rect, flags, commands) = if full {
                    let rect = [
                        reader.u16(at + 4)?,
                        reader.u16(at + 6)?,
                        reader.u16(at + 8)?,
                        reader.u16(at + 10)?,
                    ];
                    (rect, reader.u8(at + 12)?, at + 14)
                } else {
                    let rect = main_rect.ok_or(GameArtError::Invalid("SLD mask without image"))?;
                    (rect, reader.u8(at + 4)?, at + 6)
                };
                if commands > end {
                    return Err(GameArtError::Truncated("SLD layer header"));
                }
                if layer != UNKNOWN {
                    let [x1, y1, x2, y2] = rect;
                    if x1 > x2 || y1 > y2 || x2 > canvas_width || y2 > canvas_height {
                        return Err(GameArtError::Invalid("SLD layer rectangle"));
                    }
                }
                let reference = LayerRef {
                    commands,
                    end,
                    rect,
                    flags,
                };
                match layer {
                    MAIN => {
                        main_rect = Some(rect);
                        frame.main = Some(reference);
                    }
                    PLAYER => frame.player = Some(reference),
                    _ => {}
                }
                at = end + (4 - length % 4) % 4;
            }
            frames.push(frame);
        }
        Ok(Self { bytes, frames })
    }

    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    #[must_use]
    pub fn has_main_image(&self, index: usize) -> bool {
        self.frames
            .get(index)
            .and_then(|frame| frame.main)
            .is_some_and(|layer| {
                let [x1, y1, x2, y2] = layer.rect;
                x2 > x1 && y2 > y1
            })
    }

    pub fn decode(&self, index: usize) -> Result<SldFrame, GameArtError> {
        let frame = self
            .frames
            .get(index)
            .ok_or(GameArtError::Invalid("SLD frame index"))?;
        let nonempty =
            |layer: SldLayer| (layer.image.width > 0 && layer.image.height > 0).then_some(layer);
        let main = frame
            .main
            .map(|layer| self.decode_layer(index, layer, MAIN))
            .transpose()?
            .and_then(nonempty);
        let player = frame
            .player
            .map(|layer| self.decode_layer(index, layer, PLAYER))
            .transpose()?
            .and_then(nonempty);
        Ok(SldFrame {
            canvas_width: frame.canvas_width,
            canvas_height: frame.canvas_height,
            hotspot_x: frame.hotspot_x,
            hotspot_y: frame.hotspot_y,
            main,
            player,
        })
    }

    fn layer_of(&self, index: usize, kind: u8) -> Option<LayerRef> {
        let frame = self.frames.get(index)?;
        if kind == MAIN {
            frame.main
        } else {
            frame.player
        }
    }

    fn decode_layer(
        &self,
        index: usize,
        layer: LayerRef,
        kind: u8,
    ) -> Result<SldLayer, GameArtError> {
        let mut chain = vec![(index, layer)];
        let mut current = index;
        while chain.len() <= MAXIMUM_REUSE_CHAIN
            && chain.last().is_some_and(|(_, layer)| layer.flags & 1 != 0)
            && current > 0
        {
            current -= 1;
            match self.layer_of(current, kind) {
                Some(previous) => chain.push((current, previous)),
                None => break,
            }
        }
        let mut previous: Option<SldLayer> = None;
        for (_, layer) in chain.into_iter().rev() {
            let reuse = if layer.flags & 1 != 0 {
                previous.as_ref()
            } else {
                None
            };
            previous = Some(self.decode_one(layer, kind, reuse)?);
        }
        previous.ok_or(GameArtError::Invalid("SLD layer"))
    }

    fn decode_one(
        &self,
        layer: LayerRef,
        kind: u8,
        reuse: Option<&SldLayer>,
    ) -> Result<SldLayer, GameArtError> {
        let [x1, y1, x2, y2] = layer.rect;
        let (width, height) = (x2 - x1, y2 - y1);
        let channels: u8 = if kind == MAIN { 4 } else { 1 };
        let reader = Reader::new(&self.bytes[..layer.end], "SLD layer");
        let command_count = usize::from(reader.u16(layer.commands)?);
        let commands = reader.slice(layer.commands + 2, command_count * 2)?;
        let mut data_at = layer.commands + 2 + command_count * 2;
        if width == 0 || height == 0 {
            return Ok(SldLayer {
                x: x1,
                y: y1,
                image: Image {
                    width: u32::from(width),
                    height: u32::from(height),
                    channels,
                    pixels: Vec::new(),
                },
            });
        }
        let mut image = Image::blank(u32::from(width), u32::from(height), channels)
            .ok_or(GameArtError::Limit("SLD layer"))?;
        let blocks_wide = usize::from(width).div_ceil(4);
        let block_count = blocks_wide * usize::from(height).div_ceil(4);
        let mut position = 0_usize;
        let mut block = [0_u8; 64];
        for pair in commands.chunks_exact(2) {
            let (skip, draw) = (usize::from(pair[0]), usize::from(pair[1]));
            if position + skip + draw > block_count {
                return Err(GameArtError::Invalid("SLD block commands"));
            }
            if let Some(source) = reuse {
                for skipped in position..position + skip {
                    copy_reused_block(
                        &mut image,
                        (x1, y1),
                        source,
                        skipped % blocks_wide,
                        skipped / blocks_wide,
                    );
                }
            }
            position += skip;
            for _ in 0..draw {
                let compressed = reader.slice(data_at, 8)?;
                data_at += 8;
                if kind == MAIN {
                    bcdec_rs::bc1(compressed, &mut block, 16);
                } else {
                    bcdec_rs::bc4(compressed, &mut block[..16], 4, false);
                }
                blit_block(
                    &mut image,
                    &block,
                    usize::from(channels),
                    position % blocks_wide,
                    position / blocks_wide,
                );
                position += 1;
            }
        }
        Ok(SldLayer {
            x: x1,
            y: y1,
            image,
        })
    }
}

fn copy_reused_block(
    image: &mut Image,
    origin: (u16, u16),
    source: &SldLayer,
    block_x: usize,
    block_y: usize,
) {
    let channels = usize::from(image.channels);
    if source.image.channels != image.channels {
        return;
    }
    for row in 0..4 {
        for column in 0..4 {
            let x = block_x * 4 + column;
            let y = block_y * 4 + row;
            if x >= image.width as usize || y >= image.height as usize {
                continue;
            }
            let canvas_x = usize::from(origin.0) + x;
            let canvas_y = usize::from(origin.1) + y;
            let (Some(sx), Some(sy)) = (
                canvas_x.checked_sub(usize::from(source.x)),
                canvas_y.checked_sub(usize::from(source.y)),
            ) else {
                continue;
            };
            if sx >= source.image.width as usize || sy >= source.image.height as usize {
                continue;
            }
            let target = (y * image.width as usize + x) * channels;
            let from = (sy * source.image.width as usize + sx) * channels;
            image.pixels[target..target + channels]
                .copy_from_slice(&source.image.pixels[from..from + channels]);
        }
    }
}
