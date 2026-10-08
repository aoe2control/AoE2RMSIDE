use rms_source::{ByteOffset, ByteRange};
use xs_syntax::{Item, Stmt, StmtKind, Token, TokenKind, XsLexerLimits, lex};

use crate::model::XsFile;

pub const XS_FORMATTER_CONVENTION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextEdit {
    pub range: ByteRange,
    pub replacement: String,
}

pub fn format_document(file: &XsFile, indent: &str) -> Result<Vec<TextEdit>, String> {
    if file
        .tree
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code.starts_with("XS1") || diagnostic.code.starts_with("XS2"))
    {
        return Err("the script has syntax errors; fix them before formatting".to_owned());
    }
    if !indent
        .chars()
        .all(|character| character == ' ' || character == '\t')
    {
        return Err("indentation must be spaces or tabs".to_owned());
    }
    let bytes = file.source.bytes();
    let tokens = &file.tree.tokens;
    let depths = token_depths(tokens);
    let mut dangling = Vec::new();
    for item in &file.tree.items {
        let body = match item {
            Item::Function(function) => function.body.as_ref(),
            Item::Rule(rule) => rule.body.as_ref(),
            _ => None,
        };
        if let Some(body) = body {
            collect_dangling(&body.stmts, &mut dangling);
        }
    }
    let content_start = if bytes.starts_with(b"\xef\xbb\xbf") {
        3
    } else {
        0
    };
    let mut edits = Vec::new();
    let mut line_start = content_start;
    while line_start <= bytes.len() {
        let mut line_end = line_start;
        while line_end < bytes.len() && !matches!(bytes[line_end], b'\r' | b'\n') {
            line_end += 1;
        }
        let next = if line_end < bytes.len() {
            if bytes[line_end] == b'\r' && bytes.get(line_end + 1) == Some(&b'\n') {
                line_end + 2
            } else {
                line_end + 1
            }
        } else {
            bytes.len() + 1
        };
        format_line(
            bytes, tokens, &depths, &dangling, indent, line_start, line_end, &mut edits,
        );
        line_start = next;
    }
    verify_tokens(file, &edits)?;
    Ok(edits)
}

#[allow(clippy::too_many_arguments)]
fn format_line(
    bytes: &[u8],
    tokens: &[Token],
    depths: &[(u32, u32)],
    dangling: &[ByteRange],
    indent: &str,
    line_start: usize,
    line_end: usize,
    edits: &mut Vec<TextEdit>,
) {
    let is_space = |byte: u8| matches!(byte, b' ' | b'\t' | 0x0b | 0x0c);
    let mut first = line_start;
    while first < line_end && is_space(bytes[first]) {
        first += 1;
    }
    if first == line_end {
        if line_end > line_start && !inside_comment(tokens, line_start) {
            edits.push(edit(line_start, line_end, String::new()));
        }
        return;
    }
    let mut last = line_end;
    while last > first && is_space(bytes[last - 1]) {
        last -= 1;
    }
    if !inside_comment(tokens, first) {
        let index = tokens.partition_point(|token| token.range.end.0 as usize <= first);
        if let Some(token) = tokens.get(index) {
            let (braces, parens) = depths[index];
            let mut level = braces;
            if token.kind == TokenKind::RBrace {
                level = level.saturating_sub(1);
            }
            let open_parens = if token.kind == TokenKind::RParen {
                parens.saturating_sub(1)
            } else {
                parens
            };
            if open_parens > 0 && !token.kind.is_comment() {
                level += 1;
            }
            level += dangling
                .iter()
                .filter(|range| range.start <= token.range.start && token.range.start < range.end)
                .count() as u32;
            let wanted = indent.repeat(level as usize);
            if bytes[line_start..first] != *wanted.as_bytes() {
                edits.push(edit(line_start, first, wanted));
            }
        }
    }
    if last < line_end && !inside_comment(tokens, last) {
        edits.push(edit(last, line_end, String::new()));
    }
}

