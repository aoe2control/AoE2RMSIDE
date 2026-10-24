mod builtins;
mod interp;
mod preview;
mod program;
mod random;
mod table;
mod text;
mod value;

pub use interp::{
    CallOutcome, Finding, FindingSeverity, RunOptions, RunReport, RunStatus, Stop, StopCode, Topic,
    call_function, run_start,
};
pub use preview::{
    ChangeKind, ChatLine, HostRecord, MAXIMUM_CHAT_BYTES, MAXIMUM_CHAT_LINES,
    MAXIMUM_RECORDED_CALLS, MAXIMUM_REPORT_CHANGES, MAXIMUM_VALUE_TEXT_BYTES, Operation,
    PreviewHost, PreviewPlayer, PreviewState, PreviewTiles, PreviewUnit, RecordedCall, StartChange,
    TechnologyCounts, bounded_text, technology_counts,
};
pub use program::{
    CompileErrors, ENGINE_CONSTANTS_ID, PrepareError, Program, XsFileSet, engine_constants, prepare,
};
pub use random::XsRandom;
pub use table::{CallClass, CallEntry, CallTable, MockKind, UnansweredReason, call_table};
pub use text::number_text;
pub use value::{Value, ValueKind};

pub const DEFAULT_STEP_LIMIT: u64 = 10_000_000;
pub const DEFAULT_CALL_DEPTH: u32 = 256;
pub const MAXIMUM_ARRAYS: usize = 4_096;
pub const MAXIMUM_ARRAY_ITEMS: usize = 1_000_000;
pub const MAXIMUM_TEXT_BYTES: usize = 64 * 1024;
pub const MAXIMUM_TEXT_TOTAL_BYTES: usize = 16 * 1024 * 1024;
pub const MAXIMUM_FINDINGS: usize = 200;
pub const RUN_STACK_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct HostCall<'a> {
    pub name: &'a str,
    pub class: CallClass,
    pub args: &'a [Value],
    pub source_id: Option<&'a rms_source::SourceId>,
    pub range: rms_source::ByteRange,
    pub context_player: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostAnswer {
    Value(Value),
    Void,
    Unanswered(Unanswered),
    IntArray { array: i32, items: Vec<i32> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum HostNote {
    Topic(Topic),
    Finding {
        code: &'static str,
        severity: FindingSeverity,
        message: String,
        arguments: Vec<(&'static str, String)>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unanswered {
    Reason(UnansweredReason),
    Unavailable(CallClass),
}

impl Unanswered {
    pub const fn argument(self) -> &'static str {
        match self {
            Self::Reason(reason) => reason.wire_name(),
            Self::Unavailable(CallClass::Chat) => "CHAT_UNAVAILABLE",
            Self::Unavailable(CallClass::Mocked) => "TIME_AND_FILES_UNAVAILABLE",
            Self::Unavailable(CallClass::RecordedChange) => "CHANGES_UNAVAILABLE",
            Self::Unavailable(_) => "MAP_UNAVAILABLE",
        }
    }

    pub const fn wire_reason(self) -> Option<UnansweredReason> {
        match self {
            Self::Reason(reason) => Some(reason),
            Self::Unavailable(_) => None,
        }
    }

    pub const fn text(self) -> &'static str {
        match self {
            Self::Reason(reason) => reason.text(),
            Self::Unavailable(CallClass::Chat) => "chat output is not available here",
            Self::Unavailable(CallClass::Mocked) => "game time and files are not available here",
            Self::Unavailable(CallClass::RecordedChange) => {
                "changes to the match are not available here"
            }
            Self::Unavailable(_) => "the generated map is not available here",
        }
    }
}

pub trait XsHost: Send {
    fn call(&mut self, call: &HostCall<'_>) -> HostAnswer;

    fn take_notes(&mut self) -> Vec<HostNote> {
        Vec::new()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoHost;

impl XsHost for NoHost {
    fn call(&mut self, call: &HostCall<'_>) -> HostAnswer {
        let reason = call_table()
            .ok()
            .and_then(|table| table.get(call.name))
            .and_then(|entry| entry.reason);
        HostAnswer::Unanswered(match reason {
            Some(reason) => Unanswered::Reason(reason),
            None => Unanswered::Unavailable(call.class),
        })
    }
}
