use std::collections::BTreeSet;

use rms_source::{ByteOffset, ByteRange, SourceText};
use rms_syntax::{CstDocument, CstKind, CstNode, Token, TokenKind};

pub const CONVENTION_VERSION: u32 = 2;
pub const INDENT_WIDTH: usize = 4;

const MAXIMUM_EDITS: usize = 65_536;
const MAXIMUM_REPLACEMENT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormatOptions {
    pub indent_conditionals: bool,
}

impl Default for FormatOptions {
    fn default() -> Self {
        Self {
            indent_conditionals: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatEdit {
    pub range: ByteRange,
    pub replacement: String,
}

pub fn format_document(
    source: &SourceText,
    cst: &CstDocument,
    options: FormatOptions,
) -> Result<Vec<FormatEdit>, String> {
    if cst.source_id != *source.id() {
        return Err("formatter source and CST identities differ".to_owned());
    }

    let bytes = source.bytes();
    let mut edits = Vec::new();
    let mut replacement_bytes = 0usize;
    let mut brace_depth = 0usize;
    let mut conditional_depth = 0usize;
    let mut alignment_lines = Vec::new();
    let mut token_cursor = 0usize;
    let mut node_cursor = 0usize;
    let head_start = |node: &CstNode| cst.tokens[node.token_start as usize].range.start.0 as usize;

    for line in physical_lines(bytes) {
        while cst
            .tokens
            .get(token_cursor)
            .is_some_and(|token| (token.range.end.0 as usize) <= line.start)
        {
            token_cursor += 1;
        }
        let line_tokens = cst.tokens[token_cursor..]
            .iter()
            .take_while(|token| (token.range.start.0 as usize) < line.content_end)
            .collect::<Vec<_>>();
        let block_comment_continuation = line_tokens.iter().any(|token| {
            token.kind == TokenKind::BlockComment
                && (token.range.start.0 as usize) < line.start
                && (token.range.end.0 as usize) > line.start
        });

        let first = first_significant(&line_tokens, line.start, line.content_end);
        let line_nodes_start = node_cursor;
        while cst
            .nodes
            .get(node_cursor)
            .is_some_and(|node| head_start(node) < line.content_end)
        {
            node_cursor += 1;
        }
        let line_nodes = &cst.nodes[line_nodes_start..node_cursor];
        let conditional_word = |node: &CstNode| {
            (node.kind == CstKind::Conditional)
                .then(|| cst.tokens[node.token_start as usize].bytes(source))
        };
        let leading_closing_braces = leading_closing_braces(&line_tokens, line.start);
        let conditional_outdent = usize::from(
            options.indent_conditionals
                && line_nodes.first().is_some_and(|node| {
                    first.is_some_and(|first| first.range.start.0 as usize == head_start(node))
                        && conditional_word(node)
                            .is_some_and(|word| matches!(word, b"elseif" | b"else" | b"endif"))
                }),
        );
        let desired_depth = brace_depth
            .saturating_add(conditional_depth)
            .saturating_sub(leading_closing_braces)
            .saturating_sub(conditional_outdent);

        let indentation_start = if line.start == 0 && bytes.starts_with(b"\xef\xbb\xbf") {
            3
        } else {
            line.start
        };
        let leading_end = scan_horizontal_whitespace(bytes, indentation_start, line.content_end);
        if !block_comment_continuation {
            let desired_width = if first.is_some() {
                desired_depth
                    .checked_mul(INDENT_WIDTH)
                    .ok_or_else(|| "formatter indentation overflowed".to_owned())?
            } else {
                0
            };
            let desired = " ".repeat(desired_width);
            if bytes[indentation_start..leading_end] != *desired.as_bytes() {
                push_edit(
                    &mut edits,
                    &mut replacement_bytes,
                    indentation_start,
                    leading_end,
                    desired,
                )?;
            }
        }

        if let Some(trailing) = line_tokens.iter().rev().find(|token| {
            token.kind == TokenKind::Whitespace && token.range.end.0 as usize == line.content_end
        }) {
            let start = trailing.range.start.0 as usize;
            let end = trailing.range.end.0 as usize;
            let overlaps_leading = start < leading_end && end > indentation_start;
            if !overlaps_leading {
                push_edit(
                    &mut edits,
                    &mut replacement_bytes,
                    start,
                    end,
                    String::new(),
                )?;
            }
        }

        alignment_lines.push(alignment_line(
            source,
            &line_tokens,
            line,
            block_comment_continuation,
            desired_depth,
        ));

        for token in &line_tokens {
            if (token.range.start.0 as usize) < line.start {
                continue;
            }
            match token.kind {
                TokenKind::LBrace => brace_depth = brace_depth.saturating_add(1),
                TokenKind::RBrace => brace_depth = brace_depth.saturating_sub(1),
                _ => {}
            }
        }
        if options.indent_conditionals {
            for word in line_nodes.iter().filter_map(conditional_word) {
                match word {
                    b"if" => conditional_depth = conditional_depth.saturating_add(1),
                    b"endif" => conditional_depth = conditional_depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
    }

    for (start, end) in unaligned_gaps(&mut alignment_lines) {
        push_edit(
            &mut edits,
            &mut replacement_bytes,
            start,
            end,
            " ".to_owned(),
        )?;
    }

    edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
    if edits
        .windows(2)
        .any(|pair| pair[0].range.end > pair[1].range.start)
    {
        return Err("formatter produced overlapping edits".to_owned());
    }
    Ok(edits)
}

pub fn formatting_structure_is_equivalent(
    previous_source: &SourceText,
    previous: &CstDocument,
    next_source: &SourceText,
    next: &CstDocument,
) -> bool {
    if !previous.diagnostics.is_empty() || !next.diagnostics.is_empty() {
        return false;
    }
    let previous_tokens = previous
        .tokens
        .iter()
        .filter(|token| token.kind != TokenKind::Whitespace)
        .map(|token| (token.kind, token.bytes(previous_source)))
        .collect::<Vec<_>>();
    let next_tokens = next
        .tokens
        .iter()
        .filter(|token| token.kind != TokenKind::Whitespace)
        .map(|token| (token.kind, token.bytes(next_source)))
        .collect::<Vec<_>>();
    let previous_structure = previous
        .nodes
        .iter()
        .map(|node| (node.kind, node.depth))
        .collect::<Vec<_>>();
    let next_structure = next
        .nodes
        .iter()
        .map(|node| (node.kind, node.depth))
        .collect::<Vec<_>>();
    previous_tokens == next_tokens && previous_structure == next_structure
}

pub fn apply_edits(source: &[u8], edits: &[FormatEdit]) -> Result<Vec<u8>, String> {
    let replacement_bytes = edits
        .iter()
        .map(|edit| edit.replacement.len())
        .sum::<usize>();
    let removed_bytes = edits
        .iter()
        .map(|edit| (edit.range.end.0 - edit.range.start.0) as usize)
        .sum::<usize>();
    let capacity = source
        .len()
        .checked_sub(removed_bytes)
        .and_then(|length| length.checked_add(replacement_bytes))
        .ok_or_else(|| "formatted document size overflowed".to_owned())?;
    let mut result = Vec::with_capacity(capacity);
    let mut cursor = 0usize;
    for edit in edits {
        let start = edit.range.start.0 as usize;
        let end = edit.range.end.0 as usize;
        if start < cursor || end < start || end > source.len() {
            return Err("formatter edit range is invalid".to_owned());
        }
        result.extend_from_slice(&source[cursor..start]);
        result.extend_from_slice(edit.replacement.as_bytes());
        cursor = end;
    }
    result.extend_from_slice(&source[cursor..]);
    Ok(result)
}

#[derive(Clone, Copy)]
struct PhysicalLine {
    start: usize,
    content_end: usize,
}

fn physical_lines(bytes: &[u8]) -> Vec<PhysicalLine> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if matches!(bytes[cursor], b'\r' | b'\n') {
            lines.push(PhysicalLine {
                start,
                content_end: cursor,
            });
            if bytes[cursor] == b'\r' && bytes.get(cursor + 1) == Some(&b'\n') {
                cursor += 1;
            }
            cursor += 1;
            start = cursor;
        } else {
            cursor += 1;
        }
    }
    if start < bytes.len() {
        lines.push(PhysicalLine {
            start,
            content_end: bytes.len(),
        });
    }
    lines
}

fn first_significant<'a>(
    tokens: &'a [&Token],
    line_start: usize,
    content_end: usize,
) -> Option<&'a Token> {
    tokens.iter().copied().find(|token| {
        (token.range.end.0 as usize) > line_start
            && (token.range.start.0 as usize) < content_end
            && !matches!(
                token.kind,
                TokenKind::Bom | TokenKind::Whitespace | TokenKind::Newline
            )
    })
}

fn leading_closing_braces(tokens: &[&Token], line_start: usize) -> usize {
    let mut count = 0usize;
    for token in tokens {
        if token.range.end.0 as usize <= line_start
            || matches!(
                token.kind,
                TokenKind::Bom | TokenKind::Whitespace | TokenKind::Newline
            )
        {
            continue;
        }
        if token.kind == TokenKind::RBrace {
            count += 1;
        } else {
            break;
        }
    }
    count
}

fn scan_horizontal_whitespace(bytes: &[u8], mut cursor: usize, end: usize) -> usize {
    while cursor < end && matches!(bytes[cursor], b' ' | b'\t' | 0x0b | 0x0c) {
        cursor += 1;
    }
    cursor
}

fn push_edit(
    edits: &mut Vec<FormatEdit>,
    replacement_bytes: &mut usize,
    start: usize,
    end: usize,
    replacement: String,
) -> Result<(), String> {
    if edits.len() >= MAXIMUM_EDITS {
        return Err("formatter edit count exceeds its bound".to_owned());
    }
    *replacement_bytes = replacement_bytes
        .checked_add(replacement.len())
        .ok_or_else(|| "formatter replacement size overflowed".to_owned())?;
    if *replacement_bytes > MAXIMUM_REPLACEMENT_BYTES {
        return Err("formatter replacement size exceeds its bound".to_owned());
    }
    edits.push(FormatEdit {
        range: ByteRange {
            start: ByteOffset(
                u32::try_from(start).map_err(|_| "formatter range overflowed".to_owned())?,
            ),
            end: ByteOffset(
                u32::try_from(end).map_err(|_| "formatter range overflowed".to_owned())?,
            ),
        },
        replacement,
    });
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AlignmentClass {
    Blank,
    CommentOnly,
    Opaque,
    Code { depth: usize },
}

#[derive(Clone, Copy, Debug)]
enum AlignmentItem {
    Token {
        width: usize,
    },
    Gap {
        start: usize,
        end: usize,
        width: usize,
        spaces_only: bool,
    },
}

#[derive(Debug)]
struct AlignmentLine {
    class: AlignmentClass,
    items: Vec<AlignmentItem>,
}

impl AlignmentLine {
    fn has_gap(&self) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item, AlignmentItem::Gap { .. }))
    }

