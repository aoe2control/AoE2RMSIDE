use std::io::{self, Read, Write};

use prost::Message;
use thiserror::Error;

#[allow(clippy::large_enum_variant)]
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/rmside.v1.rs"));
}

pub const PROTOCOL_MAJOR: u32 = 2;
pub const PROTOCOL_MINOR: u32 = 27;
pub const PROTOCOL_PATCH: u32 = 0;
pub const MAX_FRAME_BYTES: usize = 20 * 1024 * 1024;

pub const XS_START_REPORT_MAJOR: u32 = 1;
pub const XS_START_REPORT_MINOR: u32 = 0;
pub const MAX_XS_START_FINDINGS: usize = 200;
pub const MAX_XS_START_CHAT_LINES: usize = 1_000;
pub const MAX_XS_START_CHANGES: usize = 1_000;
pub const MAX_XS_START_RECORDED_CALLS: usize = 5_000;
pub const MAX_XS_START_SOURCE_IDS: usize = 64;
pub const MAX_XS_START_UNANSWERABLE_CALLS: usize = 64;
pub const MAX_XS_START_REPORT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_XS_CHAT_LINE_BYTES: usize = 2_048;
pub const MAX_XS_VALUE_TEXT_BYTES: usize = 256;
pub const MAX_XS_CONSTANTS_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_DIAGNOSTIC_ARGUMENTS: usize = 8;
pub const MAX_KNOWN_CRASH_ARGUMENTS: usize = 4;
pub const MAX_MESSAGE_ARGUMENT_NAME_BYTES: usize = 32;
pub const MAX_MESSAGE_ARGUMENT_VALUE_BYTES: usize = 256;
pub const MAX_KNOWN_CRASH_ID_BYTES: usize = 64;
pub const KNOWN_CRASH_PLACEHOLDERS: [&str; 3] = ["command", "terrain", "word"];
pub const MAX_QUALITY_CASE_IDS: usize = 32;
pub const MAX_QUALITY_ID_BYTES: usize = 48;
pub const MAX_QUALITY_SETTINGS: usize = 16;
pub const MAX_QUALITY_SEEDS: u32 = 4_096;
pub const MAX_QUALITY_PLAYER_VALUES: usize = 8;
pub const MAX_QUALITY_ROW_TILES: usize = 8;
pub const MAX_QUALITY_SAMPLE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum ContractViolation {
    #[error("too many message arguments")]
    TooManyArguments,
    #[error("a message argument name is not lower camel case ASCII of 1 to 32 bytes")]
    ArgumentName,
    #[error("message argument names are not sorted and unique")]
    ArgumentOrder,
    #[error("a message argument value exceeds 256 bytes")]
    ArgumentValue,
    #[error("a known-crash id is not lower-case words joined by hyphens of at most 64 bytes")]
    CrashId,
    #[error("a known-crash argument is not a cause placeholder")]
    CrashPlaceholder,
    #[error("the known-crash evidence is unspecified or unknown")]
    CrashEvidence,
    #[error(
        "a quality case id or item code is not lower-case words joined by hyphens of at most 48 bytes"
    )]
    QualityId,
    #[error("a quality sample row has an unspecified or unknown level")]
    QualityLevel,
    #[error("a quality sample row has more than 8 player values or tiles")]
    QualityRowBound,
    #[error("quality sample rows are not sorted by setting")]
    QualityRowOrder,
    #[error("quality sample rows exceed 256 KiB")]
    QualitySamplesTooLarge,
    #[error("instance IDs are present without the available state, or absent with it")]
    InstanceIdState,
    #[error("instance IDs do not give one 4-byte ID per object, cliff piece or terrain appearance")]
    InstanceIdLength,
    #[error("instance IDs are negative or repeated")]
    InstanceIdValue,
}

pub fn validate_message_arguments(
    arguments: &[v1::MessageArgument],
    maximum: usize,
) -> Result<(), ContractViolation> {
    if arguments.len() > maximum {
        return Err(ContractViolation::TooManyArguments);
    }
    for argument in arguments {
        let name = argument.name.as_bytes();
        let valid_name = (1..=MAX_MESSAGE_ARGUMENT_NAME_BYTES).contains(&name.len())
            && name[0].is_ascii_lowercase()
            && name.iter().all(u8::is_ascii_alphanumeric);
        if !valid_name {
            return Err(ContractViolation::ArgumentName);
        }
        if argument.value.len() > MAX_MESSAGE_ARGUMENT_VALUE_BYTES {
            return Err(ContractViolation::ArgumentValue);
        }
    }
    if !arguments.windows(2).all(|pair| pair[0].name < pair[1].name) {
        return Err(ContractViolation::ArgumentOrder);
    }
    Ok(())
}

