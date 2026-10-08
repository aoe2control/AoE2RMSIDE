use std::sync::Arc;

use thiserror::Error;

const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ByteOffset(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRange {
    pub start: ByteOffset,
    pub end: ByteOffset,
}

impl ByteRange {
    pub fn new(start: ByteOffset, end: ByteOffset) -> Result<Self, SourceError> {
        if start > end {
            return Err(SourceError::ReversedRange);
        }
        Ok(Self { start, end })
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Utf16Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Utf16Range {
    pub start: Utf16Position,
    pub end: Utf16Position,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SourceId(Arc<str>);

impl SourceId {
    pub fn new(value: impl Into<Arc<str>>) -> Result<Self, SourceError> {
        let value = value.into();
        if value.is_empty() || value.len() > 4096 {
            return Err(SourceError::InvalidSourceId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceEncoding {
    Utf8,
    Utf8Bom,
    Windows1252,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NewlineStyle {
    None,
    Lf,
    CrLf,
    Cr,
    Mixed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceText {
    id: SourceId,
    bytes: Arc<[u8]>,
    text: Arc<str>,
    encoding: SourceEncoding,
    newline_style: NewlineStyle,
    line_index: Arc<LineIndex>,
}

impl SourceText {
    pub fn from_bytes(id: SourceId, bytes: impl Into<Arc<[u8]>>) -> Result<Self, SourceError> {
        let bytes = bytes.into();
        if bytes.len() > u32::MAX as usize {
            return Err(SourceError::TooLarge);
        }
        let (encoding, text, units, content_start) = decode_source(&bytes)?;
        let newline_style = detect_newline_style(&text);
        let line_index = Arc::new(LineIndex::from_units(&units, content_start)?);
        drop(units);
        Ok(Self {
            id,
            bytes,
            text: text.into(),
            encoding,
            newline_style,
            line_index,
        })
    }

    pub fn validate_bytes(bytes: &[u8]) -> Result<SourceEncoding, SourceError> {
        if bytes.len() > u32::MAX as usize {
            return Err(SourceError::TooLarge);
        }
        if let Some(content) = bytes.strip_prefix(UTF8_BOM) {
            std::str::from_utf8(content).map_err(|error| SourceError::InvalidUtf8 {
                offset: u32::try_from(UTF8_BOM.len() + error.valid_up_to()).unwrap_or(u32::MAX),
            })?;
            return Ok(SourceEncoding::Utf8Bom);
        }
        if std::str::from_utf8(bytes).is_ok() {
            return Ok(SourceEncoding::Utf8);
        }
        for (index, byte) in bytes.iter().copied().enumerate() {
            decode_windows_1252(byte).ok_or(SourceError::InvalidLegacyByte {
                offset: u32::try_from(index).unwrap_or(u32::MAX),
                byte,
            })?;
        }
        Ok(SourceEncoding::Windows1252)
    }

    pub fn id(&self) -> &SourceId {
        &self.id
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn encoding(&self) -> SourceEncoding {
        self.encoding
    }

    pub const fn newline_style(&self) -> NewlineStyle {
        self.newline_style
    }

    pub fn line_index(&self) -> &LineIndex {
        &self.line_index
    }

    pub fn byte_to_utf16(&self, offset: ByteOffset) -> Result<Utf16Position, SourceError> {
        self.line_index.byte_to_utf16(offset)
    }

    pub fn utf16_to_byte(&self, position: Utf16Position) -> Result<ByteOffset, SourceError> {
        self.line_index.utf16_to_byte(position)
    }

    pub fn byte_range_to_utf16(&self, range: ByteRange) -> Result<Utf16Range, SourceError> {
        if range.start > range.end {
            return Err(SourceError::ReversedRange);
        }
        Ok(Utf16Range {
            start: self.byte_to_utf16(range.start)?,
            end: self.byte_to_utf16(range.end)?,
        })
    }

    pub fn byte_range_to_utf16_near(
        &self,
        range: ByteRange,
        cursor: &mut usize,
    ) -> Result<Utf16Range, SourceError> {
        if range.start > range.end {
            return Err(SourceError::ReversedRange);
        }
        Ok(Utf16Range {
            start: self.line_index.byte_to_utf16_near(range.start, cursor)?,
            end: self.line_index.byte_to_utf16_near(range.end, cursor)?,
        })
    }

    pub fn encode_edited(&self, edited_text: &str) -> Result<Vec<u8>, SourceError> {
        if edited_text == self.text() {
            return Ok(self.bytes.to_vec());
        }
        let normalized = normalize_newlines(edited_text, self.newline_style);
        match self.encoding {
            SourceEncoding::Utf8 => Ok(normalized.into_bytes()),
            SourceEncoding::Utf8Bom => {
                let mut encoded = Vec::with_capacity(UTF8_BOM.len() + normalized.len());
                encoded.extend_from_slice(UTF8_BOM);
                encoded.extend_from_slice(normalized.as_bytes());
                Ok(encoded)
            }
            SourceEncoding::Windows1252 => encode_windows_1252(&normalized),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Boundary {
    byte: ByteOffset,
    position: Utf16Position,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LineIndex {
    boundaries_by_byte: Vec<Boundary>,
    line_starts: Vec<u32>,
}

impl LineIndex {
    fn from_units(units: &[DecodedUnit], content_start: u32) -> Result<Self, SourceError> {
        let mut by_byte = Vec::with_capacity(units.len() + 1);
        let mut line_starts = vec![0_u32];
        let mut position = Utf16Position {
            line: 0,
            character: 0,
        };
        push_boundary(&mut by_byte, content_start, position)?;

        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            if unit.character == '\r'
                && units
                    .get(index + 1)
                    .is_some_and(|next| next.character == '\n')
            {
                let next = units[index + 1];
                position = Utf16Position {
                    line: position.line.checked_add(1).ok_or(SourceError::TooLarge)?,
                    character: 0,
                };
                start_line(&mut line_starts, &by_byte)?;
                push_boundary(&mut by_byte, next.raw_end, position)?;
                index += 2;
                continue;
            }
            if unit.character == '\r' || unit.character == '\n' {
                position = Utf16Position {
                    line: position.line.checked_add(1).ok_or(SourceError::TooLarge)?,
                    character: 0,
                };
                start_line(&mut line_starts, &by_byte)?;
                push_boundary(&mut by_byte, unit.raw_end, position)?;
                index += 1;
                continue;
            }
            position.character = position
                .character
                .checked_add(unit.character.len_utf16() as u32)
                .ok_or(SourceError::TooLarge)?;
            push_boundary(&mut by_byte, unit.raw_end, position)?;
            index += 1;
        }
        Ok(Self {
            boundaries_by_byte: by_byte,
            line_starts,
        })
    }

    pub fn byte_to_utf16(&self, offset: ByteOffset) -> Result<Utf16Position, SourceError> {
        self.boundaries_by_byte
            .binary_search_by_key(&offset, |boundary| boundary.byte)
            .map(|index| self.boundaries_by_byte[index].position)
            .map_err(|_| SourceError::InvalidByteBoundary(offset))
    }

    pub fn byte_to_utf16_near(
        &self,
        offset: ByteOffset,
        cursor: &mut usize,
    ) -> Result<Utf16Position, SourceError> {
        let boundaries = &self.boundaries_by_byte;
        let at = (*cursor).min(boundaries.len().saturating_sub(1));
        let (low, high) = if boundaries.get(at).is_some_and(|start| start.byte <= offset) {
            let (mut low, mut step) = (at, 1);
            loop {
                let probe = at.saturating_add(step);
                if probe >= boundaries.len() {
                    break (low, boundaries.len());
                }
                if boundaries[probe].byte > offset {
                    break (low, probe);
                }
                low = probe;
                step *= 2;
            }
        } else {
            let (mut high, mut step) = (at, 1);
            loop {
                let Some(probe) = at.checked_sub(step) else {
                    break (0, high);
                };
                if boundaries[probe].byte <= offset {
                    break (probe, high);
                }
                high = probe;
                step *= 2;
            }
        };
        let index = boundaries[low..high]
            .binary_search_by_key(&offset, |boundary| boundary.byte)
            .map_err(|_| SourceError::InvalidByteBoundary(offset))?
            + low;
        *cursor = index;
        Ok(boundaries[index].position)
    }

    pub fn utf16_to_byte(&self, position: Utf16Position) -> Result<ByteOffset, SourceError> {
        let line_index = position.line as usize;
        let start = *self
            .line_starts
            .get(line_index)
            .ok_or(SourceError::InvalidUtf16Position(position))? as usize;
        let end = self
            .line_starts
            .get(line_index + 1)
            .map_or(self.boundaries_by_byte.len(), |next| *next as usize);
        let line = &self.boundaries_by_byte[start..end];
        line.binary_search_by_key(&position.character, |boundary| boundary.position.character)
            .map(|index| line[index].byte)
            .map_err(|_| SourceError::InvalidUtf16Position(position))
    }

    pub fn line_count(&self) -> u32 {
        u32::try_from(self.line_starts.len()).unwrap_or(u32::MAX)
    }

    pub fn valid_boundaries(&self) -> impl Iterator<Item = (ByteOffset, Utf16Position)> + '_ {
        self.boundaries_by_byte
            .iter()
            .map(|boundary| (boundary.byte, boundary.position))
    }
}

#[derive(Clone, Copy, Debug)]
struct DecodedUnit {
    character: char,
    raw_end: u32,
}

fn decode_source(
    bytes: &[u8],
) -> Result<(SourceEncoding, String, Vec<DecodedUnit>, u32), SourceError> {
    if bytes.starts_with(UTF8_BOM) {
        let content = &bytes[UTF8_BOM.len()..];
        let text = std::str::from_utf8(content).map_err(|error| SourceError::InvalidUtf8 {
            offset: u32::try_from(UTF8_BOM.len() + error.valid_up_to()).unwrap_or(u32::MAX),
        })?;
        let units = utf8_units(text, UTF8_BOM.len() as u32)?;
        return Ok((
            SourceEncoding::Utf8Bom,
            text.to_owned(),
            units,
            UTF8_BOM.len() as u32,
        ));
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((
            SourceEncoding::Utf8,
            text.to_owned(),
            utf8_units(text, 0)?,
            0,
        ));
    }

    let mut text = String::with_capacity(bytes.len());
    let mut units = Vec::with_capacity(bytes.len());
    for (index, byte) in bytes.iter().copied().enumerate() {
        let character = decode_windows_1252(byte).ok_or(SourceError::InvalidLegacyByte {
            offset: u32::try_from(index).unwrap_or(u32::MAX),
            byte,
        })?;
        text.push(character);
        units.push(DecodedUnit {
            character,
            raw_end: u32::try_from(index + 1).map_err(|_| SourceError::TooLarge)?,
        });
    }
    Ok((SourceEncoding::Windows1252, text, units, 0))
}

fn utf8_units(text: &str, content_start: u32) -> Result<Vec<DecodedUnit>, SourceError> {
    text.char_indices()
        .map(|(index, character)| {
            let raw_end = content_start as usize + index + character.len_utf8();
            Ok(DecodedUnit {
                character,
                raw_end: u32::try_from(raw_end).map_err(|_| SourceError::TooLarge)?,
            })
        })
        .collect()
}

fn push_boundary(
    by_byte: &mut Vec<Boundary>,
    byte: u32,
    position: Utf16Position,
) -> Result<(), SourceError> {
    by_byte.push(Boundary {
        byte: ByteOffset(byte),
        position,
    });
    Ok(())
}

fn start_line(line_starts: &mut Vec<u32>, by_byte: &[Boundary]) -> Result<(), SourceError> {
    line_starts.push(u32::try_from(by_byte.len()).map_err(|_| SourceError::TooLarge)?);
    Ok(())
}

fn detect_newline_style(text: &str) -> NewlineStyle {
    let bytes = text.as_bytes();
    let mut crlf = 0;
    let mut lf = 0;
    let mut cr = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            crlf += 1;
            index += 2;
        } else if bytes[index] == b'\r' {
            cr += 1;
            index += 1;
        } else if bytes[index] == b'\n' {
            lf += 1;
            index += 1;
        } else {
            index += 1;
        }
    }
    match (crlf > 0, lf > 0, cr > 0) {
        (false, false, false) => NewlineStyle::None,
        (true, false, false) => NewlineStyle::CrLf,
        (false, true, false) => NewlineStyle::Lf,
        (false, false, true) => NewlineStyle::Cr,
        _ => NewlineStyle::Mixed,
    }
}

fn normalize_newlines(text: &str, style: NewlineStyle) -> String {
    let replacement = match style {
        NewlineStyle::Lf => "\n",
        NewlineStyle::CrLf => "\r\n",
        NewlineStyle::Cr => "\r",
        NewlineStyle::None | NewlineStyle::Mixed => return text.to_owned(),
    };
    let mut normalized = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\r' {
            if characters.peek() == Some(&'\n') {
                characters.next();
            }
            normalized.push_str(replacement);
        } else if character == '\n' {
            normalized.push_str(replacement);
        } else {
            normalized.push(character);
        }
    }
    normalized
}

fn decode_windows_1252(byte: u8) -> Option<char> {
    match byte {
        0x00..=0x7f | 0xa0..=0xff => char::from_u32(byte as u32),
        0x80 => Some('\u{20ac}'),
        0x82 => Some('\u{201a}'),
        0x83 => Some('\u{0192}'),
        0x84 => Some('\u{201e}'),
        0x85 => Some('\u{2026}'),
        0x86 => Some('\u{2020}'),
        0x87 => Some('\u{2021}'),
        0x88 => Some('\u{02c6}'),
        0x89 => Some('\u{2030}'),
        0x8a => Some('\u{0160}'),
        0x8b => Some('\u{2039}'),
        0x8c => Some('\u{0152}'),
        0x8e => Some('\u{017d}'),
        0x91 => Some('\u{2018}'),
        0x92 => Some('\u{2019}'),
        0x93 => Some('\u{201c}'),
        0x94 => Some('\u{201d}'),
        0x95 => Some('\u{2022}'),
        0x96 => Some('\u{2013}'),
        0x97 => Some('\u{2014}'),
        0x98 => Some('\u{02dc}'),
        0x99 => Some('\u{2122}'),
        0x9a => Some('\u{0161}'),
        0x9b => Some('\u{203a}'),
        0x9c => Some('\u{0153}'),
        0x9e => Some('\u{017e}'),
        0x9f => Some('\u{0178}'),
        _ => None,
    }
}

fn encode_windows_1252(text: &str) -> Result<Vec<u8>, SourceError> {
    text.chars()
        .enumerate()
        .map(|(index, character)| {
            encode_windows_1252_character(character).ok_or(SourceError::UnrepresentableCharacter {
                character,
                character_index: u32::try_from(index).unwrap_or(u32::MAX),
            })
        })
        .collect()
}

fn encode_windows_1252_character(character: char) -> Option<u8> {
    match character {
        '\u{0000}'..='\u{007f}' | '\u{00a0}'..='\u{00ff}' => Some(character as u8),
        '\u{20ac}' => Some(0x80),
        '\u{201a}' => Some(0x82),
        '\u{0192}' => Some(0x83),
        '\u{201e}' => Some(0x84),
        '\u{2026}' => Some(0x85),
        '\u{2020}' => Some(0x86),
        '\u{2021}' => Some(0x87),
        '\u{02c6}' => Some(0x88),
        '\u{2030}' => Some(0x89),
        '\u{0160}' => Some(0x8a),
        '\u{2039}' => Some(0x8b),
        '\u{0152}' => Some(0x8c),
        '\u{017d}' => Some(0x8e),
        '\u{2018}' => Some(0x91),
        '\u{2019}' => Some(0x92),
        '\u{201c}' => Some(0x93),
        '\u{201d}' => Some(0x94),
        '\u{2022}' => Some(0x95),
        '\u{2013}' => Some(0x96),
        '\u{2014}' => Some(0x97),
        '\u{02dc}' => Some(0x98),
        '\u{2122}' => Some(0x99),
        '\u{0161}' => Some(0x9a),
        '\u{203a}' => Some(0x9b),
        '\u{0153}' => Some(0x9c),
        '\u{017e}' => Some(0x9e),
        '\u{0178}' => Some(0x9f),
        _ => None,
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SourceError {
    #[error("source identifier is empty or exceeds the bounded length")]
    InvalidSourceId,
    #[error("the file is too large")]
    TooLarge,
    #[error("source range end precedes its start")]
    ReversedRange,
    #[error("the file is not valid UTF-8 text")]
    InvalidUtf8 { offset: u32 },
    #[error("the file contains byte 0x{byte:02x}, which is not a character in its encoding")]
    InvalidLegacyByte { offset: u32, byte: u8 },
    #[error("position {0:?} is not at a character boundary")]
    InvalidByteBoundary(ByteOffset),
    #[error("UTF-16 position {0:?} is out of range or splits a surrogate pair")]
    InvalidUtf16Position(Utf16Position),
    #[error("character {character:?} at character index {character_index} is not representable")]
    UnrepresentableCharacter {
        character: char,
        character_index: u32,
    },
}
