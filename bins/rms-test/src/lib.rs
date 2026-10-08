#![allow(clippy::too_many_arguments)]

mod machine;
mod retained;
mod source_batch;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
pub use machine::{
    MAX_WORKERS, MachineResources, SYSTEM_MEMORY_HEADROOM_BYTES, WorkerSetting,
    estimated_worker_peak_bytes, plan_workers, processor_workers,
};
use retained::{CompactMap, Lookup, RetainedStore, SampleRecord};
use rms_analysis::{PreparedCatalogAnalysis, product_strict_options, require_catalog_vocabulary};
use rms_content::{CompatibleContentView, ContentPackIdentity, NeutralContentPack};
use rms_engine::{
    AtomicCancellationToken, CancellationToken, ConnectionKind, ExactRmsGenerationBackend,
    ExecutionCostCollector, ExecutionCostSummary, GeneratedMap, GenerationBackend,
    GenerationRequest, MapCoordinate, MapDimensions, PlayerConfiguration, ResolvedGenerationInput,
    SetupContext, VisualCheckpoint, VisualCheckpointObserver, observe_exact_script_parse,
};
use rms_profile::BehaviorProfile;
use rms_source::SourceCatalog;
use rms_trace::{BoundedEventBuffer, TraceLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use starlark::any::ProvidesStaticType;
use starlark::docs::DocModule;
use starlark::environment::{GlobalsBuilder, LibraryExtension, Module};
use starlark::eval::Evaluator;
use starlark::syntax::{AstModule, Dialect};
use starlark::values::none::NoneType;
use starlark::values::structs::AllocStruct;
use starlark::values::tuple::{AllocTuple, UnpackTuple};
use starlark::values::typing::StarlarkNever;
use starlark::values::{Heap, Value};
use starlark::{PrintHandler, starlark_module};

pub const SEMANTIC_API_MAJOR: u32 = 2;
pub const REPORT_SCHEMA_VERSION: &str = "1.1.0";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ReportSchema {
    Legacy,
    #[default]
    RequestRevision,
}

pub const MAX_SCRIPT_BYTES: usize = 1024 * 1024;
pub const MAX_INTERPRETER_TICKS: u64 = 10_000_000;
pub const MAX_CALL_DEPTH: usize = 32;
pub const MAX_GENERATED_MAPS: usize = 4_096;
pub const MAX_WALL_TIME: Duration = Duration::from_secs(10 * 60);
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_OUTPUT_MESSAGES: usize = 10_000;
pub const MAX_OUTPUT_MESSAGE_BYTES: usize = 8 * 1024;
pub const MAX_FINDINGS: usize = 4_096;
pub const MAX_MEASUREMENTS: usize = 32;
pub const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;
pub const PROCESS_MEMORY_LIMIT_BYTES: usize = 2 * 1024 * 1024 * 1024;
pub const MAX_PROCESS_MEMORY_LIMIT_BYTES: usize = 8 * 1024 * 1024 * 1024;
pub const MAX_SCRIPT_NESTING: usize = 200;
pub const MAX_SCRIPT_BLOCK_NESTING: usize = 100;
pub const MAX_CONSTANT_SEQUENCE: u64 = 16 * 1024 * 1024;
pub const MAX_PRINTED_VALUE_DEPTH: usize = 1_000;
pub const MAX_PRINTED_VALUES: usize = 100_000;
pub const MAX_HOST_RESULTS_PER_CALL: usize = 2 * 512 * 512;
pub const MAX_HOST_RESULTS_PER_RUN: usize = 2 * 1024 * 1024;
pub const EVALUATION_STACK_BYTES: usize = 256 * 1024 * 1024;
pub mod memory {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{MAX_PROCESS_MEMORY_LIMIT_BYTES, PROCESS_MEMORY_LIMIT_BYTES};

    pub static LIVE_HEAP_BYTES: AtomicUsize = AtomicUsize::new(0);
    pub const SOFT_LIMIT_MARGIN_BYTES: usize = 192 * 1024 * 1024;
    static PROCESS_LIMIT_BYTES: AtomicUsize = AtomicUsize::new(PROCESS_MEMORY_LIMIT_BYTES);

    pub fn scaled_process_limit(available_memory_bytes: u64) -> usize {
        const MIB: usize = 1024 * 1024;
        let half = usize::try_from(available_memory_bytes / 2).unwrap_or(usize::MAX);
        half.clamp(PROCESS_MEMORY_LIMIT_BYTES, MAX_PROCESS_MEMORY_LIMIT_BYTES) / MIB * MIB
    }

    pub fn set_process_limit_bytes(bytes: usize) {
        PROCESS_LIMIT_BYTES.store(
            bytes.clamp(PROCESS_MEMORY_LIMIT_BYTES, MAX_PROCESS_MEMORY_LIMIT_BYTES),
            Ordering::Relaxed,
        );
    }

    pub fn process_limit_bytes() -> usize {
        PROCESS_LIMIT_BYTES.load(Ordering::Relaxed)
    }

    pub fn soft_limit_bytes() -> usize {
        process_limit_bytes() - SOFT_LIMIT_MARGIN_BYTES
    }

    pub fn over_soft_limit() -> bool {
        LIVE_HEAP_BYTES.load(Ordering::Relaxed) > soft_limit_bytes()
    }

    thread_local! {
        static THREAD_LIVE: Cell<isize> = const { Cell::new(0) };
        static THREAD_PEAK: Cell<isize> = const { Cell::new(0) };
    }

    #[inline]
    pub fn record_allocation(bytes: usize) {
        LIVE_HEAP_BYTES.fetch_add(bytes, Ordering::Relaxed);
        let _ = THREAD_LIVE.try_with(|live| {
            let now = live.get().saturating_add(bytes as isize);
            live.set(now);
            let _ = THREAD_PEAK.try_with(|peak| {
                if now > peak.get() {
                    peak.set(now);
                }
            });
        });
    }

    #[inline]
    pub fn record_deallocation(bytes: usize) {
        LIVE_HEAP_BYTES.fetch_sub(bytes, Ordering::Relaxed);
        let _ = THREAD_LIVE.try_with(|live| live.set(live.get().saturating_sub(bytes as isize)));
    }

    pub fn reset_thread_peak() {
        let _ = THREAD_LIVE.try_with(|live| live.set(0));
        let _ = THREAD_PEAK.try_with(|peak| peak.set(0));
    }

    pub fn thread_peak_bytes() -> u64 {
        THREAD_PEAK
            .try_with(|peak| peak.get().max(0) as u64)
            .unwrap_or(0)
    }
}

pub fn language_environment() -> DocModule {
    let mut documentation = GlobalsBuilder::extended_by(&[LibraryExtension::StructType])
        .with(host_globals)
        .build()
        .documentation();
    documentation
        .members
        .retain(|name, _| !name.starts_with("__rms_"));
    documentation
}
const MAX_STARLARK_HEAP_BYTES: usize = 512 * 1024 * 1024;
const MAX_RETAINED_MAP_BYTES: u64 = 1280 * 1024 * 1024;
const RUNTIME_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryBudget {
    pub retained_maps: u64,
    pub in_flight: u64,
}

impl MemoryBudget {
    pub fn for_process(process_bytes: u64) -> Self {
        let shared = process_bytes
            .saturating_sub(MAX_STARLARK_HEAP_BYTES as u64)
            .saturating_sub(RUNTIME_HEADROOM_BYTES);
        let retained_maps = (shared / 2).min(MAX_RETAINED_MAP_BYTES);
        Self {
            retained_maps,
            in_flight: shared - retained_maps,
        }
    }
}

const HOST_PRELUDE: &str = r#"
def _rms_map(handle):
    return struct(
        width = __rms_map_width(handle),
        height = __rms_map_height(handle),
        hash = __rms_map_hash(handle),
        tile = lambda x, y: __rms_map_tile(handle, x, y),
        tiles = lambda terrain_ids = None, land_zone_ids = None, terrain_zone_ids = None, layer_ids = None: __rms_map_tiles(handle, terrain_ids, land_zone_ids, terrain_zone_ids, layer_ids),
        count_tiles = lambda terrain_ids = None, land_zone_ids = None, terrain_zone_ids = None, layer_ids = None: __rms_map_count_tiles(handle, terrain_ids, land_zone_ids, terrain_zone_ids, layer_ids),
        objects = lambda object_ids = None, owner = None: __rms_map_objects(handle, False, owner, object_ids),
        walls = lambda object_ids = None, owner = None: __rms_map_objects(handle, True, owner, object_ids),
        cliffs = lambda cliff_types = None: __rms_map_cliffs(handle, cliff_types),
        connections = lambda kinds = None: __rms_map_connections(handle, kinds),
        neighbors = lambda x, y, diagonal = False: __rms_map_neighbors(handle, x, y, diagonal),
        manhattan_distance = lambda x1, y1, x2, y2: __rms_manhattan(x1, y1, x2, y2),
        chebyshev_distance = lambda x1, y1, x2, y2: __rms_chebyshev(x1, y1, x2, y2),
        squared_distance = lambda x1, y1, x2, y2: __rms_squared(x1, y1, x2, y2),
        boundaries = lambda terrain_ids = None, land_zone_ids = None, terrain_zone_ids = None, layer_ids = None: __rms_map_boundaries(handle, terrain_ids, land_zone_ids, terrain_zone_ids, layer_ids),
        components = lambda terrain_ids = None, land_zone_ids = None, terrain_zone_ids = None, layer_ids = None: __rms_map_components(handle, terrain_ids, land_zone_ids, terrain_zone_ids, layer_ids),
        connected = lambda x1, y1, x2, y2, terrain_ids = None, land_zone_ids = None, terrain_zone_ids = None, layer_ids = None: __rms_map_connected(handle, x1, y1, x2, y2, terrain_ids, land_zone_ids, terrain_zone_ids, layer_ids),
    )

def _rms_sample(handle):
    return struct(
        seed = __rms_sample_seed(handle),
        map = _rms_map(handle),
        request_hash = __rms_sample_request_hash(handle),
        map_hash = __rms_map_hash(handle),
        warnings = __rms_sample_warnings(handle),
        metrics = __rms_sample_metrics(handle),
        expect = lambda condition, message, values = None, code = None: __rms_expect(handle, condition, message, code, values),
        report = lambda message, values = None, code = None: __rms_report(handle, message, code, values),
    )

def _rms_generate(target, seeds, preview = True):
    return tuple([_rms_sample(handle) for handle in __rms_generate(target, seeds, preview)])

rms = struct(source = __rms_source, seeds = __rms_seeds, generate = _rms_generate, id = __rms_id)
"#;

#[derive(Clone, Debug)]
pub struct RunConfiguration {
    pub script: Vec<u8>,
    pub script_name: String,
    pub workspace_name: String,
    pub default_source_path: Option<String>,
    pub source_catalogs: BTreeMap<String, SourceCatalog>,
    pub profile: BehaviorProfile,
    pub content: NeutralContentPack,
    pub dimensions: MapDimensions,
    pub map_size: String,
    pub players: Vec<PlayerConfiguration>,
    pub setup_context: SetupContext,
    pub workers: WorkerSetting,
    pub machine: Option<MachineResources>,
    pub retained_map_budget: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Passed,
    Failed,
    Error,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub output: Vec<String>,
    pub report: Option<MapTestReport>,
    pub diagnostic: Option<RunDiagnostic>,
    pub preview: Option<PreviewSample>,
    pub statistics: RunStatistics,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RunStatistics {
    pub max_workers: usize,
    pub worker_peak_bytes: u64,
    pub retained_peak_bytes: u64,
    pub retained_budget_bytes: u64,
    pub dropped_maps: u64,
    pub regenerated_maps: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDiagnostic {
    pub code: String,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct PreviewSample {
    pub seed: u32,
    pub source_path: String,
    pub source_graph_hash: [u8; 32],
    pub request_hash: [u8; 32],
    pub map_hash: [u8; 32],
    pub map: Arc<GeneratedMap>,
    pub execution_cost: Option<ExecutionCostSummary>,
}

pub type PreviewCallback = Arc<dyn Fn(u32, PreviewSample) -> Result<()> + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CandidateSample {
    pub ordinal: u32,
    pub seed: u32,
}

pub type CandidateCallback = Arc<dyn Fn(CandidateSample, VisualCheckpoint) -> bool + Send + Sync>;

#[derive(Clone)]
pub struct ProgressivePreview {
    pub publish: CandidateCallback,
    pub revoke: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Debug, Default)]
struct LeaseState {
    holder: Option<u32>,
    revoked: bool,
    revision_offset: u64,
    last_revision: u64,
}

struct ProgressiveLease {
    preview: ProgressivePreview,
    state: Mutex<LeaseState>,
    active: AtomicBool,
}

impl ProgressiveLease {
    fn new(preview: ProgressivePreview) -> Self {
        Self {
            preview,
            state: Mutex::new(LeaseState {
                revoked: true,
                ..LeaseState::default()
            }),
            active: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LeaseState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn begin_batch(&self) {
        let mut state = self.lock();
        state.holder = None;
        state.revoked = false;
        self.active.store(true, Ordering::Release);
    }

    fn revoke(&self) {
        let mut state = self.lock();
        let had_holder = state.holder.take().is_some() || !state.revoked;
        state.revoked = true;
        self.active.store(false, Ordering::Release);
        drop(state);
        if had_holder {
            (self.preview.revoke)();
        }
    }

    fn try_acquire(&self, ordinal: u32) -> bool {
        let mut state = self.lock();
        if state.revoked {
            return false;
        }
        match state.holder {
            Some(holder) => holder == ordinal,
            None => {
                state.holder = Some(ordinal);
                true
            }
        }
    }

    fn release(&self, ordinal: u32) {
        let mut state = self.lock();
        if state.holder == Some(ordinal) {
            state.holder = None;
        }
    }

    fn publish(&self, sample: CandidateSample, mut checkpoint: VisualCheckpoint) -> bool {
        let mut state = self.lock();
        if state.revoked || state.holder != Some(sample.ordinal) {
            return false;
        }
        if checkpoint.is_keyframe() {
            state.revision_offset = state.last_revision;
        } else {
            checkpoint.base_revision += state.revision_offset;
        }
        checkpoint.revision += state.revision_offset;
        state.last_revision = checkpoint.revision;
        (self.preview.publish)(sample, checkpoint)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapTestReport {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: String,
    pub compatibility: ReportCompatibility,
    pub semantic_api_major: u32,
    pub report_identity: String,
    pub status: RunStatus,
    pub script: ScriptIdentity,
    pub workspace_name: String,
    pub engine_version: String,
    pub protocol_version: String,
    pub profile: ArtifactIdentity,
    pub content: ArtifactIdentity,
    pub settings: ReportSettings,
    pub generated_maps: u32,
    pub assertion_count: u32,
    pub findings: Vec<Finding>,
    pub output: Vec<String>,
    pub preview: Option<PreviewIdentity>,
}

impl MapTestReport {
    pub fn use_legacy_schema(&mut self) -> Result<()> {
        self.schema_version = "1.0.0".to_owned();
        for finding in &mut self.findings {
            finding.request_document_revision = None;
        }
        self.report_identity.clear();
        self.report_identity = hex::encode(Sha256::digest(serde_json::to_vec(self)?));
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptIdentity {
    pub name: String,
    pub semantic_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCompatibility {
    pub minimum_major: u32,
    pub maximum_major: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIdentity {
    pub id: String,
    pub version: String,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSettings {
    pub width: u16,
    pub height: u16,
    pub map_size: String,
    pub players: Vec<PlayerConfiguration>,
    pub setup_context: SetupContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewIdentity {
    pub seed: u32,
    pub request_hash: String,
    pub map_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub finding_id: String,
    pub assertion_id: String,
    pub code: Option<String>,
    pub message: String,
    pub script_line: u32,
    pub script_column: u32,
    pub seed: u32,
    pub source_path: String,
    pub source_graph_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_document_revision: Option<String>,
    pub request_hash: String,
    pub map_hash: String,
    pub measurements: BTreeMap<String, JsonValue>,
}

#[derive(Clone, Debug)]
struct RunnerContext {
    config: Arc<RunConfiguration>,
    script_hash: [u8; 32],
    profile_hash: [u8; 32],
    content_hash: [u8; 32],
    content_identity: ContentPackIdentity,
    constants: Arc<BTreeMap<String, String>>,
    budget: MemoryBudget,
}

#[derive(Clone, Debug)]
struct GeneratedSample {
    record: SampleRecord,
    map: GeneratedMap,
}

#[derive(Debug, Default)]
struct MutableState {
    findings: Vec<Finding>,
    output: Vec<String>,
    output_bytes: usize,
    generated_maps: usize,
    assertion_count: u32,
    assertion_ordinals: BTreeMap<(u32, u32), u32>,
    occurrence_ordinals: BTreeMap<String, u32>,
    host_results: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SampleProgress {
    pub completed: u32,
    pub requested: u32,
}

pub type ProgressCallback = Arc<dyn Fn(SampleProgress) + Send + Sync>;

#[derive(Clone, Default)]
pub struct RunObservers {
    pub preview: Option<PreviewCallback>,
    pub progressive: Option<ProgressivePreview>,
    pub progress: Option<ProgressCallback>,
}

struct ProgressReporter {
    callback: ProgressCallback,
    state: Mutex<SampleProgress>,
}

impl ProgressReporter {
    fn new(callback: ProgressCallback) -> Self {
        Self {
            callback,
            state: Mutex::new(SampleProgress::default()),
        }
    }

    fn update(&self, change: impl FnOnce(&mut SampleProgress)) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        change(&mut state);
        (self.callback)(*state);
    }
}

struct PreparedTarget {
    target: String,
    source_path: Arc<str>,
    source_graph_hash: [u8; 32],
    analysis: PreparedCatalogAnalysis,
    request: GenerationRequest,
}

const PREPARED_TARGETS: usize = 4;

#[derive(ProvidesStaticType)]
struct HostState {
    context: RunnerContext,
    mutable: Mutex<MutableState>,
    retained: Mutex<RetainedStore>,
    prepared: Mutex<VecDeque<Arc<PreparedTarget>>>,
    measured_peak: AtomicU64,
    regenerated: AtomicU64,
    max_workers: AtomicUsize,
    cancellation: Arc<AtomicCancellationToken>,
    started: Instant,
    preview_callback: Option<PreviewCallback>,
    progressive: Option<Arc<ProgressiveLease>>,
    progress: Option<ProgressReporter>,
    memory_limited: AtomicBool,
}

impl HostState {
    fn must_stop(&self) -> bool {
        if memory::over_soft_limit() {
            self.memory_limited.store(true, Ordering::Relaxed);
            return true;
        }
        self.cancellation.is_cancelled() || self.started.elapsed() >= MAX_WALL_TIME
    }

    fn check_running(&self) -> Result<()> {
        if self.must_stop() {
            if self.memory_limited.load(Ordering::Relaxed) {
                bail!("map-test run exceeded the child memory limit");
            }
            bail!("map-test run was cancelled");
        }
        Ok(())
    }

    fn charge_results(&self, items: usize) -> Result<()> {
        if items > MAX_HOST_RESULTS_PER_CALL {
            bail!(
                "a map query returning {items} values exceeds its {MAX_HOST_RESULTS_PER_CALL}-value bound; filter it"
            );
        }
        let mut state = self.mutable.lock().expect("map-test state poisoned");
        let total = state.host_results.saturating_add(items);
        if total > MAX_HOST_RESULTS_PER_RUN {
            bail!(
                "map queries returned more than {MAX_HOST_RESULTS_PER_RUN} values in this run; \
                 use count_tiles or narrower filters"
            );
        }
        state.host_results = total;
        drop(state);
        self.check_running()
    }
}

struct SampleCancellation<'a> {
    host: &'a HostState,
}

impl CancellationToken for SampleCancellation<'_> {
    fn is_cancelled(&self) -> bool {
        self.host.must_stop()
    }
}

struct BatchSampleCancellation<'a> {
    host: &'a HostState,
    first_failure: &'a AtomicUsize,
    index: usize,
}

impl CancellationToken for BatchSampleCancellation<'_> {
    fn is_cancelled(&self) -> bool {
        self.first_failure.load(Ordering::Relaxed) < self.index || self.host.must_stop()
    }
}

enum ScriptFailure {
    Nesting(String),
    Parse(String),
    ConstantSequence(String),
    Evaluation(String),
}

fn evaluate_script(host: &HostState, script: String) -> std::result::Result<(), ScriptFailure> {
    check_script_nesting(&script).map_err(ScriptFailure::Nesting)?;
    let dialect = Dialect {
        enable_load: false,
        ..Dialect::Standard
    };
    let prelude_ast = AstModule::parse("<rms-test-host-v1>", HOST_PRELUDE.to_owned(), &dialect)
        .expect("frozen host prelude parses");
    let ast = AstModule::parse(&host.context.config.script_name, script, &dialect)
        .map_err(|error| ScriptFailure::Parse(format!("{error:#}")))?;
    check_constant_sequences(&ast).map_err(ScriptFailure::ConstantSequence)?;
    let globals = GlobalsBuilder::extended_by(&[LibraryExtension::StructType])
        .with(host_globals)
        .build();
    Module::with_temp_heap(|module| {
        let print_handler = CapturedPrint(host);
        let mut evaluator = Evaluator::new(&module);
        evaluator.extra = Some(host);
        evaluator.set_print_handler(&print_handler);
        evaluator
            .set_max_callstack_size(MAX_CALL_DEPTH)
            .map_err(starlark::Error::new_other)?;
        evaluator
            .set_max_tick_count(MAX_INTERPRETER_TICKS)
            .map_err(starlark::Error::new_other)?;
        evaluator
            .set_max_heap_size(MAX_STARLARK_HEAP_BYTES)
            .map_err(starlark::Error::new_other)?;
        evaluator.set_check_cancelled(Box::new(|| host.must_stop()));
        evaluator.eval_module(prelude_ast, &globals)?;
        evaluator.eval_module(ast, &globals)?;
        if evaluator.get_total_tick_count() > MAX_INTERPRETER_TICKS {
            return Err(starlark::Error::new_other(anyhow!(
                "interpreter tick limit exceeded"
            )));
        }
        starlark::Result::Ok(())
    })
    .map_err(|error| ScriptFailure::Evaluation(format!("{error:#}")))
}

struct CapturedPrint<'a>(&'a HostState);

impl PrintHandler for CapturedPrint<'_> {
    fn println(&self, text: &str) -> starlark::Result<()> {
        let mut state = self.0.mutable.lock().expect("map-test state poisoned");
        if text.len() > MAX_OUTPUT_MESSAGE_BYTES {
            return Err(starlark::Error::new_other(anyhow!(
                "output message exceeds the 8 KiB limit"
            )));
        }
        if state.output.len() >= MAX_OUTPUT_MESSAGES
            || state.output_bytes.saturating_add(text.len()) > MAX_OUTPUT_BYTES
        {
            return Err(starlark::Error::new_other(anyhow!(
                "output exceeds the bounded map-test limit"
            )));
        }
        state.output_bytes += text.len();
        state.output.push(text.to_owned());
        Ok(())
    }
}

impl RunConfiguration {
    pub fn validate(&self) -> Result<()> {
        if self.script.is_empty() || self.script.len() > MAX_SCRIPT_BYTES {
            bail!("script must contain 1 byte to 1 MiB");
        }
        self.workers
            .validate()
            .map_err(|message| anyhow!(message))?;
        if self
            .machine
            .is_some_and(|machine| machine.logical_processors == 0)
        {
            bail!("an injected machine needs at least one logical processor");
        }
        self.dimensions.tile_count()?;
        if self.players.is_empty() || self.players.len() > 8 {
            bail!("generation needs 1 to 8 explicit players");
        }
        if self.source_catalogs.is_empty() {
            bail!("at least one immutable RMS source graph is required");
        }
        source_batch::validate(&self.source_catalogs)?;
        if self.script_name.is_empty()
            || self.script_name.len() > 512
            || self.workspace_name.is_empty()
            || self.workspace_name.len() > 256
            || self.script_name.contains(['\\', ':'])
            || self
                .script_name
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
            || self.workspace_name.contains(['/', '\\', ':'])
            || matches!(self.workspace_name.as_str(), "." | "..")
        {
            bail!("script and workspace identities must be bounded and path-redacted");
        }
        if let Some(path) = &self.default_source_path
            && !self.source_catalogs.contains_key(path)
        {
            bail!("default RMS source is absent from the immutable snapshot");
        }
        Ok(())
    }
}

pub fn run(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
) -> RunOutcome {
    run_observed(configuration, cancellation, RunObservers::default())
}

pub fn run_with_preview_updates(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
    preview_callback: PreviewCallback,
) -> RunOutcome {
    run_observed(
        configuration,
        cancellation,
        RunObservers {
            preview: Some(preview_callback),
            ..RunObservers::default()
        },
    )
}

pub fn run_with_progressive_preview(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
    preview_callback: PreviewCallback,
    progressive: ProgressivePreview,
) -> RunOutcome {
    run_observed(
        configuration,
        cancellation,
        RunObservers {
            preview: Some(preview_callback),
            progressive: Some(progressive),
            progress: None,
        },
    )
}

pub fn run_observed(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
    observers: RunObservers,
) -> RunOutcome {
    run_observed_with_report_schema(
        configuration,
        cancellation,
        observers,
        ReportSchema::default(),
    )
}

pub fn run_observed_with_report_schema(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
    observers: RunObservers,
    report_schema: ReportSchema,
) -> RunOutcome {
    match run_inner(configuration, cancellation, observers, report_schema) {
        Ok(outcome) => outcome,
        Err((status, output, diagnostic)) => RunOutcome {
            status,
            output,
            report: None,
            diagnostic: Some(diagnostic),
            preview: None,
            statistics: RunStatistics::default(),
        },
    }
}

type RunFailure = (RunStatus, Vec<String>, RunDiagnostic);

fn run_inner(
    configuration: RunConfiguration,
    cancellation: Arc<AtomicCancellationToken>,
    observers: RunObservers,
    report_schema: ReportSchema,
) -> std::result::Result<RunOutcome, RunFailure> {
    configuration.validate().map_err(|error| {
        failure(
            RunStatus::Error,
            Vec::new(),
            "RMSTEST1001",
            error.to_string(),
        )
    })?;
    let script = decode_script(&configuration.script).map_err(|error| {
        failure(
            RunStatus::Error,
            Vec::new(),
            "RMSTEST1002",
            error.to_string(),
        )
    })?;
    let profile_hash = configuration
        .profile
        .deterministic_hash()
        .map_err(|error| {
            failure(
                RunStatus::Error,
                Vec::new(),
                "RMSTEST1003",
                error.to_string(),
            )
        })?;
    let content_identity = configuration.content.identity().map_err(|error| {
        failure(
            RunStatus::Error,
            Vec::new(),
            "RMSTEST1004",
            error.to_string(),
        )
    })?;
    let content_hash = content_identity.content_hash;
    let script_hash: [u8; 32] = Sha256::digest(normalize_script_identity(&script)).into();
    let constants = run_constant_names(&configuration).map_err(|error| {
        failure(
            RunStatus::Error,
            Vec::new(),
            "RMSTEST1004",
            error.to_string(),
        )
    })?;
    let mut budget = MemoryBudget::for_process(memory::process_limit_bytes() as u64);
    if let Some(retained_maps) = configuration.retained_map_budget {
        budget.retained_maps = retained_maps.min(MAX_RETAINED_MAP_BYTES);
    }
    let context = RunnerContext {
        config: Arc::new(configuration),
        script_hash,
        profile_hash,
        content_hash,
        content_identity,
        constants: Arc::new(constants),
        budget,
    };
    let host = HostState {
        context: context.clone(),
        mutable: Mutex::new(MutableState::default()),
        retained: Mutex::new(RetainedStore::new(budget.retained_maps)),
        prepared: Mutex::new(VecDeque::new()),
        measured_peak: AtomicU64::new(0),
        regenerated: AtomicU64::new(0),
        max_workers: AtomicUsize::new(0),
        cancellation: cancellation.clone(),
        started: Instant::now(),
        preview_callback: observers.preview,
        progressive: observers
            .progressive
            .map(|preview| Arc::new(ProgressiveLease::new(preview))),
        progress: observers.progress.map(ProgressReporter::new),
        memory_limited: AtomicBool::new(false),
    };
    let evaluated = thread::scope(|scope| {
        thread::Builder::new()
            .name("rms-test-evaluation".to_owned())
            .stack_size(EVALUATION_STACK_BYTES)
            .spawn_scoped(scope, || evaluate_script(&host, script))
            .map(|worker| {
                worker.join().unwrap_or_else(|_| {
                    Err(ScriptFailure::Evaluation(
                        "map-test evaluation stopped unexpectedly".to_owned(),
                    ))
                })
            })
            .unwrap_or_else(|error| {
                Err(ScriptFailure::Evaluation(format!(
                    "map-test evaluation could not start: {error}"
                )))
            })
    });
    let mut state = std::mem::take(&mut *host.mutable.lock().expect("map-test state poisoned"));
    if let Err(script_failure) = evaluated {
        let (status, code, message) = match script_failure {
            ScriptFailure::Nesting(message) => (RunStatus::Error, "RMSTEST2004", message),
            ScriptFailure::Parse(message) => (RunStatus::Error, "RMSTEST2001", message),
            ScriptFailure::ConstantSequence(message) => (RunStatus::Error, "RMSTEST2006", message),
            ScriptFailure::Evaluation(message) if host.memory_limited.load(Ordering::Relaxed) => (
                RunStatus::Error,
                "RMSTEST2005",
                format!("map-test run exceeded its memory limit: {message}"),
            ),
            ScriptFailure::Evaluation(message) => {
                let status = if cancellation.is_cancelled() || message.contains("cancelled") {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Error
                };
                (status, "RMSTEST2002", message)
            }
        };
        return Err(failure(status, state.output, code, message));
    }
    if cancellation.is_cancelled() || host.started.elapsed() >= MAX_WALL_TIME {
        return Err(failure(
            RunStatus::Cancelled,
            state.output,
            "RMSTEST2003",
            "map-test run was cancelled before commit".to_owned(),
        ));
    }
    let status = if state.findings.is_empty() {
        RunStatus::Passed
    } else {
        RunStatus::Failed
    };
    let last_preview = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned")
        .records()
        .rev()
        .find(|(_, record)| record.preview_requested)
        .map(|(handle, record)| (handle, record.clone()));
    let preview = match last_preview {
        Some((handle, record)) => Some(
            sample_map(&host, handle)
                .map(|map| preview_sample(&record, map))
                .map_err(|error| {
                    let status = if host.must_stop() {
                        RunStatus::Cancelled
                    } else {
                        RunStatus::Error
                    };
                    if status == RunStatus::Cancelled {
                        failure(
                            status,
                            state.output.clone(),
                            "RMSTEST2003",
                            "map-test run was cancelled before commit".to_owned(),
                        )
                    } else {
                        failure(
                            status,
                            state.output.clone(),
                            "RMSTEST2002",
                            error.to_string(),
                        )
                    }
                })?,
        ),
        None => None,
    };
    let profile = &context.config.profile;
    let content_identity = context.content_identity.clone();
    let mut findings = std::mem::take(&mut state.findings);
    if report_schema == ReportSchema::Legacy {
        for finding in &mut findings {
            finding.request_document_revision = None;
        }
    }
    let mut report = MapTestReport {
        schema: "https://rmside.invalid/schemas/map-test-report/v1".to_owned(),
        schema_version: match report_schema {
            ReportSchema::Legacy => "1.0.0",
            ReportSchema::RequestRevision => REPORT_SCHEMA_VERSION,
        }
        .to_owned(),
        compatibility: ReportCompatibility {
            minimum_major: 1,
            maximum_major: 1,
        },
        semantic_api_major: SEMANTIC_API_MAJOR,
        report_identity: String::new(),
        status,
        script: ScriptIdentity {
            name: context.config.script_name.clone(),
            semantic_hash: hex::encode(script_hash),
        },
        workspace_name: context.config.workspace_name.clone(),
        engine_version: ExactRmsGenerationBackend.backend_id().to_owned(),
        protocol_version: format!(
            "{}.{}.{}",
            rms_protocol::PROTOCOL_MAJOR,
            rms_protocol::PROTOCOL_MINOR,
            rms_protocol::PROTOCOL_PATCH
        ),
        profile: ArtifactIdentity {
            id: profile.profile_id.clone(),
            version: profile.behavior_version.clone(),
            hash: hex::encode(profile_hash),
        },
        content: ArtifactIdentity {
            id: content_identity.pack_id,
            version: content_identity.pack_version,
            hash: hex::encode(context.content_hash),
        },
        settings: ReportSettings {
            width: context.config.dimensions.width,
            height: context.config.dimensions.height,
            map_size: context.config.map_size.clone(),
            players: context.config.players.clone(),
            setup_context: context.config.setup_context,
        },
        generated_maps: state.generated_maps as u32,
        assertion_count: state.assertion_count,
        findings,
        output: state.output.clone(),
        preview: preview.as_ref().map(|sample| PreviewIdentity {
            seed: sample.seed,
            request_hash: hex::encode(sample.request_hash),
            map_hash: hex::encode(sample.map_hash),
        }),
    };
    let canonical = serde_json::to_vec(&report).map_err(|error| {
        failure(
            RunStatus::Error,
            state.output.clone(),
            "RMSTEST3001",
            error.to_string(),
        )
    })?;
    report.report_identity = hex::encode(Sha256::digest(&canonical));
    let encoded = serde_json::to_vec_pretty(&report).map_err(|error| {
        failure(
            RunStatus::Error,
            state.output.clone(),
            "RMSTEST3001",
            error.to_string(),
        )
    })?;
    if encoded.len() > MAX_REPORT_BYTES {
        return Err(failure(
            RunStatus::Error,
            state.output,
            "RMSTEST3002",
            "map-test report exceeds the 16 MiB limit".to_owned(),
        ));
    }
    if !cancellation.begin_commit() {
        return Err(failure(
            RunStatus::Cancelled,
            state.output,
            "RMSTEST2003",
            "map-test run was cancelled before commit".to_owned(),
        ));
    }
    let statistics = {
        let store = host
            .retained
            .lock()
            .expect("map-test retained samples poisoned");
        RunStatistics {
            max_workers: host.max_workers.load(Ordering::Relaxed),
            worker_peak_bytes: host.measured_peak.load(Ordering::Relaxed),
            retained_peak_bytes: store.peak_body_bytes(),
            retained_budget_bytes: context.budget.retained_maps,
            dropped_maps: store.evictions(),
            regenerated_maps: host.regenerated.load(Ordering::Relaxed),
        }
    };
    Ok(RunOutcome {
        status,
        output: state.output,
        report: Some(report),
        diagnostic: None,
        preview,
        statistics,
    })
}

fn failure(status: RunStatus, output: Vec<String>, code: &str, message: String) -> RunFailure {
    (
        status,
        output,
        RunDiagnostic {
            code: code.to_owned(),
            message: bounded_diagnostic_message(redact_diagnostic(&message)),
            line: None,
            column: None,
        },
    )
}

pub const MAX_DIAGNOSTIC_MESSAGE_BYTES: usize = 8 * 1024;

fn bounded_diagnostic_message(mut message: String) -> String {
    if message.len() > MAX_DIAGNOSTIC_MESSAGE_BYTES {
        let mut end = MAX_DIAGNOSTIC_MESSAGE_BYTES - 32;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        let omitted = message.len() - end;
        message.truncate(end);
        let _ = write!(message, "... ({omitted} bytes omitted)");
    }
    message
}

fn decode_script(bytes: &[u8]) -> Result<String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).context("map-test script is not valid UTF-8")
}

fn normalize_script_identity(script: &str) -> Vec<u8> {
    script
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .into_bytes()
}

fn redact_diagnostic(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            if part.len() >= 3
                && part.as_bytes().get(1) == Some(&b':')
                && (part.contains('\\') || part.contains('/'))
            {
                "<redacted-path>"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[allow(clippy::too_many_arguments)]
#[starlark_module]
fn host_globals(builder: &mut GlobalsBuilder) {
    fn print<'v>(
        #[starlark(args)] args: UnpackTuple<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        check_renderable(&args.items, eval.heap())?;
        let text = args
            .items
            .iter()
            .map(|value| value.to_str())
            .collect::<Vec<_>>()
            .join(" ");
        CapturedPrint(host(eval)?)
            .println(&text)
            .map_err(|error| anyhow!("{error}"))?;
        Ok(NoneType)
    }

    fn fail<'v>(
        #[starlark(args)] args: UnpackTuple<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> starlark::Result<StarlarkNever> {
        check_renderable(&args.items, eval.heap()).map_err(starlark::Error::new_other)?;
        let mut message = String::new();
        for value in &args.items {
            message.push(' ');
            match value.unpack_str() {
                Some(text) => message.push_str(text),
                None => message.push_str(&value.to_repr()),
            }
        }
        Err(starlark::Error::new_kind(starlark::ErrorKind::Fail(
            anyhow::Error::msg(message),
        )))
    }

    fn __rms_source(path: Option<String>, eval: &mut Evaluator) -> anyhow::Result<String> {
        let host = host(eval)?;
        let selected = match path {
            Some(path) => normalize_relative_path(&path)?,
            None => host
                .context
                .config
                .default_source_path
                .clone()
                .ok_or_else(|| {
                    anyhow!(
                        "rms.source() has no map to use: pin a map in the Run options, or name one, for example rms.source(\"maps/example.rms\")"
                    )
                })?,
        };
        if !host.context.config.source_catalogs.contains_key(&selected) {
            bail!("{}", outside_folder_message(&selected));
        }
        Ok(selected)
    }

    fn __rms_id<'v>(name: &str, eval: &mut Evaluator<'v, '_, '_>) -> anyhow::Result<u32> {
        constant_id(&host(eval)?.context.constants, name)
    }

    fn __rms_seeds<'v>(
        start: u32,
        count: Option<u32>,
        step: Option<u32>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let count = count.unwrap_or(1);
        let step = step.unwrap_or(1);
        if count == 0 || step == 0 {
            bail!("rms.seeds count and step must be positive");
        }
        if count as usize > MAX_GENERATED_MAPS {
            bail!("rms.seeds exceeds the 4,096-map run limit");
        }
        let seeds = (0..count)
            .map(|ordinal| {
                start
                    .checked_add(
                        ordinal
                            .checked_mul(step)
                            .ok_or_else(|| anyhow!("seed overflow"))?,
                    )
                    .ok_or_else(|| anyhow!("seed overflow"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(eval.heap().alloc(AllocTuple(seeds)))
    }

    fn __rms_generate<'v>(
        target: String,
        seeds: Value<'v>,
        preview: bool,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Vec<u32>> {
        let seeds = value_u32_list(seeds, eval.heap())?;
        generate_batch(host(eval)?, &target, &seeds, preview)
    }

    fn __rms_sample_seed(handle: u32, eval: &mut Evaluator) -> anyhow::Result<u32> {
        Ok(sample(host(eval)?, handle)?.seed)
    }

    fn __rms_sample_request_hash(handle: u32, eval: &mut Evaluator) -> anyhow::Result<String> {
        Ok(hex::encode(sample(host(eval)?, handle)?.request_hash))
    }

    fn __rms_sample_warnings<'v>(
        handle: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let sample = sample(host(eval)?, handle)?;
        let heap = eval.heap();
        let values = sample
            .warnings
            .iter()
            .map(|warning| {
                heap.alloc(AllocStruct(vec![
                    ("code", heap.alloc(warning.code.as_str())),
                    ("message", heap.alloc(warning.message.as_str())),
                ]))
            })
            .collect::<Vec<_>>();
        Ok(heap.alloc(AllocTuple(values)))
    }

    fn __rms_sample_metrics<'v>(
        handle: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let sample = sample(host(eval)?, handle)?;
        let heap = eval.heap();
        let metrics = &sample.metrics;
        Ok(heap.alloc(AllocStruct(vec![
            ("tile_count", heap.alloc(metrics.tile_count)),
            ("object_count", heap.alloc(metrics.object_count)),
            ("allocated_bytes", heap.alloc(metrics.allocated_bytes)),
            ("emitted_events", heap.alloc(metrics.emitted_events)),
        ])))
    }

    fn __rms_map_width(handle: u32, eval: &mut Evaluator) -> anyhow::Result<u32> {
        Ok(u32::from(sample(host(eval)?, handle)?.dimensions.width))
    }

    fn __rms_map_height(handle: u32, eval: &mut Evaluator) -> anyhow::Result<u32> {
        Ok(u32::from(sample(host(eval)?, handle)?.dimensions.height))
    }

    fn __rms_map_hash(handle: u32, eval: &mut Evaluator) -> anyhow::Result<String> {
        Ok(hex::encode(sample(host(eval)?, handle)?.map_hash))
    }

    fn __rms_map_tile<'v>(
        handle: u32,
        x: u32,
        y: u32,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let index = tile_index(&map, x, y)?;
        Ok(alloc_tile(eval.heap(), &map, index))
    }

    fn __rms_map_tiles<'v>(
        handle: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let heap = eval.heap();
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            heap,
            &host(eval)?.context.constants,
        )?;
        let host = host(eval)?;
        let indices = matching_tiles(host, &map, &filter)?;
        host.charge_results(indices.len())?;
        let values = indices
            .into_iter()
            .map(|index| alloc_tile(heap, &map, index))
            .collect::<Vec<_>>();
        let tiles = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(tiles)
    }

    fn __rms_map_count_tiles<'v>(
        handle: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<u32> {
        let map = sample_map(host(eval)?, handle)?;
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            eval.heap(),
            &host(eval)?.context.constants,
        )?;
        Ok(matching_tiles(host(eval)?, &map, &filter)?.len() as u32)
    }

    fn __rms_map_objects<'v>(
        handle: u32,
        walls_only: bool,
        owner: Value<'v>,
        object_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let ids = bounded_set(
            optional_id_list(object_ids, eval.heap(), &host(eval)?.context.constants)?,
            "object ID filter",
        )?;
        let owner = optional_u32(owner)?
            .map(|value| u8::try_from(value).context("owner is out of range"))
            .transpose()?;
        let heap = eval.heap();
        let objects = map
            .objects
            .iter()
            .filter(|object| {
                ids.as_ref()
                    .is_none_or(|ids| ids.contains(&object.object_id.0))
            })
            .filter(|object| owner.is_none_or(|owner| object.owner == owner))
            .filter(|object| !walls_only || object.presentation_kind == 1)
            .collect::<Vec<_>>();
        host(eval)?.charge_results(objects.len())?;
        let values = objects
            .into_iter()
            .map(|object| alloc_object(heap, object))
            .collect::<Vec<_>>();
        let objects = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(objects)
    }

    fn __rms_map_cliffs<'v>(
        handle: u32,
        cliff_types: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let types = bounded_set(
            optional_id_list(cliff_types, eval.heap(), &host(eval)?.context.constants)?,
            "cliff-type filter",
        )?;
        let heap = eval.heap();
        let cliffs = map
            .cliffs
            .iter()
            .filter(|cliff| {
                types
                    .as_ref()
                    .is_none_or(|types| types.contains(&cliff.cliff_type))
            })
            .collect::<Vec<_>>();
        host(eval)?.charge_results(cliffs.len())?;
        let values = cliffs
            .into_iter()
            .map(|cliff| {
                heap.alloc(AllocStruct(vec![
                    ("from_x", heap.alloc(u32::from(cliff.from.x))),
                    ("from_y", heap.alloc(u32::from(cliff.from.y))),
                    ("to_x", heap.alloc(u32::from(cliff.to.x))),
                    ("to_y", heap.alloc(u32::from(cliff.to.y))),
                    ("cliff_type", heap.alloc(cliff.cliff_type)),
                ]))
            })
            .collect::<Vec<_>>();
        let cliffs = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(cliffs)
    }

    fn __rms_map_connections<'v>(
        handle: u32,
        kinds: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let kinds = optional_string_list(kinds, eval.heap())?
            .map(|values| values.into_iter().collect::<BTreeSet<_>>());
        let heap = eval.heap();
        let connections = map
            .connections
            .iter()
            .filter(|connection| {
                kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.contains(connection_kind(connection.kind)))
            })
            .collect::<Vec<_>>();
        host(eval)?.charge_results(connections.len())?;
        let values = connections
            .into_iter()
            .map(|connection| {
                heap.alloc(AllocStruct(vec![
                    ("start_x", heap.alloc(u32::from(connection.start.x))),
                    ("start_y", heap.alloc(u32::from(connection.start.y))),
                    ("end_x", heap.alloc(u32::from(connection.end.x))),
                    ("end_y", heap.alloc(u32::from(connection.end.y))),
                    ("kind", heap.alloc(connection_kind(connection.kind))),
                ]))
            })
            .collect::<Vec<_>>();
        let connections = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(connections)
    }

    fn __rms_map_neighbors<'v>(
        handle: u32,
        x: u32,
        y: u32,
        diagonal: bool,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        tile_index(&map, x, y)?;
        let heap = eval.heap();
        let mut indices = neighbor_indices(&map, x as u16, y as u16, diagonal);
        indices.sort_unstable();
        Ok(heap.alloc(AllocTuple(
            indices
                .into_iter()
                .map(|index| alloc_tile(heap, &map, index))
                .collect::<Vec<_>>(),
        )))
    }

    fn __rms_manhattan(x1: i64, y1: i64, x2: i64, y2: i64) -> anyhow::Result<u64> {
        Ok(x1.abs_diff(x2).saturating_add(y1.abs_diff(y2)))
    }

    fn __rms_chebyshev(x1: i64, y1: i64, x2: i64, y2: i64) -> anyhow::Result<u64> {
        Ok(x1.abs_diff(x2).max(y1.abs_diff(y2)))
    }

    fn __rms_squared(x1: i64, y1: i64, x2: i64, y2: i64) -> anyhow::Result<u64> {
        let dx = x1.abs_diff(x2);
        let dy = y1.abs_diff(y2);
        dx.checked_mul(dx)
            .and_then(|value| value.checked_add(dy.checked_mul(dy)?))
            .ok_or_else(|| anyhow!("squared distance overflow"))
    }

    fn __rms_map_boundaries<'v>(
        handle: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let heap = eval.heap();
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            heap,
            &host(eval)?.context.constants,
        )?;
        let host = host(eval)?;
        let indices = boundary_indices(host, &map, &filter)?;
        host.charge_results(indices.len())?;
        let values = indices
            .into_iter()
            .map(|index| alloc_tile(heap, &map, index))
            .collect::<Vec<_>>();
        let boundaries = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(boundaries)
    }

    fn __rms_map_components<'v>(
        handle: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<Value<'v>> {
        let map = sample_map(host(eval)?, handle)?;
        let heap = eval.heap();
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            heap,
            &host(eval)?.context.constants,
        )?;
        let host = host(eval)?;
        let components = component_indices(host, &map, &filter)?;
        host.charge_results(
            components
                .iter()
                .map(|component| component.len() + 1)
                .sum::<usize>(),
        )?;
        let values = components
            .into_iter()
            .map(|component| {
                heap.alloc(AllocTuple(
                    component
                        .into_iter()
                        .map(|index| alloc_tile(heap, &map, index))
                        .collect::<Vec<_>>(),
                ))
            })
            .collect::<Vec<_>>();
        let components = heap.alloc(AllocTuple(values));
        check_heap(eval)?;
        Ok(components)
    }

    fn __rms_map_connected<'v>(
        handle: u32,
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        terrain_ids: Option<Value<'v>>,
        land_zone_ids: Option<Value<'v>>,
        terrain_zone_ids: Option<Value<'v>>,
        layer_ids: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<bool> {
        let map = sample_map(host(eval)?, handle)?;
        let start = tile_index(&map, x1, y1)?;
        let end = tile_index(&map, x2, y2)?;
        let filter = tile_filter(
            terrain_ids,
            land_zone_ids,
            terrain_zone_ids,
            layer_ids,
            eval.heap(),
            &host(eval)?.context.constants,
        )?;
        connected(host(eval)?, &map, &filter, start, end)
    }

    fn __rms_expect(
        handle: u32,
        condition: bool,
        message: String,
        code: Value,
        values: Option<Value>,
        eval: &mut Evaluator,
    ) -> anyhow::Result<NoneType> {
        let assertion = begin_assertion(host(eval)?, eval);
        if !condition {
            record_finding(
                host(eval)?,
                handle,
                message,
                values,
                optional_string(code)?,
                assertion,
            )?;
        }
        Ok(NoneType)
    }

    fn __rms_report(
        handle: u32,
        message: String,
        code: Value,
        values: Option<Value>,
        eval: &mut Evaluator,
    ) -> anyhow::Result<NoneType> {
        let assertion = begin_assertion(host(eval)?, eval);
        record_finding(
            host(eval)?,
            handle,
            message,
            values,
            optional_string(code)?,
            assertion,
        )?;
        Ok(NoneType)
    }
}

