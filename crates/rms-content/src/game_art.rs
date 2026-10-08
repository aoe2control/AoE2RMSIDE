mod catalog;
pub mod dds;
pub mod png;
pub mod sld;

pub use catalog::{
    ArtAnnex, ArtDelta, ArtGraphic, ArtMaster, ArtPart, ArtTerrain, GAME_ART_BLEND_ATLASES,
    GameArtCatalog, MAXIMUM_OBJECT_ART_PARTS, ObjectArt, read_aoe2de_dat_game_art,
};

use thiserror::Error;

#[must_use]
pub fn is_asset_name(name: &str) -> bool {
    crate::dat::is_art_name(name.as_bytes())
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum GameArtError {
    #[error("{0} is truncated")]
    Truncated(&'static str),
    #[error("{0} exceeds its bound")]
    Limit(&'static str),
    #[error("{0} is invalid")]
    Invalid(&'static str),
    #[error("unsupported {0}")]
    Unsupported(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub pixels: Vec<u8>,
}

impl Image {
    #[must_use]
    pub fn blank(width: u32, height: u32, channels: u8) -> Option<Self> {
        if width == 0 || height == 0 || !(1..=4).contains(&channels) {
            return None;
        }
        let length = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(usize::from(channels))?;
        Some(Self {
            width,
            height,
            channels,
            pixels: vec![0; length],
        })
    }

    fn stride(&self) -> usize {
        self.width as usize * usize::from(self.channels)
    }

    #[must_use]
    pub fn first_channel(&self) -> Self {
        let channels = usize::from(self.channels);
        Self {
            width: self.width,
            height: self.height,
            channels: 1,
            pixels: self.pixels.chunks_exact(channels).map(|px| px[0]).collect(),
        }
    }

    #[must_use]
    pub fn rgb(&self) -> Self {
        let channels = usize::from(self.channels);
        let mut pixels = Vec::with_capacity(self.width as usize * self.height as usize * 3);
        for px in self.pixels.chunks_exact(channels) {
            if channels >= 3 {
                pixels.extend_from_slice(&px[..3]);
            } else {
                pixels.extend_from_slice(&[px[0], px[0], px[0]]);
            }
        }
        Self {
            width: self.width,
            height: self.height,
            channels: 3,
            pixels,
        }
    }

    #[must_use]
    pub fn flipped_horizontally(&self) -> Self {
        let channels = usize::from(self.channels);
        let stride = self.stride();
        let mut pixels = Vec::with_capacity(self.pixels.len());
        for row in self.pixels.chunks_exact(stride) {
            for px in row.chunks_exact(channels).rev() {
                pixels.extend_from_slice(px);
            }
        }
        Self {
            width: self.width,
            height: self.height,
            channels: self.channels,
            pixels,
        }
    }

    #[must_use]
    pub fn half(&self) -> Self {
        let channels = usize::from(self.channels);
        let width = self.width.div_ceil(2).max(1);
        let height = self.height.div_ceil(2).max(1);
        let stride = self.stride();
        let mut pixels = Vec::with_capacity(width as usize * height as usize * channels);
        for y in 0..height as usize {
            for x in 0..width as usize {
                for channel in 0..channels {
                    let mut sum = 0_u32;
                    let mut count = 0_u32;
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let sx = x * 2 + dx;
                            let sy = y * 2 + dy;
                            if sx < self.width as usize && sy < self.height as usize {
                                sum +=
                                    u32::from(self.pixels[sy * stride + sx * channels + channel]);
                                count += 1;
                            }
                        }
                    }
                    pixels.push(((sum + count / 2) / count) as u8);
                }
            }
        }
        Self {
            width,
            height,
            channels: self.channels,
            pixels,
        }
    }
}

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    label: &'static str,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8], label: &'static str) -> Self {
        Self { bytes, label }
    }

    pub(crate) fn slice(&self, at: usize, length: usize) -> Result<&'a [u8], GameArtError> {
        at.checked_add(length)
            .and_then(|end| self.bytes.get(at..end))
            .ok_or(GameArtError::Truncated(self.label))
    }

    pub(crate) fn u8(&self, at: usize) -> Result<u8, GameArtError> {
        Ok(self.slice(at, 1)?[0])
    }

    pub(crate) fn u16(&self, at: usize) -> Result<u16, GameArtError> {
        let bytes = self.slice(at, 2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(crate) fn i16(&self, at: usize) -> Result<i16, GameArtError> {
        self.u16(at).map(|value| value as i16)
    }

    pub(crate) fn u32(&self, at: usize) -> Result<u32, GameArtError> {
        let bytes = self.slice(at, 4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}
