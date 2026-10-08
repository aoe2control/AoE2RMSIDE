use crate::catalog::{Builtin, Documentation, DocumentationSource, XsBuild};

pub const MAXIMUM_BUILTIN_DOCUMENTATION_BYTES: usize = 16 * 1024;

pub struct BuiltinDocumentation {
    pub body: String,
    pub signature_body: String,
    pub parameters: Vec<Option<String>>,
    pub hover_signature: String,
}

pub fn builtin_documentation(builtin: &Builtin, build: Option<XsBuild>) -> String {
    builtin_documentation_view(builtin, build).body
}

pub fn builtin_documentation_view(
    builtin: &Builtin,
    build: Option<XsBuild>,
) -> BuiltinDocumentation {
    let view = render(builtin, build, true);
    if fits(builtin, build, &view) {
        return view;
    }
    let compact = render(builtin, build, false);
    if fits(builtin, build, &compact) {
        return compact;
    }
    BuiltinDocumentation {
        body: "Documentation exceeds the display limit.".to_owned(),
        signature_body: "Documentation exceeds the display limit.".to_owned(),
        parameters: Vec::new(),
        hover_signature: String::new(),
    }
}

pub(crate) fn within_rendered_limit(builtin: &Builtin, build: Option<XsBuild>) -> bool {
    fits(builtin, build, &render(builtin, build, true))
}

fn fits(builtin: &Builtin, build: Option<XsBuild>, view: &BuiltinDocumentation) -> bool {
    let signature = builtin.signature(build);
    let full = view
        .hover_signature
        .len()
        .saturating_add(2)
        .saturating_add(view.body.len());
    let completion = signature.len().saturating_add(view.body.len());
    let signature_help = builtin.params_for(build).iter().zip(&view.parameters).fold(
        signature.len().saturating_add(view.signature_body.len()),
        |size, (param, docs)| {
            size.saturating_add(param.label().len())
                .saturating_add(docs.as_ref().map_or(0, String::len))
        },
    );
    [full, completion, signature_help]
        .into_iter()
        .all(|size| size <= MAXIMUM_BUILTIN_DOCUMENTATION_BYTES)
}

fn render(builtin: &Builtin, build: Option<XsBuild>, expanded: bool) -> BuiltinDocumentation {
    let enhanced = builtin.has_documentation_metadata();
    let params = builtin.params_for(build);
    let summary = summary_without_version_notes(&builtin.summary);
    let mut body = escape_prose(&summary);
    let runtimes = builtin
        .runtimes
        .iter()
        .map(|runtime| runtime.label())
        .collect::<Vec<_>>()
        .join(", ");
    body.push_str(&format!("\n\nUsable in: {runtimes}."));
    let mut signature_body = body.clone();
    let parameters = params
        .iter()
        .map(|param| {
            expanded
                .then(|| param.documentation.as_ref().map(documentation))
                .flatten()
        })
        .collect::<Vec<_>>();
    if expanded {
        for (param, docs) in params.iter().zip(&parameters) {
            if let Some(docs) = docs {
                body.push_str(&format!("\n\n{}: {docs}", inline_code(&param.name)));
            }
        }
        if let Some(docs) = &builtin.return_documentation {
            let text = format!("\n\n**Return value**\n\n{}", documentation(docs));
            body.push_str(&text);
            signature_body.push_str(&text);
        }
        if !builtin.related_identifiers.is_empty() {
            let names = builtin
                .related_identifiers
                .iter()
                .map(|name| inline_code(name))
                .collect::<Vec<_>>()
                .join(", ");
            let label = if builtin
                .related_identifiers
                .iter()
                .any(|name| name.starts_with("cPanel"))
            {
                "Reference labels"
            } else {
                "Related"
            };
            let text = format!("\n\n{label}: {names}.");
            body.push_str(&text);
            signature_body.push_str(&text);
        }
    }
    if enhanced && params.iter().any(|param| param.default.is_none()) {
        let note = "\n\nTrailing arguments may be omitted.";
        body.push_str(note);
        signature_body.push_str(note);
    }
    if builtin.reference_source == Some(DocumentationSource::Aoe2DeUgcGuide) {
        let source = "\n\n[AoE2DE UGC Guide](https://ugc.aoe2.rocks/general/xs/)";
        body.push_str(source);
        signature_body.push_str(source);
    }
    let signature = builtin.signature(build);
    let declaration = if enhanced && expanded && signature.len() > 100 && !params.is_empty() {
        format!(
            "{} {}(\n  {}\n)",
            builtin.return_type_for(build).label(),
            builtin.name,
            params
                .iter()
                .map(|param| param.label())
                .collect::<Vec<_>>()
                .join(",\n  ")
        )
    } else {
        signature
    };
    BuiltinDocumentation {
        body,
        signature_body,
        parameters,
        hover_signature: code_block(&declaration),
    }
}

fn documentation(value: &Documentation) -> String {
    escape_prose(&value.text)
}

fn escape_prose(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn code_block(text: &str) -> String {
    let mut run = 0;
    let mut longest = 0;
    for character in text.chars() {
        run = if character == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}xs\n{text}\n{fence}")
}

fn inline_code(text: &str) -> String {
    let longest = text
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    if longest == 0 {
        format!("{fence}{text}{fence}")
    } else {
        format!("{fence} {text} {fence}")
    }
}

fn summary_without_version_notes(summary: &str) -> String {
    let mut text = String::with_capacity(summary.len());
    let mut rest = summary;
    while let Some(open) = rest.find('(') {
        let Some(close) = rest[open..].find(')').map(|close| open + close) else {
            break;
        };
        let note = &rest[open + 1..close];
        if note
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| word.eq_ignore_ascii_case("4x") || word.eq_ignore_ascii_case("5x"))
        {
            text.push_str(rest[..open].trim_end());
        } else {
            text.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    text.push_str(rest);
    text
}