fn host<'a>(eval: &'a Evaluator<'_, '_, '_>) -> Result<&'a HostState> {
    eval.extra
        .and_then(|extra| extra.downcast_ref::<HostState>())
        .ok_or_else(|| anyhow!("map-test host state is unavailable"))
}

fn normalize_relative_path(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.contains(':')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("RMS source path must stay within the authorized workspace root");
    }
    let extension = value
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("rms" | "rms2")) {
        bail!("rms.source() requires a root .rms or .rms2 document");
    }
    Ok(value)
}

fn sample(host: &HostState, handle: u32) -> Result<SampleRecord> {
    host.retained
        .lock()
        .expect("map-test retained samples poisoned")
        .record(handle)
        .cloned()
        .ok_or_else(|| anyhow!("sample handle is invalid"))
}

fn sample_map(host: &HostState, handle: u32) -> Result<Arc<GeneratedMap>> {
    let lookup = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned")
        .lookup(handle);
    let map = match lookup {
        Lookup::Decoded(map) => return Ok(map),
        Lookup::Compact(body) => Arc::new(body.decode()),
        Lookup::Missing => regenerate(host, handle)?,
        Lookup::Invalid => bail!("sample handle is invalid"),
    };
    host.retained
        .lock()
        .expect("map-test retained samples poisoned")
        .remember(handle, map.clone());
    Ok(map)
}

