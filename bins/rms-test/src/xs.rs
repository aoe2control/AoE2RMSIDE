use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Result, anyhow, bail};
use rms_content::CompatibleContentView;
use rms_protocol::v1;
use rms_source::{SourceCatalogRole, SourceId, SourceText};
use sha2::{Digest, Sha256};
use starlark::values::dict::AllocDict;
use starlark::values::float::StarlarkFloat;
use starlark::values::structs::AllocStruct;
use starlark::values::tuple::{AllocTuple, TupleRef};
use starlark::values::{Heap, UnpackValue, Value};
use xs_analysis::{XsBuild, XsFile};
use xs_eval::{
    CallOutcome, NoHost, PrepareError, Program, RunOptions, Stop, StopCode, Value as XsValue,
    XsFileSet,
};

use crate::{HostState, RunConfiguration};

const MAX_XS_ARGUMENTS: usize = 32;
const MAX_XS_PROGRAMS: usize = 64;

#[derive(Debug, Default)]
pub(crate) struct XsPrograms {
    programs: Mutex<BTreeMap<String, Arc<Program>>>,
    constants_used: AtomicBool,
    game_constants: OnceLock<v1::XsGameConstants>,
}

fn find_xs_source(config: &RunConfiguration, path: &str) -> Option<(String, SourceId, Arc<[u8]>)> {
    let wanted = path.to_ascii_lowercase();
    for catalog in config.source_catalogs.values() {
        let roots = &catalog.roots().opened_or_configured;
        for source in catalog.sources() {
            if source.role != SourceCatalogRole::ExternalXs {
                continue;
            }
            let lower = source.path.to_ascii_lowercase();
            let matches = lower == wanted
                || roots
                    .iter()
                    .any(|root| lower == format!("{}/{wanted}", root.to_ascii_lowercase()));
            if matches {
                return Some((
                    source.path.clone(),
                    source.source_id.clone(),
                    source.bytes.clone(),
                ));
            }
        }
    }
    None
}

pub(crate) fn xs_source(config: &RunConfiguration, path: &str) -> Result<String> {
    let value = path.replace('\\', "/");
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.contains(':')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("rms.xs() needs a relative path to an .xs file inside the open folder");
    }
    let extension = value
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    if extension.as_deref() != Some("xs") {
        bail!("rms.xs() needs a relative path to an .xs file inside the open folder");
    }
    if config.xs_constants.is_none() {
        bail!("rms.xs() needs the game's Constants.xs, which this run does not have");
    }
    if find_xs_source(config, &value).is_none() {
        bail!("{value} is not an XS file in the open folder");
    }
    Ok(value)
}

impl XsPrograms {
    pub(crate) fn constants_used(&self) -> bool {
        self.constants_used.load(Ordering::Relaxed)
    }

    fn game_constants(&self, text: &str) -> &v1::XsGameConstants {
        self.game_constants.get_or_init(|| v1::XsGameConstants {
            text: text.as_bytes().to_vec(),
            sha256: Sha256::digest(text.as_bytes()).to_vec(),
        })
    }