    fn anchors(&self) -> Vec<usize> {
        let mut anchors = Vec::new();
        let mut column = Some(0usize);
        let mut after_gap = false;
        for item in &self.items {
            match *item {
                AlignmentItem::Token { width } => {
                    if after_gap && let Some(column) = column {
                        anchors.push(column);
                    }
                    after_gap = false;
                    column = column.map(|column| column.saturating_add(width));
                }
                AlignmentItem::Gap {
                    width, spaces_only, ..
                } => {
                    after_gap = true;
                    column = column
                        .filter(|_| spaces_only)
                        .map(|column| column.saturating_add(width));
                }
            }
        }
        anchors
    }

    fn wide_gaps(&self) -> Vec<(usize, usize)> {
        let mut gaps = Vec::new();
        let mut column = Some(0usize);
        for (index, item) in self.items.iter().enumerate() {
            match *item {
                AlignmentItem::Token { width } => {
                    column = column.map(|column| column.saturating_add(width));
                }
                AlignmentItem::Gap {
                    width, spaces_only, ..
                } => {
                    column = column
                        .filter(|_| spaces_only)
                        .map(|column| column.saturating_add(width));
                    if width > 1
                        && let Some(column) = column
                    {
                        gaps.push((index, column));
                    }
                }
            }
        }
        gaps
    }
}

