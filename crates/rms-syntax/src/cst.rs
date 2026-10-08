use rms_source::{ByteOffset, ByteRange, SourceText};

use crate::{LexDiagnostic, LexedDocument, LexerLimits, LexicalProfile, Token, TokenKind, lex};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CstKind {
    Section,
    Command,
    Attribute,
    Include,
    Definition,
    Conditional,
    RandomBranch,
    Brace,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CstNode {
    pub kind: CstKind,
    pub range: ByteRange,
    pub token_start: u32,
    pub token_end: u32,
    pub depth: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CstRegion {
    Token(u32),
    EndOfFile,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CstDocument {
    pub source_id: rms_source::SourceId,
    pub tokens: Vec<Token>,
    pub nodes: Vec<CstNode>,
    pub diagnostics: Vec<LexDiagnostic>,
    pub brace_pairs: Vec<ByteRange>,
}

impl CstDocument {
    pub fn region_at(&self, offset: ByteOffset) -> Option<CstRegion> {
        let length = self.tokens.last().map_or(0, |token| token.range.end.0);
        if offset.0 > length {
            return None;
        }
        if offset.0 == length {
            return Some(CstRegion::EndOfFile);
        }
        self.tokens
            .iter()
            .position(|token| offset >= token.range.start && offset < token.range.end)
            .map(|index| CstRegion::Token(index as u32))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperandKind {
    Word,
    Number,
    Condition,
    OptionalNumber,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandShape<'a> {
    pub operands: &'a [OperandKind],
    pub operands_from_next_line: bool,
}

pub trait StatementGrammar {
    fn command(&self, word: &[u8]) -> Option<CommandShape<'_>>;
}

pub fn parse_tolerant(
    source: &SourceText,
    profile: LexicalProfile,
    limits: LexerLimits,
    grammar: &dyn StatementGrammar,
) -> CstDocument {
    let lexed = lex(source, profile, limits);
    build_cst(source, lexed, grammar)
}

struct Statement {
    tokens: Vec<usize>,
    after_comment: bool,
}

struct Reader<'a> {
    source: &'a SourceText,
    tokens: &'a [Token],
    grammar: &'a dyn StatementGrammar,
}

impl Reader<'_> {
    fn word(&self, index: usize) -> &[u8] {
        self.tokens[index].bytes(self.source)
    }

    fn command(&self, index: usize) -> Option<CommandShape<'_>> {
        self.grammar.command(self.word(index))
    }

    fn is_statement_start(&self, index: usize) -> bool {
        self.command(index).is_some()
    }

    fn numeric_count(&self, words: &[usize]) -> usize {
        let Some(&first) = words.first() else {
            return 0;
        };
        if !self.word(first).starts_with(b"(") {
            return 1;
        }
        words
            .iter()
            .position(|&index| self.word(index).ends_with(b")"))
            .map_or(words.len(), |position| position + 1)
    }

    fn statement_length(&self, words: &[usize]) -> usize {
        let Some(shape) = words.first().and_then(|&first| self.command(first)) else {
            return 1;
        };
        let mut count = 1;
        for operand in shape.operands {
            if count >= words.len() {
                break;
            }
            if self.is_statement_start(words[count]) {
                match operand {
                    OperandKind::Number | OperandKind::Condition => return count,
                    OperandKind::OptionalNumber => break,
                    OperandKind::Word => {}
                }
            }
            count += match operand {
                OperandKind::Number | OperandKind::OptionalNumber => {
                    self.numeric_count(&words[count..])
                }
                OperandKind::Word | OperandKind::Condition => 1,
            };
        }
        count.min(words.len())
    }

    fn waits_for_operand(&self, words: &[usize]) -> bool {
        let Some(shape) = words.first().and_then(|&first| self.command(first)) else {
            return false;
        };
        if !shape.operands_from_next_line {
            return false;
        }
        let mut count = 1;
        for operand in shape.operands {
            if count >= words.len() {
                return matches!(operand, OperandKind::Number | OperandKind::Condition);
            }
            if self.is_statement_start(words[count]) {
                return false;
            }
            count += match operand {
                OperandKind::Number | OperandKind::OptionalNumber => {
                    self.numeric_count(&words[count..])
                }
                OperandKind::Word | OperandKind::Condition => 1,
            };
        }
        false
    }

    fn statements(&self) -> Vec<Statement> {
        let mut statements = Vec::new();
        let mut words = Vec::new();
        let mut comment_before = false;
        for index in 0..=self.tokens.len() {
            match self.tokens.get(index) {
                Some(token) if token.kind != TokenKind::Newline => {
                    if !token.kind.is_trivia() {
                        words.push(index);
                    } else if token.kind == TokenKind::BlockComment && words.is_empty() {
                        comment_before = true;
                    }
                    continue;
                }
                _ => {}
            }
            let mut position = 0;
            while position < words.len() {
                let start = position;
                let length = self.statement_length(&words[position..]).max(1);
                position = (position + length).min(words.len());
                if !self.is_statement_start(words[start]) {
                    while position < words.len() && !self.is_statement_start(words[position]) {
                        position += 1;
                    }
                }
                statements.push(Statement {
                    tokens: words[start..position].to_vec(),
                    after_comment: comment_before && start == 0,
                });
            }
            if !words.is_empty() {
                comment_before = false;
            }
            words.clear();
        }
        self.take_operands_from_following_lines(&mut statements);
        statements
    }

    fn take_operands_from_following_lines(&self, statements: &mut Vec<Statement>) {
        let mut index = 0;
        while index + 1 < statements.len() {
            while self.waits_for_operand(&statements[index].tokens) {
                let following = &statements[index + 1];
                let Some(&next) = following.tokens.first() else {
                    break;
                };
                let word = self.word(next);
                if following.after_comment
                    || self.is_statement_start(next)
                    || word == b"/*"
                    || word == b"*/"
                {
                    break;
                }
                let count = self
                    .numeric_count(&following.tokens)
                    .clamp(1, following.tokens.len());
                let moved = statements[index + 1]
                    .tokens
                    .drain(..count)
                    .collect::<Vec<_>>();
                statements[index].tokens.extend(moved);
                if statements[index + 1].tokens.is_empty() {
                    statements.remove(index + 1);
                }
                if index + 1 >= statements.len() {
                    break;
                }
            }
            index += 1;
        }
    }
}

fn build_cst(
    source: &SourceText,
    lexed: LexedDocument,
    grammar: &dyn StatementGrammar,
) -> CstDocument {
    let statements = Reader {
        source,
        tokens: &lexed.tokens,
        grammar,
    }
    .statements();
    let mut nodes = Vec::with_capacity(statements.len());
    let mut diagnostics = lexed.diagnostics;
    let mut braces = BraceState::default();
    let mut brace_pairs = Vec::new();
    let mut conditional_stack = Vec::<ConditionalFrame>::new();
    let mut conditional_overflow = 0_usize;
    let mut nesting_limit_reported = false;

    for statement in &statements {
        let (Some(&first_index), Some(&last_index)) =
            (statement.tokens.first(), statement.tokens.last())
        else {
            continue;
        };
        let first = &lexed.tokens[first_index];
        let text = first.bytes(source);

        if is_conditional_open(text) {
            if conditional_stack.len() >= MAXIMUM_TRACKED_CONDITIONALS {
                conditional_overflow += 1;
                report_nesting_limit(&mut diagnostics, &mut nesting_limit_reported, first.range);
            } else {
                conditional_stack.push(ConditionalFrame {
                    opener: first.range,
                    entry: braces.clone(),
                    merged: None,
                    has_else: false,
                });
            }
        } else if is_conditional_branch(text) {
            if conditional_overflow == 0
                && let Some(frame) = conditional_stack.last_mut()
            {
                let finished = std::mem::replace(&mut braces, frame.entry.clone());
                frame.merge_branch(finished);
                frame.has_else |= is_conditional_else(text);
            }
        } else if is_conditional_close(text) {
            if conditional_overflow > 0 {
                conditional_overflow -= 1;
            } else {
                match conditional_stack.pop() {
                    Some(mut frame) => {
                        frame.merge_branch(std::mem::take(&mut braces));
                        let merged = frame.merged.take().unwrap_or_default();
                        braces = if frame.has_else {
                            merged
                        } else {
                            BraceState::merge(&merged, &frame.entry)
                        };
                    }
                    None => diagnostics.push(syntax_diagnostic(
                        "RMS1101",
                        "conditional terminator has no matching opener",
                        first.range,
                    )),
                }
            }
        }

        let mut kind = classify(first.kind, text, braces.depth() > 0);
        let depth = braces.depth() as u32;
        if first.kind == TokenKind::LBrace {
            if !braces.open(first.range) {
                report_nesting_limit(&mut diagnostics, &mut nesting_limit_reported, first.range);
            }
        } else if first.kind == TokenKind::RBrace {
            match braces.close() {
                Some(openers) => {
                    brace_pairs.extend(openers.into_iter().map(|opener| ByteRange {
                        start: opener.start,
                        end: first.range.end,
                    }));
                }
                None => {
                    diagnostics.push(syntax_diagnostic(
                        "RMS1102",
                        "closing brace has no matching opener",
                        first.range,
                    ));
                    kind = CstKind::Error;
                }
            }
        }
        nodes.push(CstNode {
            kind,
            range: ByteRange {
                start: first.range.start,
                end: lexed.tokens[last_index].range.end,
            },
            token_start: first_index as u32,
            token_end: last_index as u32 + 1,
            depth,
        });
    }

    let eof = ByteOffset(source.bytes().len() as u32);
    let mut unclosed = braces.levels.into_iter().flatten().collect::<Vec<_>>();
    unclosed.sort_by_key(|opener| (opener.start, opener.end));
    unclosed.dedup();
    for opener in unclosed {
        diagnostics.push(syntax_diagnostic(
            "RMS1103",
            "opening brace is not closed before end of file",
            ByteRange {
                start: opener.start,
                end: eof,
            },
        ));
    }
    for frame in conditional_stack {
        diagnostics.push(syntax_diagnostic(
            "RMS1104",
            "conditional is not closed before end of file",
            ByteRange {
                start: frame.opener.start,
                end: eof,
            },
        ));
    }

    CstDocument {
        source_id: source.id().clone(),
        tokens: lexed.tokens,
        nodes,
        diagnostics,
        brace_pairs,
    }
}

const MAXIMUM_TRACKED_BRACE_DEPTH: usize = 128;
const MAXIMUM_TRACKED_CONDITIONALS: usize = 128;
const MAXIMUM_OPENERS_PER_LEVEL: usize = 16;

fn report_nesting_limit(
    diagnostics: &mut Vec<LexDiagnostic>,
    reported: &mut bool,
    range: ByteRange,
) {
    if !*reported {
        *reported = true;
        diagnostics.push(syntax_diagnostic(
            "RMS1010",
            "braces and if blocks are nested deeper than the editor follows",
            range,
        ));
    }
}

#[derive(Clone, Debug, Default)]
struct BraceState {
    levels: Vec<Vec<ByteRange>>,
    overflow: usize,
}

impl BraceState {
    fn depth(&self) -> usize {
        self.levels.len() + self.overflow
    }

    fn open(&mut self, opener: ByteRange) -> bool {
        if self.levels.len() >= MAXIMUM_TRACKED_BRACE_DEPTH {
            self.overflow += 1;
            return false;
        }
        self.levels.push(vec![opener]);
        true
    }

    fn close(&mut self) -> Option<Vec<ByteRange>> {
        if self.overflow > 0 {
            self.overflow -= 1;
            return Some(Vec::new());
        }
        self.levels.pop()
    }

    fn merge(first: &BraceState, second: &BraceState) -> BraceState {
        let depth = first.levels.len().max(second.levels.len());
        let mut levels = vec![Vec::<ByteRange>::new(); depth];
        for branch in [first, second] {
            for (level, openers) in branch.levels.iter().enumerate() {
                for opener in openers {
                    if levels[level].len() < MAXIMUM_OPENERS_PER_LEVEL
                        && !levels[level].contains(opener)
                    {
                        levels[level].push(*opener);
                    }
                }
            }
        }
        BraceState {
            levels,
            overflow: first.overflow.max(second.overflow),
        }
    }
}

struct ConditionalFrame {
    opener: ByteRange,
    entry: BraceState,
    merged: Option<BraceState>,
    has_else: bool,
}

impl ConditionalFrame {
    fn merge_branch(&mut self, finished: BraceState) {
        self.merged = Some(match self.merged.take() {
            None => finished,
            Some(merged) => BraceState::merge(&merged, &finished),
        });
    }
}

fn classify(kind: TokenKind, text: &[u8], inside_brace: bool) -> CstKind {
    if kind == TokenKind::Section {
        CstKind::Section
    } else if matches!(text, b"#include" | b"#include_drs" | b"#includeXS") {
        CstKind::Include
    } else if matches!(text, b"#define" | b"#const" | b"#undefine") {
        CstKind::Definition
    } else if is_conditional_open(text) || is_conditional_branch(text) || is_conditional_close(text)
    {
        CstKind::Conditional
    } else if matches!(text, b"start_random" | b"percent_chance" | b"end_random") {
        CstKind::RandomBranch
    } else if matches!(kind, TokenKind::LBrace | TokenKind::RBrace) {
        CstKind::Brace
    } else if matches!(kind, TokenKind::Unknown | TokenKind::Error) {
        CstKind::Error
    } else if inside_brace {
        CstKind::Attribute
    } else {
        CstKind::Command
    }
}

fn is_conditional_open(text: &[u8]) -> bool {
    text == b"if"
}

fn is_conditional_close(text: &[u8]) -> bool {
    text == b"endif"
}

fn is_conditional_branch(text: &[u8]) -> bool {
    matches!(text, b"elseif" | b"else")
}

fn is_conditional_else(text: &[u8]) -> bool {
    text == b"else"
}

fn syntax_diagnostic(
    code: &'static str,
    message: impl Into<String>,
    range: ByteRange,
) -> LexDiagnostic {
    LexDiagnostic {
        kind: crate::LexDiagnosticKind::UnknownInput,
        code,
        message: message.into(),
        range,
    }
}
