use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::catalog::{Catalog, PRODUCT_VERSION, ServedBy};
use crate::content::{ToolError, text_result};
use crate::guide;
use crate::jsonrpc::{
    self, INVALID_PARAMS, INVALID_REQUEST, Incoming, METHOD_NOT_FOUND, RESOURCE_NOT_FOUND,
};
use crate::prompts;

pub const LATEST_REVISION: &str = "2025-11-25";
pub const SUPPORTED_REVISIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
pub const SERVER_NAME: &str = "aoe2rmside";
pub const SERVER_TITLE: &str = "AoE2RMSIDE";
pub const UNNAMED_APP: &str = "Unnamed app";

pub fn negotiate(requested: &str) -> &'static str {
    SUPPORTED_REVISIONS
        .iter()
        .find(|revision| **revision == requested)
        .copied()
        .unwrap_or(LATEST_REVISION)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientIdentity {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl ClientIdentity {
    pub fn from_client_info(info: Option<&Value>) -> Self {
        let field = |key: &str, maximum: usize| {
            display_text(
                info.and_then(|info| info.get(key))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                maximum,
            )
        };
        let name = field("name", rms_connect_protocol::MAX_APP_NAME_CHARS);
        Self {
            name: if name.is_empty() {
                UNNAMED_APP.to_owned()
            } else {
                name
            },
            title: field("title", rms_connect_protocol::MAX_APP_TITLE_CHARS),
            version: field("version", rms_connect_protocol::MAX_APP_VERSION_CHARS),
        }
    }
}

pub fn display_text(text: &str, maximum: usize) -> String {
    let cleaned: String = text.chars().filter(|c| !c.is_control()).collect();
    cleaned
        .trim()
        .chars()
        .take(maximum)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallRequest {
    pub request_id: Value,
    pub tool: String,
    pub arguments_json: String,
    pub progress_token: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Send(Value),
    Identify {
        client: ClientIdentity,
        revision: &'static str,
    },
    Connect,
    Call(CallRequest),
    Cancel(Value),
}

pub struct Server {
    catalog: Arc<Catalog>,
    revision: Option<&'static str>,
    ready: bool,
}

impl Server {
    pub fn new(catalog: Arc<Catalog>) -> Self {
        Self {
            catalog,
            revision: None,
            ready: false,
        }
    }

    pub fn revision(&self) -> Option<&'static str> {
        self.revision
    }

    pub fn line_too_long(&self) -> Action {
        Action::Send(jsonrpc::error(
            &Value::Null,
            INVALID_REQUEST,
            "The message is longer than the 1 MiB line bound.",
        ))
    }

    pub fn handle_line(&mut self, line: &[u8]) -> Vec<Action> {
        match jsonrpc::parse_line(line) {
            Err(refused) => vec![Action::Send(jsonrpc::error(
                &refused.id,
                refused.code,
                refused.message,
            ))],
            Ok(Incoming::Response) => Vec::new(),
            Ok(Incoming::Notification { method, params }) => {
                self.notification(&method, params.as_ref())
            }
            Ok(Incoming::Request { id, method, params }) => {
                self.request(&id, &method, params.as_ref())
            }
        }
    }

    fn notification(&mut self, method: &str, params: Option<&Value>) -> Vec<Action> {
        if self.revision.is_none() {
            return Vec::new();
        }
        match method {
            "notifications/initialized" if !self.ready => {
                self.ready = true;
                vec![Action::Connect]
            }
            "notifications/cancelled" => params
                .and_then(|params| params.get("requestId"))
                .filter(|id| id.is_string() || id.is_number())
                .map(|id| vec![Action::Cancel(id.clone())])
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn request(&mut self, id: &Value, method: &str, params: Option<&Value>) -> Vec<Action> {
        let send = |message: Value| vec![Action::Send(message)];
        if method == "ping" {
            return send(jsonrpc::result(id, json!({})));
        }
        if method == "initialize" {
            return self.initialize(id, params);
        }
        if self.revision.is_none() {
            return send(jsonrpc::error(
                id,
                INVALID_REQUEST,
                "Send initialize first.",
            ));
        }
        let params = match jsonrpc::params_object(params) {
            Ok(params) => params,
            Err(message) => return send(jsonrpc::error(id, INVALID_PARAMS, message)),
        };
        let paged = matches!(
            method,
            "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list"
        );
        if paged && params.contains_key("cursor") {
            return send(jsonrpc::error(id, INVALID_PARAMS, "Unknown cursor."));
        }
        match method {
            "tools/list" => {
                let tools: Vec<Value> = self
                    .catalog
                    .tools
                    .iter()
                    .map(|tool| tool.definition.clone())
                    .collect();
                send(jsonrpc::result(id, json!({ "tools": tools })))
            }
            "tools/call" => self.call_tool(id, &params),
            "resources/list" => send(jsonrpc::result(id, guide::resources(&self.catalog))),
            "resources/templates/list" => {
                send(jsonrpc::result(id, json!({ "resourceTemplates": [] })))
            }
            "resources/read" => {
                let uri = params
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match guide::read_resource(&self.catalog, uri) {
                    Some(result) => send(jsonrpc::result(id, result)),
                    None => send(jsonrpc::error(
                        id,
                        RESOURCE_NOT_FOUND,
                        "Resource not found.",
                    )),
                }
            }
            "prompts/list" => send(jsonrpc::result(id, prompts::list(&self.catalog))),
            "prompts/get" => match prompts::get(&self.catalog, &params) {
                Ok(result) => send(jsonrpc::result(id, result)),
                Err(message) => send(jsonrpc::error(id, INVALID_PARAMS, &message)),
            },
            _ => send(jsonrpc::error(id, METHOD_NOT_FOUND, "Method not found.")),
        }
    }

    fn initialize(&mut self, id: &Value, params: Option<&Value>) -> Vec<Action> {
        if self.revision.is_some() {
            return vec![Action::Send(jsonrpc::error(
                id,
                INVALID_REQUEST,
                "The server is already initialized.",
            ))];
        }
        let params = match jsonrpc::params_object(params) {
            Ok(params) => params,
            Err(message) => {
                return vec![Action::Send(jsonrpc::error(id, INVALID_PARAMS, message))];
            }
        };
        let Some(requested) = params.get("protocolVersion").and_then(Value::as_str) else {
            return vec![Action::Send(jsonrpc::error(
                id,
                INVALID_PARAMS,
                "protocolVersion is required.",
            ))];
        };
        let revision = negotiate(requested);
        self.revision = Some(revision);
        let client = ClientIdentity::from_client_info(params.get("clientInfo"));
        let result = json!({
            "protocolVersion": revision,
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": { "listChanged": false, "subscribe": false },
                "prompts": { "listChanged": false },
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "title": SERVER_TITLE,
                "version": PRODUCT_VERSION,
            },
            "instructions": self.catalog.instructions,
        });
        vec![
            Action::Identify { client, revision },
            Action::Send(jsonrpc::result(id, result)),
        ]
    }

    fn call_tool(&mut self, id: &Value, params: &Map<String, Value>) -> Vec<Action> {
        let send = |message: Value| vec![Action::Send(message)];
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return send(jsonrpc::error(
                id,
                INVALID_PARAMS,
                "name must be a tool name.",
            ));
        };
        let Some(tool) = self.catalog.tool(name) else {
            let shown: String = name.chars().take(64).collect();
            return send(jsonrpc::error(
                id,
                INVALID_PARAMS,
                &format!("Unknown tool: {shown}."),
            ));
        };
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(arguments)) => arguments.clone(),
            Some(_) => {
                return send(jsonrpc::error(
                    id,
                    INVALID_PARAMS,
                    "arguments must be an object.",
                ));
            }
        };
        match tool.served_by {
            ServedBy::Connector => {
                let result = match guide::read_guide(&self.catalog, &arguments) {
                    Ok(text) => text_result(text),
                    Err(error) => error.result(),
                };
                send(jsonrpc::result(id, result))
            }
            ServedBy::Ide => {
                let arguments_json = Value::Object(arguments).to_string();
                if arguments_json.len() > self.catalog.limits.arguments_json_bytes {
                    let error = ToolError::new(
                        "invalid_arguments",
                        "The arguments are larger than 512 KiB.",
                        "Split the work into smaller calls.",
                    );
                    return send(jsonrpc::result(id, error.result()));
                }
                let progress_token = params
                    .get("_meta")
                    .and_then(|meta| meta.get("progressToken"))
                    .filter(|token| token.is_string() || token.is_number())
                    .cloned();
                vec![Action::Call(CallRequest {
                    request_id: id.clone(),
                    tool: tool.name.clone(),
                    arguments_json,
                    progress_token,
                })]
            }
        }
    }
}
