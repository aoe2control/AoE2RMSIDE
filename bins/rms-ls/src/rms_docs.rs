use std::collections::BTreeMap;
use std::sync::OnceLock;

use rms_analysis::docs::{
    DocContext, DocumentationCatalog, TermKind, constant_markdown, documentation_catalog,
    snippet_markdown, term_markdown,
};
use rms_content::packaged_support_bundles;
use rms_source::ByteOffset;
use rms_syntax::{Token, TokenKind};
use serde_json::{Value, json};

use crate::rms_completion::{Block, CaretContext, caret_context};
use crate::{OpenDocument, Server, lsp_range, section_at};

const KIND_FUNCTION: u64 = 3;
const KIND_PROPERTY: u64 = 10;
const KIND_KEYWORD: u64 = 14;
const KIND_SNIPPET: u8 = 15;

fn catalog() -> Option<&'static DocumentationCatalog> {
    documentation_catalog().ok()
}

fn packaged_profile() -> &'static str {
    static PROFILE: OnceLock<String> = OnceLock::new();
    PROFILE.get_or_init(|| {
        packaged_support_bundles()
            .ok()
            .and_then(|bundles| bundles.first())
            .map(|bundle| bundle.manifest.behavior_profile_id.clone())
            .unwrap_or_default()
    })
}

