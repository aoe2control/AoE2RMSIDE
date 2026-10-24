use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use prost::Message;
use rms_content::CompatibleContentView;
use rms_engine::{GameMode, GameModeModifier, GeneratedMap, GenerationRequest};
use rms_protocol::v1;
use rms_source::{ByteRange, SourceCatalog, SourceCatalogRole, SourceId, SourceText};
use sha2::{Digest, Sha256};
use xs_analysis::{XsBuild, XsFile};
use xs_eval::{
    ChangeKind, FindingSeverity, HostRecord, Operation, PrepareError, PreviewHost, PreviewPlayer,
    PreviewState, PreviewTiles, PreviewUnit, Program, RunOptions, RunReport, RunStatus, Topic,
    UnansweredReason, Value, XsFileSet,
};

const CONSTANTS_SOURCE_ID: &str = "game:///Constants.xs";
const MAXIMUM_MESSAGE_BYTES: usize = 1_024;
const MAXIMUM_FINDING_ARGUMENTS: usize = 8;

pub struct XsStartInput<'a> {
    pub constants: Option<&'a v1::XsGameConstants>,
    pub roots: &'a [SourceId],
    pub catalog: Option<&'a SourceCatalog>,
    pub profile_id: &'a str,
    pub content: CompatibleContentView<'a>,
    pub technology_count: Option<i32>,
    pub request: &'a GenerationRequest,
    pub map: &'a GeneratedMap,
}

pub enum XsStartOutcome {
    Report(Box<v1::XsStartReport>),
    Cancelled,
}

pub fn xs_start_report(
    input: &XsStartInput<'_>,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> XsStartOutcome {
    let mut report = v1::XsStartReport {
        contract_major: rms_protocol::XS_START_REPORT_MAJOR,
        contract_minor: rms_protocol::XS_START_REPORT_MINOR,
        verification: v1::XsStartVerification::NotCompared as i32,
        source_ids: input
            .roots
            .iter()
            .take(rms_protocol::MAX_XS_START_SOURCE_IDS)
            .map(|id| id.as_str().to_owned())
            .collect(),
        step_limit: xs_eval::DEFAULT_STEP_LIMIT,
        ..Default::default()
    };
    let Some(constants) = input.constants else {
        report.status = v1::XsStartStatus::SkippedNoConstants as i32;
        return XsStartOutcome::Report(Box::new(report));
    };
    report.constants_sha256 = constants.sha256.clone();
    let program = match prepared(input, constants) {
        Prepared::Program(program) => program,
        Prepared::CompileErrors(errors) => {
            report.status = v1::XsStartStatus::SkippedCompileErrors as i32;
            report.compile_errors = errors;
            return XsStartOutcome::Report(Box::new(report));
        }
    };

    let terrain: Vec<u32> = input.map.terrain.iter().map(|terrain| terrain.0).collect();
    let state = preview_state(input, &terrain);
    let mut host = PreviewHost::new(&state, &program);
    let unanswerable = host.unanswerable_calls(&program);
    let options = RunOptions {
        step_limit: xs_eval::DEFAULT_STEP_LIMIT,
        map_seed: i64::from(input.request.seed),
        cancelled: Some(cancelled),
    };
    let Some(run) = xs_eval::run_start(&program, &mut host, &options) else {
        return XsStartOutcome::Cancelled;
    };
    let record = host.into_record();
    report.omitted_unanswerable_calls = unanswerable
        .len()
        .saturating_sub(rms_protocol::MAX_XS_START_UNANSWERABLE_CALLS)
        as u32;
    report.unanswerable_calls = unanswerable
        .into_iter()
        .take(rms_protocol::MAX_XS_START_UNANSWERABLE_CALLS)
        .collect();
    fill_run(&mut report, &program, run, record);
    bound_report(&mut report);
    XsStartOutcome::Report(Box::new(report))
}

enum Prepared {
    Program(Arc<Program>),
    CompileErrors(Vec<v1::XsStartFileErrors>),
}

impl Clone for Prepared {
    fn clone(&self) -> Self {
        match self {
            Self::Program(program) => Self::Program(program.clone()),
            Self::CompileErrors(errors) => Self::CompileErrors(errors.clone()),
        }
    }
}

static PREPARED: Mutex<Option<([u8; 32], Prepared)>> = Mutex::new(None);

fn prepared(input: &XsStartInput<'_>, constants: &v1::XsGameConstants) -> Prepared {
    let key = prepared_key(input, constants);
    if let Some((cached, prepared)) = PREPARED
        .lock()
        .expect("XS start check cache poisoned")
        .as_ref()
        && *cached == key
    {
        return prepared.clone();
    }
    let prepared = compile(input, constants);
    *PREPARED.lock().expect("XS start check cache poisoned") = Some((key, prepared.clone()));
    prepared
}