pub fn is_known_crash_id(id: &str) -> bool {
    id.len() <= MAX_KNOWN_CRASH_ID_BYTES
        && id.starts_with(|character: char| character.is_ascii_lowercase())
        && id.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub fn validate_known_crash_reference(
    reference: &v1::KnownCrashReference,
) -> Result<(), ContractViolation> {
    if !is_known_crash_id(&reference.crash_id) {
        return Err(ContractViolation::CrashId);
    }
    validate_message_arguments(&reference.arguments, MAX_KNOWN_CRASH_ARGUMENTS)?;
    if !reference
        .arguments
        .iter()
        .all(|argument| KNOWN_CRASH_PLACEHOLDERS.contains(&argument.name.as_str()))
    {
        return Err(ContractViolation::CrashPlaceholder);
    }
    match v1::KnownCrashEvidence::try_from(reference.evidence) {
        Ok(v1::KnownCrashEvidence::Unspecified) | Err(_) => Err(ContractViolation::CrashEvidence),
        Ok(_) => Ok(()),
    }
}

pub fn validate_object_instance_ids(columns: &v1::ObjectColumns) -> Result<(), ContractViolation> {
    let available = columns.instance_id_state == v1::ObjectInstanceIdState::Available as i32;
    if !available {
        return if columns.instance_ids_le.is_empty() {
            Ok(())
        } else {
            Err(ContractViolation::InstanceIdState)
        };
    }
    if !columns.ids_le.len().is_multiple_of(4)
        || columns.instance_ids_le.len() != columns.ids_le.len()
    {
        return Err(ContractViolation::InstanceIdLength);
    }
    unique_non_negative_ids([columns.instance_ids_le.as_slice()])
}

pub fn validate_map_instance_ids(map: &v1::ColumnarMapState) -> Result<(), ContractViolation> {
    let none = v1::ObjectColumns::default();
    let objects = map.objects.as_ref().unwrap_or(&none);
    validate_object_instance_ids(objects)?;
    let available = objects.instance_id_state == v1::ObjectInstanceIdState::Available as i32;
    if !available {
        return if map.cliff_piece_instance_ids_le.is_empty()
            && map.appearance_instance_ids_le.is_empty()
        {
            Ok(())
        } else {
            Err(ContractViolation::InstanceIdState)
        };
    }
    for (records, record_bytes, ids) in [
        (&map.cliff_pieces_le, 20, &map.cliff_piece_instance_ids_le),
        (
            &map.appearance_objects_le,
            16,
            &map.appearance_instance_ids_le,
        ),
    ] {
        if !records.len().is_multiple_of(record_bytes)
            || ids.len() != records.len() / record_bytes * 4
        {
            return Err(ContractViolation::InstanceIdLength);
        }
    }
    unique_non_negative_ids([
        objects.instance_ids_le.as_slice(),
        map.cliff_piece_instance_ids_le.as_slice(),
        map.appearance_instance_ids_le.as_slice(),
    ])
}

fn unique_non_negative_ids<const N: usize>(columns: [&[u8]; N]) -> Result<(), ContractViolation> {
    let mut ids = columns
        .iter()
        .flat_map(|column| column.chunks_exact(4))
        .map(|bytes| i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect::<Vec<_>>();
    ids.sort_unstable();
    if ids.first().is_some_and(|id| *id < 0) || ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ContractViolation::InstanceIdValue);
    }
    Ok(())
}

pub fn is_quality_id(id: &str) -> bool {
    id.len() <= MAX_QUALITY_ID_BYTES && is_known_crash_id(id)
}

pub fn validate_quality_samples(samples: &v1::QualitySamples) -> Result<(), ContractViolation> {
    if samples.encoded_len() > MAX_QUALITY_SAMPLE_BYTES {
        return Err(ContractViolation::QualitySamplesTooLarge);
    }
    for row in &samples.rows {
        if !is_quality_id(&row.case_id) || !is_quality_id(&row.code) {
            return Err(ContractViolation::QualityId);
        }
        match v1::QualityLevel::try_from(row.level) {
            Ok(v1::QualityLevel::Unspecified) | Err(_) => {
                return Err(ContractViolation::QualityLevel);
            }
            Ok(_) => {}
        }
        if row.player_values.len() > MAX_QUALITY_PLAYER_VALUES
            || row.tiles.len() > MAX_QUALITY_ROW_TILES
        {
            return Err(ContractViolation::QualityRowBound);
        }
    }
    if !samples
        .rows
        .windows(2)
        .all(|pair| pair[0].settings_index <= pair[1].settings_index)
    {
        return Err(ContractViolation::QualityRowOrder);
    }
    Ok(())
}

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
            known_crash: None,
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
