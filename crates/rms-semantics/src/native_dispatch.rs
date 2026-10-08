use crate::block_rules::{block_rules, descriptor_block, section_rules};
use crate::native_context::is_global_descriptor_command;
use crate::parser::{DispatchedCommand, dispatched_command, word_statements};
use crate::strict_commands::{
    StrictArgumentKind, StrictCommand, StrictCommandKind, dispatcher_handles_id,
    find_strict_command, strict_command_id,
};

pub const GAME_CRASH_CODE: &str = "RMS2042";

pub const UNSUPPORTED_DISPATCH_CODE: &str = "RMS2043";

pub(crate) fn native_command_id(value: f32) -> i32 {
    if value.is_nan() || !(-2_147_483_648.0..2_147_483_648.0).contains(&value) {
        i32::MIN
    } else {
        value.trunc() as i32
    }
}

#[derive(Clone, Copy, Debug, Default)]
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
    Crash(&'static str),
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
    let crash = NullSlot::Crash;
    match (state.section, id) {
        (_, 90) => crash("ai_info_map_type reads its missing map type"),
        (_, 121) => crash("effect_amount reads its missing effect"),
        (_, 124) => crash("effect_percent reads its missing effect"),
        ("player_setup", 98) => crash("guard_state reads its missing object"),
        ("cliff_generation", 142) => crash("cliff_type reads its missing cliff type"),
        ("land_generation", 19 | 102) if !state.brace_open => {
            crash("the land section reads the missing terrain")
        }
        ("land_generation", 21) if state.brace_open && state.land_range => {
            crash("terrain_type reads its missing terrain")
        }
        ("land_generation", 99)
            if state.brace_open && state.land_range && state.land_range_from_create_land =>
        {
            crash("assign_to reads its missing target")
        }
        ("terrain_generation", 43 | 104) if !state.brace_open => {
            crash("the terrain section reads the missing terrain")
        }
        ("objects_generation", 48) if !state.brace_open => NullSlot::Nothing,
        ("objects_generation", 56 | 114 | 116) if state.brace_open && state.object_descriptor => {
            crash("the object block reads the missing object or terrain")
        }
        ("elevation_generation", 19 | 102) if state.brace_open && state.elevation_range => {
            crash("the elevation block reads the missing terrain")
        }
        _ if crashes_in_connection_block(id, true, state) => {
            crash("the connection block reads the missing terrain")
        }
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
            NullSlot::Crash(_) => return true,
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
