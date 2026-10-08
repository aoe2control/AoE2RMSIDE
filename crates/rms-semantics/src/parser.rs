use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use rms_profile::ProfileIdentity;
use rms_source::{
    ByteOffset, ByteRange, IncludePath, ResolutionDiagnostic, ResolutionDiagnosticKind, SourceId,
    SourceText, VirtualSource, VirtualSourceResolver,
};
use rms_syntax::{LexerLimits, LexicalProfile, Token, TokenKind, lex};
use thiserror::Error;

mod dependency_discovery;
pub use dependency_discovery::{PotentialInclude, discover_include_requests};

use crate::native_dispatch::{
    GAME_CRASH_CODE, HandlerState, NullSlot, UNSUPPORTED_DISPATCH_CODE,
    crashes_in_connection_block, first_slot_is_not_a_token, native_command_id, null_token_slot,
};
use crate::strict_commands::{strict_command_by_id, strict_command_id};
use crate::{
    find_command,
    strict_commands::{
        StrictArgumentKind, StrictCommand, StrictCommandKind, find_strict_command,
        reads_missing_operand_from_next_line,
    },
    target_rng::{RmsRandom, RmsRngDraw, RmsRngPurpose, RmsRngSample, RmsRngState},
};
use crate::{is_global_descriptor_command, section_rules};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ExecutionPlayerSetup {
    pub slot: u8,
    pub team: u8,
    pub civilization_id: u32,
    pub color: u8,
}