fn preview_sample(record: &SampleRecord, map: Arc<GeneratedMap>) -> PreviewSample {
    PreviewSample {
        seed: record.seed,
        source_path: record.source_path.to_string(),
        source_graph_hash: record.source_graph_hash,
        request_hash: record.request_hash,
        map_hash: record.map_hash,
        map,
        execution_cost: record.execution_cost.clone(),
    }
}

fn outside_folder_message(path: &str) -> String {
    format!("{path} is not a map in the open folder, so the map test cannot run it")
}

fn generate_batch(
    host: &HostState,
    target: &str,
    seeds: &[u32],
    preview: bool,
) -> Result<Vec<u32>> {
    let target = normalize_relative_path(target)?;
    if !host.context.config.source_catalogs.contains_key(&target) {
        bail!("{}", outside_folder_message(&target));
    }
    if seeds.is_empty() {
        return Ok(Vec::new());
    }
    if host
        .mutable
        .lock()
        .expect("map-test state poisoned")
        .generated_maps
        .saturating_add(seeds.len())
        > MAX_GENERATED_MAPS
    {
        bail!("generated-map count exceeds the 4,096-map limit");
    }
    host.check_running()?;
    let progress = host.progress.as_ref();
    if let Some(progress) = progress {
        progress.update(|counts| {
            counts.requested = counts.requested.saturating_add(seeds.len() as u32);
        });
    }
    let prepared = prepared_target(host, &target)?;
    let content = CompatibleContentView::new(
        &host.context.config.content,
        &host.context.config.profile.profile_id,
    )?;
    let lease = host
        .progressive
        .as_ref()
        .filter(|_| preview && host.preview_callback.is_some())
        .cloned();
    if let Some(lease) = &lease {
        lease.begin_batch();
    }
    let first = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned")
        .begin_batch(seeds.len() as u32);
    let machine = run_machine(host);
    let planned = batch_workers(host, machine, seeds.len());
    host.max_workers.fetch_max(planned, Ordering::Relaxed);
    let allowed = AtomicUsize::new(planned);
    let next_job = AtomicUsize::new(0);
    let first_failure = AtomicUsize::new(usize::MAX);
    let failures = Mutex::new(BTreeMap::<usize, anyhow::Error>::new());
    thread::scope(|scope| {
        for worker in 0..planned {
            let prepared = &prepared;
            let lease = lease.as_deref();
            let (allowed, next_job, first_failure, failures) =
                (&allowed, &next_job, &first_failure, &failures);
            scope.spawn(move || {
                machine::lower_thread_priority();
                loop {
                    if worker >= allowed.load(Ordering::Relaxed) || host.must_stop() {
                        break;
                    }
                    let index = next_job.fetch_add(1, Ordering::Relaxed);
                    if index >= seeds.len() || index > first_failure.load(Ordering::Relaxed) {
                        break;
                    }
                    let sample = CandidateSample {
                        ordinal: first + index as u32,
                        seed: seeds[index],
                    };
                    let cancellation = BatchSampleCancellation {
                        host,
                        first_failure,
                        index,
                    };
                    memory::reset_thread_peak();
                    match generate_sample(prepared, content, sample, preview, &cancellation, lease)
                    {
                        Ok(generated) => {
                            if let Some(progress) = progress {
                                progress.update(|counts| {
                                    counts.completed = counts.completed.saturating_add(1);
                                });
                            }
                            let body = CompactMap::encode(generated.map);
                            host.retained
                                .lock()
                                .expect("map-test retained samples poisoned")
                                .insert(sample.ordinal, generated.record, body);
                            let peak = memory::thread_peak_bytes();
                            if peak > host.measured_peak.fetch_max(peak, Ordering::Relaxed) {
                                allowed.fetch_min(
                                    batch_workers(host, machine, seeds.len()),
                                    Ordering::Relaxed,
                                );
                            }
                        }
                        Err(error) => {
                            first_failure.fetch_min(index, Ordering::Relaxed);
                            failures
                                .lock()
                                .expect("map-test failures poisoned")
                                .insert(index, error);
                        }
                    }
                }
            });
        }
    });
    if let Some(lease) = &lease {
        lease.revoke();
    }
    let committed = host.check_running().and_then(|()| {
        let mut failures = failures.into_inner().expect("map-test failures poisoned");
        let store = host
            .retained
            .lock()
            .expect("map-test retained samples poisoned");
        match (0..seeds.len()).find(|index| store.record(first + *index as u32).is_none()) {
            Some(index) => Err(failures
                .remove(&index)
                .unwrap_or_else(|| anyhow!("generation was cancelled"))),
            None => Ok(()),
        }
    });
    if let Err(error) = committed {
        host.retained
            .lock()
            .expect("map-test retained samples poisoned")
            .abandon_batch(first);
        return Err(error);
    }
    host.mutable
        .lock()
        .expect("map-test state poisoned")
        .generated_maps += seeds.len();
    if preview && let Some(callback) = &host.preview_callback {
        publish_finals(host, first, seeds.len() as u32, callback)?;
    }
    Ok((first..first + seeds.len() as u32).collect())
}

