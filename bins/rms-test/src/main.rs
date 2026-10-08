use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand, ValueEnum};
use rms_content::{CivilizationId, NeutralContentPack, packaged_support_bundles};
#[cfg(feature = "internal-fixtures")]
use rms_content::{EXACT_REFERENCE_PACK_ID, exact_reference_content_pack};
use rms_engine::local_content::{LocalContentPaths, local_content_pack, local_content_pack_id};
use rms_engine::{
    AtomicCancellationToken, ComputerPlayerSlots, GameMode, GameModeModifier, GameModeModifiers,
    LobbyOptions, MapDimensions, PlayerConfiguration, PositionPolicy, SetupContext,
    SetupContextVersion, StartingAge, StartingResourcePolicy,
};
use rms_profile::{CURRENT_PROFILE_ID, ProfileCatalog};
use rms_protocol::v1::envelope::Payload;
use rms_protocol::v1::{self, ErrorCode};
use rms_protocol::{
    FrameError, artifact_version, compatibility, decode_envelope, envelope, fits_frame,
    frame_too_large_error, read_frame, structured_error, supports_major, write_frame,
};
use rms_source::{
    CatalogSource, ResolverRoots, SourceCatalog, SourceCatalogOrigin, SourceCatalogParts,
    SourceCatalogRole, SourceCatalogVersion, SourceId, StandardIncludeAccess,
};
use rms_test::{
    CandidateSample, MAX_WORKERS, MachineResources, PreviewCallback, ProgressCallback,
    ProgressivePreview, ReportSchema, RunConfiguration, RunDiagnostic, RunObservers, RunOutcome,
    RunStatistics, RunStatus, SEMANTIC_API_MAJOR, SampleProgress, WorkerSetting, report_json, run,
    run_observed_with_report_schema,
};
use serde::Serialize;
use starlark::analysis::AstModuleLint;
use starlark::docs::DocModule;
use starlark::errors::EvalMessage;
use starlark::syntax::{AstModule, Dialect};
use starlark_lsp::error::eval_message_to_lsp_diagnostic;
use starlark_lsp::server::{LspContext, LspEvalResult, LspUri, StringLiteralResult, stdio_server};

const TRANSIENT_PREVIEW_INTERVAL: Duration = Duration::from_millis(33);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct CandidateSlotState {
    lane: rms_engine::CoalescingCheckpointLane,
    sample: Option<CandidateSample>,
    closed: bool,
}

#[derive(Default)]
struct CandidateSlot {
    state: Mutex<CandidateSlotState>,
    changed: Condvar,
}

impl CandidateSlot {
    fn lock(&self) -> std::sync::MutexGuard<'_, CandidateSlotState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn offer(&self, sample: CandidateSample, checkpoint: rms_engine::VisualCheckpoint) -> bool {
        let mut state = self.lock();
        if state.closed || !state.lane.offer(checkpoint) {
            return false;
        }
        state.sample = Some(sample);
        self.changed.notify_one();
        true
    }

    fn discard(&self) {
        self.lock().lane.take();
    }

    fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        state.lane.take();
        self.changed.notify_all();
    }

    fn receive(&self) -> Option<(CandidateSample, rms_engine::VisualCheckpoint)> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            if let (Some(checkpoint), Some(sample)) = (state.lane.take(), state.sample) {
                return Some((sample, checkpoint));
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }
}

struct LatestValueState<T> {
    pending: Option<T>,
    closed: bool,
}

struct LatestValueQueue<T> {
    state: Mutex<LatestValueState<T>>,
    changed: Condvar,
}

impl<T> Default for LatestValueQueue<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(LatestValueState {
                pending: None,
                closed: false,
            }),
            changed: Condvar::new(),
        }
    }
}

impl<T> LatestValueQueue<T> {
    fn publish(&self, value: T) -> bool {
        let mut state = self.state.lock().expect("latest-value queue poisoned");
        if state.closed {
            return false;
        }
        state.pending = Some(value);
        self.changed.notify_one();
        true
    }

    fn close(&self) {
        let mut state = self.state.lock().expect("latest-value queue poisoned");
        state.closed = true;
        self.changed.notify_all();
    }

    fn receive(&self) -> Option<T> {
        let mut state = self.state.lock().expect("latest-value queue poisoned");
        loop {
            if let Some(value) = state.pending.take() {
                return Some(value);
            }
            if state.closed {
                return None;
            }
            state = self
                .changed
                .wait(state)
                .expect("latest-value queue poisoned while waiting");
        }
    }

    fn wait_closed(&self, timeout: Duration) -> bool {
        let state = self.state.lock().expect("latest-value queue poisoned");
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.closed)
            .expect("latest-value queue poisoned while waiting");
        state.closed
    }
}

fn forward_progress(
    queue: &LatestValueQueue<SampleProgress>,
    interval: Duration,
    mut send: impl FnMut(SampleProgress) -> bool,
) {
    while let Some(progress) = queue.receive() {
        if !send(progress) {
            break;
        }
        queue.wait_closed(interval);
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "rms-test",
    version,
    about = "Bounded deterministic RMS map-test runner"
)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run one sandboxed .rmstest map-test script and emit its versioned JSON report.
    Run(Box<RunArguments>),
    /// Serve the internal versioned length-framed Protobuf desktop protocol over stdio.
    #[command(hide = true)]
    Serve,
    /// Serve Starlark editor intelligence over the Language Server Protocol.
    #[command(hide = true)]
    Lsp,
}

#[derive(Debug, Parser)]
struct RunArguments {
    /// Authorized workspace root snapshotted before script evaluation.
    #[arg(long)]
    workspace: PathBuf,
    /// Sandboxed Starlark script inside the authorized workspace.
    #[arg(long)]
    script: PathBuf,
    /// Default root RMS path, relative to the workspace.
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    width: u16,
    #[arg(long)]
    height: u16,
    #[arg(long, default_value = "custom")]
    map_size: String,
    #[arg(long, default_value_t = 2)]
    players: u8,
    /// Explicit comma-separated lobby team IDs, one per player.
    #[arg(long, value_delimiter = ',')]
    teams: Vec<u8>,
    /// Comma-separated civilization IDs, one per player. By default player N
    /// plays civilization N. Zero means an unresolved Random choice, which a
    /// player's ordinary fallback start cannot use.
    #[arg(long, value_delimiter = ',')]
    civilizations: Vec<u32>,
    #[arg(long, value_enum, default_value_t = GameModeArgument::RandomMap)]
    game_mode: GameModeArgument,
    #[arg(long, value_enum, default_value_t = StartingResourcesArgument::Standard)]
    starting_resources: StartingResourcesArgument,
    #[arg(long, value_enum, default_value_t = StartingAgeArgument::Standard)]
    starting_age: StartingAgeArgument,
    #[arg(long, value_enum, default_value_t = PositionPolicyArgument::Random)]
    position_policy: PositionPolicyArgument,
    /// Maps generated at once: `auto` (from this machine and the map size)
    /// or at most 1 to 32. Never changes the report.
    #[arg(long, default_value = "auto", value_parser = parse_workers)]
    workers: WorkerSetting,
    /// Behavior profile; its packaged bundle supplies the content.
    #[arg(long, default_value = CURRENT_PROFILE_ID)]
    profile: String,
    /// Optional report destination. Stdout always receives the same report JSON.
    #[arg(long)]
    output: Option<PathBuf>,
}