fn prepared_key(input: &XsStartInput<'_>, constants: &v1::XsGameConstants) -> [u8; 32] {
    let mut hash = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    };
    field(b"rmside-xs-start-unit-v1");
    field(&constants.sha256);
    field(input.profile_id.as_bytes());
    for root in input.roots {
        field(root.as_str().as_bytes());
    }
    for source in external_xs_sources(input.catalog) {
        field(source.path.as_bytes());
        field(source.source_id.as_str().as_bytes());
        field(&source.raw_hash);
    }
    hash.finalize().into()
}

fn external_xs_sources(
    catalog: Option<&SourceCatalog>,
) -> impl Iterator<Item = &rms_source::CatalogSource> {
    catalog
        .into_iter()
        .flat_map(|catalog| catalog.sources())
        .filter(|source| source.role == SourceCatalogRole::ExternalXs)
}

fn compile(input: &XsStartInput<'_>, constants: &v1::XsGameConstants) -> Prepared {
    let one_error = |id: &SourceId| {
        Prepared::CompileErrors(vec![v1::XsStartFileErrors {
            source_id: id.as_str().to_owned(),
            errors: 1,
        }])
    };
    let constants_id = SourceId::new(CONSTANTS_SOURCE_ID).expect("valid source id");
    let Ok(constants_text) = SourceText::from_bytes(constants_id.clone(), constants.text.clone())
    else {
        return one_error(&constants_id);
    };
    let mut files = XsFileSet::new();
    let mut parsed: BTreeMap<&str, Arc<XsFile>> = BTreeMap::new();
    for source in external_xs_sources(input.catalog) {
        let Ok(text) = SourceText::from_bytes(source.source_id.clone(), source.bytes.clone())
        else {
            continue;
        };
        let file = XsFile::parse(text);
        parsed.insert(source.source_id.as_str(), file.clone());
        files.insert(&source.path, file);
    }
    let mut roots = Vec::with_capacity(input.roots.len());
    for root in input.roots {
        match parsed.get(root.as_str()) {
            Some(file) => roots.push(file.clone()),
            None => return one_error(root),
        }
    }
    match xs_eval::prepare(
        &roots,
        &files,
        Some(XsFile::parse(constants_text)),
        XsBuild::from_profile_id(input.profile_id),
    ) {
        Ok(program) => Prepared::Program(Arc::new(program)),
        Err(PrepareError::CompileErrors(errors)) => {
            let files: Vec<_> = errors
                .files
                .iter()
                .map(|(id, list)| v1::XsStartFileErrors {
                    source_id: id.as_str().to_owned(),
                    errors: u32::try_from(list.len()).unwrap_or(u32::MAX),
                })
                .collect();
            if files.is_empty() {
                input
                    .roots
                    .first()
                    .map_or(Prepared::CompileErrors(Vec::new()), one_error)
            } else {
                Prepared::CompileErrors(files)
            }
        }
        Err(PrepareError::Table(_)) => input
            .roots
            .first()
            .map_or(Prepared::CompileErrors(Vec::new()), one_error),
    }
}

fn preview_state<'a>(input: &XsStartInput<'a>, terrain: &'a [u32]) -> PreviewState<'a> {
    let request = input.request;
    let map = input.map;
    let mut players: Vec<PreviewPlayer> = request
        .players
        .iter()
        .map(|player| PreviewPlayer {
            number: i32::from(player.slot),
            team: player.team,
            civilization: player.civilization_id.0 as i32,
            color: i32::from(player.color),
            computer: request
                .setup_context
                .computer_player_slots
                .contains(player.slot),
        })
        .collect();
    players.sort_by_key(|player| player.number);
    let mut instance_ids: Vec<u32> = map
        .objects
        .iter()
        .map(|object| object.instance_id)
        .collect();
    instance_ids.sort_unstable();
    let distinct = instance_ids.windows(2).all(|pair| pair[0] != pair[1])
        && instance_ids
            .last()
            .is_none_or(|id| *id < i32::MAX as u32 / 2);
    let units = map
        .objects
        .iter()
        .enumerate()
        .map(|(index, object)| PreviewUnit {
            id: if distinct {
                object.instance_id as i32
            } else {
                i32::try_from(index + 1).unwrap_or(i32::MAX)
            },
            object_id: object.object_id.0 as i32,
            owner: i32::from(object.owner),
            position: [
                object.x_256 as f32 / 256.0,
                object.y_256 as f32 / 256.0,
                object.z_256 as f32 / 256.0,
            ],
        })
        .collect();
    let object_classes = input
        .content
        .objects()
        .iter()
        .map(|object| (object.id.0 as i32, object.class_id as i32))
        .collect();
    PreviewState {
        map_width: i32::from(map.dimensions.width),
        map_height: i32::from(map.dimensions.height),
        map_seed: request.seed as i32,
        map_file_name: map_file_name(&request.document_uri),
        players,
        units,
        object_classes,
        tiles: Some(PreviewTiles {
            width: usize::from(map.dimensions.width),
            height: usize::from(map.dimensions.height),
            terrain,
            elevation: &map.elevation,
            layer: &map.layer,
        }),
        technology_count: input.technology_count,
        game_mode_adds_objects: game_mode_adds_objects(request),
    }
}