fn publish_finals(
    host: &HostState,
    first: u32,
    count: u32,
    callback: &PreviewCallback,
) -> Result<()> {
    let last = first + count - 1;
    for handle in first..=last {
        let (record, lookup) = {
            let store = host
                .retained
                .lock()
                .expect("map-test retained samples poisoned");
            let record = store
                .record(handle)
                .cloned()
                .ok_or_else(|| anyhow!("sample handle is invalid"))?;
            (record, store.peek(handle))
        };
        let map = match lookup {
            Lookup::Decoded(map) => map,
            Lookup::Compact(body) => Arc::new(body.decode()),
            Lookup::Missing if handle == last => regenerate(host, handle)?,
            Lookup::Missing => continue,
            Lookup::Invalid => bail!("sample handle is invalid"),
        };
        callback(handle, preview_sample(&record, map))?;
    }
    Ok(())
}

fn run_machine(host: &HostState) -> MachineResources {
    host.context
        .config
        .machine
        .unwrap_or_else(MachineResources::detect)
}

fn batch_workers(host: &HostState, machine: MachineResources, samples: usize) -> usize {
    let measured = host.measured_peak.load(Ordering::Relaxed);
    let peak = if measured > 0 {
        measured.saturating_add(measured / 4)
    } else {
        estimated_worker_peak_bytes(host.context.config.dimensions.tile_count().unwrap_or(0) as u64)
    };
    plan_workers(
        host.context.config.workers,
        machine,
        peak,
        host.context.budget.in_flight,
        samples,
    )
}