fn parse_workers(value: &str) -> std::result::Result<WorkerSetting, String> {
    if value.eq_ignore_ascii_case("auto") {
        return Ok(WorkerSetting::Auto);
    }
    let setting = value
        .parse::<usize>()
        .map(WorkerSetting::Fixed)
        .map_err(|_| format!("workers must be auto or 1 to {MAX_WORKERS}"))?;
    setting
        .validate()
        .map(|()| setting)
        .map_err(|_| format!("workers must be auto or 1 to {MAX_WORKERS}"))
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum GameModeArgument {
    RandomMap,
    Regicide,
    DeathMatch,
    KingOfTheHill,
    WonderRace,
    DefendTheWonder,
    TurboRandomMap,
    CaptureTheRelic,
    SuddenDeath,
    BattleRoyale,
    EmpireWars,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum StartingResourcesArgument {
    Standard,
    Low,
    Medium,
    High,
    UltraHigh,
    Infinite,
    Random,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum StartingAgeArgument {
    Standard,
    DarkAge,
    FeudalAge,
    CastleAge,
    ImperialAge,
    PostImperialAge,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PositionPolicyArgument {
    Random,
    Fixed,
    TeamTogether,
}

impl From<GameModeArgument> for GameMode {
    fn from(value: GameModeArgument) -> Self {
        match value {
            GameModeArgument::RandomMap => Self::RandomMap,
            GameModeArgument::Regicide => Self::Regicide,
            GameModeArgument::DeathMatch => Self::DeathMatch,
            GameModeArgument::KingOfTheHill => Self::KingOfTheHill,
            GameModeArgument::WonderRace => Self::WonderRace,
            GameModeArgument::DefendTheWonder => Self::DefendTheWonder,
            GameModeArgument::TurboRandomMap => Self::TurboRandomMap,
            GameModeArgument::CaptureTheRelic => Self::CaptureTheRelic,
            GameModeArgument::SuddenDeath => Self::SuddenDeath,
            GameModeArgument::BattleRoyale => Self::BattleRoyale,
            GameModeArgument::EmpireWars => Self::EmpireWars,
        }
    }
}

impl From<StartingResourcesArgument> for StartingResourcePolicy {
    fn from(value: StartingResourcesArgument) -> Self {
        match value {
            StartingResourcesArgument::Standard => Self::Standard,
            StartingResourcesArgument::Low => Self::Low,
            StartingResourcesArgument::Medium => Self::Medium,
            StartingResourcesArgument::High => Self::High,
            StartingResourcesArgument::UltraHigh => Self::UltraHigh,
            StartingResourcesArgument::Infinite => Self::Infinite,
            StartingResourcesArgument::Random => Self::Random,
        }
    }
}

impl From<StartingAgeArgument> for StartingAge {
    fn from(value: StartingAgeArgument) -> Self {
        match value {
            StartingAgeArgument::Standard => Self::Standard,
            StartingAgeArgument::DarkAge => Self::DarkAge,
            StartingAgeArgument::FeudalAge => Self::FeudalAge,
            StartingAgeArgument::CastleAge => Self::CastleAge,
            StartingAgeArgument::ImperialAge => Self::ImperialAge,
            StartingAgeArgument::PostImperialAge => Self::PostImperialAge,
        }
    }
}

impl From<PositionPolicyArgument> for PositionPolicy {
    fn from(value: PositionPolicyArgument) -> Self {
        match value {
            PositionPolicyArgument::Random => Self::Random,
            PositionPolicyArgument::Fixed => Self::Fixed,
            PositionPolicyArgument::TeamTogether => Self::TeamTogether,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliFailure<'a> {
    status: RunStatus,
    output: &'a [String],
    diagnostic: &'a RunDiagnostic,
}

mod counting_allocator {
    use std::alloc::{GlobalAlloc, Layout, System};

    use rms_test::memory::{record_allocation, record_deallocation};

    pub(super) struct CountingAllocator;

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let pointer = unsafe { System.alloc(layout) };
            if !pointer.is_null() {
                record_allocation(layout.size());
            }
            pointer
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let pointer = unsafe { System.alloc_zeroed(layout) };
            if !pointer.is_null() {
                record_allocation(layout.size());
            }
            pointer
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) };
            record_deallocation(layout.size());
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let result = unsafe { System.realloc(pointer, layout, new_size) };
            if !result.is_null() {
                if new_size >= layout.size() {
                    record_allocation(new_size - layout.size());
                } else {
                    record_deallocation(layout.size() - new_size);
                }
            }
            result
        }
    }
}

#[global_allocator]
static ALLOCATOR: counting_allocator::CountingAllocator = counting_allocator::CountingAllocator;

const SERVICE_STACK_BYTES: usize = 64 * 1024 * 1024;

fn main() -> Result<()> {
    rms_test::memory::set_process_limit_bytes(rms_test::memory::scaled_process_limit(
        MachineResources::detect().available_memory_bytes,
    ));
    let _memory_limit = process_memory_limit::install()?;
    match Arguments::parse().command {
        Command::Run(arguments) => run_cli(*arguments),
        Command::Serve => {
            let mut input = io::stdin();
            let mut output = io::stdout();
            run_service(&mut input, &mut output)
        }
        Command::Lsp => thread::Builder::new()
            .name("rms-test-lsp".to_owned())
            .stack_size(SERVICE_STACK_BYTES)
            .spawn(|| stdio_server(MapTestLspContext).map_err(|error| anyhow!(error.to_string())))
            .context("starting the map-test language server")?
            .join()
            .map_err(|_| anyhow!("the map-test language server stopped unexpectedly"))?,
    }
}

struct MapTestLspContext;

impl LspContext for MapTestLspContext {
    fn parse_file_with_contents(&self, uri: &LspUri, content: String) -> LspEvalResult {
        let dialect = Dialect {
            enable_load: false,
            ..Dialect::Standard
        };
        if let Err(message) = rms_test::check_script_nesting(&content) {
            return LspEvalResult {
                diagnostics: vec![eval_message_to_lsp_diagnostic(EvalMessage::from_error(
                    uri.path(),
                    &starlark::Error::new_other(anyhow!("RMSTEST2004: {message}")),
                ))],
                ast: None,
            };
        }
        match AstModule::parse(&uri.path().to_string_lossy(), content, &dialect) {
            Ok(ast) => LspEvalResult {
                diagnostics: ast
                    .lint(None)
                    .into_iter()
                    .map(|lint| eval_message_to_lsp_diagnostic(EvalMessage::from(lint)))
                    .collect(),
                ast: Some(ast),
            },
            Err(error) => LspEvalResult {
                diagnostics: vec![eval_message_to_lsp_diagnostic(EvalMessage::from_error(
                    uri.path(),
                    &error,
                ))],
                ast: None,
            },
        }
    }

    fn resolve_load(
        &self,
        _path: &str,
        _current_file: &LspUri,
        _workspace_root: Option<&Path>,
    ) -> Result<LspUri, String> {
        Err("load() is disabled by the map-test v1 dialect".to_owned())
    }

    fn render_as_load(
        &self,
        _target: &LspUri,
        _current_file: &LspUri,
        _workspace_root: Option<&Path>,
    ) -> Result<String, String> {
        Err("load() is disabled by the map-test v1 dialect".to_owned())
    }

    fn resolve_string_literal(
        &self,
        _literal: &str,
        _current_file: &LspUri,
        _workspace_root: Option<&Path>,
    ) -> Result<Option<StringLiteralResult>, String> {
        Ok(None)
    }

    fn get_load_contents(&self, _uri: &LspUri) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn get_environment(&self, _uri: &LspUri) -> DocModule {
        rms_test::language_environment()
    }

    fn get_uri_for_global_symbol(
        &self,
        _current_file: &LspUri,
        _symbol: &str,
    ) -> Result<Option<LspUri>, String> {
        Ok(None)
    }
}

fn run_cli(arguments: RunArguments) -> Result<()> {
    let configuration = cli_configuration(&arguments)?;
    let outcome = run(configuration, Arc::new(AtomicCancellationToken::default()));
    if let Some(report) = &outcome.report {
        let bytes = report_json(report)?;
        io::stdout().write_all(&bytes)?;
        io::stdout().write_all(b"\n")?;
        if let Some(path) = arguments.output {
            fs::write(path, &bytes).context("writing map-test report")?;
        }
        if report.status == RunStatus::Failed {
            bail!("map-test findings were reported");
        }
        Ok(())
    } else {
        let diagnostic = outcome
            .diagnostic
            .as_ref()
            .ok_or_else(|| anyhow!("map-test failed without a diagnostic"))?;
        println!(
            "{}",
            serde_json::to_string(&CliFailure {
                status: outcome.status,
                output: &outcome.output,
                diagnostic,
            })?
        );
        bail!("map-test did not publish a report")
    }
}

fn cli_configuration(arguments: &RunArguments) -> Result<RunConfiguration> {
    let workspace = arguments
        .workspace
        .canonicalize()
        .context("resolving workspace root")?;
    if !workspace.is_dir() {
        bail!("workspace must be a directory");
    }
    let script = authorized_file(&workspace, &arguments.script)?;
    let script_name = workspace_relative(&workspace, &script)?;
    if script.extension().and_then(|value| value.to_str()) != Some("rmstest") {
        bail!("script must use the dedicated .rmstest extension");
    }
    let source = authorized_file(&workspace, &arguments.source)?;
    let source_path = workspace_relative(&workspace, &source)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("rms" | "rms2")) {
        bail!("source must be a root .rms or .rms2 file");
    }
    let profile_catalog = ProfileCatalog::frozen_current()?;
    let profile = profile_catalog
        .get(&arguments.profile)
        .ok_or_else(|| anyhow!("unknown behavior profile {}", arguments.profile))?
        .clone();
    let bundle = packaged_support_bundles()?
        .iter()
        .find(|bundle| bundle.manifest.behavior_profile_id == profile.profile_id)
        .ok_or_else(|| anyhow!("no packaged bundle supports {}", profile.profile_id))?;
    let content = bundle.content.clone();
    let catalogs =
        snapshot_workspace_catalogs(&workspace, &source_path, &profile.profile_id, &content)?;
    if !arguments.teams.is_empty() && arguments.teams.len() != usize::from(arguments.players) {
        bail!("--teams must contain exactly one team ID per explicit player");
    }
    if !arguments.civilizations.is_empty()
        && arguments.civilizations.len() != usize::from(arguments.players)
    {
        bail!("--civilizations must contain exactly one civilization ID per explicit player");
    }
    let players = (1..=arguments.players)
        .map(|slot| PlayerConfiguration {
            slot,
            team: arguments
                .teams
                .get(usize::from(slot - 1))
                .copied()
                .unwrap_or(0),
            civilization_id: CivilizationId(
                arguments
                    .civilizations
                    .get(usize::from(slot - 1))
                    .copied()
                    .unwrap_or(u32::from(slot)),
            ),
            color: slot - 1,
        })
        .collect();
    Ok(RunConfiguration {
        script: fs::read(script).context("reading map-test script")?,
        script_name,
        workspace_name: workspace
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace")
            .to_owned(),
        default_source_path: Some(source_path),
        source_catalogs: catalogs,
        profile,
        content,
        dimensions: MapDimensions {
            width: arguments.width,
            height: arguments.height,
        },
        map_size: arguments.map_size.clone(),
        players,
        setup_context: SetupContext {
            contract_version: SetupContextVersion::default(),
            game_mode: arguments.game_mode.into(),
            starting_resources: arguments.starting_resources.into(),
            starting_age: arguments.starting_age.into(),
            position_policy: arguments.position_policy.into(),
            computer_player_slots: ComputerPlayerSlots::default(),
            lobby_options: LobbyOptions::default(),
        },
        workers: arguments.workers,
        machine: None,
        retained_map_budget: None,
    })
}

fn authorized_file(workspace: &Path, input: &Path) -> Result<PathBuf> {
    let path = if input.is_absolute() {
        input.to_owned()
    } else {
        workspace.join(input)
    };
    let path = path.canonicalize().context("resolving authorized input")?;
    if !path.is_file() || !path.starts_with(workspace) {
        bail!("input must be a regular file inside the authorized workspace");
    }
    Ok(path)
}

fn workspace_relative(workspace: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(workspace)
        .context("input escaped the authorized workspace")?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            bail!("workspace path is not a normal relative path");
        };
        parts.push(
            value
                .to_str()
                .ok_or_else(|| anyhow!("workspace path is not Unicode"))?,
        );
    }
    if parts.is_empty() {
        bail!("workspace-relative file path is empty");
    }
    Ok(parts.join("/"))
}