impl ExecutionPlayerSetup {
    pub fn has_default_color(&self) -> bool {
        u16::from(self.color) + 1 == u16::from(self.slot)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionContext {
    pub seed: u32,
    pub map_width: u16,
    pub map_height: u16,
    pub players: Vec<ExecutionPlayerSetup>,
    pub game_mode: u8,
    pub starting_resources: u8,
    pub starting_age: u8,
    pub position_policy: u8,
}

impl Default for ExecutionContext {
    fn default() -> Self {
        Self {
            seed: 0,
            map_width: 120,
            map_height: 120,
            players: vec![
                ExecutionPlayerSetup {
                    slot: 1,
                    team: 0,
                    civilization_id: 0,
                    color: 0,
                },
                ExecutionPlayerSetup {
                    slot: 2,
                    team: 0,
                    civilization_id: 0,
                    color: 1,
                },
            ],
            game_mode: 0,
            starting_resources: 0,
            starting_age: 0,
            position_policy: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParserLimits {
    pub lexer: LexerLimits,
    pub maximum_include_depth: u32,
    pub maximum_descriptors: u32,
    pub maximum_definitions: u32,
    pub maximum_alias_expansion: u32,
    pub maximum_random_nesting: u32,
}

impl Default for ParserLimits {
    fn default() -> Self {
        Self {
            lexer: LexerLimits::default(),
            maximum_include_depth: 64,
            maximum_descriptors: 1_000_000,
            maximum_definitions: 65_536,
            maximum_alias_expansion: 64,
            maximum_random_nesting: 64,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrictParseOptions {
    pub profile: ProfileIdentity,
    pub execution_context: ExecutionContext,
    pub lexical_profile: LexicalProfile,
    pub limits: ParserLimits,
    pub implicit_definitions: BTreeMap<String, String>,
    pub preloaded_sources: BTreeSet<SourceId>,
    pub semantic_token_aliases: BTreeMap<i64, String>,
    pub undefined_numeric_values_are_zero: bool,
    pub optional_missing_includes: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArgumentKind {
    Identifier,
    Number,
    String,
    Operator,
    Punctuation,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArgumentResolution {
    Direct,
    DefinedIdentifier,
    UndefinedNumericFallback,
    ObjectGroupReference,
    UnparsedAfterRejection,
    UnregisteredNumber,
}

#[cfg(any(test, feature = "attribution-switches"))]
fn number_name_rule_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_NUMBER_NAME_RULE").is_some()
}

#[cfg(not(any(test, feature = "attribution-switches")))]
fn number_name_rule_disabled_for_attribution() -> bool {
    false
}

#[cfg(any(test, feature = "attribution-switches"))]
fn word_name_rule_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_WORD_NAME_RULE").is_some()
}

#[cfg(not(any(test, feature = "attribution-switches")))]
fn word_name_rule_disabled_for_attribution() -> bool {
    false
}

#[cfg(any(test, feature = "attribution-switches"))]
fn command_word_pushback_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_COMMAND_WORD_PUSHBACK").is_some()
}

#[cfg(not(any(test, feature = "attribution-switches")))]
fn command_word_pushback_disabled_for_attribution() -> bool {
    false
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedArgument {
    pub kind: ArgumentKind,
    pub value: String,
    pub resolution: ArgumentResolution,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedDescriptor {
    pub section: String,
    pub name: String,
    pub arguments: Vec<ResolvedArgument>,
    pub depth: u32,
    pub source_id: SourceId,
    pub source_range: ByteRange,
    pub include_chain: Vec<SourceId>,
    pub source_ordinal: u32,
    pub parser_effect_rng_draws: Vec<RmsRngDraw>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParsedDecisionKind {
    Definition,
    Redefinition,
    Conditional,
    RandomBranch,
    Include,
    UndefinedNumericFallback,
    MissingIncludeFallback,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedDecision {
    pub kind: ParsedDecisionKind,
    pub values: Vec<String>,
    pub result: bool,
    pub source_id: SourceId,
    pub source_range: ByteRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedProgram {
    pub entry_source: SourceId,
    pub profile: ProfileIdentity,
    pub execution_context: ExecutionContext,
    pub selected_sections: Vec<String>,
    pub descriptors: Vec<ParsedDescriptor>,
    pub decisions: Vec<ParsedDecision>,
    pub resolved_includes: Vec<SourceId>,
    pub external_dependencies: Vec<SourceId>,
    pub rng_draws: Vec<RmsRngDraw>,
    pub rng_state_after_parser: RmsRngState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictParseErrorKind {
    Lexical,
    Resolution,
    Preprocessor,
    Syntax,
    ResourceLimit,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct StrictParseError {
    pub kind: StrictParseErrorKind,
    pub code: &'static str,
    pub message: String,
    pub source_chain: Vec<SourceId>,
    pub range: Option<ByteRange>,
}

#[derive(Debug, Error)]
pub enum ImplicitDefinitionError {
    #[error(transparent)]
    Parse(#[from] StrictParseError),
    #[error("implicit definition import requires an empty initial environment")]
    InitialEnvironment,
    #[error("implicit definition source has context-dependent or executable operations")]
    ContextDependentSource,
    #[error("implicit definition {0} is not a decimal integer")]
    NonIntegerValue(String),
    #[error("implicit definition source is not valid source text: {0}")]
    InvalidSource(String),
}

pub fn normalize_implicit_definition_bytes(
    source_id: &str,
    bytes: Vec<u8>,
) -> Result<BTreeMap<String, i32>, ImplicitDefinitionError> {
    let id = SourceId::new(source_id)
        .map_err(|error| ImplicitDefinitionError::InvalidSource(error.to_string()))?;
    let source = SourceText::from_bytes(id, bytes)
        .map_err(|error| ImplicitDefinitionError::InvalidSource(error.to_string()))?;
    normalize_implicit_definition_integers(source)
}

pub fn normalize_implicit_definition_integers(
    source: SourceText,
) -> Result<BTreeMap<String, i32>, ImplicitDefinitionError> {
    let definitions = normalize_implicit_definition_source(
        source,
        StrictParseOptions {
            profile: ProfileIdentity {
                schema_version: "1.0".to_owned(),
                profile_id: "definition-import".to_owned(),
                behavior_version: "definition-import".to_owned(),
            },
            execution_context: ExecutionContext::default(),
            lexical_profile: LexicalProfile::default(),
            limits: ParserLimits::default(),
            implicit_definitions: BTreeMap::new(),
            preloaded_sources: BTreeSet::new(),
            semantic_token_aliases: BTreeMap::new(),
            undefined_numeric_values_are_zero: false,
            optional_missing_includes: BTreeSet::new(),
        },
    )?;
    definitions
        .into_iter()
        .map(|(name, value)| match value.parse::<i32>() {
            Ok(parsed) => Ok((name, parsed)),
            Err(_) => Err(ImplicitDefinitionError::NonIntegerValue(name)),
        })
        .collect()
}

pub fn parse_strict(
    entry_path: &str,
    entry_source: SourceText,
    resolver: &VirtualSourceResolver,
    options: StrictParseOptions,
) -> Result<ParsedProgram, StrictParseError> {
    Parser::new(Some(resolver), options).parse(entry_path, entry_source)
}

pub fn parse_strict_cached(
    entry_path: &str,
    entry_source: SourceText,
    resolver: &VirtualSourceResolver,
    options: StrictParseOptions,
    cache: &StrictLexCache,
) -> Result<ParsedProgram, StrictParseError> {
    let mut parser = Parser::new(Some(resolver), options);
    parser.lex_cache = Some(cache);
    parser.parse(entry_path, entry_source)
}

#[derive(Debug, Default)]
pub struct StrictLexCache {
    entries: Mutex<BTreeMap<SourceId, Arc<LexedStatements>>>,
}

impl StrictLexCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<SourceId, Arc<LexedStatements>>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn statements(&self, source: &SourceText, limits: LexerLimits) -> Arc<LexedStatements> {
        if let Some(entry) = self.lock().get(source.id())
            && entry.limits == limits
            && entry.bytes.as_ref() == source.bytes()
        {
            return entry.clone();
        }
        let entry = Arc::new(lex_statements(source, limits));
        self.lock().insert(source.id().clone(), entry.clone());
        entry
    }
}

type LexFailure = (StrictParseErrorKind, &'static str, String, ByteRange);

struct LexedStatements {
    bytes: Arc<[u8]>,
    limits: LexerLimits,
    failure: Option<LexFailure>,
    lines: Vec<Line>,
}

impl std::fmt::Debug for LexedStatements {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LexedStatements")
            .field("bytes", &self.bytes.len())
            .field("limits", &self.limits)
            .field("failure", &self.failure)
            .field("lines", &self.lines.len())
            .finish()
    }
}

fn lex_statements(source: &SourceText, limits: LexerLimits) -> LexedStatements {
    let strict_lexical_profile = LexicalProfile {
        semicolon_line_comments: false,
        slash_line_comments: false,
        block_comments: false,
        quoted_values: false,
    };
    let lexed = lex(source, strict_lexical_profile, limits);
    let failure = lexed
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code != "RMS1003")
        .map(|diagnostic| {
            let kind = if diagnostic.kind == rms_syntax::LexDiagnosticKind::ResourceLimit {
                StrictParseErrorKind::ResourceLimit
            } else {
                StrictParseErrorKind::Lexical
            };
            (
                kind,
                diagnostic.code,
                diagnostic.message.clone(),
                diagnostic.range,
            )
        });
    let lines = if failure.is_some() {
        Vec::new()
    } else {
        logical_statements(source, &lexed.tokens)
    };
    LexedStatements {
        bytes: Arc::from(source.bytes()),
        limits,
        failure,
        lines,
    }
}

pub fn parse_strict_single(
    entry_source: SourceText,
    options: StrictParseOptions,
) -> Result<ParsedProgram, StrictParseError> {
    let entry_path = entry_source.id().as_str().to_owned();
    Parser::new(None, options).parse(&entry_path, entry_source)
}

pub fn normalize_implicit_definition_source(
    source: SourceText,
    options: StrictParseOptions,
) -> Result<BTreeMap<String, String>, ImplicitDefinitionError> {
    if !options.implicit_definitions.is_empty()
        || !options.preloaded_sources.is_empty()
        || !options.optional_missing_includes.is_empty()
        || options.undefined_numeric_values_are_zero
    {
        return Err(ImplicitDefinitionError::InitialEnvironment);
    }
    let path = source.id().as_str().to_owned();
    let mut parser = Parser::new(None, options);
    parser.process_source(&path, &source, 0)?;
    parser.validate_termination()?;
    if !parser.selected_sections.is_empty()
        || !parser.descriptors.is_empty()
        || !parser.resolved_includes.is_empty()
        || !parser.external_dependencies.is_empty()
        || !parser.rng_draws.is_empty()
        || parser.decisions.iter().any(|decision| {
            !matches!(
                decision.kind,
                ParsedDecisionKind::Definition | ParsedDecisionKind::Redefinition
            )
        })
    {
        return Err(ImplicitDefinitionError::ContextDependentSource);
    }
    parser
        .definitions
        .into_iter()
        .map(|(name, values)| {
            values
                .into_iter()
                .next()
                .map(|value| (name, value.value))
                .ok_or(ImplicitDefinitionError::ContextDependentSource)
        })
        .collect()
}

struct Parser<'a> {
    resolver: Option<&'a VirtualSourceResolver>,
    options: StrictParseOptions,
    definitions: BTreeMap<String, Vec<ResolvedArgument>>,
    numeric_definition_references: BTreeMap<String, f32>,
    object_group_names: BTreeSet<String>,
    descriptors: Vec<ParsedDescriptor>,
    decisions: Vec<ParsedDecision>,
    resolved_includes: Vec<SourceId>,
    external_dependencies: Vec<SourceId>,
    source_chain: Vec<SourceId>,
    loaded_sources: BTreeSet<SourceId>,
    current_section: String,
    selected_sections: BTreeSet<String>,
    brace_open: bool,
    source_ordinal: u32,
    land: NativeLandRange,
    used_land_assignment_slots: BTreeSet<u8>,
    rng: RmsRandom,
    rng_draws: Vec<RmsRngDraw>,
    conditionals: Vec<ConditionalFrame>,
    block_comment_depth: u32,
    random_depth: u32,
    elevation_range: bool,
    object_descriptor: bool,
    connection: bool,
    lex_cache: Option<&'a StrictLexCache>,
}

#[derive(Clone, Copy, Debug)]
struct NativeLandRange {
    descriptors: i64,
    start: i64,
    end: i64,
    single: bool,
}

impl NativeLandRange {
    const fn new() -> Self {
        Self {
            descriptors: 0,
            start: -1,
            end: -1,
            single: false,
        }
    }

    fn reset(&mut self) {
        self.start = -1;
        self.end = -1;
    }

    fn valid(&self) -> bool {
        self.start >= 0 && self.end >= 0 && self.end <= self.descriptors
    }

    fn len(&self) -> usize {
        if self.valid() {
            usize::try_from(self.end - self.start).unwrap_or(0)
        } else {
            0
        }
    }

    fn create_land(&mut self) {
        self.descriptors += 1;
        self.start = self.descriptors - 1;
        self.end = self.descriptors;
        self.single = true;
    }

    fn create_player_lands(&mut self, players: usize) {
        self.start = self.descriptors;
        self.descriptors += i64::try_from(players).unwrap_or(i64::MAX);
        self.end = self.descriptors;
        self.single = false;
    }

    fn remove_after_failed_assign_to(&mut self) {
        self.descriptors -= 1;
        self.start -= 1;
        self.end -= 1;
        self.single = false;
    }

    fn remove_after_absent_player(&mut self) {
        self.descriptors -= 1;
        self.single = false;
    }
}

#[derive(Clone, Copy, Debug)]
struct ConditionalFrame {
    parent_active: bool,
    branch_taken: bool,
    active: bool,
}

impl Parser<'_> {
    fn new(
        resolver: Option<&VirtualSourceResolver>,
        mut options: StrictParseOptions,
    ) -> Parser<'_> {
        let rng = RmsRandom::random_map(options.execution_context.seed);
        let definitions: BTreeMap<String, Vec<ResolvedArgument>> = options
            .implicit_definitions
            .iter()
            .map(|(name, value)| {
                (
                    normalize_identifier(name),
                    vec![ResolvedArgument {
                        kind: classify_argument(value),
                        value: normalize_value(value, classify_argument(value)),
                        resolution: ArgumentResolution::Direct,
                    }],
                )
            })
            .collect();
        let numeric_definition_references = definitions
            .iter()
            .filter_map(|(name, values)| {
                values
                    .first()
                    .and_then(|value| value.value.parse::<f32>().ok())
                    .map(|value| (name.clone(), numeric_definition_reference(value)))
            })
            .collect();
        let loaded_sources = std::mem::take(&mut options.preloaded_sources);
        Parser {
            resolver,
            options,
            definitions,
            numeric_definition_references,
            object_group_names: BTreeSet::new(),
            descriptors: Vec::new(),
            decisions: Vec::new(),
            resolved_includes: Vec::new(),
            external_dependencies: Vec::new(),
            source_chain: Vec::new(),
            loaded_sources,
            current_section: String::new(),
            selected_sections: BTreeSet::new(),
            brace_open: false,
            source_ordinal: 0,
            land: NativeLandRange::new(),
            used_land_assignment_slots: BTreeSet::new(),
            rng,
            rng_draws: Vec::new(),
            conditionals: Vec::new(),
            block_comment_depth: 0,
            random_depth: 0,
            elevation_range: false,
            object_descriptor: false,
            connection: false,
            lex_cache: None,
        }
    }

    fn parse(
        mut self,
        entry_path: &str,
        entry_source: SourceText,
    ) -> Result<ParsedProgram, StrictParseError> {
        let entry_id = entry_source.id().clone();
        self.process_source(entry_path, &entry_source, 0)?;
        self.validate_termination()?;
        debug_assert!(
            self.descriptors
                .windows(2)
                .all(|pair| pair[0].source_ordinal < pair[1].source_ordinal)
        );
        let rng_state_after_parser = self.rng.state();
        Ok(ParsedProgram {
            entry_source: entry_id,
            profile: self.options.profile,
            execution_context: self.options.execution_context,
            selected_sections: self.selected_sections.into_iter().collect(),
            descriptors: self.descriptors,
            decisions: self.decisions,
            resolved_includes: self.resolved_includes,
            external_dependencies: self.external_dependencies,
            rng_draws: self.rng_draws,
            rng_state_after_parser,
        })
    }

    fn validate_termination(&self) -> Result<(), StrictParseError> {
        if self.block_comment_depth != 0 {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2024",
                "a block comment is not closed before the end of the script",
                None,
            ));
        }
        Ok(())
    }

    fn process_source(
        &mut self,
        path: &str,
        source: &SourceText,
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        if !self.loaded_sources.insert(source.id().clone()) {
            return Ok(());
        }
        if include_depth > self.options.limits.maximum_include_depth {
            return Err(self.error(
                StrictParseErrorKind::ResourceLimit,
                "RMS2003",
                "include depth exceeds the configured limit",
                None,
            ));
        }
        self.source_chain.push(source.id().clone());

        let statements = match self.lex_cache {
            Some(cache) => cache.statements(source, self.options.limits.lexer),
            None => Arc::new(lex_statements(source, self.options.limits.lexer)),
        };
        if let Some((kind, code, message, range)) = &statements.failure {
            return Err(self.error(*kind, code, message.clone(), Some(*range)));
        }
        let lines = &statements.lines;
        self.process_lines(path, source, lines, 0, lines.len(), include_depth)?;

        self.block_comment_depth = 0;
        self.source_chain.pop();
        Ok(())
    }

    fn process_lines(
        &mut self,
        path: &str,
        source: &SourceText,
        lines: &[Line],
        start: usize,
        end: usize,
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        let mut owned: Option<Vec<Line>> = None;
        let mut index = start;
        let mut end = end;
        while index < end {
            let expansion = {
                let view = owned.as_deref().unwrap_or(lines);
                self.expand_dispatch(&view[index])?
            };
            if let Some(statements) = expansion {
                if owned.is_none() {
                    owned = Some(lines[index..end].to_vec());
                    end -= index;
                    index = 0;
                }
                let vec = owned.as_mut().expect("the range was copied");
                let count = statements.len();
                vec.splice(index..index + 1, statements);
                end = end + count - 1;
                continue;
            }
            let view = owned.as_deref().unwrap_or(lines);
            let line = &view[index];
            if let Some(significant) = &line.suppressed_comment {
                self.consume_suppressed_comment_arguments(significant, line.range)?;
                index += 1;
                continue;
            }
            let was_commented = self.block_comment_depth > 0;
            let mut significant = self.semantic_statement(&line.significant)?;
            if was_commented {
                self.consume_suppressed_comment_arguments(&line.significant, line.range)?;
                index += 1;
                continue;
            }
            if significant.is_empty() {
                index += 1;
                continue;
            }
            if let Some(pending) = &line.pending_numeric_command {
                significant.push(pending.clone());
            }
            let keyword = significant[0].1.clone();
            if keyword == "start_random" {
                if !self.is_active() {
                    index += 1;
                    continue;
                }
                let range = line.range;
                if self.random_block_needs_expansion(view, index + 1, end)? {
                    if owned.is_none() {
                        owned = Some(lines[index..end].to_vec());
                        end -= index;
                        index = 0;
                    }
                    let vec = owned.as_mut().expect("the range was copied");
                    self.expand_random_block(vec, index + 1, &mut end)?;
                }
                let view = owned.as_deref().unwrap_or(lines);
                let random_end = find_random_end(view, index + 1, end).ok_or_else(|| {
                    self.error(
                        StrictParseErrorKind::Preprocessor,
                        "RMS2005",
                        "random block is not terminated",
                        Some(range),
                    )
                })?;
                self.process_random(
                    path,
                    source,
                    view,
                    index + 1,
                    random_end,
                    include_depth,
                    range,
                )?;
                index = random_end + 1;
                continue;
            }
            if keyword == "end_random" || keyword == "percent_chance" {
                if self.is_active()
                    && keyword == "percent_chance"
                    && line.pending_numeric_command.is_none()
                    && significant.len() > 1
                {
                    self.evaluate_numeric_tokens(&significant[1..], line.range)?;
                }
                index += 1;
                continue;
            }
            self.process_line(path, source, line, &significant, include_depth)?;
            index += 1;
        }
        Ok(())
    }

    fn random_block_needs_expansion(
        &self,
        lines: &[Line],
        start: usize,
        end: usize,
    ) -> Result<bool, StrictParseError> {
        let mut depth = 1_u32;
        for line in &lines[start..end] {
            if self.dispatch_words(line)? {
                return Ok(true);
            }
            match line.significant.first().map(|token| token.1.as_str()) {
                Some("start_random") => depth = depth.saturating_add(1),
                Some("end_random") => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Ok(false);
                    }
                }
                _ => {}
            }
        }
        Ok(false)
    }

    fn expand_random_block(
        &self,
        lines: &mut Vec<Line>,
        start: usize,
        end: &mut usize,
    ) -> Result<(), StrictParseError> {
        let mut depth = 1_u32;
        let mut index = start;
        while index < *end {
            if let Some(statements) = self.expand_dispatch(&lines[index])? {
                let count = statements.len();
                lines.splice(index..index + 1, statements);
                *end = *end + count - 1;
                continue;
            }
            match lines[index]
                .significant
                .first()
                .map(|token| token.1.as_str())
            {
                Some("start_random") => depth = depth.saturating_add(1),
                Some("end_random") => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Ok(());
                    }
                }
                _ => {}
            }
            index += 1;
        }
        Ok(())
    }

    fn dispatched_value(&self, word: &str) -> Option<f32> {
        if is_statement_start(word)
            || !self
                .definitions
                .contains_key(normalize_identifier_ref(word))
        {
            return None;
        }
        let expanded = self
            .expand_alias(
                word,
                &mut BTreeSet::new(),
                0,
                ByteRange {
                    start: ByteOffset(0),
                    end: ByteOffset(0),
                },
            )
            .ok()?;
        match expanded.as_slice() {
            [single] => single.value.parse::<f32>().ok(),
            _ => None,
        }
    }

    fn dispatch_words(&self, line: &Line) -> Result<bool, StrictParseError> {
        if line.expanded
            || line.suppressed_comment.is_some()
            || line.pending_numeric_command.is_some()
        {
            return Ok(false);
        }
        let Some((_, head, _)) = line.significant.first() else {
            return Ok(false);
        };
        if is_statement_start(&self.semantic_spelling(head)?) {
            return Ok(false);
        }
        Ok(line
            .significant
            .iter()
            .any(|(_, word, _)| self.dispatched_value(word).is_some()))
    }

    fn expand_dispatch(&self, line: &Line) -> Result<Option<Vec<Line>>, StrictParseError> {
        if !self.dispatch_words(line)? {
            return Ok(None);
        }
        let mut statements = Vec::with_capacity(line.significant.len());
        for token in &line.significant {
            let (significant, dispatched) = match self.dispatched_value(&token.1) {
                Some(value) => match dispatched_statement(value, token.2) {
                    Some(significant) => (significant, true),
                    None => continue,
                },
                None => (vec![token.clone()], false),
            };
            statements.push(Line {
                range: token.2,
                significant,
                pending_numeric_command: None,
                suppressed_comment: None,
                expanded: true,
                dispatched,
            });
        }
        Ok(Some(statements))
    }

    #[allow(clippy::too_many_arguments)]
    fn process_random(
        &mut self,
        path: &str,
        source: &SourceText,
        lines: &[Line],
        start: usize,
        end: usize,
        include_depth: u32,
        range: ByteRange,
    ) -> Result<(), StrictParseError> {
        if self.random_depth >= self.options.limits.maximum_random_nesting {
            return Err(self.error(
                StrictParseErrorKind::ResourceLimit,
                "RMS2041",
                "random blocks are nested deeper than the configured limit",
                Some(range),
            ));
        }
        self.random_depth += 1;
        let result =
            self.process_random_block(path, source, lines, start, end, include_depth, range);
        self.random_depth -= 1;
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn process_random_block(
        &mut self,
        path: &str,
        source: &SourceText,
        lines: &[Line],
        start: usize,
        end: usize,
        include_depth: u32,
        range: ByteRange,
    ) -> Result<(), StrictParseError> {
        let mut prepared = Vec::with_capacity(end - start);
        for line in &lines[start..end] {
            match self.expand_dispatch(line)? {
                Some(statements) => prepared.extend(statements),
                None => prepared.push(line.clone()),
            }
        }
        let (start, end) = (0, prepared.len());
        for line in prepared.iter_mut().take(end).skip(start) {
            let original = line.significant.clone();
            let was_commented = self.block_comment_depth > 0;
            line.significant = self.semantic_statement(&line.significant)?;
            line.expanded = true;
            if was_commented {
                line.suppressed_comment = Some(original);
            }
        }
        let roll = self
            .draw_bounded(100, RmsRngPurpose::ParserRandomBranch)
            .result;
        let branches = random_branches(self, &prepared, start, end)?;
        if branches.is_empty() {
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::RandomBranch,
                values: vec!["none".to_owned(), roll.to_string(), "100".to_owned()],
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        }
        let mut remaining = roll as i32;
        let selected = branches.iter().position(|branch| {
            if remaining <= branch.weight {
                true
            } else {
                remaining = remaining.saturating_sub(branch.weight);
                false
            }
        });
        self.decisions.push(ParsedDecision {
            kind: ParsedDecisionKind::RandomBranch,
            values: vec![
                selected.map_or_else(|| "none".to_owned(), |index| index.to_string()),
                roll.to_string(),
                "100".to_owned(),
            ],
            result: selected.is_some(),
            source_id: source.id().clone(),
            source_range: range,
        });
        for (index, branch) in branches.iter().enumerate() {
            if Some(index) == selected {
                self.process_lines(
                    path,
                    source,
                    &prepared,
                    branch.start,
                    branch.end,
                    include_depth,
                )?;
            } else {
                self.consume_inactive_lines(
                    path,
                    source,
                    &prepared,
                    branch.start,
                    branch.end,
                    include_depth,
                )?;
            }
        }
        Ok(())
    }

    fn consume_inactive_lines(
        &mut self,
        path: &str,
        source: &SourceText,
        lines: &[Line],
        start: usize,
        end: usize,
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        let mut index = start;
        while index < end {
            let line = &lines[index];
            if let Some(significant) = &line.suppressed_comment {
                self.consume_suppressed_comment_arguments(significant, line.range)?;
                index += 1;
                continue;
            }
            let significant = &line.significant;
            let Some(keyword) = significant.first().map(|token| token.1.as_str()) else {
                index += 1;
                continue;
            };

            if keyword == "start_random" && self.is_active() {
                let random_end = find_random_end(lines, index + 1, end).ok_or_else(|| {
                    self.error(
                        StrictParseErrorKind::Preprocessor,
                        "RMS2005",
                        "random block is not terminated",
                        Some(line.range),
                    )
                })?;
                self.process_random(
                    path,
                    source,
                    lines,
                    index + 1,
                    random_end,
                    include_depth,
                    line.range,
                )?;
                index = random_end + 1;
                continue;
            }

            if let Some(command) = find_strict_command(keyword)
                && command.kind == StrictCommandKind::Descriptor
            {
                let _ = self.resolve_command_arguments(
                    command,
                    significant.get(1..).unwrap_or_default(),
                    line.range,
                );
            } else if keyword == "#const" {
                let _ = self
                    .evaluate_numeric_tokens(significant.get(2..).unwrap_or_default(), line.range);
            }
            index += 1;
        }
        Ok(())
    }

    fn consume_suppressed_comment_arguments(
        &mut self,
        tokens: &[(TokenKind, String, ByteRange)],
        range: ByteRange,
    ) -> Result<(), StrictParseError> {
        let Some((_, authored_keyword, _)) = tokens.first() else {
            return Ok(());
        };
        let keyword = self.semantic_spelling(authored_keyword)?;
        let Some(command) = find_strict_command(&keyword) else {
            return Ok(());
        };

        let decision_count = self.decisions.len();
        let _ = self.resolve_command_arguments(command, &tokens[1..], range);
        self.decisions.truncate(decision_count);
        Ok(())
    }

    fn process_line(
        &mut self,
        path: &str,
        source: &SourceText,
        line: &Line,
        significant: &[(TokenKind, String, ByteRange)],
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        if let Some((_, _, range)) = significant
            .iter()
            .find(|(kind, value, _)| *kind == TokenKind::Unknown && value.starts_with('<'))
        {
            return Err(self.error(
                StrictParseErrorKind::Lexical,
                "RMS1003",
                "unterminated or malformed section header",
                Some(*range),
            ));
        }
        if significant[0].0 == TokenKind::Error {
            return self.process_dispatch_marker(source, line.range, &significant[0].1);
        }
        let zeroed;
        let significant = if significant[1..]
            .iter()
            .any(|(kind, value, _)| *kind == TokenKind::Error && value.is_empty())
        {
            if self.is_active()
                && let Some(id) = strict_command_id(&significant[0].1)
            {
                match null_token_slot(id as i32, &self.handler_state()) {
                    NullSlot::Crash(reason) => {
                        return Err(self.dispatched_crash(
                            source,
                            line.range,
                            &significant[0].1,
                            reason,
                        ));
                    }
                    NullSlot::Nothing => return Ok(()),
                    NullSlot::Zero => {}
                }
            }
            zeroed = significant
                .iter()
                .map(|(kind, value, range)| {
                    if *kind == TokenKind::Error && value.is_empty() {
                        (TokenKind::Number, "0".to_owned(), *range)
                    } else {
                        (*kind, value.clone(), *range)
                    }
                })
                .collect::<Vec<_>>();
            &zeroed[..]
        } else {
            significant
        };
        let keyword = significant[0].1.as_str();
        if is_conditional_keyword(keyword) {
            return self.process_conditional(source, line.range, significant);
        }
        if !self.is_active() {
            if let Some(command) = find_strict_command(keyword)
                && command.kind == StrictCommandKind::Descriptor
            {
                let _ = self.resolve_command_arguments(command, &significant[1..], line.range);
            } else if keyword == "#const" {
                let _ = self.evaluate_numeric_tokens(&significant[2..], line.range);
            }
            return Ok(());
        }
        if matches!(keyword, "#include" | "#include_drs" | "#includeXS") {
            return self.process_include(path, source, line.range, significant, include_depth);
        }
        if matches!(keyword, "#define" | "#const" | "#undefine") {
            return self.process_definition(source, line.range, significant);
        }

        let Some(command) = find_strict_command(keyword) else {
            return Ok(());
        };
        if let StrictCommandKind::Section(section) = command.kind {
            self.current_section = section.to_owned();
            self.selected_sections.insert(section.to_owned());
            match section {
                "land_generation" => self.land.reset(),
                "connection_generation" => self.connection = false,
                "elevation_generation" => self.elevation_range = false,
                _ => {}
            }
            return Ok(());
        }
        if keyword == "{" {
            self.brace_open = true;
            return Ok(());
        }
        if keyword == "}" {
            self.brace_open = false;
            return Ok(());
        }
        if command.kind != StrictCommandKind::Descriptor {
            return Ok(());
        }
        let name = command.name.to_owned();
        if let Some(id) = strict_command_id(&name)
            && crashes_in_connection_block(
                id as i32,
                first_slot_is_not_a_token(command),
                &self.handler_state(),
            )
        {
            return Err(self.error(
                StrictParseErrorKind::Syntax,
                GAME_CRASH_CODE,
                format!(
                    "The game crashes on this script: inside a connection block it reads a terrain from every command, and {name} has none. Move {name} out of the block."
                ),
                Some(line.range),
            ));
        }
        if line.dispatched
            && !self.brace_open
            && !is_global_descriptor_command(&name)
            && !section_rules(&self.current_section).is_some_and(|rules| rules.contains(&name))
        {
            return Ok(());
        }
        let arguments = self.resolve_command_arguments(command, &significant[1..], line.range)?;
        self.track_handler_state(&name, &arguments);
        if let Some(metadata) = find_command(&self.current_section, &name) {
            let count = arguments.len();
            let rejected = arguments.iter().any(|argument| {
                matches!(
                    argument.resolution,
                    ArgumentResolution::UndefinedNumericFallback
                        | ArgumentResolution::UnparsedAfterRejection
                        | ArgumentResolution::UnregisteredNumber
                )
            });
            let native_omitted_argument = count == 0
                && matches!(
                    name.as_str(),
                    "spacing_to_other_terrain_types" | "avoid_actor_area"
                );
            if !rejected
                && (count < metadata.minimum_arguments as usize
                    || count > metadata.maximum_arguments as usize)
                && !native_omitted_argument
            {
                return Err(self.error(
                    StrictParseErrorKind::Syntax,
                    "RMS2010",
                    format!(
                        "{} expects {} to {} arguments, received {count}",
                        metadata.name, metadata.minimum_arguments, metadata.maximum_arguments
                    ),
                    Some(line.range),
                ));
            }
        }
        if self.descriptors.len() as u32 >= self.options.limits.maximum_descriptors {
            return Err(self.error(
                StrictParseErrorKind::ResourceLimit,
                "RMS2011",
                "descriptor count exceeds the configured limit",
                Some(line.range),
            ));
        }
        if self.current_section == "objects_generation"
            && name == "create_object_group"
            && !arguments.iter().any(|argument| {
                matches!(
                    argument.resolution,
                    ArgumentResolution::UndefinedNumericFallback
                        | ArgumentResolution::UnparsedAfterRejection
                        | ArgumentResolution::UnregisteredNumber
                )
            })
        {
            let Some(group_name) = arguments.first().filter(|argument| {
                argument.kind == ArgumentKind::Identifier
                    && argument.resolution == ArgumentResolution::Direct
            }) else {
                return Err(self.error(
                    StrictParseErrorKind::Syntax,
                    "RMS2033",
                    "create_object_group requires a direct label",
                    Some(line.range),
                ));
            };
            self.object_group_names.insert(group_name.value.clone());
        }
        let mut parser_effect_rng_draws = Vec::new();
        if self.current_section == "land_generation" && self.brace_open && self.land.valid() {
            if name == "assign_to"
                && self.land.single
                && arguments.iter().all(|argument| {
                    !matches!(
                        argument.resolution,
                        ArgumentResolution::UndefinedNumericFallback
                            | ArgumentResolution::UnparsedAfterRejection
                    )
                })
            {
                let (draws, assigned) =
                    self.resolve_land_assignment_effect(&arguments, line.range)?;
                parser_effect_rng_draws = draws;
                if !assigned {
                    self.land.remove_after_failed_assign_to();
                }
            } else if name == "assign_to_player" && self.land.single {
                if let Some(value) = arguments
                    .first()
                    .and_then(|argument| argument.value.parse::<f32>().ok())
                    .filter(|value| value.is_finite())
                    .map(f32::round)
                    && (1.0..=9.0).contains(&value)
                    && !self
                        .options
                        .execution_context
                        .players
                        .iter()
                        .any(|player| f32::from(player.slot) == value)
                {
                    self.land.remove_after_absent_player();
                }
            } else if name == "set_zone_randomly" && self.land.len() > 0 {
                let descriptor_count = self.land.len();
                let upper_exclusive = u32::try_from(self.options.execution_context.players.len())
                    .map_err(|_| {
                    self.error(
                        StrictParseErrorKind::ResourceLimit,
                        "RMS2035",
                        "player count exceeds the land-zone RNG range",
                        Some(line.range),
                    )
                })?;
                if upper_exclusive == 0 {
                    return Err(self.error(
                        StrictParseErrorKind::Preprocessor,
                        "RMS2036",
                        "set_zone_randomly requires an active player",
                        Some(line.range),
                    ));
                }
                for _ in 0..descriptor_count {
                    let purpose = RmsRngPurpose::LandZoneRandomization;
                    let sample = self.draw_bounded(upper_exclusive, purpose);
                    parser_effect_rng_draws.push(RmsRngDraw { purpose, sample });
                }
            }
        }
        self.descriptors.push(ParsedDescriptor {
            section: self.current_section.clone(),
            name,
            arguments,
            depth: u32::from(self.brace_open),
            source_id: source.id().clone(),
            source_range: line.range,
            include_chain: self.source_chain.clone(),
            source_ordinal: self.source_ordinal,
            parser_effect_rng_draws,
        });
        self.source_ordinal = self.source_ordinal.saturating_add(1);
        Ok(())
    }

    fn process_include(
        &mut self,
        path: &str,
        source: &SourceText,
        range: ByteRange,
        tokens: &[(TokenKind, String, ByteRange)],
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        let pushed_back = tokens.get(1).is_some_and(|(_, word, _)| {
            is_statement_start(word) && !command_word_pushback_disabled_for_attribution()
        });
        let (_, name) = include_filename_words(tokens.get(1..).unwrap_or_default());
        let Some(raw_path) = name.filter(|_| !pushed_back) else {
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::MissingIncludeFallback,
                values: vec![
                    tokens
                        .get(1)
                        .map_or_else(String::new, |(_, value, _)| value.clone()),
                ],
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        };
        let include = IncludePath::new(raw_path)
            .map_err(|diagnostic| self.resolution_error(diagnostic, Some(range)))?;
        let resolver = self.resolver.ok_or_else(|| {
            self.error(
                StrictParseErrorKind::Resolution,
                "RMS2012",
                "include cannot be resolved without a source catalog",
                Some(range),
            )
        })?;
        let external_xs = tokens.first().is_some_and(|token| token.1 == "#includeXS");
        let resolution = if external_xs {
            resolver.resolve_external_xs(path, &include, &self.source_chain)
        } else {
            resolver.resolve(path, &include, &self.source_chain)
        };
        let resolved = match resolution {
            Ok(resolved) => resolved,
            Err(diagnostic)
                if !external_xs && diagnostic.kind == ResolutionDiagnosticKind::Missing =>
            {
                self.decisions.push(ParsedDecision {
                    kind: ParsedDecisionKind::MissingIncludeFallback,
                    values: vec![include.as_str().to_owned()],
                    result: false,
                    source_id: source.id().clone(),
                    source_range: range,
                });
                return Ok(());
            }
            Err(diagnostic) => {
                return Err(self.resolution_error(diagnostic, Some(range)));
            }
        };
        if let Some(diagnostic) = resolved.ambiguity_diagnostic(&self.source_chain) {
            return Err(self.resolution_error(diagnostic, Some(range)));
        }
        self.decisions.push(ParsedDecision {
            kind: ParsedDecisionKind::Include,
            values: vec![resolved.selected.source.id().as_str().to_owned()],
            result: true,
            source_id: source.id().clone(),
            source_range: range,
        });
        if external_xs {
            self.external_dependencies
                .push(resolved.selected.source.id().clone());
            Ok(())
        } else {
            self.resolved_includes
                .push(resolved.selected.source.id().clone());
            self.process_virtual_source(resolved.selected, include_depth + 1)
        }
    }

    fn process_virtual_source(
        &mut self,
        source: VirtualSource,
        include_depth: u32,
    ) -> Result<(), StrictParseError> {
        self.process_source(&source.path, &source.source, include_depth)
    }

    fn process_definition(
        &mut self,
        source: &SourceText,
        range: ByteRange,
        tokens: &[(TokenKind, String, ByteRange)],
    ) -> Result<(), StrictParseError> {
        let name = tokens.get(1).filter(|name| {
            !is_statement_start(&name.1) || command_word_pushback_disabled_for_attribution()
        });
        let Some(name) = name else {
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::Definition,
                values: Vec::new(),
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        };
        if name.0 != TokenKind::Identifier {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2014",
                "definition symbol must be an identifier",
                Some(name.2),
            ));
        }
        if tokens[0].1 == "#undefine" {
            let existing = self
                .definitions
                .get(&normalize_identifier(&name.1))
                .cloned()
                .unwrap_or_default();
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::Redefinition,
                values: existing.iter().map(|value| value.value.clone()).collect(),
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        }
        if tokens[0].1 == "#const"
            && tokens
                .get(2)
                .is_none_or(|token| is_statement_start(&token.1))
        {
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::Definition,
                values: Vec::new(),
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        }
        if self.definitions.len() as u32 >= self.options.limits.maximum_definitions
            && !self
                .definitions
                .contains_key(&normalize_identifier(&name.1))
        {
            return Err(self.error(
                StrictParseErrorKind::ResourceLimit,
                "RMS2015",
                "definition count exceeds the configured limit",
                Some(range),
            ));
        }
        let (values, numeric_value) = if tokens[0].1 == "#define" {
            (
                vec![ResolvedArgument {
                    kind: ArgumentKind::Number,
                    value: "0".to_owned(),
                    resolution: ArgumentResolution::Direct,
                }],
                0.0,
            )
        } else {
            let value = self.evaluate_numeric_tokens(&tokens[2..], range)?;
            (
                vec![ResolvedArgument {
                    kind: ArgumentKind::Number,
                    value: canonical_number(value),
                    resolution: ArgumentResolution::Direct,
                }],
                value,
            )
        };
        let key = normalize_identifier(&name.1);
        let redefined = self.definitions.contains_key(&key);
        if !redefined {
            self.definitions.insert(key.clone(), values.clone());
            self.numeric_definition_references
                .insert(key, numeric_definition_reference(numeric_value));
        }
        self.decisions.push(ParsedDecision {
            kind: if redefined {
                ParsedDecisionKind::Redefinition
            } else {
                ParsedDecisionKind::Definition
            },
            values: values.iter().map(|value| value.value.clone()).collect(),
            result: !redefined,
            source_id: source.id().clone(),
            source_range: range,
        });
        Ok(())
    }

    fn process_conditional(
        &mut self,
        source: &SourceText,
        range: ByteRange,
        tokens: &[(TokenKind, String, ByteRange)],
    ) -> Result<(), StrictParseError> {
        let keyword = tokens[0].1.as_str();
        if keyword == "endif" {
            if self.conditionals.pop().is_none() {
                return Ok(());
            }
            return Ok(());
        }
        let command_operand = tokens
            .get(1)
            .filter(|(_, value, _)| is_statement_start(value))
            .map(|(_, value, _)| value.clone());
        if let Some(command) = command_operand.clone()
            && matches!(keyword, "if" | "elseif")
            && self.is_active()
        {
            if keyword == "elseif" && self.conditionals.is_empty() {
                return Ok(());
            }
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::Conditional,
                values: vec![keyword.to_owned(), command],
                result: false,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        }
        if matches!(keyword, "else" | "elseif") {
            let Some(previous) = self.conditionals.pop() else {
                return Ok(());
            };
            let condition = if keyword == "elseif" {
                command_operand.is_some() || self.evaluate_condition(&tokens[1..], range)?
            } else {
                true
            };
            let active = previous.parent_active && !previous.branch_taken && condition;
            self.conditionals.push(ConditionalFrame {
                parent_active: previous.parent_active,
                branch_taken: previous.branch_taken || active,
                active,
            });
            self.decisions.push(ParsedDecision {
                kind: ParsedDecisionKind::Conditional,
                values: vec![keyword.to_owned()],
                result: active,
                source_id: source.id().clone(),
                source_range: range,
            });
            return Ok(());
        }

        let parent_active = self.is_active();
        let result = self.evaluate_condition(&tokens[1..], range)?;
        let active = parent_active && result;
        self.conditionals.push(ConditionalFrame {
            parent_active,
            branch_taken: active,
            active,
        });
        let resolved = tokens
            .get(1)
            .and_then(|(_, value, _)| self.definitions.get(&normalize_identifier(value)))
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.value.clone())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        self.decisions.push(ParsedDecision {
            kind: ParsedDecisionKind::Conditional,
            values: vec![keyword.to_owned(), resolved],
            result: active,
            source_id: source.id().clone(),
            source_range: range,
        });
        Ok(())
    }

    fn evaluate_condition(
        &self,
        tokens: &[(TokenKind, String, ByteRange)],
        range: ByteRange,
    ) -> Result<bool, StrictParseError> {
        let Some(first) = tokens.first() else {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2018",
                "conditional expression is missing",
                Some(range),
            ));
        };
        if tokens.len() != 1 {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2019",
                "conditional expects exactly one defined token",
                Some(range),
            ));
        }
        Ok(self.definitions.contains_key(first.1.as_str()))
    }

    fn resolve_command_arguments(
        &mut self,
        command: &StrictCommand,
        tokens: &[(TokenKind, String, ByteRange)],
        range: ByteRange,
    ) -> Result<Vec<ResolvedArgument>, StrictParseError> {
        let mut result = Vec::new();
        let mut cursor = 0;
        let mut rejected = false;
        for expected in command.arguments {
            if rejected {
                if let Some(argument) = unparsed_argument(*expected, tokens, &mut cursor) {
                    result.push(argument);
                }
                continue;
            }
            if cursor >= tokens.len() {
                if *expected == StrictArgumentKind::TolerantNumber
                    || (*expected == StrictArgumentKind::Number
                        && matches!(
                            command.name,
                            "spacing_to_other_terrain_types" | "avoid_actor_area"
                        ))
                {
                    continue;
                }
                return Err(self.error(
                    StrictParseErrorKind::Syntax,
                    "RMS2027",
                    format!("{} is missing a required argument", command.name),
                    Some(range),
                ));
            }
            match expected {
                StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => {
                    if is_statement_start(&tokens[cursor].1) {
                        if *expected == StrictArgumentKind::TolerantNumber
                            || matches!(
                                command.name,
                                "spacing_to_other_terrain_types" | "avoid_actor_area"
                            )
                        {
                            break;
                        }
                        result.push(ResolvedArgument {
                            kind: ArgumentKind::Number,
                            value: tokens[cursor].1.clone(),
                            resolution: ArgumentResolution::UnparsedAfterRejection,
                        });
                        break;
                    }
                    let count = numeric_token_count(&tokens[cursor..]);
                    let decision_start = self.decisions.len();
                    let numeric = self.evaluate_numeric_tokens(
                        &tokens[cursor..cursor.saturating_add(count)],
                        range,
                    );
                    match numeric {
                        Ok(value) => result.push(ResolvedArgument {
                            kind: ArgumentKind::Number,
                            value: canonical_number(value),
                            resolution: if self.decisions[decision_start..].iter().any(|decision| {
                                decision.kind == ParsedDecisionKind::UndefinedNumericFallback
                            }) {
                                ArgumentResolution::UndefinedNumericFallback
                            } else {
                                ArgumentResolution::Direct
                            },
                        }),
                        Err(_) if *expected == StrictArgumentKind::TolerantNumber => break,
                        Err(error) => return Err(error),
                    }
                    cursor = cursor.saturating_add(count);
                }
                StrictArgumentKind::Label | StrictArgumentKind::Token
                    if is_statement_start(&tokens[cursor].1)
                        && !command_word_pushback_disabled_for_attribution() =>
                {
                    result.push(ResolvedArgument {
                        kind: ArgumentKind::Identifier,
                        value: tokens[cursor].1.clone(),
                        resolution: ArgumentResolution::UnparsedAfterRejection,
                    });
                    break;
                }
                StrictArgumentKind::Label | StrictArgumentKind::Path => {
                    let kind = if *expected == StrictArgumentKind::Path {
                        ArgumentKind::String
                    } else {
                        ArgumentKind::Identifier
                    };
                    result.push(ResolvedArgument {
                        kind,
                        value: normalize_value(&tokens[cursor].1, kind),
                        resolution: ArgumentResolution::Direct,
                    });
                    cursor += 1;
                }
                StrictArgumentKind::Token => {
                    let raw = &tokens[cursor].1;
                    let normalized = normalize_identifier(raw);
                    let unregistered_number = (raw.parse::<f32>().is_ok()
                        && !number_name_rule_disabled_for_attribution()
                        || raw.starts_with("rnd("))
                        && !self.definitions.contains_key(&normalized)
                        && self.options.undefined_numeric_values_are_zero;
                    let unregistered_word = !unregistered_number
                        && raw.parse::<f32>().is_err()
                        && !raw.starts_with("rnd(")
                        && !self.definitions.contains_key(&normalized)
                        && self.options.undefined_numeric_values_are_zero
                        && !word_name_rule_disabled_for_attribution()
                        && !self.token_word_converts_to_zero(raw);
                    if self.is_active()
                        && matches!(command.name, "create_object" | "second_object")
                        && !self.definitions.contains_key(&normalized)
                        && (raw.parse::<f32>().is_err() || unregistered_number)
                        && self.object_group_names.contains(&normalized)
                    {
                        result.push(ResolvedArgument {
                            kind: ArgumentKind::Identifier,
                            value: normalized,
                            resolution: ArgumentResolution::ObjectGroupReference,
                        });
                    } else if unregistered_number || unregistered_word {
                        rejected = true;
                        result.push(ResolvedArgument {
                            kind: if unregistered_number {
                                ArgumentKind::Number
                            } else {
                                token_argument_kind(tokens[cursor].0)
                            },
                            value: normalized,
                            resolution: ArgumentResolution::UnregisteredNumber,
                        });
                    } else if raw.parse::<f32>().is_ok()
                        || self.definitions.contains_key(&normalize_identifier(raw))
                        || self.options.undefined_numeric_values_are_zero
                    {
                        let decision_start = self.decisions.len();
                        let value = self.evaluate_numeric_atom(raw, range)?;
                        let undefined = self.decisions[decision_start..].iter().any(|decision| {
                            decision.kind == ParsedDecisionKind::UndefinedNumericFallback
                        });
                        rejected = undefined;
                        result.push(ResolvedArgument {
                            kind: ArgumentKind::Number,
                            value: canonical_number(value),
                            resolution: if raw.parse::<f32>().is_ok() {
                                ArgumentResolution::Direct
                            } else if self.definitions.contains_key(&normalize_identifier(raw)) {
                                ArgumentResolution::DefinedIdentifier
                            } else if undefined {
                                ArgumentResolution::UndefinedNumericFallback
                            } else {
                                unreachable!(
                                    "undefined numeric resolution must record its decision"
                                )
                            },
                        });
                    } else {
                        result.push(ResolvedArgument {
                            kind: token_argument_kind(tokens[cursor].0),
                            value: normalize_identifier(raw),
                            resolution: ArgumentResolution::Direct,
                        });
                    }
                    cursor += 1;
                }
                StrictArgumentKind::Condition => {
                    let value = &tokens[cursor].1;
                    let mut expanded = self.expand_alias(value, &mut BTreeSet::new(), 0, range)?;
                    if expanded.is_empty() {
                        expanded.push(ResolvedArgument {
                            kind: token_argument_kind(tokens[cursor].0),
                            value: normalize_identifier(value),
                            resolution: ArgumentResolution::Direct,
                        });
                    }
                    result.extend(expanded);
                    cursor += 1;
                }
            }
        }
        Ok(result)
    }

    fn evaluate_numeric_tokens(
        &mut self,
        tokens: &[(TokenKind, String, ByteRange)],
        range: ByteRange,
    ) -> Result<f32, StrictParseError> {
        if tokens.is_empty() {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2028",
                "numeric expression is missing",
                Some(range),
            ));
        }
        let mut parts = tokens
            .iter()
            .map(|(_, value, _)| value.clone())
            .collect::<Vec<_>>();
        if parts[0].starts_with('(') {
            parts[0] = parts[0].trim_start_matches('(').to_owned();
            let Some(last) = parts.last_mut() else {
                unreachable!();
            };
            if !last.ends_with(')') {
                return Err(self.error(
                    StrictParseErrorKind::Preprocessor,
                    "RMS2029",
                    "numeric expression is missing its closing parenthesis",
                    Some(range),
                ));
            }
            *last = last.trim_end_matches(')').to_owned();
        }
        if parts.is_empty() || parts.len().is_multiple_of(2) {
            return Err(self.error(
                StrictParseErrorKind::Preprocessor,
                "RMS2030",
                "numeric expression must alternate values and operators",
                Some(range),
            ));
        }
        let mut value = self.evaluate_numeric_atom_with(&parts[0], range, true, true)?;
        for pair in parts[1..].chunks_exact(2) {
            let right = self.evaluate_numeric_atom_with(&pair[1], range, true, false)?;
            value = match pair[0].as_str() {
                "+" => value + right,
                "-" => value - right,
                "/" if value == 0.0 || right == 0.0 => 0.0,
                "/" => value / right,
                "*" => value * right,
                "%" => {
                    let left = value as i32;
                    let right = right as i32;
                    if left == 0 || right == 0 {
                        left as f32
                    } else {
                        left.checked_rem(right).unwrap_or(0) as f32
                    }
                }
                _ => {
                    return Err(self.error(
                        StrictParseErrorKind::Preprocessor,
                        "RMS2031",
                        format!("unsupported numeric operator {}", pair[0]),
                        Some(range),
                    ));
                }
            };
        }
        Ok(value)
    }

    fn evaluate_numeric_atom(
        &mut self,
        atom: &str,
        range: ByteRange,
    ) -> Result<f32, StrictParseError> {
        self.evaluate_numeric_atom_with(atom, range, false, true)
    }

    fn evaluate_numeric_atom_with(
        &mut self,
        atom: &str,
        range: ByteRange,
        atof_prefix: bool,
        allow_random: bool,
    ) -> Result<f32, StrictParseError> {
        let (unsigned, negative, signs) = strip_atom_signs(atom);
        if (!allow_random || unsigned.len() != atom.len()) && unsigned.starts_with("rnd(") {
            if self.options.undefined_numeric_values_are_zero && atof_prefix {
                self.record_undefined_numeric_fallback(atom, range, "0".to_owned())?;
                return Ok(0.0);
            }
            return Err(self.numeric_atom_error(atom, range));
        }
        if unsigned.len() != atom.len() {
            return self
                .evaluate_numeric_atom_with(unsigned, range, atof_prefix && signs == 1, false)
                .map(|value| if negative { -value } else { value });
        }
        if let Some(arguments) = atom
            .strip_prefix("rnd(")
            .and_then(|value| value.strip_suffix(')'))
        {
            let Some((minimum, maximum)) = arguments.split_once(',') else {
                return Err(self.numeric_atom_error(atom, range));
            };
            let minimum = minimum
                .parse::<i32>()
                .map_err(|_| self.numeric_atom_error(atom, range))?;
            let maximum = maximum
                .parse::<i32>()
                .map_err(|_| self.numeric_atom_error(atom, range))?;
            let width = i64::from(maximum)
                .checked_sub(i64::from(minimum))
                .and_then(|value| value.checked_add(1))
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| self.numeric_atom_error(atom, range))?;
            let sample = self.draw_bounded(width, RmsRngPurpose::ParserNumericRange);
            let result = i64::from(minimum) + i64::from(sample.result);
            let result = i32::try_from(result).map_err(|_| self.numeric_atom_error(atom, range))?;
            return Ok(result as f32);
        }
        let normalized = normalize_identifier(atom);
        if self.definitions.contains_key(&normalized) {
            return self
                .numeric_definition_references
                .get(&normalized)
                .copied()
                .ok_or_else(|| self.numeric_atom_error(atom, range));
        }
        match atom.parse::<f32>() {
            Ok(value) => Ok(value),
            Err(_)
                if self.options.undefined_numeric_values_are_zero
                    && undefined_atom_converts_to_zero(atom) =>
            {
                self.record_undefined_numeric_fallback(atom, range, "0".to_owned())?;
                Ok(0.0)
            }
            Err(_) if self.options.undefined_numeric_values_are_zero && atof_prefix => {
                let value = undefined_atom_decimal_prefix(atom)
                    .ok_or_else(|| self.numeric_atom_error(atom, range))?;
                self.record_undefined_numeric_fallback(atom, range, canonical_number(value))?;
                Ok(value)
            }
            Err(_) => Err(self.numeric_atom_error(atom, range)),
        }
    }

    fn token_word_converts_to_zero(&self, raw: &str) -> bool {
        let (unsigned, _, signs) = strip_atom_signs(raw);
        (signs == 0
            || !unsigned.starts_with("rnd(")
                && !self
                    .definitions
                    .contains_key(&normalize_identifier(unsigned))
                && unsigned.parse::<f32>().is_err())
            && undefined_atom_converts_to_zero(unsigned)
    }

    fn record_undefined_numeric_fallback(
        &mut self,
        atom: &str,
        range: ByteRange,
        converted: String,
    ) -> Result<(), StrictParseError> {
        let Some(source_id) = self.source_chain.last().cloned() else {
            return Err(self.numeric_atom_error(atom, range));
        };
        self.decisions.push(ParsedDecision {
            kind: ParsedDecisionKind::UndefinedNumericFallback,
            values: vec![normalize_identifier(atom), converted],
            result: false,
            source_id,
            source_range: range,
        });
        Ok(())
    }

    fn draw_bounded(&mut self, upper_exclusive: u32, purpose: RmsRngPurpose) -> RmsRngSample {
        let sample = self.rng.bounded(upper_exclusive);
        self.rng_draws.push(RmsRngDraw { purpose, sample });
        sample
    }

    fn resolve_land_assignment_effect(
        &mut self,
        arguments: &[ResolvedArgument],
        range: ByteRange,
    ) -> Result<(Vec<RmsRngDraw>, bool), StrictParseError> {
        let value = |index: usize| -> Result<i32, StrictParseError> {
            let argument = arguments.get(index).ok_or_else(|| {
                self.error(
                    StrictParseErrorKind::Syntax,
                    "RMS2037",
                    "assign_to is missing a selector argument",
                    Some(range),
                )
            })?;
            let value = argument.value.parse::<f32>().map_err(|_| {
                self.error(
                    StrictParseErrorKind::Preprocessor,
                    "RMS2038",
                    "assign_to selector is not numeric",
                    Some(range),
                )
            })?;
            if !value.is_finite() || value < i32::MIN as f32 || value > i32::MAX as f32 {
                return Err(self.error(
                    StrictParseErrorKind::Preprocessor,
                    "RMS2039",
                    "assign_to selector exceeds its fixed-width range",
                    Some(range),
                ));
            }
            Ok(value.round() as i32)
        };

        let mode = arguments
            .first()
            .and_then(|argument| argument.value.parse::<f32>().ok())
            .filter(|mode| mode.is_finite() && *mode >= i32::MIN as f32 && *mode <= i32::MAX as f32)
            .map_or(0, |mode| mode.trunc() as i32);
        let selector = value(1)?;
        let first_eligible = value(2)? != 0;
        let reuse = value(3)?;
        let mut players = self.options.execution_context.players.clone();
        players.sort_by_key(|player| player.slot);
        let team_values = compact_team_selector_values(&players);
        let accepts_used = reuse == 1;
        let mut candidates = Vec::new();
        match mode {
            1 | 2 => {}
            _ => {
                if selector >= 0
                    && selector <= players.len() as i32
                    && (accepts_used
                        || !self.used_land_assignment_slots.contains(&(selector as u8)))
                {
                    candidates.push(selector as u8);
                }
            }
        }
        match mode {
            2 => {
                let excluded = selector.checked_neg();
                for (player, team) in players.iter().zip(team_values) {
                    let selector_matches = if selector < 0 {
                        Some(team) != excluded
                    } else {
                        team == selector
                    };
                    if selector_matches
                        && (accepts_used || !self.used_land_assignment_slots.contains(&player.slot))
                    {
                        candidates.push(player.slot);
                    }
                }
            }
            1 => {
                if let Some(player) = players.iter().find(|player| {
                    i32::from(player.color) + 1 == selector
                        && (accepts_used || !self.used_land_assignment_slots.contains(&player.slot))
                }) {
                    candidates.push(player.slot);
                }
            }
            _ => {}
        }

        let mut draws = Vec::new();
        let selected = if mode != 2 || first_eligible {
            candidates.first().copied()
        } else if !candidates.is_empty() {
            let upper_exclusive = u32::try_from(candidates.len()).map_err(|_| {
                self.error(
                    StrictParseErrorKind::ResourceLimit,
                    "RMS2040",
                    "assign_to candidate count exceeds its RNG range",
                    Some(range),
                )
            })?;
            let purpose = RmsRngPurpose::LandAssignmentSelection;
            let sample = self.draw_bounded(upper_exclusive, purpose);
            draws.push(RmsRngDraw { purpose, sample });
            candidates.get(sample.result as usize).copied()
        } else {
            None
        };
        if let Some(slot) = selected.filter(|_| reuse != 2) {
            self.used_land_assignment_slots.insert(slot);
        }
        let assigned = selected
            .is_some_and(|slot| slot == 0 || players.iter().any(|player| player.slot == slot));
        Ok((draws, assigned))
    }

    fn numeric_atom_error(&self, atom: &str, range: ByteRange) -> StrictParseError {
        self.error(
            StrictParseErrorKind::Preprocessor,
            "RMS2032",
            format!("{atom} is not a defined numeric value"),
            Some(range),
        )
    }

    fn semantic_statement(
        &mut self,
        tokens: &[(TokenKind, String, ByteRange)],
    ) -> Result<Vec<(TokenKind, String, ByteRange)>, StrictParseError> {
        let head_reads_operands = match tokens.first() {
            Some((_, head, _)) => find_strict_command(&self.semantic_spelling(head)?)
                .is_some_and(|command| !command.arguments.is_empty()),
            None => false,
        };
        let mut result = Vec::with_capacity(tokens.len());
        for (position, (kind, value, range)) in tokens.iter().enumerate() {
            let dispatched = position == 0 || !head_reads_operands;
            let delimiter = if dispatched && self.options.lexical_profile.block_comments {
                self.definition_comment_delimiter(value)
            } else {
                None
            };
            if self.block_comment_depth > 0 {
                let semantic = self.semantic_spelling(value)?;
                if self.options.lexical_profile.block_comments {
                    if semantic == "/*" || delimiter == Some(CommentDelimiter::Open) {
                        self.block_comment_depth = self.block_comment_depth.saturating_add(1);
                    }
                    if semantic == "*/" || delimiter == Some(CommentDelimiter::Close) {
                        self.block_comment_depth = self.block_comment_depth.saturating_sub(1);
                    }
                }
                continue;
            }
            let semantic = if result.is_empty() {
                self.semantic_spelling(value)?
            } else {
                value.clone()
            };
            if self.options.lexical_profile.block_comments
                && (semantic == "/*" || delimiter == Some(CommentDelimiter::Open))
            {
                self.block_comment_depth = 1;
                continue;
            }
            if self.options.lexical_profile.block_comments
                && (semantic == "*/" || delimiter == Some(CommentDelimiter::Close))
            {
                continue;
            }
            if *kind == TokenKind::Unknown && !value.starts_with('<') {
                return Err(self.error(
                    StrictParseErrorKind::Lexical,
                    "RMS1006",
                    "the script contains a control character the preview cannot read",
                    Some(*range),
                ));
            }
            if result.is_empty() {
                result.push((semantic_token_kind(&semantic, *kind), semantic, *range));
            } else {
                result.push((*kind, value.clone(), *range));
            }
        }
        Ok(result)
    }

    fn definition_comment_delimiter(&self, value: &str) -> Option<CommentDelimiter> {
        let expanded = self
            .expand_alias(
                value,
                &mut BTreeSet::new(),
                0,
                ByteRange {
                    start: ByteOffset(0),
                    end: ByteOffset(0),
                },
            )
            .ok()?;
        let [single] = expanded.as_slice() else {
            return None;
        };
        match single.value.parse::<f64>().ok()? {
            69.0 => Some(CommentDelimiter::Open),
            70.0 => Some(CommentDelimiter::Close),
            _ => None,
        }
    }

    fn semantic_spelling(&self, value: &str) -> Result<String, StrictParseError> {
        let expanded = self.expand_alias(
            value,
            &mut BTreeSet::new(),
            0,
            ByteRange {
                start: ByteOffset(0),
                end: ByteOffset(0),
            },
        )?;
        let resolved = if expanded.len() == 1 {
            expanded[0].value.as_str()
        } else {
            value
        };
        Ok(resolved
            .parse::<i64>()
            .ok()
            .and_then(|identity| self.options.semantic_token_aliases.get(&identity))
            .cloned()
            .unwrap_or_else(|| resolved.to_owned()))
    }

    fn expand_alias(
        &self,
        value: &str,
        active: &mut BTreeSet<String>,
        depth: u32,
        range: ByteRange,
    ) -> Result<Vec<ResolvedArgument>, StrictParseError> {
        let Some(values) = self.definitions.get(normalize_identifier_ref(value)) else {
            return Ok(Vec::new());
        };
        let name = normalize_identifier(value);
        if depth >= self.options.limits.maximum_alias_expansion || !active.insert(name.clone()) {
            return Err(self.error(
                StrictParseErrorKind::ResourceLimit,
                "RMS2020",
                "definition alias expansion is cyclic or exceeds its configured limit",
                Some(range),
            ));
        }
        let mut expanded = Vec::new();
        for value in values {
            if value.kind == ArgumentKind::Identifier {
                let nested = self.expand_alias(&value.value, active, depth + 1, range)?;
                if nested.is_empty() {
                    expanded.push(value.clone());
                } else {
                    expanded.extend(nested);
                }
            } else {
                let mut value = value.clone();
                value.resolution = ArgumentResolution::DefinedIdentifier;
                expanded.push(value);
            }
        }
        active.remove(&name);
        Ok(expanded)
    }

    fn is_active(&self) -> bool {
        self.conditionals.last().is_none_or(|frame| frame.active)
    }

    fn handler_state(&self) -> HandlerState<'_> {
        HandlerState {
            section: &self.current_section,
            brace_open: self.brace_open,
            land_range: self.land.valid() && self.land.start < self.land.end,
            land_range_from_create_land: self.land.valid() && self.land.single,
            elevation_range: self.elevation_range,
            object_descriptor: self.object_descriptor,
            connection: self.connection,
        }
    }

    fn track_handler_state(&mut self, name: &str, arguments: &[ResolvedArgument]) {
        if self.brace_open {
            return;
        }
        match (self.current_section.as_str(), name) {
            ("land_generation", "create_land") => self.land.create_land(),
            ("land_generation", "create_player_lands") => self
                .land
                .create_player_lands(self.options.execution_context.players.len()),
            ("elevation_generation", "create_elevation") => {
                self.elevation_range = arguments
                    .first()
                    .and_then(|argument| argument.value.parse::<f32>().ok())
                    .is_some_and(|value| value.round() > 0.0);
            }
            ("objects_generation", "create_object") => self.object_descriptor = true,
            (
                "connection_generation",
                "create_connect_all_players_land"
                | "create_connect_teams_lands"
                | "create_connect_same_land_zones"
                | "create_connect_all_lands"
                | "create_connect_to_nonplayer_land"
                | "create_connect_land_zones",
            ) => self.connection = true,
            _ => {}
        }
    }

    fn source_words(source: &SourceText, range: ByteRange) -> String {
        let bytes = source
            .bytes()
            .get(range.start.0 as usize..range.end.0 as usize)
            .unwrap_or_default();
        String::from_utf8_lossy(bytes).into_owned()
    }

    fn dispatched_crash(
        &self,
        source: &SourceText,
        range: ByteRange,
        command: &str,
        reason: &str,
    ) -> StrictParseError {
        let word = Self::source_words(source, range);
        self.error(
            StrictParseErrorKind::Syntax,
            GAME_CRASH_CODE,
            format!(
                "The game crashes on this script: {word} is a defined name where a command can stand, so the game runs it as the command {command} with no values, and {reason}. Remove {word} or write the command it was meant to be."
            ),
            Some(range),
        )
    }

    fn process_dispatch_marker(
        &mut self,
        source: &SourceText,
        range: ByteRange,
        marker: &str,
    ) -> Result<(), StrictParseError> {
        if !self.is_active() {
            return Ok(());
        }
        let word = Self::source_words(source, range);
        if let Some(id) = marker.strip_prefix(DISPATCH_ID_MARKER) {
            let id = id.parse::<i32>().unwrap_or(i32::MIN);
            if crashes_in_connection_block(id, true, &self.handler_state()) {
                return Err(self.error(
                    StrictParseErrorKind::Syntax,
                    GAME_CRASH_CODE,
                    format!(
                        "The game crashes on this script: {word} is a defined name where a command can stand, and inside a connection block the game reads a terrain from it that it does not have. Remove {word}."
                    ),
                    Some(range),
                ));
            }
            return Ok(());
        }
        let Some(what) = marker.strip_prefix(DISPATCH_UNSUPPORTED_MARKER) else {
            return Ok(());
        };
        let state = self.handler_state();
        let unsupported = match what {
            "147" | "148" => {
                let id = what.parse::<i32>().unwrap_or_default();
                if crashes_in_connection_block(id, true, &state) {
                    let command = strict_command_by_id(id).map_or("", |command| command.name);
                    return Err(self.dispatched_crash(
                        source,
                        range,
                        command,
                        "the connection block reads the missing terrain",
                    ));
                }
                state.section == "objects_generation"
                    && if id == 147 {
                        !state.brace_open
                    } else {
                        state.brace_open && !self.object_group_names.is_empty()
                    }
            }
            _ => true,
        };
        if unsupported {
            return Err(self.error(
                StrictParseErrorKind::Syntax,
                UNSUPPORTED_DISPATCH_CODE,
                format!(
                    "The preview cannot show this script: {word} is a defined name where a command can stand, and the game runs it here as a command whose effect the preview does not reproduce. Remove {word} or write the command it was meant to be."
                ),
                Some(range),
            ));
        }
        Ok(())
    }

    fn error(
        &self,
        kind: StrictParseErrorKind,
        code: &'static str,
        message: impl Into<String>,
        range: Option<ByteRange>,
    ) -> StrictParseError {
        StrictParseError {
            kind,
            code,
            message: message.into(),
            source_chain: self.source_chain.clone(),
            range,
        }
    }

    fn resolution_error(
        &self,
        diagnostic: ResolutionDiagnostic,
        range: Option<ByteRange>,
    ) -> StrictParseError {
        StrictParseError {
            kind: StrictParseErrorKind::Resolution,
            code: "RMS2021",
            message: diagnostic.message,
            source_chain: diagnostic.source_chain,
            range,
        }
    }
}

