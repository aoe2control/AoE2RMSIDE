use serde_json::{Map, Value, json};
use xs_analysis::{builtin_documentation_view, catalog as xs_catalog};

use crate::{RequestError, RequestResult, Server, rms_docs};

pub(crate) const MAXIMUM_NAME_CHARS: usize = 64;
const CLOSE_NAMES: usize = 5;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReferenceKind {
    Command,
    Attribute,
    Constant,
    Xs,
}

impl ReferenceKind {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "command" => Some(Self::Command),
            "attribute" => Some(Self::Attribute),
            "constant" => Some(Self::Constant),
            "xs" => Some(Self::Xs),
            _ => None,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Attribute => "attribute",
            Self::Constant => "constant",
            Self::Xs => "xs",
        }
    }
}

fn valid_name(name: &str) -> bool {
    let body = name.strip_prefix(['#', '<']).unwrap_or(name);
    let body = body.strip_suffix('>').unwrap_or(body);
    let mut characters = body.chars();
    !name.is_empty()
        && name.chars().count() <= MAXIMUM_NAME_CHARS
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '.'
        })
}

fn parse_params(params: &Value) -> RequestResult<(&str, Option<ReferenceKind>)> {
    let object: &Map<String, Value> = params
        .as_object()
        .ok_or_else(|| RequestError::invalid("reference lookup parameters must be an object"))?;
    if object.keys().any(|key| key != "name" && key != "kind") {
        return Err(RequestError::invalid(
            "reference lookup accepts only name and kind",
        ));
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| valid_name(name))
        .ok_or_else(|| RequestError::invalid("reference lookup needs a valid name"))?;
    let kind = match object.get("kind") {
        None => None,
        Some(kind) => Some(
            kind.as_str()
                .and_then(ReferenceKind::parse)
                .ok_or_else(|| RequestError::invalid("reference lookup kind is unknown"))?,
        ),
    };
    Ok((name, kind))
}

impl Server {
    pub(crate) fn reference_lookup(&self, params: &Value) -> RequestResult<Value> {
        let (name, wanted) = parse_params(params)?;
        let allows = |kind: ReferenceKind| wanted.is_none_or(|wanted| wanted == kind);
        if let Some((kind, text)) = rms_docs::term_reference(self, name)
            && allows(kind)
        {
            return Ok(found(kind, name, text));
        }
        if allows(ReferenceKind::Constant)
            && let Some(text) = rms_docs::constant_reference(self, name)
        {
            return Ok(found(ReferenceKind::Constant, name, text));
        }
        if allows(ReferenceKind::Xs)
            && let Some(text) = self.xs_reference(name)
        {
            return Ok(found(ReferenceKind::Xs, name, text));
        }
        let mut candidates = if wanted == Some(ReferenceKind::Xs) {
            Vec::new()
        } else {
            rms_docs::reference_names(self)
        };
        if allows(ReferenceKind::Xs)
            && let Ok(catalog) = xs_catalog()
        {
            candidates.extend(
                catalog
                    .builtins()
                    .iter()
                    .map(|builtin| (builtin.name.clone(), ReferenceKind::Xs)),
            );
        }
        candidates.retain(|(_, kind)| allows(*kind));
        let close = close_names(name, candidates)
            .into_iter()
            .map(|(name, kind)| json!({ "name": name, "kind": kind.label() }))
            .collect::<Vec<_>>();
        Ok(json!({ "found": false, "close": close }))
    }

    fn xs_reference(&self, name: &str) -> Option<String> {
        let builtin = xs_catalog().ok()?.get(name)?;
        let build = self.xs_build();
        let view = builtin_documentation_view(builtin, build);
        let mut text = format!("{}\n\n{}", view.hover_signature, view.body);
        if build.is_some_and(|build| !builtin.available_in(build)) {
            text.push_str("\n\nThe selected game version does not have this function.");
        }
        Some(text)
    }
}

fn found(kind: ReferenceKind, name: &str, text: String) -> Value {
    json!({ "found": true, "kind": kind.label(), "name": name, "text": text })
}

fn close_names(
    name: &str,
    candidates: Vec<(String, ReferenceKind)>,
) -> Vec<(String, ReferenceKind)> {
    let wanted = name.to_ascii_lowercase();
    let wanted_chars = wanted.chars().count();
    let limit = (wanted_chars / 3).max(2);
    let mut scored = Vec::new();
    for (candidate, kind) in candidates {
        let lower = candidate.to_ascii_lowercase();
        let length = lower.chars().count();
        let length_difference = length.abs_diff(wanted_chars);
        let score = if lower == wanted {
            0
        } else if wanted_chars >= 3 && (lower.contains(&wanted) || wanted.contains(&lower)) {
            1
        } else if length_difference > limit {
            continue;
        } else {
            match edit_distance(&wanted, &lower, limit) {
                Some(distance) => 1 + distance,
                None => continue,
            }
        };
        scored.push((score, length_difference, candidate, kind));
    }
    scored.sort_by(|left, right| (left.0, left.1, &left.2).cmp(&(right.0, right.1, &right.2)));
    let mut close: Vec<(String, ReferenceKind)> = Vec::new();
    for (_, _, candidate, kind) in scored {
        if close.len() == CLOSE_NAMES {
            break;
        }
        if !close.iter().any(|(known, _)| *known == candidate) {
            close.push((candidate, kind));
        }
    }
    close
}

fn edit_distance(left: &str, right: &str, limit: usize) -> Option<usize> {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];
    for (row, left_byte) in left.iter().enumerate() {
        current[0] = row + 1;
        let mut row_minimum = current[0];
        for (column, right_byte) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_byte != right_byte);
            current[column + 1] = substitution
                .min(previous[column + 1] + 1)
                .min(current[column] + 1);
            row_minimum = row_minimum.min(current[column + 1]);
        }
        if row_minimum > limit {
            return None;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let distance = previous[right.len()];
    (distance <= limit).then_some(distance)
}