fn regenerate(host: &HostState, handle: u32) -> Result<Arc<GeneratedMap>> {
    host.check_running()?;
    let machine = run_machine(host);
    let workers = batch_workers(host, machine, MAX_WORKERS);
    let samples = {
        let store = host
            .retained
            .lock()
            .expect("map-test retained samples poisoned");
        store
            .missing_from(handle, store.read_ahead(workers))
            .into_iter()
            .map(|candidate| {
                store
                    .record(candidate)
                    .cloned()
                    .map(|record| (candidate, record))
                    .ok_or_else(|| anyhow!("sample handle is invalid"))
            })
            .collect::<Result<Vec<_>>>()?
    };
    let Some((_, first_record)) = samples.first() else {
        bail!("sample handle is invalid");
    };
    let prepared = prepared_target(host, &first_record.source_path)?;
    let content = CompatibleContentView::new(
        &host.context.config.content,
        &host.context.config.profile.profile_id,
    )?;
    let cancellation = SampleCancellation { host };
    let results = Mutex::new(
        std::iter::repeat_with(|| None)
            .take(samples.len())
            .collect::<Vec<Option<Result<GeneratedMap>>>>(),
    );
    let next_job = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..workers.min(samples.len()) {
            let (prepared, samples, results, next_job, cancellation) =
                (&prepared, &samples, &results, &next_job, &cancellation);
            scope.spawn(move || {
                machine::lower_thread_priority();
                loop {
                    let index = next_job.fetch_add(1, Ordering::Relaxed);
                    let Some((candidate, record)) = samples.get(index) else {
                        break;
                    };
                    if cancellation.is_cancelled() {
                        break;
                    }
                    let sample = CandidateSample {
                        ordinal: *candidate,
                        seed: record.seed,
                    };
                    let result = generate_sample(prepared, content, sample, false, cancellation, None)
                        .and_then(|generated| {
                            if generated.record.request_hash != record.request_hash
                                || generated.record.map_hash != record.map_hash
                            {
                                bail!(
                                    "the map of seed {} generated again differs from its first generation",
                                    record.seed
                                );
                            }
                            Ok(generated.map)
                        });
                    results.lock().expect("map-test results poisoned")[index] = Some(result);
                }
            });
        }
    });
    host.check_running()?;
    let mut results = results.into_inner().expect("map-test results poisoned");
    let requested = results[0]
        .take()
        .ok_or_else(|| anyhow!("generation was cancelled"))??;
    host.regenerated
        .fetch_add(samples.len() as u64, Ordering::Relaxed);
    let protected = handle..samples.last().map_or(handle, |(last, _)| last + 1);
    let mut store = host
        .retained
        .lock()
        .expect("map-test retained samples poisoned");
    for ((candidate, _), result) in samples.iter().zip(results).skip(1) {
        if let Some(Ok(map)) = result {
            store.restore(*candidate, CompactMap::encode(map), protected.clone());
        }
    }
    store.restore(handle, CompactMap::encode(requested.clone()), protected);
    Ok(Arc::new(requested))
}

fn prepared_target(host: &HostState, target: &str) -> Result<Arc<PreparedTarget>> {
    {
        let mut prepared = host.prepared.lock().expect("map-test targets poisoned");
        if let Some(position) = prepared.iter().position(|entry| entry.target == target) {
            let entry = prepared.remove(position).expect("position is in range");
            prepared.push_back(entry.clone());
            return Ok(entry);
        }
    }
    let entry = Arc::new(prepare_target(&host.context, target)?);
    let mut prepared = host.prepared.lock().expect("map-test targets poisoned");
    if prepared.len() == PREPARED_TARGETS {
        prepared.pop_front();
    }
    prepared.push_back(entry.clone());
    Ok(entry)
}