fn snapshot_workspace_catalogs(
    workspace: &Path,
    root: &str,
    profile_id: &str,
    content: &rms_content::NeutralContentPack,
) -> Result<BTreeMap<String, SourceCatalog>> {
    let mut files = Vec::<(String, Arc<[u8]>, SourceCatalogRole)>::new();
    collect_workspace_files(workspace, workspace, &mut files)?;
    if files.len() > rms_source::SOURCE_CATALOG_MAX_SOURCES {
        bail!("workspace source snapshot exceeds 4,096 files");
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let aggregate = files.iter().map(|(_, bytes, _)| bytes.len()).sum::<usize>();
    if aggregate > rms_source::SOURCE_CATALOG_MAX_AGGREGATE_BYTES {
        bail!("workspace source snapshot exceeds 16 MiB");
    }
    let identity = content.identity()?;
    let content_identity = format!(
        "{}@{}#{}",
        identity.pack_id, identity.pack_version, identity.source_fingerprint
    );
    let standard_includes = standard_include_access(content)?;
    if !files.iter().any(|(path, _, _)| path == root) {
        bail!("selected RMS source is absent from the workspace snapshot");
    }
    let mut catalogs = BTreeMap::new();
    let sources = files
        .iter()
        .map(|(path, bytes, role)| {
            let role = if path == root {
                SourceCatalogRole::RmsEntry
            } else if *role == SourceCatalogRole::ExternalXs {
                SourceCatalogRole::ExternalXs
            } else {
                SourceCatalogRole::RmsDependency
            };
            CatalogSource::new(
                format!("workspace/{path}"),
                SourceId::new(format!("workspace:///{path}"))?,
                bytes.clone(),
                SourceCatalogOrigin::Workspace,
                role,
                None,
            )
            .map_err(anyhow::Error::from)
        })
        .collect::<Result<Vec<_>>>()?;
    let catalog = SourceCatalog::build(
        SourceCatalogVersion::default(),
        1,
        format!("workspace/{root}"),
        sources,
        ResolverRoots {
            opened_or_configured: vec!["workspace".to_owned()],
            standard_includes,
            ..ResolverRoots::default()
        },
        false,
        profile_id,
        &content_identity,
        content.rms_implicit_definitions()?,
    )?;
    catalogs.insert(root.to_owned(), catalog);
    Ok(catalogs)
}

fn standard_include_access(content: &NeutralContentPack) -> Result<StandardIncludeAccess> {
    let Some(bundle) = packaged_support_bundles()?
        .iter()
        .find(|bundle| bundle.content.pack_id == content.pack_id)
    else {
        return Ok(StandardIncludeAccess::default());
    };
    StandardIncludeAccess::new(bundle.standard_includes.resolver_identifiers(), false)
        .map_err(|error| anyhow!(error.to_string()))
}

fn local_content(
    request: &v1::MapTestRunRequest,
    source: &v1::LocalContentSource,
) -> Result<NeutralContentPack> {
    let expected_id = local_content_pack_id(&source.product_version)?;
    if request.content_pack_id != expected_id || request.profile_id != source.profile_id {
        bail!("local content must name its own pack and profile");
    }
    let paths = LocalContentPaths {
        dat: PathBuf::from(&source.dat_path),
        object_replacements: PathBuf::from(&source.object_replacements_path),
        definitions: PathBuf::from(&source.definitions_path),
    };
    let (pack, _) = local_content_pack(&paths, &source.product_version, &source.profile_id)
        .map_err(|error| anyhow!("local generation content is unavailable: {error}"))?;
    Ok(NeutralContentPack::clone(&pack))
}

fn resolve_content(pack_id: &str, profile_id: &str) -> Result<NeutralContentPack> {
    if let Some(bundle) = packaged_support_bundles()?
        .iter()
        .find(|bundle| bundle.content.pack_id == pack_id)
    {
        return Ok(bundle.content.clone());
    }
    #[cfg(feature = "internal-fixtures")]
    if pack_id == EXACT_REFERENCE_PACK_ID {
        return Ok(exact_reference_content_pack(profile_id));
    }
    let _ = profile_id;
    bail!("the map-test runner does not provide content pack {pack_id}")
}

fn collect_workspace_files(
    workspace: &Path,
    directory: &Path,
    files: &mut Vec<(String, Arc<[u8]>, SourceCatalogRole)>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let path = entry.path();
        if metadata.is_dir() {
            collect_workspace_files(workspace, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let role = match extension.as_deref() {
            Some("rms" | "rms2") => SourceCatalogRole::RmsEntry,
            Some("inc" | "def") => SourceCatalogRole::RmsDependency,
            Some("xs") => SourceCatalogRole::ExternalXs,
            _ => continue,
        };
        if metadata.len() > rms_source::SOURCE_CATALOG_MAX_FILE_BYTES as u64 {
            bail!("workspace source file exceeds 4 MiB");
        }
        files.push((
            workspace_relative(workspace, &path)?,
            Arc::from(fs::read(&path)?),
            role,
        ));
    }
    Ok(())
}

fn run_service<R: Read, W: Write + Send>(input: &mut R, output: &mut W) -> Result<()> {
    thread::scope(|scope| -> Result<()> {
        let writer = Arc::new(Mutex::new(output));
        let active = Arc::new(Mutex::new(None::<(String, Arc<AtomicCancellationToken>)>));
        let _cancel_on_exit = CancelActiveRunOnExit(active.clone());
        let mut workers: Vec<thread::ScopedJoinHandle<'_, ()>> = Vec::new();
        let mut handshaken = false;
        loop {
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    let _ = workers.swap_remove(index).join();
                } else {
                    index += 1;
                }
            }
            let frame = match read_frame(input) {
                Ok(frame) => frame,
                Err(FrameError::Eof) => break,
                Err(error) => return Err(error.into()),
            };
            let request = decode_envelope(&frame)?;
            if request.request_id.len() > MAX_REQUEST_ID_BYTES {
                let mut end = MAX_REQUEST_ID_BYTES;
                while !request.request_id.is_char_boundary(end) {
                    end -= 1;
                }
                send(
                    &writer,
                    structured_error(
                        request.request_id[..end].to_owned(),
                        ErrorCode::MalformedRequest,
                        format!("request identifiers are limited to {MAX_REQUEST_ID_BYTES} bytes"),
                        false,
                    ),
                )?;
                continue;
            }
            let request_id = request.request_id.clone();
            if !supports_major(request.artifact_version.as_ref()) {
                send(
                    &writer,
                    structured_error(
                        request_id,
                        ErrorCode::UnsupportedVersion,
                        "unsupported rms-test protocol major",
                        false,
                    ),
                )?;
                continue;
            }
            match request.payload {
                Some(Payload::HandshakeRequest(handshake)) => {
                    if !supports_major(handshake.protocol_version.as_ref()) {
                        send(
                            &writer,
                            structured_error(
                                request_id,
                                ErrorCode::UnsupportedVersion,
                                "unsupported rms-test protocol major",
                                false,
                            ),
                        )?;
                        continue;
                    }
                    handshaken = true;
                    send(
                        &writer,
                        envelope(
                            request_id,
                            Payload::HandshakeResponse(v1::HandshakeResponse {
                                protocol_version: Some(artifact_version()),
                                supported_protocol: Some(compatibility()),
                                server_name: "rms-test".to_owned(),
                                capabilities: Some(v1::Capabilities {
                                    analysis: false,
                                    generation: true,
                                    cancellation: true,
                                    progress: false,
                                    configuration_catalog: false,
                                    source_catalog_v1: true,
                                    map_testing: true,
                                    presentation_string_ids: false,
                                    execution_cost: true,
                                    local_content_import: true,
                                    progressive_preview: true,
                                    game_art: false,
                                    map_test_progress: true,
                                    map_test_automatic_workers: true,
                                    map_test_report_request_revision: true,
                                    connection_routes: false,
                                    control_pipe_exchange: false,
                                }),
                            }),
                        ),
                    )?;
                }
                Some(Payload::MapTestRunRequest(run_request)) if handshaken => {
                    let mut guard = active.lock().expect("active run registry poisoned");
                    if guard.is_some() {
                        send(
                            &writer,
                            structured_error(
                                request_id,
                                ErrorCode::UnsupportedCapability,
                                "the supervised child already owns one root map-test run",
                                true,
                            ),
                        )?;
                        continue;
                    }
                    let cancellation = Arc::new(AtomicCancellationToken::default());
                    *guard = Some((request_id.clone(), cancellation.clone()));
                    drop(guard);
                    let writer = writer.clone();
                    let active = active.clone();
                    let preview_queue =
                        Arc::new(LatestValueQueue::<(u32, rms_test::PreviewSample)>::default());
                    let preview_receiver = preview_queue.clone();
                    let preview_writer = writer.clone();
                    let preview_request_id = request_id.clone();
                    let preview_identity = run_request.identity.clone();
                    let preview_forwarder = scope.spawn(move || {
                        while let Some((ordinal, preview)) = preview_receiver.receive() {
                            if send(
                                &preview_writer,
                                envelope(
                                    preview_request_id.clone(),
                                    Payload::MapTestPreviewEvent(v1::MapTestPreviewEvent {
                                        identity: preview_identity.clone(),
                                        ordinal,
                                        preview: Some(protocol_preview(preview)),
                                    }),
                                ),
                            )
                            .is_err()
                            {
                                break;
                            }
                            thread::sleep(TRANSIENT_PREVIEW_INTERVAL);
                        }
                    });
                    let candidate_slot = Arc::new(CandidateSlot::default());
                    let candidate_forwarder = run_request.progressive_preview.then(|| {
                        let slot = candidate_slot.clone();
                        let writer = writer.clone();
                        let request_id = request_id.clone();
                        let identity = run_request.identity.clone();
                        scope.spawn(move || {
                            while let Some((sample, checkpoint)) = slot.receive() {
                                let event = protocol_visual_checkpoint(
                                    identity.clone(),
                                    sample,
                                    checkpoint,
                                );
                                if send(
                                    &writer,
                                    envelope(
                                        request_id.clone(),
                                        Payload::VisualCheckpointEvent(event),
                                    ),
                                )
                                .is_err()
                                {
                                    break;
                                }
                            }
                        })
                    });
                    let progress_queue = Arc::new(LatestValueQueue::<SampleProgress>::default());
                    let progress_forwarder = run_request.sample_progress.then(|| {
                        let queue = progress_queue.clone();
                        let writer = writer.clone();
                        let request_id = request_id.clone();
                        let identity = run_request.identity.clone();
                        scope.spawn(move || {
                            forward_progress(&queue, PROGRESS_INTERVAL, |progress| {
                                send(
                                    &writer,
                                    envelope(
                                        request_id.clone(),
                                        Payload::MapTestProgressEvent(v1::MapTestProgressEvent {
                                            identity: identity.clone(),
                                            completed_samples: progress.completed,
                                            requested_samples: progress.requested,
                                        }),
                                    ),
                                )
                                .is_ok()
                            });
                        })
                    });
                    workers.push(scope.spawn(move || {
                        let preview_sender = preview_queue.clone();
                        let preview_callback: PreviewCallback =
                            Arc::new(move |ordinal, preview| {
                                if preview_sender.publish((ordinal, preview)) {
                                    Ok(())
                                } else {
                                    Err(anyhow!("map-test preview receiver closed"))
                                }
                            });
                        let progressive = run_request.progressive_preview.then(|| {
                            let publish_slot = candidate_slot.clone();
                            let revoke_slot = candidate_slot.clone();
                            ProgressivePreview {
                                publish: Arc::new(move |sample, checkpoint| {
                                    publish_slot.offer(sample, checkpoint)
                                }),
                                revoke: Arc::new(move || revoke_slot.discard()),
                            }
                        });
                        let progress = progress_forwarder.is_some().then(|| {
                            let sender = progress_queue.clone();
                            Arc::new(move |progress| {
                                sender.publish(progress);
                            }) as ProgressCallback
                        });
                        let outcome = protocol_configuration(&run_request)
                            .map(|configuration| {
                                run_observed_with_report_schema(
                                    configuration,
                                    cancellation,
                                    RunObservers {
                                        preview: Some(preview_callback),
                                        progressive,
                                        progress,
                                    },
                                    if run_request.report_request_revision {
                                        ReportSchema::RequestRevision
                                    } else {
                                        ReportSchema::Legacy
                                    },
                                )
                            })
                            .unwrap_or_else(protocol_configuration_failure);
                        candidate_slot.close();
                        if let Some(forwarder) = candidate_forwarder {
                            let _ = forwarder.join();
                        }
                        preview_queue.close();
                        let _ = preview_forwarder.join();
                        progress_queue.close();
                        if let Some(forwarder) = progress_forwarder {
                            let _ = forwarder.join();
                        }
                        for (ordinal, text) in outcome.output.iter().enumerate() {
                            let _ = send(
                                &writer,
                                envelope(
                                    request_id.clone(),
                                    Payload::MapTestOutputEvent(v1::MapTestOutputEvent {
                                        identity: run_request.identity.clone(),
                                        ordinal: ordinal as u32,
                                        text: text.clone(),
                                    }),
                                ),
                            );
                        }
                        let response = framed_run_response(
                            &request_id,
                            protocol_outcome(run_request.identity, outcome),
                        );
                        {
                            let mut guard = active.lock().expect("active run registry poisoned");
                            if guard.as_ref().is_some_and(|(id, _)| id == &request_id) {
                                *guard = None;
                            }
                        }
                        let _ = send(&writer, response);
                    }));
                }
                Some(Payload::CancellationRequest(cancel)) if handshaken => {
                    let accepted = active
                        .lock()
                        .expect("active run registry poisoned")
                        .as_ref()
                        .filter(|(id, _)| id == &cancel.request_id)
                        .is_some_and(|(_, token)| token.cancel());
                    send(
                        &writer,
                        envelope(
                            request_id,
                            Payload::CancellationResponse(v1::CancellationResponse {
                                request_id: cancel.request_id,
                                accepted,
                            }),
                        ),
                    )?;
                }
                Some(Payload::ShutdownRequest(_)) if handshaken => {
                    if let Some((_, token)) = active
                        .lock()
                        .expect("active run registry poisoned")
                        .as_ref()
                    {
                        token.cancel();
                    }
                    send(
                        &writer,
                        envelope(
                            request_id,
                            Payload::ShutdownResponse(v1::ShutdownResponse { accepted: true }),
                        ),
                    )?;
                    let active = active.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_secs(2));
                        if active
                            .lock()
                            .expect("active run registry poisoned")
                            .is_some()
                        {
                            std::process::exit(124);
                        }
                    });
                    break;
                }
                _ => send(
                    &writer,
                    structured_error(
                        request_id,
                        ErrorCode::MalformedRequest,
                        "rms-test requires a handshake and supported request payload",
                        false,
                    ),
                )?,
            }
        }
        if let Some((_, token)) = active
            .lock()
            .expect("active run registry poisoned")
            .as_ref()
        {
            token.cancel();
        }
        for worker in workers {
            let _ = worker.join();
        }
        Ok(())
    })
}

