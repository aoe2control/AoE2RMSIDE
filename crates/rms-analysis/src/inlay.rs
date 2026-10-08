use rms_semantics::{StrictArgumentKind, strict_command};
use rms_source::{ByteOffset, ByteRange, SourceText};
use rms_syntax::{Token, TokenKind};

use crate::DocumentAnalysis;
use crate::lint::{Document, known_head};

pub const MAXIMUM_INLAY_HINTS: usize = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InlayHintKind {
    Value,
    Parameter,
    Content(ContentKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentKind {
    Object,
    Terrain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InlayHint {
    pub position: ByteOffset,
    pub label: String,
    pub kind: InlayHintKind,
    pub content_id: Option<u32>,
}

const PARAMETER_NAMES: &[(&str, &[&str])] = &[
    ("land_position", &["x", "y"]),
    ("circle_radius", &["radius", "variance"]),
    ("height_limits", &["min", "max"]),
    ("replace_terrain", &["terrain", "replacement"]),
    ("terrain_cost", &["terrain", "cost"]),
    ("terrain_size", &["terrain", "size", "variance"]),
    ("spacing_to_specific_terrain", &["terrain", "distance"]),
    ("create_connect_land_zones", &["zone", "zone"]),
    ("add_object", &["object", "weight"]),
    ("create_actor_area", &["x", "y", "id", "radius"]),
    ("effect_amount", &["effect", "object", "attribute", "value"]),
    (
        "effect_percent",
        &["effect", "object", "attribute", "percent"],
    ),
];

const CONTENT_SLOTS: &[(&str, usize, ContentKind)] = &[
    ("terrain_type", 0, ContentKind::Terrain),
    ("base_terrain", 0, ContentKind::Terrain),
    ("create_terrain", 0, ContentKind::Terrain),
    ("terrain_to_place_on", 0, ContentKind::Terrain),
    ("layer_to_place_on", 0, ContentKind::Terrain),
    ("base_layer", 0, ContentKind::Terrain),
    ("beach_terrain", 0, ContentKind::Terrain),
    ("default_terrain_replacement", 0, ContentKind::Terrain),
    ("replace_terrain", 0, ContentKind::Terrain),
    ("replace_terrain", 1, ContentKind::Terrain),
    ("terrain_cost", 0, ContentKind::Terrain),
    ("terrain_size", 0, ContentKind::Terrain),
    ("spacing_to_specific_terrain", 0, ContentKind::Terrain),
    ("create_object", 0, ContentKind::Object),
    ("second_object", 0, ContentKind::Object),
    ("add_object", 0, ContentKind::Object),
];

pub fn content_slot(command: &str, index: usize) -> Option<ContentKind> {
    CONTENT_SLOTS
        .iter()
        .find(|(name, slot, _)| *name == command && *slot == index)
        .map(|(_, _, kind)| *kind)
}

pub fn operand_names(command: &str) -> Option<&'static [&'static str]> {
    PARAMETER_NAMES
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, names)| *names)
}

fn statements<'t>(document: &Document<'_>, tokens: &[&'t Token]) -> Vec<Vec<&'t Token>> {
    fn finish<'t>(statements: &mut Vec<Vec<&'t Token>>, current: &mut Vec<&'t Token>) {
        if !current.is_empty() {
            statements.push(std::mem::take(current));
        }
    }
    let mut statements = Vec::new();
    let mut current: Vec<&'t Token> = Vec::new();
    let mut remaining: &[StrictArgumentKind] = &[];
    for token in tokens {
        if matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace) {
            finish(&mut statements, &mut current);
            remaining = &[];
            continue;
        }
        let command = strict_command(document.text(token));
        if let Some((kind, rest)) = remaining.split_first()
            && !(*kind == StrictArgumentKind::TolerantNumber && command.is_some())
        {
            current.push(token);
            remaining = rest;
            if remaining.is_empty() {
                finish(&mut statements, &mut current);
            }
            continue;
        }
        finish(&mut statements, &mut current);
        remaining = &[];
        let Some(command) = command else {
            continue;
        };
        current.push(token);
        remaining = command.arguments;
        if remaining.is_empty() {
            finish(&mut statements, &mut current);
        }
    }
    finish(&mut statements, &mut current);
    statements
}

