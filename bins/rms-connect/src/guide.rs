use serde_json::{Map, Value, json};

use crate::catalog::Catalog;
use crate::content::ToolError;

pub const PAGE_CHARS: usize = 8_000;
const FOOTER_CHARS: usize = 120;
pub const TOPICS_ID: &str = "topics";
pub const RESOURCE_PREFIX: &str = "rmside://guide/";

pub fn read_guide(catalog: &Catalog, arguments: &Map<String, Value>) -> Result<String, ToolError> {
    let page_maximum = catalog
        .tool("read_guide")
        .and_then(|tool| {
            tool.definition
                .pointer("/inputSchema/properties/page/maximum")
        })
        .and_then(Value::as_u64)
        .unwrap_or(50);
    if let Some(unknown) = arguments
        .keys()
        .find(|key| *key != "topic" && *key != "page")
    {
        return Err(invalid(format!(
            "read_guide has no argument {}.",
            short(unknown)
        )));
    }
    let topic = match arguments.get("topic") {
        Some(Value::String(topic)) if topic == TOPICS_ID || catalog.topic(topic).is_some() => {
            topic.as_str()
        }
        Some(_) => {
            return Err(invalid(
                "topic is not a guide topic. read_guide {topic:'topics'} lists them.".to_owned(),
            ));
        }
        None => return Err(invalid("topic is required.".to_owned())),
    };
    let page = match arguments.get("page") {
        None => 1,
        Some(page) => match page.as_u64() {
            Some(page) if (1..=page_maximum).contains(&page) => page as usize,
            _ => {
                return Err(invalid(format!(
                    "page must be a whole number from 1 to {page_maximum}."
                )));
            }
        },
    };
    let text = topic_text(catalog, topic).expect("the topic was checked");
    let pages = paginate(&text, PAGE_CHARS - FOOTER_CHARS);
    let total = pages.len();
    let Some(body) = pages.get(page - 1) else {
        return Err(ToolError::new(
            "invalid_arguments",
            format!(
                "The topic {topic} has {total} page{}.",
                if total == 1 { "" } else { "s" }
            ),
            format!("Ask for page 1 to {total}."),
        ));
    };
    let mut text = body.clone();
    if total > 1 {
        if page < total {
            text.push_str(&format!(
                "\n\n(Page {page} of {total}. Next: read_guide {{topic:'{topic}', page:{}}})",
                page + 1
            ));
        } else {
            text.push_str(&format!("\n\n(Page {page} of {total}.)"));
        }
    }
    Ok(text)
}

pub fn topic_text(catalog: &Catalog, id: &str) -> Option<String> {
    if id == TOPICS_ID {
        let mut text = String::from("Guide topics. Read one with read_guide {topic:'<id>'}.\n");
        for topic in &catalog.topics {
            text.push_str(&format!("- {}: {}\n", topic.id, topic.summary));
        }
        return Some(text.trim_end().to_owned());
    }
    catalog.topic(id).map(|topic| clean(&topic.text))
}

pub fn resources(catalog: &Catalog) -> Value {
    let mut resources = vec![json!({
        "uri": format!("{RESOURCE_PREFIX}{TOPICS_ID}"),
        "name": TOPICS_ID,
        "title": "Guide topics",
        "description": "The guide topics with one line each.",
        "mimeType": "text/markdown",
    })];
    for topic in &catalog.topics {
        resources.push(json!({
            "uri": format!("{RESOURCE_PREFIX}{}", topic.id),
            "name": topic.id,
            "title": topic.title,
            "description": topic.summary,
            "mimeType": "text/markdown",
        }));
    }
    json!({ "resources": resources })
}

pub fn read_resource(catalog: &Catalog, uri: &str) -> Option<Value> {
    let id = uri.strip_prefix(RESOURCE_PREFIX)?;
    let text = topic_text(catalog, id)?;
    Some(json!({ "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }] }))
}

pub fn clean(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        kept.push_str(&rest[..start]);
        rest = match rest[start..].find("-->") {
            Some(end) => &rest[start + end + 3..],
            None => "",
        };
    }
    kept.push_str(rest);
    kept.trim().to_owned()
}

pub fn paginate(text: &str, budget: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    for section in split_before_headings(text) {
        split_to_budget(section, budget, 0, &mut pieces);
    }
    let mut pages = Vec::new();
    let mut page = String::new();
    let mut page_chars = 0;
    for piece in pieces {
        let chars = piece.chars().count();
        if page_chars + chars > budget && !page.trim().is_empty() {
            pages.push(page.trim().to_owned());
            page.clear();
            page_chars = 0;
        }
        page.push_str(piece);
        page_chars += chars;
    }
    if !page.trim().is_empty() || pages.is_empty() {
        pages.push(page.trim().to_owned());
    }
    pages
}

fn split_before_headings(text: &str) -> Vec<&str> {
    let mut sections = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    let mut fenced = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
        } else if !fenced && trimmed.starts_with('#') && offset > start {
            sections.push(&text[start..offset]);
            start = offset;
        }
        offset += line.len();
    }
    if start < text.len() {
        sections.push(&text[start..]);
    }
    sections
}

fn split_to_budget<'a>(piece: &'a str, budget: usize, level: u8, out: &mut Vec<&'a str>) {
    if piece.chars().count() <= budget {
        out.push(piece);
        return;
    }
    let parts: Vec<&str> = match level {
        0 => split_after(piece, "\n\n"),
        1 => piece.split_inclusive('\n').collect(),
        _ => {
            let mut rest = piece;
            while !rest.is_empty() {
                let end = rest
                    .char_indices()
                    .nth(budget)
                    .map_or(rest.len(), |(index, _)| index);
                out.push(&rest[..end]);
                rest = &rest[end..];
            }
            return;
        }
    };
    for part in parts {
        split_to_budget(part, budget, level + 1, out);
    }
}

fn split_after<'a>(text: &'a str, separator: &str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find(separator) {
        let end = index + separator.len();
        parts.push(&rest[..end]);
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        parts.push(rest);
    }
    parts
}

fn invalid(message: String) -> ToolError {
    ToolError::new(
        "invalid_arguments",
        message,
        "Call read_guide {topic:'topics'} for the list of topics.",
    )
}

fn short(text: &str) -> String {
    text.chars().take(64).collect()
}