    fn program(&self, config: &RunConfiguration, path: &str) -> Result<Arc<Program>> {
        if let Some(program) = self
            .programs
            .lock()
            .expect("XS programs poisoned")
            .get(path)
        {
            return Ok(program.clone());
        }
        let constants = config.xs_constants.as_ref().ok_or_else(|| {
            anyhow!("rms.xs() needs the game's Constants.xs, which this run does not have")
        })?;
        self.constants_used.store(true, Ordering::Relaxed);
        let constants = XsFile::parse(SourceText::from_bytes(
            SourceId::new("game:///Constants.xs").expect("valid source id"),
            constants.as_bytes(),
        )?);
        let (_, root_id, _) = find_xs_source(config, path)
            .ok_or_else(|| anyhow!("{path} is not an XS file in the open folder"))?;
        let mut files = XsFileSet::new();
        let mut root = None;
        for catalog in config.source_catalogs.values() {
            for source in catalog.sources() {
                if source.role != SourceCatalogRole::ExternalXs || files.get(&source.path).is_some()
                {
                    continue;
                }
                let Ok(text) =
                    SourceText::from_bytes(source.source_id.clone(), source.bytes.clone())
                else {
                    continue;
                };
                let file = XsFile::parse(text);
                if source.source_id == root_id && root.is_none() {
                    root = Some(file.clone());
                }
                files.insert(&source.path, file);
            }
        }
        let root = root.ok_or_else(|| anyhow!("{path} is not readable XS text"))?;
        let build = XsBuild::from_profile_id(&config.profile.profile_id);
        let program = match xs_eval::prepare(&[root], &files, Some(constants), build) {
            Ok(program) => Arc::new(program),
            Err(PrepareError::CompileErrors(errors)) => {
                let count = errors.count();
                let first = errors.files.first().and_then(|(id, list)| {
                    list.first()
                        .map(|diagnostic| (display_path(config, id), diagnostic.message.clone()))
                });
                match first {
                    Some((file, message)) => bail!(
                        "rms.xs(\"{path}\") does not compile ({count} errors); first in {file}: {message}"
                    ),
                    None => bail!("rms.xs(\"{path}\") does not compile"),
                }
            }
            Err(PrepareError::Table(error)) => bail!("XS calls are unavailable: {error}"),
        };
        let mut programs = self.programs.lock().expect("XS programs poisoned");
        if programs.len() >= MAX_XS_PROGRAMS && !programs.contains_key(path) {
            bail!("a map test may call functions of at most {MAX_XS_PROGRAMS} XS files");
        }
        programs.insert(path.to_owned(), program.clone());
        Ok(program)
    }
}

fn display_path(config: &RunConfiguration, id: &SourceId) -> String {
    folder_path(config, id.as_str())
}

fn folder_path(config: &RunConfiguration, id: &str) -> String {
    for catalog in config.source_catalogs.values() {
        let Some(source) = catalog
            .sources()
            .iter()
            .find(|source| source.source_id.as_str() == id)
        else {
            continue;
        };
        for root in &catalog.roots().opened_or_configured {
            if let Some(path) = source
                .path
                .strip_prefix(root.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
            {
                return path.to_owned();
            }
        }
        return source.path.clone();
    }
    id.rsplit('/').next().unwrap_or(id).to_owned()
}

fn xs_argument(value: Value<'_>) -> Result<XsValue> {
    if let Some(flag) = value.unpack_bool() {
        return Ok(XsValue::Bool(flag));
    }
    if let Some(number) = value.unpack_i32() {
        return Ok(XsValue::Int(number));
    }
    if value.get_type() == "int" {
        bail!("rms.xs call arguments must fit a 32-bit XS int");
    }
    if let Some(number) = StarlarkFloat::unpack_value_opt(value) {
        return Ok(XsValue::Float(number.0 as f32));
    }
    if let Some(text) = value.unpack_str() {
        if text.len() > xs_eval::MAXIMUM_TEXT_BYTES {
            bail!("rms.xs call text arguments may hold at most 64 KiB");
        }
        return Ok(XsValue::text(text));
    }
    if let Some(tuple) = TupleRef::from_value(value)
        && tuple.len() == 3
    {
        let mut parts = [0.0f32; 3];
        for (slot, part) in parts.iter_mut().zip(tuple.content()) {
            *slot = if let Some(number) = part.unpack_i32() {
                number as f32
            } else if let Some(number) = StarlarkFloat::unpack_value_opt(*part) {
                number.0 as f32
            } else {
                bail!("an XS vector argument is a tuple of three numbers");
            };
        }
        return Ok(XsValue::Vector(parts));
    }
    bail!(
        "rms.xs call arguments must be int, float, bool, string, or a tuple of three numbers, not {}",
        value.get_type()
    )
}

fn starlark_result<'v>(heap: Heap<'v>, name: &str, value: XsValue) -> Result<Value<'v>> {
    Ok(match value {
        XsValue::Int(number) => heap.alloc(number),
        XsValue::Float(number) => heap.alloc(f64::from(number)),
        XsValue::Bool(flag) => Value::new_bool(flag),
        XsValue::Str(bytes) => heap.alloc(String::from_utf8_lossy(&bytes).into_owned()),
        XsValue::Vector([x, y, z]) => {
            heap.alloc(AllocTuple([f64::from(x), f64::from(y), f64::from(z)]))
        }
        XsValue::Void => Value::new_none(),
        XsValue::Object(_) => {
            bail!("{name} returns a class value, which map tests cannot read")
        }
    })
}

