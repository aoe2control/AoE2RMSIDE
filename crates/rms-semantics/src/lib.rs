mod block_rules;
mod metadata;
mod native_context;
mod native_dispatch;
mod parser;
mod program;
mod strict_commands;
mod target_rng;

pub use block_rules::{
    CommandRules, DescriptorBlock, block_rules, descriptor_block, section_rules,
};
pub use metadata::{CommandKind, CommandMetadata, command_metadata, find_command};
pub use native_context::{
    BLOCK_OPENING_COMMANDS, NativeIgnoredContext, NativeIgnoredOperation, ObjectBlockCommandEffect,
    is_global_descriptor_command, is_player_setup_command, object_block_command_effect,
    opens_descriptor_block,
};
pub use native_dispatch::{
    Braces, GAME_CRASH_CODE, UNSUPPORTED_DISPATCH_CODE, WordAction, WordDefinitions, WordPlace,
    first_word_action,
};
pub use parser::{
    ArgumentKind, ArgumentResolution, ExecutionContext, ExecutionPlayerSetup,
    ImplicitDefinitionError, ParsedDecision, ParsedDecisionKind, ParsedDescriptor, ParsedProgram,
    ParserLimits, PotentialInclude, ResolvedArgument, StrictLexCache, StrictParseError,
    StrictParseErrorKind, StrictParseOptions, discover_include_requests,
    normalize_implicit_definition_bytes, normalize_implicit_definition_integers,
    normalize_implicit_definition_source, parse_strict, parse_strict_cached, parse_strict_single,
};
pub use program::{
    ExecutedConstruct, SemanticEquivalence, SemanticOperation, SemanticProgram,
    SemanticProgramIdentity, SourceSpanMapping, compare_semantics,
};
pub use strict_commands::{
    StrictArgumentKind, StrictCommand, StrictCommandKind, reads_missing_operand_from_next_line,
    strict_command, strict_command_arity, strict_command_id, strict_command_names, strict_commands,
};
pub use target_rng::{
    RmsRandom, RmsRngDraw, RmsRngError, RmsRngPurpose, RmsRngSample, RmsRngState,
};
