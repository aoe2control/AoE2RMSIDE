use std::io::{self, Read, Write};

use prost::Message;
use thiserror::Error;

pub mod catalog;
pub mod key;

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/rmside.connect.v1.rs"));
}

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;
pub const PROTOCOL_PATCH: u32 = 0;

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ARGUMENTS_JSON_BYTES: usize = 512 * 1024;
pub const MAX_TEXT_ITEM_BYTES: usize = 64 * 1024;
pub const MAX_PNG_BYTES: usize = 1536 * 1024;
pub const MAX_IMAGE_SIDE: u32 = 1024;
pub const MIN_IMAGE_LONG_SIDE: u32 = 256;
pub const MAX_CONTENT_ITEMS: usize = 4;
pub const MAX_IMAGES_PER_RESULT: usize = 1;
pub const NONCE_BYTES: usize = 32;
pub const PROOF_BYTES: usize = 32;
pub const CATALOG_HASH_BYTES: usize = 32;
pub const MAX_APP_NAME_CHARS: usize = 64;
pub const MAX_APP_TITLE_CHARS: usize = 64;
pub const MAX_APP_VERSION_CHARS: usize = 32;
pub const MAX_LAUNCHER_IMAGE_CHARS: usize = 255;
pub const MAX_APP_DISPLAY_NAME_CHARS: usize = 128;
pub const MAX_PRODUCT_VERSION_BYTES: usize = 64;
pub const MAX_MCP_REVISION_BYTES: usize = 32;
pub const MAX_SESSION_ID_BYTES: usize = 64;
pub const MAX_TOOL_NAME_BYTES: usize = 64;
pub const MAX_PROGRESS_MESSAGE_BYTES: usize = 256;
pub const MAX_GOODBYE_MESSAGE_BYTES: usize = 512;
pub const MAX_ERROR_CODE_BYTES: usize = 64;
pub const MAX_ERROR_MESSAGE_BYTES: usize = 512;
pub const HANDSHAKE_DEADLINE_MILLISECONDS: u64 = 5_000;

pub const ERROR_UNSUPPORTED_MAJOR: &str = "unsupported-major";
pub const ERROR_UNKNOWN_MESSAGE: &str = "unknown-message";
pub const ERROR_MALFORMED_MESSAGE: &str = "malformed-message";

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

