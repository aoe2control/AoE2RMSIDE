use std::collections::{BTreeMap, BTreeSet};

use rms_semantics::{
    ArgumentResolution, Braces, NativeIgnoredContext, ParsedDecisionKind, SemanticProgram,
    WordAction, WordDefinitions, WordPlace, first_word_action, strict_command_arity,
    strict_command_names,
};
use rms_source::{ByteOffset, ByteRange, SourceId, SourceText};
use rms_syntax::{CstKind, Token, TokenKind};

use crate::DocumentAnalysis;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum LintSeverity {
    Warning,
    Information,
    Hint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LintRule {
    pub code: &'static str,
    pub severity: LintSeverity,
    pub title: &'static str,
    pub rationale: &'static str,
}

pub const UNKNOWN_COMMAND: &str = "RMS4001";
pub const UNUSED_DEFINITION: &str = "RMS4002";
pub const NO_EFFECT_HERE: &str = "RMS4003";
pub const OVERWRITTEN_ATTRIBUTE: &str = "RMS4004";
pub const BRANCH_NEVER_CHOSEN: &str = "RMS4005";
pub const ZERO_CHANCE_FIRST_BRANCH: &str = "RMS4006";
pub const CLAMPED_VALUE: &str = "RMS4007";
pub const IGNORED_REDEFINITION: &str = "RMS4008";
pub const NOT_A_COMMENT: &str = "RMS4009";
pub const NUMBER_FOR_A_NAME: &str = "RMS4010";
pub const POSSIBLY_UNDEFINED_NAME: &str = "RMS4011";

pub const LINT_RULES: &[LintRule] = &[
    LintRule {
        code: UNKNOWN_COMMAND,
        severity: LintSeverity::Warning,
        title: "Unknown command",
        rationale: "The game looks commands up by their spelling and skips any word it does not know, so a misspelled or wrongly capitalized command does nothing.",
    },
    LintRule {
        code: UNUSED_DEFINITION,
        severity: LintSeverity::Hint,
        title: "Unused definition",
        rationale: "A #define or #const that nothing in the script or its includes reads has no effect; it is often a leftover or a misspelled name.",
    },
    LintRule {
        code: NO_EFFECT_HERE,
        severity: LintSeverity::Warning,
        title: "Command has no effect here",
        rationale: "The game recognizes the command, but the handler of its section ignores it in this place (for example an attribute that create_object has no case for), and #undefine never removes a definition.",
    },
    LintRule {
        code: OVERWRITTEN_ATTRIBUTE,
        severity: LintSeverity::Warning,
        title: "Attribute set again",
        rationale: "The attribute only stores its value in the current block, so a later line with the same attribute in the same block replaces it.",
    },
    LintRule {
        code: BRANCH_NEVER_CHOSEN,
        severity: LintSeverity::Warning,
        title: "Random branch never chosen",
        rationale: "The game rolls a number from 0 to 99 and walks the percent_chance weights in order; a branch whose turn no roll reaches never runs.",
    },
    LintRule {
        code: ZERO_CHANCE_FIRST_BRANCH,
        severity: LintSeverity::Information,
        title: "Zero-chance first branch",
        rationale: "The first branch is chosen when the roll (0 to 99) is at most its weight, so a first branch with chance 0 still runs on a roll of 0.",
    },
    LintRule {
        code: CLAMPED_VALUE,
        severity: LintSeverity::Warning,
        title: "Value is clamped",
        rationale: "The game limits cliff_type to the cliff types 0 to 5 and cliff_curliness to 100, and uses the nearest allowed value instead.",
    },
    LintRule {
        code: IGNORED_REDEFINITION,
        severity: LintSeverity::Warning,
        title: "Constant already defined",
        rationale: "The first definition of a constant wins; a later #const with another value is ignored.",
    },
    LintRule {
        code: NOT_A_COMMENT,
        severity: LintSeverity::Warning,
        title: "Not a comment in the game",
        rationale: "The game splits a script into words and only skips what stands between the words /* and */ written apart. // and ; are ordinary words, and so are /* or */ glued to other text, so the words after them still run. After // or ; the finding is only a hint when the game skips every word after it on the line: none is a command, a defined name or a random value it acts on there.",
    },
    LintRule {
        code: NUMBER_FOR_A_NAME,
        severity: LintSeverity::Warning,
        title: "Number where a name is needed",
        rationale: "Where a command reads an object, terrain, effect, resource or attribute, the game looks the word up among the defined names only. A plain number is not one of them, so the game ignores the whole command. Amounts and other numeric values still take numbers.",
    },
    LintRule {
        code: POSSIBLY_UNDEFINED_NAME,
        severity: LintSeverity::Hint,
        title: "Name may be undefined",
        rationale: "The game reads a script once from top to bottom, runs only the branch of an if or a random block that applies, and knows a #define or #const only from its line on. A name that only some branches define is missing on the other paths: a command that reads it as a name is then ignored, and a number it reads counts as 0. Paths that depend on lobby settings or on included files are not judged.",
    },
];

pub fn lint_rule(code: &str) -> Option<&'static LintRule> {
    LINT_RULES.iter().find(|rule| rule.code == code)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LintEdit {
    pub range: ByteRange,
    pub replacement: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LintFix {
    pub title: String,
    pub edits: Vec<LintEdit>,
    pub preferred: bool,
}

pub const MAXIMUM_LINT_RELATED: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LintRelated {
    pub source_id: Option<SourceId>,
    pub range: ByteRange,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LintFinding {
    pub code: &'static str,
    pub severity: LintSeverity,
    pub message: String,
    pub range: ByteRange,
    pub unnecessary: bool,
    pub fix: Option<LintFix>,
    pub related: Vec<LintRelated>,
}

pub struct ProgramView<'a> {
    pub program: &'a SemanticProgram,
    pub game_definitions: &'a BTreeMap<String, String>,
    pub setup_definitions: &'a BTreeMap<String, String>,
    pub source: &'a dyn Fn(&SourceId) -> Option<&'a SourceText>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Predefined {
    Always,
    Maybe,
    Never,
}

pub struct LintEnvironment<'a> {
    pub external_names: Option<&'a BTreeSet<String>>,
    pub defined_elsewhere: &'a dyn Fn(&str) -> bool,
    pub definitions_elsewhere: &'a dyn Fn(&str) -> WordDefinitions,
    pub is_entry_script: bool,
    pub program: Option<ProgramView<'a>>,
    pub predefined: Option<&'a dyn Fn(&str) -> Predefined>,
    pub disabled: &'a BTreeSet<String>,
}

impl LintEnvironment<'_> {
    fn enabled(&self, code: &str) -> bool {
        !self.disabled.contains(code)
    }
}

pub fn lint_document(
    source: &SourceText,
    analysis: &DocumentAnalysis,
    environment: &LintEnvironment<'_>,
) -> Vec<LintFinding> {
    let document = Document::new(source, analysis);
    let mut findings = Vec::new();
    if environment.enabled(UNKNOWN_COMMAND) {
        unknown_commands(&document, environment, &mut findings);
    }
    if environment.enabled(UNUSED_DEFINITION) {
        unused_definitions(&document, environment, &mut findings);
    }
    if environment.enabled(NO_EFFECT_HERE) {
        undefine_lines(&document, &mut findings);
    }
    if environment.enabled(OVERWRITTEN_ATTRIBUTE) || environment.enabled(CLAMPED_VALUE) {
        block_attributes(&document, environment, &mut findings);
    }
    if environment.enabled(BRANCH_NEVER_CHOSEN) || environment.enabled(ZERO_CHANCE_FIRST_BRANCH) {
        random_branches(&document, environment, &mut findings);
    }
    if environment.enabled(NOT_A_COMMENT) {
        comment_look_alikes(&document, environment, &mut findings);
    }
    if environment.enabled(POSSIBLY_UNDEFINED_NAME) {
        crate::undefined_paths::possibly_undefined_names(&document, environment, &mut findings);
    }
    if let Some(view) = &environment.program {
        if environment.enabled(NO_EFFECT_HERE) {
            ignored_operations(&document, view, &mut findings);
        }
        if environment.enabled(IGNORED_REDEFINITION) {
            ignored_redefinitions(&document, view, &mut findings);
        }
        if environment.enabled(NUMBER_FOR_A_NAME) {
            numbers_for_names(&document, view, &mut findings);
        }
    }
    findings.retain(|finding| environment.enabled(finding.code));
    let suppressions = Suppressions::read(&document);
    findings.retain(|finding| !suppressions.silences(&document, finding));
    findings.sort_by_key(|finding| (finding.range.start, finding.range.end, finding.code));
    findings.dedup_by(|later, earlier| later.code == earlier.code && later.range == earlier.range);
    findings
}

pub fn suppression_edit(source: &SourceText, finding_start: ByteOffset, code: &str) -> LintEdit {
    let bytes = source.bytes();
    let start = line_start(bytes, finding_start.0 as usize);
    let indentation = bytes[start..]
        .iter()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let newline = line_break(bytes);
    LintEdit {
        range: ByteRange {
            start: ByteOffset(start as u32),
            end: ByteOffset(start as u32),
        },
        replacement: format!(
            "{}/* {SUPPRESS_LINE} {code} */{newline}",
            String::from_utf8_lossy(&bytes[start..start + indentation])
        ),
    }
}

const SUPPRESS_LINE: &str = "rmside-ignore";
const SUPPRESS_FILE: &str = "rmside-ignore-file";

pub(crate) struct Line<'a> {
    pub(crate) kind: CstKind,
    pub(crate) depth: u32,
    pub(crate) tokens: Vec<&'a Token>,
    pub(crate) has_comment: bool,
    pub(crate) full: ByteRange,
    pub(crate) uncertain: bool,
}