pub fn inlay_hints(
    source: &SourceText,
    analysis: &DocumentAnalysis,
    range: ByteRange,
    constant_value: &dyn Fn(&str) -> Option<String>,
) -> Vec<InlayHint> {
    let document = Document::new(source, analysis);
    let local_values = local_constant_values(&document);
    let value_of = |name: &str| {
        constant_value(name).or_else(|| {
            local_values
                .iter()
                .find(|(candidate, _)| candidate == name)
                .and_then(|(_, value)| value.clone())
        })
    };
    let mut hints = Vec::new();
    for line in &document.lines {
        let start = line
            .tokens
            .first()
            .map_or(line.full.start, |token| token.range.start);
        if start < range.start || start > range.end || line.uncertain {
            continue;
        }
        for statement in statements(&document, &line.tokens) {
            statement_hints(&document, &statement, &value_of, &mut hints);
        }
        if hints.len() >= MAXIMUM_INLAY_HINTS {
            break;
        }
    }
    hints.sort_by_key(|hint| hint.position);
    hints.dedup_by(|later, earlier| {
        later.position == earlier.position && later.label == earlier.label
    });
    hints.truncate(MAXIMUM_INLAY_HINTS);
    hints
}

fn statement_hints(
    document: &Document<'_>,
    statement: &[&Token],
    value_of: &dyn Fn(&str) -> Option<String>,
    hints: &mut Vec<InlayHint>,
) {
    let Some((head, operands)) = statement.split_first() else {
        return;
    };
    let name = document.text(head);
    if !known_head(name) {
        return;
    }
    if let Some(names) = operand_names(name) {
        for (operand, label) in operands.iter().zip(names.iter()) {
            hints.push(InlayHint {
                position: operand.range.start,
                label: format!("{label}:"),
                kind: InlayHintKind::Parameter,
                content_id: None,
            });
        }
    }
    let definition = matches!(name, "#const" | "#define");
    let condition = matches!(name, "if" | "elseif");
    for (index, operand) in operands.iter().enumerate() {
        match operand.kind {
            TokenKind::Number => {
                let Some(kind) = content_slot(name, index) else {
                    continue;
                };
                let text = document.text(operand);
                let Ok(id) = text.parse::<u32>() else {
                    continue;
                };
                hints.push(InlayHint {
                    position: operand.range.end,
                    label: text.to_owned(),
                    kind: InlayHintKind::Content(kind),
                    content_id: Some(id),
                });
            }
            TokenKind::Identifier if !condition && !(definition && index == 0) => {
                let text = document.text(operand);
                if let Some(value) = value_of(text) {
                    hints.push(InlayHint {
                        position: operand.range.end,
                        label: format!("= {value}"),
                        kind: InlayHintKind::Value,
                        content_id: None,
                    });
                }
            }
            _ => {}
        }
    }
}

fn local_constant_values(document: &Document<'_>) -> Vec<(String, Option<String>)> {
    let mut values = Vec::<(String, Option<String>)>::new();
    for line in &document.lines {
        if line.uncertain {
            continue;
        }
        for statement in statements(document, &line.tokens) {
            let head = document.text(statement[0]);
            if !matches!(head, "#const" | "#define") {
                continue;
            }
            let Some(name) = statement
                .get(1)
                .filter(|token| token.kind == TokenKind::Identifier)
            else {
                continue;
            };
            let name = document.text(name).to_owned();
            let value = (head == "#const")
                .then(|| statement.get(2))
                .flatten()
                .filter(|token| token.kind == TokenKind::Number)
                .map(|token| document.text(token).to_owned());
            match values.iter_mut().find(|(candidate, _)| *candidate == name) {
                Some((_, existing)) => {
                    if *existing != value {
                        *existing = None;
                    }
                }
                None => values.push((name, value)),
            }
        }
    }
    values
}
