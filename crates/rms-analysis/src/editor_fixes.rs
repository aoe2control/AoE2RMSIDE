use rms_source::{ByteOffset, ByteRange, SourceText};
use rms_syntax::TokenKind;

use crate::lint::{Document, line_break};
use crate::{DocumentAnalysis, LintEdit, LintFix, unique_closest};

pub fn missing_closer_fix(
    source: &SourceText,
    analysis: &DocumentAnalysis,
    code: &str,
    range: ByteRange,
) -> Option<LintFix> {
    let open_constructs = analysis
        .diagnostics
        .iter()
        .filter(|diagnostic| matches!(diagnostic.code.as_str(), "RMS1103" | "RMS1104"))
        .count();
    let structural_errors = analysis.diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "RMS1101" | "RMS1102" | "RMS1002" | "RMS1010"
        )
    });
    if open_constructs != 1 || structural_errors {
        return None;
    }
    let tokens = &analysis.cst.tokens;
    let opener = tokens
        .iter()
        .position(|token| token.range.start == range.start && !token.kind.is_trivia())?;
    let bytes = source.bytes();
    let (closer, title) = match code {
        "RMS1103" if tokens[opener].kind == TokenKind::LBrace => {
            if tokens[opener + 1..]
                .iter()
                .any(|token| matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace))
            {
                return None;
            }
            ("}".to_owned(), "Add the missing } at the end of the file")
        }
        "RMS1104" => {
            let document = Document::new(source, analysis);
            let opener_text = document.text(&tokens[opener]);
            if opener_text != "if" {
                return None;
            }
            if tokens[opener + 1..].iter().any(|token| {
                !token.kind.is_trivia() && matches!(document.text(token), "if" | "endif")
            }) {
                return None;
            }
            let line_start = bytes[..range.start.0 as usize]
                .iter()
                .rposition(|byte| matches!(byte, b'\n' | b'\r'))
                .map_or(0, |index| index + 1);
            let indentation = String::from_utf8_lossy(
                &bytes[line_start..range.start.0 as usize]
                    .iter()
                    .copied()
                    .take_while(|byte| matches!(byte, b' ' | b'\t'))
                    .collect::<Vec<_>>(),
            )
            .into_owned();
            (
                format!("{indentation}endif"),
                "Add the missing endif at the end of the file",
            )
        }
        _ => return None,
    };
    let newline = line_break(bytes);
    let ends_with_break = bytes
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'));
    let end = ByteOffset(bytes.len() as u32);
    Some(LintFix {
        title: title.to_owned(),
        edits: vec![LintEdit {
            range: ByteRange { start: end, end },
            replacement: if ends_with_break {
                format!("{closer}{newline}")
            } else {
                format!("{newline}{closer}{newline}")
            },
        }],
        preferred: true,
    })
}

pub fn undefined_name_fix(
    source: &SourceText,
    analysis: &DocumentAnalysis,
    range: ByteRange,
    name: &str,
    defined: &[&str],
) -> Option<LintFix> {
    let tokens = &analysis.cst.tokens;
    let first = tokens.partition_point(|token| token.range.start < range.start);
    let mut occurrences = tokens[first..]
        .iter()
        .take_while(|token| token.range.end <= range.end)
        .filter(|token| {
            token.kind == TokenKind::Identifier && token.bytes(source) == name.as_bytes()
        });
    let token = occurrences.next()?;
    if occurrences.next().is_some() {
        return None;
    }
    let replacement = closest_name(name, defined)?;
    Some(LintFix {
        title: format!("Change to '{replacement}'"),
        edits: vec![LintEdit {
            range: token.range,
            replacement: replacement.to_owned(),
        }],
        preferred: true,
    })
}

pub fn closest_name<'n>(name: &str, defined: &[&'n str]) -> Option<&'n str> {
    if defined.contains(&name) {
        return None;
    }
    unique_closest(name, defined)
}