#[cfg(windows)]
mod process_memory_limit {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;

    use anyhow::{Context, Result};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub(super) struct ProcessMemoryLimit(HANDLE);

    impl Drop for ProcessMemoryLimit {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) fn install() -> Result<ProcessMemoryLimit> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error())
                .context("creating rms-test memory-limit job");
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = rms_test::memory::process_limit_bytes();
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(error).context("configuring rms-test memory-limit job");
        }
        let assigned = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(error).context("assigning rms-test to its memory-limit job");
        }
        Ok(ProcessMemoryLimit(job))
    }
}

#[cfg(not(windows))]
mod process_memory_limit {
    use anyhow::Result;

    pub(super) struct ProcessMemoryLimit;

    pub(super) fn install() -> Result<ProcessMemoryLimit> {
        Ok(ProcessMemoryLimit)
    }
}

const MAX_REQUEST_ID_BYTES: usize = 128;

type ActiveRun = Arc<Mutex<Option<(String, Arc<AtomicCancellationToken>)>>>;

struct CancelActiveRunOnExit(ActiveRun);

impl Drop for CancelActiveRunOnExit {
    fn drop(&mut self) {
        let active = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some((_, token)) = active.as_ref() {
            token.cancel();
        }
    }
}

fn framed_run_response(request_id: &str, mut response: v1::MapTestRunResponse) -> v1::Envelope {
    let message = envelope(
        request_id.to_owned(),
        Payload::MapTestRunResponse(response.clone()),
    );
    if fits_frame(&message).is_ok() {
        return message;
    }
    response.preview = None;
    let message = envelope(request_id.to_owned(), Payload::MapTestRunResponse(response));
    match fits_frame(&message) {
        Ok(()) => message,
        Err(length) => {
            frame_too_large_error(request_id.to_owned(), "the map-test run response", length)
        }
    }
}