fn game_mode_adds_objects(request: &GenerationRequest) -> bool {
    let context = &request.setup_context;
    matches!(
        context.game_mode,
        GameMode::Regicide
            | GameMode::KingOfTheHill
            | GameMode::DefendTheWonder
            | GameMode::BattleRoyale
            | GameMode::EmpireWars
    ) || [
        GameModeModifier::Regicide,
        GameModeModifier::KingOfTheHill,
        GameModeModifier::EmpireWars,
    ]
    .into_iter()
    .any(|modifier| context.lobby_options.game_mode_modifiers.contains(modifier))
}

fn map_file_name(uri: &str) -> String {
    let name = uri.rsplit(['/', '\\']).next().unwrap_or(uri);
    let bytes = name.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |byte: u8| (byte as char).to_digit(16);
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| name.to_owned())
}

fn fill_run(report: &mut v1::XsStartReport, program: &Program, run: RunReport, record: HostRecord) {
    let place = |source_id: Option<&SourceId>, range: ByteRange| place(program, source_id, range);
    report.main_ran = run.main_ran;
    report.rules_run = run.rules_run;
    report.steps = run.steps;
    report.step_limit = run.step_limit;
    report.random_draws = run.random_draws;
    report.unconfirmed_topics = run
        .topics
        .iter()
        .map(|topic| wire_topic(*topic) as i32)
        .collect();
    report.omitted_findings = run.omitted_findings;
    report.findings = run
        .findings
        .iter()
        .map(|finding| {
            let (source_id, range) = match finding.range {
                Some(range) => place(finding.source_id.as_ref(), range),
                None => (
                    finding
                        .source_id
                        .as_ref()
                        .map_or_else(String::new, |id| id.as_str().to_owned()),
                    None,
                ),
            };
            diagnostic(
                finding.code,
                finding.severity,
                &finding.message,
                &finding.arguments,
                source_id,
                range,
            )
        })
        .collect();
    match run.status {
        RunStatus::Completed => report.status = v1::XsStartStatus::Completed as i32,
        RunStatus::Stopped(stop) => {
            report.status = v1::XsStartStatus::Stopped as i32;
            let (source_id, range) = match stop.range {
                Some(range) => place(stop.source_id.as_ref(), range),
                None => (
                    stop.source_id
                        .as_ref()
                        .map_or_else(String::new, |id| id.as_str().to_owned()),
                    None,
                ),
            };
            if report.findings.len() >= rms_protocol::MAX_XS_START_FINDINGS {
                report
                    .findings
                    .truncate(rms_protocol::MAX_XS_START_FINDINGS - 1);
                report.omitted_findings = report.omitted_findings.saturating_add(1);
            }
            report.findings.push(diagnostic(
                stop.code.code(),
                stop.code.severity(),
                &stop.message,
                &stop.arguments,
                source_id.clone(),
                range,
            ));
            report.stop = Some(v1::XsStartStop {
                code: stop.code.code().to_owned(),
                source_id,
                range,
                function: bounded(stop.function.as_deref().unwrap_or_default()),
                in_rule: stop.in_rule,
                call: bounded(stop.call.as_deref().unwrap_or_default()),
                reason: stop
                    .reason
                    .and_then(|reason| reason.wire_reason())
                    .map_or(v1::XsUnansweredReason::Unspecified, wire_reason)
                    as i32,
            });
        }
    }
    report.omitted_chat_lines = record.omitted_chat_lines;
    report.chat_lines = record
        .chat_lines
        .iter()
        .map(|line| {
            let (source_id, range) = place(line.source_id.as_ref(), line.range);
            v1::XsChatLine {
                text: line.text.clone(),
                call: line.call.clone(),
                source_id,
                range,
            }
        })
        .collect();
    report.omitted_changes = record.omitted_changes;
    report.changes = record
        .changes
        .iter()
        .map(|change| {
            let (source_id, range) = place(change.source_id.as_ref(), change.range);
            v1::XsStartChange {
                player: change.player,
                kind: wire_kind(change.kind) as i32,
                target_id: change.target_id,
                target_constant: change.target_constant.clone(),
                operation: wire_operation(change.operation) as i32,
                amount: change.amount,
                count: change.count,
                position: change.position.map(|[x, y, z]| v1::XsVector { x, y, z }),
                text: change.text.clone(),
                value_id: change.value_id,
                calls: change.calls,
                call: change.call.clone(),
                source_id,
                range,
            }
        })
        .collect();
    report.omitted_recorded_calls = record.omitted_recorded_calls;
    report.recorded_calls = record
        .recorded_calls
        .iter()
        .map(|call| {
            let (source_id, range) = place(call.source_id.as_ref(), call.range);
            v1::XsRecordedCall {
                name: call.name.clone(),
                arguments: call.args.iter().map(xs_value).collect(),
                result: call.result.as_ref().map(xs_value),
                source_id,
                range,
            }
        })
        .collect();
}

