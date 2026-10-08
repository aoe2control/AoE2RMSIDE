use rms_source::{ByteOffset, ByteRange, SourceText};

use crate::ast::*;
use crate::diagnostic::{Severity, XsDiagnostic};
use crate::lexer::{Keyword, Token, TokenKind, XsLexerLimits, lex, range};

pub const MAXIMUM_SYNTAX_NESTING: u32 = 200;
const MAXIMUM_TRACKED_BRACES: usize = 4_096;
const MAXIMUM_PARSE_DIAGNOSTICS: usize = 4_096;
pub const VOID_PARAMETER_LIST: &str =
    "XS has no '(void)' parameter list: write '()' for a function without parameters.";
const LINE_FEED: u8 = 0x0a;
const CARRIAGE_RETURN: u8 = 0x0d;

pub fn parse(source: &SourceText, limits: XsLexerLimits) -> SyntaxTree {
    let lexed = lex(source, limits);
    let significant = lexed
        .tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| !token.kind.is_trivia() && token.kind != TokenKind::Unknown)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut parser = Parser {
        source,
        tokens: &lexed.tokens,
        significant,
        position: 0,
        depth: 0,
        diagnostics: Vec::new(),
        suppressed: 0,
        last_error_position: usize::MAX,
        nesting_reported: false,
        reserved_callee_at: None,
    };
    let items = parser.parse_items();
    let mut diagnostics = lexed.diagnostics;
    diagnostics.append(&mut parser.diagnostics);
    if parser.suppressed > 0 {
        let end = source.bytes().len() as u32;
        diagnostics.push(XsDiagnostic::new(
            "XS2091",
            Severity::Information,
            format!(
                "{} more syntax diagnostics were omitted.",
                parser.suppressed
            ),
            range(end, end),
        ));
    }
    let brace_pairs = brace_pairs(&lexed.tokens);
    SyntaxTree {
        tokens: lexed.tokens,
        items,
        diagnostics,
        brace_pairs,
    }
}

fn brace_pairs(tokens: &[Token]) -> Vec<ByteRange> {
    let mut stack = Vec::new();
    let mut overflow = 0_usize;
    let mut pairs = Vec::new();
    for token in tokens {
        match token.kind {
            TokenKind::LBrace => {
                if stack.len() < MAXIMUM_TRACKED_BRACES {
                    stack.push(token.range.start);
                } else {
                    overflow += 1;
                }
            }
            TokenKind::RBrace => {
                if overflow > 0 {
                    overflow -= 1;
                } else if let Some(start) = stack.pop() {
                    pairs.push(ByteRange {
                        start,
                        end: token.range.end,
                    });
                }
            }
            _ => {}
        }
    }
    pairs
}

struct Parser<'a> {
    source: &'a SourceText,
    tokens: &'a [Token],
    significant: Vec<usize>,
    position: usize,
    depth: u32,
    diagnostics: Vec<XsDiagnostic>,
    suppressed: usize,
    last_error_position: usize,
    nesting_reported: bool,
    reserved_callee_at: Option<usize>,
}