fn prepare_target(context: &RunnerContext, target: &str) -> Result<PreparedTarget> {
    let config = &context.config;
    let catalog = config
        .source_catalogs
        .get(target)
        .ok_or_else(|| anyhow!("authorized source graph is unavailable"))?;
    let vocabulary = config.content.rms_implicit_definitions()?;
    require_catalog_vocabulary(catalog, &vocabulary).map_err(|error| anyhow!(error.message))?;
    let mut options = product_strict_options(&config.profile, &vocabulary);
    config.setup_context.configure_strict_parser(
        &mut options,
        0,
        config.dimensions,
        &config.map_size,
        &config.players,
    )?;
    let analysis = PreparedCatalogAnalysis::new(catalog, options).map_err(strict_failure)?;
    let entry = catalog.entry_source()?;
    let request = GenerationRequest {
        document_uri: entry.id().as_str().to_owned(),
        document_revision: catalog.revision(),
        document_hash: Sha256::digest(entry.bytes()).into(),
        source_graph_hash: catalog.rms_graph_hash(),
        semantic_hash: [0; 32],
        behavior_profile: config.profile.identity(),
        behavior_profile_hash: context.profile_hash,
        content_pack: context.content_identity.clone(),
        backend_id: ExactRmsGenerationBackend.backend_id().to_owned(),
        seed: 0,
        dimensions: config.dimensions,
        map_size: config.map_size.clone(),
        players: config.players.clone(),
        setup_context: config.setup_context,
        trace_level: TraceLevel::Off,
    };
    Ok(PreparedTarget {
        target: target.to_owned(),
        source_path: Arc::from(target),
        source_graph_hash: catalog.rms_graph_hash(),
        analysis,
        request,
    })
}

fn strict_failure(error: rms_semantics::StrictParseError) -> anyhow::Error {
    let range = error.range.map_or_else(
        || "without a source range".to_owned(),
        |range| format!("at source bytes {}..{}", range.start.0, range.end.0),
    );
    anyhow!(
        "strict source execution failed ({}): {} ({range})",
        error.code,
        error.message
    )
}

fn generate_sample(
    prepared: &PreparedTarget,
    content: CompatibleContentView<'_>,
    sample: CandidateSample,
    preview: bool,
    cancellation: &dyn CancellationToken,
    lease: Option<&ProgressiveLease>,
) -> Result<GeneratedSample> {
    let seed = sample.seed;
    let mut collector = ExecutionCostCollector::new();
    let mut observed = match lease {
        Some(lease) => VisualCheckpointObserver::new(&mut collector, move |checkpoint| {
            lease.publish(sample, checkpoint)
        })
        .with_admission_gate(move || lease.try_acquire(sample.ordinal)),
        None => VisualCheckpointObserver::forwarding(&mut collector),
    };
    let mut unobserved = rms_engine::NoopExecutionObserver;
    let observer: &mut dyn rms_engine::ExecutionObserver = if preview {
        &mut observed
    } else {
        &mut unobserved
    };
    let program = observe_exact_script_parse(observer, || prepared.analysis.analyze(seed))
        .map_err(strict_failure)?;
    let mut request = prepared.request.clone();
    request.seed = seed;
    request.semantic_hash = program.identity.semantic_hash;
    let request_hash = request.deterministic_hash()?;
    let input = ResolvedGenerationInput {
        semantic_program: &program,
        request: &request,
        content,
    };
    let mut events = BoundedEventBuffer::new(0);
    let generated =
        ExactRmsGenerationBackend.generate_observed(input, &mut events, cancellation, observer);
    if let (Ok(map), Some(lease)) = (&generated, lease)
        && observed.admitted()
    {
        observed.publish_completed(map);
        lease.release(sample.ordinal);
    } else if let Some(lease) = lease {
        lease.release(sample.ordinal);
    }
    drop(observed);
    let mut map = generated?;
    map.connection_routes = None;
    Ok(GeneratedSample {
        record: SampleRecord {
            seed,
            source_path: prepared.source_path.clone(),
            source_graph_hash: prepared.source_graph_hash,
            request_document_revision: request.document_revision,
            request_hash,
            map_hash: map.final_semantic_hash,
            dimensions: map.dimensions,
            warnings: map.warnings.clone(),
            metrics: map.metrics.clone(),
            preview_requested: preview,
            execution_cost: if preview { collector.finish() } else { None },
        },
        map,
    })
}

fn record_finding(
    host: &HostState,
    handle: u32,
    message: String,
    values: Option<Value>,
    code: Option<String>,
    assertion: AssertionContext,
) -> Result<()> {
    if message.is_empty() || message.len() > MAX_OUTPUT_MESSAGE_BYTES {
        bail!("finding message must contain 1 byte to 8 KiB");
    }
    if code
        .as_ref()
        .is_some_and(|code| code.is_empty() || code.len() > 256)
    {
        bail!("finding code must contain 1 to 256 bytes");
    }
    let measurements = measurements(values)?;
    let sample = sample(host, handle)?;
    let mut state = host.mutable.lock().expect("map-test state poisoned");
    if state.findings.len() >= MAX_FINDINGS {
        bail!("finding count exceeds the 4,096-result limit");
    }
    let occurrence = state
        .occurrence_ordinals
        .entry(assertion.id.clone())
        .or_default();
    *occurrence = occurrence.saturating_add(1);
    let finding_id = hash_identity(
        b"rms-test-finding-v1",
        &[
            assertion.id.as_bytes(),
            &sample.seed.to_le_bytes(),
            &occurrence.to_le_bytes(),
        ],
    );
    state.findings.push(Finding {
        finding_id,
        assertion_id: assertion.id,
        code,
        message,
        script_line: assertion.line,
        script_column: assertion.column,
        seed: sample.seed,
        source_path: sample.source_path.to_string(),
        source_graph_hash: hex::encode(sample.source_graph_hash),
        request_document_revision: Some(sample.request_document_revision.to_string()),
        request_hash: hex::encode(sample.request_hash),
        map_hash: hex::encode(sample.map_hash),
        measurements,
    });
    Ok(())
}

struct AssertionContext {
    id: String,
    line: u32,
    column: u32,
}

fn begin_assertion(host: &HostState, eval: &Evaluator) -> AssertionContext {
    let location = eval
        .call_stack_nth_location(1)
        .or_else(|| eval.call_stack_top_location());
    let (line, column) = location
        .map(|location| {
            let resolved = location.resolve_span();
            (
                resolved.begin.line as u32 + 1,
                resolved.begin.column as u32 + 1,
            )
        })
        .unwrap_or((1, 1));
    let mut state = host.mutable.lock().expect("map-test state poisoned");
    let ordinal = {
        let ordinal = state.assertion_ordinals.entry((line, column)).or_default();
        *ordinal = ordinal.saturating_add(1);
        *ordinal
    };
    state.assertion_count = state.assertion_count.saturating_add(1);
    AssertionContext {
        id: hash_identity(
            b"rms-test-assertion-v1",
            &[
                &host.context.script_hash,
                &line.to_le_bytes(),
                &column.to_le_bytes(),
                &ordinal.to_le_bytes(),
            ],
        ),
        line,
        column,
    }
}

fn measurements(value: Option<Value>) -> Result<BTreeMap<String, JsonValue>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    if value.is_none() {
        return Ok(BTreeMap::new());
    }
    let dictionary = starlark::values::dict::DictRef::from_value(value)
        .ok_or_else(|| anyhow!("finding values must be a dictionary"))?;
    if dictionary.len() > MAX_MEASUREMENTS {
        bail!("finding values exceed the 32-measurement limit");
    }
    let mut result = BTreeMap::new();
    for (key, value) in dictionary.iter() {
        let key = key
            .unpack_str()
            .ok_or_else(|| anyhow!("finding measurement names must be strings"))?;
        let value = scalar_measurement(value)?;
        if key.is_empty() || key.len() > 256 || serde_json::to_vec(&value)?.len() > 1024 {
            bail!("finding measurement is not bounded");
        }
        result.insert(key.to_owned(), value);
    }
    Ok(result)
}

fn scalar_measurement(value: Value<'_>) -> Result<JsonValue> {
    if value.is_none() {
        return Ok(JsonValue::Null);
    }
    if let Some(flag) = value.unpack_bool() {
        return Ok(JsonValue::Bool(flag));
    }
    if let Some(text) = value.unpack_str() {
        if text.len() > 1024 {
            bail!("finding measurement is not bounded");
        }
        return Ok(JsonValue::String(text.to_owned()));
    }
    if matches!(value.get_type(), "int" | "float") {
        let json = value.to_json()?;
        if json.len() > 1024 {
            bail!("finding measurement is not bounded");
        }
        return Ok(serde_json::from_str(&json)?);
    }
    bail!("finding measurements must be scalar values")
}

pub fn check_script_nesting(script: &str) -> std::result::Result<(), String> {
    const KEYWORDS: [&str; 8] = ["not", "and", "or", "if", "else", "lambda", "in", "for"];
    let bytes = script.as_bytes();
    let mut index = 0;
    let mut line = 1_usize;
    let mut levels = vec![0_usize];
    let mut lambdas = vec![0_usize];
    let mut depth = 0_usize;
    let mut indents = vec![0_usize];
    let mut line_start = true;
    let too_deep = |line: usize| {
        format!(
            "script nesting exceeds the {MAX_SCRIPT_NESTING}-level bound at line {line}; \
             split the expression"
        )
    };
    while index < bytes.len() {
        if line_start && levels.len() == 1 {
            let mut width = 0;
            while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
                width += 1;
                index += 1;
            }
            if index < bytes.len() && !matches!(bytes[index], b'\n' | b'\r' | b'#') {
                while indents.len() > 1 && width < indents[indents.len() - 1] {
                    indents.pop();
                }
                if width > indents[indents.len() - 1] {
                    indents.push(width);
                    if indents.len() - 1 > MAX_SCRIPT_BLOCK_NESTING {
                        return Err(format!(
                            "script block nesting exceeds the {MAX_SCRIPT_BLOCK_NESTING}-level \
                             bound at line {line}"
                        ));
                    }
                }
                line_start = false;
            }
            if index >= bytes.len() {
                break;
            }
        }
        let byte = bytes[index];
        let operator;
        match byte {
            b'\n' => {
                line += 1;
                index += 1;
                if levels.len() == 1 {
                    depth -= levels[0];
                    levels[0] = 0;
                    lambdas[0] = 0;
                    line_start = true;
                }
                continue;
            }
            b'\\' if matches!(bytes.get(index + 1), Some(b'\n' | b'\r')) => {
                index += 1;
                if bytes.get(index) == Some(&b'\r') {
                    index += 1;
                }
                if bytes.get(index) == Some(&b'\n') {
                    index += 1;
                    line += 1;
                }
                continue;
            }
            b'#' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            b'"' | b'\'' => {
                index = skip_string(bytes, index, &mut line);
                continue;
            }
            b'(' | b'[' | b'{' => {
                operator = true;
                index += 1;
            }
            b')' | b']' | b'}' => {
                if levels.len() > 1 {
                    depth -= levels.pop().unwrap_or(0);
                    lambdas.pop();
                }
                index += 1;
                continue;
            }
            b',' | b';' | b':' => {
                let current = levels.len() - 1;
                if lambdas[current] > 0 && byte != b';' {
                    if byte == b':' {
                        lambdas[current] -= 1;
                    }
                } else {
                    depth -= levels[current];
                    levels[current] = 0;
                }
                index += 1;
                continue;
            }
            b'0'..=b'9' => {
                index = skip_number(bytes, index);
                continue;
            }
            b'.' if bytes.get(index + 1).is_some_and(u8::is_ascii_digit) => {
                index = skip_number(bytes, index);
                continue;
            }
            b'=' | b'+' | b'-' | b'*' | b'/' | b'%' | b'&' | b'|' | b'^' | b'~' | b'<' | b'>'
            | b'!' | b'.' => {
                let start = index;
                index += 1;
                if let Some(&next) = bytes.get(index) {
                    let pair = [byte, next];
                    if matches!(
                        &pair,
                        b"==" | b"!=" | b"<=" | b">=" | b"**" | b"//" | b"<<" | b">>" | b"->"
                    ) || (next == b'=' && b"+-*/%&|^".contains(&byte))
                    {
                        index += 1;
                        if matches!(&pair, b"**" | b"//" | b"<<" | b">>")
                            && bytes.get(index) == Some(&b'=')
                        {
                            index += 1;
                        }
                    }
                }
                let token = &bytes[start..index];
                let assignment = token == b"="
                    || (token.len() >= 2
                        && token.ends_with(b"=")
                        && !matches!(token, b"==" | b"<=" | b">=" | b"!="));
                if assignment {
                    let current = levels.len() - 1;
                    if lambdas[current] == 0 {
                        depth -= levels[current];
                        levels[current] = 0;
                    }
                    continue;
                }
                operator = true;
            }
            _ if byte == b'_' || byte.is_ascii_alphabetic() || byte >= 0x80 => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index] == b'_'
                        || bytes[index].is_ascii_alphanumeric()
                        || bytes[index] >= 0x80)
                {
                    index += 1;
                }
                let word = &script[start..index];
                if matches!(bytes.get(index), Some(b'"' | b'\''))
                    && word.len() <= 2
                    && word.bytes().all(|byte| b"rRbBfF".contains(&byte))
                {
                    index = skip_string(bytes, index, &mut line);
                    continue;
                }
                operator = KEYWORDS.contains(&word);
                if word == "lambda" {
                    let current = levels.len() - 1;
                    lambdas[current] += 1;
                }
            }
            _ => {
                index += 1;
                continue;
            }
        }
        if operator {
            let current = levels.len() - 1;
            levels[current] += 1;
            depth += 1;
            if byte == b'(' || byte == b'[' || byte == b'{' {
                levels.push(0);
                lambdas.push(0);
            }
            if depth > MAX_SCRIPT_NESTING || levels.len() > MAX_SCRIPT_NESTING {
                return Err(too_deep(line));
            }
        }
    }
    Ok(())
}

