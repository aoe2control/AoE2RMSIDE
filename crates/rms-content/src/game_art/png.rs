use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;

use super::{GameArtError, Image};

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
pub const MAXIMUM_PNG_BYTES: usize = 64 * 1024 * 1024;
pub const MAXIMUM_PNG_EDGE: u32 = 8_192;
const MAXIMUM_CHUNKS: usize = 65_536;

fn be32(bytes: &[u8], at: usize) -> Result<u32, GameArtError> {
    at.checked_add(4)
        .and_then(|end| bytes.get(at..end))
        .map(|value| u32::from_be_bytes([value[0], value[1], value[2], value[3]]))
        .ok_or(GameArtError::Truncated("PNG chunk"))
}

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = flate2::Crc::new();
    for part in parts {
        crc.update(part);
    }
    crc.sum()
}

pub fn decode(bytes: &[u8]) -> Result<Image, GameArtError> {
    if bytes.len() > MAXIMUM_PNG_BYTES {
        return Err(GameArtError::Limit("PNG file"));
    }
    if bytes.get(..8) != Some(&SIGNATURE[..]) {
        return Err(GameArtError::Unsupported("PNG signature".to_owned()));
    }
    let mut at = 8;
    let mut header: Option<(u32, u32, u8)> = None;
    let mut palette: Option<&[u8]> = None;
    let mut compressed = Vec::new();
    let mut ended = false;
    for index in 0.. {
        if index >= MAXIMUM_CHUNKS {
            return Err(GameArtError::Limit("PNG chunks"));
        }
        let length = be32(bytes, at)? as usize;
        let kind = bytes
            .get(at + 4..at + 8)
            .ok_or(GameArtError::Truncated("PNG chunk"))?;
        let data_start = at + 8;
        let data = data_start
            .checked_add(length)
            .and_then(|end| bytes.get(data_start..end))
            .ok_or(GameArtError::Truncated("PNG chunk"))?;
        let stored_crc = be32(bytes, data_start + length)?;
        if crc32(&[kind, data]) != stored_crc {
            return Err(GameArtError::Invalid("PNG chunk checksum"));
        }
        at = data_start + length + 4;
        match kind {
            b"IHDR" => {
                if index != 0 || data.len() != 13 {
                    return Err(GameArtError::Invalid("PNG header"));
                }
                let width = be32(data, 0)?;
                let height = be32(data, 4)?;
                let (depth, color, method, filter, interlace) =
                    (data[8], data[9], data[10], data[11], data[12]);
                if width == 0
                    || height == 0
                    || width > MAXIMUM_PNG_EDGE
                    || height > MAXIMUM_PNG_EDGE
                {
                    return Err(GameArtError::Limit("PNG dimensions"));
                }
                if depth != 8 || method != 0 || filter != 0 || interlace != 0 {
                    return Err(GameArtError::Unsupported(format!(
                        "PNG form (depth {depth}, interlace {interlace})"
                    )));
                }
                if !matches!(color, 0 | 2 | 3 | 4 | 6) {
                    return Err(GameArtError::Unsupported(format!(
                        "PNG colour type {color}"
                    )));
                }
                header = Some((width, height, color));
            }
            _ if header.is_none() => return Err(GameArtError::Invalid("PNG header")),
            b"PLTE" => {
                if data.is_empty() || data.len() % 3 != 0 || data.len() > 768 {
                    return Err(GameArtError::Invalid("PNG palette"));
                }
                palette = Some(data);
            }
            b"IDAT" => compressed.extend_from_slice(data),
            b"IEND" => {
                ended = true;
                break;
            }
            _ if kind[0].is_ascii_lowercase() => {}
            _ => return Err(GameArtError::Unsupported("PNG critical chunk".to_owned())),
        }
    }
    let Some((width, height, color)) = header else {
        return Err(GameArtError::Invalid("PNG header"));
    };
    if !ended {
        return Err(GameArtError::Truncated("PNG end"));
    }
    let samples = match color {
        0 | 3 => 1,
        4 => 2,
        2 => 3,
        _ => 4,
    };
    let stride = width as usize * samples;
    let expected = (stride + 1)
        .checked_mul(height as usize)
        .ok_or(GameArtError::Limit("PNG image"))?;
    let mut raw = Vec::with_capacity(expected);
    ZlibDecoder::new(compressed.as_slice())
        .take(expected as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| GameArtError::Invalid("PNG image data"))?;
    if raw.len() != expected {
        return Err(GameArtError::Invalid("PNG image data length"));
    }
    let mut pixels = vec![0_u8; stride * height as usize];
    for row in 0..height as usize {
        let filter = raw[row * (stride + 1)];
        let line = &raw[row * (stride + 1) + 1..(row + 1) * (stride + 1)];
        let (done, rest) = pixels.split_at_mut(row * stride);
        let previous = if row == 0 {
            None
        } else {
            Some(&done[(row - 1) * stride..])
        };
        let current = &mut rest[..stride];
        unfilter(filter, line, previous, current, samples)?;
    }
    if color == 3 {
        let palette = palette.ok_or(GameArtError::Invalid("PNG palette"))?;
        let mut rgb = Vec::with_capacity(pixels.len() * 3);
        for index in pixels {
            let at = usize::from(index) * 3;
            let entry = palette
                .get(at..at + 3)
                .ok_or(GameArtError::Invalid("PNG palette index"))?;
            rgb.extend_from_slice(entry);
        }
        return Ok(Image {
            width,
            height,
            channels: 3,
            pixels: rgb,
        });
    }
    Ok(Image {
        width,
        height,
        channels: samples as u8,
        pixels,
    })
}