impl Parser<'_> {
    fn peek_token(&self, offset: usize) -> Option<&Token> {
        self.significant
            .get(self.position + offset)
            .map(|index| &self.tokens[*index])
    }

    fn peek(&self) -> Option<TokenKind> {
        self.peek_token(0).map(|token| token.kind)
    }

    fn peek_at(&self, offset: usize) -> Option<TokenKind> {
        self.peek_token(offset).map(|token| token.kind)
    }

    fn parameter_comma_ahead(&self) -> Option<usize> {
        let mut depth = 0_usize;
        let mut offset = 0;
        loop {
            match self.peek_at(offset)? {
                TokenKind::Comma if depth == 0 => return Some(offset),
                TokenKind::LParen => depth += 1,
                TokenKind::RParen if depth == 0 => return None,
                TokenKind::RParen => depth -= 1,
                TokenKind::LBrace | TokenKind::RBrace | TokenKind::Semicolon => return None,
                _ => {}
            }
            offset += 1;
        }
    }

    fn at(&self, kind: TokenKind) -> bool {
        self.peek() == Some(kind)
    }

    fn at_keyword(&self, keyword: Keyword) -> bool {
        self.peek() == Some(TokenKind::Keyword(keyword))
    }

    fn at_end(&self) -> bool {
        self.position >= self.significant.len()
    }

    fn bump(&mut self) -> Option<Token> {
        let token = self.peek_token(0).copied();
        if token.is_some() {
            self.position += 1;
        }
        token
    }

    fn eat(&mut self, kind: TokenKind) -> Option<Token> {
        if self.at(kind) { self.bump() } else { None }
    }

    fn current_start(&self) -> ByteOffset {
        self.peek_token(0)
            .map_or_else(|| self.previous_end(), |token| token.range.start)
    }

    fn previous_end(&self) -> ByteOffset {
        if self.position == 0 {
            return ByteOffset(0);
        }
        self.significant
            .get(self.position - 1)
            .map_or(ByteOffset(self.source.bytes().len() as u32), |index| {
                self.tokens[*index].range.end
            })
    }

    fn span_from(&self, start: ByteOffset) -> ByteRange {
        let end = self.previous_end().max(start);
        ByteRange { start, end }
    }

    fn text(&self, token: &Token) -> String {
        token.text(self.source)
    }

    fn describe_current(&self) -> String {
        match self.peek_token(0) {
            Some(token) => {
                let text = self.text(token);
                if text.chars().count() > 32 {
                    format!("'{}...'", text.chars().take(32).collect::<String>())
                } else {
                    format!("'{text}'")
                }
            }
            None => "the end of the file".to_owned(),
        }
    }

    fn error_at(&mut self, code: &'static str, message: String, range: ByteRange) {
        if self.last_error_position == self.position {
            return;
        }
        self.last_error_position = self.position;
        if self.diagnostics.len() < MAXIMUM_PARSE_DIAGNOSTICS {
            self.diagnostics
                .push(XsDiagnostic::error(code, message, range));
        } else {
            self.suppressed += 1;
        }
    }

    fn error_here(&mut self, code: &'static str, message: String) {
        let range = match self.peek_token(0) {
            Some(token) => token.range,
            None => {
                let end = self.previous_end();
                ByteRange { start: end, end }
            }
        };
        self.error_at(code, message, range);
    }

    fn expect(&mut self, kind: TokenKind, what: &str) -> Option<Token> {
        if let Some(token) = self.eat(kind) {
            return Some(token);
        }
        let found = self.describe_current();
        self.error_here("XS2001", format!("Expected {what}, found {found}."));
        None
    }

    fn expect_name(&mut self, what: &str) -> Option<Name> {
        if let Some(token) = self.eat(TokenKind::Identifier) {
            return Some(Name {
                text: self.text(&token),
                range: token.range,
            });
        }
        let found = self.describe_current();
        let hint = if matches!(self.peek(), Some(TokenKind::Keyword(_))) {
            " Reserved XS words cannot be used as names."
        } else {
            ""
        };
        self.error_here("XS2001", format!("Expected {what}, found {found}.{hint}"));
        None
    }

    fn expect_declared_name(&mut self, what: &str) -> Option<Name> {
        if let Some(token) = self.peek_token(0).copied()
            && matches!(token.kind, TokenKind::Keyword(keyword) if keyword.is_reserved_rule_word())
        {
            self.bump();
            return Some(Name {
                text: self.text(&token),
                range: token.range,
            });
        }
        self.expect_name(what)
    }

    fn at_reserved_rule_word(&self, offset: usize) -> bool {
        matches!(
            self.peek_at(offset),
            Some(TokenKind::Keyword(keyword)) if keyword.is_reserved_rule_word()
        )
    }

    fn enter(&mut self) -> bool {
        if self.depth >= MAXIMUM_SYNTAX_NESTING {
            if !self.nesting_reported {
                self.nesting_reported = true;
                let range = self.peek_token(0).map_or_else(
                    || {
                        let end = self.previous_end();
                        ByteRange { start: end, end }
                    },
                    |token| token.range,
                );
                self.diagnostics.push(XsDiagnostic::error(
                    "XS2090",
                    "The code is nested more deeply than the editor analyzes; inner parts are skipped.",
                    range,
                ));
            }
            return false;
        }
        self.depth += 1;
        true
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn recover_statement(&mut self) {
        let mut parens = 0_u32;
        let mut braces = 0_u32;
        while let Some(kind) = self.peek() {
            match kind {
                TokenKind::Semicolon if parens == 0 && braces == 0 => {
                    self.bump();
                    return;
                }
                TokenKind::LParen => parens += 1,
                TokenKind::RParen => parens = parens.saturating_sub(1),
                TokenKind::LBrace => braces += 1,
                TokenKind::RBrace => {
                    if braces == 0 {
                        return;
                    }
                    braces -= 1;
                    if braces == 0 && parens == 0 {
                        self.bump();
                        return;
                    }
                }
                _ => {}
            }
            self.bump();
        }
    }

    fn at_item_start(&self) -> bool {
        match self.peek() {
            Some(TokenKind::Keyword(keyword)) => matches!(
                keyword,
                Keyword::Int
                    | Keyword::Float
                    | Keyword::Bool
                    | Keyword::String
                    | Keyword::Vector
                    | Keyword::Void
                    | Keyword::Const
                    | Keyword::Static
                    | Keyword::Extern
                    | Keyword::Export
                    | Keyword::Mutable
                    | Keyword::Class
                    | Keyword::Rule
                    | Keyword::Include
            ),
            _ => false,
        }
    }

    fn recover_item(&mut self) -> ByteRange {
        let start = self.current_start();
        let mut parens = 0_u32;
        let mut braces = 0_u32;
        let mut first = true;
        while let Some(kind) = self.peek() {
            if !first && parens == 0 && braces == 0 && self.at_item_start() {
                break;
            }
            first = false;
            match kind {
                TokenKind::Semicolon if parens == 0 && braces == 0 => {
                    self.bump();
                    break;
                }
                TokenKind::LParen => parens += 1,
                TokenKind::RParen => parens = parens.saturating_sub(1),
                TokenKind::LBrace => braces += 1,
                TokenKind::RBrace => {
                    braces = braces.saturating_sub(1);
                    if braces == 0 && parens == 0 {
                        self.bump();
                        break;
                    }
                }
                _ => {}
            }
            self.bump();
        }
        self.span_from(start)
    }

    fn parse_items(&mut self) -> Vec<Item> {
        let mut items = Vec::new();
        while !self.at_end() {
            let before = self.position;
            let item = self.parse_item();
            items.push(item);
            if self.position == before {
                self.bump();
            }
        }
        items
    }

    fn parse_item(&mut self) -> Item {
        let start = self.current_start();
        match self.peek() {
            Some(TokenKind::Keyword(Keyword::Include)) => Item::Include(self.parse_include()),
            Some(TokenKind::Keyword(Keyword::Rule)) => Item::Rule(self.parse_rule()),
            Some(TokenKind::Keyword(Keyword::Class)) => Item::Class(self.parse_class()),
            Some(TokenKind::Keyword(
                keyword @ (Keyword::InfiniteLoopLimit | Keyword::InfiniteRecursionLimit),
            )) => {
                self.bump();
                let value = self.parse_pragma_value();
                Item::Pragma {
                    kind: pragma_kind(keyword),
                    value,
                    range: self.span_from(start),
                }
            }
            Some(TokenKind::RBrace) => {
                self.error_here(
                    "XS2006",
                    "This closing brace has no matching opening brace.".to_owned(),
                );
                self.bump();
                Item::Error(self.span_from(start))
            }
            _ if self.at_declaration_start() => self.parse_declaration_item(start),
            _ => {
                let found = self.describe_current();
                self.error_here(
                    "XS2003",
                    format!(
                        "Expected a declaration (variable, function, rule, class, or include) at file scope, found {found}."
                    ),
                );
                Item::Error(self.recover_item())
            }
        }
    }

    fn at_declaration_start(&self) -> bool {
        match self.peek() {
            Some(TokenKind::Keyword(keyword)) => {
                keyword.is_type()
                    || matches!(
                        keyword,
                        Keyword::Const
                            | Keyword::Static
                            | Keyword::Extern
                            | Keyword::Export
                            | Keyword::Mutable
                    )
            }
            Some(TokenKind::Identifier) => {
                self.peek_at(1) == Some(TokenKind::Identifier) || self.at_reserved_rule_word(1)
            }
            _ => false,
        }
    }

    fn parse_modifiers(&mut self) -> Modifiers {
        let mut modifiers = Modifiers::default();
        while let Some(token) = self.peek_token(0).copied() {
            let slot = match token.kind {
                TokenKind::Keyword(Keyword::Extern) => &mut modifiers.extern_,
                TokenKind::Keyword(Keyword::Export) => &mut modifiers.export,
                TokenKind::Keyword(Keyword::Static) => &mut modifiers.static_,
                TokenKind::Keyword(Keyword::Const) => &mut modifiers.const_,
                TokenKind::Keyword(Keyword::Mutable) => &mut modifiers.mutable,
                _ => break,
            };
            if slot.is_none() {
                *slot = Some(token.range);
            }
            self.bump();
        }
        modifiers
    }

    fn parse_type(&mut self) -> Option<TypeRef> {
        let token = self.peek_token(0).copied()?;
        let builtin = match token.kind {
            TokenKind::Keyword(Keyword::Int) => TypeName::Int,
            TokenKind::Keyword(Keyword::Float) => TypeName::Float,
            TokenKind::Keyword(Keyword::Bool) => TypeName::Bool,
            TokenKind::Keyword(Keyword::String) => TypeName::String,
            TokenKind::Keyword(Keyword::Vector) => TypeName::Vector,
            TokenKind::Keyword(Keyword::Void) => TypeName::Void,
            TokenKind::Identifier => {
                self.bump();
                return Some(TypeRef::Class(Name {
                    text: self.text(&token),
                    range: token.range,
                }));
            }
            _ => {
                let found = self.describe_current();
                self.error_here("XS2001", format!("Expected a type, found {found}."));
                return None;
            }
        };
        self.bump();
        Some(TypeRef::Builtin(builtin, token.range))
    }

    fn parse_declaration_item(&mut self, start: ByteOffset) -> Item {
        let modifiers = self.parse_modifiers();
        let Some(ty) = self.parse_type() else {
            return Item::Error(self.recover_item());
        };
        let Some(name) = self.expect_declared_name("a name") else {
            return Item::Error(self.recover_item());
        };
        if self.at(TokenKind::LParen) {
            return Item::Function(self.parse_function_rest(start, modifiers, ty, name));
        }
        Item::Variable(self.parse_variable_rest(start, modifiers, ty, name))
    }

    fn parse_variable_rest(
        &mut self,
        start: ByteOffset,
        modifiers: Modifiers,
        ty: TypeRef,
        name: Name,
    ) -> VarDecl {
        let init = if self.eat(TokenKind::Assign).is_some() {
            Some(self.parse_expression())
        } else {
            None
        };
        self.finish_semicolon();
        VarDecl {
            modifiers,
            ty,
            name,
            init,
            range: self.span_from(start),
        }
    }

    fn parse_function_rest(
        &mut self,
        start: ByteOffset,
        modifiers: Modifiers,
        return_type: TypeRef,
        name: Name,
    ) -> FunctionDecl {
        let params_start = self.current_start();
        self.bump();
        let mut params = Vec::new();
        if let Some(token) = self.peek_token(0).copied()
            && token.kind == TokenKind::Keyword(Keyword::Void)
            && self.peek_at(1) == Some(TokenKind::RParen)
        {
            self.error_at("XS2001", VOID_PARAMETER_LIST.to_owned(), token.range);
            self.bump();
        } else if !self.at(TokenKind::RParen) {
            loop {
                let param_start = self.current_start();
                if matches!(
                    self.peek(),
                    Some(TokenKind::Keyword(_) | TokenKind::Identifier)
                ) {
                    let modifiers = self.parse_modifiers();
                    if let Some(range) = modifiers
                        .extern_
                        .or(modifiers.export)
                        .or(modifiers.static_)
                        .or(modifiers.mutable)
                    {
                        self.error_at(
                            "XS2011",
                            "Parameters cannot be declared extern, export, static, or mutable."
                                .to_owned(),
                            range,
                        );
                    }
                    let Some(ty) = self.parse_type() else { break };
                    let Some(param_name) = self.expect_declared_name("a parameter name") else {
                        break;
                    };
                    let default = if self.eat(TokenKind::Assign).is_some() {
                        Some(self.parse_expression())
                    } else {
                        self.error_at(
                            "XS2004",
                            format!(
                                "Parameter '{}' needs a default value, for example '{} {} = {}'.",
                                param_name.text,
                                type_label(&ty),
                                param_name.text,
                                default_example(&ty)
                            ),
                            param_name.range,
                        );
                        None
                    };
                    params.push(Param {
                        ty,
                        name: param_name,
                        default,
                        range: self.span_from(param_start),
                    });
                } else {
                    let found = self.describe_current();
                    self.error_here("XS2001", format!("Expected a parameter, found {found}."));
                    break;
                }
                if self.eat(TokenKind::Comma).is_some() {
                    if self.at(TokenKind::RParen) {
                        break;
                    }
                    continue;
                }
                let Some(comma) = self.parameter_comma_ahead() else {
                    break;
                };
                let found = self.describe_current();
                self.error_here("XS2001", format!("Expected ')', found {found}."));
                self.position += comma + 1;
            }
        }
        if self.expect(TokenKind::RParen, "')'").is_none() {
            while let Some(kind) = self.peek() {
                if matches!(kind, TokenKind::LBrace | TokenKind::Semicolon) {
                    break;
                }
                if kind == TokenKind::RParen {
                    self.bump();
                    break;
                }
                self.bump();
            }
        }
        let params_range = self.span_from(params_start);
        let body = if self.at(TokenKind::LBrace) {
            Some(self.parse_block())
        } else {
            let found = self.describe_current();
            self.error_here(
                "XS2001",
                format!("Expected '{{' to start the function body, found {found}."),
            );
            self.recover_statement();
            None
        };
        FunctionDecl {
            modifiers,
            return_type,
            name,
            params,
            params_range,
            body,
            range: self.span_from(start),
        }
    }

    fn parse_include(&mut self) -> Include {
        let start = self.current_start();
        self.bump();
        let (path, path_range) = match self.peek_token(0).copied() {
            Some(token) if token.kind == TokenKind::String => {
                self.bump();
                (Some(unquote(&self.text(&token))), Some(token.range))
            }
            _ => {
                let found = self.describe_current();
                self.error_here(
                    "XS2001",
                    format!("Expected a quoted file name after 'include', found {found}."),
                );
                (None, None)
            }
        };
        self.finish_semicolon();
        Include {
            path,
            path_range,
            range: self.span_from(start),
        }
    }

    fn parse_rule(&mut self) -> RuleDecl {
        let start = self.current_start();
        self.bump();
        let name = self.expect_declared_name("a rule name").unwrap_or(Name {
            text: String::new(),
            range: ByteRange {
                start: self.previous_end(),
                end: self.previous_end(),
            },
        });
        let mut modifiers = Vec::new();
        while let Some(token) = self.peek_token(0).copied() {
            let modifier_start = token.range.start;
            let kind = match token.kind {
                TokenKind::LBrace => break,
                TokenKind::Keyword(Keyword::Active) => RuleModifierKind::Active,
                TokenKind::Keyword(Keyword::Inactive) => RuleModifierKind::Inactive,
                TokenKind::Keyword(Keyword::HighFrequency) => RuleModifierKind::HighFrequency,
                TokenKind::Keyword(Keyword::RunImmediately) => RuleModifierKind::RunImmediately,
                TokenKind::Keyword(Keyword::MinInterval) => RuleModifierKind::MinInterval,
                TokenKind::Keyword(Keyword::MaxInterval) => RuleModifierKind::MaxInterval,
                TokenKind::Keyword(Keyword::Priority) => RuleModifierKind::Priority,
                TokenKind::Keyword(Keyword::Group) => RuleModifierKind::Group,
                _ => {
                    let found = self.describe_current();
                    self.error_here(
                        "XS2009",
                        format!(
                            "Expected a rule setting (active, inactive, group, priority, minInterval, maxInterval, highFrequency, runImmediately) or '{{', found {found}."
                        ),
                    );
                    break;
                }
            };
            self.bump();
            let (name, value) = match kind {
                RuleModifierKind::Group => (self.expect_name("a group name"), None),
                RuleModifierKind::Priority
                | RuleModifierKind::MinInterval
                | RuleModifierKind::MaxInterval => (None, Some(self.parse_unary())),
                _ => (None, None),
            };
            modifiers.push(RuleModifier {
                kind,
                name,
                value,
                range: self.span_from(modifier_start),
            });
        }
        let body = if self.at(TokenKind::LBrace) {
            Some(self.parse_block())
        } else {
            let found = self.describe_current();
            self.error_here(
                "XS2001",
                format!("Expected '{{' to start the rule body, found {found}."),
            );
            self.recover_item();
            None
        };
        RuleDecl {
            name,
            modifiers,
            body,
            range: self.span_from(start),
        }
    }

    fn parse_class(&mut self) -> ClassDecl {
        let start = self.current_start();
        self.bump();
        let name = self.expect_name("a class name").unwrap_or(Name {
            text: String::new(),
            range: ByteRange {
                start: self.previous_end(),
                end: self.previous_end(),
            },
        });
        let mut members = Vec::new();
        if self.expect(TokenKind::LBrace, "'{'").is_some() {
            while !self.at_end() && !self.at(TokenKind::RBrace) {
                let member_start = self.current_start();
                let before = self.position;
                let modifiers = self.parse_modifiers();
                let member = self.parse_type().and_then(|ty| {
                    let name = self.expect_name("a member name")?;
                    Some(self.parse_variable_rest(member_start, modifiers, ty, name))
                });
                match member {
                    Some(member) => members.push(member),
                    None => self.recover_statement(),
                }
                if self.position == before {
                    self.bump();
                }
            }
            self.expect(TokenKind::RBrace, "'}' to close the class");
            self.eat(TokenKind::Semicolon);
        } else {
            self.recover_item();
        }
        ClassDecl {
            name,
            members,
            range: self.span_from(start),
        }
    }

    fn parse_pragma_value(&mut self) -> Option<Expr> {
        self.eat(TokenKind::Assign);
        let value = if self.at(TokenKind::Semicolon) {
            None
        } else {
            Some(self.parse_unary())
        };
        self.finish_semicolon();
        value
    }

    fn parse_block(&mut self) -> Block {
        let start = self.current_start();
        self.bump();
        let mut stmts = Vec::new();
        if !self.enter() {
            self.skip_balanced_block();
            return Block {
                stmts,
                range: self.span_from(start),
                closed: true,
            };
        }
        while !self.at_end() && !self.at(TokenKind::RBrace) {
            let before = self.position;
            stmts.push(self.parse_statement());
            if self.position == before {
                self.bump();
            }
        }
        self.leave();
        let closed = self.eat(TokenKind::RBrace).is_some();
        if !closed {
            self.diagnostics.push(XsDiagnostic::error(
                "XS2007",
                "This block is not closed with '}' before the end of the file.",
                ByteRange {
                    start,
                    end: ByteOffset(start.0 + 1),
                },
            ));
        }
        Block {
            stmts,
            range: self.span_from(start),
            closed,
        }
    }

    fn skip_balanced_block(&mut self) {
        let mut depth = 1_u32;
        while let Some(kind) = self.bump().map(|token| token.kind) {
            match kind {
                TokenKind::LBrace => depth += 1,
                TokenKind::RBrace => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    fn parse_statement(&mut self) -> Stmt {
        let start = self.current_start();
        if !self.enter() {
            self.recover_statement();
            return Stmt {
                kind: StmtKind::Error,
                range: self.span_from(start),
            };
        }
        let kind = self.parse_statement_kind(start);
        self.leave();
        Stmt {
            kind,
            range: self.span_from(start),
        }
    }

    fn boxed_statement(&mut self, context: &str) -> Option<Box<Stmt>> {
        if self.at_end() || self.at(TokenKind::RBrace) {
            let found = self.describe_current();
            self.error_here(
                "XS2001",
                format!("Expected a statement {context}, found {found}."),
            );
            return None;
        }
        Some(Box::new(self.parse_statement()))
    }

    fn parenthesized_condition(&mut self, keyword: &str) -> Option<Expr> {
        self.expect(TokenKind::LParen, &format!("'(' after '{keyword}'"))?;
        let condition = self.parse_expression();
        if self.expect(TokenKind::RParen, "')'").is_none() {
            let mut depth = 0_u32;
            while let Some(kind) = self.peek() {
                match kind {
                    TokenKind::LParen => depth += 1,
                    TokenKind::RParen if depth == 0 => {
                        self.bump();
                        break;
                    }
                    TokenKind::RParen => depth -= 1,
                    TokenKind::LBrace | TokenKind::Semicolon | TokenKind::RBrace => break,
                    _ => {}
                }
                self.bump();
            }
        }
        Some(condition)
    }

    fn parse_statement_kind(&mut self, start: ByteOffset) -> StmtKind {
        let _ = start;
        let Some(token) = self.peek_token(0).copied() else {
            return StmtKind::Error;
        };
        match token.kind {
            TokenKind::LBrace => StmtKind::Block(self.parse_block()),
            TokenKind::Semicolon => {
                self.bump();
                StmtKind::Empty
            }
            TokenKind::Keyword(Keyword::If) => {
                self.bump();
                let condition = self.parenthesized_condition("if");
                let then_branch = self.boxed_statement("after the if condition");
                let else_branch = if self.eat(TokenKind::Keyword(Keyword::Else)).is_some() {
                    self.boxed_statement("after 'else'")
                } else {
                    None
                };
                StmtKind::If {
                    condition,
                    then_branch,
                    else_branch,
                }
            }
            TokenKind::Keyword(Keyword::While) => {
                self.bump();
                let condition = self.parenthesized_condition("while");
                let body = self.boxed_statement("as the loop body");
                StmtKind::While { condition, body }
            }
            TokenKind::Keyword(Keyword::For) => self.parse_for(),
            TokenKind::Keyword(Keyword::Switch) => self.parse_switch(),
            TokenKind::Keyword(Keyword::Break) => {
                self.bump();
                self.finish_simple_statement();
                StmtKind::Break
            }
            TokenKind::Keyword(Keyword::Continue) => {
                self.bump();
                self.finish_simple_statement();
                StmtKind::Continue
            }
            TokenKind::Keyword(Keyword::Breakpoint) => {
                self.bump();
                self.finish_simple_statement();
                StmtKind::Breakpoint
            }
            TokenKind::Keyword(Keyword::Return) => {
                self.bump();
                let value = if self.at(TokenKind::Semicolon) {
                    None
                } else {
                    Some(self.parse_expression())
                };
                self.finish_simple_statement();
                StmtKind::Return(value)
            }
            TokenKind::Keyword(keyword @ (Keyword::Goto | Keyword::Label | Keyword::Dbg)) => {
                self.bump();
                let name = self.expect_name(match keyword {
                    Keyword::Dbg => "a variable name",
                    _ => "a label name",
                });
                self.finish_simple_statement();
                match keyword {
                    Keyword::Goto => StmtKind::Goto(name),
                    Keyword::Label => StmtKind::Label(name),
                    _ => StmtKind::Dbg(name),
                }
            }
            TokenKind::Keyword(
                keyword @ (Keyword::InfiniteLoopLimit | Keyword::InfiniteRecursionLimit),
            ) => {
                self.bump();
                let value = self.parse_pragma_value();
                StmtKind::Pragma {
                    kind: pragma_kind(keyword),
                    value,
                }
            }
            TokenKind::Keyword(Keyword::Class) => StmtKind::Class(self.parse_class()),
            TokenKind::Keyword(
                keyword @ (Keyword::Else
                | Keyword::Case
                | Keyword::Default
                | Keyword::Rule
                | Keyword::Include
                | Keyword::Then
                | Keyword::Active
                | Keyword::Inactive
                | Keyword::MinInterval
                | Keyword::MaxInterval
                | Keyword::HighFrequency
                | Keyword::RunImmediately),
            ) => {
                let message = match keyword {
                    Keyword::Else => "'else' must follow an if statement.".to_owned(),
                    Keyword::Case | Keyword::Default => {
                        format!("'{}' is only valid inside a switch.", keyword.as_str())
                    }
                    Keyword::Rule | Keyword::Include => format!(
                        "'{}' is only valid at file scope, not inside a function or rule.",
                        keyword.as_str()
                    ),
                    _ => format!("'{}' cannot start a statement.", keyword.as_str()),
                };
                self.error_here("XS2008", message);
                self.bump();
                self.recover_statement();
                StmtKind::Error
            }
            _ if self.at_local_declaration_start() => {
                let start = self.current_start();
                let modifiers = self.parse_modifiers();
                let Some(ty) = self.parse_type() else {
                    self.recover_statement();
                    return StmtKind::Error;
                };
                let Some(name) = self.expect_declared_name("a variable name") else {
                    self.recover_statement();
                    return StmtKind::Error;
                };
                if modifiers.const_.is_none()
                    && modifiers.static_.is_none()
                    && !self.at(TokenKind::LParen)
                    && is_reserved_rule_word(&name.text)
                {
                    self.error_at(
                        "XS2012",
                        format!(
                            "'{}' is a reserved XS word (a rule setting) and cannot name a local variable; choose another name.",
                            name.text
                        ),
                        name.range,
                    );
                }
                if self.at(TokenKind::LParen) {
                    let function = self.parse_function_rest(start, modifiers, ty, name);
                    self.error_at(
                        "XS2008",
                        format!(
                            "Function '{}' must be declared at file scope, not inside another body.",
                            function.name.text
                        ),
                        function.name.range,
                    );
                    return StmtKind::Error;
                }
                StmtKind::Variable(self.parse_variable_rest(start, modifiers, ty, name))
            }
            _ => self.parse_expression_statement(),
        }
    }

    fn at_local_declaration_start(&self) -> bool {
        match self.peek() {
            Some(TokenKind::Keyword(
                Keyword::Const
                | Keyword::Static
                | Keyword::Extern
                | Keyword::Export
                | Keyword::Mutable,
            )) => true,
            Some(TokenKind::Keyword(keyword)) if keyword.is_type() => {
                self.peek_at(1) != Some(TokenKind::LParen)
            }
            Some(TokenKind::Identifier) => {
                self.peek_at(1) == Some(TokenKind::Identifier) || self.at_reserved_rule_word(1)
            }
            _ => false,
        }
    }

    fn finish_simple_statement(&mut self) {
        self.finish_semicolon();
    }

    fn finish_semicolon(&mut self) {
        if self.expect(TokenKind::Semicolon, "';'").is_some() {
            return;
        }
        let start = self.previous_end().0 as usize;
        let end = self.current_start().0 as usize;
        let line_break = self.peek_token(0).is_some()
            && self.source.bytes().get(start..end).is_some_and(|between| {
                between
                    .iter()
                    .any(|byte| *byte == LINE_FEED || *byte == CARRIAGE_RETURN)
            });
        if !line_break {
            self.recover_statement();
        }
    }

    fn parse_expression_statement(&mut self) -> StmtKind {
        if self.at_reserved_rule_word(0) && self.peek_at(1) == Some(TokenKind::LParen) {
            self.reserved_callee_at = Some(self.position);
        }
        let target = self.parse_expression();
        self.reserved_callee_at = None;
        if matches!(target.kind, ExprKind::Error) {
            self.recover_statement();
            return StmtKind::Error;
        }
        let kind = if self.eat(TokenKind::Assign).is_some() {
            let value = self.parse_expression();
            StmtKind::Assign {
                target,
                op: AssignOp::Assign,
                value: Some(value),
            }
        } else if self.eat(TokenKind::PlusPlus).is_some() {
            StmtKind::Assign {
                target,
                op: AssignOp::Increment,
                value: None,
            }
        } else if self.eat(TokenKind::MinusMinus).is_some() {
            StmtKind::Assign {
                target,
                op: AssignOp::Decrement,
                value: None,
            }
        } else {
            StmtKind::Expr(target)
        };
        self.finish_simple_statement();
        kind
    }

    fn parse_for(&mut self) -> StmtKind {
        self.bump();
        let header_start = self.current_start();
        let mut variable = None;
        let mut start = None;
        let mut compare = None;
        let mut limit = None;
        let header_ok = (|| {
            self.eat(TokenKind::LParen)?;
            let token = self.eat(TokenKind::Identifier)?;
            variable = Some(Name {
                text: self.text(&token),
                range: token.range,
            });
            self.eat(TokenKind::Assign)?;
            start = Some(self.parse_expression());
            self.eat(TokenKind::Semicolon)?;
            compare = Some(match self.bump()?.kind {
                TokenKind::Less => CompareOp::Less,
                TokenKind::LessEq => CompareOp::LessEq,
                TokenKind::Greater => CompareOp::Greater,
                TokenKind::GreaterEq => CompareOp::GreaterEq,
                _ => return None,
            });
            limit = Some(self.parse_expression());
            self.eat(TokenKind::RParen)?;
            Some(())
        })()
        .is_some();
        if !header_ok {
            self.error_at(
                "XS2005",
                "XS for loops have the form 'for (i = start; < limit)' (also <=, >, >=)."
                    .to_owned(),
                self.span_from(header_start),
            );
            let mut depth = 0_u32;
            while let Some(kind) = self.peek() {
                match kind {
                    TokenKind::LParen => depth += 1,
                    TokenKind::RParen => {
                        self.bump();
                        if depth <= 1 {
                            break;
                        }
                        depth -= 1;
                        continue;
                    }
                    TokenKind::LBrace | TokenKind::RBrace => break,
                    _ => {}
                }
                self.bump();
            }
        }
        let body = self.boxed_statement("as the loop body");
        StmtKind::For {
            variable,
            start,
            compare,
            limit,
            body,
        }
    }

    fn parse_switch(&mut self) -> StmtKind {
        self.bump();
        let scrutinee = self.parenthesized_condition("switch");
        let mut cases = Vec::new();
        if self
            .expect(TokenKind::LBrace, "'{' to start the switch body")
            .is_none()
        {
            self.recover_statement();
            return StmtKind::Switch { scrutinee, cases };
        }
        while !self.at_end() && !self.at(TokenKind::RBrace) {
            let case_start = self.current_start();
            let label = if self.eat(TokenKind::Keyword(Keyword::Case)).is_some() {
                Some(self.parse_expression())
            } else if self.eat(TokenKind::Keyword(Keyword::Default)).is_some() {
                None
            } else {
                let found = self.describe_current();
                self.error_here(
                    "XS2010",
                    format!("Expected 'case' or 'default' in the switch, found {found}."),
                );
                self.recover_statement();
                continue;
            };
            let label_range = self.span_from(case_start);
            self.expect(TokenKind::Colon, "':'");
            let mut body = Vec::new();
            while !self.at_end()
                && !self.at(TokenKind::RBrace)
                && !self.at_keyword(Keyword::Case)
                && !self.at_keyword(Keyword::Default)
            {
                let before = self.position;
                body.push(self.parse_statement());
                if self.position == before {
                    self.bump();
                }
            }
            cases.push(Case {
                label,
                label_range,
                body,
                range: self.span_from(case_start),
            });
        }
        self.expect(TokenKind::RBrace, "'}' to close the switch");
        StmtKind::Switch { scrutinee, cases }
    }

    pub(crate) fn parse_expression(&mut self) -> Expr {
        self.parse_binary(0)
    }

    fn parse_binary(&mut self, minimum_level: u8) -> Expr {
        let start = self.current_start();
        if !self.enter() {
            self.bump();
            return Expr {
                kind: ExprKind::Error,
                range: self.span_from(start),
            };
        }
        let mut left = self.parse_unary_inner();
        while let Some((op, level)) = self.peek().and_then(binary_operator) {
            if level < minimum_level {
                break;
            }
            self.bump();
            let right = self.parse_binary(level + 1);
            left = Expr {
                range: self.span_from(start),
                kind: ExprKind::Binary {
                    op,
                    left: Box::new(left),
                    right: Box::new(right),
                },
            };
        }
        self.leave();
        left
    }

    fn parse_unary(&mut self) -> Expr {
        let start = self.current_start();
        if !self.enter() {
            self.bump();
            return Expr {
                kind: ExprKind::Error,
                range: self.span_from(start),
            };
        }
        let expression = self.parse_unary_inner();
        self.leave();
        expression
    }

    fn parse_unary_inner(&mut self) -> Expr {
        let start = self.current_start();
        let op = match self.peek() {
            Some(TokenKind::Minus) => UnaryOp::Negate,
            Some(TokenKind::Plus) => UnaryOp::Plus,
            _ => return self.parse_postfix(),
        };
        self.bump();
        let operand = self.parse_unary();
        Expr {
            range: self.span_from(start),
            kind: ExprKind::Unary {
                op,
                operand: Box::new(operand),
            },
        }
    }

    fn parse_postfix(&mut self) -> Expr {
        let start = self.current_start();
        let mut expression = self.parse_primary();
        while self.at(TokenKind::Period) {
            self.bump();
            let Some(member) = self.expect_name("a member name") else {
                break;
            };
            expression = Expr {
                range: self.span_from(start),
                kind: ExprKind::Member {
                    object: Box::new(expression),
                    member,
                },
            };
        }
        expression
    }

    fn parse_arguments(&mut self) -> (Vec<Expr>, ByteRange) {
        let open = self.current_start();
        self.bump();
        let mut args = Vec::new();
        if !self.at(TokenKind::RParen) {
            loop {
                if self.at_end()
                    || matches!(self.peek(), Some(TokenKind::Semicolon | TokenKind::RBrace))
                {
                    break;
                }
                args.push(self.parse_expression());
                if self.eat(TokenKind::Comma).is_none() {
                    break;
                }
            }
        }
        self.expect(TokenKind::RParen, "')' to close the argument list");
        (args, self.span_from(open))
    }

    fn parse_call_arguments(&mut self) -> (Vec<Expr>, ByteRange, Vec<ByteRange>, bool) {
        let open = self.current_start();
        self.bump();
        let mut args = Vec::new();
        let mut extra_commas = Vec::new();
        loop {
            if self.at_end()
                || matches!(
                    self.peek(),
                    Some(TokenKind::RParen | TokenKind::Semicolon | TokenKind::RBrace)
                )
            {
                break;
            }
            if let Some(comma) = self.eat(TokenKind::Comma) {
                extra_commas.push(comma.range);
                continue;
            }
            args.push(self.parse_expression());
            if self.eat(TokenKind::Comma).is_none() {
                break;
            }
        }
        let closed = self
            .expect(TokenKind::RParen, "')' to close the argument list")
            .is_some();
        (args, self.span_from(open), extra_commas, closed)
    }

    fn parenthesized_type_ahead(&self) -> Option<TypeName> {
        if self.peek_at(2) != Some(TokenKind::RParen) {
            return None;
        }
        match self.peek_at(1)? {
            TokenKind::Keyword(Keyword::Int) => Some(TypeName::Int),
            TokenKind::Keyword(Keyword::Float) => Some(TypeName::Float),
            TokenKind::Keyword(Keyword::Bool) => Some(TypeName::Bool),
            TokenKind::Keyword(Keyword::String) => Some(TypeName::String),
            _ => None,
        }
    }

    fn at_operand_start(&self) -> bool {
        match self.peek() {
            Some(
                TokenKind::Identifier
                | TokenKind::Integer
                | TokenKind::Float
                | TokenKind::BoolLiteral
                | TokenKind::String
                | TokenKind::LParen,
            ) => true,
            Some(TokenKind::Keyword(keyword)) => {
                keyword.is_reserved_rule_word()
                    || (matches!(
                        keyword,
                        Keyword::Int
                            | Keyword::Float
                            | Keyword::Bool
                            | Keyword::String
                            | Keyword::Vector
                    ) && self.peek_at(1) == Some(TokenKind::LParen))
            }
            _ => false,
        }
    }

    fn parse_primary(&mut self) -> Expr {
        let start = self.current_start();
        let Some(token) = self.peek_token(0).copied() else {
            self.error_here(
                "XS2002",
                "Expected an expression, found the end of the file.".to_owned(),
            );
            return Expr {
                kind: ExprKind::Error,
                range: self.span_from(start),
            };
        };
        let kind = match token.kind {
            TokenKind::Integer => {
                self.bump();
                let text = self.text(&token);
                ExprKind::Literal(Literal::Integer(text.parse::<i64>().unwrap_or(i64::MAX)))
            }
            TokenKind::Float => {
                self.bump();
                let text = self.text(&token);
                ExprKind::Literal(Literal::Float(text.parse::<f64>().unwrap_or(0.0)))
            }
            TokenKind::BoolLiteral => {
                self.bump();
                ExprKind::Literal(Literal::Bool(
                    self.text(&token).eq_ignore_ascii_case("true"),
                ))
            }
            TokenKind::String => {
                self.bump();
                ExprKind::Literal(Literal::String(unquote(&self.text(&token))))
            }
            TokenKind::Identifier | TokenKind::Keyword(Keyword::Priority | Keyword::Group) => {
                if token.kind != TokenKind::Identifier
                    && self.reserved_callee_at != Some(self.position)
                {
                    let word = self.text(&token);
                    self.error_here(
                        "XS2012",
                        format!(
                            "'{word}' is a reserved XS word (a rule setting) and cannot be used in an expression; rename the variable or function named '{word}'."
                        ),
                    );
                }
                self.bump();
                let name = Name {
                    text: self.text(&token),
                    range: token.range,
                };
                if self.at(TokenKind::LParen) {
                    let (args, args_range, extra_commas, closed) = self.parse_call_arguments();
                    ExprKind::Call {
                        callee: name,
                        args,
                        args_range,
                        extra_commas,
                        closed,
                    }
                } else {
                    ExprKind::Name(name)
                }
            }
            TokenKind::LParen if let Some(ty) = self.parenthesized_type_ahead() => {
                self.bump();
                self.bump();
                self.bump();
                let type_range = self.span_from(start);
                let operand = self
                    .at_operand_start()
                    .then(|| Box::new(self.parse_postfix()));
                ExprKind::ParenthesizedType {
                    ty,
                    type_range,
                    operand,
                }
            }
            TokenKind::LParen => {
                self.bump();
                let inner = self.parse_expression();
                self.expect(TokenKind::RParen, "')'");
                ExprKind::Paren(Box::new(inner))
            }
            TokenKind::Keyword(Keyword::Vector) if self.peek_at(1) == Some(TokenKind::LParen) => {
                self.bump();
                let (args, _) = self.parse_arguments();
                ExprKind::Vector(args)
            }
            TokenKind::Keyword(
                keyword @ (Keyword::Int
                | Keyword::Float
                | Keyword::Bool
                | Keyword::String
                | Keyword::Void),
            ) if self.peek_at(1) == Some(TokenKind::LParen) => {
                self.bump();
                let (mut args, _) = self.parse_arguments();
                let ty = match keyword {
                    Keyword::Int => TypeName::Int,
                    Keyword::Float => TypeName::Float,
                    Keyword::Bool => TypeName::Bool,
                    Keyword::String => TypeName::String,
                    _ => TypeName::Void,
                };
                if args.len() > 1 {
                    self.error_at(
                        "XS2001",
                        format!("A conversion to {} takes exactly one value.", ty.as_str()),
                        args[1].range,
                    );
                }
                ExprKind::Cast {
                    ty,
                    operand: (!args.is_empty()).then(|| Box::new(args.swap_remove(0))),
                }
            }
            _ => {
                let found = self.describe_current();
                self.error_here("XS2002", format!("Expected an expression, found {found}."));
                return Expr {
                    kind: ExprKind::Error,
                    range: ByteRange {
                        start: token.range.start,
                        end: token.range.start,
                    },
                };
            }
        };
        Expr {
            kind,
            range: self.span_from(start),
        }
    }
}

fn binary_operator(kind: TokenKind) -> Option<(BinaryOp, u8)> {
    Some(match kind {
        TokenKind::OrOr => (BinaryOp::Or, 1),
        TokenKind::AndAnd => (BinaryOp::And, 2),
        TokenKind::Pipe => (BinaryOp::BitOr, 3),
        TokenKind::Amp => (BinaryOp::BitAnd, 4),
        TokenKind::EqEq => (BinaryOp::Eq, 5),
        TokenKind::NotEq => (BinaryOp::NotEq, 5),
        TokenKind::Less => (BinaryOp::Less, 6),
        TokenKind::LessEq => (BinaryOp::LessEq, 6),
        TokenKind::Greater => (BinaryOp::Greater, 6),
        TokenKind::GreaterEq => (BinaryOp::GreaterEq, 6),
        TokenKind::Plus => (BinaryOp::Add, 7),
        TokenKind::Minus => (BinaryOp::Sub, 7),
        TokenKind::Star => (BinaryOp::Mul, 8),
        TokenKind::Slash => (BinaryOp::Div, 8),
        TokenKind::Percent => (BinaryOp::Mod, 8),
        _ => return None,
    })
}

fn is_reserved_rule_word(text: &str) -> bool {
    Keyword::from_bytes(text.as_bytes()).is_some_and(Keyword::is_reserved_rule_word)
}

fn pragma_kind(keyword: Keyword) -> PragmaKind {
    if keyword == Keyword::InfiniteLoopLimit {
        PragmaKind::InfiniteLoopLimit
    } else {
        PragmaKind::InfiniteRecursionLimit
    }
}

fn type_label(ty: &TypeRef) -> String {
    match ty {
        TypeRef::Builtin(name, _) => name.as_str().to_owned(),
        TypeRef::Class(name) => name.text.clone(),
    }
}

fn default_example(ty: &TypeRef) -> &'static str {
    match ty {
        TypeRef::Builtin(TypeName::Int, _) => "-1",
        TypeRef::Builtin(TypeName::Float, _) => "0.0",
        TypeRef::Builtin(TypeName::Bool, _) => "false",
        TypeRef::Builtin(TypeName::String, _) => "\"\"",
        TypeRef::Builtin(TypeName::Vector, _) => "vector(0, 0, 0)",
        _ => "...",
    }
}

pub(crate) fn unquote(raw: &str) -> String {
    let inner = raw.strip_prefix('"').unwrap_or(raw);
    let inner = inner.strip_suffix('"').unwrap_or(inner);
    let mut value = String::with_capacity(inner.len());
    let mut characters = inner.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => value.push('\n'),
            Some('r') => value.push('\r'),
            Some('t') => value.push('\t'),
            Some('b') => value.push('\u{8}'),
            Some('f') => value.push('\u{c}'),
            Some('v') => value.push('\u{b}'),
            Some(other) => value.push(other),
            None => value.push('\\'),
        }
    }
    value
}