fn compact_team_selector_values(players: &[ExecutionPlayerSetup]) -> Vec<i32> {
    let mut next_team = 0_i32;
    let mut compact = BTreeMap::<u8, i32>::new();
    players
        .iter()
        .map(|player| {
            if player.team == 0
                || players
                    .iter()
                    .filter(|candidate| candidate.team == player.team)
                    .count()
                    < 2
            {
                0
            } else {
                *compact.entry(player.team).or_insert_with(|| {
                    next_team += 1;
                    next_team
                })
            }
        })
        .collect()
}

#[derive(Clone)]
struct Line {
    range: ByteRange,
    significant: Vec<(TokenKind, String, ByteRange)>,
    pending_numeric_command: Option<(TokenKind, String, ByteRange)>,
    suppressed_comment: Option<Vec<(TokenKind, String, ByteRange)>>,
    expanded: bool,
    dispatched: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommentDelimiter {
    Open,
    Close,
}

#[derive(Clone, Copy)]
struct RandomBranch {
    weight: i32,
    start: usize,
    end: usize,
}

fn logical_statements(source: &SourceText, tokens: &[Token]) -> Vec<Line> {
    let mut result: Vec<Line> = Vec::new();
    let mut start = 0;
    for (index, token) in tokens.iter().enumerate() {
        if token.kind == TokenKind::Newline {
            split_line_into_statements(source, tokens, start, index + 1, &mut result);
            start = index + 1;
        }
    }
    if start < tokens.len() {
        split_line_into_statements(source, tokens, start, tokens.len(), &mut result);
    }
    take_quoted_include_names_from_following_lines(&mut result);
    take_operands_from_following_lines(&mut result);
    for index in 1..result.len() {
        let (before, after) = result.split_at_mut(index);
        let line = &mut before[index - 1];
        let Some(next) = after[0].significant.first() else {
            continue;
        };
        if line.pending_numeric_command.is_none()
            && is_statement_start(&next.1)
            && ends_before_required_operand(&line.significant)
        {
            line.pending_numeric_command = Some(next.clone());
        }
    }
    result
}

fn take_operands_from_following_lines(lines: &mut Vec<Line>) {
    let mut index = 0;
    while index + 1 < lines.len() {
        while ends_before_required_operand(&lines[index].significant) {
            let Some(next) = lines
                .get(index + 1)
                .and_then(|line| line.significant.first())
            else {
                break;
            };
            if is_statement_start(&next.1) {
                break;
            }
            let following = &lines[index + 1].significant;
            let count = numeric_token_count(following).max(1).min(following.len());
            let moved = lines[index + 1]
                .significant
                .drain(..count)
                .collect::<Vec<_>>();
            let line = &mut lines[index];
            line.range.end = moved.last().map_or(line.range.end, |token| token.2.end);
            line.significant.extend(moved);
            let following = &mut lines[index + 1];
            match following.significant.first() {
                Some(first) => following.range.start = first.2.start,
                None => {
                    lines.remove(index + 1);
                }
            }
            if index + 1 >= lines.len() {
                break;
            }
        }
        index += 1;
    }
}

fn ends_before_required_operand(tokens: &[(TokenKind, String, ByteRange)]) -> bool {
    let Some(command) = tokens
        .first()
        .and_then(|(_, value, _)| find_strict_command(value))
    else {
        return false;
    };
    if !reads_missing_operand_from_next_line(command.name) {
        return false;
    }
    let mut count = 1;
    for argument in command.arguments {
        if count >= tokens.len() {
            return matches!(
                argument,
                StrictArgumentKind::Number | StrictArgumentKind::Condition
            );
        }
        if is_statement_start(&tokens[count].1) {
            return false;
        }
        count += match argument {
            StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => {
                numeric_token_count(&tokens[count..])
            }
            _ => 1,
        };
    }
    false
}

fn split_line_into_statements(
    source: &SourceText,
    tokens: &[Token],
    start: usize,
    end: usize,
    result: &mut Vec<Line>,
) {
    let physical = line(source, tokens, start, end);
    split_significant_into_statements(physical.significant, result);
}

pub(crate) fn word_statements(words: &[&str]) -> (Vec<std::ops::Range<usize>>, bool) {
    let at = |index: usize| ByteRange {
        start: ByteOffset(index as u32),
        end: ByteOffset(index as u32 + 1),
    };
    let significant = words
        .iter()
        .enumerate()
        .map(|(index, word)| (TokenKind::Identifier, (*word).to_owned(), at(index)))
        .collect();
    let mut lines = Vec::new();
    split_significant_into_statements(significant, &mut lines);
    let waits = lines
        .last()
        .is_some_and(|line| ends_before_required_operand(&line.significant));
    let ranges = lines
        .iter()
        .map(|line| line.range.start.0 as usize..line.range.end.0 as usize)
        .collect();
    (ranges, waits)
}

fn split_significant_into_statements(
    significant: Vec<(TokenKind, String, ByteRange)>,
    result: &mut Vec<Line>,
) {
    let mut statements = Vec::new();
    let mut index = 0;
    while index < significant.len() {
        let statement_start = index;
        let value = significant[index].1.as_str();
        let (count, advance) = statement_token_count(&significant[index..]);
        let pending_numeric_command =
            (count > advance).then(|| significant[index + advance].clone());
        index = index.saturating_add(advance.max(1)).min(significant.len());
        if !is_statement_start(value) {
            while index < significant.len() && !is_statement_start(&significant[index].1) {
                index += 1;
            }
        }
        statements.push((index - statement_start, pending_numeric_command));
    }
    let single = statements.len() == 1;
    let mut whole = Some(significant);
    let mut words = if single {
        Vec::new().into_iter()
    } else {
        whole.take().unwrap_or_default().into_iter()
    };
    for (count, pending_numeric_command) in statements {
        let statement = match whole.take() {
            Some(statement) => statement,
            None => words.by_ref().take(count).collect::<Vec<_>>(),
        };
        if let (Some(first), Some(last)) = (statement.first(), statement.last()) {
            result.push(Line {
                range: ByteRange {
                    start: first.2.start,
                    end: last.2.end,
                },
                significant: statement,
                pending_numeric_command,
                suppressed_comment: None,
                expanded: false,
                dispatched: false,
            });
        }
    }
}

fn statement_token_count(tokens: &[(TokenKind, String, ByteRange)]) -> (usize, usize) {
    let Some((_, value, _)) = tokens.first() else {
        return (0, 0);
    };
    let Some(command) = find_strict_command(value) else {
        return (1, 1);
    };
    let mut count = 1;
    for argument in command.arguments {
        if count >= tokens.len() {
            break;
        }
        if is_statement_start(&tokens[count].1) {
            match argument {
                StrictArgumentKind::Number | StrictArgumentKind::Condition => {
                    return (count + 1, count);
                }
                StrictArgumentKind::Token
                | StrictArgumentKind::Label
                | StrictArgumentKind::Path
                    if !command_word_pushback_disabled_for_attribution() =>
                {
                    return (count + 1, count);
                }
                StrictArgumentKind::TolerantNumber => break,
                _ => {}
            }
        }
        count += match argument {
            StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => {
                numeric_token_count(&tokens[count..])
            }
            StrictArgumentKind::Path => include_filename_words(&tokens[count..]).0,
            _ => 1,
        };
    }
    (count.min(tokens.len()), count.min(tokens.len()))
}

fn include_filename_words(tokens: &[(TokenKind, String, ByteRange)]) -> (usize, Option<String>) {
    include_filename_word_values(tokens.iter().map(|(_, word, _)| word.as_str()))
}

fn include_filename_word_values<'a>(
    words: impl IntoIterator<Item = &'a str>,
) -> (usize, Option<String>) {
    let mut words = words.into_iter();
    let Some(first) = words.next() else {
        return (0, None);
    };
    let Some(open) = first.find('"') else {
        return (1, Some(first.to_owned()));
    };
    let rest = &first[open + 1..];
    if let Some(close) = rest.find('"') {
        return (1, Some(rest[..close].to_owned()));
    }
    let mut name = rest.to_owned();
    let mut count = 1;
    for word in words {
        count += 1;
        name.push(' ');
        match word.find('"') {
            Some(close) => {
                name.push_str(&word[..close]);
                return (count, Some(name));
            }
            None => name.push_str(word),
        }
    }
    (count, None)
}

