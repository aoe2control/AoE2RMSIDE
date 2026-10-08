use rms_source::{ByteOffset, ByteRange, SourceText};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TokenKind {
    Bom,
    Whitespace,
    Newline,
    LineComment,
    BlockComment,
    Section,
    Directive,
    Identifier,
    Number,
    String,
    LBrace,
    RBrace,
    LParen,
    RParen,
    Comma,
    Operator,
    Unknown,
    Error,
}

impl TokenKind {
    pub const fn is_trivia(self) -> bool {
        matches!(
            self,
            Self::Bom | Self::Whitespace | Self::Newline | Self::LineComment | Self::BlockComment
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub range: ByteRange,
}

impl Token {
    pub fn bytes<'a>(&self, source: &'a SourceText) -> &'a [u8] {
        &source.bytes()[self.range.start.0 as usize..self.range.end.0 as usize]
    }

    pub fn ascii_lowercase(&self, source: &SourceText) -> String {
        String::from_utf8_lossy(self.bytes(source)).to_ascii_lowercase()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LexicalProfile {
    pub semicolon_line_comments: bool,
    pub slash_line_comments: bool,
    pub block_comments: bool,
    pub quoted_values: bool,
}

impl Default for LexicalProfile {
    fn default() -> Self {
        Self {
            semicolon_line_comments: false,
            slash_line_comments: false,
            block_comments: true,
            quoted_values: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LexerLimits {
    pub maximum_total_bytes: u32,
    pub maximum_token_bytes: u32,
    pub maximum_tokens: u32,
    pub maximum_nesting: u32,
}

impl Default for LexerLimits {
    fn default() -> Self {
        Self {
            maximum_total_bytes: 16 * 1024 * 1024,
            maximum_token_bytes: 1024 * 1024,
            maximum_tokens: 2_000_000,
            maximum_nesting: 4096,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LexDiagnosticKind {
    UnterminatedComment,
    UnterminatedString,
    UnterminatedSection,
    UnknownInput,
    ResourceLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LexDiagnostic {
    pub kind: LexDiagnosticKind,
    pub code: &'static str,
    pub message: String,
    pub range: ByteRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LexedDocument {
    pub tokens: Vec<Token>,
    pub diagnostics: Vec<LexDiagnostic>,
}

impl LexedDocument {
    pub fn reconstruct(&self, source: &SourceText) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(source.bytes().len());
        for token in &self.tokens {
            bytes.extend_from_slice(token.bytes(source));
        }
        bytes
    }

    pub fn covers_source(&self, source: &SourceText) -> bool {
        let mut expected = 0;
        for token in &self.tokens {
            if token.range.start.0 != expected || token.range.end.0 < token.range.start.0 {
                return false;
            }
            expected = token.range.end.0;
        }
        expected as usize == source.bytes().len()
    }
}

pub fn lex(source: &SourceText, profile: LexicalProfile, limits: LexerLimits) -> LexedDocument {
    let bytes = source.bytes();
    let length = bytes.len() as u32;
    if length > limits.maximum_total_bytes {
        return LexedDocument {
            tokens: vec![Token {
                kind: TokenKind::Error,
                range: byte_range(0, length),
            }],
            diagnostics: vec![diagnostic(
                LexDiagnosticKind::ResourceLimit,
                "RMS1001",
                "the script is larger than the editor reads",
                0,
                length,
            )],
        };
    }

    let mut lexer = Lexer {
        bytes,
        profile,
        limits,
        tokens: Vec::new(),
        diagnostics: Vec::new(),
        nesting: 0,
        token_limit_reported: false,
        suppressed_diagnostics: 0,
    };
    lexer.run();
    if lexer.suppressed_diagnostics > 0 {
        let end = lexer.bytes.len() as u32;
        lexer.diagnostics.push(diagnostic(
            LexDiagnosticKind::ResourceLimit,
            "RMS1011",
            format!(
                "{} more problems in this script are not listed",
                lexer.suppressed_diagnostics
            ),
            end,
            end,
        ));
    }
    LexedDocument {
        tokens: lexer.tokens,
        diagnostics: lexer.diagnostics,
    }
}

pub const MAXIMUM_LEXICAL_DIAGNOSTICS: usize = 4_096;

pub fn is_native_whitespace(byte: u8) -> bool {
    matches!(byte, 0x09..=0x0d | b' ')
}

struct Lexer<'a> {
    bytes: &'a [u8],
    profile: LexicalProfile,
    limits: LexerLimits,
    tokens: Vec<Token>,
    diagnostics: Vec<LexDiagnostic>,
    nesting: u32,
    token_limit_reported: bool,
    suppressed_diagnostics: usize,
}

impl Lexer<'_> {
    fn report(&mut self, diagnostic: LexDiagnostic) {
        if self.diagnostics.len() < MAXIMUM_LEXICAL_DIAGNOSTICS || diagnostic.code == "RMS1008" {
            self.diagnostics.push(diagnostic);
        } else {
            self.suppressed_diagnostics += 1;
        }
    }

    fn run(&mut self) {
        let mut index = 0;
        if self.bytes.starts_with(b"\xef\xbb\xbf") {
            self.push(TokenKind::Bom, 0, 3);
            index = 3;
        }
        while index < self.bytes.len() {
            let start = index;
            let byte = self.bytes[index];
            let (kind, end) = match byte {
                b' ' | b'\t' | 0x0b | 0x0c => {
                    index += 1;
                    while self
                        .bytes
                        .get(index)
                        .is_some_and(|byte| matches!(byte, b' ' | b'\t' | 0x0b | 0x0c))
                    {
                        index += 1;
                    }
                    (TokenKind::Whitespace, index)
                }
                b'\r' => {
                    index += 1;
                    if self.bytes.get(index) == Some(&b'\n') {
                        index += 1;
                    }
                    (TokenKind::Newline, index)
                }
                b'\n' => (TokenKind::Newline, index + 1),
                b';' if self.profile.semicolon_line_comments => {
                    (TokenKind::LineComment, self.scan_to_newline(index + 1))
                }
                b'/' if self.profile.slash_line_comments
                    && self.word_end(index) == index + 2
                    && self.bytes.get(index + 1) == Some(&b'/') =>
                {
                    (TokenKind::LineComment, self.scan_to_newline(index + 2))
                }
                b'/' if self.profile.block_comments
                    && self.word_end(index) == index + 2
                    && self.bytes.get(index + 1) == Some(&b'*') =>
                {
                    let (end, terminated) = self.scan_block_comment(index + 2);
                    if !terminated {
                        self.report(diagnostic(
                            LexDiagnosticKind::UnterminatedComment,
                            "RMS1002",
                            "unterminated block comment",
                            start as u32,
                            end as u32,
                        ));
                    }
                    (TokenKind::BlockComment, end)
                }
                b'"' | b'\'' if self.profile.quoted_values => {
                    let quote = byte;
                    index += 1;
                    while index < self.bytes.len()
                        && self.bytes[index] != quote
                        && !matches!(self.bytes[index], b'\r' | b'\n')
                    {
                        index += 1;
                    }
                    let terminated = self.bytes.get(index) == Some(&quote);
                    if terminated {
                        index += 1;
                    } else {
                        self.report(diagnostic(
                            LexDiagnosticKind::UnterminatedString,
                            "RMS1004",
                            "unterminated quoted value",
                            start as u32,
                            index as u32,
                        ));
                    }
                    (TokenKind::String, index)
                }
                _ => {
                    let end = self.word_end(index);
                    let word = &self.bytes[start..end];
                    if self.profile.block_comments && word == b"*/" {
                        (TokenKind::BlockComment, end)
                    } else {
                        (self.classify_word(word, start as u32, end as u32), end)
                    }
                }
            };
            self.push(kind, start as u32, end as u32);
            index = end;
        }
    }

    fn scan_to_newline(&self, mut index: usize) -> usize {
        while index < self.bytes.len() && !matches!(self.bytes[index], b'\r' | b'\n') {
            index += 1;
        }
        index
    }

    fn scan_block_comment(&self, mut index: usize) -> (usize, bool) {
        let mut depth = 1_u32;
        while index < self.bytes.len() {
            while self
                .bytes
                .get(index)
                .copied()
                .is_some_and(is_native_whitespace)
            {
                index += 1;
            }
            if index >= self.bytes.len() {
                break;
            }
            let end = self.word_end(index);
            let token = &self.bytes[index..end];
            if token == b"/*" {
                depth = depth.saturating_add(1);
            }
            if token == b"*/" {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return (end, true);
                }
            }
            index = end;
        }
        (self.bytes.len(), false)
    }

    fn word_end(&self, mut index: usize) -> usize {
        while self
            .bytes
            .get(index)
            .is_some_and(|byte| !is_native_whitespace(*byte))
        {
            index += 1;
        }
        index
    }

    fn classify_word(&mut self, word: &[u8], start: u32, end: u32) -> TokenKind {
        match word {
            b"{" => {
                self.nesting = self.nesting.saturating_add(1);
                if self.nesting > self.limits.maximum_nesting {
                    self.report(diagnostic(
                        LexDiagnosticKind::ResourceLimit,
                        "RMS1005",
                        "brace nesting exceeds the configured limit",
                        start,
                        end,
                    ));
                }
                TokenKind::LBrace
            }
            b"}" => {
                self.nesting = self.nesting.saturating_sub(1);
                TokenKind::RBrace
            }
            b"(" => TokenKind::LParen,
            b")" => TokenKind::RParen,
            b"," => TokenKind::Comma,
            b"=" | b"==" | b"!=" | b"<" | b"<=" | b">" | b">=" | b"+" | b"-" | b"*" | b"/"
            | b"%" | b"&&" | b"||" => TokenKind::Operator,
            _ if is_section(word) => TokenKind::Section,
            _ if word.starts_with(b"<") => {
                self.report(diagnostic(
                    LexDiagnosticKind::UnterminatedSection,
                    "RMS1003",
                    "unterminated or malformed section header",
                    start,
                    end,
                ));
                TokenKind::Unknown
            }
            _ if word.starts_with(b"#")
                && word.len() > 1
                && word[1..].iter().copied().all(is_word_continue) =>
            {
                TokenKind::Directive
            }
            _ if is_number(word) => TokenKind::Number,
            _ if word
                .iter()
                .all(|byte| byte.is_ascii_graphic() || !byte.is_ascii()) =>
            {
                TokenKind::Identifier
            }
            _ => {
                self.report(diagnostic(
                    LexDiagnosticKind::UnknownInput,
                    "RMS1006",
                    "the script contains a control character the preview cannot read",
                    start,
                    end,
                ));
                TokenKind::Unknown
            }
        }
    }

    fn push(&mut self, kind: TokenKind, start: u32, end: u32) {
        let chunk = self.limits.maximum_token_bytes.max(1);
        let mut chunk_start = start;
        if end.saturating_sub(start) > chunk {
            self.report(diagnostic(
                LexDiagnosticKind::ResourceLimit,
                "RMS1007",
                "a word is longer than the editor reads as one word",
                start,
                end,
            ));
        }
        while chunk_start < end {
            let chunk_end = end.min(chunk_start.saturating_add(chunk));
            let bounded_kind = if chunk_start == start {
                kind
            } else {
                TokenKind::Error
            };
            if self.tokens.len() as u32 >= self.limits.maximum_tokens {
                if !self.token_limit_reported {
                    self.token_limit_reported = true;
                    self.report(diagnostic(
                        LexDiagnosticKind::ResourceLimit,
                        "RMS1008",
                        "the script has more words than the editor reads",
                        chunk_start,
                        self.bytes.len() as u32,
                    ));
                }
                if let Some(last) = self.tokens.last_mut() {
                    last.kind = TokenKind::Error;
                    last.range.end = ByteOffset(self.bytes.len() as u32);
                } else {
                    self.tokens.push(Token {
                        kind: TokenKind::Error,
                        range: byte_range(chunk_start, self.bytes.len() as u32),
                    });
                }
                return;
            }
            self.tokens.push(Token {
                kind: bounded_kind,
                range: byte_range(chunk_start, chunk_end),
            });
            chunk_start = chunk_end;
        }
    }
}

fn is_word_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

fn is_section(word: &[u8]) -> bool {
    word.len() >= 3
        && word.starts_with(b"<")
        && word.ends_with(b">")
        && word[1..word.len() - 1]
            .iter()
            .copied()
            .all(is_word_continue)
}

fn is_number(word: &[u8]) -> bool {
    std::str::from_utf8(word)
        .ok()
        .is_some_and(|value| value.parse::<f64>().is_ok())
}

fn byte_range(start: u32, end: u32) -> ByteRange {
    ByteRange {
        start: ByteOffset(start),
        end: ByteOffset(end),
    }
}

fn diagnostic(
    kind: LexDiagnosticKind,
    code: &'static str,
    message: impl Into<String>,
    start: u32,
    end: u32,
) -> LexDiagnostic {
    LexDiagnostic {
        kind,
        code,
        message: message.into(),
        range: byte_range(start, end),
    }
}
