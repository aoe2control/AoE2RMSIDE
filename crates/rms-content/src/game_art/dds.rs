use super::{GameArtError, Image, Reader};

pub const MAXIMUM_DDS_EDGE: u32 = 16_384;
pub const MAXIMUM_DDS_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_MIP_LEVELS: u32 = 16;
const HEADER_BYTES: usize = 128;
const DX10_HEADER_BYTES: usize = 20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Encoding {
    Bc1,
    Bc3,
    Bc7,
    Raw32 { rgba: bool },
}

impl Encoding {
    fn level_bytes(self, width: u32, height: u32) -> Option<usize> {
        let blocks = |edge: u32| (edge.max(1) as usize).div_ceil(4);
        match self {
            Self::Bc1 => blocks(width).checked_mul(blocks(height))?.checked_mul(8),
            Self::Bc3 | Self::Bc7 => blocks(width).checked_mul(blocks(height))?.checked_mul(16),
            Self::Raw32 { .. } => (width.max(1) as usize)
                .checked_mul(height.max(1) as usize)?
                .checked_mul(4),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DdsInfo {
    pub width: u32,
    pub height: u32,
    pub levels: u32,
    encoding: Encoding,
    data_offset: usize,
}

pub fn inspect(bytes: &[u8]) -> Result<DdsInfo, GameArtError> {
    if bytes.len() > MAXIMUM_DDS_BYTES {
        return Err(GameArtError::Limit("DDS file"));
    }
    let reader = Reader::new(bytes, "DDS header");
    if reader.slice(0, 4)? != b"DDS " || reader.u32(4)? != 124 {
        return Err(GameArtError::Unsupported("DDS signature".to_owned()));
    }
    let height = reader.u32(12)?;
    let width = reader.u32(16)?;
    let levels = reader.u32(28)?.max(1);
    if width == 0 || height == 0 || width > MAXIMUM_DDS_EDGE || height > MAXIMUM_DDS_EDGE {
        return Err(GameArtError::Limit("DDS dimensions"));
    }
    if levels > MAXIMUM_MIP_LEVELS {
        return Err(GameArtError::Limit("DDS mip levels"));
    }
    if reader.u32(76)? != 32 {
        return Err(GameArtError::Invalid("DDS pixel format"));
    }
    let flags = reader.u32(80)?;
    let four_cc = reader.slice(84, 4)?;
    let (encoding, data_offset) = if flags & 0x4 != 0 {
        match four_cc {
            b"DXT1" => (Encoding::Bc1, HEADER_BYTES),
            b"DXT5" => (Encoding::Bc3, HEADER_BYTES),
            b"DX10" => {
                let format = match reader.u32(HEADER_BYTES)? {
                    71 | 72 => Encoding::Bc1,
                    77 | 78 => Encoding::Bc3,
                    98 | 99 => Encoding::Bc7,
                    other => {
                        return Err(GameArtError::Unsupported(format!("DXGI format {other}")));
                    }
                };
                if reader.u32(HEADER_BYTES + 4)? != 3 || reader.u32(HEADER_BYTES + 12)? > 1 {
                    return Err(GameArtError::Unsupported("DX10 resource layout".to_owned()));
                }
                (format, HEADER_BYTES + DX10_HEADER_BYTES)
            }
            other => {
                return Err(GameArtError::Unsupported(format!(
                    "DDS encoding {}",
                    String::from_utf8_lossy(other).escape_debug()
                )));
            }
        }
    } else if flags & 0x40 != 0 && reader.u32(88)? == 32 {
        let masks = (reader.u32(92)?, reader.u32(96)?, reader.u32(100)?);
        match masks {
            (0x0000_00ff, 0x0000_ff00, 0x00ff_0000) => {
                (Encoding::Raw32 { rgba: true }, HEADER_BYTES)
            }
            (0x00ff_0000, 0x0000_ff00, 0x0000_00ff) => {
                (Encoding::Raw32 { rgba: false }, HEADER_BYTES)
            }
            _ => return Err(GameArtError::Unsupported("DDS channel masks".to_owned())),
        }
    } else {
        return Err(GameArtError::Unsupported("DDS pixel format".to_owned()));
    };
    let mut end = data_offset;
    for level in 0..levels {
        let size = encoding
            .level_bytes(width >> level, height >> level)
            .ok_or(GameArtError::Limit("DDS level"))?;
        end = end
            .checked_add(size)
            .ok_or(GameArtError::Limit("DDS level"))?;
    }
    if end > bytes.len() {
        return Err(GameArtError::Truncated("DDS levels"));
    }
    Ok(DdsInfo {
        width,
        height,
        levels,
        encoding,
        data_offset,
    })
}

pub fn decode_level(bytes: &[u8], info: &DdsInfo, level: u32) -> Result<Image, GameArtError> {
    if level >= info.levels {
        return Err(GameArtError::Invalid("DDS level index"));
    }
    let mut offset = info.data_offset;
    for previous in 0..level {
        offset += info
            .encoding
            .level_bytes(info.width >> previous, info.height >> previous)
            .ok_or(GameArtError::Limit("DDS level"))?;
    }
    let width = (info.width >> level).max(1);
    let height = (info.height >> level).max(1);
    let size = info
        .encoding
        .level_bytes(width, height)
        .ok_or(GameArtError::Limit("DDS level"))?;
    let data = Reader::new(bytes, "DDS level").slice(offset, size)?;
    let mut image = Image::blank(width, height, 4).ok_or(GameArtError::Limit("DDS level"))?;
    match info.encoding {
        Encoding::Raw32 { rgba } => {
            for (target, source) in image.pixels.chunks_exact_mut(4).zip(data.chunks_exact(4)) {
                if rgba {
                    target.copy_from_slice(source);
                } else {
                    target.copy_from_slice(&[source[2], source[1], source[0], source[3]]);
                }
            }
        }
        encoding => {
            let block_bytes = if encoding == Encoding::Bc1 { 8 } else { 16 };
            let blocks_wide = (width as usize).div_ceil(4);
            let mut block = [0_u8; 64];
            for (index, compressed) in data.chunks_exact(block_bytes).enumerate() {
                match encoding {
                    Encoding::Bc1 => bcdec_rs::bc1(compressed, &mut block, 16),
                    Encoding::Bc3 => bcdec_rs::bc3(compressed, &mut block, 16),
                    _ => bcdec_rs::bc7(compressed, &mut block, 16),
                }
                blit_block(
                    &mut image,
                    &block,
                    4,
                    index % blocks_wide,
                    index / blocks_wide,
                );
            }
        }
    }
    Ok(image)
}

pub(crate) fn blit_block(
    image: &mut Image,
    block: &[u8],
    channels: usize,
    block_x: usize,
    block_y: usize,
) {
    let stride = image.width as usize * channels;
    for row in 0..4 {
        let y = block_y * 4 + row;
        if y >= image.height as usize {
            break;
        }
        let x = block_x * 4;
        if x >= image.width as usize {
            break;
        }
        let columns = (image.width as usize - x).min(4);
        let target = y * stride + x * channels;
        let source = row * 4 * channels;
        image.pixels[target..target + columns * channels]
            .copy_from_slice(&block[source..source + columns * channels]);
    }
}

pub fn decode_terrain_texture(bytes: &[u8], target_edge: u32) -> Result<Image, GameArtError> {
    let info = inspect(bytes)?;
    let target_edge = target_edge.max(1);
    let fitting = (0..info.levels)
        .find(|level| (info.width >> level).max(info.height >> level) <= target_edge);
    let mut image = decode_level(bytes, &info, fitting.unwrap_or(info.levels - 1))?;
    while image.width.max(image.height) > target_edge {
        image = image.half();
    }
    Ok(image.rgb())
}