fn send<W: Write>(writer: &Arc<Mutex<&mut W>>, message: v1::Envelope) -> Result<()> {
    write_frame(
        &mut **writer.lock().expect("protocol writer poisoned"),
        &message,
    )?;
    Ok(())
}

fn protocol_configuration(request: &v1::MapTestRunRequest) -> Result<RunConfiguration> {
    if request.semantic_api_major != SEMANTIC_API_MAJOR {
        bail!("unsupported map-test semantic API major");
    }
    let profiles = ProfileCatalog::frozen_current()?;
    let profile = profiles
        .get(&request.profile_id)
        .ok_or_else(|| anyhow!("unknown behavior profile"))?
        .clone();
    if profile.deterministic_hash()?.as_slice() != request.behavior_profile_hash {
        bail!("behavior profile identity is stale");
    }
    let content = match request.local_content.as_ref() {
        Some(source) => local_content(request, source)?,
        None => resolve_content(&request.content_pack_id, &profile.profile_id)?,
    };
    let identity = content.identity()?;
    if identity.pack_version != request.content_pack_version
        || identity.content_hash.as_slice() != request.content_pack_hash
        || identity.source_fingerprint != request.content_source_fingerprint
    {
        bail!("content pack identity is stale");
    }
    let mut catalogs = BTreeMap::new();
    for catalog in &request.source_catalogs {
        let catalog = protocol_source_catalog(catalog)?;
        let key = catalog_key(&catalog);
        if catalogs.insert(key, catalog).is_some() {
            bail!("duplicate RMS source graph");
        }
    }
    Ok(RunConfiguration {
        script: request.script.clone(),
        script_name: request.script_name.clone(),
        workspace_name: request.workspace_name.clone(),
        default_source_path: (!request.default_source_path.is_empty())
            .then(|| request.default_source_path.clone()),
        source_catalogs: catalogs,
        profile,
        content,
        dimensions: MapDimensions {
            width: u16::try_from(request.width).context("map width is invalid")?,
            height: u16::try_from(request.height).context("map height is invalid")?,
        },
        map_size: request.map_size.clone(),
        players: protocol_players(&request.players)?,
        setup_context: protocol_setup_context(request.setup_context.as_ref())?,
        workers: protocol_workers(request)?,
        machine: None,
        retained_map_budget: None,
    })
}