pub(crate) struct Document<'a> {
    pub(crate) source: &'a SourceText,
    pub(crate) analysis: &'a DocumentAnalysis,
    pub(crate) lines: Vec<Line<'a>>,
    pub(crate) suspicious_comments: Vec<ByteRange>,
    pub(crate) defined_here: BTreeSet<String>,
    pub(crate) defined_unconditionally: BTreeSet<String>,
}

impl<'a> Document<'a> {
    pub(crate) fn new(source: &'a SourceText, analysis: &'a DocumentAnalysis) -> Self {
        let tokens = &analysis.cst.tokens;
        let mut suspicious_comments = Vec::new();
        for token in tokens {
            let text = token.bytes(source);
            let suspicious = match token.kind {
                TokenKind::BlockComment => block_comment_may_end_early(text),
                TokenKind::LineComment => {
                    text.first() == Some(&b';')
                        && text.get(1).is_some_and(|byte| !byte.is_ascii_whitespace())
                }
                _ => false,
            };
            if suspicious {
                suspicious_comments.push(token.range);
            }
        }
        struct Group {
            kind: CstKind,
            depth: u32,
            start: usize,
            end: usize,
            spans_lines: bool,
            starts_mid_statement: bool,
        }
        let line_end_after = |index: usize| {
            let mut end = index;
            while end < tokens.len() && tokens[end].kind != TokenKind::Newline {
                end += 1;
            }
            (end + 1).min(tokens.len())
        };
        let mut groups = Vec::<Group>::new();
        let mut control_depth = 0_u32;
        let mut defined_here = BTreeSet::new();
        let mut definitions = Vec::<(String, bool, usize)>::new();
        for node in &analysis.cst.nodes {
            let head = &tokens[node.token_start as usize];
            let head_text = head.bytes(source);
            let opens_control = matches!(head_text, b"if" | b"start_random");
            let closes_control = matches!(head_text, b"endif" | b"end_random");
            if closes_control {
                control_depth = control_depth.saturating_sub(1);
            }
            let in_control = control_depth > 0 || opens_control || closes_control;
            if opens_control {
                control_depth = control_depth.saturating_add(1);
            }
            let mut physical_start = node.token_start as usize;
            while physical_start > 0 && tokens[physical_start - 1].kind != TokenKind::Newline {
                physical_start -= 1;
            }
            let last = (node.token_end as usize).saturating_sub(1);
            let end = line_end_after(last);
            let spans_lines = tokens[node.token_start as usize..=last]
                .iter()
                .any(|token| token.kind == TokenKind::Newline);
            match groups.last_mut() {
                Some(group) if physical_start < group.end => {
                    group.end = group.end.max(end);
                    group.spans_lines |= spans_lines;
                }
                _ => {
                    let starts_mid_statement = tokens[physical_start..node.token_start as usize]
                        .iter()
                        .any(|token| !token.kind.is_trivia());
                    groups.push(Group {
                        kind: node.kind,
                        depth: node.depth,
                        start: physical_start,
                        end,
                        spans_lines,
                        starts_mid_statement,
                    });
                }
            }
            if node.kind == CstKind::Definition
                && matches!(head_text, b"#define" | b"#const")
                && let Some(name) = tokens[node.token_start as usize + 1..node.token_end as usize]
                    .iter()
                    .find(|token| !token.kind.is_trivia())
                    .filter(|token| token.kind == TokenKind::Identifier)
            {
                let name = String::from_utf8_lossy(name.bytes(source)).into_owned();
                defined_here.insert(name.clone());
                definitions.push((name, in_control, groups.len() - 1));
            }
        }
        let mut lines = Vec::with_capacity(groups.len());
        let mut glued_comment_depth = 0_u32;
        for group in groups {
            let line_tokens = &tokens[group.start..group.end];
            let significant = line_tokens
                .iter()
                .filter(|token| !token.kind.is_trivia())
                .collect::<Vec<_>>();
            let has_comment = line_tokens.iter().any(|token| {
                matches!(token.kind, TokenKind::LineComment | TokenKind::BlockComment)
            });
            let full = ByteRange {
                start: line_tokens
                    .first()
                    .map_or(ByteOffset(0), |token| token.range.start),
                end: line_tokens
                    .last()
                    .map_or(ByteOffset(0), |token| token.range.end),
            };
            let mut uncertain = group.spans_lines
                || group.starts_mid_statement
                || glued_comment_depth > 0
                || overlaps_any(&suspicious_comments, full);
            for token in &significant {
                if !matches!(token.kind, TokenKind::Identifier | TokenKind::Unknown) {
                    continue;
                }
                let text = token.bytes(source);
                let opens = text.starts_with(b"/*");
                let closes = text.ends_with(b"*/");
                if opens || closes {
                    uncertain = true;
                }
                if opens && !(closes && text.len() >= 4) {
                    glued_comment_depth = glued_comment_depth.saturating_add(1);
                } else if closes {
                    glued_comment_depth = glued_comment_depth.saturating_sub(1);
                }
            }
            if glued_comment_depth > 0 {
                uncertain = true;
            }
            lines.push(Line {
                kind: group.kind,
                depth: group.depth,
                tokens: significant,
                has_comment,
                full,
                uncertain,
            });
        }
        let defined_unconditionally = definitions
            .into_iter()
            .filter(|(_, in_control, line)| !in_control && !lines[*line].uncertain)
            .map(|(name, _, _)| name)
            .collect();
        Self {
            source,
            analysis,
            lines,
            suspicious_comments,
            defined_here,
            defined_unconditionally,
        }
    }

