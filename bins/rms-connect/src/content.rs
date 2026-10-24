use rms_connect_protocol::v1;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ToolError {
    #[serde(rename = "error")]
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u32>,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: hint.into(),
            retry_after_s: None,
        }
    }

    pub fn retry_after(mut self, seconds: u32) -> Self {
        self.retry_after_s = Some(seconds);
        self
    }

    pub fn result(&self) -> Value {
        let text = serde_json::to_string(self).expect("a tool error serializes");
        json!({ "content": [{ "type": "text", "text": text }], "isError": true })
    }
}

pub fn text_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

pub fn relayed_result(result: &v1::CallResult) -> Value {
    use v1::content_item::Item;

    let content: Vec<Value> = result
        .content
        .iter()
        .filter_map(|item| match item.item.as_ref()? {
            Item::Text(text) => Some(json!({ "type": "text", "text": text })),
            Item::Image(image) => Some(json!({
                "type": "image",
                "data": base64(&image.png),
                "mimeType": "image/png",
            })),
        })
        .collect();
    if result.is_error {
        json!({ "content": content, "isError": true })
    } else {
        json!({ "content": content })
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                text.push(ALPHABET[((triple >> (18 - 6 * index)) & 0x3f) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}