fn place(
    program: &Program,
    source_id: Option<&SourceId>,
    range: ByteRange,
) -> (String, Option<v1::SourceRange>) {
    let Some(source_id) = source_id else {
        return (String::new(), None);
    };
    let position = |offset| {
        program
            .report_position(source_id, offset)
            .map(|(line, utf16_column)| v1::SourcePosition { line, utf16_column })
    };
    let range = match (position(range.start), position(range.end)) {
        (Some(start), Some(end)) => Some(v1::SourceRange {
            start: Some(start),
            end: Some(end),
            byte_start: u64::from(range.start.0),
            byte_end: u64::from(range.end.0),
        }),
        _ => None,
    };
    (source_id.as_str().to_owned(), range)
}

fn diagnostic(
    code: &str,
    severity: FindingSeverity,
    message: &str,
    arguments: &[(&'static str, String)],
    source_id: String,
    range: Option<v1::SourceRange>,
) -> v1::Diagnostic {
    let mut arguments: Vec<v1::MessageArgument> = arguments
        .iter()
        .map(|(name, value)| v1::MessageArgument {
            name: (*name).to_owned(),
            value: bounded(value),
        })
        .collect();
    arguments.sort_by(|left, right| left.name.cmp(&right.name));
    arguments.dedup_by(|left, right| left.name == right.name);
    arguments.truncate(MAXIMUM_FINDING_ARGUMENTS);
    v1::Diagnostic {
        code: code.to_owned(),
        message: xs_eval::bounded_text(message, MAXIMUM_MESSAGE_BYTES),
        severity: match severity {
            FindingSeverity::Error => v1::DiagnosticSeverity::Error,
            FindingSeverity::Warning => v1::DiagnosticSeverity::Warning,
            FindingSeverity::Information => v1::DiagnosticSeverity::Information,
        } as i32,
        source_id,
        range,
        known_crash: None,
        arguments,
    }
}

fn bounded(text: &str) -> String {
    xs_eval::bounded_text(text, rms_protocol::MAX_XS_VALUE_TEXT_BYTES)
}

fn xs_value(value: &Value) -> v1::XsValue {
    use v1::xs_value::Kind;
    let kind = match value {
        Value::Int(value) => Some(Kind::IntValue(*value)),
        Value::Float(value) => Some(Kind::FloatValue(*value)),
        Value::Bool(value) => Some(Kind::BoolValue(*value)),
        Value::Str(bytes) => Some(Kind::StringValue(bounded(&String::from_utf8_lossy(bytes)))),
        Value::Vector([x, y, z]) => Some(Kind::VectorValue(v1::XsVector {
            x: *x,
            y: *y,
            z: *z,
        })),
        Value::Object(_) | Value::Void => None,
    };
    v1::XsValue { kind }
}

const fn wire_topic(topic: Topic) -> v1::XsUnconfirmedTopic {
    match topic {
        Topic::IntegerArithmetic => v1::XsUnconfirmedTopic::IntegerArithmetic,
        Topic::MixedNumbers => v1::XsUnconfirmedTopic::MixedNumbers,
        Topic::NumberText => v1::XsUnconfirmedTopic::NumberText,
        Topic::TextFunctions => v1::XsUnconfirmedTopic::TextFunctions,
        Topic::ArrayDefaults => v1::XsUnconfirmedTopic::ArrayDefaults,
        Topic::RuleOrder => v1::XsUnconfirmedTopic::RuleOrder,
        Topic::Goto => v1::XsUnconfirmedTopic::Goto,
        Topic::StartDefaults => v1::XsUnconfirmedTopic::StartDefaults,
    }
}

const fn wire_reason(reason: UnansweredReason) -> v1::XsUnansweredReason {
    match reason {
        UnansweredReason::LobbySetting => v1::XsUnansweredReason::LobbySetting,
        UnansweredReason::ObjectData => v1::XsUnansweredReason::ObjectData,
        UnansweredReason::TechnologyData => v1::XsUnansweredReason::TechnologyData,
        UnansweredReason::TextTable => v1::XsUnansweredReason::TextTable,
        UnansweredReason::GameRuntime => v1::XsUnansweredReason::GameRuntime,
        UnansweredReason::NotInMapScripts => v1::XsUnansweredReason::NotInMapScripts,
        UnansweredReason::UnknownCall => v1::XsUnansweredReason::UnknownCall,
    }
}

const fn wire_kind(kind: ChangeKind) -> v1::XsStartChangeKind {
    match kind {
        ChangeKind::Other => v1::XsStartChangeKind::Unspecified,
        ChangeKind::Resource => v1::XsStartChangeKind::Resource,
        ChangeKind::Technology => v1::XsStartChangeKind::Technology,
        ChangeKind::Diplomacy => v1::XsStartChangeKind::Diplomacy,
        ChangeKind::PlayerName => v1::XsStartChangeKind::PlayerName,
        ChangeKind::CivilizationName => v1::XsStartChangeKind::CivilizationName,
        ChangeKind::PlayerColor => v1::XsStartChangeKind::PlayerColor,
        ChangeKind::ColorMood => v1::XsStartChangeKind::ColorMood,
        ChangeKind::UnitsCreated => v1::XsStartChangeKind::UnitsCreated,
        ChangeKind::UnitsRemoved => v1::XsStartChangeKind::UnitsRemoved,
        ChangeKind::UnitsMoved => v1::XsStartChangeKind::UnitsMoved,
        ChangeKind::UnitsOwnerChanged => v1::XsStartChangeKind::UnitsOwnerChanged,
        ChangeKind::UnitValues => v1::XsStartChangeKind::UnitValues,
        ChangeKind::UnitText => v1::XsStartChangeKind::UnitText,
        ChangeKind::ObjectData => v1::XsStartChangeKind::ObjectData,
        ChangeKind::TechnologyData => v1::XsStartChangeKind::TechnologyData,
    }
}

const fn wire_operation(operation: Operation) -> v1::XsStartOperation {
    match operation {
        Operation::None => v1::XsStartOperation::Unspecified,
        Operation::Set => v1::XsStartOperation::Set,
        Operation::Add => v1::XsStartOperation::Add,
        Operation::Multiply => v1::XsStartOperation::Multiply,
    }
}

pub fn bound_report(report: &mut v1::XsStartReport) {
    let excess = |report: &v1::XsStartReport| {
        report
            .encoded_len()
            .saturating_sub(rms_protocol::MAX_XS_START_REPORT_BYTES)
    };
    loop {
        let over = excess(report);
        if over == 0 {
            return;
        }
        let cut = if !report.recorded_calls.is_empty() {
            trim(&mut report.recorded_calls, over)
        } else if !report.chat_lines.is_empty() {
            trim(&mut report.chat_lines, over)
        } else if !report.changes.is_empty() {
            trim(&mut report.changes, over)
        } else {
            return;
        };
        let omitted = if cut.0 == Cut::Calls {
            &mut report.omitted_recorded_calls
        } else if cut.0 == Cut::Chat {
            &mut report.omitted_chat_lines
        } else {
            &mut report.omitted_changes
        };
        *omitted = omitted.saturating_add(cut.1);
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Cut {
    Calls,
    Chat,
    Changes,
}

trait Trimmed {
    const CUT: Cut;
}

impl Trimmed for v1::XsRecordedCall {
    const CUT: Cut = Cut::Calls;
}

impl Trimmed for v1::XsChatLine {
    const CUT: Cut = Cut::Chat;
}

impl Trimmed for v1::XsStartChange {
    const CUT: Cut = Cut::Changes;
}

fn trim<T: Message + Trimmed>(items: &mut Vec<T>, bytes: usize) -> (Cut, u32) {
    let mut freed = 0;
    let mut cut = 0;
    while freed < bytes && cut < items.len() {
        freed += items[items.len() - 1 - cut].encoded_len() + 2;
        cut += 1;
    }
    items.truncate(items.len() - cut);
    (T::CUT, u32::try_from(cut).unwrap_or(u32::MAX))
}