    pub(crate) fn text(&self, token: &Token) -> &'a str {
        std::str::from_utf8(token.bytes(self.source)).unwrap_or("")
    }

    fn line_number(&self, offset: ByteOffset) -> u32 {
        self.source
            .byte_to_utf16(offset)
            .map_or(0, |position| position.line + 1)
    }

    fn crosses_suspicious_comment(&self, range: ByteRange) -> bool {
        overlaps_any(&self.suspicious_comments, range)
    }

    fn line_is_only_statement(&self, line: &Line<'_>) -> bool {
        !line.has_comment
            && !line.uncertain
            && line.tokens.iter().all(|token| {
                !matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace)
                    && !contains_random_draw(self.text(token))
            })
    }
}

fn delete_line(line: &Line<'_>) -> LintEdit {
    LintEdit {
        range: line.full,
        replacement: String::new(),
    }
}

fn overlaps_any(sorted: &[ByteRange], range: ByteRange) -> bool {
    let first = sorted.partition_point(|candidate| candidate.end <= range.start);
    sorted
        .get(first)
        .is_some_and(|candidate| candidate.start < range.end)
}

fn contains_random_draw(text: &str) -> bool {
    text.to_ascii_lowercase().contains("rnd(")
}

fn line_start(bytes: &[u8], offset: usize) -> usize {
    bytes[..offset.min(bytes.len())]
        .iter()
        .rposition(|byte| matches!(byte, b'\n' | b'\r'))
        .map_or(0, |index| index + 1)
}

pub(crate) fn line_break(bytes: &[u8]) -> &'static str {
    match bytes.iter().position(|byte| matches!(byte, b'\n' | b'\r')) {
        Some(index) if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') => "\r\n",
        Some(index) if bytes[index] == b'\r' => "\r",
        _ => "\n",
    }
}

fn block_comment_may_end_early(text: &[u8]) -> bool {
    text.split(u8::is_ascii_whitespace)
        .filter(|word| !word.is_empty())
        .any(|word| {
            word != b"/*" && word != b"*/" && (word.starts_with(b"/*") || word.ends_with(b"*/"))
        })
}

pub(crate) fn definition_name(source: &SourceText, line: &Line<'_>) -> Option<String> {
    if line.kind != CstKind::Definition || line.uncertain {
        return None;
    }
    let head = line.tokens.first()?.bytes(source);
    if head != b"#define" && head != b"#const" {
        return None;
    }
    let name = line.tokens.get(1)?;
    (name.kind == TokenKind::Identifier)
        .then(|| String::from_utf8_lossy(name.bytes(source)).into_owned())
}

pub(crate) fn known_head(text: &str) -> bool {
    strict_command_arity(text).is_some()
}

fn section_name(header: &str) -> Option<&'static str> {
    Some(match header {
        "<PLAYER_SETUP>" => "player_setup",
        "<LAND_GENERATION>" => "land_generation",
        "<ELEVATION_GENERATION>" => "elevation_generation",
        "<CLIFF_GENERATION>" => "cliff_generation",
        "<TERRAIN_GENERATION>" => "terrain_generation",
        "<CONNECTION_GENERATION>" => "connection_generation",
        "<OBJECTS_GENERATION>" => "objects_generation",
        _ => return None,
    })
}

fn unknown_commands(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    for (index, line) in document.lines.iter().enumerate() {
        if line.uncertain {
            continue;
        }
        let Some(head) = line.tokens.first() else {
            continue;
        };
        if !matches!(head.kind, TokenKind::Identifier | TokenKind::Directive) {
            continue;
        }
        let text = document.text(head);
        if text.is_empty()
            || known_head(text)
            || text.starts_with("/*")
            || text.ends_with("*/")
            || text.starts_with(';')
            || text.starts_with("//")
            || !text.bytes().all(|byte| byte.is_ascii_graphic())
            || !text.bytes().any(|byte| byte.is_ascii_alphabetic())
        {
            continue;
        }
        if document.defined_here.contains(text) || (environment.defined_elsewhere)(text) {
            continue;
        }
        if index > 0 && waits_for_operand(document, &document.lines[index - 1]) {
            continue;
        }
        let joined = line.tokens.get(1).and_then(|next| {
            let joined = format!("{text}_{}", document.text(next));
            let range = ByteRange {
                start: head.range.start,
                end: next.range.end,
            };
            (next.kind == TokenKind::Identifier && suggestable(&joined)).then_some((joined, range))
        });
        let suggestion =
            joined.or_else(|| closest_command(text).map(|name| (name.to_owned(), head.range)));
        let message = match &suggestion {
            Some((name, _)) => format!(
                "'{text}' is not an RMS command, so the game skips it (did you mean '{name}'?)"
            ),
            None => format!("'{text}' is not an RMS command, so the game skips it"),
        };
        findings.push(LintFinding {
            related: Vec::new(),
            code: UNKNOWN_COMMAND,
            severity: LintSeverity::Warning,
            message,
            range: head.range,
            unnecessary: false,
            fix: suggestion.map(|(name, range)| LintFix {
                title: format!("Change to '{name}'"),
                edits: vec![LintEdit {
                    range,
                    replacement: name,
                }],
                preferred: true,
            }),
        });
    }
}

fn waits_for_operand(document: &Document<'_>, line: &Line<'_>) -> bool {
    if line.uncertain {
        return true;
    }
    let Some(head) = line.tokens.first() else {
        return false;
    };
    strict_command_arity(document.text(head)).is_some_and(|arity| line.tokens.len() < arity + 1)
}

fn suggestable(name: &str) -> bool {
    known_head(name)
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'#')
        && !matches!(
            name,
            "if" | "elseif" | "else" | "endif" | "start_random" | "percent_chance" | "end_random"
        )
}

pub fn closest_command(word: &str) -> Option<&'static str> {
    let candidates = strict_command_names()
        .filter(|name| suggestable(name))
        .collect::<Vec<_>>();
    unique_closest(word, &candidates)
}

pub fn unique_closest<'c>(word: &str, candidates: &[&'c str]) -> Option<&'c str> {
    let lowercase = word.to_ascii_lowercase();
    let mut case_variants = candidates
        .iter()
        .filter(|candidate| **candidate != word && candidate.eq_ignore_ascii_case(word));
    if let Some(variant) = case_variants.next() {
        return case_variants.next().is_none().then_some(*variant);
    }
    let mut near = candidates.iter().filter(|candidate| {
        candidate.len().abs_diff(word.len()) <= 1
            && within_one_edit(
                lowercase.as_bytes(),
                candidate.to_ascii_lowercase().as_bytes(),
            )
    });
    let first = near.next()?;
    near.next().is_none().then_some(*first)
}

pub fn within_one_edit(left: &[u8], right: &[u8]) -> bool {
    if left == right {
        return false;
    }
    let prefix = left.iter().zip(right).take_while(|(a, b)| a == b).count();
    let (left_rest, right_rest) = (&left[prefix..], &right[prefix..]);
    match left.len().cmp(&right.len()) {
        std::cmp::Ordering::Equal => {
            left_rest[1..] == right_rest[1..]
                || (left_rest.len() >= 2
                    && left_rest[0] == right_rest[1]
                    && left_rest[1] == right_rest[0]
                    && left_rest[2..] == right_rest[2..])
        }
        std::cmp::Ordering::Less => left_rest == &right_rest[1..],
        std::cmp::Ordering::Greater => &left_rest[1..] == right_rest,
    }
}

