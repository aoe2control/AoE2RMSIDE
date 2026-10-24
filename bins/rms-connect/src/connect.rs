use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rms_connect_protocol::key::{self, KEY_BYTES};
use rms_connect_protocol::v1::envelope::Payload;
use rms_connect_protocol::{
    FrameError, HANDSHAKE_DEADLINE_MILLISECONDS, NONCE_BYTES, Refusal, check_envelope,
    decode_envelope, envelope, read_frame, v1, write_frame,
};

use crate::platform::{self, OpenError, Pipe};
use crate::relay::{ConnectFailure, ConnectRequest, Connected, Transport};
use crate::server_check::ServerPolicy;

const BUSY_WAIT: Duration = Duration::from_secs(2);
const WRITE_DEADLINE: Duration = Duration::from_secs(10);
pub const HANDSHAKE_FRAME_BYTES: usize = 16 * 1024;

pub trait FrameSource: Send {
    fn next(&mut self) -> Result<v1::Envelope, FrameError>;
}

#[derive(Clone, Debug)]
pub struct Connector {
    pub key_path: Option<PathBuf>,
    pub policy: ServerPolicy,
}

impl Connector {
    pub fn connect(
        &self,
        request: &ConnectRequest,
    ) -> Result<(Connected, Box<dyn FrameSource>), ConnectFailure> {
        let key_path = self.key_path.as_deref().ok_or(ConnectFailure::NoKey)?;
        let key = read_key(key_path).ok_or(ConnectFailure::NoKey)?;
        let key_id = key::key_id(&key);
        if request.refused_key_id.as_deref() == Some(key_id.as_str()) {
            return Err(ConnectFailure::RefusedBefore);
        }
        let started = Instant::now();
        let pipe = match Pipe::open(&key::pipe_name(&key), BUSY_WAIT) {
            Ok(pipe) => Arc::new(pipe),
            Err(OpenError::NotFound | OpenError::Busy) => return Err(ConnectFailure::NoPipe),
            Err(OpenError::Other) => return Err(ConnectFailure::Failed),
        };
        let trusted = pipe
            .server_process_id()
            .and_then(platform::process_image)
            .is_some_and(|image| self.policy.accepts(&image));
        if !trusted {
            return Err(ConnectFailure::Untrusted);
        }
        let deadline = started + Duration::from_millis(HANDSHAKE_DEADLINE_MILLISECONDS);
        let result = handshake(&pipe, &key, &key_id, request, deadline);
        if result.is_err() {
            pipe.stop();
        }
        let (ide_version, ready) = result?;
        Ok((
            Connected {
                transport: Box::new(PipeTransport(pipe.clone())),
                key_id,
                ide_version,
                ready,
                next_message_id: 3,
            },
            Box::new(PipeSource(pipe)),
        ))
    }
}

pub fn read_key(path: &Path) -> Option<[u8; KEY_BYTES]> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(KEY_BYTES + 1);
    file.take(KEY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    bytes.try_into().ok()
}

fn handshake(
    pipe: &Pipe,
    key: &[u8; KEY_BYTES],
    key_id: &str,
    request: &ConnectRequest,
    deadline: Instant,
) -> Result<(String, v1::SessionReady), ConnectFailure> {
    let mut client_nonce = [0_u8; NONCE_BYTES];
    platform::fill_random(&mut client_nonce).map_err(|_| ConnectFailure::Failed)?;
    let hello = envelope(
        1,
        Payload::ClientHello(v1::ClientHello {
            connector_version: request.hello.connector_version.clone(),
            catalog_hash: request.hello.catalog_hash.to_vec(),
            client_nonce: client_nonce.to_vec(),
            app: Some(request.hello.app.clone()),
            mcp_revision: request.hello.mcp_revision.clone(),
        }),
    );
    send(pipe, &hello, deadline)?;

    let server_hello = match receive(pipe, deadline, key_id)? {
        Payload::ServerHello(hello) => hello,
        Payload::Goodbye(goodbye) => return Err(goodbye_failure(goodbye, key_id)),
        _ => return Err(ConnectFailure::Unverified),
    };
    let server_nonce: [u8; NONCE_BYTES] = server_hello
        .server_nonce
        .as_slice()
        .try_into()
        .map_err(|_| ConnectFailure::Unverified)?;
    let expected = key::server_proof(key, &client_nonce, &server_nonce);
    if !key::proof_matches(&server_hello.server_proof, &expected) {
        return Err(ConnectFailure::Unverified);
    }
    let proof = envelope(
        2,
        Payload::ClientProof(v1::ClientProof {
            client_proof: key::client_proof(key, &server_nonce, &client_nonce).to_vec(),
        }),
    );
    send(pipe, &proof, deadline)?;
    let answer = receive(pipe, deadline, key_id);
    if server_hello.catalog_hash != request.hello.catalog_hash {
        return Err(catalog_answer(answer, server_hello.ide_version, key_id));
    }
    match answer? {
        Payload::SessionReady(ready) => Ok((server_hello.ide_version, ready)),
        Payload::Goodbye(goodbye) => Err(goodbye_failure(goodbye, key_id)),
        _ => Err(ConnectFailure::Unverified),
    }
}