fn protocol_workers(request: &v1::MapTestRunRequest) -> Result<WorkerSetting> {
    if request.automatic_workers {
        if request.workers != 0 {
            bail!("automatic workers take no worker count");
        }
        return Ok(WorkerSetting::Auto);
    }
    Ok(WorkerSetting::Fixed(
        usize::try_from(request.workers).unwrap_or(usize::MAX),
    ))
}

fn protocol_configuration_failure(error: anyhow::Error) -> RunOutcome {
    RunOutcome {
        status: RunStatus::Error,
        output: Vec::new(),
        report: None,
        diagnostic: Some(RunDiagnostic {
            code: "RMSTEST1001".to_owned(),
            message: error.to_string(),
            line: None,
            column: None,
        }),
        preview: None,
        statistics: RunStatistics::default(),
    }
}

fn protocol_source_catalog(value: &v1::SourceCatalog) -> Result<SourceCatalog> {
    let version = value
        .contract_version
        .as_ref()
        .ok_or_else(|| anyhow!("source catalog version is required"))?;
    let roots = value.roots.as_ref().cloned().unwrap_or_default();
    let sources = value
        .sources
        .iter()
        .map(|source| {
            let origin = match v1::SourceCatalogOrigin::try_from(source.origin) {
                Ok(v1::SourceCatalogOrigin::Workspace) => SourceCatalogOrigin::Workspace,
                Ok(v1::SourceCatalogOrigin::DirtyBuffer) => SourceCatalogOrigin::DirtyBuffer,
                Ok(v1::SourceCatalogOrigin::DeployedMap) => SourceCatalogOrigin::DeployedMap,
                Ok(v1::SourceCatalogOrigin::GameData) => SourceCatalogOrigin::GameData,
                Ok(v1::SourceCatalogOrigin::ImplicitEnvironment) => {
                    SourceCatalogOrigin::ImplicitEnvironment
                }
                _ => bail!("source catalog origin is unsupported"),
            };
            let role = match v1::SourceCatalogRole::try_from(source.role) {
                Ok(v1::SourceCatalogRole::RmsEntry) => SourceCatalogRole::RmsEntry,
                Ok(v1::SourceCatalogRole::RmsDependency) => SourceCatalogRole::RmsDependency,
                Ok(v1::SourceCatalogRole::ExternalXs) => SourceCatalogRole::ExternalXs,
                _ => bail!("source catalog role is unsupported"),
            };
            Ok(CatalogSource {
                path: source.normalized_path.clone(),
                source_id: SourceId::new(source.source_id.clone())?,
                raw_hash: fixed_hash(&source.raw_hash, "source raw")?,
                bytes: Arc::from(source.source.clone()),
                origin,
                role,
                buffer_revision: source.buffer_revision,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let definitions = value
        .implicit_definitions
        .iter()
        .map(|definition| (definition.name.clone(), definition.value.clone()))
        .collect();
    SourceCatalog::from_parts(SourceCatalogParts {
        version: SourceCatalogVersion {
            major: version.major,
            minor: version.minor,
            patch: version.patch,
        },
        revision: value.revision,
        entry_path: value.entry_path.clone(),
        sources,
        roots: ResolverRoots {
            opened_or_configured: roots.opened_or_configured,
            deployed_map_context: nonempty(roots.deployed_map_context),
            game_gamedata_x2: nonempty(roots.game_gamedata_x2),
            implicit_environment: nonempty(roots.implicit_environment),
            game_xs: nonempty(roots.game_xs),
            standard_includes: StandardIncludeAccess {
                identifiers: roots.standard_includes,
                authorized: roots.standard_includes_authorized,
            },
        },
        case_sensitive: value.case_sensitive,
        profile_id: value.profile_id.clone(),
        content_identity: value.content_identity.clone(),
        implicit_definitions: definitions,
        implicit_environment_hash: fixed_hash(
            &value.implicit_environment_hash,
            "implicit environment",
        )?,
        catalog_hash: fixed_hash(&value.catalog_hash, "source catalog")?,
        rms_graph_hash: fixed_hash(&value.rms_graph_hash, "source graph")?,
        asset_graph_hash: fixed_hash(&value.external_asset_hash, "external asset graph")?,
    })
    .map_err(anyhow::Error::from)
}

fn catalog_key(catalog: &SourceCatalog) -> String {
    for root in &catalog.roots().opened_or_configured {
        if let Some(path) = catalog.entry_path().strip_prefix(&format!("{root}/")) {
            return path.to_owned();
        }
    }
    catalog.entry_path().to_owned()
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn fixed_hash(bytes: &[u8], label: &str) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("{label} hash must contain exactly 32 bytes"))
}

fn protocol_players(values: &[v1::PlayerConfiguration]) -> Result<Vec<PlayerConfiguration>> {
    values
        .iter()
        .map(|value| {
            Ok(PlayerConfiguration {
                slot: u8::try_from(value.slot)?,
                team: u8::try_from(value.team)?,
                civilization_id: CivilizationId(value.civilization_id),
                color: u8::try_from(value.color)?,
            })
        })
        .collect()
}

fn protocol_setup_context(value: Option<&v1::SetupContext>) -> Result<SetupContext> {
    let value = value.ok_or_else(|| anyhow!("typed setup context is required"))?;
    let version = value
        .contract_version
        .as_ref()
        .ok_or_else(|| anyhow!("setup context version is required"))?;
    Ok(SetupContext {
        contract_version: SetupContextVersion {
            major: version.major,
            minor: version.minor,
            patch: version.patch,
        },
        game_mode: match v1::GameMode::try_from(value.game_mode)? {
            v1::GameMode::RandomMap => GameMode::RandomMap,
            v1::GameMode::Regicide => GameMode::Regicide,
            v1::GameMode::DeathMatch => GameMode::DeathMatch,
            v1::GameMode::KingOfTheHill => GameMode::KingOfTheHill,
            v1::GameMode::WonderRace => GameMode::WonderRace,
            v1::GameMode::DefendTheWonder => GameMode::DefendTheWonder,
            v1::GameMode::TurboRandomMap => GameMode::TurboRandomMap,
            v1::GameMode::CaptureTheRelic => GameMode::CaptureTheRelic,
            v1::GameMode::SuddenDeath => GameMode::SuddenDeath,
            v1::GameMode::BattleRoyale => GameMode::BattleRoyale,
            v1::GameMode::EmpireWars => GameMode::EmpireWars,
            v1::GameMode::Unspecified => bail!("game mode must be explicit"),
        },
        starting_resources: match v1::StartingResourcePolicy::try_from(value.starting_resources)? {
            v1::StartingResourcePolicy::Standard => StartingResourcePolicy::Standard,
            v1::StartingResourcePolicy::Low => StartingResourcePolicy::Low,
            v1::StartingResourcePolicy::Medium => StartingResourcePolicy::Medium,
            v1::StartingResourcePolicy::High => StartingResourcePolicy::High,
            v1::StartingResourcePolicy::UltraHigh => StartingResourcePolicy::UltraHigh,
            v1::StartingResourcePolicy::Infinite => StartingResourcePolicy::Infinite,
            v1::StartingResourcePolicy::Random => StartingResourcePolicy::Random,
            v1::StartingResourcePolicy::Unspecified => bail!("starting resources must be explicit"),
        },
        starting_age: match v1::StartingAge::try_from(value.starting_age)? {
            v1::StartingAge::Standard => StartingAge::Standard,
            v1::StartingAge::DarkAge => StartingAge::DarkAge,
            v1::StartingAge::FeudalAge => StartingAge::FeudalAge,
            v1::StartingAge::CastleAge => StartingAge::CastleAge,
            v1::StartingAge::ImperialAge => StartingAge::ImperialAge,
            v1::StartingAge::PostImperialAge => StartingAge::PostImperialAge,
            v1::StartingAge::Unspecified => bail!("starting age must be explicit"),
        },
        position_policy: match v1::PositionPolicy::try_from(value.position_policy)? {
            v1::PositionPolicy::Random => PositionPolicy::Random,
            v1::PositionPolicy::Fixed => PositionPolicy::Fixed,
            v1::PositionPolicy::TeamTogether => PositionPolicy::TeamTogether,
            v1::PositionPolicy::Unspecified => bail!("position policy must be explicit"),
        },
        computer_player_slots: ComputerPlayerSlots::from_slots(
            &value
                .computer_player_slots
                .iter()
                .map(|slot| u8::try_from(*slot))
                .collect::<std::result::Result<Vec<_>, _>>()?,
        )
        .map_err(|message| anyhow!(message))?,
        lobby_options: LobbyOptions {
            game_mode_modifiers: GameModeModifiers::from_modifiers(
                &value
                    .game_mode_modifiers
                    .iter()
                    .map(
                        |modifier| match v1::GameModeModifier::try_from(*modifier)? {
                            v1::GameModeModifier::EmpireWars => Ok(GameModeModifier::EmpireWars),
                            v1::GameModeModifier::SuddenDeath => Ok(GameModeModifier::SuddenDeath),
                            v1::GameModeModifier::Regicide => Ok(GameModeModifier::Regicide),
                            v1::GameModeModifier::KingOfTheHill => {
                                Ok(GameModeModifier::KingOfTheHill)
                            }
                            v1::GameModeModifier::Unspecified => {
                                bail!("game mode modifiers must be explicit")
                            }
                        },
                    )
                    .collect::<Result<Vec<_>>>()?,
            )
            .map_err(|message| anyhow!(message))?,
            turbo_mode: value.turbo_mode,
            full_tech_tree: value.full_tech_tree,
            antiquity_mode: value.antiquity_mode,
            solid_farms: value.solid_farms,
        },
    })
}

fn protocol_outcome(
    identity: Option<v1::RequestIdentity>,
    mut outcome: RunOutcome,
) -> v1::MapTestRunResponse {
    let encoded = outcome.report.as_ref().map(|report| {
        report_json(report).map(|bytes| {
            (
                bytes,
                hex::decode(&report.report_identity).unwrap_or_default(),
            )
        })
    });
    let (report_json, report_identity) = match encoded {
        Some(Ok(encoded)) => encoded,
        Some(Err(error)) => {
            outcome.status = RunStatus::Error;
            outcome.report = None;
            outcome.preview = None;
            outcome.diagnostic = Some(RunDiagnostic {
                code: "RMSTEST3002".to_owned(),
                message: error.to_string(),
                line: None,
                column: None,
            });
            (Vec::new(), Vec::new())
        }
        None => (Vec::new(), Vec::new()),
    };
    v1::MapTestRunResponse {
        identity,
        status: protocol_status(outcome.status) as i32,
        report_json,
        report_identity,
        diagnostics: outcome
            .diagnostic
            .into_iter()
            .map(|diagnostic| v1::Diagnostic {
                code: diagnostic.code,
                message: diagnostic.message,
                severity: v1::DiagnosticSeverity::Error as i32,
                source_id: String::new(),
                range: None,
            })
            .collect(),
        preview: outcome.preview.map(protocol_preview),
    }
}

fn protocol_status(status: RunStatus) -> v1::MapTestStatus {
    match status {
        RunStatus::Passed => v1::MapTestStatus::Passed,
        RunStatus::Failed => v1::MapTestStatus::Failed,
        RunStatus::Error => v1::MapTestStatus::Error,
        RunStatus::Cancelled => v1::MapTestStatus::Cancelled,
    }
}

fn protocol_execution_cost(summary: &rms_engine::ExecutionCostSummary) -> v1::ExecutionCostSummary {
    v1::ExecutionCostSummary {
        contract_major: summary.contract_major,
        contract_minor: summary.contract_minor,
        total_us: summary.total_us,
        groups: summary
            .groups
            .iter()
            .map(|group| v1::ExecutionCostGroup {
                group: group.group.id().to_owned(),
                duration_us: group.duration_us,
                steps: group
                    .steps
                    .iter()
                    .map(|step| v1::ExecutionCostStep {
                        step: step.step.id().to_owned(),
                        duration_us: step.duration_us,
                        counters: step
                            .counters
                            .iter()
                            .map(|(counter, value)| v1::ExecutionCostCounter {
                                counter: counter.id().to_owned(),
                                value: *value,
                            })
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
        context: v1::ExecutionCostContext::MapTest as i32,
    }
}

fn protocol_visual_checkpoint(
    identity: Option<v1::RequestIdentity>,
    sample: CandidateSample,
    checkpoint: rms_engine::VisualCheckpoint,
) -> v1::VisualCheckpointEvent {
    v1::VisualCheckpointEvent {
        identity,
        contract_major: rms_engine::VISUAL_CHECKPOINT_CONTRACT_MAJOR,
        contract_minor: rms_engine::VISUAL_CHECKPOINT_CONTRACT_MINOR,
        revision: checkpoint.revision,
        base_revision: checkpoint.base_revision,
        stage: match checkpoint.stage {
            rms_engine::VisualStage::Land => v1::VisualCheckpointStage::Land,
            rms_engine::VisualStage::Elevation => v1::VisualCheckpointStage::Elevation,
            rms_engine::VisualStage::Cliffs => v1::VisualCheckpointStage::Cliffs,
            rms_engine::VisualStage::Terrain => v1::VisualCheckpointStage::Terrain,
            rms_engine::VisualStage::Connections => v1::VisualCheckpointStage::Connections,
            rms_engine::VisualStage::Objects => v1::VisualCheckpointStage::Objects,
            rms_engine::VisualStage::SampleComplete => v1::VisualCheckpointStage::SampleComplete,
        } as i32,
        width: u32::from(checkpoint.dimensions.width),
        height: u32::from(checkpoint.dimensions.height),
        chunks: checkpoint
            .chunks
            .into_iter()
            .map(|chunk| v1::VisualCheckpointChunk {
                chunk_x: u32::from(chunk.chunk_x),
                chunk_y: u32::from(chunk.chunk_y),
                terrain_ids_le: chunk.terrain_ids_le,
                elevations: chunk.elevations,
                cliff_edges: chunk.cliff_edges,
                objects: chunk.objects,
            })
            .collect(),
        elapsed_us: checkpoint.elapsed_us,
        sample: Some(v1::VisualCheckpointSample {
            ordinal: sample.ordinal,
            seed: sample.seed,
        }),
    }
}

fn protocol_preview(sample: rms_test::PreviewSample) -> v1::MapTestPreview {
    let execution_cost = sample.execution_cost.as_ref().map(protocol_execution_cost);
    let map = sample.map;
    v1::MapTestPreview {
        execution_cost,
        seed: sample.seed,
        request_hash: sample.request_hash.to_vec(),
        map_hash: sample.map_hash.to_vec(),
        source_path: sample.source_path,
        source_graph_hash: sample.source_graph_hash.to_vec(),
        map_state: Some(v1::ColumnarMapState {
            width: u32::from(map.dimensions.width),
            height: u32::from(map.dimensions.height),
            terrain_ids_le: encode_u32(map.terrain.iter().map(|value| value.0)),
            elevations: encode_i16(map.elevation.iter().copied()),
            zones_le: encode_u32(map.terrain_zone.iter().copied()),
            land_ids_le: encode_u32(map.land_zone.iter().copied()),
            cliff_pieces_le: Vec::new(),
            appearance_objects_le: Vec::new(),
            cliff_edges: map
                .cliffs
                .iter()
                .flat_map(|cliff| {
                    let mut bytes = Vec::with_capacity(12);
                    bytes.extend_from_slice(&cliff.from.x.to_le_bytes());
                    bytes.extend_from_slice(&cliff.from.y.to_le_bytes());
                    bytes.extend_from_slice(&cliff.to.x.to_le_bytes());
                    bytes.extend_from_slice(&cliff.to.y.to_le_bytes());
                    bytes.extend_from_slice(&cliff.cliff_type.to_le_bytes());
                    bytes
                })
                .collect(),
            objects: Some(v1::ObjectColumns {
                ids_le: encode_u32(map.objects.iter().map(|value| value.object_id.0)),
                x_le: encode_u32(map.objects.iter().map(|value| value.x_256)),
                y_le: encode_u32(map.objects.iter().map(|value| value.y_256)),
                owners_le: map.objects.iter().map(|value| value.owner).collect(),
                facets_le: encode_u16(map.objects.iter().map(|value| value.facet)),
                footprint_widths_256_le: encode_u16(
                    map.objects.iter().map(|value| value.footprint_width_256),
                ),
                footprint_heights_256_le: encode_u16(
                    map.objects.iter().map(|value| value.footprint_height_256),
                ),
                presentation_kinds: map
                    .objects
                    .iter()
                    .map(|value| value.presentation_kind)
                    .collect(),
                resource_type_le: encode_i16(map.objects.iter().map(|value| value.resource_type)),
                resource_quantity_f32_bits_le: encode_u32(
                    map.objects
                        .iter()
                        .map(|value| value.resource_quantity_f32_bits),
                ),
                resource_deltas_le: encode_i32(
                    map.objects.iter().map(|value| value.resource_delta),
                ),
                statuses_le: encode_i32(map.objects.iter().map(|value| value.status)),
                death_states: map
                    .objects
                    .iter()
                    .map(|value| value.death_state as u8)
                    .collect(),
                data_statuses_le: encode_i16(map.objects.iter().map(|value| value.data_status)),
                selection_flags: map
                    .objects
                    .iter()
                    .map(|value| value.selection_flags)
                    .collect(),
                behavior_flags_le: encode_u16(map.objects.iter().map(|value| value.behavior_flags)),
            }),
            layer_ids_le: encode_u16(map.layer.iter().copied()),
            flags_le: encode_u32(map.flags.iter().map(|value| value.0)),
            connections: Some(v1::ConnectionColumns {
                start_x_le: encode_u16(map.connections.iter().map(|value| value.start.x)),
                start_y_le: encode_u16(map.connections.iter().map(|value| value.start.y)),
                end_x_le: encode_u16(map.connections.iter().map(|value| value.end.x)),
                end_y_le: encode_u16(map.connections.iter().map(|value| value.end.y)),
                kinds: map
                    .connections
                    .iter()
                    .map(|value| match value.kind {
                        rms_engine::ConnectionKind::Land => 0,
                        rms_engine::ConnectionKind::Water => 1,
                        rms_engine::ConnectionKind::Road => 2,
                    })
                    .collect(),
            }),
            pre_connection_terrain_ids_le: Vec::new(),
            connection_routes: None,
        }),
    }
}

fn encode_u16(values: impl IntoIterator<Item = u16>) -> Vec<u8> {
    values.into_iter().flat_map(u16::to_le_bytes).collect()
}

fn encode_i16(values: impl IntoIterator<Item = i16>) -> Vec<u8> {
    values.into_iter().flat_map(i16::to_le_bytes).collect()
}

fn encode_i32(values: impl IntoIterator<Item = i32>) -> Vec<u8> {
    values.into_iter().flat_map(i32::to_le_bytes).collect()
}

fn encode_u32(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
    values.into_iter().flat_map(u32::to_le_bytes).collect()
}