fn paeth(left: u8, up: u8, up_left: u8) -> u8 {
    let estimate = i16::from(left) + i16::from(up) - i16::from(up_left);
    let (a, b, c) = (
        (estimate - i16::from(left)).abs(),
        (estimate - i16::from(up)).abs(),
        (estimate - i16::from(up_left)).abs(),
    );
    if a <= b && a <= c {
        left
    } else if b <= c {
        up
    } else {
        up_left
    }
}

fn unfilter(
    filter: u8,
    line: &[u8],
    previous: Option<&[u8]>,
    current: &mut [u8],
    samples: usize,
) -> Result<(), GameArtError> {
    for index in 0..line.len() {
        let left = if index >= samples {
            current[index - samples]
        } else {
            0
        };
        let up = previous.map_or(0, |row| row[index]);
        let up_left = if index >= samples {
            previous.map_or(0, |row| row[index - samples])
        } else {
            0
        };
        let predictor = match filter {
            0 => 0,
            1 => left,
            2 => up,
            3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
            4 => paeth(left, up, up_left),
            _ => return Err(GameArtError::Invalid("PNG filter type")),
        };
        current[index] = line[index].wrapping_add(predictor);
    }
    Ok(())
}

fn chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(kind);
    output.extend_from_slice(data);
    output.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

pub fn encode(image: &Image) -> Result<Vec<u8>, GameArtError> {
    let color = match image.channels {
        1 => 0,
        2 => 4,
        3 => 2,
        4 => 6,
        _ => return Err(GameArtError::Invalid("PNG channels")),
    };
    let samples = usize::from(image.channels);
    let stride = image.width as usize * samples;
    if image.width == 0 || image.height == 0 || image.pixels.len() != stride * image.height as usize
    {
        return Err(GameArtError::Invalid("PNG image"));
    }
    let mut filtered = Vec::with_capacity((stride + 1) * image.height as usize);
    for row in 0..image.height as usize {
        let current = &image.pixels[row * stride..(row + 1) * stride];
        let previous = (row > 0).then(|| &image.pixels[(row - 1) * stride..row * stride]);
        filtered.push(4);
        for index in 0..stride {
            let left = if index >= samples {
                current[index - samples]
            } else {
                0
            };
            let up = previous.map_or(0, |row| row[index]);
            let up_left = if index >= samples {
                previous.map_or(0, |row| row[index - samples])
            } else {
                0
            };
            filtered.push(current[index].wrapping_sub(paeth(left, up, up_left)));
        }
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(&filtered)
        .map_err(|_| GameArtError::Invalid("PNG compression"))?;
    let compressed = encoder
        .finish()
        .map_err(|_| GameArtError::Invalid("PNG compression"))?;
    let mut output = SIGNATURE.to_vec();
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&image.width.to_be_bytes());
    header.extend_from_slice(&image.height.to_be_bytes());
    header.extend_from_slice(&[8, color, 0, 0, 0]);
    chunk(&mut output, b"IHDR", &header);
    chunk(&mut output, b"IDAT", &compressed);
    chunk(&mut output, b"IEND", &[]);
    Ok(output)
}