fn catalog_answer(
    answer: Result<Payload, ConnectFailure>,
    ide_version: String,
    key_id: &str,
) -> ConnectFailure {
    match answer {
        Ok(Payload::Goodbye(goodbye))
            if goodbye.reason != v1::GoodbyeReason::VersionMismatch as i32 =>
        {
            goodbye_failure(goodbye, key_id)
        }
        Err(failure @ ConnectFailure::UnsupportedMajor { .. }) => failure,
        _ => ConnectFailure::CatalogMismatch {
            ide_version,
            key_id: key_id.to_owned(),
        },
    }
}

fn goodbye_failure(goodbye: v1::Goodbye, key_id: &str) -> ConnectFailure {
    ConnectFailure::Goodbye {
        reason: goodbye.reason,
        message: goodbye.message,
        key_id: key_id.to_owned(),
    }
}

fn send(pipe: &Pipe, message: &v1::Envelope, deadline: Instant) -> Result<(), ConnectFailure> {
    check_envelope(message).map_err(|_| ConnectFailure::Failed)?;
    if prost::Message::encoded_len(message) > HANDSHAKE_FRAME_BYTES {
        return Err(ConnectFailure::Failed);
    }
    write_frame(&mut PipeWriter { pipe, deadline }, message).map_err(|_| ConnectFailure::Unverified)
}

fn receive(pipe: &Pipe, deadline: Instant, key_id: &str) -> Result<Payload, ConnectFailure> {
    let frame = read_bounded_frame(
        &mut PipeReader {
            pipe,
            deadline: Some(deadline),
        },
        HANDSHAKE_FRAME_BYTES,
    )
    .map_err(|_| ConnectFailure::Unverified)?;
    let message = decode_envelope(&frame).map_err(|_| ConnectFailure::Unverified)?;
    match check_envelope(&message) {
        Ok(()) => Ok(message.payload.expect("checked envelopes carry a payload")),
        Err(Refusal::UnsupportedMajor) => Err(ConnectFailure::UnsupportedMajor {
            key_id: key_id.to_owned(),
        }),
        Err(_) => Err(ConnectFailure::Unverified),
    }
}

pub fn read_bounded_frame(reader: &mut impl Read, maximum: usize) -> Result<Vec<u8>, FrameError> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Eof
        } else {
            FrameError::Io(error)
        }
    })?;
    let length = u32::from_le_bytes(header) as usize;
    if length > maximum {
        return Err(FrameError::TooLarge {
            actual: length,
            maximum,
        });
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::TruncatedBody
        } else {
            FrameError::Io(error)
        }
    })?;
    Ok(body)
}

struct PipeReader<'a> {
    pipe: &'a Pipe,
    deadline: Option<Instant>,
}

impl Read for PipeReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.pipe.read(buffer, self.deadline)
    }
}

struct PipeWriter<'a> {
    pipe: &'a Pipe,
    deadline: Instant,
}

impl Write for PipeWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.pipe.write(bytes, self.deadline)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PipeTransport(Arc<Pipe>);

impl Transport for PipeTransport {
    fn send(&mut self, message: &v1::Envelope) -> Result<(), FrameError> {
        write_frame(
            &mut PipeWriter {
                pipe: &self.0,
                deadline: Instant::now() + WRITE_DEADLINE,
            },
            message,
        )
    }

    fn close(&mut self) {
        self.0.stop();
    }
}

struct PipeSource(Arc<Pipe>);

impl FrameSource for PipeSource {
    fn next(&mut self) -> Result<v1::Envelope, FrameError> {
        let frame = read_frame(&mut PipeReader {
            pipe: &self.0,
            deadline: None,
        })?;
        decode_envelope(&frame)
    }
}