fn stop_text(stop: &Stop) -> String {
    let argument = |name: &str| {
        stop.arguments
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };
    match stop.code {
        StopCode::StepLimit => format!("it ran more than {} XS steps", argument("limit")),
        StopCode::CallDepth => format!("its calls nested deeper than {}", argument("depth")),
        StopCode::MemoryBound => {
            let bound = match argument("bound").as_str() {
                "arrays" => "arrays",
                "arrayItems" => "array items",
                "text" => "text in one value",
                _ => "text",
            };
            format!("it used more {bound} than an XS call may")
        }
        _ => stop.message.clone(),
    }
}

pub(crate) fn xs_call<'v>(
    host: &HostState,
    heap: Heap<'v>,
    path: &str,
    seed: i64,
    name: &str,
    args: &[Value<'v>],
) -> Result<Value<'v>> {
    host.check_running()?;
    let config = &host.context.config;
    if args.len() > MAX_XS_ARGUMENTS {
        bail!("an XS call may pass at most {MAX_XS_ARGUMENTS} arguments");
    }
    let program = host.xs_programs.program(config, path)?;
    let values = args
        .iter()
        .map(|value| xs_argument(*value))
        .collect::<Result<Vec<_>>>()?;
    let must_stop = || host.must_stop();
    let options = RunOptions {
        map_seed: seed,
        cancelled: Some(&must_stop),
        ..RunOptions::default()
    };
    let Some((outcome, _)) = xs_eval::call_function(&program, name, &values, &mut NoHost, &options)
    else {
        host.check_running()?;
        bail!("the XS call {name} was cancelled");
    };
    match outcome {
        CallOutcome::Returned(value) => starlark_result(heap, name, value),
        CallOutcome::NoSuchFunction => bail!("{path} has no XS function {name}"),
        CallOutcome::Stopped(stop) => {
            let place = match (&stop.source_id, stop.range) {
                (Some(id), Some(range)) => match program.line_of(id, range.start) {
                    Some(line) => format!(" at {}:{line}", display_path(config, id)),
                    None => format!(" in {}", display_path(config, id)),
                },
                _ => String::new(),
            };
            bail!(
                "the XS call {name} stopped{place} ({}): {}",
                stop.code.code(),
                stop_text(&stop)
            )
        }
    }
}

const NO_XS_FILES: &str = "no_xs_files";

pub(crate) fn sample_xs_start<'v>(
    host: &HostState,
    heap: Heap<'v>,
    handle: u32,
) -> Result<Value<'v>> {
    host.check_running()?;
    let config = &host.context.config;
    let Some(text) = config.xs_constants.as_deref() else {
        bail!("sample.xs_start() needs the game's Constants.xs, which this run does not have");
    };
    let record = crate::sample(host, handle)?;
    if record.failure.is_some() {
        bail!(
            "seed {} did not generate a map, so it has no XS start check",
            record.seed
        );
    }
    if record.xs_roots.is_empty() {
        let report = v1::XsStartReport {
            step_limit: xs_eval::DEFAULT_STEP_LIMIT,
            ..v1::XsStartReport::default()
        };
        return Ok(start_value(config, heap, &report, Some(NO_XS_FILES)));
    }
    let constants = host.xs_programs.game_constants(text);
    host.xs_programs
        .constants_used
        .store(true, Ordering::Relaxed);
    let map = crate::sample_map(host, handle)?;
    let prepared = crate::prepared_target(host, &record.source_path, record.settings_index)?;
    let mut request = prepared.request.clone();
    request.seed = record.seed;
    let content = CompatibleContentView::new(&config.content, &config.profile.profile_id)?;
    let technology_count = xs_eval::technology_counts()
        .ok()
        .and_then(|table| table.get(&host.context.content_identity.pack_id));
    let input = xs_start::XsStartInput {
        constants: Some(constants),
        roots: &record.xs_roots,
        catalog: config.source_catalogs.get(&*record.source_path),
        profile_id: &config.profile.profile_id,
        content,
        technology_count,
        request: &request,
        map: &map,
    };
    let must_stop = || host.must_stop();
    let report = match xs_start::xs_start_report(&input, &must_stop) {
        xs_start::XsStartOutcome::Report(report) => report,
        xs_start::XsStartOutcome::Cancelled => {
            host.check_running()?;
            bail!("sample.xs_start() was cancelled");
        }
    };
    host.charge_results(
        report.findings.len()
            + report.chat_lines.len()
            + report.changes.len()
            + report.compile_errors.len(),
    )?;
    Ok(start_value(config, heap, &report, None))
}