fn packaged_definitions(profile: &str) -> Option<&'static BTreeMap<String, String>> {
    static DEFINITIONS: OnceLock<Vec<(String, BTreeMap<String, String>)>> = OnceLock::new();
    let all = DEFINITIONS.get_or_init(|| {
        packaged_support_bundles()
            .map(|bundles| {
                bundles
                    .iter()
                    .filter_map(|bundle| {
                        Some((
                            bundle.manifest.behavior_profile_id.clone(),
                            bundle.vocabulary().ok()?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    all.iter()
        .find(|(candidate, _)| candidate == profile)
        .or_else(|| all.first())
        .map(|(_, definitions)| definitions)
}

pub(crate) struct Place {
    section: String,
    opener: Option<&'static str>,
    profile: String,
}

impl Place {
    fn context(&self) -> DocContext<'_> {
        DocContext {
            section: (!self.section.is_empty()).then_some(self.section.as_str()),
            opener: self.opener,
            profile: Some(self.profile.as_str()),
        }
    }
}

impl Server {
    pub(crate) fn documentation_profile(&self) -> String {
        self.editor_selection().map_or_else(
            || packaged_profile().to_owned(),
            |catalog| catalog.profile_id().to_owned(),
        )
    }

    fn documentation_place(&self, document: &OpenDocument, offset: ByteOffset) -> Place {
        let tokens = &document.analysis.cst.tokens;
        let before = tokens.partition_point(|token| token.range.end <= offset);
        let line_start = tokens[..before]
            .iter()
            .rposition(|token| token.kind == TokenKind::Newline)
            .map_or(0, |index| index + 1);
        let statement_start = tokens[line_start..before]
            .iter()
            .rposition(|token| matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace))
            .map_or(line_start, |index| line_start + index + 1);
        let at = tokens[statement_start..]
            .iter()
            .find(|token| !token.kind.is_trivia())
            .map_or(offset, |token| token.range.start.min(offset));
        let opener = match caret_context(&document.source, tokens, at) {
            CaretContext::Statement {
                block: Block::Inside(opener),
                ..
            } => opener,
            _ => None,
        };
        Place {
            section: section_at(document, offset),
            opener,
            profile: self.documentation_profile(),
        }
    }

    fn built_in_value(&self, name: &str) -> Option<String> {
        match self.editor_selection() {
            Some(catalog) => catalog.implicit_definitions().get(name).cloned(),
            None => packaged_definitions(packaged_profile())?.get(name).cloned(),
        }
    }
}

fn markdown(value: String) -> Value {
    json!({ "kind": "markdown", "value": value })
}

pub(crate) fn hover(server: &Server, document: &OpenDocument, token: &Token) -> Option<Value> {
    let catalog = catalog()?;
    if !matches!(
        token.kind,
        TokenKind::Identifier | TokenKind::Directive | TokenKind::Section
    ) {
        return None;
    }
    let text = String::from_utf8_lossy(token.bytes(&document.source));
    let name = if text.starts_with("rnd(") {
        "rnd"
    } else {
        text.as_ref()
    };
    let range = lsp_range(&document.source, token.range);
    if let Some(term) = catalog.term(name)
        && term.kind != TermKind::Delimiter
    {
        let place = server.documentation_place(document, token.range.start);
        return Some(json!({
            "contents": markdown(term_markdown(catalog, term, &place.context())),
            "range": range,
        }));
    }
    if token.kind != TokenKind::Identifier {
        return None;
    }
    let value = if let Some(family) = catalog.run_setting_family(name) {
        constant_markdown(Some(family), name, None)
    } else {
        let value = server.built_in_value(name)?;
        constant_markdown(catalog.definition_family(name), name, Some(&value))
    };
    Some(json!({ "contents": markdown(value), "range": range }))
}

pub(crate) fn attach(server: &Server, params: &Value, mut list: Value) -> Value {
    let Some(catalog) = catalog() else {
        return list;
    };
    let Some(place) = completion_place(server, params) else {
        return list;
    };
    let Some(items) = list.get_mut("items").and_then(Value::as_array_mut) else {
        return list;
    };
    let context = place.context();
    for item in items {
        if !matches!(
            item.get("kind").and_then(Value::as_u64),
            Some(KIND_FUNCTION | KIND_PROPERTY | KIND_KEYWORD)
        ) {
            continue;
        }
        let Some(term) = item
            .get("label")
            .and_then(Value::as_str)
            .and_then(|label| catalog.term(label))
        else {
            continue;
        };
        let (signature, _) = term.signature_label(term.usage_for(&context));
        item["detail"] = json!(if signature == term.name {
            term.kind.label().to_owned()
        } else {
            signature
        });
        if let Some(object) = item.as_object_mut() {
            object.remove("documentation");
        }
        item["data"] = json!({
            "rmsDoc": {
                "term": term.name,
                "section": place.section,
                "opener": place.opener,
                "profile": place.profile,
            }
        });
    }
    list
}

fn completion_place(server: &Server, params: &Value) -> Option<Place> {
    let (uri, position) = crate::request_position(params).ok()?;
    let document = server.document(uri).ok()?;
    let offset = crate::byte_offset(&document.source, position).ok()?;
    Some(server.documentation_place(document, offset))
}

pub(crate) fn resolve(params: &Value) -> Option<Value> {
    let reference = params.get("data")?.get("rmsDoc")?;
    let catalog = catalog()?;
    let term = catalog.term(reference.get("term")?.as_str()?)?;
    let field = |name: &str| reference.get(name).and_then(Value::as_str);
    let context = DocContext {
        section: field("section").filter(|section| !section.is_empty()),
        opener: field("opener"),
        profile: field("profile"),
    };
    let mut item = params.clone();
    item["documentation"] = markdown(term_markdown(catalog, term, &context));
    Some(item)
}

pub(crate) fn snippet_items(block: &Block, section: &str, sort: &str) -> Vec<Value> {
    let Some(catalog) = catalog() else {
        return Vec::new();
    };
    let top_level = *block == Block::TopLevel;
    catalog
        .snippets
        .iter()
        .filter(|snippet| snippet.offered(section, top_level))
        .map(|snippet| {
            json!({
                "label": snippet.label,
                "kind": KIND_SNIPPET,
                "sortText": format!("{sort}{}", snippet.label),
                "filterText": snippet.prefix,
                "insertText": snippet.insert_text(),
                "insertTextFormat": 2,
                "detail": "Snippet",
                "documentation": markdown(snippet_markdown(snippet)),
            })
        })
        .collect()
}

pub(crate) fn signature_help(
    server: &Server,
    document: &OpenDocument,
    offset: ByteOffset,
    context: &CaretContext,
) -> Value {
    let Some(catalog) = catalog() else {
        return Value::Null;
    };
    let CaretContext::Operand { head, index, word } = context else {
        return Value::Null;
    };
    let place = server.documentation_place(document, offset);
    let (name, active) = match word.strip_prefix("rnd(") {
        Some(arguments) if !arguments.contains(')') => ("rnd", arguments.matches(',').count()),
        _ => (head.name, *index),
    };
    let Some(term) = catalog.term(name) else {
        return Value::Null;
    };
    let signature = term.signature(&place.context());
    json!({
        "signatures": [{
            "label": signature.label,
            "documentation": markdown(signature.documentation),
            "parameters": signature
                .parameters
                .iter()
                .map(|parameter| json!({
                    "label": [parameter.range.0, parameter.range.1],
                    "documentation": markdown(parameter.documentation.clone()),
                }))
                .collect::<Vec<_>>(),
        }],
        "activeSignature": 0,
        "activeParameter": active,
    })
}
