use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use rms_connect_protocol::v1::envelope::Payload;
use rms_connect_protocol::{
    ERROR_UNSUPPORTED_MAJOR, FrameError, Refusal, check_envelope, envelope, protocol_error, v1,
};
use serde_json::{Value, json};

use crate::content::{ToolError, relayed_result};
use crate::jsonrpc;
use crate::mcp::{CallRequest, ClientIdentity};

pub const MAX_OPEN_CALLS: usize = 64;

pub trait Transport: Send {
    fn send(&mut self, envelope: &v1::Envelope) -> Result<(), FrameError>;
    fn close(&mut self);
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hello {
    pub connector_version: String,
    pub catalog_hash: [u8; 32],
    pub app: v1::ClientApp,
    pub mcp_revision: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectRequest {
    pub generation: u64,
    pub hello: Hello,
    pub refused_key_id: Option<String>,
}

pub struct Connected {
    pub transport: Box<dyn Transport>,
    pub key_id: String,
    pub ide_version: String,
    pub ready: v1::SessionReady,
    pub next_message_id: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectFailure {
    NoKey,
    NoPipe,
    Untrusted,
    Unverified,
    CatalogMismatch {
        ide_version: String,
        key_id: String,
    },
    UnsupportedMajor {
        key_id: String,
    },
    Goodbye {
        reason: i32,
        message: String,
        key_id: String,
    },
    RefusedBefore,
    Failed,
}

#[derive(Debug, PartialEq)]
pub enum Out {
    Send(Value),
    Connect(ConnectRequest),
    Exit,
}

struct LiveCall {
    request_id: Value,
    progress_token: Option<Value>,
    last_progress: Option<u64>,
    last_progress_at: Option<Instant>,
}

struct Session {
    generation: u64,
    key_id: String,
    transport: Box<dyn Transport>,
    next_message_id: u64,
    next_call_id: u64,
    calls: BTreeMap<u64, LiveCall>,
}

impl Session {
    fn message_id(&mut self) -> u64 {
        let id = self.next_message_id;
        self.next_message_id += 1;
        id
    }

    fn send(&mut self, payload: Payload) -> Result<(), ()> {
        let message = envelope(self.message_id(), payload);
        if check_envelope(&message).is_err() {
            return Err(());
        }
        self.transport.send(&message).map_err(|_| ())
    }

    fn send_protocol_error(&mut self, code: &'static str, message: &str) {
        let error = protocol_error(self.message_id(), code, message);
        let _ = self.transport.send(&error);
    }
}

enum Link {
    Idle,
    Connecting {
        generation: u64,
        queued: Vec<CallRequest>,
    },
    Ready(Session),
}

pub struct Relay {
    connector_version: String,
    catalog_hash: [u8; 32],
    launcher_image: String,
    client: ClientIdentity,
    revision: String,
    link: Link,
    next_generation: u64,
    refused: Option<(String, ToolError)>,
    progress_interval: Duration,
}

impl Relay {
    pub fn new(
        connector_version: &str,
        catalog_hash: [u8; 32],
        launcher_image: String,
        progress_per_second: u32,
    ) -> Self {
        Self {
            connector_version: connector_version.to_owned(),
            catalog_hash,
            launcher_image,
            client: ClientIdentity::from_client_info(None),
            revision: String::new(),
            link: Link::Idle,
            next_generation: 1,
            refused: None,
            progress_interval: Duration::from_millis(1000 / u64::from(progress_per_second.max(1))),
        }
    }

    pub fn identify(&mut self, client: ClientIdentity, revision: &str) {
        self.client = client;
        self.revision = revision.to_owned();
    }

    pub fn connect_hint(&mut self) -> Vec<Out> {
        match self.link {
            Link::Idle => vec![self.start_connecting(Vec::new())],
            _ => Vec::new(),
        }
    }

    pub fn call(&mut self, call: CallRequest) -> Vec<Out> {
        if self.is_open(&call.request_id) {
            return vec![Out::Send(jsonrpc::error(
                &call.request_id,
                jsonrpc::INVALID_REQUEST,
                "This request id is already in use.",
            ))];
        }
        if self.open_calls() >= MAX_OPEN_CALLS {
            return vec![respond_error(&call.request_id, &too_many_calls())];
        }
        match &mut self.link {
            Link::Idle => vec![self.start_connecting(vec![call])],
            Link::Connecting { queued, .. } => {
                queued.push(call);
                Vec::new()
            }
            Link::Ready(session) => {
                if send_call(session, &call).is_ok() {
                    return Vec::new();
                }
                let mut outs = self.drop_session(&closed_during_call());
                outs.push(self.start_connecting(vec![call]));
                outs
            }
        }
    }

    pub fn cancel(&mut self, request_id: &Value) -> Vec<Out> {
        match &mut self.link {
            Link::Idle => Vec::new(),
            Link::Connecting { queued, .. } => {
                queued.retain(|call| call.request_id != *request_id);
                Vec::new()
            }
            Link::Ready(session) => {
                let Some(call_id) = session
                    .calls
                    .iter()
                    .find(|(_, call)| call.request_id == *request_id)
                    .map(|(call_id, _)| *call_id)
                else {
                    return Vec::new();
                };
                session.calls.remove(&call_id);
                if session
                    .send(Payload::CancelCall(v1::CancelCall { call_id }))
                    .is_err()
                {
                    return self.drop_session(&closed_during_call());
                }
                Vec::new()
            }
        }
    }

    pub fn connected(
        &mut self,
        generation: u64,
        result: Result<Connected, ConnectFailure>,
    ) -> Vec<Out> {
        let queued = match &mut self.link {
            Link::Connecting {
                generation: current,
                queued,
            } if *current == generation => std::mem::take(queued),
            _ => {
                if let Ok(mut stale) = result {
                    stale.transport.close();
                }
                return Vec::new();
            }
        };
        match result {
            Ok(connected) => {
                log_pairing(connected.ready.pairing, &connected.ready.app_display_name);
                let mut session = Session {
                    generation,
                    key_id: connected.key_id,
                    transport: connected.transport,
                    next_message_id: connected.next_message_id,
                    next_call_id: 1,
                    calls: BTreeMap::new(),
                };
                self.refused = None;
                let mut failed = Vec::new();
                for call in queued {
                    if !failed.is_empty() || send_call(&mut session, &call).is_err() {
                        failed.push(call.request_id);
                    }
                }
                self.link = Link::Ready(session);
                if failed.is_empty() {
                    return Vec::new();
                }
                let error = closed_during_call();
                let mut outs = self.drop_session(&error);
                outs.extend(failed.iter().map(|id| respond_error(id, &error)));
                outs
            }
            Err(failure) => {
                self.link = Link::Idle;
                let (error, exit) = self.failure_error(failure);
                let mut outs: Vec<Out> = queued
                    .iter()
                    .map(|call| respond_error(&call.request_id, &error))
                    .collect();
                if exit {
                    outs.push(Out::Exit);
                }
                outs
            }
        }
    }

    pub fn received(
        &mut self,
        generation: u64,
        result: Result<v1::Envelope, FrameError>,
        now: Instant,
    ) -> Vec<Out> {
        let Link::Ready(session) = &mut self.link else {
            return Vec::new();
        };
        if session.generation != generation {
            return Vec::new();
        }
        let message = match result {
            Ok(message) => message,
            Err(_) => return self.drop_session(&closed_during_call()),
        };
        match check_envelope(&message) {
            Ok(()) => {}
            Err(Refusal::UnsupportedMajor) => {
                session.send_protocol_error(ERROR_UNSUPPORTED_MAJOR, "Connector protocol 1 only.");
                return self.drop_session(&version_mismatch(""));
            }
            Err(refusal @ Refusal::UnknownMessage) => {
                session.send_protocol_error(
                    refusal.code(),
                    "This connector does not know the message.",
                );
                return Vec::new();
            }
            Err(refusal @ Refusal::Malformed(field)) => {
                session.send_protocol_error(refusal.code(), field);
                if let Some(Payload::CallResult(result)) = &message.payload
                    && let Some(call) = session.calls.remove(&result.call_id)
                {
                    let error = ToolError::new(
                        "internal",
                        "AoE2RMSIDE sent a result this connector cannot read.",
                        "Try again; if it keeps failing, ask the user to restart AoE2RMSIDE.",
                    );
                    return vec![respond_error(&call.request_id, &error)];
                }
                return Vec::new();
            }
        }
        match message.payload.expect("checked envelopes carry a payload") {
            Payload::CallProgress(progress) => {
                let interval = self.progress_interval;
                session
                    .calls
                    .get_mut(&progress.call_id)
                    .and_then(|call| progress_notification(call, &progress, now, interval))
                    .map(|notification| vec![Out::Send(notification)])
                    .unwrap_or_default()
            }
            Payload::CallResult(result) => match session.calls.remove(&result.call_id) {
                Some(call) => vec![Out::Send(jsonrpc::result(
                    &call.request_id,
                    relayed_result(&result),
                ))],
                None => Vec::new(),
            },
            Payload::PairingChanged(changed) => {
                log_pairing(changed.pairing, "");
                Vec::new()
            }
            Payload::Goodbye(goodbye) => {
                let key_id = session.key_id.clone();
                let (error, exit) = self.failure_error(ConnectFailure::Goodbye {
                    reason: goodbye.reason,
                    message: goodbye.message,
                    key_id,
                });
                let mut outs = self.drop_session(&error);
                if exit {
                    outs.push(Out::Exit);
                }
                outs
            }
            Payload::ProtocolError(error) => {
                eprintln!(
                    "rms-connect: AoE2RMSIDE reported a protocol error ({})",
                    error.code
                );
                if error.code == ERROR_UNSUPPORTED_MAJOR {
                    return self.drop_session(&version_mismatch(""));
                }
                Vec::new()
            }
            Payload::ClientHello(_)
            | Payload::ServerHello(_)
            | Payload::ClientProof(_)
            | Payload::SessionReady(_)
            | Payload::CallTool(_)
            | Payload::CancelCall(_) => {
                let _ = session.send(Payload::Goodbye(v1::Goodbye {
                    reason: v1::GoodbyeReason::ProtocolViolation as i32,
                    message: "Unexpected message after the handshake.".to_owned(),
                }));
                self.drop_session(&connection_failed())
            }
        }
    }

    pub fn shutdown(&mut self) {
        if let Link::Ready(session) = &mut self.link {
            session.transport.close();
        }
        self.link = Link::Idle;
    }

    fn start_connecting(&mut self, queued: Vec<CallRequest>) -> Out {
        let generation = self.next_generation;
        self.next_generation += 1;
        self.link = Link::Connecting { generation, queued };
        Out::Connect(ConnectRequest {
            generation,
            hello: Hello {
                connector_version: self.connector_version.clone(),
                catalog_hash: self.catalog_hash,
                app: v1::ClientApp {
                    name: self.client.name.clone(),
                    title: self.client.title.clone(),
                    version: self.client.version.clone(),
                    launcher_image: self.launcher_image.clone(),
                },
                mcp_revision: self.revision.clone(),
            },
            refused_key_id: self.refused.as_ref().map(|(key_id, _)| key_id.clone()),
        })
    }

    fn drop_session(&mut self, error: &ToolError) -> Vec<Out> {
        let Link::Ready(mut session) = std::mem::replace(&mut self.link, Link::Idle) else {
            return Vec::new();
        };
        session.transport.close();
        session
            .calls
            .values()
            .map(|call| respond_error(&call.request_id, error))
            .collect()
    }

    fn failure_error(&mut self, failure: ConnectFailure) -> (ToolError, bool) {
        let error = match failure {
            ConnectFailure::NoKey | ConnectFailure::NoPipe => not_running(),
            ConnectFailure::Untrusted => ToolError::new(
                "internal",
                "The program behind the AoE2RMSIDE connection is not this installation's AoE2RMSIDE.",
                "Ask the user to start AoE2RMSIDE from the installation this AI app was set up with, or to set this app up again through View > MCP > Connect an AI app.",
            ),
            ConnectFailure::Unverified | ConnectFailure::Failed => connection_failed(),
            ConnectFailure::CatalogMismatch {
                ide_version,
                key_id,
            } => {
                let error = version_mismatch(&format!(
                    "This connector belongs to AoE2RMSIDE {}, but AoE2RMSIDE {ide_version} is running.",
                    self.connector_version
                ));
                self.refused = Some((key_id, error.clone()));
                error
            }
            ConnectFailure::UnsupportedMajor { key_id } => {
                let error = version_mismatch("");
                self.refused = Some((key_id, error.clone()));
                error
            }
            ConnectFailure::RefusedBefore => self
                .refused
                .as_ref()
                .map(|(_, error)| error.clone())
                .unwrap_or_else(|| version_mismatch("")),
            ConnectFailure::Goodbye {
                reason,
                message,
                key_id,
            } => {
                let reason = v1::GoodbyeReason::try_from(reason).ok();
                if reason == Some(v1::GoodbyeReason::VersionMismatch) {
                    let error = version_mismatch(&message);
                    self.refused = Some((key_id, error.clone()));
                    return (error, false);
                }
                eprintln!("rms-connect: AoE2RMSIDE ended the connection ({reason:?})");
                return goodbye_error(reason);
            }
        };
        (error, false)
    }

    fn is_open(&self, request_id: &Value) -> bool {
        match &self.link {
            Link::Idle => false,
            Link::Connecting { queued, .. } => {
                queued.iter().any(|call| call.request_id == *request_id)
            }
            Link::Ready(session) => session
                .calls
                .values()
                .any(|call| call.request_id == *request_id),
        }
    }

    fn open_calls(&self) -> usize {
        match &self.link {
            Link::Idle => 0,
            Link::Connecting { queued, .. } => queued.len(),
            Link::Ready(session) => session.calls.len(),
        }
    }
}

fn send_call(session: &mut Session, call: &CallRequest) -> Result<(), ()> {
    let call_id = session.next_call_id;
    session.next_call_id += 1;
    session.send(Payload::CallTool(v1::CallTool {
        call_id,
        tool_name: call.tool.clone(),
        arguments_json: call.arguments_json.clone(),
        wants_progress: call.progress_token.is_some(),
    }))?;
    session.calls.insert(
        call_id,
        LiveCall {
            request_id: call.request_id.clone(),
            progress_token: call.progress_token.clone(),
            last_progress: None,
            last_progress_at: None,
        },
    );
    Ok(())
}

fn progress_notification(
    call: &mut LiveCall,
    progress: &v1::CallProgress,
    now: Instant,
    interval: Duration,
) -> Option<Value> {
    let token = call.progress_token.as_ref()?;
    if call
        .last_progress_at
        .is_some_and(|last| now.duration_since(last) < interval)
    {
        return None;
    }
    let mut value = u64::from(progress.done);
    if let Some(last) = call.last_progress
        && value <= last
    {
        value = last + 1;
    }
    let total = u64::from(progress.total);
    if total != 0 && value > total {
        return None;
    }
    call.last_progress = Some(value);
    call.last_progress_at = Some(now);
    let mut params = json!({ "progressToken": token, "progress": value });
    if total != 0 {
        params["total"] = json!(total);
    }
    if !progress.message.is_empty() {
        params["message"] = json!(progress.message);
    }
    Some(jsonrpc::notification("notifications/progress", params))
}

fn log_pairing(pairing: i32, display_name: &str) {
    match v1::PairingState::try_from(pairing) {
        Ok(v1::PairingState::Pending) => {
            eprintln!("rms-connect: waiting for the user's approval in AoE2RMSIDE");
        }
        Ok(v1::PairingState::Denied) => {
            eprintln!("rms-connect: the user did not allow this app in AoE2RMSIDE");
        }
        Ok(v1::PairingState::Approved) if !display_name.is_empty() => {
            eprintln!("rms-connect: connected to AoE2RMSIDE as {display_name}");
        }
        _ => {}
    }
}

fn respond_error(request_id: &Value, error: &ToolError) -> Out {
    Out::Send(jsonrpc::result(request_id, error.result()))
}

pub fn not_running() -> ToolError {
    ToolError::new(
        "ide_not_running",
        "AoE2RMSIDE is not running, or Enable MCP is off in it.",
        "Ask the user to start AoE2RMSIDE and turn on Enable MCP in View > MCP, then try again. read_guide works without the IDE.",
    )
}

fn closed_during_call() -> ToolError {
    ToolError::new(
        "ide_not_running",
        "The connection to AoE2RMSIDE closed during this call.",
        "Try again. If AoE2RMSIDE was closed, ask the user to start it.",
    )
}

fn connection_failed() -> ToolError {
    ToolError::new(
        "internal",
        "The connection to AoE2RMSIDE failed.",
        "Try again; if it keeps failing, ask the user to restart AoE2RMSIDE.",
    )
}

fn too_many_calls() -> ToolError {
    ToolError::new(
        "too_many_calls",
        "Too many calls are waiting for AoE2RMSIDE.",
        "Wait for the open calls to finish, then try again.",
    )
    .retry_after(10)
}

fn version_mismatch(message: &str) -> ToolError {
    let message = if message.is_empty() {
        "This connector and the running AoE2RMSIDE belong to different versions."
    } else {
        message
    };
    ToolError::new(
        "version_mismatch",
        message,
        "Ask the user to open View > MCP > Connect an AI app in AoE2RMSIDE, set this app up again, and restart this AI app.",
    )
}

fn goodbye_error(reason: Option<v1::GoodbyeReason>) -> (ToolError, bool) {
    use v1::GoodbyeReason as Reason;

    let error = match reason {
        Some(Reason::McpTurnedOff) => ToolError::new(
            "ide_not_running",
            "Enable MCP was turned off in AoE2RMSIDE.",
            "Ask the user to turn on Enable MCP in View > MCP if they want you to continue.",
        ),
        Some(Reason::AppRemoved) => ToolError::new(
            "not_allowed",
            "The user removed this app from the allowed apps in AoE2RMSIDE.",
            "Do not retry unless the user asks; AoE2RMSIDE asks the user again on the next call.",
        ),
        Some(Reason::IdeClosing) => ToolError::new(
            "ide_not_running",
            "AoE2RMSIDE is closing.",
            "Ask the user to start AoE2RMSIDE again, then try again.",
        ),
        Some(Reason::IdeUpdating) => {
            return (
                ToolError::new(
                    "ide_not_running",
                    "AoE2RMSIDE is updating, and this connector stops for the update.",
                    "After the update, ask the user to restart this AI app's connection to AoE2RMSIDE.",
                ),
                true,
            );
        }
        Some(Reason::LimitReached) => ToolError::new(
            "too_many_calls",
            "AoE2RMSIDE already has as many AI app connections as it allows.",
            "Ask the user to close another AI app's session, then try again.",
        )
        .retry_after(30),
        Some(Reason::VersionMismatch) => version_mismatch(""),
        Some(Reason::ProtocolViolation | Reason::Unspecified) | None => connection_failed(),
    };
    (error, false)
}