fn alignment_line(
    source: &SourceText,
    line_tokens: &[&Token],
    line: PhysicalLine,
    block_comment_continuation: bool,
    depth: usize,
) -> AlignmentLine {
    let is_significant = |token: &&&Token| {
        !matches!(
            token.kind,
            TokenKind::Bom | TokenKind::Whitespace | TokenKind::Newline
        )
    };
    let first = line_tokens.iter().position(|token| is_significant(&token));
    let last = line_tokens.iter().rposition(|token| is_significant(&token));
    let comment_only = line_tokens
        .iter()
        .filter(is_significant)
        .all(|token| matches!(token.kind, TokenKind::BlockComment | TokenKind::LineComment));
    let class = if block_comment_continuation {
        if comment_only {
            AlignmentClass::CommentOnly
        } else {
            AlignmentClass::Opaque
        }
    } else if first.is_none() {
        AlignmentClass::Blank
    } else if comment_only {
        AlignmentClass::CommentOnly
    } else {
        AlignmentClass::Code { depth }
    };
    let mut items = Vec::new();
    if let (AlignmentClass::Code { .. }, Some(first), Some(last)) = (class, first, last) {
        for token in &line_tokens[first..=last] {
            let start = token.range.start.0 as usize;
            let end = (token.range.end.0 as usize).min(line.content_end);
            let bytes = &source.bytes()[start..end];
            if token.kind == TokenKind::Whitespace {
                items.push(AlignmentItem::Gap {
                    start,
                    end,
                    width: bytes.len(),
                    spaces_only: bytes.iter().all(|byte| *byte == b' '),
                });
            } else {
                let width =
                    std::str::from_utf8(bytes).map_or(bytes.len(), |text| text.chars().count());
                items.push(AlignmentItem::Token { width });
            }
        }
    }
    AlignmentLine { class, items }
}