fn edit(start: usize, end: usize, replacement: String) -> TextEdit {
    TextEdit {
        range: ByteRange {
            start: ByteOffset(start as u32),
            end: ByteOffset(end as u32),
        },
        replacement,
    }
}

fn inside_comment(tokens: &[Token], offset: usize) -> bool {
    let index = tokens.partition_point(|token| (token.range.end.0 as usize) <= offset);
    tokens.get(index).is_some_and(|token| {
        token.kind == TokenKind::BlockComment && (token.range.start.0 as usize) < offset
    })
}

fn token_depths(tokens: &[Token]) -> Vec<(u32, u32)> {
    let mut braces = 0_u32;
    let mut parens = 0_u32;
    tokens
        .iter()
        .map(|token| {
            let before = (braces, parens);
            match token.kind {
                TokenKind::LBrace => braces = braces.saturating_add(1),
                TokenKind::RBrace => braces = braces.saturating_sub(1),
                TokenKind::LParen => parens = parens.saturating_add(1),
                TokenKind::RParen => parens = parens.saturating_sub(1),
                _ => {}
            }
            before
        })
        .collect()
}

fn collect_dangling(stmts: &[Stmt], output: &mut Vec<ByteRange>) {
    for stmt in stmts {
        collect_dangling_in(stmt, output);
    }
}

fn body(stmt: &Stmt, output: &mut Vec<ByteRange>) {
    if !matches!(stmt.kind, StmtKind::Block(_)) {
        output.push(stmt.range);
    }
    collect_dangling_in(stmt, output);
}

fn collect_dangling_in(stmt: &Stmt, output: &mut Vec<ByteRange>) {
    match &stmt.kind {
        StmtKind::Block(block) => collect_dangling(&block.stmts, output),
        StmtKind::If {
            then_branch,
            else_branch,
            ..
        } => {
            if let Some(branch) = then_branch {
                body(branch, output);
            }
            if let Some(branch) = else_branch {
                if matches!(branch.kind, StmtKind::If { .. }) {
                    collect_dangling_in(branch, output);
                } else {
                    body(branch, output);
                }
            }
        }
        StmtKind::While {
            body: Some(inner), ..
        }
        | StmtKind::For {
            body: Some(inner), ..
        } => {
            body(inner, output);
        }
        StmtKind::Switch { cases, .. } => {
            for case in cases {
                for inner in &case.body {
                    body(inner, output);
                }
            }
        }
        _ => {}
    }
}

fn verify_tokens(file: &XsFile, edits: &[TextEdit]) -> Result<(), String> {
    let edited = apply(file.source.bytes(), edits);
    let source = rms_source::SourceText::from_bytes(file.id().clone(), edited)
        .map_err(|error| error.to_string())?;
    let significant = |source: &rms_source::SourceText| {
        lex(source, XsLexerLimits::default())
            .tokens
            .into_iter()
            .filter(|token| !matches!(token.kind, TokenKind::Whitespace | TokenKind::Newline))
            .map(|token| {
                let mut bytes = token.bytes(source).to_vec();
                if token.kind == TokenKind::LineComment {
                    while bytes
                        .last()
                        .is_some_and(|byte| matches!(byte, b' ' | b'\t' | 0x0b | 0x0c))
                    {
                        bytes.pop();
                    }
                }
                (token.kind, bytes)
            })
            .collect::<Vec<_>>()
    };
    if significant(&file.source) == significant(&source) {
        Ok(())
    } else {
        Err("formatting would change the script's tokens".to_owned())
    }
}

pub fn apply(bytes: &[u8], edits: &[TextEdit]) -> Vec<u8> {
    let mut result = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    let mut sorted = edits.to_vec();
    sorted.sort_by_key(|edit| (edit.range.start, edit.range.end));
    for edit in sorted {
        let start = edit.range.start.0 as usize;
        let end = edit.range.end.0 as usize;
        result.extend_from_slice(&bytes[cursor..start]);
        result.extend_from_slice(edit.replacement.as_bytes());
        cursor = end;
    }
    result.extend_from_slice(&bytes[cursor..]);
    result
}