fn enum_word(name: &str, prefix: &str) -> String {
    name.strip_prefix(prefix)
        .unwrap_or(name)
        .to_ascii_lowercase()
}

fn optional_text<'v>(heap: Heap<'v>, text: &str) -> Value<'v> {
    if text.is_empty() {
        Value::new_none()
    } else {
        heap.alloc(text)
    }
}

fn place_values<'v>(
    config: &RunConfiguration,
    heap: Heap<'v>,
    source_id: &str,
    range: Option<&v1::SourceRange>,
) -> [Value<'v>; 3] {
    let file = if source_id.is_empty() {
        Value::new_none()
    } else {
        heap.alloc(folder_path(config, source_id))
    };
    let start = range.and_then(|range| range.start.as_ref());
    [
        file,
        start.map_or_else(Value::new_none, |start| heap.alloc(start.line)),
        start.map_or_else(Value::new_none, |start| heap.alloc(start.utf16_column)),
    ]
}

fn start_value<'v>(
    config: &RunConfiguration,
    heap: Heap<'v>,
    report: &v1::XsStartReport,
    status: Option<&str>,
) -> Value<'v> {
    let status = status.map_or_else(
        || {
            v1::XsStartStatus::try_from(report.status).map_or_else(
                |_| "unknown".to_owned(),
                |status| enum_word(status.as_str_name(), "XS_START_STATUS_"),
            )
        },
        str::to_owned,
    );
    let findings = report
        .findings
        .iter()
        .map(|finding| {
            let [file, line, column] =
                place_values(config, heap, &finding.source_id, finding.range.as_ref());
            let severity = match v1::DiagnosticSeverity::try_from(finding.severity) {
                Ok(v1::DiagnosticSeverity::Error) => "error",
                Ok(v1::DiagnosticSeverity::Warning) => "warning",
                _ => "info",
            };
            let arguments = heap.alloc(AllocDict(
                finding
                    .arguments
                    .iter()
                    .map(|argument| (argument.name.as_str(), argument.value.as_str())),
            ));
            heap.alloc(AllocStruct(vec![
                ("code", heap.alloc(finding.code.as_str())),
                ("severity", heap.alloc(severity)),
                ("message", heap.alloc(finding.message.as_str())),
                ("file", file),
                ("line", line),
                ("column", column),
                ("arguments", arguments),
            ]))
        })
        .collect::<Vec<_>>();
    let chat = report
        .chat_lines
        .iter()
        .map(|line| {
            let [file, number, column] =
                place_values(config, heap, &line.source_id, line.range.as_ref());
            heap.alloc(AllocStruct(vec![
                ("text", heap.alloc(line.text.as_str())),
                ("call", heap.alloc(line.call.as_str())),
                ("file", file),
                ("line", number),
                ("column", column),
            ]))
        })
        .collect::<Vec<_>>();
    let changes = report
        .changes
        .iter()
        .map(|change| {
            let [file, line, column] =
                place_values(config, heap, &change.source_id, change.range.as_ref());
            let kind = match v1::XsStartChangeKind::try_from(change.kind) {
                Ok(v1::XsStartChangeKind::Unspecified) | Err(_) => "other".to_owned(),
                Ok(kind) => enum_word(kind.as_str_name(), "XS_START_CHANGE_KIND_"),
            };
            let operation = match v1::XsStartOperation::try_from(change.operation) {
                Ok(v1::XsStartOperation::Unspecified) | Err(_) => Value::new_none(),
                Ok(operation) => {
                    heap.alloc(enum_word(operation.as_str_name(), "XS_START_OPERATION_"))
                }
            };
            let position = change.position.as_ref().map_or_else(Value::new_none, |at| {
                heap.alloc(AllocTuple([
                    f64::from(at.x),
                    f64::from(at.y),
                    f64::from(at.z),
                ]))
            });
            heap.alloc(AllocStruct(vec![
                ("player", heap.alloc(change.player)),
                ("kind", heap.alloc(kind)),
                ("operation", operation),
                ("target_id", heap.alloc(change.target_id)),
                ("target", optional_text(heap, &change.target_constant)),
                ("amount", heap.alloc(f64::from(change.amount))),
                ("count", heap.alloc(change.count)),
                ("position", position),
                ("text", optional_text(heap, &change.text)),
                ("value_id", heap.alloc(change.value_id)),
                ("calls", heap.alloc(change.calls)),
                ("call", heap.alloc(change.call.as_str())),
                ("file", file),
                ("line", line),
                ("column", column),
            ]))
        })
        .collect::<Vec<_>>();
    let stop = report.stop.as_ref().map_or_else(Value::new_none, |stop| {
        let [file, line, column] = place_values(config, heap, &stop.source_id, stop.range.as_ref());
        let reason = match v1::XsUnansweredReason::try_from(stop.reason) {
            Ok(v1::XsUnansweredReason::Unspecified) | Err(_) => Value::new_none(),
            Ok(reason) => heap.alloc(enum_word(reason.as_str_name(), "XS_UNANSWERED_REASON_")),
        };
        let message = report
            .findings
            .last()
            .filter(|finding| finding.code == stop.code)
            .map_or("", |finding| finding.message.as_str());
        heap.alloc(AllocStruct(vec![
            ("code", heap.alloc(stop.code.as_str())),
            ("message", heap.alloc(message)),
            ("call", optional_text(heap, &stop.call)),
            ("reason", reason),
            ("function", optional_text(heap, &stop.function)),
            ("in_rule", Value::new_bool(stop.in_rule)),
            ("file", file),
            ("line", line),
            ("column", column),
        ]))
    });
    let compile_errors = report
        .compile_errors
        .iter()
        .map(|errors| {
            heap.alloc(AllocStruct(vec![
                ("file", heap.alloc(folder_path(config, &errors.source_id))),
                ("errors", heap.alloc(errors.errors)),
            ]))
        })
        .collect::<Vec<_>>();
    let files = report
        .source_ids
        .iter()
        .map(|id| heap.alloc(folder_path(config, id)))
        .collect::<Vec<_>>();
    let topics = report
        .unconfirmed_topics
        .iter()
        .filter_map(|topic| v1::XsUnconfirmedTopic::try_from(*topic).ok())
        .map(|topic| heap.alloc(enum_word(topic.as_str_name(), "XS_UNCONFIRMED_TOPIC_")))
        .collect::<Vec<_>>();
    let unanswerable = report
        .unanswerable_calls
        .iter()
        .map(|call| heap.alloc(call.as_str()))
        .collect::<Vec<_>>();
    heap.alloc(AllocStruct(vec![
        ("status", heap.alloc(status)),
        ("files", heap.alloc(AllocTuple(files))),
        ("main_ran", Value::new_bool(report.main_ran)),
        ("rules_run", heap.alloc(report.rules_run)),
        ("steps", heap.alloc(report.steps)),
        ("step_limit", heap.alloc(report.step_limit)),
        ("random_draws", heap.alloc(report.random_draws)),
        ("findings", heap.alloc(AllocTuple(findings))),
        ("omitted_findings", heap.alloc(report.omitted_findings)),
        ("chat", heap.alloc(AllocTuple(chat))),
        ("omitted_chat", heap.alloc(report.omitted_chat_lines)),
        ("changes", heap.alloc(AllocTuple(changes))),
        ("omitted_changes", heap.alloc(report.omitted_changes)),
        ("stop", stop),
        ("compile_errors", heap.alloc(AllocTuple(compile_errors))),
        ("unanswerable_calls", heap.alloc(AllocTuple(unanswerable))),
        ("unconfirmed_topics", heap.alloc(AllocTuple(topics))),
    ]))
}