fn unaligned_gaps(lines: &mut [AlignmentLine]) -> Vec<(usize, usize)> {
    let mut above = vec![None; lines.len()];
    let mut below = vec![None; lines.len()];
    let mut previous: Option<usize> = None;
    let mut current_depth: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        match line.class {
            AlignmentClass::Blank | AlignmentClass::Opaque => {
                previous = None;
                current_depth = None;
            }
            AlignmentClass::CommentOnly => {}
            AlignmentClass::Code { depth } => {
                if current_depth != Some(depth) {
                    previous = None;
                    current_depth = Some(depth);
                }
                if line.has_gap() {
                    above[index] = previous;
                    if let Some(previous) = previous {
                        below[previous] = Some(index);
                    }
                    previous = Some(index);
                }
            }
        }
    }

    let mut anchors = lines.iter().map(AlignmentLine::anchors).collect::<Vec<_>>();
    let mut dirty = (0..lines.len())
        .filter(|index| !lines[*index].items.is_empty())
        .collect::<BTreeSet<_>>();
    let mut narrowed = Vec::new();
    while !dirty.is_empty() {
        let mut decisions = Vec::new();
        for &index in &dirty {
            let aligned_with = |neighbour: Option<usize>, column: usize| {
                neighbour.is_some_and(|neighbour| anchors[neighbour].binary_search(&column).is_ok())
            };
            let unaligned = lines[index]
                .wide_gaps()
                .into_iter()
                .filter(|(_, column)| {
                    !aligned_with(above[index], *column) && !aligned_with(below[index], *column)
                })
                .map(|(item, _)| item)
                .collect::<Vec<_>>();
            if !unaligned.is_empty() {
                decisions.push((index, unaligned));
            }
        }
        let mut next = BTreeSet::new();
        for (index, items) in decisions {
            for item in items {
                if let AlignmentItem::Gap {
                    start, end, width, ..
                } = &mut lines[index].items[item]
                {
                    *width = 1;
                    narrowed.push((*start, *end));
                }
            }
            anchors[index] = lines[index].anchors();
            next.insert(index);
            next.extend(above[index]);
            next.extend(below[index]);
        }
        dirty = next;
    }
    narrowed
}
