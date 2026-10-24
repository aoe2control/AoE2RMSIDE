use std::collections::HashMap;

use rms_profile::crash_ids;

use crate::block_rules::{block_rules, descriptor_block, section_rules};
use crate::native_context::is_global_descriptor_command;
use crate::parser::{
    DispatchedCommand, dispatched_command, word_statement_ranges, word_statements,
};
use crate::strict_commands::{
    StrictArgumentKind, StrictCommand, StrictCommandKind, dispatcher_handles_id,
    find_strict_command, strict_command_id,
};

pub const GAME_CRASH_CODE: &str = "RMS2042";

pub(crate) const CONNECTION_BLOCK_REASON: &str = "the connection block reads the missing terrain";

pub const UNSUPPORTED_DISPATCH_CODE: &str = "RMS2043";

pub(crate) fn native_command_id(value: f32) -> i32 {
    if value.is_nan() || !(-2_147_483_648.0..2_147_483_648.0).contains(&value) {
        i32::MIN
    } else {
        value.trunc() as i32
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct HandlerState<'a> {
    pub section: &'a str,
    pub brace_open: bool,
    pub land_range: bool,
    pub land_range_from_create_land: bool,
    pub elevation_range: bool,
    pub object_descriptor: bool,
    pub connection: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NullSlot {
    Crash(&'static str, &'static str),
    Zero,
    Nothing,
}

pub(crate) fn crashes_in_connection_block(id: i32, slot0_null: bool, state: &HandlerState) -> bool {
    state.section == "connection_generation"
        && state.brace_open
        && state.connection
        && !dispatcher_handles_id(id)
        && slot0_null
}

pub(crate) fn first_slot_is_not_a_token(command: &StrictCommand) -> bool {
    command.arguments.first() != Some(&StrictArgumentKind::Token)
}

pub(crate) fn null_token_slot(id: i32, state: &HandlerState) -> NullSlot {
    const GLOBAL: &str = crash_ids::DEFINED_NAME_RUNS_AS_GLOBAL_COMMAND;
    const LAND_TERRAIN: &str = crash_ids::DEFINED_NAME_RUNS_AS_LAND_TERRAIN;
    let crash = NullSlot::Crash;
    match (state.section, id) {
        (_, 90) => crash("ai_info_map_type reads its missing map type", GLOBAL),
        (_, 121) => crash("effect_amount reads its missing effect", GLOBAL),
        (_, 124) => crash("effect_percent reads its missing effect", GLOBAL),
        ("player_setup", 98) => crash(
            "guard_state reads its missing object",
            crash_ids::DEFINED_NAME_RUNS_AS_GUARD_STATE,
        ),
        ("cliff_generation", 142) => crash(
            "cliff_type reads its missing cliff type",
            crash_ids::DEFINED_NAME_RUNS_AS_CLIFF_TYPE,
        ),
        ("land_generation", 19 | 102) if !state.brace_open => crash(
            "the land section reads the missing terrain",
            crash_ids::DEFINED_NAME_RUNS_AS_LAND_BASE_TERRAIN,
        ),
        ("land_generation", 21) if state.brace_open && state.land_range => {
            crash("terrain_type reads its missing terrain", LAND_TERRAIN)
        }
        ("land_generation", 99)
            if state.brace_open && state.land_range && state.land_range_from_create_land =>
        {
            crash("assign_to reads its missing target", LAND_TERRAIN)
        }
        ("terrain_generation", 43 | 104) if !state.brace_open => crash(
            "the terrain section reads the missing terrain",
            crash_ids::DEFINED_NAME_RUNS_AS_TERRAIN_COMMAND,
        ),
        ("objects_generation", 48) if !state.brace_open => NullSlot::Nothing,
        ("objects_generation", 56 | 114 | 116) if state.brace_open && state.object_descriptor => {
            crash(
                "the object block reads the missing object or terrain",
                crash_ids::DEFINED_NAME_RUNS_AS_OBJECT_TERRAIN,
            )
        }
        ("elevation_generation", 19 | 102) if state.brace_open && state.elevation_range => crash(
            "the elevation block reads the missing terrain",
            crash_ids::DEFINED_NAME_RUNS_AS_ELEVATION_TERRAIN,
        ),
        _ if crashes_in_connection_block(id, true, state) => crash(
            CONNECTION_BLOCK_REASON,
            crash_ids::CONNECTION_BLOCK_MISSING_TERRAIN,
        ),
        _ => NullSlot::Zero,
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WordPlace<'a> {
    pub section: Option<&'a str>,
    pub braces: Braces<'a>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Braces<'a> {
    Outside,
    Inside(Option<&'a str>),
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WordDefinitions {
    Undefined,
    Values(Vec<String>),
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WordAction {
    Command { index: usize, command: &'static str },
    Dispatch { index: usize, command: &'static str },
    Other { index: usize },
}

pub fn first_word_action(
    words: &[&str],
    from: usize,
    place: WordPlace<'_>,
    definitions: &dyn Fn(&str) -> WordDefinitions,
) -> Option<WordAction> {
    let (statements, waits) = word_statements(words);
    let last = statements.len().saturating_sub(1);
    for (position, statement) in statements.iter().enumerate() {
        let head = statement.start;
        let Some(command) = find_strict_command(words[head]) else {
            for index in statement.clone().filter(|index| *index >= from) {
                if let Some(action) =
                    defined_word_action(words[index], index, place, definitions, 0)
                {
                    return Some(action);
                }
            }
            continue;
        };
        if matches!(command.name, "/*" | "*/") {
            continue;
        }
        if head < from {
            if let Some(index) = (head + 1..statement.end).find(|index| *index >= from) {
                return Some(WordAction::Other { index });
            }
            continue;
        }
        if command_acts(command, false, place) || (position == last && waits) {
            return Some(WordAction::Command {
                index: head,
                command: command.name,
            });
        }
        if let Some(index) = (head + 1..statement.end)
            .find(|index| words[*index].to_ascii_lowercase().contains("rnd("))
        {
            return Some(WordAction::Other { index });
        }
    }
    None
}

const MAXIMUM_DEFINITION_DEPTH: u32 = 16;

fn defined_word_action(
    word: &str,
    index: usize,
    place: WordPlace<'_>,
    definitions: &dyn Fn(&str) -> WordDefinitions,
    depth: u32,
) -> Option<WordAction> {
    let values = match definitions(word) {
        WordDefinitions::Undefined => return None,
        WordDefinitions::Unknown => return Some(WordAction::Other { index }),
        WordDefinitions::Values(values) => values,
    };
    for value in values {
        if let Ok(number) = value.parse::<f32>() {
            match dispatched_command(number) {
                DispatchedCommand::Nothing => {}
                DispatchedCommand::Command(command) => {
                    if command_acts(command, true, place) {
                        return Some(WordAction::Dispatch {
                            index,
                            command: command.name,
                        });
                    }
                }
                DispatchedCommand::OutsideCatalogue(id) => {
                    let crashes = match handler_state(place) {
                        Some(state) => crashes_in_connection_block(id, true, &state),
                        None => true,
                    };
                    if crashes {
                        return Some(WordAction::Other { index });
                    }
                }
                DispatchedCommand::CommentDelimiter | DispatchedCommand::Unsupported => {
                    return Some(WordAction::Other { index });
                }
            }
        } else if let Some(command) = find_strict_command(&value) {
            return Some(WordAction::Dispatch {
                index,
                command: command.name,
            });
        } else if depth >= MAXIMUM_DEFINITION_DEPTH {
            return Some(WordAction::Other { index });
        } else if let Some(action) =
            defined_word_action(&value, index, place, definitions, depth + 1)
        {
            return Some(action);
        }
    }
    None
}

fn handler_state<'a>(place: WordPlace<'a>) -> Option<HandlerState<'a>> {
    let brace_open = match place.braces {
        Braces::Outside => false,
        Braces::Inside(_) => true,
        Braces::Unknown => return None,
    };
    Some(HandlerState {
        section: place.section?,
        brace_open,
        land_range: true,
        land_range_from_create_land: true,
        elevation_range: true,
        object_descriptor: true,
        connection: true,
    })
}

fn command_acts(command: &StrictCommand, dispatched: bool, place: WordPlace<'_>) -> bool {
    if command.kind != StrictCommandKind::Descriptor || is_global_descriptor_command(command.name) {
        return true;
    }
    let (Some(state), Some(id)) = (handler_state(place), strict_command_id(command.name)) else {
        return true;
    };
    let id = id as i32;
    if dispatched {
        match null_token_slot(id, &state) {
            NullSlot::Crash(..) => return true,
            NullSlot::Nothing => return false,
            NullSlot::Zero => {}
        }
    } else if crashes_in_connection_block(id, first_slot_is_not_a_token(command), &state) {
        return true;
    }
    match place.braces {
        Braces::Outside => {
            section_rules(state.section).is_none_or(|rules| rules.contains(command.name))
        }
        Braces::Inside(Some(opener)) => descriptor_block(opener)
            .filter(|block| block.section() == state.section)
            .is_none_or(|block| block_rules(block).contains(command.name)),
        Braces::Inside(None) | Braces::Unknown => true,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WordCrash {
    pub index: usize,
    pub crash_id: &'static str,
    pub command: Option<&'static str>,
}

pub fn crashing_words(
    words: &[&str],
    place: WordPlace<'_>,
    definitions: &dyn Fn(&str) -> WordDefinitions,
) -> Vec<WordCrash> {
    CrashingWords::new(definitions).of_line(words, place)
}

type DispatchCrash = Option<(&'static str, Option<&'static str>)>;

pub struct CrashingWords<'w, 'd> {
    definitions: &'d dyn Fn(&str) -> WordDefinitions,
    dispatches: HashMap<&'w str, Vec<(HandlerState<'w>, DispatchCrash)>>,
}

impl<'w, 'd> CrashingWords<'w, 'd> {
    pub fn new(definitions: &'d dyn Fn(&str) -> WordDefinitions) -> Self {
        Self {
            definitions,
            dispatches: HashMap::new(),
        }
    }

    pub fn of_line(&mut self, words: &[&'w str], place: WordPlace<'w>) -> Vec<WordCrash> {
        let Some(mut state) = handler_state(place) else {
            return Vec::new();
        };
        state.land_range_from_create_land =
            !matches!(place.braces, Braces::Inside(Some("create_player_lands")));
        state.connection = matches!(
            place.braces,
            Braces::Inside(Some(opener)) if opener.starts_with("create_connect_")
        );
        if !(state.section == "connection_generation" && state.brace_open && state.connection)
            && words.iter().all(|word| find_strict_command(word).is_some())
        {
            return Vec::new();
        }
        let mut crashes = Vec::new();
        for statement in word_statement_ranges(words) {
            let head = statement.start;
            match find_strict_command(words[head]) {
                Some(command) => {
                    if command.kind == StrictCommandKind::Descriptor
                        && let Some(id) = strict_command_id(command.name)
                        && crashes_in_connection_block(
                            id as i32,
                            first_slot_is_not_a_token(command),
                            &state,
                        )
                    {
                        crashes.push(WordCrash {
                            index: head,
                            crash_id: crash_ids::CONNECTION_BLOCK_MISSING_TERRAIN,
                            command: None,
                        });
                    }
                }
                None => {
                    for index in statement {
                        if let Some((crash_id, command)) = self.dispatch_crash(words[index], &state)
                        {
                            crashes.push(WordCrash {
                                index,
                                crash_id,
                                command,
                            });
                        }
                    }
                }
            }
        }
        crashes
    }

    fn dispatch_crash(&mut self, word: &'w str, state: &HandlerState<'w>) -> DispatchCrash {
        let known = self.dispatches.entry(word).or_default();
        if let Some((_, crash)) = known.iter().find(|(seen, _)| seen == state) {
            return *crash;
        }
        let crash = defined_word_crash(word, state, self.definitions, 0);
        known.push((*state, crash));
        crash
    }
}

fn defined_word_crash(
    word: &str,
    state: &HandlerState<'_>,
    definitions: &dyn Fn(&str) -> WordDefinitions,
    depth: u32,
) -> Option<(&'static str, Option<&'static str>)> {
    let WordDefinitions::Values(values) = definitions(word) else {
        return None;
    };
    for value in values {
        if let Ok(number) = value.parse::<f32>() {
            let id = native_command_id(number);
            match dispatched_command(number) {
                DispatchedCommand::Command(command) => {
                    if let NullSlot::Crash(_, crash_id) = null_token_slot(id, state) {
                        let command = (crash_id != crash_ids::CONNECTION_BLOCK_MISSING_TERRAIN)
                            .then_some(command.name);
                        return Some((crash_id, command));
                    }
                }
                DispatchedCommand::OutsideCatalogue(_) | DispatchedCommand::Unsupported => {
                    if crashes_in_connection_block(id, true, state) {
                        return Some((crash_ids::CONNECTION_BLOCK_MISSING_TERRAIN, None));
                    }
                }
                DispatchedCommand::Nothing | DispatchedCommand::CommentDelimiter => {}
            }
        } else if find_strict_command(&value).is_none()
            && depth < MAXIMUM_DEFINITION_DEPTH
            && let Some(crash) = defined_word_crash(&value, state, definitions, depth + 1)
        {
            return Some(crash);
        }
    }
    None
}