fn unused_definitions(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    if !environment.is_entry_script {
        return;
    }
    let Some(external) = environment.external_names else {
        return;
    };
    let source = document.source;
    let mut used = BTreeSet::new();
    let mut definitions = Vec::new();
    for line in &document.lines {
        let definition = definition_name(source, line);
        for (index, token) in line.tokens.iter().enumerate() {
            if definition.is_some() && index == 1 {
                continue;
            }
            if token.kind == TokenKind::Identifier {
                used.insert(document.text(token).to_owned());
            }
        }
        if let Some(name) = definition {
            definitions.push((name, line));
        }
    }
    for token in &document.analysis.cst.tokens {
        if matches!(token.kind, TokenKind::BlockComment | TokenKind::LineComment)
            && overlaps_any(&document.suspicious_comments, token.range)
        {
            for word in document.text(token).split_ascii_whitespace() {
                used.insert(word.trim_start_matches(';').to_owned());
            }
        }
    }
    for (name, line) in definitions {
        if used.contains(&name)
            || external.contains(&name)
            || (environment.defined_elsewhere)(&name)
        {
            continue;
        }
        let name_token = line.tokens[1];
        let removable = document.line_is_only_statement(line);
        findings.push(LintFinding {
            related: Vec::new(),
            code: UNUSED_DEFINITION,
            severity: LintSeverity::Hint,
            message: format!("'{name}' is defined but never used"),
            range: name_token.range,
            unnecessary: true,
            fix: removable.then(|| LintFix {
                title: format!("Remove the unused definition of '{name}'"),
                edits: vec![delete_line(line)],
                preferred: true,
            }),
        });
    }
}

struct OverwriteTable {
    section: &'static str,
    openers: &'static [&'static str],
    attributes: &'static [(&'static str, usize)],
}

const OVERWRITTEN_ATTRIBUTES: &[OverwriteTable] = &[
    OverwriteTable {
        section: "land_generation",
        openers: &["create_land", "create_player_lands"],
        attributes: &[
            ("terrain_type", 1),
            ("base_size", 1),
            ("base_elevation", 1),
            ("number_of_tiles", 1),
            ("other_zone_avoidance_distance", 1),
            ("min_placement_distance", 1),
            ("clumping_factor", 1),
            ("left_border", 1),
            ("right_border", 1),
            ("top_border", 1),
            ("bottom_border", 1),
            ("border_fuzziness", 1),
            ("land_conformity", 1),
            ("generate_mode", 1),
        ],
    },
    OverwriteTable {
        section: "land_generation",
        openers: &["create_land"],
        attributes: &[("land_position", 2)],
    },
    OverwriteTable {
        section: "objects_generation",
        openers: &["create_object"],
        attributes: &[
            ("number_of_objects", 1),
            ("number_of_groups", 1),
            ("group_variance", 1),
            ("group_placement_radius", 1),
            ("set_facet", 1),
            ("resource_delta", 1),
            ("place_on_specific_land_id", 1),
            ("min_distance_to_map_edge", 1),
            ("max_distance_to_other_zones", 1),
            ("min_distance_group_placement", 1),
            ("temp_min_distance_group_placement", 1),
            ("min_connected_tiles", 1),
            ("actor_area", 1),
            ("actor_area_to_place_in", 1),
            ("actor_area_radius", 1),
            ("min_distance_to_players", 1),
            ("max_distance_to_players", 1),
            ("terrain_to_place_on", 1),
            ("layer_to_place_on", 1),
            ("second_object", 1),
        ],
    },
    OverwriteTable {
        section: "terrain_generation",
        openers: &["create_terrain"],
        attributes: &[
            ("base_terrain", 1),
            ("land_percent", 1),
            ("number_of_tiles", 1),
            ("number_of_clumps", 1),
            ("spacing_to_other_terrain_types", 1),
            ("clumping_factor", 1),
            ("height_limits", 2),
            ("terrain_mask", 1),
            ("beach_terrain", 1),
            ("base_layer", 1),
        ],
    },
    OverwriteTable {
        section: "elevation_generation",
        openers: &["create_elevation"],
        attributes: &[
            ("number_of_tiles", 1),
            ("number_of_clumps", 1),
            ("spacing", 1),
            ("base_elevation", 1),
            ("base_terrain", 1),
            ("base_layer", 1),
        ],
    },
    OverwriteTable {
        section: "cliff_generation",
        openers: &[],
        attributes: &[
            ("cliff_type", 1),
            ("min_number_of_cliffs", 1),
            ("max_number_of_cliffs", 1),
            ("min_length_of_cliff", 1),
            ("max_length_of_cliff", 1),
            ("cliff_curliness", 1),
            ("min_distance_cliffs", 1),
            ("min_terrain_distance", 1),
        ],
    },
];

fn overwrite_arity(section: &str, opener: Option<&str>, attribute: &str) -> Option<usize> {
    OVERWRITTEN_ATTRIBUTES
        .iter()
        .filter(|table| table.section == section)
        .filter(|table| match opener {
            Some(opener) => table.openers.contains(&opener),
            None => table.openers.is_empty(),
        })
        .find_map(|table| {
            table
                .attributes
                .iter()
                .find(|(name, _)| *name == attribute)
                .map(|(_, arity)| *arity)
        })
}

#[derive(Clone, Copy, PartialEq)]
struct Block<'d> {
    pair: ByteRange,
    opener: &'d str,
}

fn block_attributes<'d>(
    document: &'d Document<'d>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let blocks = document.blocks();
    let mut section = None::<&'static str>;
    let mut current = None::<Block<'d>>;
    let mut run = BTreeMap::<&'d str, &'d Line<'d>>::new();
    for (line, block) in document.lines.iter().zip(blocks) {
        if block != current {
            run.clear();
            current = block;
        }
        match line.kind {
            CstKind::Section => {
                section = line
                    .tokens
                    .first()
                    .and_then(|head| section_name(document.text(head)));
                run.clear();
            }
            CstKind::Command if line.depth == 0 && section == Some("cliff_generation") => {
                cliff_value(document, line, environment, findings);
                track_overwrite(
                    document,
                    environment,
                    line,
                    "cliff_generation",
                    None,
                    &mut run,
                    findings,
                );
            }
            CstKind::Attribute if line.depth == 1 => {
                let (Some(section), Some(block)) = (section, block) else {
                    run.clear();
                    continue;
                };
                track_overwrite(
                    document,
                    environment,
                    line,
                    section,
                    Some(block.opener),
                    &mut run,
                    findings,
                );
            }
            _ => run.clear(),
        }
    }
}