fn is_include_keyword(value: &str) -> bool {
    matches!(value, "#include" | "#include_drs" | "#includeXS")
}

fn take_quoted_include_names_from_following_lines(lines: &mut Vec<Line>) {
    let mut index = 0;
    while index < lines.len() {
        let significant = &lines[index].significant;
        let incomplete = significant
            .first()
            .is_some_and(|(_, keyword, _)| is_include_keyword(keyword))
            && include_filename_words(&significant[1..]).1.is_none();
        let reads_on = incomplete
            && (significant.len() > 1
                || lines
                    .get(index + 1)
                    .and_then(|line| line.significant.first())
                    .is_some_and(|(_, word, _)| !is_statement_start(word)));
        if !reads_on {
            index += 1;
            continue;
        }
        while index + 1 < lines.len() {
            let following = lines.remove(index + 1);
            let line = &mut lines[index];
            let mut words = following.significant.into_iter();
            let mut complete = false;
            for word in words.by_ref() {
                line.range.end = word.2.end;
                line.significant.push(word);
                complete = include_filename_words(&line.significant[1..]).1.is_some();
                if complete {
                    break;
                }
            }
            if complete {
                let mut rest = Vec::new();
                split_significant_into_statements(words.collect(), &mut rest);
                lines.splice(index + 1..index + 1, rest);
                break;
            }
        }
        index += 1;
    }
}

