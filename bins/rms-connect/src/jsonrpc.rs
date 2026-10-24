use serde_json::{Map, Value, json};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const RESOURCE_NOT_FOUND: i64 = -32002;

#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Response,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Refused {
    pub id: Value,
    pub code: i64,
    pub message: &'static str,
}

pub fn parse_line(line: &[u8]) -> Result<Incoming, Refused> {
    let refused = |id: Value, code, message| Refused { id, code, message };
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| refused(Value::Null, PARSE_ERROR, "The message is not valid JSON."))?;
    let object = match value {
        Value::Object(object) => object,
        Value::Array(_) => {
            return Err(refused(
                Value::Null,
                INVALID_REQUEST,
                "Batches are not supported; send one message per line.",
            ));
        }
        _ => {
            return Err(refused(
                Value::Null,
                INVALID_REQUEST,
                "The message is not a JSON-RPC object.",
            ));
        }
    };
    let id = match object.get("id") {
        None => None,
        Some(id @ (Value::String(_) | Value::Number(_))) => Some(id.clone()),
        Some(_) => {
            return Err(refused(
                Value::Null,
                INVALID_REQUEST,
                "The request id must be a string or a number.",
            ));
        }
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(refused(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "The message is not JSON-RPC 2.0.",
        ));
    }
    let params = object.get("params").cloned();
    match (object.get("method"), id) {
        (Some(Value::String(method)), Some(id)) => Ok(Incoming::Request {
            id,
            method: method.clone(),
            params,
        }),
        (Some(Value::String(method)), None) => Ok(Incoming::Notification {
            method: method.clone(),
            params,
        }),
        (None, Some(_)) if object.contains_key("result") || object.contains_key("error") => {
            Ok(Incoming::Response)
        }
        (_, id) => Err(refused(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "The message has no method.",
        )),
    }
}

pub fn params_object(params: Option<&Value>) -> Result<Map<String, Value>, &'static str> {
    match params {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(_) => Err("The params must be an object."),
    }
}

pub fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}