impl<'d> Document<'d> {
    fn blocks(&'d self) -> Vec<Option<Block<'d>>> {
        let pairs = &self.analysis.cst.brace_pairs;
        let mut ends = BTreeMap::<ByteOffset, usize>::new();
        for pair in pairs {
            *ends.entry(pair.end).or_default() += 1;
        }
        let mut sorted = pairs.clone();
        sorted.sort_by_key(|pair| (pair.start, pair.end));
        let mut next = 0;
        let mut open = Vec::<ByteRange>::new();
        let mut openers = BTreeMap::<ByteOffset, Option<&'d str>>::new();
        let mut result = Vec::with_capacity(self.lines.len());
        for (index, line) in self.lines.iter().enumerate() {
            let start = line
                .tokens
                .first()
                .map_or(line.full.start, |token| token.range.start);
            while next < sorted.len() && sorted[next].start < start {
                open.push(sorted[next]);
                next += 1;
            }
            open.retain(|pair| pair.end > start);
            let block = match open.as_slice() {
                [pair] if ends.get(&pair.end) == Some(&1) => *openers
                    .entry(pair.start)
                    .or_insert_with(|| self.opener_of(index, *pair)),
                _ => None,
            };
            result.push(block.map(|opener| Block {
                pair: *open.last().expect("one open pair"),
                opener,
            }));
        }
        result
    }

    fn opener_of(&self, index: usize, pair: ByteRange) -> Option<&'d str> {
        let holder = self.lines[..index]
            .iter()
            .rposition(|line| line.full.start <= pair.start && pair.start < line.full.end)?;
        let mut line = &self.lines[holder];
        if line.tokens.first()?.kind == TokenKind::LBrace {
            line = &self.lines[holder.checked_sub(1)?];
        }
        if line.uncertain || line.kind != CstKind::Command || line.depth != 0 {
            return None;
        }
        let head = self.text(line.tokens.first()?);
        known_head(head).then_some(head)
    }
}

#[allow(clippy::too_many_arguments)]
fn track_overwrite<'d>(
    document: &'d Document<'d>,
    environment: &LintEnvironment<'_>,
    line: &'d Line<'d>,
    section: &str,
    opener: Option<&str>,
    run: &mut BTreeMap<&'d str, &'d Line<'d>>,
    findings: &mut Vec<LintFinding>,
) {
    let Some(head) = line.tokens.first() else {
        run.clear();
        return;
    };
    let name = document.text(head);
    if line.uncertain || !known_head(name) {
        run.clear();
        return;
    }
    if line
        .tokens
        .iter()
        .any(|token| matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace))
    {
        run.clear();
        return;
    }
    let Some(arity) = overwrite_arity(section, opener, name) else {
        return;
    };
    if line.tokens.len() != arity + 1 || !operands_resolve(document, environment, line) {
        run.remove(name);
        return;
    }
    if let Some(earlier) = run.insert(name, line)
        && environment.enabled(OVERWRITTEN_ATTRIBUTE)
        && !document.crosses_suspicious_comment(ByteRange {
            start: earlier.full.start,
            end: line.full.end,
        })
        && !earlier
            .tokens
            .iter()
            .any(|token| contains_random_draw(document.text(token)))
    {
        let later_line = document.line_number(line.full.start);
        findings.push(LintFinding {
            related: vec![LintRelated {
                source_id: None,
                range: ByteRange {
                    start: line.tokens[0].range.start,
                    end: line.tokens[line.tokens.len() - 1].range.end,
                },
                message: format!("{name} is set again here"),
            }],
            code: OVERWRITTEN_ATTRIBUTE,
            severity: LintSeverity::Warning,
            message: format!(
                "{name} is set again on line {later_line}, so this value has no effect"
            ),
            range: ByteRange {
                start: earlier.tokens[0].range.start,
                end: earlier.tokens[earlier.tokens.len() - 1].range.end,
            },
            unnecessary: true,
            fix: document.line_is_only_statement(earlier).then(|| LintFix {
                title: format!("Remove this {name}"),
                edits: vec![delete_line(earlier)],
                preferred: true,
            }),
        });
    }
}

fn operands_resolve(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    line: &Line<'_>,
) -> bool {
    line.tokens[1..].iter().all(|token| match token.kind {
        TokenKind::Number => true,
        TokenKind::Identifier => {
            let text = document.text(token);
            !contains_random_draw(text)
                && !text.contains(['(', ')'])
                && ((environment.defined_elsewhere)(text)
                    || document.defined_unconditionally.contains(text))
        }
        _ => false,
    })
}

pub(crate) fn literal_value(document: &Document<'_>, token: &Token) -> Option<f32> {
    (token.kind == TokenKind::Number)
        .then(|| document.text(token).parse::<f32>().ok())
        .flatten()
        .filter(|value| value.is_finite())
}

fn clamped(
    line: &Line<'_>,
    token: &Token,
    message: String,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    if !environment.enabled(CLAMPED_VALUE) || line.uncertain {
        return;
    }
    findings.push(LintFinding {
        related: Vec::new(),
        code: CLAMPED_VALUE,
        severity: LintSeverity::Warning,
        message,
        range: token.range,
        unnecessary: false,
        fix: None,
    });
}

fn cliff_value(
    document: &Document<'_>,
    line: &Line<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let [head, operand] = line.tokens.as_slice() else {
        return;
    };
    let Some(value) = literal_value(document, operand) else {
        return;
    };
    match document.text(head) {
        "cliff_curliness" if value.round() > 100.0 && value.round() <= f32::from(u16::MAX) => {
            clamped(
                line,
                operand,
                format!(
                    "cliff_curliness {} works like 100, the largest value the game uses",
                    document.text(operand)
                ),
                environment,
                findings,
            );
        }
        _ => {}
    }
}

fn random_branches(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let mut frames = Vec::<Frame<'_>>::new();
    for line in &document.lines {
        let Some(first) = line.tokens.first() else {
            continue;
        };
        let head = document.text(first);
        let opaque = line.uncertain
            || line.tokens[1..].iter().any(|token| {
                matches!(
                    document.text(token),
                    "start_random" | "percent_chance" | "end_random"
                )
            })
            || first.kind == TokenKind::Number
            || (!known_head(head)
                && (document.defined_here.contains(head) || (environment.defined_elsewhere)(head)));
        if opaque {
            for frame in &mut frames {
                frame.valid = false;
            }
        }
        match head {
            "start_random" => frames.push(Frame {
                start: line.full.start,
                valid: !opaque && line.tokens.len() == 1,
                branches: Vec::new(),
            }),
            "end_random" => {
                let Some(frame) = frames.pop() else {
                    continue;
                };
                let span = ByteRange {
                    start: frame.start,
                    end: line.full.end,
                };
                if frame.valid && !document.crosses_suspicious_comment(span) {
                    report_branches(environment, &frame.branches, findings);
                }
            }
            "percent_chance" => {
                let Some(frame) = frames.last_mut() else {
                    continue;
                };
                if line.tokens.len() != 2 {
                    frame.valid = false;
                    continue;
                }
                let weight = literal_value(document, line.tokens[1])
                    .filter(|value| *value >= i32::MIN as f32 && *value <= i32::MAX as f32)
                    .map(|value| value.round() as i32);
                frame.branches.push(Branch { line, weight });
            }
            _ => {}
        }
    }
}

struct Frame<'l> {
    start: ByteOffset,
    valid: bool,
    branches: Vec<Branch<'l>>,
}

struct Branch<'l> {
    line: &'l Line<'l>,
    weight: Option<i32>,
}