fn numeric_token_count(tokens: &[(TokenKind, String, ByteRange)]) -> usize {
    let Some((_, first, _)) = tokens.first() else {
        return 0;
    };
    if !first.starts_with('(') {
        return 1;
    }
    tokens
        .iter()
        .position(|(_, value, _)| value.ends_with(')'))
        .map_or(tokens.len(), |index| index + 1)
}

fn unparsed_argument(
    expected: StrictArgumentKind,
    tokens: &[(TokenKind, String, ByteRange)],
    cursor: &mut usize,
) -> Option<ResolvedArgument> {
    let first = tokens.get(*cursor)?;
    let count = match expected {
        StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => {
            numeric_token_count(&tokens[*cursor..])
        }
        _ => 1,
    };
    let end = cursor.saturating_add(count).min(tokens.len());
    let value = match expected {
        StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => tokens[*cursor..end]
            .iter()
            .map(|(_, value, _)| value.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        StrictArgumentKind::Path => first.1.trim_matches(['\"', '\'']).to_owned(),
        _ => normalize_identifier(&first.1),
    };
    let kind = match expected {
        StrictArgumentKind::Label => ArgumentKind::Identifier,
        StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => ArgumentKind::Number,
        StrictArgumentKind::Path => ArgumentKind::String,
        StrictArgumentKind::Token | StrictArgumentKind::Condition => token_argument_kind(first.0),
    };
    *cursor = end;
    Some(ResolvedArgument {
        kind,
        value,
        resolution: ArgumentResolution::UnparsedAfterRejection,
    })
}

fn strip_atom_signs(atom: &str) -> (&str, bool, usize) {
    let mut unsigned = atom;
    let mut negative = false;
    let mut signs = 0_usize;
    loop {
        if let Some(rest) = unsigned.strip_prefix('-').filter(|value| !value.is_empty()) {
            negative = !negative;
            unsigned = rest;
        } else if let Some(rest) = unsigned.strip_prefix('+').filter(|value| !value.is_empty()) {
            unsigned = rest;
        } else {
            break;
        }
        signs += 1;
    }
    (unsigned, negative, signs)
}

fn undefined_atom_converts_to_zero(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || value.starts_with("rnd(") || bytes.contains(&b',') {
        return false;
    }
    let unsigned = bytes
        .strip_prefix(b"+")
        .or_else(|| bytes.strip_prefix(b"-"))
        .unwrap_or(bytes);
    let special = unsigned.get(..3).is_some_and(|prefix| {
        prefix.eq_ignore_ascii_case(b"inf") || prefix.eq_ignore_ascii_case(b"nan")
    });
    let hexadecimal = unsigned.len() >= 3
        && unsigned[0] == b'0'
        && matches!(unsigned[1], b'x' | b'X')
        && (unsigned[2].is_ascii_hexdigit()
            || unsigned[2] == b'.' && unsigned.get(3).is_some_and(u8::is_ascii_hexdigit));
    if special || hexadecimal {
        return false;
    }
    let integer_digits = unsigned
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let fraction_digits = match unsigned.get(integer_digits) {
        Some(b'.') => unsigned[integer_digits + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count(),
        _ => 0,
    };
    unsigned[..integer_digits]
        .iter()
        .chain(
            unsigned
                .get(integer_digits + 1..integer_digits + 1 + fraction_digits)
                .unwrap_or_default(),
        )
        .all(|byte| *byte == b'0')
}

fn undefined_atom_decimal_prefix(value: &str) -> Option<f32> {
    let bytes = value.as_bytes();
    if value.starts_with("rnd(") || bytes.contains(&b',') {
        return None;
    }
    let digits = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let next = *bytes.get(digits)?;
    if !(1..=15).contains(&digits) || matches!(next, b'.' | b'e' | b'E' | b'x' | b'X') {
        return None;
    }
    value[..digits].parse::<f32>().ok()
}

fn is_statement_start(value: &str) -> bool {
    find_strict_command(value).is_some()
}

fn line(source: &SourceText, tokens: &[Token], start: usize, end: usize) -> Line {
    Line {
        pending_numeric_command: None,
        range: ByteRange {
            start: tokens
                .get(start)
                .map_or(ByteOffset(0), |token| token.range.start),
            end: tokens
                .get(end.saturating_sub(1))
                .map_or(ByteOffset(0), |token| token.range.end),
        },
        significant: tokens[start..end]
            .iter()
            .filter(|token| !token.kind.is_trivia())
            .map(|token| {
                (
                    token.kind,
                    native_token_text(token.bytes(source)),
                    token.range,
                )
            })
            .collect(),
        suppressed_comment: None,
        expanded: false,
        dispatched: false,
    }
}

const NATIVE_TOKEN_BYTE_BASE: u32 = 0x10_FF00;

fn native_token_text(bytes: &[u8]) -> String {
    let is_byte_form = |character: char| {
        (NATIVE_TOKEN_BYTE_BASE + 0x80..=NATIVE_TOKEN_BYTE_BASE + 0xff)
            .contains(&u32::from(character))
    };
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.chars().any(is_byte_form) => text.to_owned(),
        _ => bytes
            .iter()
            .map(|&byte| {
                if byte.is_ascii() {
                    char::from(byte)
                } else {
                    char::from_u32(NATIVE_TOKEN_BYTE_BASE + u32::from(byte))
                        .expect("the byte form stays inside the private-use plane")
                }
            })
            .collect(),
    }
}

const DISPATCH_ID_MARKER: &str = "\u{1}dispatch-id:";
const DISPATCH_UNSUPPORTED_MARKER: &str = "\u{1}dispatch-unsupported:";
const DISPATCH_EMPTY_CONDITION: &str = "\u{1}";

fn dispatched_statement(
    value: f32,
    range: ByteRange,
) -> Option<Vec<(TokenKind, String, ByteRange)>> {
    let word = |kind: TokenKind, text: &str| (kind, text.to_owned(), range);
    if value == 69.0 {
        return Some(vec![word(TokenKind::Identifier, "/*")]);
    }
    if value == 70.0 {
        return Some(vec![word(TokenKind::Identifier, "*/")]);
    }
    let id = native_command_id(value);
    match id {
        0 | 1 | 2 | 10 | 92 | 123 => return None,
        69 | 70 => {
            return Some(vec![word(
                TokenKind::Error,
                &format!("{DISPATCH_UNSUPPORTED_MARKER}a constant with a fractional comment code"),
            )]);
        }
        147 | 148 => {
            return Some(vec![word(
                TokenKind::Error,
                &format!("{DISPATCH_UNSUPPORTED_MARKER}{id}"),
            )]);
        }
        _ => {}
    }
    let Some(command) = strict_command_by_id(id) else {
        return Some(vec![word(
            TokenKind::Error,
            &format!("{DISPATCH_ID_MARKER}{id}"),
        )]);
    };
    let mut statement = vec![word(
        semantic_token_kind(command.name, TokenKind::Identifier),
        command.name,
    )];
    for argument in command.arguments {
        match argument {
            StrictArgumentKind::Number => statement.push(word(TokenKind::Number, "0")),
            StrictArgumentKind::TolerantNumber => {}
            StrictArgumentKind::Token => statement.push(word(TokenKind::Error, "")),
            StrictArgumentKind::Condition => {
                statement.push(word(TokenKind::Error, DISPATCH_EMPTY_CONDITION))
            }
            StrictArgumentKind::Label | StrictArgumentKind::Path => return None,
        }
    }
    Some(statement)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DispatchedCommand {
    Nothing,
    CommentDelimiter,
    Command(&'static StrictCommand),
    OutsideCatalogue(i32),
    Unsupported,
}

pub(crate) fn dispatched_command(value: f32) -> DispatchedCommand {
    let nowhere = ByteRange {
        start: ByteOffset(0),
        end: ByteOffset(0),
    };
    let Some(statement) = dispatched_statement(value, nowhere) else {
        return DispatchedCommand::Nothing;
    };
    let Some((kind, head, _)) = statement.first() else {
        return DispatchedCommand::Nothing;
    };
    if *kind == TokenKind::Error {
        return match head.strip_prefix(DISPATCH_ID_MARKER) {
            Some(id) => DispatchedCommand::OutsideCatalogue(id.parse().unwrap_or(i32::MIN)),
            None => DispatchedCommand::Unsupported,
        };
    }
    if head == "/*" || head == "*/" {
        return DispatchedCommand::CommentDelimiter;
    }
    find_strict_command(head).map_or(DispatchedCommand::Unsupported, DispatchedCommand::Command)
}

fn find_random_end(lines: &[Line], start: usize, end: usize) -> Option<usize> {
    let mut depth = 1_u32;
    for (index, line) in lines.iter().enumerate().take(end).skip(start) {
        match line.significant.first().map(|token| token.1.as_str()) {
            Some("start_random") => depth = depth.saturating_add(1),
            Some("end_random") => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn random_branches(
    parser: &mut Parser<'_>,
    lines: &[Line],
    start: usize,
    end: usize,
) -> Result<Vec<RandomBranch>, StrictParseError> {
    let mut result: Vec<RandomBranch> = Vec::new();
    let mut depth = 0_u32;
    for (index, line) in lines.iter().enumerate().take(end).skip(start) {
        let tokens = &line.significant;
        match tokens.first().map(|token| token.1.as_str()) {
            Some("start_random") => depth = depth.saturating_add(1),
            Some("end_random") => depth = depth.saturating_sub(1),
            Some("percent_chance") if depth == 0 => {
                let Some(raw_weight) = tokens.get(1) else {
                    continue;
                };
                if let Some(previous) = result.last_mut() {
                    previous.end = index;
                }
                let weight = parser.evaluate_numeric_tokens(&tokens[1..], line.range)?;
                if !weight.is_finite() || weight < i32::MIN as f32 || weight > i32::MAX as f32 {
                    return Err(parser.error(
                        StrictParseErrorKind::Preprocessor,
                        "RMS2023",
                        "percent_chance weight is outside the supported integer range",
                        Some(raw_weight.2),
                    ));
                }
                let weight = weight.round() as i32;
                result.push(RandomBranch {
                    weight,
                    start: index + 1,
                    end,
                });
            }
            _ => {}
        }
    }
    Ok(result)
}

fn is_conditional_keyword(value: &str) -> bool {
    matches!(value, "if" | "elseif" | "else" | "endif")
}

fn token_argument_kind(kind: TokenKind) -> ArgumentKind {
    match kind {
        TokenKind::Identifier | TokenKind::Directive | TokenKind::Section => {
            ArgumentKind::Identifier
        }
        TokenKind::Number => ArgumentKind::Number,
        TokenKind::String => ArgumentKind::String,
        TokenKind::Operator => ArgumentKind::Operator,
        TokenKind::LParen | TokenKind::RParen | TokenKind::Comma => ArgumentKind::Punctuation,
        _ => ArgumentKind::Unknown,
    }
}

fn semantic_token_kind(value: &str, fallback: TokenKind) -> TokenKind {
    match value {
        "{" => TokenKind::LBrace,
        "}" => TokenKind::RBrace,
        "(" => TokenKind::LParen,
        ")" => TokenKind::RParen,
        "," => TokenKind::Comma,
        "=" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%" | "&&" | "||" => {
            TokenKind::Operator
        }
        _ if value.starts_with('<') && value.ends_with('>') => TokenKind::Section,
        _ if value.starts_with('#') => TokenKind::Directive,
        _ => fallback,
    }
}

fn classify_argument(value: &str) -> ArgumentKind {
    if value.parse::<f64>().is_ok() {
        ArgumentKind::Number
    } else {
        ArgumentKind::Identifier
    }
}

fn normalize_value(value: &str, kind: ArgumentKind) -> String {
    match kind {
        ArgumentKind::Identifier => normalize_identifier(value),
        ArgumentKind::String => value.trim_matches(['"', '\'']).to_owned(),
        _ => value.to_owned(),
    }
}

fn normalize_identifier(value: &str) -> String {
    value.to_owned()
}

fn normalize_identifier_ref(value: &str) -> &str {
    value
}

fn canonical_number(value: f32) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        value.to_string()
    }
}

fn numeric_definition_reference(value: f32) -> f32 {
    format!("{value:.6}")
        .parse::<f32>()
        .expect("formatting a binary32 value must remain parseable")
}
