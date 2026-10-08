use rms_source::{ByteOffset, ByteRange, SourceEncoding, SourceText};

use crate::diagnostic::{Severity, XsDiagnostic};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Keyword {
    Int,
    Float,
    Bool,
    String,
    Vector,
    Void,
    Const,
    Static,
    Extern,
    Export,
    Mutable,
    Class,
    Rule,
    Include,
    If,
    Then,
    Else,
    For,
    While,
    Switch,
    Case,
    Default,
    Break,
    Continue,
    Return,
    Goto,
    Label,
    Dbg,
    Breakpoint,
    Active,
    Inactive,
    MinInterval,
    MaxInterval,
    HighFrequency,
    RunImmediately,
    Priority,
    Group,
    InfiniteLoopLimit,
    InfiniteRecursionLimit,
}

impl Keyword {
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|keyword| keyword.as_str().as_bytes().eq_ignore_ascii_case(bytes))
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Int => "int",
            Self::Float => "float",
            Self::Bool => "bool",
            Self::String => "string",
            Self::Vector => "vector",
            Self::Void => "void",
            Self::Const => "const",
            Self::Static => "static",
            Self::Extern => "extern",
            Self::Export => "export",
            Self::Mutable => "mutable",
            Self::Class => "class",
            Self::Rule => "rule",
            Self::Include => "include",
            Self::If => "if",
            Self::Then => "then",
            Self::Else => "else",
            Self::For => "for",
            Self::While => "while",
            Self::Switch => "switch",
            Self::Case => "case",
            Self::Default => "default",
            Self::Break => "break",
            Self::Continue => "continue",
            Self::Return => "return",
            Self::Goto => "goto",
            Self::Label => "label",
            Self::Dbg => "dbg",
            Self::Breakpoint => "breakpoint",
            Self::Active => "active",
            Self::Inactive => "inactive",
            Self::MinInterval => "minInterval",
            Self::MaxInterval => "maxInterval",
            Self::HighFrequency => "highFrequency",
            Self::RunImmediately => "runImmediately",
            Self::Priority => "priority",
            Self::Group => "group",
            Self::InfiniteLoopLimit => "infiniteLoopLimit",
            Self::InfiniteRecursionLimit => "infiniteRecursionLimit",
        }
    }

    pub const ALL: [Self; 39] = [
        Self::Int,
        Self::Float,
        Self::Bool,
        Self::String,
        Self::Vector,
        Self::Void,
        Self::Const,
        Self::Static,
        Self::Extern,
        Self::Export,
        Self::Mutable,
        Self::Class,
        Self::Rule,
        Self::Include,
        Self::If,
        Self::Then,
        Self::Else,
        Self::For,
        Self::While,
        Self::Switch,
        Self::Case,
        Self::Default,
        Self::Break,
        Self::Continue,
        Self::Return,
        Self::Goto,
        Self::Label,
        Self::Dbg,
        Self::Breakpoint,
        Self::Active,
        Self::Inactive,
        Self::MinInterval,
        Self::MaxInterval,
        Self::HighFrequency,
        Self::RunImmediately,
        Self::Priority,
        Self::Group,
        Self::InfiniteLoopLimit,
        Self::InfiniteRecursionLimit,
    ];

    pub const fn is_type(self) -> bool {
        matches!(
            self,
            Self::Int | Self::Float | Self::Bool | Self::String | Self::Vector | Self::Void
        )
    }

    pub const fn is_reserved_rule_word(self) -> bool {
        matches!(self, Self::Priority | Self::Group)
    }

    pub const fn is_control(self) -> bool {
        matches!(
            self,
            Self::If
                | Self::Then
                | Self::Else
                | Self::For
                | Self::While
                | Self::Switch
                | Self::Case
                | Self::Default
                | Self::Break
                | Self::Continue
                | Self::Return
                | Self::Goto
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TokenKind {
    Bom,
    Whitespace,
    Newline,
    LineComment,
    BlockComment,
    Identifier,
    Keyword(Keyword),
    BoolLiteral,
    Integer,
    Float,
    String,
    LParen,
    RParen,
    LBrace,
    RBrace,
    Semicolon,
    Comma,
    Colon,
    Period,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Assign,
    EqEq,
    NotEq,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    AndAnd,
    OrOr,
    Amp,
    Pipe,
    PlusPlus,
    MinusMinus,
    Unknown,
}

impl TokenKind {
    pub const fn is_trivia(self) -> bool {
        matches!(
            self,
            Self::Bom | Self::Whitespace | Self::Newline | Self::LineComment | Self::BlockComment
        )
    }

    pub const fn is_comment(self) -> bool {
        matches!(self, Self::LineComment | Self::BlockComment)
    }

    pub const fn is_operator(self) -> bool {
        matches!(
            self,
            Self::Plus
                | Self::Minus
                | Self::Star
                | Self::Slash
                | Self::Percent
                | Self::Assign
                | Self::EqEq
                | Self::NotEq
                | Self::Less
                | Self::LessEq
                | Self::Greater
                | Self::GreaterEq
                | Self::AndAnd
                | Self::OrOr
                | Self::Amp
                | Self::Pipe
                | Self::PlusPlus
                | Self::MinusMinus
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub range: ByteRange,
}

impl Token {
    pub fn bytes<'a>(&self, source: &'a SourceText) -> &'a [u8] {
        &source.bytes()[self.range.start.0 as usize..self.range.end.0 as usize]
    }

    pub fn text(&self, source: &SourceText) -> String {
        String::from_utf8_lossy(self.bytes(source)).into_owned()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct XsLexerLimits {
    pub maximum_total_bytes: u32,
    pub maximum_tokens: u32,
    pub maximum_diagnostics: u32,
}

impl Default for XsLexerLimits {
    fn default() -> Self {
        Self {
            maximum_total_bytes: 16 * 1024 * 1024,
            maximum_tokens: 2_000_000,
            maximum_diagnostics: 4_096,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LexedXs {
    pub tokens: Vec<Token>,
    pub diagnostics: Vec<XsDiagnostic>,
}

impl LexedXs {
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
            if token.range.start.0 != expected || token.range.end.0 <= token.range.start.0 {
                return false;
            }
            expected = token.range.end.0;
        }
        expected as usize == source.bytes().len()
    }
}

const MAXIMUM_INTEGER_DIGITS: usize = 9;

pub fn lex(source: &SourceText, limits: XsLexerLimits) -> LexedXs {
    let bytes = source.bytes();
    let length = bytes.len() as u32;
    if length > limits.maximum_total_bytes {
        return LexedXs {
            tokens: vec![Token {
                kind: TokenKind::Unknown,
                range: range(0, length),
            }],
            diagnostics: vec![XsDiagnostic::error(
                "XS1000",
                "The script is larger than the editor's XS size limit.",
                range(0, length),
            )],
        };
    }
    let mut lexer = Lexer {
        bytes,
        utf8: source.encoding() != SourceEncoding::Windows1252,
        limits,
        tokens: Vec::new(),
        diagnostics: Vec::new(),
        suppressed: 0,
    };
    lexer.run();
    if lexer.suppressed > 0 {
        lexer.diagnostics.push(XsDiagnostic::new(
            "XS1009",
            Severity::Information,
            format!(
                "{} more problems in this file are not listed.",
                lexer.suppressed
            ),
            range(length, length),
        ));
    }
    LexedXs {
        tokens: lexer.tokens,
        diagnostics: lexer.diagnostics,
    }
}

struct Lexer<'a> {
    bytes: &'a [u8],
    utf8: bool,
    limits: XsLexerLimits,
    tokens: Vec<Token>,
    diagnostics: Vec<XsDiagnostic>,
    suppressed: usize,
}

impl Lexer<'_> {
    fn report(&mut self, diagnostic: XsDiagnostic) {
        if self.diagnostics.len() < self.limits.maximum_diagnostics as usize {
            self.diagnostics.push(diagnostic);
        } else {
            self.suppressed += 1;
        }
    }

    fn run(&mut self) {
        let mut index = 0;
        if self.bytes.starts_with(b"\xef\xbb\xbf") {
            self.push(TokenKind::Bom, 0, 3);
            index = 3;
        }
        while index < self.bytes.len() {
            if self.tokens.len() as u32 >= self.limits.maximum_tokens {
                let end = self.bytes.len() as u32;
                self.diagnostics.push(XsDiagnostic::error(
                    "XS1008",
                    "The script has more tokens than the editor's XS limit; the rest is not analyzed.",
                    range(index as u32, end),
                ));
                self.push(TokenKind::Unknown, index as u32, end);
                return;
            }
            let start = index;
            let (kind, end) = self.scan(index);
            self.push(kind, start as u32, end as u32);
            index = end;
        }
    }

    fn scan(&mut self, start: usize) -> (TokenKind, usize) {
        let bytes = self.bytes;
        let byte = bytes[start];
        let next = bytes.get(start + 1).copied();
        match byte {
            b' ' | b'\t' | 0x0b | 0x0c => {
                let mut index = start + 1;
                while bytes
                    .get(index)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t' | 0x0b | 0x0c))
                {
                    index += 1;
                }
                (TokenKind::Whitespace, index)
            }
            b'\r' => {
                if next == Some(b'\n') {
                    (TokenKind::Newline, start + 2)
                } else {
                    (TokenKind::Newline, start + 1)
                }
            }
            b'\n' => (TokenKind::Newline, start + 1),
            b'/' if next == Some(b'/') => (TokenKind::LineComment, self.line_end(start + 2)),
            b'/' if next == Some(b'*') => {
                let mut index = start + 2;
                while index < bytes.len() {
                    if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                        return (TokenKind::BlockComment, index + 2);
                    }
                    index += 1;
                }
                self.report(XsDiagnostic::error(
                    "XS1004",
                    "This block comment is not closed with */ before the end of the file.",
                    range(start as u32, bytes.len() as u32),
                ));
                (TokenKind::BlockComment, bytes.len())
            }
            b'"' => self.scan_string(start),
            b'0'..=b'9' => self.scan_number(start),
            b'.' if next.is_some_and(|byte| byte.is_ascii_digit()) => self.scan_number(start),
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let mut index = start + 1;
                while bytes
                    .get(index)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    index += 1;
                }
                let word = &bytes[start..index];
                let kind =
                    if word.eq_ignore_ascii_case(b"true") || word.eq_ignore_ascii_case(b"false") {
                        TokenKind::BoolLiteral
                    } else if let Some(keyword) = Keyword::from_bytes(word) {
                        TokenKind::Keyword(keyword)
                    } else {
                        TokenKind::Identifier
                    };
                (kind, index)
            }
            b'(' => (TokenKind::LParen, start + 1),
            b')' => (TokenKind::RParen, start + 1),
            b'{' => (TokenKind::LBrace, start + 1),
            b'}' => (TokenKind::RBrace, start + 1),
            b';' => (TokenKind::Semicolon, start + 1),
            b',' => (TokenKind::Comma, start + 1),
            b':' => (TokenKind::Colon, start + 1),
            b'.' => (TokenKind::Period, start + 1),
            b'+' if next == Some(b'+') => (TokenKind::PlusPlus, start + 2),
            b'+' => (TokenKind::Plus, start + 1),
            b'-' if next == Some(b'-') => (TokenKind::MinusMinus, start + 2),
            b'-' => (TokenKind::Minus, start + 1),
            b'*' => (TokenKind::Star, start + 1),
            b'/' => (TokenKind::Slash, start + 1),
            b'%' => (TokenKind::Percent, start + 1),
            b'=' if next == Some(b'=') => (TokenKind::EqEq, start + 2),
            b'=' => (TokenKind::Assign, start + 1),
            b'!' if next == Some(b'=') => (TokenKind::NotEq, start + 2),
            b'!' => {
                self.report(XsDiagnostic::error(
                    "XS1007",
                    "XS has no '!' operator; only '!=' is valid. Compare with '== false' instead.",
                    range(start as u32, start as u32 + 1),
                ));
                (TokenKind::Unknown, start + 1)
            }
            b'<' if next == Some(b'=') => (TokenKind::LessEq, start + 2),
            b'<' => (TokenKind::Less, start + 1),
            b'>' if next == Some(b'=') => (TokenKind::GreaterEq, start + 2),
            b'>' => (TokenKind::Greater, start + 1),
            b'&' if next == Some(b'&') => (TokenKind::AndAnd, start + 2),
            b'&' => (TokenKind::Amp, start + 1),
            b'|' if next == Some(b'|') => (TokenKind::OrOr, start + 2),
            b'|' => (TokenKind::Pipe, start + 1),
            _ => {
                let end = start + self.character_width(start);
                let shown = String::from_utf8_lossy(&bytes[start..end]).into_owned();
                let message = if byte.is_ascii_graphic() {
                    format!(
                        "The character '{shown}' is not valid in XS outside strings and comments."
                    )
                } else {
                    "This character is not valid in XS outside strings and comments.".to_owned()
                };
                self.report(XsDiagnostic::error(
                    "XS1001",
                    message,
                    range(start as u32, end as u32),
                ));
                (TokenKind::Unknown, end)
            }
        }
    }

    fn scan_string(&mut self, start: usize) -> (TokenKind, usize) {
        let bytes = self.bytes;
        let mut index = start + 1;
        while index < bytes.len() {
            match bytes[index] {
                b'"' => return (TokenKind::String, index + 1),
                b'\\'
                    if bytes
                        .get(index + 1)
                        .is_some_and(|byte| !matches!(byte, b'\r' | b'\n')) =>
                {
                    index += 2;
                }
                b'\r' | b'\n' => {
                    self.report(XsDiagnostic::error(
                        "XS1003",
                        "A string cannot continue onto the next line; close it with \" first.",
                        range(start as u32, index as u32),
                    ));
                    return (TokenKind::String, index);
                }
                _ => index += 1,
            }
        }
        let end = bytes.len().min(index);
        self.report(XsDiagnostic::error(
            "XS1002",
            "This string is not closed with \" before the end of the file.",
            range(start as u32, end as u32),
        ));
        (TokenKind::String, end)
    }

    fn scan_number(&mut self, start: usize) -> (TokenKind, usize) {
        let bytes = self.bytes;
        let mut index = start;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        let integer_digits = index - start;
        let mut is_float = false;
        if bytes.get(index) == Some(&b'.') {
            is_float = true;
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
        }
        if matches!(bytes.get(index), Some(b'e' | b'E')) {
            let mut exponent = index + 1;
            if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
                exponent += 1;
            }
            if bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
                is_float = true;
                index = exponent;
                while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                    index += 1;
                }
            } else if is_float {
                self.report(XsDiagnostic::error(
                    "XS1006",
                    "This number has an exponent marker but no exponent digits.",
                    range(start as u32, exponent as u32),
                ));
                index = exponent;
            }
        }
        if !is_float && integer_digits > MAXIMUM_INTEGER_DIGITS {
            self.report(XsDiagnostic::error(
                "XS1005",
                "Integer constants may have at most 9 digits in XS.",
                range(start as u32, index as u32),
            ));
        }
        (
            if is_float {
                TokenKind::Float
            } else {
                TokenKind::Integer
            },
            index,
        )
    }

    fn line_end(&self, mut index: usize) -> usize {
        while index < self.bytes.len() && !matches!(self.bytes[index], b'\r' | b'\n') {
            index += 1;
        }
        index
    }

    fn character_width(&self, index: usize) -> usize {
        if !self.utf8 {
            return 1;
        }
        let width = match self.bytes[index] {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        width.min(self.bytes.len() - index)
    }

    fn push(&mut self, kind: TokenKind, start: u32, end: u32) {
        self.tokens.push(Token {
            kind,
            range: range(start, end),
        });
    }
}

pub(crate) fn range(start: u32, end: u32) -> ByteRange {
    ByteRange {
        start: ByteOffset(start),
        end: ByteOffset(end),
    }
}