fn skip_string(bytes: &[u8], start: usize, line: &mut usize) -> usize {
    let quote = bytes[start];
    let triple = bytes.get(start + 1) == Some(&quote) && bytes.get(start + 2) == Some(&quote);
    let mut index = start + if triple { 3 } else { 1 };
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    *line += 1;
                }
                index += 2;
                continue;
            }
            b'\n' if !triple => return index,
            b'\n' => *line += 1,
            byte if byte == quote => {
                if !triple {
                    return index + 1;
                }
                if bytes.get(index + 1) == Some(&quote) && bytes.get(index + 2) == Some(&quote) {
                    return index + 3;
                }
            }
            _ => {}
        }
        index += 1;
    }
    bytes.len()
}

fn skip_number(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        let exponent_sign = matches!(byte, b'+' | b'-') && matches!(bytes[index - 1], b'e' | b'E');
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' || exponent_sign {
            index += 1;
        } else {
            break;
        }
    }
    index.min(bytes.len()).max(start + 1)
}

#[derive(Clone, Copy)]
enum ConstantSize {
    Integer(i128),
    Sequence(u64),
    Range(u64),
}

fn check_constant_sequences(ast: &AstModule) -> std::result::Result<(), String> {
    fn expression(expr: &starlark::syntax::ast::AstExpr) -> std::result::Result<(), String> {
        if let Some(ConstantSize::Sequence(length)) = constant_size(expr)
            && length > MAX_CONSTANT_SEQUENCE
        {
            return Err(format!(
                "a constant repetition or range of {length} items exceeds the \
                 {MAX_CONSTANT_SEQUENCE}-item bound"
            ));
        }
        let mut result = Ok(());
        expr.node.visit_expr(|child| {
            if result.is_ok() {
                result = expression(child);
            }
        });
        result
    }
    let mut result = Ok(());
    ast.statement().node.visit_expr(|expr| {
        if result.is_ok() {
            result = expression(expr);
        }
    });
    result
}

fn constant_size(expr: &starlark::syntax::ast::AstExpr) -> Option<ConstantSize> {
    use starlark::syntax::ast::{ArgumentP, AstLiteral, BinOp, ExprP};
    match &expr.node {
        ExprP::Literal(AstLiteral::Int(value)) => Some(ConstantSize::Integer(
            value.node.to_string().parse::<i128>().unwrap_or(i128::MAX),
        )),
        ExprP::Literal(AstLiteral::String(value)) => {
            Some(ConstantSize::Sequence(value.node.len() as u64))
        }
        ExprP::List(items) | ExprP::Tuple(items) => {
            Some(ConstantSize::Sequence(items.len() as u64))
        }
        ExprP::Minus(value) => match constant_size(value)? {
            ConstantSize::Integer(value) => Some(ConstantSize::Integer(value.saturating_neg())),
            _ => None,
        },
        ExprP::Op(left, operator, right) => {
            let (left, right) = (constant_size(left)?, constant_size(right)?);
            match (operator, left, right) {
                (BinOp::Multiply, ConstantSize::Integer(a), ConstantSize::Integer(b)) => {
                    Some(ConstantSize::Integer(a.saturating_mul(b)))
                }
                (BinOp::Add, ConstantSize::Integer(a), ConstantSize::Integer(b)) => {
                    Some(ConstantSize::Integer(a.saturating_add(b)))
                }
                (BinOp::Multiply, ConstantSize::Sequence(length), ConstantSize::Integer(count))
                | (BinOp::Multiply, ConstantSize::Integer(count), ConstantSize::Sequence(length)) => {
                    Some(ConstantSize::Sequence(length.saturating_mul(
                        u64::try_from(count.clamp(0, i128::from(u64::MAX))).unwrap_or(u64::MAX),
                    )))
                }
                (BinOp::Add, ConstantSize::Sequence(a), ConstantSize::Sequence(b)) => {
                    Some(ConstantSize::Sequence(a.saturating_add(b)))
                }
                _ => None,
            }
        }
        ExprP::Call(function, arguments) => {
            let ExprP::Identifier(name) = &function.node else {
                return None;
            };
            let positional = arguments
                .args
                .iter()
                .map(|argument| match &argument.node {
                    ArgumentP::Positional(value) => Some(value),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            match (name.node.ident.as_str(), positional.as_slice()) {
                ("list" | "tuple", [inner]) => match constant_size(inner)? {
                    ConstantSize::Sequence(length) | ConstantSize::Range(length) => {
                        Some(ConstantSize::Sequence(length))
                    }
                    ConstantSize::Integer(_) => None,
                },
                ("range", bounds) if (1..=3).contains(&bounds.len()) => {
                    let values = bounds
                        .iter()
                        .map(|bound| match constant_size(bound)? {
                            ConstantSize::Integer(value) => Some(value),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()?;
                    let (start, stop, step) = match values.as_slice() {
                        [stop] => (0, *stop, 1),
                        [start, stop] => (*start, *stop, 1),
                        [start, stop, step] => (*start, *stop, *step),
                        _ => return None,
                    };
                    if step == 0 {
                        return None;
                    }
                    let span = if step > 0 {
                        stop.saturating_sub(start)
                    } else {
                        start.saturating_sub(stop)
                    };
                    let length = if span <= 0 {
                        0
                    } else {
                        span.saturating_add(step.saturating_abs() - 1) / step.saturating_abs()
                    };
                    Some(ConstantSize::Range(
                        u64::try_from(length.clamp(0, i128::from(u64::MAX))).unwrap_or(u64::MAX),
                    ))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn check_renderable<'v>(values: &[Value<'v>], heap: Heap<'v>) -> Result<()> {
    use starlark::values::dict::DictRef;
    use starlark::values::list::ListRef;
    use starlark::values::structs::StructRef;
    use starlark::values::tuple::TupleRef;
    fn children<'v>(value: Value<'v>, heap: Heap<'v>) -> Option<Vec<Value<'v>>> {
        if let Some(list) = ListRef::from_value(value) {
            Some(list.content().to_vec())
        } else if let Some(tuple) = TupleRef::from_value(value) {
            Some(tuple.content().to_vec())
        } else if let Some(dict) = DictRef::from_value(value) {
            Some(dict.iter().flat_map(|(key, value)| [key, value]).collect())
        } else if let Some(fields) = StructRef::from_value(value) {
            Some(fields.iter().map(|(_, value)| value).collect())
        } else if value.get_type() == "set" {
            value.iterate(heap).ok().map(Iterator::collect)
        } else {
            None
        }
    }
    let too_large = || {
        anyhow!(
            "value is nested deeper than {MAX_PRINTED_VALUE_DEPTH} levels or holds more than \
             {MAX_PRINTED_VALUES} values; it cannot be rendered"
        )
    };
    let mut visited = 0_usize;
    let mut path = std::collections::HashSet::new();
    let mut stack: Vec<(Value<'v>, std::vec::IntoIter<Value<'v>>)> = Vec::new();
    let mut enter = |value: Value<'v>,
                     stack: &mut Vec<(Value<'v>, std::vec::IntoIter<Value<'v>>)>,
                     path: &mut std::collections::HashSet<_>|
     -> Result<()> {
        visited += 1;
        if visited > MAX_PRINTED_VALUES {
            return Err(too_large());
        }
        if let Some(children) = children(value, heap)
            && path.insert(value.identity())
        {
            if stack.len() >= MAX_PRINTED_VALUE_DEPTH {
                return Err(too_large());
            }
            stack.push((value, children.into_iter()));
        }
        Ok(())
    };
    for value in values {
        enter(*value, &mut stack, &mut path)?;
        while let Some((container, children)) = stack.last_mut() {
            match children.next() {
                Some(child) => enter(child, &mut stack, &mut path)?,
                None => {
                    path.remove(&container.identity());
                    stack.pop();
                }
            }
        }
    }
    Ok(())
}

fn hash_identity(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u32).to_le_bytes());
        hasher.update(part);
    }
    hex::encode(hasher.finalize())
}

fn value_u32_list<'v>(value: Value<'v>, heap: Heap<'v>) -> Result<Vec<u32>> {
    let mut result = Vec::new();
    for item in value
        .iterate(heap)
        .map_err(|error| anyhow!("value is not an iterable integer sequence: {error:#}"))?
    {
        if result.len() >= MAX_GENERATED_MAPS {
            bail!("integer sequence exceeds its 4,096-item bound");
        }
        result.push(unpack_u32(item)?);
    }
    Ok(result)
}

fn unpack_u32(value: Value<'_>) -> Result<u32> {
    use starlark::values::UnpackValue;
    match u32::unpack_value(value) {
        Ok(Some(number)) => Ok(number),
        Ok(None) => bail!(
            "expected an unsigned 32-bit integer, received a value of type {}",
            value.get_type()
        ),
        Err(_) => bail!("expected an unsigned 32-bit integer, received an out-of-range integer"),
    }
}

fn run_constant_names(
    configuration: &RunConfiguration,
) -> Result<BTreeMap<String, String>, rms_content::ContentError> {
    let mut names = configuration.content.rms_implicit_definitions()?;
    let catalog = configuration
        .default_source_path
        .as_ref()
        .and_then(|path| configuration.source_catalogs.get(path))
        .or_else(|| configuration.source_catalogs.values().next());
    if let Some(catalog) = catalog {
        for (name, value) in catalog.implicit_definitions() {
            names.insert(name.clone(), value.clone());
        }
    }
    Ok(names)
}

fn constant_id(constants: &BTreeMap<String, String>, name: &str) -> Result<u32> {
    if name.is_empty() || name.len() > 128 {
        bail!("a game constant name must have 1 to 128 characters");
    }
    let Some(value) = constants.get(name) else {
        bail!("{name} is not a game constant of the selected game version");
    };
    value
        .trim()
        .parse::<u32>()
        .map_err(|_| anyhow!("{name} is {value}, which is not an ID"))
}

fn optional_id_list<'v>(
    value: Option<Value<'v>>,
    heap: Heap<'v>,
    constants: &BTreeMap<String, String>,
) -> Result<Option<Vec<u32>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_none() {
        return Ok(None);
    }
    let mut result = Vec::new();
    for item in value.iterate(heap).map_err(|error| {
        anyhow!("value is not an iterable sequence of IDs or constant names: {error:#}")
    })? {
        if result.len() >= MAX_GENERATED_MAPS {
            bail!("integer sequence exceeds its 4,096-item bound");
        }
        result.push(match item.unpack_str() {
            Some(name) => constant_id(constants, name)?,
            None => unpack_u32(item)?,
        });
    }
    Ok(Some(result))
}

fn optional_u32_list<'v>(value: Option<Value<'v>>, heap: Heap<'v>) -> Result<Option<Vec<u32>>> {
    match value {
        None => Ok(None),
        Some(value) if value.is_none() => Ok(None),
        Some(value) => value_u32_list(value, heap).map(Some),
    }
}