fn report_branches(
    environment: &LintEnvironment<'_>,
    branches: &[Branch<'_>],
    findings: &mut Vec<LintFinding>,
) {
    for (index, branch) in branches.iter().enumerate() {
        let Some(weights) = branches[..=index]
            .iter()
            .map(|branch| branch.weight)
            .collect::<Option<Vec<_>>>()
        else {
            return;
        };
        let chosen = (0..100_i32)
            .filter(|roll| {
                let mut remaining = *roll;
                for (position, weight) in weights.iter().enumerate() {
                    if remaining <= *weight {
                        return position == index;
                    }
                    remaining = remaining.saturating_sub(*weight);
                }
                false
            })
            .count();
        let weight = weights[index];
        let marker = branch.line.tokens[0].range;
        let range = ByteRange {
            start: marker.start,
            end: branch.line.tokens[1].range.end,
        };
        if chosen == 0 && environment.enabled(BRANCH_NEVER_CHOSEN) {
            let message = if weight <= 0 {
                format!(
                    "This branch is never chosen: a chance of {weight} after the first branch never wins the roll"
                )
            } else {
                "This branch is never chosen: the chances before it already cover every roll"
                    .to_owned()
            };
            findings.push(LintFinding {
                related: Vec::new(),
                code: BRANCH_NEVER_CHOSEN,
                severity: LintSeverity::Warning,
                message,
                range,
                unnecessary: false,
                fix: None,
            });
        } else if index == 0 && weight == 0 && environment.enabled(ZERO_CHANCE_FIRST_BRANCH) {
            findings.push(LintFinding {
                related: Vec::new(),
                code: ZERO_CHANCE_FIRST_BRANCH,
                severity: LintSeverity::Information,
                message: "A first branch with chance 0 is still chosen 1 time in 100".to_owned(),
                range,
                unnecessary: false,
                fix: None,
            });
        }
    }
}

fn ignored_operations(
    document: &Document<'_>,
    view: &ProgramView<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let program = view.program;
    let id = document.source.id();
    for ignored in program.native_ignored_operations() {
        let operation = &program.operations[ignored.operation_index];
        if operation.source_id != *id {
            continue;
        }
        let name = operation.name.as_str();
        let message = match ignored.context {
            NativeIgnoredContext::ObjectBlock if name == "add_object" => continue,
            NativeIgnoredContext::ObjectBlock => {
                format!("{name} has no effect inside create_object braces; the game ignores it there")
            }
            NativeIgnoredContext::ObjectCreateInsideBraces => format!(
                "{name} has no effect inside braces; objects are only created outside braces"
            ),
            NativeIgnoredContext::ObjectGroupEntryOutsideBraces => {
                "add_object has no effect outside the braces of create_object_group".to_owned()
            }
            NativeIgnoredContext::TerrainPercentOfLand => {
                "percent_of_land has no effect in <TERRAIN_GENERATION>; land_percent sets the share of the map".to_owned()
            }
            NativeIgnoredContext::ElevationLandId => {
                "land_id has no effect inside create_elevation; base_layer selects where the elevation goes".to_owned()
            }
            NativeIgnoredContext::PlayerLandsPosition => {
                "land_position has no effect inside create_player_lands; only create_land takes a position".to_owned()
            }
            NativeIgnoredContext::CircleRadiusOutsideLandBlock if operation.depth == 0 => {
                "circle_radius has no effect outside the braces of a land".to_owned()
            }
            NativeIgnoredContext::AccumulateConnectionsInsideBraces => {
                "accumulate_connections has no effect inside braces".to_owned()
            }
            NativeIgnoredContext::PlayerSetupCommandOutsidePlayerSetup => {
                format!("{name} only has an effect in <PLAYER_SETUP>")
            }
            NativeIgnoredContext::ObjectBlockWithoutDescriptor
            | NativeIgnoredContext::CircleRadiusOutsideLandBlock => continue,
        };
        let Some(line) = document.line_starting_at(operation.source_range.start) else {
            continue;
        };
        if line.uncertain {
            continue;
        }
        if line
            .tokens
            .iter()
            .any(|token| contains_random_draw(document.text(token)))
        {
            continue;
        }
        let statement_is_line = line
            .tokens
            .last()
            .is_some_and(|last| last.range.end == operation.source_range.end);
        findings.push(LintFinding {
            related: Vec::new(),
            code: NO_EFFECT_HERE,
            severity: LintSeverity::Warning,
            message,
            range: operation.source_range,
            unnecessary: true,
            fix: (statement_is_line && document.line_is_only_statement(line)).then(|| LintFix {
                title: format!("Remove {name}"),
                edits: vec![delete_line(line)],
                preferred: true,
            }),
        });
    }
}

fn undefine_lines(document: &Document<'_>, findings: &mut Vec<LintFinding>) {
    for line in &document.lines {
        let Some(head) = line.tokens.first() else {
            continue;
        };
        if line.uncertain || document.text(head) != "#undefine" {
            continue;
        }
        let name = line
            .tokens
            .get(1)
            .filter(|token| token.kind == TokenKind::Identifier);
        let message = match name {
            Some(name) => format!(
                "#undefine has no effect; the game keeps {} defined",
                document.text(name)
            ),
            None => "#undefine has no effect".to_owned(),
        };
        findings.push(LintFinding {
            related: Vec::new(),
            code: NO_EFFECT_HERE,
            severity: LintSeverity::Warning,
            message,
            range: ByteRange {
                start: head.range.start,
                end: name.map_or(head.range.end, |name| name.range.end),
            },
            unnecessary: true,
            fix: document.line_is_only_statement(line).then(|| LintFix {
                title: "Remove #undefine".to_owned(),
                edits: vec![delete_line(line)],
                preferred: true,
            }),
        });
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LookAlike {
    LineMarker,
    GluedOpener,
    GluedCloser,
}

fn look_alike(word: &[u8]) -> Option<LookAlike> {
    if word == b"//" || word.starts_with(b"//") || word.starts_with(b";") {
        Some(LookAlike::LineMarker)
    } else if word.starts_with(b"/*") && word != b"/*" {
        Some(LookAlike::GluedOpener)
    } else if word.ends_with(b"*/") && word != b"*/" {
        Some(LookAlike::GluedCloser)
    } else {
        None
    }
}

fn comment_look_alikes(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let source = document.source;
    let bytes = source.bytes();
    let tokens = &document.analysis.cst.tokens;
    let mut places = None;
    let mut local = None;
    for token in tokens {
        if token.kind.is_trivia() || token.kind == TokenKind::String {
            continue;
        }
        let word = token.bytes(source);
        let Some(kind) = look_alike(word) else {
            continue;
        };
        let text = String::from_utf8_lossy(word);
        let start = token.range.start.0 as usize;
        let line_end = bytes[start..]
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
            .map_or(bytes.len(), |offset| start + offset);
        let (severity, message, fix) = match kind {
            LookAlike::LineMarker => {
                let marker = if word.starts_with(b"//") { 2 } else { 1 };
                let rest = String::from_utf8_lossy(&bytes[start + marker..line_end]);
                let rest = rest.trim();
                let fix = (!rest
                    .split(|character: char| character.is_ascii_whitespace())
                    .any(|word| word == "/*" || word == "*/"))
                .then(|| LintFix {
                    title: "Make the rest of the line a comment".to_owned(),
                    edits: vec![LintEdit {
                        range: ByteRange {
                            start: token.range.start,
                            end: ByteOffset(line_end as u32),
                        },
                        replacement: if rest.is_empty() {
                            "/* */".to_owned()
                        } else {
                            format!("/* {rest} */")
                        },
                    }],
                    preferred: true,
                });
                let places = places.get_or_insert_with(|| document.word_places());
                let local = local.get_or_insert_with(|| {
                    let mut local = BTreeMap::<String, Vec<Option<String>>>::new();
                    for (name, value) in document_definitions(source, document.analysis) {
                        local.entry(name).or_default().push(value);
                    }
                    local
                });
                let definitions = |name: &str| definitions_of(name, local, environment);
                let (words, marker_index) = line_words(document, token, line_end);
                let place = document.place_of(places, token);
                let action = first_word_action(&words, marker_index + 1, place, &definitions);
                let (severity, message) = match action {
                    Some(WordAction::Command { command, .. }) => (
                        LintSeverity::Warning,
                        format!(
                            "The game does not read {text} as a comment and runs {command} after it on this line."
                        ),
                    ),
                    Some(WordAction::Dispatch { index, command }) => (
                        LintSeverity::Warning,
                        format!(
                            "The game does not read {text} as a comment and runs the defined name {} after it as the command {command}.",
                            words[index]
                        ),
                    ),
                    Some(WordAction::Other { index }) => (
                        LintSeverity::Warning,
                        format!(
                            "The game does not read {text} as a comment and acts on {} after it on this line.",
                            words[index]
                        ),
                    ),
                    None => (
                        LintSeverity::Hint,
                        format!(
                            "The game does not read {text} as a comment. It skips the words after it on this line because none of them is a command or a defined name it acts on here."
                        ),
                    ),
                };
                (severity, message, fix)
            }
            LookAlike::GluedOpener => (
                LintSeverity::Warning,
                format!(
                    "The game does not read {text} as the start of a comment: only /* written apart is one, so the words after it still run."
                ),
                None,
            ),
            LookAlike::GluedCloser => (
                LintSeverity::Warning,
                format!(
                    "The game does not read {text} as the end of a comment: only */ written apart is one."
                ),
                None,
            ),
        };
        findings.push(LintFinding {
            related: Vec::new(),
            code: NOT_A_COMMENT,
            severity,
            message,
            range: token.range,
            unnecessary: false,
            fix,
        });
    }
}

fn line_words<'d>(
    document: &Document<'d>,
    marker: &Token,
    line_end: usize,
) -> (Vec<&'d str>, usize) {
    let source = document.source;
    let start = line_start(source.bytes(), marker.range.start.0 as usize) as u32;
    let tokens = &document.analysis.cst.tokens;
    let first = tokens.partition_point(|token| token.range.start.0 < start);
    let mut words = Vec::new();
    let mut marker_index = 0;
    for token in &tokens[first..] {
        if token.range.start.0 as usize >= line_end {
            break;
        }
        if token.range == marker.range {
            marker_index = words.len();
        }
        let text = std::str::from_utf8(token.bytes(source)).unwrap_or("\u{fffd}");
        match token.kind {
            TokenKind::BlockComment if text.starts_with("/*") => words.push("/*"),
            TokenKind::BlockComment => words.push("*/"),
            kind if kind.is_trivia() => {}
            _ => words.extend(
                text.split(|character: char| {
                    matches!(character, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ')
                })
                .filter(|word| !word.is_empty()),
            ),
        }
    }
    (words, marker_index)
}

fn definitions_of(
    name: &str,
    local: &BTreeMap<String, Vec<Option<String>>>,
    environment: &LintEnvironment<'_>,
) -> WordDefinitions {
    let mut values = Vec::new();
    let mut defined = false;
    for value in local.get(name).into_iter().flatten() {
        defined = true;
        match value {
            Some(value) => values.push(value.clone()),
            None => return WordDefinitions::Unknown,
        }
    }
    match (environment.definitions_elsewhere)(name) {
        WordDefinitions::Unknown => return WordDefinitions::Unknown,
        WordDefinitions::Values(elsewhere) => {
            defined = true;
            values.extend(elsewhere);
        }
        WordDefinitions::Undefined if (environment.defined_elsewhere)(name) => {
            return WordDefinitions::Unknown;
        }
        WordDefinitions::Undefined => {}
    }
    if defined {
        WordDefinitions::Values(values)
    } else {
        WordDefinitions::Undefined
    }
}

pub fn document_definitions(
    source: &SourceText,
    analysis: &DocumentAnalysis,
) -> Vec<(String, Option<String>)> {
    let tokens = &analysis.cst.tokens;
    let mut definitions = Vec::new();
    for node in &analysis.cst.nodes {
        if node.kind != CstKind::Definition {
            continue;
        }
        let mut words = tokens[node.token_start as usize..node.token_end as usize]
            .iter()
            .filter(|token| !token.kind.is_trivia());
        let (Some(head), Some(name)) = (words.next(), words.next()) else {
            continue;
        };
        if name.kind != TokenKind::Identifier {
            continue;
        }
        let value = match head.bytes(source) {
            b"#define" => Some("0".to_owned()),
            b"#const" => match words.collect::<Vec<_>>().as_slice() {
                [] => continue,
                [value] => {
                    let text = String::from_utf8_lossy(value.bytes(source)).into_owned();
                    if known_head(&text) {
                        continue;
                    }
                    let plain_name = text
                        .chars()
                        .next()
                        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                        && !text.contains(['(', ')']);
                    (text.parse::<f32>().is_ok() || plain_name).then_some(text)
                }
                _ => None,
            },
            _ => continue,
        };
        definitions.push((
            String::from_utf8_lossy(name.bytes(source)).into_owned(),
            value,
        ));
    }
    definitions
}

type WordPlaces<'d> = (Vec<Option<&'static str>>, Vec<Option<Block<'d>>>);

impl<'d> Document<'d> {
    fn word_places(&'d self) -> WordPlaces<'d> {
        let mut sections = Vec::with_capacity(self.lines.len());
        let mut section = None;
        let mut control_depth = 0_u32;
        for line in &self.lines {
            sections.push(section);
            for token in &line.tokens {
                match self.text(token) {
                    "if" | "start_random" => control_depth = control_depth.saturating_add(1),
                    "endif" | "end_random" => control_depth = control_depth.saturating_sub(1),
                    text => {
                        if let Some(name) = section_name(text) {
                            section = (control_depth == 0).then_some(name);
                        }
                    }
                }
            }
        }
        (sections, self.blocks())
    }

    fn place_of(&self, places: &WordPlaces<'d>, marker: &Token) -> WordPlace<'d> {
        let offset = marker.range.start;
        let index = self.lines.partition_point(|line| line.full.end <= offset);
        let Some(line) = self
            .lines
            .get(index)
            .filter(|line| line.full.start <= offset && !line.uncertain)
        else {
            return WordPlace::default();
        };
        let mut place = WordPlace {
            section: places.0[index],
            braces: match places.1[index] {
                Some(block) => Braces::Inside(Some(block.opener)),
                None if line.depth == 0 => Braces::Outside,
                None => Braces::Inside(None),
            },
        };
        for token in line
            .tokens
            .iter()
            .filter(|token| token.range.start < offset)
        {
            let word = self.text(token);
            if section_name(word).is_some() {
                place.section = None;
            }
            if matches!(word, "{" | "}") {
                place.braces = Braces::Unknown;
            }
        }
        place
    }
}

fn numbers_for_names(
    document: &Document<'_>,
    view: &ProgramView<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let id = document.source.id();
    for operation in &view.program.operations {
        if operation.source_id != *id {
            continue;
        }
        let Some(number) = operation
            .arguments
            .iter()
            .find(|argument| argument.resolution == ArgumentResolution::UnregisteredNumber)
        else {
            continue;
        };
        let range = operation.source_range;
        let operand = document
            .lines
            .iter()
            .flat_map(|line| line.tokens.iter())
            .filter(|token| token.range.start >= range.start && token.range.end <= range.end)
            .skip(1)
            .find(|token| document.text(token) == number.value);
        let Some(operand) = operand else {
            continue;
        };
        let name = operation.name.as_str();
        let is_number = number.value.parse::<f32>().is_ok() || number.value.starts_with("rnd(");
        findings.push(LintFinding {
            related: Vec::new(),
            code: NUMBER_FOR_A_NAME,
            severity: LintSeverity::Warning,
            message: if is_number {
                format!(
                    "The game ignores this {name}: {} is a number where it reads a name, and it only finds defined names there.",
                    number.value
                )
            } else {
                format!(
                    "The game ignores this {name}: {} is not a defined name where it reads a name, and it only finds defined names there.",
                    number.value
                )
            },
            range: operand.range,
            unnecessary: false,
            fix: None,
        });
    }
}

#[derive(Clone, Copy)]
enum Origin {
    Game,
    Setup,
    Script,
}

fn ignored_redefinitions(
    document: &Document<'_>,
    view: &ProgramView<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let mut first = BTreeMap::<String, (String, Origin, Option<(SourceId, ByteRange)>)>::new();
    for (name, value) in view.game_definitions {
        first.insert(name.clone(), (value.clone(), Origin::Game, None));
    }
    for (name, value) in view.setup_definitions {
        first.insert(name.clone(), (value.clone(), Origin::Setup, None));
    }
    let id = document.source.id();
    for decision in &view.program.decisions {
        if !matches!(
            decision.kind,
            ParsedDecisionKind::Definition | ParsedDecisionKind::Redefinition
        ) {
            continue;
        }
        let Some(text) = (view.source)(&decision.source_id) else {
            continue;
        };
        let start = decision.source_range.start.0 as usize;
        let end = (decision.source_range.end.0 as usize).min(text.bytes().len());
        let Some(statement) = text.bytes().get(start..end) else {
            continue;
        };
        let mut words = statement
            .split(u8::is_ascii_whitespace)
            .filter(|word| !word.is_empty());
        let (Some(head), Some(name)) = (words.next(), words.next()) else {
            continue;
        };
        if head != b"#const" {
            continue;
        }
        let name = String::from_utf8_lossy(name).into_owned();
        let Some(value) = decision.values.first() else {
            continue;
        };
        match decision.kind {
            ParsedDecisionKind::Definition if decision.result => {
                let written = word_range(statement, decision.source_range.start, 1)
                    .map(|range| (decision.source_id.clone(), range));
                first
                    .entry(name)
                    .or_insert_with(|| (value.clone(), Origin::Script, written));
            }
            ParsedDecisionKind::Redefinition if decision.source_id == *id => {
                let Some((existing, origin, written)) = first.get(&name) else {
                    continue;
                };
                let same = match (existing.parse::<f32>(), value.parse::<f32>()) {
                    (Ok(left), Ok(right)) => left == right,
                    _ => existing == value,
                };
                if same {
                    continue;
                }
                let Some(name_token) = document
                    .line_starting_at(decision.source_range.start)
                    .and_then(|line| line.tokens.get(1))
                else {
                    continue;
                };
                let message = match origin {
                    Origin::Game => format!(
                        "{name} is already {existing} in the selected game version, so this value ({value}) is ignored"
                    ),
                    Origin::Setup => format!(
                        "{name} is already {existing} from the run settings, so this value ({value}) is ignored"
                    ),
                    Origin::Script => {
                        format!("{name} is already {existing}, so this value ({value}) is ignored")
                    }
                };
                let related = written
                    .iter()
                    .map(|(source_id, range)| LintRelated {
                        source_id: (source_id != id).then(|| source_id.clone()),
                        range: *range,
                        message: format!("{name} is first defined here"),
                    })
                    .collect();
                findings.push(LintFinding {
                    related,
                    code: IGNORED_REDEFINITION,
                    severity: LintSeverity::Warning,
                    message,
                    range: name_token.range,
                    unnecessary: false,
                    fix: None,
                });
            }
            _ => {}
        }
    }
}

fn word_range(statement: &[u8], start: ByteOffset, index: usize) -> Option<ByteRange> {
    let mut offset = 0;
    let mut found = 0;
    while offset < statement.len() {
        while offset < statement.len() && statement[offset].is_ascii_whitespace() {
            offset += 1;
        }
        let word = offset;
        while offset < statement.len() && !statement[offset].is_ascii_whitespace() {
            offset += 1;
        }
        if word == offset {
            break;
        }
        if found == index {
            return Some(ByteRange {
                start: ByteOffset(start.0 + word as u32),
                end: ByteOffset(start.0 + offset as u32),
            });
        }
        found += 1;
    }
    None
}

struct Suppressions {
    file: Option<BTreeSet<String>>,
    lines: BTreeMap<u32, BTreeSet<String>>,
}

impl Suppressions {
    fn read(document: &Document<'_>) -> Self {
        let mut suppressions = Self {
            file: None,
            lines: BTreeMap::new(),
        };
        let tokens = &document.analysis.cst.tokens;
        for (index, token) in tokens.iter().enumerate() {
            if token.kind != TokenKind::BlockComment {
                continue;
            }
            let text = document.text(token);
            let Some(inner) = text
                .strip_prefix("/*")
                .and_then(|text| text.strip_suffix("*/"))
            else {
                continue;
            };
            let mut words = inner
                .split(|character: char| character.is_ascii_whitespace() || character == ',')
                .filter(|word| !word.is_empty());
            let Some(directive) = words.next() else {
                continue;
            };
            let codes = words
                .take_while(|word| word.starts_with("RMS"))
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            match directive {
                SUPPRESS_FILE => {
                    let file = suppressions.file.get_or_insert_with(BTreeSet::new);
                    if codes.is_empty() {
                        file.insert(String::new());
                    } else {
                        file.extend(codes);
                    }
                }
                SUPPRESS_LINE => {
                    let line_start = document.line_start_of(token.range.start);
                    let alone = tokens[..index]
                        .iter()
                        .rev()
                        .take_while(|token| token.kind != TokenKind::Newline)
                        .all(|token| token.kind.is_trivia())
                        && tokens[index + 1..]
                            .iter()
                            .take_while(|token| token.kind != TokenKind::Newline)
                            .all(|token| token.kind.is_trivia());
                    let target = if alone {
                        let next = document
                            .lines
                            .partition_point(|line| line.full.start <= token.range.end);
                        document.lines.get(next).map(|line| line.full.start.0)
                    } else {
                        Some(line_start)
                    };
                    if let Some(target) = target {
                        let entry = suppressions.lines.entry(target).or_default();
                        if codes.is_empty() {
                            entry.insert(String::new());
                        } else {
                            entry.extend(codes);
                        }
                    }
                }
                _ => {}
            }
        }
        suppressions
    }

    fn silences(&self, document: &Document<'_>, finding: &LintFinding) -> bool {
        let matches = |codes: &BTreeSet<String>| codes.contains("") || codes.contains(finding.code);
        if self.file.as_ref().is_some_and(matches) {
            return true;
        }
        let line_start = document.line_start_of(finding.range.start);
        self.lines.get(&line_start).is_some_and(matches)
    }
}

impl Document<'_> {
    fn line_starting_at(&self, offset: ByteOffset) -> Option<&Line<'_>> {
        let index = self.lines.partition_point(|line| {
            line.tokens
                .first()
                .map_or(line.full.start, |head| head.range.start)
                < offset
        });
        self.lines.get(index).filter(|line| {
            line.tokens
                .first()
                .is_some_and(|head| head.range.start == offset)
        })
    }

    fn line_start_of(&self, offset: ByteOffset) -> u32 {
        line_start(self.source.bytes(), offset.0 as usize) as u32
    }
}