pub fn protocol_version() -> v1::ProtocolVersion {
    v1::ProtocolVersion {
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

pub fn envelope(message_id: u64, payload: v1::envelope::Payload) -> v1::Envelope {
    v1::Envelope {
        version: Some(protocol_version()),
        compatibility: Some(compatibility()),
        message_id,
        payload: Some(payload),
    }
}

pub fn protocol_error(message_id: u64, code: &'static str, message: &str) -> v1::Envelope {
    envelope(
        message_id,
        v1::envelope::Payload::ProtocolError(v1::ProtocolError {
            code: code.to_owned(),
            message: truncate_to_bytes(message, MAX_ERROR_MESSAGE_BYTES),
        }),
    )
}

pub fn truncate_to_bytes(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_owned();
    }
    let mut end = maximum;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

pub fn supports_major(envelope: &v1::Envelope) -> bool {
    let version = envelope
        .version
        .as_ref()
        .is_some_and(|version| version.major == PROTOCOL_MAJOR);
    let range = envelope.compatibility.as_ref().is_some_and(|range| {
        range.minimum_major <= range.maximum_major
            && (range.minimum_major..=range.maximum_major).contains(&PROTOCOL_MAJOR)
    });
    version && range
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum Refusal {
    #[error("the envelope's protocol major is not supported")]
    UnsupportedMajor,
    #[error("the envelope carries no payload this build knows")]
    UnknownMessage,
    #[error("the field {0} is outside the contract")]
    Malformed(&'static str),
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::UnsupportedMajor => ERROR_UNSUPPORTED_MAJOR,
            Self::UnknownMessage => ERROR_UNKNOWN_MESSAGE,
            Self::Malformed(_) => ERROR_MALFORMED_MESSAGE,
        }
    }
}

pub fn check_envelope(envelope: &v1::Envelope) -> Result<(), Refusal> {
    use v1::envelope::Payload;

    if !supports_major(envelope) {
        return Err(Refusal::UnsupportedMajor);
    }
    if envelope.message_id == 0 {
        return Err(Refusal::Malformed("message_id"));
    }
    match envelope.payload.as_ref().ok_or(Refusal::UnknownMessage)? {
        Payload::ClientHello(hello) => check_client_hello(hello),
        Payload::ServerHello(hello) => {
            product_version(&hello.ide_version, "server_hello.ide_version")?;
            exact_bytes(
                &hello.catalog_hash,
                CATALOG_HASH_BYTES,
                "server_hello.catalog_hash",
            )?;
            exact_bytes(
                &hello.server_nonce,
                NONCE_BYTES,
                "server_hello.server_nonce",
            )?;
            exact_bytes(
                &hello.server_proof,
                PROOF_BYTES,
                "server_hello.server_proof",
            )
        }
        Payload::ClientProof(proof) => exact_bytes(
            &proof.client_proof,
            PROOF_BYTES,
            "client_proof.client_proof",
        ),
        Payload::SessionReady(ready) => {
            let id = ready.session_id.as_bytes();
            if id.is_empty()
                || id.len() > MAX_SESSION_ID_BYTES
                || !id
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
            {
                return Err(Refusal::Malformed("session_ready.session_id"));
            }
            pairing_state(ready.pairing, "session_ready.pairing")?;
            display_text(
                &ready.app_display_name,
                1,
                MAX_APP_DISPLAY_NAME_CHARS,
                "session_ready.app_display_name",
            )
        }
        Payload::PairingChanged(changed) => {
            pairing_state(changed.pairing, "pairing_changed.pairing")
        }
        Payload::CallTool(call) => {
            call_id(call.call_id, "call_tool.call_id")?;
            if !is_tool_name(&call.tool_name) {
                return Err(Refusal::Malformed("call_tool.tool_name"));
            }
            if !is_json_object_text(&call.arguments_json) {
                return Err(Refusal::Malformed("call_tool.arguments_json"));
            }
            Ok(())
        }
        Payload::CancelCall(cancel) => call_id(cancel.call_id, "cancel_call.call_id"),
        Payload::CallProgress(progress) => {
            call_id(progress.call_id, "call_progress.call_id")?;
            if progress.total != 0 && progress.done > progress.total {
                return Err(Refusal::Malformed("call_progress.done"));
            }
            byte_bound(
                &progress.message,
                MAX_PROGRESS_MESSAGE_BYTES,
                "call_progress.message",
            )
        }
        Payload::CallResult(result) => check_call_result(result),
        Payload::Goodbye(goodbye) => {
            if goodbye.reason == v1::GoodbyeReason::Unspecified as i32 || goodbye.reason < 0 {
                return Err(Refusal::Malformed("goodbye.reason"));
            }
            byte_bound(
                &goodbye.message,
                MAX_GOODBYE_MESSAGE_BYTES,
                "goodbye.message",
            )
        }
        Payload::ProtocolError(error) => {
            let code = error.code.as_bytes();
            if code.is_empty()
                || code.len() > MAX_ERROR_CODE_BYTES
                || !code
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || *byte == b'-')
            {
                return Err(Refusal::Malformed("protocol_error.code"));
            }
            byte_bound(
                &error.message,
                MAX_ERROR_MESSAGE_BYTES,
                "protocol_error.message",
            )
        }
    }
}

fn check_client_hello(hello: &v1::ClientHello) -> Result<(), Refusal> {
    product_version(&hello.connector_version, "client_hello.connector_version")?;
    exact_bytes(
        &hello.catalog_hash,
        CATALOG_HASH_BYTES,
        "client_hello.catalog_hash",
    )?;
    exact_bytes(
        &hello.client_nonce,
        NONCE_BYTES,
        "client_hello.client_nonce",
    )?;
    let revision = hello.mcp_revision.as_bytes();
    if revision.len() > MAX_MCP_REVISION_BYTES || !revision.iter().all(u8::is_ascii_graphic) {
        return Err(Refusal::Malformed("client_hello.mcp_revision"));
    }
    let app = hello
        .app
        .as_ref()
        .ok_or(Refusal::Malformed("client_hello.app"))?;
    display_text(&app.name, 1, MAX_APP_NAME_CHARS, "client_hello.app.name")?;
    display_text(&app.title, 0, MAX_APP_TITLE_CHARS, "client_hello.app.title")?;
    display_text(
        &app.version,
        0,
        MAX_APP_VERSION_CHARS,
        "client_hello.app.version",
    )?;
    display_text(
        &app.launcher_image,
        0,
        MAX_LAUNCHER_IMAGE_CHARS,
        "client_hello.app.launcher_image",
    )?;
    if app.launcher_image.contains(['\\', '/', ':']) {
        return Err(Refusal::Malformed("client_hello.app.launcher_image"));
    }
    Ok(())
}

fn check_call_result(result: &v1::CallResult) -> Result<(), Refusal> {
    use v1::content_item::Item;

    call_id(result.call_id, "call_result.call_id")?;
    if result.content.is_empty() || result.content.len() > MAX_CONTENT_ITEMS {
        return Err(Refusal::Malformed("call_result.content"));
    }
    let mut images = 0;
    for item in &result.content {
        match item.item.as_ref() {
            None => return Err(Refusal::Malformed("call_result.content.item")),
            Some(Item::Text(text)) => {
                byte_bound(text, MAX_TEXT_ITEM_BYTES, "call_result.content.text")?;
            }
            Some(Item::Image(image)) => {
                images += 1;
                check_image(image)?;
            }
        }
    }
    if images > MAX_IMAGES_PER_RESULT {
        return Err(Refusal::Malformed("call_result.content.image"));
    }
    if result.is_error
        && !(result.content.len() == 1 && matches!(result.content[0].item, Some(Item::Text(_))))
    {
        return Err(Refusal::Malformed("call_result.is_error"));
    }
    Ok(())
}

fn check_image(image: &v1::Image) -> Result<(), Refusal> {
    let png = &image.png;
    if png.len() < 24
        || png.len() > MAX_PNG_BYTES
        || png[..8] != PNG_SIGNATURE
        || &png[12..16] != b"IHDR"
    {
        return Err(Refusal::Malformed("call_result.content.image.png"));
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    let sides = [image.width, image.height];
    if width != image.width
        || height != image.height
        || sides
            .iter()
            .any(|side| !(1..=MAX_IMAGE_SIDE).contains(side))
        || image.width.max(image.height) < MIN_IMAGE_LONG_SIDE
    {
        return Err(Refusal::Malformed("call_result.content.image.size"));
    }
    Ok(())
}

pub fn is_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_TOOL_NAME_BYTES
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn is_json_object_text(text: &str) -> bool {
    let trimmed = text.trim_matches([' ', '\t', '\n', '\r']);
    text.len() <= MAX_ARGUMENTS_JSON_BYTES
        && trimmed.len() >= 2
        && trimmed.starts_with('{')
        && trimmed.ends_with('}')
}

fn call_id(id: u64, field: &'static str) -> Result<(), Refusal> {
    if id == 0 {
        Err(Refusal::Malformed(field))
    } else {
        Ok(())
    }
}

fn exact_bytes(bytes: &[u8], length: usize, field: &'static str) -> Result<(), Refusal> {
    if bytes.len() == length {
        Ok(())
    } else {
        Err(Refusal::Malformed(field))
    }
}

fn byte_bound(text: &str, maximum: usize, field: &'static str) -> Result<(), Refusal> {
    if text.len() <= maximum {
        Ok(())
    } else {
        Err(Refusal::Malformed(field))
    }
}

fn product_version(text: &str, field: &'static str) -> Result<(), Refusal> {
    let bytes = text.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_PRODUCT_VERSION_BYTES
        || !bytes.iter().all(u8::is_ascii_graphic)
    {
        Err(Refusal::Malformed(field))
    } else {
        Ok(())
    }
}

fn display_text(
    text: &str,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<(), Refusal> {
    let count = text.chars().count();
    if count < minimum || count > maximum || text.chars().any(char::is_control) {
        Err(Refusal::Malformed(field))
    } else {
        Ok(())
    }
}

fn pairing_state(value: i32, field: &'static str) -> Result<(), Refusal> {
    match v1::PairingState::try_from(value) {
        Ok(v1::PairingState::Unspecified) | Err(_) => Err(Refusal::Malformed(field)),
        Ok(_) => Ok(()),
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
    if frame.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            actual: frame.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    Ok(v1::Envelope::decode(frame)?)
}

pub fn write_frame(writer: &mut impl Write, message: &v1::Envelope) -> Result<(), FrameError> {
    let length = message.encoded_len();
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::EncodeTooLarge(length));
    }
    let body = message.encode_to_vec();
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}