fn optional_string_list<'v>(
    value: Option<Value<'v>>,
    heap: Heap<'v>,
) -> Result<Option<Vec<String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_none() {
        return Ok(None);
    }
    let mut result = Vec::new();
    for item in value
        .iterate(heap)
        .map_err(|error| anyhow!("value is not an iterable string sequence: {error:#}"))?
    {
        if result.len() >= 4_096 {
            bail!("string filter exceeds its bound");
        }
        result.push(
            item.unpack_str()
                .ok_or_else(|| anyhow!("filter values must be strings"))?
                .to_owned(),
        );
    }
    Ok(Some(result))
}

fn optional_string(value: Value<'_>) -> Result<Option<String>> {
    if value.is_none() {
        Ok(None)
    } else {
        Ok(Some(
            value
                .unpack_str()
                .ok_or_else(|| anyhow!("finding code must be a string or None"))?
                .to_owned(),
        ))
    }
}

fn optional_u32(value: Value<'_>) -> Result<Option<u32>> {
    if value.is_none() {
        Ok(None)
    } else {
        unpack_u32(value).map(Some)
    }
}

fn tile_filter<'v>(
    terrain_ids: Option<Value<'v>>,
    land_zone_ids: Option<Value<'v>>,
    terrain_zone_ids: Option<Value<'v>>,
    layer_ids: Option<Value<'v>>,
    heap: Heap<'v>,
    constants: &BTreeMap<String, String>,
) -> Result<TileFilter> {
    TileFilter::new(
        optional_id_list(terrain_ids, heap, constants)?,
        optional_u32_list(land_zone_ids, heap)?,
        optional_u32_list(terrain_zone_ids, heap)?,
        optional_u32_list(layer_ids, heap)?,
    )
}

#[derive(Default)]
struct TileFilter {
    terrain_ids: Option<BTreeSet<u32>>,
    land_zone_ids: Option<BTreeSet<u32>>,
    terrain_zone_ids: Option<BTreeSet<u32>>,
    layer_ids: Option<BTreeSet<u32>>,
}

impl TileFilter {
    fn new(
        terrain_ids: Option<Vec<u32>>,
        land_zone_ids: Option<Vec<u32>>,
        terrain_zone_ids: Option<Vec<u32>>,
        layer_ids: Option<Vec<u32>>,
    ) -> Result<Self> {
        Ok(Self {
            terrain_ids: bounded_set(terrain_ids, "terrain filter")?,
            land_zone_ids: bounded_set(land_zone_ids, "land-zone filter")?,
            terrain_zone_ids: bounded_set(terrain_zone_ids, "terrain-zone filter")?,
            layer_ids: bounded_set(layer_ids, "layer filter")?,
        })
    }

    fn matches(&self, map: &GeneratedMap, index: usize) -> bool {
        self.terrain_ids
            .as_ref()
            .is_none_or(|ids| ids.contains(&map.terrain[index].0))
            && self
                .land_zone_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&map.land_zone[index]))
            && self
                .terrain_zone_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&map.terrain_zone[index]))
            && self
                .layer_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&u32::from(map.layer[index])))
    }
}

fn bounded_set(values: Option<Vec<u32>>, label: &str) -> Result<Option<BTreeSet<u32>>> {
    values
        .map(|values| {
            if values.len() > 4_096 {
                bail!("{label} exceeds its bound");
            }
            Ok(values.into_iter().collect())
        })
        .transpose()
}

fn tile_index(map: &GeneratedMap, x: u32, y: u32) -> Result<usize> {
    let x = u16::try_from(x).context("tile x is out of range")?;
    let y = u16::try_from(y).context("tile y is out of range")?;
    MapCoordinate { x, y }
        .index(map.dimensions)
        .ok_or_else(|| anyhow!("tile coordinate is outside the map"))
}

fn alloc_tile<'v>(heap: Heap<'v>, map: &GeneratedMap, index: usize) -> Value<'v> {
    let width = usize::from(map.dimensions.width);
    heap.alloc(AllocStruct(vec![
        ("x", heap.alloc((index % width) as u32)),
        ("y", heap.alloc((index / width) as u32)),
        ("terrain", heap.alloc(map.terrain[index].0)),
        ("elevation", heap.alloc(i32::from(map.elevation[index]))),
        ("land_zone", heap.alloc(map.land_zone[index])),
        ("terrain_zone", heap.alloc(map.terrain_zone[index])),
        ("layer", heap.alloc(u32::from(map.layer[index]))),
        ("flags", heap.alloc(map.flags[index].0)),
    ]))
}

fn alloc_object<'v>(heap: Heap<'v>, object: &rms_engine::PlacedObject) -> Value<'v> {
    heap.alloc(AllocStruct(vec![
        ("object_id", heap.alloc(object.object_id.0)),
        ("owner", heap.alloc(u32::from(object.owner))),
        ("x256", heap.alloc(object.x_256)),
        ("y256", heap.alloc(object.y_256)),
        ("facet", heap.alloc(u32::from(object.facet))),
        (
            "footprint_width256",
            heap.alloc(u32::from(object.footprint_width_256)),
        ),
        (
            "footprint_height256",
            heap.alloc(u32::from(object.footprint_height_256)),
        ),
        ("resource_type", heap.alloc(i32::from(object.resource_type))),
        (
            "resource_quantity_f32_bits",
            heap.alloc(object.resource_quantity_f32_bits),
        ),
        ("resource_delta", heap.alloc(object.resource_delta)),
        ("status", heap.alloc(object.status)),
        ("death_state", heap.alloc(i32::from(object.death_state))),
        ("data_status", heap.alloc(i32::from(object.data_status))),
        (
            "selection_flags",
            heap.alloc(u32::from(object.selection_flags)),
        ),
        (
            "behavior_flags",
            heap.alloc(u32::from(object.behavior_flags)),
        ),
        ("is_wall", heap.alloc(object.presentation_kind == 1)),
    ]))
}

fn connection_kind(kind: ConnectionKind) -> &'static str {
    match kind {
        ConnectionKind::Land => "land",
        ConnectionKind::Water => "water",
        ConnectionKind::Road => "road",
    }
}

fn neighbor_indices(map: &GeneratedMap, x: u16, y: u16, diagonal: bool) -> Vec<usize> {
    let mut result = Vec::with_capacity(if diagonal { 8 } else { 4 });
    for dy in -1_i32..=1 {
        for dx in -1_i32..=1 {
            if (dx == 0 && dy == 0) || (!diagonal && dx != 0 && dy != 0) {
                continue;
            }
            let next_x = i32::from(x) + dx;
            let next_y = i32::from(y) + dy;
            if next_x >= 0
                && next_y >= 0
                && let Some(index) = (MapCoordinate {
                    x: next_x as u16,
                    y: next_y as u16,
                })
                .index(map.dimensions)
            {
                result.push(index);
            }
        }
    }
    result
}

const HOST_CHECK_INTERVAL: usize = 16_384;

trait StopCheck {
    fn check(&self) -> Result<()>;
}

impl StopCheck for HostState {
    fn check(&self) -> Result<()> {
        self.check_running()
    }
}

fn check_heap(eval: &Evaluator<'_, '_, '_>) -> Result<()> {
    if eval.heap().allocated_bytes() > MAX_STARLARK_HEAP_BYTES {
        bail!("map-test script heap exceeds its {MAX_STARLARK_HEAP_BYTES}-byte bound");
    }
    Ok(())
}

fn matching_tiles(
    stop: &dyn StopCheck,
    map: &GeneratedMap,
    filter: &TileFilter,
) -> Result<Vec<usize>> {
    let mut indices = Vec::new();
    for index in 0..map.terrain.len() {
        if index.is_multiple_of(HOST_CHECK_INTERVAL) {
            stop.check()?;
        }
        if filter.matches(map, index) {
            indices.push(index);
        }
    }
    Ok(indices)
}

fn boundary_indices(
    stop: &dyn StopCheck,
    map: &GeneratedMap,
    filter: &TileFilter,
) -> Result<Vec<usize>> {
    let width = usize::from(map.dimensions.width);
    let height = usize::from(map.dimensions.height);
    let mut indices = Vec::new();
    for index in matching_tiles(stop, map, filter)? {
        let x = index % width;
        let y = index / width;
        if x == 0
            || y == 0
            || x + 1 == width
            || y + 1 == height
            || neighbor_indices(map, x as u16, y as u16, false)
                .into_iter()
                .any(|neighbor| !filter.matches(map, neighbor))
        {
            indices.push(index);
        }
    }
    Ok(indices)
}

fn component_indices(
    stop: &dyn StopCheck,
    map: &GeneratedMap,
    filter: &TileFilter,
) -> Result<Vec<Vec<usize>>> {
    let mut visited = vec![false; map.terrain.len()];
    let width = usize::from(map.dimensions.width);
    let mut components = Vec::new();
    let mut visits = 0_usize;
    for start in 0..map.terrain.len() {
        if visited[start] || !filter.matches(map, start) {
            continue;
        }
        visited[start] = true;
        let mut queue = VecDeque::from([start]);
        let mut component = Vec::new();
        while let Some(index) = queue.pop_front() {
            visits += 1;
            if visits.is_multiple_of(HOST_CHECK_INTERVAL) {
                stop.check()?;
            }
            component.push(index);
            for neighbor in
                neighbor_indices(map, (index % width) as u16, (index / width) as u16, false)
            {
                if !visited[neighbor] && filter.matches(map, neighbor) {
                    visited[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        component.sort_unstable();
        components.push(component);
    }
    components.sort_by_key(|component| component[0]);
    Ok(components)
}

fn connected(
    stop: &dyn StopCheck,
    map: &GeneratedMap,
    filter: &TileFilter,
    start: usize,
    end: usize,
) -> Result<bool> {
    if !filter.matches(map, start) || !filter.matches(map, end) {
        return Ok(false);
    }
    let width = usize::from(map.dimensions.width);
    let mut visited = vec![false; map.terrain.len()];
    visited[start] = true;
    let mut queue = VecDeque::from([start]);
    let mut visits = 0_usize;
    while let Some(index) = queue.pop_front() {
        if index == end {
            return Ok(true);
        }
        visits += 1;
        if visits.is_multiple_of(HOST_CHECK_INTERVAL) {
            stop.check()?;
        }
        for neighbor in neighbor_indices(map, (index % width) as u16, (index / width) as u16, false)
        {
            if !visited[neighbor] && filter.matches(map, neighbor) {
                visited[neighbor] = true;
                queue.push_back(neighbor);
            }
        }
    }
    Ok(false)
}

pub fn report_json(report: &MapTestReport) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(report)?;
    if bytes.len() > MAX_REPORT_BYTES {
        bail!("map-test report exceeds the 16 MiB limit");
    }
    Ok(bytes)
}

pub fn generated_map_bytes(map: &GeneratedMap) -> u64 {
    map.metrics.allocated_bytes
}

pub fn report_summary(report: &MapTestReport) -> String {
    let mut summary = String::new();
    let _ = write!(
        summary,
        "{}: {} maps, {} findings",
        match report.status {
            RunStatus::Passed => "passed",
            RunStatus::Failed => "failed",
            RunStatus::Error => "error",
            RunStatus::Cancelled => "cancelled",
        },
        report.generated_maps,
        report.findings.len()
    );
    summary
}
