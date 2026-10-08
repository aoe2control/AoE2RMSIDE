use std::io::{self, Read, Write};

use prost::Message;
use thiserror::Error;

#[allow(clippy::large_enum_variant)]
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/rmside.v1.rs"));
}

pub const PROTOCOL_MAJOR: u32 = 2;
pub const PROTOCOL_MINOR: u32 = 19;
pub const PROTOCOL_PATCH: u32 = 0;
pub const MAX_FRAME_BYTES: usize = 20 * 1024 * 1024;

pub fn artifact_version() -> v1::ArtifactVersion {
    v1::ArtifactVersion {
        major: PROTOCOL_MAJOR,
        minor: PROTOCOL_MINOR,
        patch: PROTOCOL_PATCH,
    }
}

pub fn compatibility() -> v1::CompatibilityRange {
    v1::CompatibilityRange {
        minimum_major: PROTOCOL_MAJOR,
        maximum_major: PROTOCOL_MAJOR,
    }
}

pub fn envelope(request_id: impl Into<String>, payload: v1::envelope::Payload) -> v1::Envelope {
    v1::Envelope {
        artifact_version: Some(artifact_version()),
        compatibility: Some(compatibility()),
        request_id: request_id.into(),
        payload: Some(payload),
    }
}

pub fn structured_error(
    request_id: impl Into<String>,
    code: v1::ErrorCode,
    message: impl Into<String>,
    retryable: bool,
) -> v1::Envelope {
    envelope(
        request_id,
        v1::envelope::Payload::Error(v1::StructuredError {
            code: code as i32,
            message: message.into(),
            retryable,
            details: Default::default(),
        }),
    )
}

pub const ERROR_DETAIL_REASON: &str = "reason";
pub const FRAME_TOO_LARGE_REASON: &str = "frame-too-large";

pub fn frame_too_large_error(
    request_id: impl Into<String>,
    description: &str,
    encoded_bytes: usize,
) -> v1::Envelope {
    let description = description.chars().take(256).collect::<String>();
    let mut error = structured_error(
        request_id,
        v1::ErrorCode::Internal,
        format!(
            "{description} is {encoded_bytes} bytes, over the {MAX_FRAME_BYTES}-byte protocol frame bound"
        ),
        false,
    );
    if let Some(v1::envelope::Payload::Error(error)) = error.payload.as_mut() {
        error.details.insert(
            ERROR_DETAIL_REASON.to_owned(),
            FRAME_TOO_LARGE_REASON.to_owned(),
        );
        error
            .details
            .insert("encodedBytes".to_owned(), encoded_bytes.to_string());
        error
            .details
            .insert("maximumBytes".to_owned(), MAX_FRAME_BYTES.to_string());
    }
    error
}

pub fn fits_frame(message: &v1::Envelope) -> Result<(), usize> {
    let length = message.encoded_len();
    if length > MAX_FRAME_BYTES {
        Err(length)
    } else {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("input closed before another frame")]
    Eof,
    #[error("frame header ended after {0} bytes")]
    TruncatedHeader(usize),
    #[error("frame length {actual} exceeds maximum {maximum}")]
    TooLarge { actual: usize, maximum: usize },
    #[error("frame body ended before its declared length")]
    TruncatedBody,
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid Protobuf envelope: {0}")]
    Decode(#[from] prost::DecodeError),
    #[error("encoded Protobuf envelope of {0} bytes exceeds the maximum frame")]
    EncodeTooLarge(usize),
}

pub fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>, FrameError> {
    let mut header = [0_u8; 4];
    let mut header_read = 0;
    while header_read < header.len() {
        match reader.read(&mut header[header_read..]) {
            Ok(0) if header_read == 0 => return Err(FrameError::Eof),
            Ok(0) => return Err(FrameError::TruncatedHeader(header_read)),
            Ok(count) => header_read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        });
    }
    let mut body = Vec::with_capacity(length.min(64 * 1024));
    match reader.take(length as u64).read_to_end(&mut body) {
        Ok(read) if read == length => Ok(body),
        Ok(_) => Err(FrameError::TruncatedBody),
        Err(error) => Err(FrameError::Io(error)),
    }
}

pub fn decode_envelope(frame: &[u8]) -> Result<v1::Envelope, FrameError> {
    Ok(v1::Envelope::decode(frame)?)
}

pub fn write_frame(writer: &mut impl Write, message: &v1::Envelope) -> Result<(), FrameError> {
    fits_frame(message).map_err(FrameError::EncodeTooLarge)?;
    let body = message.encode_to_vec();
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

pub fn forward_frame(frame: &[u8]) -> Result<Vec<u8>, FrameError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            actual: frame.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    Ok(frame.to_vec())
}

pub fn supports_major(version: Option<&v1::ArtifactVersion>) -> bool {
    version.is_some_and(|value| value.major == PROTOCOL_MAJOR)
}
