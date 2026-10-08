use std::collections::BTreeMap;

use rms_profile::ProfileIdentity;
use rms_source::{ByteRange, SourceId};
use sha2::{Digest, Sha256};

use crate::{
    ArgumentKind, ExecutionContext, ExecutionPlayerSetup, ParsedDecision, ParsedDecisionKind,
    ParsedProgram, ResolvedArgument, RmsRngDraw, RmsRngState,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticProgramIdentity {
    pub entry_source: SourceId,
    pub profile: ProfileIdentity,
    pub semantic_hash: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticOperation {
    pub identity: [u8; 32],
    pub section: String,
    pub name: String,
    pub arguments: Vec<ResolvedArgument>,
    pub depth: u32,
    pub source_id: SourceId,
    pub source_range: ByteRange,
    pub include_chain: Vec<SourceId>,
    pub parser_effect_rng_draws: Vec<RmsRngDraw>,
}

impl SemanticOperation {
    pub fn accepted_by_target_parser(&self) -> bool {
        let command = crate::strict_commands::find_strict_command(&self.name);
        !self.arguments.iter().enumerate().any(|(index, argument)| {
            argument.resolution == crate::ArgumentResolution::UnparsedAfterRejection
                || argument.resolution == crate::ArgumentResolution::UnregisteredNumber
                || argument.resolution == crate::ArgumentResolution::UndefinedNumericFallback
                    && !command.is_some_and(|command| {
                        matches!(
                            command.arguments.get(index),
                            Some(
                                crate::strict_commands::StrictArgumentKind::Number
                                    | crate::strict_commands::StrictArgumentKind::TolerantNumber
                            )
                        )
                    })
        })
    }

    pub fn presentation_include_chain<'a>(&'a self, entry: &'a SourceId) -> Vec<&'a SourceId> {
        let mut chain = if self.include_chain.is_empty() {
            vec![entry]
        } else {
            self.include_chain.iter().collect::<Vec<_>>()
        };
        if chain.last() != Some(&&self.source_id) {
            chain.push(&self.source_id);
        }
        chain
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ExecutedConstruct {
    pub context: String,
    pub name: String,
}

impl ExecutedConstruct {
    pub fn section_context(section: &str) -> String {
        if section.is_empty() {
            String::new()
        } else {
            format!("<{}>", section.to_ascii_uppercase())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticProgram {
    pub identity: SemanticProgramIdentity,
    pub execution_context: ExecutionContext,
    pub selected_sections: Vec<String>,
    pub operations: Vec<SemanticOperation>,
    pub decisions: Vec<ParsedDecision>,
    pub resolved_includes: Vec<SourceId>,
    pub external_dependencies: Vec<SourceId>,
    pub rng_draws: Vec<RmsRngDraw>,
    pub rng_state_after_parser: RmsRngState,
    canonical: Vec<u8>,
}

impl SemanticProgram {
    pub fn from_parsed(parsed: ParsedProgram) -> Self {
        let operations = parsed
            .descriptors
            .into_iter()
            .enumerate()
            .map(|(index, descriptor)| {
                let mut writer = CanonicalWriter::default();
                writer.string("rms-operation-v2");
                writer.u32(index as u32);
                writer.string(&descriptor.section);
                writer.string(&descriptor.name);
                writer.u32(descriptor.depth);
                writer.arguments(&descriptor.arguments);
                SemanticOperation {
                    identity: Sha256::digest(writer.finish()).into(),
                    section: descriptor.section,
                    name: descriptor.name,
                    arguments: descriptor.arguments,
                    depth: descriptor.depth,
                    source_id: descriptor.source_id,
                    source_range: descriptor.source_range,
                    include_chain: descriptor.include_chain,
                    parser_effect_rng_draws: descriptor.parser_effect_rng_draws,
                }
            })
            .collect::<Vec<_>>();
        let canonical = canonical_program(
            &parsed.profile,
            &parsed.execution_context,
            &parsed.selected_sections,
            &operations,
            &parsed.decisions,
            &parsed.resolved_includes,
            &parsed.rng_draws,
            parsed.rng_state_after_parser,
        );
        let semantic_hash = Sha256::digest(&canonical).into();
        Self {
            identity: SemanticProgramIdentity {
                entry_source: parsed.entry_source,
                profile: parsed.profile,
                semantic_hash,
            },
            execution_context: parsed.execution_context,
            selected_sections: parsed.selected_sections,
            operations,
            decisions: parsed.decisions,
            resolved_includes: parsed.resolved_includes,
            external_dependencies: parsed.external_dependencies,
            rng_draws: parsed.rng_draws,
            rng_state_after_parser: parsed.rng_state_after_parser,
            canonical,
        }
    }

    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical
    }

    pub fn executable_operations(&self) -> impl Iterator<Item = &SemanticOperation> {
        self.operations
            .iter()
            .filter(|operation| operation.accepted_by_target_parser())
    }

    pub fn executed_constructs(&self) -> BTreeMap<ExecutedConstruct, usize> {
        let mut blocks = BTreeMap::<&str, &str>::new();
        let mut constructs = BTreeMap::new();
        for (index, operation) in self.operations.iter().enumerate() {
            let section = operation.section.as_str();
            if operation.depth == 0 && operation.name.starts_with("create_") {
                blocks.insert(section, operation.name.as_str());
            }
            if !operation.accepted_by_target_parser() {
                continue;
            }
            let context = match blocks.get(section) {
                Some(block) if operation.depth > 0 => (*block).to_owned(),
                _ => ExecutedConstruct::section_context(section),
            };
            constructs
                .entry(ExecutedConstruct {
                    context,
                    name: operation.name.clone(),
                })
                .or_insert(index);
        }
        constructs
    }

    pub fn has_section(&self, section: &str) -> bool {
        self.selected_sections
            .binary_search_by(|candidate| candidate.as_str().cmp(section))
            .is_ok()
    }

    pub fn legacy_synthetic_fixture_hash(&self, player_count: u8, mode_context: &str) -> [u8; 32] {
        Sha256::digest(canonical_legacy_synthetic_fixture(
            &self.identity.profile,
            &self.execution_context,
            player_count,
            mode_context,
            &self.operations,
            &self.decisions,
            &self.resolved_includes,
            &self.rng_draws,
            self.rng_state_after_parser,
        ))
        .into()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceSpanMapping {
    pub operation_identity: [u8; 32],
    pub previous_source_id: SourceId,
    pub previous_range: ByteRange,
    pub next_source_id: SourceId,
    pub next_range: ByteRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SemanticEquivalence {
    Equal {
        semantic_hash: [u8; 32],
        source_span_remap: Vec<SourceSpanMapping>,
    },
    Different,
}

pub fn compare_semantics(
    previous: &SemanticProgram,
    next: &SemanticProgram,
) -> SemanticEquivalence {
    if previous.identity.semantic_hash != next.identity.semantic_hash
        || previous.canonical != next.canonical
    {
        return SemanticEquivalence::Different;
    }
    let mut next_by_identity = BTreeMap::<[u8; 32], Vec<&SemanticOperation>>::new();
    for operation in &next.operations {
        next_by_identity
            .entry(operation.identity)
            .or_default()
            .push(operation);
    }
    let mut consumed = BTreeMap::<[u8; 32], usize>::new();
    let mut remap = Vec::with_capacity(previous.operations.len());
    for operation in &previous.operations {
        let index = consumed.entry(operation.identity).or_default();
        let Some(candidate) = next_by_identity
            .get(&operation.identity)
            .and_then(|items| items.get(*index))
        else {
            return SemanticEquivalence::Different;
        };
        *index += 1;
        remap.push(SourceSpanMapping {
            operation_identity: operation.identity,
            previous_source_id: operation.source_id.clone(),
            previous_range: operation.source_range,
            next_source_id: candidate.source_id.clone(),
            next_range: candidate.source_range,
        });
    }
    SemanticEquivalence::Equal {
        semantic_hash: previous.identity.semantic_hash,
        source_span_remap: remap,
    }
}

#[allow(clippy::too_many_arguments)]
fn canonical_program(
    profile: &ProfileIdentity,
    context: &ExecutionContext,
    selected_sections: &[String],
    operations: &[SemanticOperation],
    decisions: &[ParsedDecision],
    resolved_includes: &[SourceId],
    rng_draws: &[RmsRngDraw],
    rng_state_after_parser: RmsRngState,
) -> Vec<u8> {
    let mut writer = CanonicalWriter::default();
    writer.string("rms-semantic-program-v3");
    writer.string(&profile.schema_version);
    writer.string(&profile.profile_id);
    writer.string(&profile.behavior_version);
    writer.u32(context.seed);
    writer.u16(context.map_width);
    writer.u16(context.map_height);
    writer.u8(context.game_mode);
    writer.u8(context.starting_resources);
    writer.u8(context.starting_age);
    writer.u8(context.position_policy);
    let mut players = context.players.clone();
    players.sort_by_key(|player| player.slot);
    writer.u8(players.len() as u8);
    for player in &players {
        writer.u8(player.slot);
        writer.u8(player.team);
        writer.u32(player.civilization_id);
    }
    writer.u32(selected_sections.len() as u32);
    for section in selected_sections {
        writer.string(section);
    }
    write_canonical_program_tail(
        &mut writer,
        operations,
        decisions,
        resolved_includes,
        rng_draws,
        rng_state_after_parser,
    );
    if !players.iter().all(ExecutionPlayerSetup::has_default_color) {
        writer.string("player-colors-v1");
        for player in &players {
            writer.u8(player.slot);
            writer.u8(player.color);
        }
    }
    writer.finish()
}

#[allow(clippy::too_many_arguments)]
fn canonical_legacy_synthetic_fixture(
    profile: &ProfileIdentity,
    context: &ExecutionContext,
    player_count: u8,
    mode_context: &str,
    operations: &[SemanticOperation],
    decisions: &[ParsedDecision],
    resolved_includes: &[SourceId],
    rng_draws: &[RmsRngDraw],
    rng_state_after_parser: RmsRngState,
) -> Vec<u8> {
    const LEGACY_SYNTHETIC_BEHAVIOR_VERSION: &str = "frozen-2026-08-22-synthetic-fixture";
    let mut writer = CanonicalWriter::default();
    writer.string("rms-semantic-program-v1");
    writer.string(&profile.schema_version);
    writer.string(&profile.profile_id);
    writer.string(LEGACY_SYNTHETIC_BEHAVIOR_VERSION);
    writer.u32(context.seed);
    writer.u16(context.map_width);
    writer.u16(context.map_height);
    writer.u8(player_count);
    writer.string(mode_context);
    write_canonical_program_tail(
        &mut writer,
        operations,
        decisions,
        resolved_includes,
        rng_draws,
        rng_state_after_parser,
    );
    writer.finish()
}

fn write_canonical_program_tail(
    writer: &mut CanonicalWriter,
    operations: &[SemanticOperation],
    decisions: &[ParsedDecision],
    resolved_includes: &[SourceId],
    rng_draws: &[RmsRngDraw],
    rng_state_after_parser: RmsRngState,
) {
    writer.u32(resolved_includes.len() as u32);
    for source in resolved_includes {
        writer.string(source.as_str());
    }
    writer.u32(decisions.len() as u32);
    for decision in decisions {
        writer.u8(decision_kind(decision.kind));
        writer.boolean(decision.result);
        writer.u32(decision.values.len() as u32);
        for value in &decision.values {
            writer.string(value);
        }
    }
    writer.u32(rng_draws.len() as u32);
    for draw in rng_draws {
        writer.string(draw.purpose.as_str());
        writer.u64(draw.sample.ordinal);
        writer.u32(draw.sample.raw);
        writer.u32(draw.sample.upper_exclusive);
        writer.u32(draw.sample.result);
        writer.bytes(&draw.sample.checkpoint_hash());
    }
    writer.u8(rng_state_after_parser.index());
    writer.u64(rng_state_after_parser.draws());
    for word in rng_state_after_parser.words() {
        writer.u32(word);
    }
    writer.u32(operations.len() as u32);
    for operation in operations {
        writer.bytes(&operation.identity);
        writer.string(&operation.section);
        writer.string(&operation.name);
        writer.u32(operation.depth);
        writer.arguments(&operation.arguments);
        writer.u32(operation.parser_effect_rng_draws.len() as u32);
        for draw in &operation.parser_effect_rng_draws {
            writer.string(draw.purpose.as_str());
            writer.u64(draw.sample.ordinal);
            writer.u32(draw.sample.raw);
            writer.u32(draw.sample.upper_exclusive);
            writer.u32(draw.sample.result);
            writer.bytes(&draw.sample.checkpoint_hash());
        }
    }
}

fn decision_kind(kind: ParsedDecisionKind) -> u8 {
    match kind {
        ParsedDecisionKind::Definition => 0,
        ParsedDecisionKind::Redefinition => 1,
        ParsedDecisionKind::Conditional => 2,
        ParsedDecisionKind::RandomBranch => 3,
        ParsedDecisionKind::Include => 4,
        ParsedDecisionKind::UndefinedNumericFallback => 5,
        ParsedDecisionKind::MissingIncludeFallback => 6,
    }
}

#[derive(Default)]
struct CanonicalWriter {
    bytes: Vec<u8>,
}

impl CanonicalWriter {
    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn boolean(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value);
    }

    fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    fn arguments(&mut self, arguments: &[ResolvedArgument]) {
        self.u32(arguments.len() as u32);
        for argument in arguments {
            self.u8(argument_kind(argument.kind));
            self.u8(argument_resolution(argument.resolution));
            self.string(&argument.value);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn argument_kind(kind: ArgumentKind) -> u8 {
    match kind {
        ArgumentKind::Identifier => 0,
        ArgumentKind::Number => 1,
        ArgumentKind::String => 2,
        ArgumentKind::Operator => 3,
        ArgumentKind::Punctuation => 4,
        ArgumentKind::Unknown => 5,
    }
}

fn argument_resolution(resolution: crate::ArgumentResolution) -> u8 {
    match resolution {
        crate::ArgumentResolution::Direct => 0,
        crate::ArgumentResolution::DefinedIdentifier => 1,
        crate::ArgumentResolution::UndefinedNumericFallback => 2,
        crate::ArgumentResolution::ObjectGroupReference => 3,
        crate::ArgumentResolution::UnparsedAfterRejection => 4,
        crate::ArgumentResolution::UnregisteredNumber => 5,
    }
}
