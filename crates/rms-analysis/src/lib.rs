pub mod docs;
mod editor_fixes;
mod inlay;
mod lint;
mod undefined_paths;

pub use editor_fixes::{closest_name, missing_closer_fix, undefined_name_fix};
pub use inlay::{
    ContentKind, InlayHint, InlayHintKind, MAXIMUM_INLAY_HINTS, content_slot, inlay_hints,
    operand_names,
};
pub use lint::{
    BRANCH_NEVER_CHOSEN, CLAMPED_VALUE, IGNORED_REDEFINITION, LINT_RULES, LintEdit,
    LintEnvironment, LintFinding, LintFix, LintRelated, LintRule, LintSeverity,
    MAXIMUM_LINT_RELATED, NO_EFFECT_HERE, NUMBER_FOR_A_NAME, OVERWRITTEN_ATTRIBUTE,
    POSSIBLY_UNDEFINED_NAME, Predefined, ProgramView, UNKNOWN_COMMAND, UNUSED_DEFINITION,
    ZERO_CHANCE_FIRST_BRANCH, closest_command, document_definitions, lint_document, lint_rule,
    suppression_edit, unique_closest, within_one_edit,
};

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use rms_profile::{BehaviorProfile, DecisionValue, frozen_current_profile};
use rms_semantics::{
    ExecutionContext, ParserLimits, SemanticProgram, StrictArgumentKind, StrictLexCache,
    StrictParseError, StrictParseOptions, parse_strict, parse_strict_cached, parse_strict_single,
    reads_missing_operand_from_next_line, strict_command_id, strict_commands,
};
use rms_source::{
    ByteOffset, ByteRange, SourceCatalog, SourceCatalogOrigin, SourceText, VirtualSourceResolver,
};
use rms_syntax::{
    CommandShape, CstDocument, CstKind, LexerLimits, LexicalProfile, OperandKind, StatementGrammar,
    TokenKind, parse_tolerant,
};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalysisDiagnostic {
    pub code: String,
    pub message: String,
    pub range: ByteRange,
    pub severity: DiagnosticSeverity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutlineKind {
    Section,
    Command,
    Attribute,
    Definition,
    Include,
    Conditional,
    RandomBranch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutlineItem {
    pub name: String,
    pub kind: OutlineKind,
    pub range: ByteRange,
    pub selection_range: ByteRange,
    pub depth: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoldRegion {
    pub range: ByteRange,
    pub kind: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: OutlineKind,
    pub range: ByteRange,
    pub selection_range: ByteRange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticTokenKind {
    Comment,
    Keyword,
    Section,
    Command,
    Attribute,
    Number,
    String,
    Variable,
    Operator,
    Control,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticTokenCandidate {
    pub kind: SemanticTokenKind,
    pub range: ByteRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentAnalysis {
    pub document_revision: [u8; 32],
    pub cst: CstDocument,
    pub diagnostics: Vec<AnalysisDiagnostic>,
    pub outline: Vec<OutlineItem>,
    pub folds: Vec<FoldRegion>,
    pub symbols: Vec<DocumentSymbol>,
    pub semantic_tokens: Vec<SemanticTokenCandidate>,
}

pub const MAXIMUM_REPORTED_DIAGNOSTICS: usize = 1_000;

pub fn analyze_document(source: &SourceText) -> DocumentAnalysis {
    analyze_document_with_profile(source, LexicalProfile::default(), LexerLimits::default())
}

struct StrictStatementGrammar {
    commands: Vec<(Vec<OperandKind>, bool)>,
}

impl StatementGrammar for StrictStatementGrammar {
    fn command(&self, word: &[u8]) -> Option<CommandShape<'_>> {
        std::str::from_utf8(word)
            .ok()
            .and_then(strict_command_id)
            .and_then(|id| self.commands.get(id))
            .map(|(operands, operands_from_next_line)| CommandShape {
                operands,
                operands_from_next_line: *operands_from_next_line,
            })
    }
}

pub fn editor_grammar() -> &'static dyn StatementGrammar {
    static GRAMMAR: OnceLock<StrictStatementGrammar> = OnceLock::new();
    GRAMMAR.get_or_init(|| StrictStatementGrammar {
        commands: strict_commands()
            .iter()
            .map(|command| {
                let operands = command
                    .arguments
                    .iter()
                    .map(|argument| match argument {
                        StrictArgumentKind::Label
                        | StrictArgumentKind::Token
                        | StrictArgumentKind::Path => OperandKind::Word,
                        StrictArgumentKind::Number => OperandKind::Number,
                        StrictArgumentKind::Condition => OperandKind::Condition,
                        StrictArgumentKind::TolerantNumber => OperandKind::OptionalNumber,
                    })
                    .collect();
                (operands, reads_missing_operand_from_next_line(command.name))
            })
            .collect(),
    })
}

pub fn parse_editor_syntax(
    source: &SourceText,
    profile: LexicalProfile,
    limits: LexerLimits,
) -> CstDocument {
    parse_tolerant(source, profile, limits, editor_grammar())
}

pub fn analyze_document_with_profile(
    source: &SourceText,
    profile: LexicalProfile,
    limits: LexerLimits,
) -> DocumentAnalysis {
    let cst = parse_editor_syntax(source, profile, limits);
    let mut diagnostics: Vec<AnalysisDiagnostic> = cst
        .diagnostics
        .iter()
        .take(MAXIMUM_REPORTED_DIAGNOSTICS)
        .map(|diagnostic| AnalysisDiagnostic {
            code: diagnostic.code.to_owned(),
            message: diagnostic.message.clone(),
            range: diagnostic.range,
            severity: if diagnostic.code.starts_with("RMS11") {
                DiagnosticSeverity::Error
            } else {
                DiagnosticSeverity::Warning
            },
        })
        .collect();
    if cst.diagnostics.len() > MAXIMUM_REPORTED_DIAGNOSTICS {
        diagnostics.push(AnalysisDiagnostic {
            code: "RMS1009".to_owned(),
            message: format!(
                "{} more syntax diagnostics were omitted",
                cst.diagnostics.len() - MAXIMUM_REPORTED_DIAGNOSTICS
            ),
            range: cst.diagnostics[MAXIMUM_REPORTED_DIAGNOSTICS].range,
            severity: DiagnosticSeverity::Warning,
        });
    }
    let outline = build_outline(source, &cst);
    let folds = build_folds(source, &cst);
    let symbols = outline
        .iter()
        .map(|item| DocumentSymbol {
            name: item.name.clone(),
            kind: item.kind,
            range: item.range,
            selection_range: item.selection_range,
        })
        .collect();
    let semantic_tokens = build_semantic_tokens(&cst);
    DocumentAnalysis {
        document_revision: Sha256::digest(source.bytes()).into(),
        cst,
        diagnostics,
        outline,
        folds,
        symbols,
        semantic_tokens,
    }
}

pub fn default_strict_options() -> StrictParseOptions {
    let profile =
        frozen_current_profile().expect("the compile-time frozen behavior profile is valid");
    let undefined_numeric_values_are_zero = matches!(
        profile.decisions.parser.get("undefined-numeric-values"),
        Some(DecisionValue::String(value)) if value == "zero-with-decision"
    );
    let optional_missing_includes = profile
        .decisions
        .parser
        .iter()
        .filter_map(|(name, value)| match (name.as_str(), value) {
            (name, DecisionValue::String(path))
                if name.starts_with("optional-missing-include-") =>
            {
                Some(path.clone())
            }
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    StrictParseOptions {
        profile: profile.identity(),
        execution_context: ExecutionContext::default(),
        lexical_profile: LexicalProfile::default(),
        limits: ParserLimits::default(),
        implicit_definitions: BTreeMap::new(),
        semantic_token_aliases: BTreeMap::new(),
        preloaded_sources: Default::default(),
        undefined_numeric_values_are_zero,
        optional_missing_includes,
    }
}

pub fn product_strict_options(
    profile: &BehaviorProfile,
    vocabulary: &BTreeMap<String, String>,
) -> StrictParseOptions {
    let mut options = default_strict_options();
    options.profile = profile.identity();
    options.implicit_definitions = vocabulary.clone();
    apply_profile_parser_decisions(profile, &mut options);
    options
}

pub fn product_strict_options_for_profile(
    profile_id: &str,
    vocabulary: &BTreeMap<String, String>,
) -> Result<StrictParseOptions, String> {
    let profiles =
        rms_profile::ProfileCatalog::frozen_current().map_err(|error| error.to_string())?;
    let profile = profiles
        .get(profile_id)
        .ok_or_else(|| format!("unknown behavior profile {profile_id}"))?;
    Ok(product_strict_options(profile, vocabulary))
}

pub fn apply_profile_parser_decisions(profile: &BehaviorProfile, options: &mut StrictParseOptions) {
    options.semantic_token_aliases = profile.semantic_token_aliases.clone();
    let boolean = |name: &str| match profile.decisions.parser.get(name) {
        Some(DecisionValue::Boolean(value)) => Some(*value),
        _ => None,
    };
    if let Some(value) = boolean("block-comments") {
        options.lexical_profile.block_comments = value;
    }
    if let Some(value) = boolean("semicolon-line-comments") {
        options.lexical_profile.semicolon_line_comments = value;
    }
    if let Some(value) = boolean("slash-line-comments") {
        options.lexical_profile.slash_line_comments = value;
    }
}

pub fn require_catalog_vocabulary(
    catalog: &SourceCatalog,
    vocabulary: &BTreeMap<String, String>,
) -> Result<(), StrictParseError> {
    if catalog.implicit_definitions() == vocabulary {
        return Ok(());
    }
    Err(StrictParseError {
        kind: rms_semantics::StrictParseErrorKind::Resolution,
        code: "RMS2031",
        message:
            "source catalog implicit environment does not match the selected version's definitions"
                .to_owned(),
        source_chain: Vec::new(),
        range: None,
    })
}

pub fn analyze_semantics_single(
    source: SourceText,
    options: StrictParseOptions,
) -> Result<SemanticProgram, StrictParseError> {
    parse_strict_single(source, options).map(SemanticProgram::from_parsed)
}

pub fn analyze_semantics_catalog(
    catalog: &SourceCatalog,
    options: StrictParseOptions,
) -> Result<SemanticProgram, StrictParseError> {
    let (resolver, entry, options) = catalog_strict_inputs(catalog, options)?;
    parse_strict(catalog.entry_path(), entry, &resolver, options).map(SemanticProgram::from_parsed)
}

#[derive(Debug)]
pub struct PreparedCatalogAnalysis {
    entry_path: String,
    entry: SourceText,
    resolver: VirtualSourceResolver,
    options: StrictParseOptions,
    lex_cache: StrictLexCache,
}

impl PreparedCatalogAnalysis {
    pub fn new(
        catalog: &SourceCatalog,
        options: StrictParseOptions,
    ) -> Result<Self, StrictParseError> {
        let (resolver, entry, options) = catalog_strict_inputs(catalog, options)?;
        Ok(Self {
            entry_path: catalog.entry_path().to_owned(),
            entry,
            resolver,
            options,
            lex_cache: StrictLexCache::new(),
        })
    }

    pub fn analyze(&self, seed: u32) -> Result<SemanticProgram, StrictParseError> {
        let mut options = self.options.clone();
        options.execution_context.seed = seed;
        parse_strict_cached(
            &self.entry_path,
            self.entry.clone(),
            &self.resolver,
            options,
            &self.lex_cache,
        )
        .map(SemanticProgram::from_parsed)
    }
}

fn catalog_strict_inputs(
    catalog: &SourceCatalog,
    mut options: StrictParseOptions,
) -> Result<(VirtualSourceResolver, SourceText, StrictParseOptions), StrictParseError> {
    let contextual_definitions = std::mem::take(&mut options.implicit_definitions);
    options.implicit_definitions = catalog.implicit_definitions().clone();
    options.implicit_definitions.extend(contextual_definitions);
    options.preloaded_sources.extend(
        catalog
            .sources()
            .iter()
            .filter(|source| source.origin == SourceCatalogOrigin::ImplicitEnvironment)
            .map(|source| source.source_id.clone()),
    );
    let resolver = catalog.resolver().map_err(|error| StrictParseError {
        kind: rms_semantics::StrictParseErrorKind::Resolution,
        code: "RMS2030",
        message: error.to_string(),
        source_chain: Vec::new(),
        range: None,
    })?;
    let entry = catalog.entry_source().map_err(|error| StrictParseError {
        kind: rms_semantics::StrictParseErrorKind::Resolution,
        code: "RMS2030",
        message: error.to_string(),
        source_chain: Vec::new(),
        range: None,
    })?;
    Ok((resolver, entry, options))
}

fn build_outline(source: &SourceText, cst: &CstDocument) -> Vec<OutlineItem> {
    cst.nodes
        .iter()
        .filter_map(|node| {
            let kind = match node.kind {
                CstKind::Section => OutlineKind::Section,
                CstKind::Command => OutlineKind::Command,
                CstKind::Attribute => OutlineKind::Attribute,
                CstKind::Definition => OutlineKind::Definition,
                CstKind::Include => OutlineKind::Include,
                CstKind::Conditional => OutlineKind::Conditional,
                CstKind::RandomBranch => OutlineKind::RandomBranch,
                CstKind::Brace | CstKind::Error => return None,
            };
            let token = cst.tokens.get(node.token_start as usize)?;
            Some(OutlineItem {
                name: String::from_utf8_lossy(token.bytes(source)).into_owned(),
                kind,
                range: node.range,
                selection_range: token.range,
                depth: node.depth,
            })
        })
        .collect()
}

fn build_folds(source: &SourceText, cst: &CstDocument) -> Vec<FoldRegion> {
    let mut folds = Vec::new();
    let sections: Vec<_> = cst
        .nodes
        .iter()
        .filter(|node| node.kind == CstKind::Section)
        .collect();
    for (index, section) in sections.iter().enumerate() {
        let end = sections
            .get(index + 1)
            .map_or(ByteOffset(source.bytes().len() as u32), |next| {
                next.range.start
            });
        if end > section.range.end {
            folds.push(FoldRegion {
                range: ByteRange {
                    start: section.range.start,
                    end,
                },
                kind: "region",
            });
        }
    }
    folds.extend(
        cst.brace_pairs
            .iter()
            .filter(|pair| pair.end > pair.start)
            .map(|pair| FoldRegion {
                range: *pair,
                kind: "region",
            }),
    );
    folds.sort_by_key(|fold| (fold.range.start, fold.range.end));
    folds
}

fn build_semantic_tokens(cst: &CstDocument) -> Vec<SemanticTokenCandidate> {
    let node_kinds: BTreeMap<u32, CstKind> = cst
        .nodes
        .iter()
        .map(|node| (node.token_start, node.kind))
        .collect();
    cst.tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            let node_kind = node_kinds.get(&(index as u32));
            let kind = match token.kind {
                TokenKind::LineComment | TokenKind::BlockComment => SemanticTokenKind::Comment,
                TokenKind::Section => SemanticTokenKind::Section,
                TokenKind::Directive
                    if matches!(
                        node_kind,
                        Some(CstKind::Conditional | CstKind::RandomBranch)
                    ) =>
                {
                    SemanticTokenKind::Control
                }
                TokenKind::Directive => SemanticTokenKind::Keyword,
                TokenKind::Number => SemanticTokenKind::Number,
                TokenKind::String => SemanticTokenKind::String,
                TokenKind::Operator => SemanticTokenKind::Operator,
                TokenKind::Identifier => match node_kind {
                    Some(CstKind::Command) => SemanticTokenKind::Command,
                    Some(CstKind::Attribute) => SemanticTokenKind::Attribute,
                    Some(CstKind::Conditional | CstKind::RandomBranch) => {
                        SemanticTokenKind::Control
                    }
                    _ => SemanticTokenKind::Variable,
                },
                _ => return None,
            };
            Some(SemanticTokenCandidate {
                kind,
                range: token.range,
            })
        })
        .collect()
}
