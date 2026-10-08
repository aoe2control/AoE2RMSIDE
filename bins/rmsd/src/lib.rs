use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
#[cfg(feature = "internal-fixtures")]
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rms_analysis::{
    DiagnosticSeverity as AnalysisSeverity, analyze_document, analyze_semantics_catalog,
    analyze_semantics_single, product_strict_options, require_catalog_vocabulary,
};
use rms_content::{
    CivilizationId, CompatibleContentView, ContentSourceKind, NeutralContentPack,
    packaged_support_bundles,
};
#[cfg(feature = "internal-fixtures")]
use rms_content::{SYNTHETIC_PACK_ID, exact_reference_content_pack, synthetic_content_pack};
use rms_engine::{
    AtomicCancellationToken, CancellationToken, CoalescingCheckpointLane, ComputerPlayerSlots,
    ContentDefinitionKind, ExactRmsGenerationBackend, ExecutionCostCollector, ExecutionCostSummary,
    ExecutionObserver, ExecutionProgress, GameMode, GameModeModifier, GameModeModifiers,
    GeneratedMap, GenerationBackend, GenerationError, GenerationRequest, LobbyOptions,
    MapDimensions, NoopExecutionObserver, PlayerConfiguration, PositionPolicy,
    ResolvedGenerationInput, SetupContext, SetupContextVersion, StartingAge,
    StartingResourcePolicy, StepCost, VisualCheckpoint, VisualCheckpointObserver, VisualStage,
    exact_effective_dimensions, observe_exact_script_parse,
};
use rms_profile::{
    BehaviorProfile, CapabilityStatus, CertifiedConstructs, GenerationCertification,
    ProfileCatalog, frozen_certified_constructs,
};
use rms_protocol::v1::envelope::Payload;
use rms_protocol::v1::{self, ErrorCode};
use rms_protocol::{
    FrameError, PROTOCOL_MAJOR, artifact_version, compatibility, decode_envelope, envelope,
    fits_frame, frame_too_large_error, read_frame, structured_error, supports_major, write_frame,
};
use rms_source::{
    ByteOffset, ByteRange, CatalogSource, ResolverRoots, SourceCatalog, SourceCatalogError,
    SourceCatalogOrigin, SourceCatalogParts, SourceCatalogRole, SourceCatalogVersion, SourceId,
    SourceText, StandardIncludeAccess,
};
#[cfg(feature = "internal-fixtures")]
use rms_testkit::{
    SyntheticFixtureScenario, SyntheticGenerationBackend, SyntheticGenerationOptions,
};
use rms_trace::{
    GenerationEvent, GenerationEventSink, TraceLevel as EngineTraceLevel, TraceSinkError,
};
use sha2::{Digest, Sha256};

mod connection_routes;
pub mod control_pipe;
mod game_art;
mod latency;
mod local_content;

pub use connection_routes::{decode_connection_routes, protocol_connection_routes};
pub const SERVER_NAME: &str = "rmsd";

#[derive(Clone, Copy, Debug, Default)]
pub struct ServiceOptions;

impl ServiceOptions {
    pub fn from_environment() -> Self {
        Self
    }
}

pub fn run_service<R: Read, W: Write + Send, D: Write>(
    input: &mut R,
    output: &mut W,
    diagnostics: &mut D,
    _options: ServiceOptions,
) -> Result<()> {
    const MAXIMUM_ACTIVE_GENERATIONS: usize = 8;
    thread::scope(|scope| -> Result<()> {
        let auxiliary_workers = Arc::new(AtomicUsize::new(0));
        let auxiliary_reads = AuxiliaryReads::default();
        let control_exchanges = Arc::new(AtomicUsize::new(0));
        let writer: ProtocolWriter = Arc::new(PriorityWriter::default());
        let writer_thread = {
            let writer = writer.clone();
            scope.spawn(move || write_protocol_batches(output, &writer))
        };
        let active = Arc::new(Mutex::new(
            BTreeMap::<String, Arc<AtomicCancellationToken>>::new(),
        ));
        let _teardown = ServiceTeardown {
            writer: writer.clone(),
            active: Arc::clone(&active),
        };
        let generation_gate = Arc::new(Mutex::new(()));
        let mut workers: Vec<thread::ScopedJoinHandle<'_, ()>> = Vec::new();
        let mut worker_panicked = false;
        let mut handshaken = false;
        let mut shutdown_request = None;
        let service_result = loop {
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    let worker = workers.remove(index);
                    if worker.join().is_err() {
                        worker_panicked = true;
                    }
                } else {
                    index += 1;
                }
            }
            let frame = match read_frame(input) {
                Ok(frame) => frame,
                Err(FrameError::Eof) => {
                    let _ = writeln!(diagnostics, "rmsd: parent input closed; exiting");
                    break Ok(());
                }
                Err(error) => {
                    let _ = writeln!(diagnostics, "rmsd: malformed input frame: {error}");
                    break Err(error.into());
                }
            };
            let decode_started = latency::mark();
            let request = match decode_envelope(&frame).context("decoding request envelope") {
                Ok(request) => request,
                Err(error) => break Err(error),
            };
            let request_id = request.request_id.clone();

            if !supports_major(request.artifact_version.as_ref()) {
                send_protocol_batch(
                    &writer,
                    vec![structured_error(
                        request_id,
                        ErrorCode::UnsupportedVersion,
                        format!("unsupported protocol major; rmsd requires {PROTOCOL_MAJOR}"),
                        false,
                    )],
                )?;
                continue;
            }

            match request.payload {
                Some(Payload::HandshakeRequest(handshake)) => {
                    let requested_major =
                        handshake.protocol_version.as_ref().map(|value| value.major);
                    let range_supported =
                        handshake.supported_protocol.as_ref().is_some_and(|range| {
                            range.minimum_major <= PROTOCOL_MAJOR
                                && range.maximum_major >= PROTOCOL_MAJOR
                        });
                    if requested_major != Some(PROTOCOL_MAJOR) || !range_supported {
                        send_protocol_batch(
                            &writer,
                            vec![structured_error(
                                request_id,
                                ErrorCode::UnsupportedVersion,
                                "client and server have no compatible protocol major",
                                false,
                            )],
                        )?;
                        continue;
                    }
                    handshaken = true;
                    send_protocol_batch(
                        &writer,
                        vec![envelope(
                            request_id,
                            Payload::HandshakeResponse(v1::HandshakeResponse {
                                protocol_version: Some(artifact_version()),
                                supported_protocol: Some(compatibility()),
                                server_name: SERVER_NAME.to_owned(),
                                capabilities: Some(v1::Capabilities {
                                    analysis: true,
                                    generation: true,
                                    cancellation: true,
                                    progress: true,
                                    configuration_catalog: true,
                                    source_catalog_v1: true,
                                    map_testing: false,
                                    presentation_string_ids: true,
                                    execution_cost: true,
                                    local_content_import: true,
                                    progressive_preview: true,
                                    game_art: true,
                                    map_test_progress: false,
                                    map_test_automatic_workers: false,
                                    map_test_report_request_revision: false,
                                    connection_routes: true,
                                    control_pipe_exchange: true,
                                }),
                            }),
                        )],
                    )?;
                }
                Some(payload) if !handshaken => {
                    let _ = payload;
                    send_protocol_batch(
                        &writer,
                        vec![structured_error(
                            request_id,
                            ErrorCode::MalformedRequest,
                            "handshake is required before requests",
                            false,
                        )],
                    )?;
                }
                Some(Payload::AnalysisRequest(request)) => {
                    let source_uri = request
                        .document
                        .as_ref()
                        .map(|document| document.uri.as_str())
                        .filter(|uri| !uri.is_empty())
                        .unwrap_or("memory://rmsd-analysis");
                    let analysis = analyze_source_with_catalog(
                        source_uri,
                        &request.source,
                        &request.profile_id,
                        request.source_catalog.as_ref(),
                    );
                    let mut document = request.document;
                    if let (Some(document), Some(catalog)) =
                        (document.as_mut(), analysis.source_catalog.as_ref())
                    {
                        document.source_graph_hash = catalog.rms_graph_hash().to_vec();
                        document.source_catalog_hash = catalog.catalog_hash().to_vec();
                    }
                    send_protocol_batch(
                        &writer,
                        vec![envelope(
                            request_id,
                            Payload::AnalysisResponse(v1::AnalysisResponse {
                                identity: request.identity,
                                document,
                                diagnostics: analysis.diagnostics,
                                semantic_hash: analysis.semantic_hash,
                            }),
                        )],
                    )?;
                }
                Some(Payload::CancellationRequest(request)) => {
                    let token = active
                        .lock()
                        .expect("active generation registry poisoned")
                        .get(&request.request_id)
                        .cloned();
                    let accepted = token.is_some_and(|token| token.cancel());
                    if accepted {
                        latency::cancelled(&request.request_id);
                    }
                    send_protocol_batch(
                        &writer,
                        vec![envelope(
                            request_id,
                            Payload::CancellationResponse(v1::CancellationResponse {
                                request_id: request.request_id,
                                accepted,
                            }),
                        )],
                    )?;
                }
                Some(Payload::GenerationRequest(request)) => {
                    let identity_request_id = request
                        .identity
                        .as_ref()
                        .map(|identity| identity.request_id.as_str())
                        .unwrap_or(request_id.as_str())
                        .to_owned();
                    if identity_request_id.is_empty() || identity_request_id != request_id {
                        send_protocol_batch(
                            &writer,
                            vec![structured_error(
                                request_id,
                                ErrorCode::MalformedRequest,
                                "generation envelope and identity request IDs must match",
                                false,
                            )],
                        )?;
                        continue;
                    }
                    let token = Arc::new(AtomicCancellationToken::default());
                    {
                        let mut registry =
                            active.lock().expect("active generation registry poisoned");
                        if registry.len() >= MAXIMUM_ACTIVE_GENERATIONS
                            || registry.contains_key(&identity_request_id)
                        {
                            send_protocol_batch(
                                &writer,
                                vec![structured_error(
                                    request_id,
                                    ErrorCode::MalformedRequest,
                                    "generation request identity is duplicate or the queue is full",
                                    true,
                                )],
                            )?;
                            continue;
                        }
                        registry.insert(identity_request_id.clone(), Arc::clone(&token));
                    }
                    latency::received(&identity_request_id, decode_started);
                    let worker_writer = writer.clone();
                    let worker_active = Arc::clone(&active);
                    let worker_gate = Arc::clone(&generation_gate);
                    workers.push(scope.spawn(move || {
                        generation_worker(
                            request_id,
                            identity_request_id,
                            request,
                            token,
                            worker_active,
                            worker_gate,
                            worker_writer,
                        );
                    }));
                }
                Some(Payload::ConfigurationCatalogRequest(_)) => match configuration_catalog() {
                    Ok(catalog) => send_protocol_batch(
                        &writer,
                        vec![envelope(
                            request_id,
                            Payload::ConfigurationCatalogResponse(catalog),
                        )],
                    )?,
                    Err(error) => send_protocol_batch(
                        &writer,
                        vec![structured_error(
                            request_id,
                            ErrorCode::Internal,
                            error.to_string(),
                            false,
                        )],
                    )?,
                },
                Some(Payload::PresentationStringIdsRequest(request)) => {
                    let key = auxiliary_read_key(b'p', &request);
                    let Some(read) = auxiliary_reads.admit(key, &request_id) else {
                        continue;
                    };
                    let Some(slot) = AuxiliaryWorkerSlot::acquire(&auxiliary_workers) else {
                        read.finish();
                        send_protocol_batch(&writer, vec![auxiliary_workers_busy(request_id)])?;
                        continue;
                    };
                    let worker_writer = writer.clone();
                    workers.push(scope.spawn(move || {
                        let response = presentation_string_ids(&request);
                        drop(slot);
                        let _ = send_protocol_batch(
                            &worker_writer,
                            read.finish()
                                .into_iter()
                                .map(|request_id| {
                                    envelope(
                                        request_id,
                                        Payload::PresentationStringIdsResponse(response.clone()),
                                    )
                                })
                                .collect(),
                        );
                    }));
                }
                Some(Payload::LocalContentImportRequest(request)) => {
                    let key = auxiliary_read_key(b'l', &request);
                    let Some(read) = auxiliary_reads.admit(key, &request_id) else {
                        continue;
                    };
                    let Some(slot) = AuxiliaryWorkerSlot::acquire(&auxiliary_workers) else {
                        read.finish();
                        send_protocol_batch(&writer, vec![auxiliary_workers_busy(request_id)])?;
                        continue;
                    };
                    let worker_writer = writer.clone();
                    workers.push(scope.spawn(move || {
                        let response = local_content::local_content_import(&request);
                        drop(slot);
                        let _ = send_protocol_batch(
                            &worker_writer,
                            read.finish()
                                .into_iter()
                                .map(|request_id| {
                                    envelope(
                                        request_id,
                                        Payload::LocalContentImportResponse(response.clone()),
                                    )
                                })
                                .collect(),
                        );
                    }));
                }
                Some(Payload::GameArtPrepareRequest(request)) => {
                    admit_game_art(
                        scope,
                        &mut workers,
                        &writer,
                        &active,
                        &auxiliary_workers,
                        request_id,
                        GameArtJob::Prepare(request),
                    )?;
                }
                Some(Payload::GameArtSpritesRequest(request)) => {
                    admit_game_art(
                        scope,
                        &mut workers,
                        &writer,
                        &active,
                        &auxiliary_workers,
                        request_id,
                        GameArtJob::Sprites(request),
                    )?;
                }
                Some(Payload::ControlPipeExchangeRequest(request)) => {
                    admit_control_exchange(
                        scope,
                        &mut workers,
                        &writer,
                        &active,
                        &control_exchanges,
                        request_id,
                        request,
                    )?;
                }
                Some(Payload::ShutdownRequest(_)) => {
                    shutdown_request = Some(request_id);
                    break Ok(());
                }
                Some(_) => {
                    send_protocol_batch(
                        &writer,
                        vec![structured_error(
                            request_id,
                            ErrorCode::MalformedRequest,
                            "message payload is not a request accepted by rmsd",
                            false,
                        )],
                    )?;
                }
                None => {
                    send_protocol_batch(
                        &writer,
                        vec![structured_error(
                            request_id,
                            ErrorCode::MalformedRequest,
                            "request envelope has no payload",
                            false,
                        )],
                    )?;
                }
            }
        };

        for token in active
            .lock()
            .expect("active generation registry poisoned")
            .values()
        {
            let _ = token.cancel();
        }
        for worker in workers {
            worker_panicked |= worker.join().is_err();
        }
        if let Some(request_id) = shutdown_request {
            send_protocol_batch(
                &writer,
                vec![envelope(
                    request_id,
                    Payload::ShutdownResponse(v1::ShutdownResponse { accepted: true }),
                )],
            )?;
            let _ = writeln!(diagnostics, "rmsd: orderly shutdown");
        }
        writer.close();
        let writer_result = writer_thread
            .join()
            .map_err(|_| anyhow::anyhow!("rmsd protocol writer panicked"))?;
        writer_result?;
        if worker_panicked {
            bail!("rmsd generation worker panicked");
        }
        service_result
    })
}

enum GameArtJob {
    Prepare(v1::GameArtPrepareRequest),
    Sprites(v1::GameArtSpritesRequest),
}

struct GameArtWorkerContext {
    token: Arc<AtomicCancellationToken>,
    writer: ProtocolWriter,
    request_id: String,
}

impl game_art::JobContext for GameArtWorkerContext {
    fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    fn progress(&mut self, phase: v1::GameArtPhase, completed: u32, total: u32) {
        let _ = send_protocol_batch(
            &self.writer,
            vec![envelope(
                self.request_id.clone(),
                Payload::GameArtProgressEvent(v1::GameArtProgressEvent {
                    phase: phase as i32,
                    completed,
                    total,
                }),
            )],
        );
    }
}

fn admit_game_art<'scope>(
    scope: &'scope thread::Scope<'scope, '_>,
    workers: &mut Vec<thread::ScopedJoinHandle<'scope, ()>>,
    writer: &ProtocolWriter,
    active: &Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
    auxiliary_workers: &Arc<AtomicUsize>,
    request_id: String,
    job: GameArtJob,
) -> Result<()> {
    const MAXIMUM_ACTIVE_REQUESTS: usize = 8;
    let token = Arc::new(AtomicCancellationToken::default());
    {
        let mut registry = active.lock().expect("active generation registry poisoned");
        if request_id.is_empty()
            || registry.len() >= MAXIMUM_ACTIVE_REQUESTS
            || registry.contains_key(&request_id)
        {
            return send_protocol_batch(
                writer,
                vec![structured_error(
                    request_id,
                    ErrorCode::MalformedRequest,
                    "game art request identity is empty or duplicate, or the queue is full",
                    true,
                )],
            );
        }
        registry.insert(request_id.clone(), Arc::clone(&token));
    }
    let registration = ActiveGenerationRegistration::new(request_id.clone(), Arc::clone(active));
    let Some(slot) = AuxiliaryWorkerSlot::acquire(auxiliary_workers) else {
        drop(registration);
        return send_protocol_batch(writer, vec![auxiliary_workers_busy(request_id)]);
    };
    let worker_writer = writer.clone();
    workers.push(scope.spawn(move || {
        lower_current_thread_priority();
        let mut registration = registration;
        let mut context = GameArtWorkerContext {
            token,
            writer: worker_writer.clone(),
            request_id: request_id.clone(),
        };
        let response = match &job {
            GameArtJob::Prepare(request) => game_art::prepare(request, &mut context),
            GameArtJob::Sprites(request) => game_art::sprites(request, &mut context),
        };
        registration.remove();
        drop(slot);
        let _ = send_protocol_batch(
            &worker_writer,
            vec![envelope(request_id, Payload::GameArtResponse(response))],
        );
    }));
    Ok(())
}

const MAXIMUM_CONTROL_EXCHANGES: usize = 2;

struct ControlExchangeContext {
    token: Arc<AtomicCancellationToken>,
    writer: ProtocolWriter,
    request_id: String,
}

impl control_pipe::ExchangeObserver for ControlExchangeContext {
    fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    fn chunk(&mut self, data: &[u8]) {
        let _ = send_protocol_batch(
            &self.writer,
            vec![envelope(
                self.request_id.clone(),
                Payload::ControlPipeResponseChunk(v1::ControlPipeResponseChunk {
                    data: data.to_vec(),
                }),
            )],
        );
    }
}

fn admit_control_exchange<'scope>(
    scope: &'scope thread::Scope<'scope, '_>,
    workers: &mut Vec<thread::ScopedJoinHandle<'scope, ()>>,
    writer: &ProtocolWriter,
    active: &Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
    control_exchanges: &Arc<AtomicUsize>,
    request_id: String,
    request: v1::ControlPipeExchangeRequest,
) -> Result<()> {
    let Some(slot) = ControlExchangeSlot::acquire(control_exchanges) else {
        return send_protocol_batch(
            writer,
            vec![structured_error(
                request_id,
                ErrorCode::MalformedRequest,
                "AoE2Control exchanges are already in flight; retry when one finishes",
                true,
            )],
        );
    };
    let token = Arc::new(AtomicCancellationToken::default());
    {
        let mut registry = active.lock().expect("active generation registry poisoned");
        if request_id.is_empty() || registry.contains_key(&request_id) {
            drop(slot);
            return send_protocol_batch(
                writer,
                vec![structured_error(
                    request_id,
                    ErrorCode::MalformedRequest,
                    "AoE2Control exchange identity is empty or duplicate",
                    false,
                )],
            );
        }
        registry.insert(request_id.clone(), Arc::clone(&token));
    }
    let registration = ActiveGenerationRegistration::new(request_id.clone(), Arc::clone(active));
    let worker_writer = writer.clone();
    workers.push(scope.spawn(move || {
        let mut registration = registration;
        let mut context = ControlExchangeContext {
            token,
            writer: worker_writer.clone(),
            request_id: request_id.clone(),
        };
        let response =
            control_pipe::exchange(&control_pipe::endpoint_pipe_name(), &request, &mut context);
        registration.remove();
        drop(slot);
        let _ = send_protocol_batch(
            &worker_writer,
            vec![envelope(
                request_id,
                Payload::ControlPipeExchangeResponse(response),
            )],
        );
    }));
    Ok(())
}

struct ControlExchangeSlot(Arc<AtomicUsize>);

impl ControlExchangeSlot {
    fn acquire(active: &Arc<AtomicUsize>) -> Option<Self> {
        active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAXIMUM_CONTROL_EXCHANGES).then_some(current + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(active)))
    }
}

impl Drop for ControlExchangeSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn lower_current_thread_priority() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

pub const MAXIMUM_AUXILIARY_WORKERS: usize = 2;

struct AuxiliaryWorkerSlot(Arc<AtomicUsize>);

impl AuxiliaryWorkerSlot {
    fn acquire(active: &Arc<AtomicUsize>) -> Option<Self> {
        active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAXIMUM_AUXILIARY_WORKERS).then_some(current + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(active)))
    }
}

impl Drop for AuxiliaryWorkerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

const MAXIMUM_AUXILIARY_READ_WAITERS: usize = 16;

#[derive(Clone, Default)]
struct AuxiliaryReads(Arc<Mutex<BTreeMap<Vec<u8>, Vec<String>>>>);

struct AuxiliaryRead {
    reads: AuxiliaryReads,
    key: Option<Vec<u8>>,
    request_id: String,
}

impl AuxiliaryReads {
    fn admit(&self, key: Vec<u8>, request_id: &str) -> Option<AuxiliaryRead> {
        let mut reads = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        let key = match reads.get_mut(&key) {
            Some(waiters) if waiters.len() < MAXIMUM_AUXILIARY_READ_WAITERS => {
                waiters.push(request_id.to_owned());
                return None;
            }
            Some(_) => None,
            None => {
                reads.insert(key.clone(), vec![request_id.to_owned()]);
                Some(key)
            }
        };
        Some(AuxiliaryRead {
            reads: self.clone(),
            key,
            request_id: request_id.to_owned(),
        })
    }
}

impl AuxiliaryRead {
    fn finish(mut self) -> Vec<String> {
        let request_id = std::mem::take(&mut self.request_id);
        let Some(key) = self.key.take() else {
            return vec![request_id];
        };
        self.reads
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&key)
            .unwrap_or_else(|| vec![request_id])
    }
}

impl Drop for AuxiliaryRead {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.reads
                .0
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&key);
        }
    }
}

fn auxiliary_read_key(kind: u8, request: &impl prost::Message) -> Vec<u8> {
    let mut key = vec![kind];
    key.extend(request.encode_to_vec());
    key
}

fn auxiliary_workers_busy(request_id: String) -> v1::Envelope {
    structured_error(
        request_id,
        ErrorCode::Internal,
        format!(
            "rmsd is already reading {MAXIMUM_AUXILIARY_WORKERS} installation data files; retry when one finishes"
        ),
        true,
    )
}

type ProtocolWriter = Arc<PriorityWriter>;

struct ServiceTeardown {
    writer: ProtocolWriter,
    active: Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
}

impl Drop for ServiceTeardown {
    fn drop(&mut self) {
        for token in self
            .active
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .values()
        {
            let _ = token.cancel();
        }
        self.writer.close();
    }
}

const STRUCTURAL_QUEUE_BATCHES: usize = 64;

struct CheckpointLaneEntry {
    identity: Option<v1::RequestIdentity>,
    sample: Option<v1::VisualCheckpointSample>,
    lane: CoalescingCheckpointLane,
}

#[derive(Default)]
struct WriterQueue {
    structural: VecDeque<Vec<v1::Envelope>>,
    checkpoints: BTreeMap<String, CheckpointLaneEntry>,
    closed: bool,
    failed: bool,
}

#[derive(Default)]
pub(crate) struct PriorityWriter {
    queue: Mutex<WriterQueue>,
    readable: Condvar,
    writable: Condvar,
}

enum WriterItem {
    Structural(Vec<v1::Envelope>),
    Checkpoint(Box<v1::Envelope>),
}

impl PriorityWriter {
    fn lock(&self) -> std::sync::MutexGuard<'_, WriterQueue> {
        self.queue
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub(crate) fn send(&self, batch: Vec<v1::Envelope>) -> std::result::Result<(), ()> {
        let mut queue = self.lock();
        while queue.structural.len() >= STRUCTURAL_QUEUE_BATCHES && !queue.failed && !queue.closed {
            queue = self
                .writable
                .wait(queue)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if queue.failed || queue.closed {
            return Err(());
        }
        queue.structural.push_back(batch);
        self.readable.notify_one();
        Ok(())
    }

    pub(crate) fn try_send(&self, batch: Vec<v1::Envelope>) -> bool {
        let mut queue = self.lock();
        if queue.failed || queue.closed || queue.structural.len() >= STRUCTURAL_QUEUE_BATCHES {
            return false;
        }
        queue.structural.push_back(batch);
        self.readable.notify_one();
        true
    }

    pub(crate) fn open_checkpoints(
        &self,
        request_id: &str,
        identity: Option<v1::RequestIdentity>,
        sample: Option<v1::VisualCheckpointSample>,
    ) {
        let mut queue = self.lock();
        if queue.checkpoints.len() < 64 {
            queue.checkpoints.insert(
                request_id.to_owned(),
                CheckpointLaneEntry {
                    identity,
                    sample,
                    lane: CoalescingCheckpointLane::default(),
                },
            );
        }
    }

    pub(crate) fn offer_checkpoint(&self, request_id: &str, checkpoint: VisualCheckpoint) -> bool {
        let mut queue = self.lock();
        if queue.failed || queue.closed {
            return false;
        }
        let Some(entry) = queue.checkpoints.get_mut(request_id) else {
            return false;
        };
        let accepted = entry.lane.offer(checkpoint);
        if accepted {
            self.readable.notify_one();
        }
        accepted
    }

    pub(crate) fn revoke_checkpoints(&self, request_id: &str) {
        self.lock().checkpoints.remove(request_id);
    }

    pub(crate) fn close(&self) {
        let mut queue = self.lock();
        queue.closed = true;
        queue.checkpoints.clear();
        self.readable.notify_all();
        self.writable.notify_all();
    }

    fn fail(&self) {
        let mut queue = self.lock();
        queue.failed = true;
        queue.structural.clear();
        queue.checkpoints.clear();
        self.readable.notify_all();
        self.writable.notify_all();
    }

    fn next(&self) -> Option<WriterItem> {
        let mut queue = self.lock();
        loop {
            if queue.failed {
                return None;
            }
            if let Some(batch) = queue.structural.pop_front() {
                self.writable.notify_one();
                return Some(WriterItem::Structural(batch));
            }
            let pending = queue
                .checkpoints
                .iter_mut()
                .find(|(_, entry)| entry.lane.has_pending());
            if let Some((request_id, entry)) = pending
                && let Some(checkpoint) = entry.lane.take()
            {
                return Some(WriterItem::Checkpoint(Box::new(envelope(
                    request_id.clone(),
                    Payload::VisualCheckpointEvent(protocol_visual_checkpoint(
                        entry.identity.clone(),
                        entry.sample,
                        checkpoint,
                    )),
                ))));
            }
            if queue.closed {
                return None;
            }
            queue = self
                .readable
                .wait(queue)
                .unwrap_or_else(|poison| poison.into_inner());
        }
    }
}

pub(crate) fn protocol_visual_checkpoint(
    identity: Option<v1::RequestIdentity>,
    sample: Option<v1::VisualCheckpointSample>,
    checkpoint: VisualCheckpoint,
) -> v1::VisualCheckpointEvent {
    v1::VisualCheckpointEvent {
        identity,
        contract_major: rms_engine::VISUAL_CHECKPOINT_CONTRACT_MAJOR,
        contract_minor: rms_engine::VISUAL_CHECKPOINT_CONTRACT_MINOR,
        revision: checkpoint.revision,
        base_revision: checkpoint.base_revision,
        stage: protocol_visual_stage(checkpoint.stage) as i32,
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
        sample,
    }
}

fn protocol_visual_stage(stage: VisualStage) -> v1::VisualCheckpointStage {
    match stage {
        VisualStage::Land => v1::VisualCheckpointStage::Land,
        VisualStage::Elevation => v1::VisualCheckpointStage::Elevation,
        VisualStage::Cliffs => v1::VisualCheckpointStage::Cliffs,
        VisualStage::Terrain => v1::VisualCheckpointStage::Terrain,
        VisualStage::Connections => v1::VisualCheckpointStage::Connections,
        VisualStage::Objects => v1::VisualCheckpointStage::Objects,
        VisualStage::SampleComplete => v1::VisualCheckpointStage::SampleComplete,
    }
}

fn write_protocol_batches<W: Write>(output: &mut W, writer: &PriorityWriter) -> Result<()> {
    let result = (|| -> Result<()> {
        while let Some(item) = writer.next() {
            match item {
                WriterItem::Structural(batch) => {
                    latency::terminal_picked(&batch);
                    for message in &batch {
                        match write_frame(output, message) {
                            Ok(()) => {}
                            Err(FrameError::EncodeTooLarge(length)) => {
                                let replacement = frame_too_large_error(
                                    message.request_id.clone(),
                                    payload_description(message.payload.as_ref()),
                                    length,
                                );
                                write_frame(output, &replacement)
                                    .context("writing the frame-bound replacement error")?;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    latency::terminal_written(&batch);
                }
                WriterItem::Checkpoint(message) => match write_frame(output, &message) {
                    Ok(()) | Err(FrameError::EncodeTooLarge(_)) => {}
                    Err(error) => return Err(error.into()),
                },
            }
        }
        Ok(())
    })();
    if result.is_err() {
        writer.fail();
    }
    result
}

fn payload_description(payload: Option<&Payload>) -> &'static str {
    match payload {
        Some(Payload::GenerationResponse(_)) => "generation response",
        Some(Payload::GenerationEvent(_)) => "generation event",
        Some(Payload::ProgressEvent(_)) => "progress event",
        Some(Payload::AnalysisResponse(_)) => "analysis response",
        Some(Payload::ConfigurationCatalogResponse(_)) => "configuration catalog response",
        Some(Payload::PresentationStringIdsResponse(_)) => "presentation string identity response",
        _ => "protocol message",
    }
}

fn send_protocol_batch(writer: &ProtocolWriter, batch: Vec<v1::Envelope>) -> Result<()> {
    writer
        .send(batch)
        .map_err(|()| anyhow::anyhow!("rmsd protocol writer disconnected"))
}

#[allow(clippy::too_many_arguments)]
fn generation_worker(
    envelope_request_id: String,
    identity_request_id: String,
    request: v1::GenerationRequest,
    cancellation: Arc<AtomicCancellationToken>,
    active: Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
    generation_gate: Arc<Mutex<()>>,
    writer: ProtocolWriter,
) {
    let identity = request.identity.clone();
    let mut registration = ActiveGenerationRegistration::new(identity_request_id.clone(), active);
    let execution = match generation_gate.lock() {
        Ok(_gate) if cancellation.is_cancelled() => Err(cancelled_failure(
            0,
            "generation request was cancelled while queued",
        )),
        Ok(_gate) => execute_generation(
            request,
            &identity_request_id,
            cancellation.as_ref(),
            &writer,
        ),
        Err(_) => Err(internal_failure("generation gate was poisoned")),
    };
    writer.revoke_checkpoints(&identity_request_id);
    let execution =
        execution.and_then(|execution| framed_generation_response(&envelope_request_id, execution));
    latency::step(&identity_request_id, "frame");
    match execution {
        Ok((sequence, response)) => {
            if let Some(Payload::GenerationResponse(response)) = &response.payload
                && let Some(cost) = &response.execution_cost
            {
                latency::engine(&identity_request_id, cost.total_us);
            }
            registration.remove();
            let state_hash = match &response.payload {
                Some(Payload::GenerationResponse(response)) => response.semantic_hash.clone(),
                _ => Vec::new(),
            };
            let completed = v1::GenerationEvent {
                identity,
                sequence,
                kind: v1::GenerationEventKind::GenerationCompleted as i32,
                stage: "finalize".to_owned(),
                completed: 1,
                total: 1,
                state_hash,
                delta: None,
                detail: "generation committed".to_owned(),
                initialization: None,
            };
            let _ = send_protocol_batch(
                &writer,
                vec![
                    envelope(
                        envelope_request_id.clone(),
                        Payload::GenerationEvent(completed),
                    ),
                    response,
                ],
            );
        }
        Err(failure) => {
            registration.remove();
            let kind = if failure.code == ErrorCode::Cancelled {
                v1::GenerationEventKind::Cancelled
            } else {
                v1::GenerationEventKind::Failed
            };
            let terminal = terminal_generation_event(
                identity,
                failure.terminal_sequence,
                kind,
                &failure.message,
            );
            let mut error = structured_error(
                envelope_request_id.clone(),
                failure.code,
                failure.message,
                failure.retryable,
            );
            if let Some(Payload::Error(error)) = error.payload.as_mut() {
                error.details = failure.details;
            }
            let _ = send_protocol_batch(
                &writer,
                vec![
                    envelope(envelope_request_id, Payload::GenerationEvent(terminal)),
                    error,
                ],
            );
        }
    }
}

fn framed_generation_response(
    envelope_request_id: &str,
    execution: GenerationExecution,
) -> Result<(u64, v1::Envelope), ProtocolFailure> {
    let sequence = execution.last_sequence.saturating_add(1);
    let mut response = envelope(
        envelope_request_id,
        Payload::GenerationResponse(execution.response),
    );
    connection_routes::fit_connection_routes(&mut response);
    fits_frame(&response)
        .map(|()| (sequence, response))
        .map_err(|length| frame_too_large_failure("generation response", length, sequence))
}

struct ActiveGenerationRegistration {
    request_id: String,
    active: Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
    registered: bool,
}

impl ActiveGenerationRegistration {
    fn new(
        request_id: String,
        active: Arc<Mutex<BTreeMap<String, Arc<AtomicCancellationToken>>>>,
    ) -> Self {
        Self {
            request_id,
            active,
            registered: true,
        }
    }

    fn remove(&mut self) {
        if self.registered {
            self.active
                .lock()
                .expect("active generation registry poisoned")
                .remove(&self.request_id);
            self.registered = false;
        }
    }
}

impl Drop for ActiveGenerationRegistration {
    fn drop(&mut self) {
        self.remove();
    }
}

struct ProtocolEventSink {
    writer: ProtocolWriter,
    request_id: String,
    identity: Option<v1::RequestIdentity>,
    last_sequence: u64,
}

impl ProtocolEventSink {
    fn new(
        writer: ProtocolWriter,
        request_id: String,
        identity: Option<v1::RequestIdentity>,
    ) -> Self {
        Self {
            writer,
            request_id,
            identity,
            last_sequence: 0,
        }
    }
}

impl GenerationEventSink for ProtocolEventSink {
    fn emit(&mut self, event: GenerationEvent) -> Result<(), TraceSinkError> {
        if event.sequence <= self.last_sequence {
            return Err(TraceSinkError::OutOfOrder {
                previous: self.last_sequence,
                next: event.sequence,
            });
        }
        self.last_sequence = event.sequence;
        let started = latency::mark();
        let mut batch = vec![envelope(
            self.request_id.clone(),
            Payload::ProgressEvent(protocol_progress(&event, self.identity.clone())),
        )];
        if let Some(event) = protocol_generation_event(&event, self.identity.clone()) {
            batch.push(envelope(
                self.request_id.clone(),
                Payload::GenerationEvent(event),
            ));
        }
        let sent = self
            .writer
            .send(batch)
            .map_err(|()| TraceSinkError::ConsumerDisconnected);
        latency::within(&self.request_id, "trace-emit", started);
        sent
    }
}

#[derive(Clone, Debug)]
pub struct SourceAnalysis {
    pub diagnostics: Vec<v1::Diagnostic>,
    pub semantic_hash: Vec<u8>,
    pub source_catalog: Option<SourceCatalog>,
}

pub const MAXIMUM_ANALYSIS_SOURCE_BYTES: usize = 16 * 1024 * 1024;

pub fn analyze_source(uri: &str, bytes: &[u8], profile_id: &str) -> SourceAnalysis {
    analyze_source_with_catalog(uri, bytes, profile_id, None)
}

fn analyze_source_with_catalog(
    uri: &str,
    bytes: &[u8],
    profile_id: &str,
    catalog: Option<&v1::SourceCatalog>,
) -> SourceAnalysis {
    if bytes.len() > MAXIMUM_ANALYSIS_SOURCE_BYTES {
        return failed_source_analysis(
            uri,
            "RMS1001",
            format!("source exceeds the {MAXIMUM_ANALYSIS_SOURCE_BYTES}-byte analysis bound"),
        );
    }
    let source_id = match SourceId::new(uri.to_owned()) {
        Ok(source_id) => source_id,
        Err(error) => return failed_source_analysis(uri, "RMS0001", error.to_string()),
    };
    let source = match SourceText::from_bytes(source_id, bytes) {
        Ok(source) => source,
        Err(error) => return failed_source_analysis(uri, "RMS0002", error.to_string()),
    };
    let tolerant = analyze_document(&source);
    let mut diagnostics = tolerant
        .diagnostics
        .iter()
        .map(|diagnostic| {
            protocol_diagnostic(
                &source,
                &diagnostic.code,
                &diagnostic.message,
                match diagnostic.severity {
                    AnalysisSeverity::Error => v1::DiagnosticSeverity::Error,
                    AnalysisSeverity::Warning => v1::DiagnosticSeverity::Warning,
                },
                diagnostic.range,
            )
        })
        .collect::<Vec<_>>();
    let catalog = match catalog.map(protocol_source_catalog).transpose() {
        Ok(catalog) => catalog,
        Err(error) => {
            diagnostics.push(protocol_diagnostic(
                &source,
                "RMS2030",
                &error.message,
                v1::DiagnosticSeverity::Error,
                ByteRange {
                    start: ByteOffset(0),
                    end: ByteOffset(source.bytes().len() as u32),
                },
            ));
            return SourceAnalysis {
                diagnostics,
                semantic_hash: Vec::new(),
                source_catalog: None,
            };
        }
    };
    let strict = match analysis_options(profile_id, catalog.as_ref()) {
        Ok(options) => {
            if let Some(catalog) = &catalog {
                analyze_semantics_catalog(catalog, options)
            } else {
                analyze_semantics_single(source.clone(), options)
            }
        }
        Err(message) => Err(rms_semantics::StrictParseError {
            kind: rms_semantics::StrictParseErrorKind::Resolution,
            code: "RMS2031",
            message,
            source_chain: Vec::new(),
            range: None,
        }),
    };
    match strict {
        Ok(program) => SourceAnalysis {
            diagnostics,
            semantic_hash: program.identity.semantic_hash.to_vec(),
            source_catalog: catalog,
        },
        Err(error) => {
            if !diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == error.code)
            {
                diagnostics.push(protocol_diagnostic(
                    &source,
                    error.code,
                    &error.message,
                    v1::DiagnosticSeverity::Error,
                    error.range.unwrap_or(ByteRange {
                        start: ByteOffset(0),
                        end: ByteOffset(source.bytes().len() as u32),
                    }),
                ));
            }
            SourceAnalysis {
                diagnostics,
                semantic_hash: Vec::new(),
                source_catalog: catalog,
            }
        }
    }
}

fn analysis_options(
    profile_id: &str,
    catalog: Option<&SourceCatalog>,
) -> Result<rms_semantics::StrictParseOptions, String> {
    let profiles = ProfileCatalog::frozen_current().map_err(|error| error.to_string())?;
    let profile_id = catalog.map_or(profile_id, SourceCatalog::profile_id);
    let profile = if profile_id.is_empty() {
        profiles.profiles().next()
    } else {
        profiles.get(profile_id)
    }
    .ok_or_else(|| format!("unknown behavior profile {profile_id}"))?;
    let vocabulary = match catalog {
        Some(catalog) => catalog.implicit_definitions().clone(),
        None => packaged_support_bundles()
            .map_err(|error| error.to_string())?
            .iter()
            .find(|bundle| bundle.manifest.behavior_profile_id == profile.profile_id)
            .ok_or_else(|| format!("no packaged bundle supports {}", profile.profile_id))?
            .vocabulary()
            .map_err(|error| error.to_string())?,
    };
    Ok(product_strict_options(profile, &vocabulary))
}

fn product_content_packs(
    profile_id: &str,
) -> Result<Vec<Cow<'static, NeutralContentPack>>, ProtocolFailure> {
    let packs = packaged_support_bundles()
        .map_err(|error| internal_failure(format!("packaged support bundle failed: {error}")))?
        .iter()
        .map(|bundle| Cow::Borrowed(&bundle.content));
    #[cfg(feature = "internal-fixtures")]
    let packs = packs.chain([
        Cow::Owned(synthetic_content_pack(profile_id)),
        Cow::Owned(exact_reference_content_pack(profile_id)),
    ]);
    #[cfg(not(feature = "internal-fixtures"))]
    let _ = profile_id;
    Ok(packs.collect())
}

enum ResolvedContent {
    Product(Box<Cow<'static, NeutralContentPack>>),
    Local(Arc<NeutralContentPack>),
}

impl std::ops::Deref for ResolvedContent {
    type Target = NeutralContentPack;

    fn deref(&self) -> &NeutralContentPack {
        match self {
            Self::Product(content) => content,
            Self::Local(content) => content,
        }
    }
}

fn resolve_content_pack(
    pack_id: &str,
    profile_id: &str,
) -> Result<Cow<'static, NeutralContentPack>, ProtocolFailure> {
    product_content_packs(profile_id)?
        .into_iter()
        .find(|pack| pack.pack_id == pack_id)
        .ok_or_else(|| malformed("content pack identity is unavailable"))
}

fn require_catalog_standard_includes(
    catalog: &SourceCatalog,
    content: &NeutralContentPack,
) -> Result<(), ProtocolFailure> {
    let access = &catalog.roots().standard_includes;
    if content.source.kind == ContentSourceKind::Aoe2deDat {
        return if access.authorized {
            Ok(())
        } else {
            Err(stale(
                "local content requires the linked installation's standard-include access",
            ))
        };
    }
    if content.source.kind != ContentSourceKind::ReviewedBundle {
        return Ok(());
    }
    let bundle = packaged_support_bundles()
        .map_err(|error| internal_failure(format!("packaged support bundle failed: {error}")))?
        .iter()
        .find(|bundle| bundle.content.pack_id == content.pack_id)
        .ok_or_else(|| malformed("content pack identity is unavailable"))?;
    let expected = rms_source::StandardIncludeAccess::new(
        bundle.standard_includes.resolver_identifiers(),
        false,
    )
    .map_err(|error| internal_failure(error.to_string()))?;
    let consistent = if access.authorized {
        expected
            .identifiers
            .iter()
            .all(|identifier| access.identifiers.binary_search(identifier).is_ok())
    } else {
        *access == expected
    };
    if !consistent {
        return Err(stale(
            "source catalog standard-include access does not match the selected version",
        ));
    }
    Ok(())
}

fn failed_source_analysis(uri: &str, code: &str, message: String) -> SourceAnalysis {
    SourceAnalysis {
        diagnostics: vec![v1::Diagnostic {
            code: code.to_owned(),
            message,
            severity: v1::DiagnosticSeverity::Error as i32,
            source_id: uri.to_owned(),
            range: None,
        }],
        semantic_hash: Vec::new(),
        source_catalog: None,
    }
}

fn protocol_diagnostic(
    source: &SourceText,
    code: &str,
    message: &str,
    severity: v1::DiagnosticSeverity,
    range: ByteRange,
) -> v1::Diagnostic {
    let utf16 = source.byte_range_to_utf16(range).ok();
    v1::Diagnostic {
        code: code.to_owned(),
        message: message.to_owned(),
        severity: severity as i32,
        source_id: source.id().as_str().to_owned(),
        range: Some(v1::SourceRange {
            start: utf16.map(|range| v1::SourcePosition {
                line: range.start.line,
                utf16_column: range.start.character,
            }),
            end: utf16.map(|range| v1::SourcePosition {
                line: range.end.line,
                utf16_column: range.end.character,
            }),
            byte_start: u64::from(range.start.0),
            byte_end: u64::from(range.end.0),
        }),
    }
}

struct GenerationExecution {
    last_sequence: u64,
    response: v1::GenerationResponse,
}

struct ProtocolFailure {
    code: ErrorCode,
    message: String,
    retryable: bool,
    terminal_sequence: u64,
    details: BTreeMap<String, String>,
}

fn execute_generation(
    request: v1::GenerationRequest,
    identity_request_id: &str,
    cancellation: &AtomicCancellationToken,
    writer: &ProtocolWriter,
) -> Result<GenerationExecution, ProtocolFailure> {
    latency::step(identity_request_id, "queue");
    if request.source.is_empty() || request.source.len() > 16 * 1024 * 1024 {
        return Err(malformed("source must contain 1 byte to 16 MiB"));
    }
    let document = request
        .document
        .as_ref()
        .ok_or_else(|| malformed("generation document identity is required"))?;
    if document.uri.is_empty() || document.uri.len() > 4096 {
        return Err(malformed("generation document URI is invalid"));
    }
    let profile_catalog = ProfileCatalog::frozen_current()
        .map_err(|error| internal_failure(format!("profile catalog failed: {error}")))?;
    let profile = profile_catalog
        .get(&request.profile_id)
        .ok_or_else(|| unsupported(format!("unknown behavior profile {}", request.profile_id)))?;
    let expected_profile_hash = profile
        .deterministic_hash()
        .map_err(|error| internal_failure(format!("profile hash failed: {error}")))?;
    let requested_profile_hash = fixed_hash(&request.behavior_profile_hash, "behavior profile")?;
    if requested_profile_hash != expected_profile_hash {
        return Err(stale("behavior profile hash does not match the catalog"));
    }
    let certification =
        generation_certification(&profile_catalog, profile, &request.local_product_version)?;

    let content = match request.local_content.as_ref() {
        Some(source) => {
            ResolvedContent::Local(local_content::generation_local_content(&request, source)?)
        }
        None => ResolvedContent::Product(Box::new(resolve_content_pack(
            &request.content_pack_id,
            &profile.profile_id,
        )?)),
    };
    let content_identity = content
        .identity()
        .map_err(|error| internal_failure(format!("content identity failed: {error}")))?;
    if request.content_pack_id != content_identity.pack_id
        || request.content_pack_version != content_identity.pack_version
        || fixed_hash(&request.content_pack_hash, "content pack")? != content_identity.content_hash
        || request.content_source_fingerprint != content_identity.source_fingerprint
    {
        return Err(stale(
            "content pack identity does not match the resolved local pack",
        ));
    }
    latency::step(identity_request_id, "content");
    if request.seed > u64::from(u32::MAX) {
        return Err(malformed("seed must be from 0 to 4294967295"));
    }
    let width = u16::try_from(request.width).map_err(|_| malformed("map width is invalid"))?;
    let height = u16::try_from(request.height).map_err(|_| malformed("map height is invalid"))?;
    let dimensions = MapDimensions { width, height };
    dimensions.tile_count().map_err(map_generation_failure)?;
    let players = protocol_players(&request.players)?;
    let setup_context = protocol_setup_context(request.setup_context.as_ref())?;
    let trace_level = match v1::TraceLevel::try_from(request.trace_level) {
        Ok(v1::TraceLevel::Off) => EngineTraceLevel::Off,
        Ok(v1::TraceLevel::Summary) => EngineTraceLevel::Summary,
        Ok(v1::TraceLevel::Full) => EngineTraceLevel::Full,
        _ => return Err(malformed("trace level must be explicit")),
    };
    let source_hash: [u8; 32] = Sha256::digest(&request.source).into();
    if fixed_hash(&request.source_hash, "source")? != source_hash {
        return Err(stale("source bytes do not match their immutable hash"));
    }
    let source_catalog = request
        .source_catalog
        .as_ref()
        .map(protocol_source_catalog)
        .transpose()?;
    if let Some(catalog) = &source_catalog {
        if catalog.profile_id() != profile.profile_id
            || catalog.content_identity() != protocol_content_identity(&content_identity)
        {
            return Err(stale(
                "source catalog profile/content identity differs from the generation request",
            ));
        }
        let entry = catalog.entry_source().map_err(source_catalog_failure)?;
        if entry.id().as_str() != document.uri
            || entry.bytes() != request.source
            || Sha256::digest(entry.bytes()).as_slice() != source_hash
        {
            return Err(stale(
                "source catalog entry differs from the immutable generation document",
            ));
        }
        if (!document.source_graph_hash.is_empty()
            && fixed_hash(&document.source_graph_hash, "document source graph")?
                != catalog.rms_graph_hash())
            || (!document.source_catalog_hash.is_empty()
                && fixed_hash(&document.source_catalog_hash, "document source catalog")?
                    != catalog.catalog_hash())
        {
            return Err(stale(
                "document identity does not match the supplied source catalog",
            ));
        }
    } else if source_mentions_dependency(&request.source) {
        return Err(malformed(
            "a source catalog is required when the entry mentions an RMS include or external XS dependency",
        ));
    }
    latency::step(identity_request_id, "source-catalog");
    let source_id = SourceId::new(document.uri.clone())
        .map_err(|error| malformed(format!("invalid document identity: {error}")))?;
    let source = SourceText::from_bytes(source_id, request.source.clone())
        .map_err(|error| malformed(format!("invalid source bytes: {error}")))?;
    let vocabulary = content
        .rms_implicit_definitions()
        .map_err(|error| internal_failure(format!("content token environment failed: {error}")))?;
    if let Some(catalog) = &source_catalog {
        require_catalog_vocabulary(catalog, &vocabulary).map_err(|error| stale(error.message))?;
        require_catalog_standard_includes(catalog, &content)?;
    }
    let mut parse_options = product_strict_options(profile, &vocabulary);
    setup_context
        .configure_strict_parser(
            &mut parse_options,
            request.seed as u32,
            dimensions,
            &request.map_size,
            &players,
        )
        .map_err(map_generation_failure)?;
    let observe_execution = request.backend == v1::GenerationBackend::Exact as i32;
    let progress_writer = writer.clone();
    let progress_request_id = identity_request_id.to_owned();
    let progress_identity = request.identity.clone();
    let mut collector = if observe_execution && request.execution_progress {
        ExecutionCostCollector::with_progress(move |progress| {
            let _ = progress_writer.try_send(vec![envelope(
                progress_request_id.clone(),
                Payload::ExecutionProgressEvent(protocol_execution_progress(
                    progress_identity.clone(),
                    progress,
                )),
            )]);
        })
    } else {
        ExecutionCostCollector::new()
    };
    let progressive = observe_execution && request.progressive_preview;
    if progressive {
        writer.open_checkpoints(identity_request_id, request.identity.clone(), None);
    }
    let checkpoint_writer = writer.clone();
    let checkpoint_request_id = identity_request_id.to_owned();
    let mut observed = if progressive {
        VisualCheckpointObserver::new(&mut collector, move |checkpoint| {
            checkpoint_writer.offer_checkpoint(&checkpoint_request_id, checkpoint)
        })
    } else {
        VisualCheckpointObserver::forwarding(&mut collector)
    };
    let mut unobserved = NoopExecutionObserver;
    let observer: &mut dyn ExecutionObserver = if observe_execution {
        &mut observed
    } else {
        &mut unobserved
    };
    latency::step(identity_request_id, "validate");
    let parse = || {
        if let Some(catalog) = &source_catalog {
            analyze_semantics_catalog(catalog, parse_options)
        } else {
            analyze_semantics_single(source, parse_options)
        }
    };
    let semantic_program = if observe_execution {
        observe_exact_script_parse(observer, parse)
    } else {
        parse()
    }
    .map_err(|error| {
        malformed(format!(
            "the script could not be analyzed ({}): {}",
            error.code, error.message
        ))
    })?;
    latency::step(identity_request_id, "parse");
    if !document.semantic_hash.is_empty()
        && fixed_hash(&document.semantic_hash, "document semantic")?
            != semantic_program.identity.semantic_hash
    {
        return Err(stale(
            "the script changed after this generation was requested",
        ));
    }
    let backend = v1::GenerationBackend::try_from(request.backend)
        .map_err(|_| unsupported("generation backend is unsupported"))?;
    let backend_id = match backend {
        #[cfg(feature = "internal-fixtures")]
        v1::GenerationBackend::SyntheticTest => SyntheticGenerationBackend::default().backend_id(),
        #[cfg(not(feature = "internal-fixtures"))]
        v1::GenerationBackend::SyntheticTest => {
            return Err(unsupported(
                "the synthetic test backend is unavailable in this product build",
            ));
        }
        v1::GenerationBackend::Exact => ExactRmsGenerationBackend.backend_id(),
        v1::GenerationBackend::Unspecified => {
            return Err(unsupported("generation backend must be explicit"));
        }
    };
    if backend == v1::GenerationBackend::Exact && !profile.supports_exact_generation() {
        return Err(unsupported(
            "map generation is not available for the selected game version",
        ));
    }
    match backend {
        #[cfg(feature = "internal-fixtures")]
        v1::GenerationBackend::SyntheticTest if request.content_pack_id != SYNTHETIC_PACK_ID => {
            return Err(malformed(
                "the synthetic test backend requires the synthetic neutral pack",
            ));
        }
        v1::GenerationBackend::Exact if content.source.kind == ContentSourceKind::Synthetic => {
            return Err(malformed(
                "map generation needs the game data of a game version, not test data",
            ));
        }
        _ => {}
    }
    let internal_request = GenerationRequest {
        document_uri: document.uri.clone(),
        document_revision: document.revision,
        document_hash: source_hash,
        source_graph_hash: source_catalog
            .as_ref()
            .map_or(source_hash, SourceCatalog::rms_graph_hash),
        semantic_hash: semantic_program.identity.semantic_hash,
        behavior_profile: profile.identity(),
        behavior_profile_hash: expected_profile_hash,
        content_pack: content_identity,
        backend_id: backend_id.to_owned(),
        seed: request.seed as u32,
        dimensions,
        map_size: request.map_size.clone(),
        players,
        setup_context,
        trace_level,
    };
    internal_request
        .validate()
        .map_err(map_generation_failure)?;
    let content_view = CompatibleContentView::new(&content, &profile.profile_id)
        .map_err(|error| malformed(format!("content pack is incompatible: {error}")))?;
    let resolved = ResolvedGenerationInput {
        semantic_program: &semantic_program,
        request: &internal_request,
        content: content_view,
    };
    if cancellation.is_cancelled() {
        return Err(cancelled_failure(
            0,
            "generation request was cancelled before execution",
        ));
    }
    let request_hash = internal_request
        .deterministic_hash()
        .map_err(map_generation_failure)?;
    let provenance_operations = protocol_provenance_operations(&semantic_program);
    let stream_dimensions = match backend {
        v1::GenerationBackend::Exact => {
            exact_effective_dimensions(&semantic_program, &internal_request)
                .map_err(map_generation_failure)?
        }
        _ => dimensions,
    };
    let accepted = envelope(
        identity_request_id,
        Payload::GenerationEvent(v1::GenerationEvent {
            identity: request.identity.clone(),
            sequence: 0,
            kind: v1::GenerationEventKind::GenerationStarted as i32,
            stage: String::new(),
            completed: 0,
            total: u32::try_from(
                stream_dimensions
                    .tile_count()
                    .map_err(map_generation_failure)?,
            )
            .unwrap_or(u32::MAX),
            state_hash: Vec::new(),
            delta: None,
            detail: "generation accepted".to_owned(),
            initialization: Some(v1::GenerationInitialization {
                width: u32::from(stream_dimensions.width),
                height: u32::from(stream_dimensions.height),
                backend_identity: backend_id.to_owned(),
                semantic_program_hash: semantic_program.identity.semantic_hash.to_vec(),
                request_hash: request_hash.to_vec(),
                provenance_operations,
                source_catalog_revision: source_catalog.as_ref().map_or(0, SourceCatalog::revision),
                source_catalog_hash: source_catalog
                    .as_ref()
                    .map_or_else(Vec::new, |catalog| catalog.catalog_hash().to_vec()),
                source_graph_hash: internal_request.source_graph_hash.to_vec(),
                external_asset_hash: source_catalog
                    .as_ref()
                    .map_or_else(Vec::new, |catalog| catalog.asset_graph_hash().to_vec()),
            }),
        }),
    );
    fits_frame(&accepted)
        .map_err(|length| frame_too_large_failure("generation initialization", length, 0))?;
    send_protocol_batch(writer, vec![accepted])
        .map_err(|error| internal_failure(error.to_string()))?;
    let mut events = ProtocolEventSink::new(
        writer.clone(),
        identity_request_id.to_owned(),
        request.identity.clone(),
    );
    #[cfg(feature = "internal-fixtures")]
    let synthetic_options = synthetic_options(request.internal_fixture_scenario)?;
    latency::step(identity_request_id, "prepare");
    let map = match backend {
        #[cfg(feature = "internal-fixtures")]
        v1::GenerationBackend::SyntheticTest => SyntheticGenerationBackend::new(synthetic_options)
            .generate(resolved, &mut events, cancellation),
        #[cfg(not(feature = "internal-fixtures"))]
        v1::GenerationBackend::SyntheticTest => unreachable!("rejected during validation"),
        v1::GenerationBackend::Exact => {
            if request.internal_fixture_scenario != v1::InternalFixtureScenario::Unspecified as i32
            {
                return Err(malformed(
                    "internal fixture scenarios require the synthetic test backend",
                ));
            }
            ExactRmsGenerationBackend.generate_observed(
                resolved,
                &mut events,
                cancellation,
                observer,
            )
        }
        v1::GenerationBackend::Unspecified => unreachable!("validated above"),
    };
    drop(observed);
    latency::step(identity_request_id, "generate");
    let map = map.map_err(|error| {
        let failure = match error {
            GenerationError::MissingContentDefinition { kind, id } => missing_content_failure(
                kind,
                id,
                &request.content_pack_id,
                request.seed,
                certification,
                &request.local_product_version,
            ),
            error => map_generation_failure(error),
        };
        with_terminal_sequence(failure, events.last_sequence + 1)
    })?;
    if cancellation.is_cancelled() {
        return Err(cancelled_failure(
            events.last_sequence + 1,
            "generation request was cancelled before commit",
        ));
    }
    let construct_verification = if backend == v1::GenerationBackend::Exact {
        construct_verification(
            profile,
            certification,
            matches!(content, ResolvedContent::Local(_)),
            &request.local_product_version,
            &semantic_program,
        )
    } else {
        None
    };
    let mut response = protocol_generation_response(
        request,
        &semantic_program,
        &internal_request,
        &content,
        map,
        false,
        identity_request_id,
    )?;
    response.certification = protocol_certification(certification)? as i32;
    response.execution_cost = if observe_execution {
        collector
            .finish()
            .map(|summary| protocol_execution_cost(&summary, v1::ExecutionCostContext::Isolated))
    } else {
        None
    };
    response.construct_verification = construct_verification;
    latency::step(identity_request_id, "respond");
    if !cancellation.begin_commit() {
        return Err(cancelled_failure(
            events.last_sequence + 1,
            "generation request was cancelled before commit",
        ));
    }
    Ok(GenerationExecution {
        last_sequence: events.last_sequence,
        response,
    })
}

fn protocol_execution_step(step: &StepCost) -> v1::ExecutionCostStep {
    v1::ExecutionCostStep {
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
    }
}

pub fn protocol_execution_cost(
    summary: &ExecutionCostSummary,
    context: v1::ExecutionCostContext,
) -> v1::ExecutionCostSummary {
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
                steps: group.steps.iter().map(protocol_execution_step).collect(),
            })
            .collect(),
        context: context as i32,
    }
}

fn protocol_execution_progress(
    identity: Option<v1::RequestIdentity>,
    progress: ExecutionProgress<'_>,
) -> v1::ExecutionProgressEvent {
    let mut event = v1::ExecutionProgressEvent {
        identity,
        contract_major: rms_engine::EXECUTION_COST_CONTRACT_MAJOR,
        contract_minor: rms_engine::EXECUTION_COST_CONTRACT_MINOR,
        ..Default::default()
    };
    match progress {
        ExecutionProgress::Started { plan } => {
            event.kind = v1::ExecutionProgressKind::Started as i32;
            event.plan = plan.iter().map(|step| step.id().to_owned()).collect();
        }
        ExecutionProgress::StepCompleted {
            step,
            completed_steps,
            measured_total_us,
            elapsed_us,
        } => {
            event.kind = v1::ExecutionProgressKind::StepCompleted as i32;
            event.step = Some(protocol_execution_step(step));
            event.completed_steps = completed_steps;
            event.measured_total_us = measured_total_us;
            event.elapsed_us = elapsed_us;
        }
    }
    event
}

fn generation_certification(
    catalog: &ProfileCatalog,
    profile: &BehaviorProfile,
    local_product_version: &str,
) -> Result<GenerationCertification, ProtocolFailure> {
    if local_product_version.is_empty() {
        return Ok(if profile.is_verified() {
            GenerationCertification::VersionMapped
        } else {
            GenerationCertification::UnverifiedProductVersion
        });
    }
    if local_product_version.len() > 64
        || !local_product_version
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        return Err(malformed("local product version label is invalid"));
    }
    Ok(match catalog.for_product_version(local_product_version) {
        Some(mapped) if mapped.profile_id == profile.profile_id => {
            GenerationCertification::VersionMapped
        }
        _ => GenerationCertification::UnverifiedProductVersion,
    })
}

const MAXIMUM_NAMED_UNCERTIFIED_CONSTRUCTS: usize = 64;

fn certified_construct_tables() -> &'static BTreeMap<String, CertifiedConstructs> {
    static TABLES: OnceLock<BTreeMap<String, CertifiedConstructs>> = OnceLock::new();
    TABLES.get_or_init(|| {
        ProfileCatalog::frozen_current()
            .map(|catalog| {
                catalog
                    .profiles()
                    .filter_map(|profile| {
                        frozen_certified_constructs(&profile.profile_id)
                            .ok()
                            .flatten()
                            .map(|table| (profile.profile_id.clone(), table))
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn construct_verification(
    profile: &BehaviorProfile,
    certification: GenerationCertification,
    local_content: bool,
    local_product_version: &str,
    program: &rms_semantics::SemanticProgram,
) -> Option<v1::ConstructVerification> {
    if local_content || certification != GenerationCertification::VersionMapped {
        return None;
    }
    let product_version = if local_product_version.is_empty() {
        profile.product_versions.first()?.as_str()
    } else {
        local_product_version
    };
    let entry = certified_construct_tables()
        .get(&profile.profile_id)?
        .entry(product_version)?;
    let executed = program.executed_constructs();
    let uncertified = executed
        .iter()
        .filter(|(construct, _)| !entry.contains(&construct.context, &construct.name))
        .collect::<Vec<_>>();
    let status = if uncertified.is_empty() {
        v1::ConstructVerificationStatus::AllCertified
    } else {
        v1::ConstructVerificationStatus::UncertifiedConstructs
    };
    Some(v1::ConstructVerification {
        status: status as i32,
        uncertified: uncertified
            .iter()
            .take(MAXIMUM_NAMED_UNCERTIFIED_CONSTRUCTS)
            .map(|(construct, first)| v1::ConstructReference {
                context: construct.context.clone(),
                name: construct.name.clone(),
                first_operation_index: u32::try_from(**first).unwrap_or(u32::MAX),
            })
            .collect(),
        omitted_uncertified: u32::try_from(
            uncertified
                .len()
                .saturating_sub(MAXIMUM_NAMED_UNCERTIFIED_CONSTRUCTS),
        )
        .unwrap_or(u32::MAX),
        executed_constructs: u32::try_from(executed.len()).unwrap_or(u32::MAX),
        table_id: entry.table_id.clone(),
    })
}

fn protocol_certification(
    certification: GenerationCertification,
) -> Result<v1::GenerationCertification, ProtocolFailure> {
    match certification {
        GenerationCertification::VersionMapped => Ok(v1::GenerationCertification::VersionMapped),
        GenerationCertification::UnverifiedProductVersion => {
            Ok(v1::GenerationCertification::UnverifiedProductVersion)
        }
        GenerationCertification::UncertifiedExplicitSelection => Err(internal_failure(
            "an explicitly selected unverified game version has no generation status to report",
        )),
    }
}

fn protocol_players(
    players: &[v1::PlayerConfiguration],
) -> Result<Vec<PlayerConfiguration>, ProtocolFailure> {
    if players.is_empty() || players.len() > 8 {
        return Err(malformed("generation needs 1 to 8 explicit players"));
    }
    players
        .iter()
        .map(|player| {
            Ok(PlayerConfiguration {
                slot: u8::try_from(player.slot)
                    .map_err(|_| malformed("player slot is out of range"))?,
                team: u8::try_from(player.team)
                    .map_err(|_| malformed("player team is out of range"))?,
                civilization_id: CivilizationId(player.civilization_id),
                color: u8::try_from(player.color)
                    .map_err(|_| malformed("player color is out of range"))?,
            })
        })
        .collect::<Result<Vec<_>, ProtocolFailure>>()
}

fn protocol_setup_context(
    context: Option<&v1::SetupContext>,
) -> Result<SetupContext, ProtocolFailure> {
    let context = context.ok_or_else(|| malformed("typed setup context is required"))?;
    let version = context
        .contract_version
        .as_ref()
        .ok_or_else(|| malformed("typed setup context version is required"))?;
    let game_mode = match v1::GameMode::try_from(context.game_mode) {
        Ok(v1::GameMode::RandomMap) => GameMode::RandomMap,
        Ok(v1::GameMode::Regicide) => GameMode::Regicide,
        Ok(v1::GameMode::DeathMatch) => GameMode::DeathMatch,
        Ok(v1::GameMode::KingOfTheHill) => GameMode::KingOfTheHill,
        Ok(v1::GameMode::WonderRace) => GameMode::WonderRace,
        Ok(v1::GameMode::DefendTheWonder) => GameMode::DefendTheWonder,
        Ok(v1::GameMode::TurboRandomMap) => GameMode::TurboRandomMap,
        Ok(v1::GameMode::CaptureTheRelic) => GameMode::CaptureTheRelic,
        Ok(v1::GameMode::SuddenDeath) => GameMode::SuddenDeath,
        Ok(v1::GameMode::BattleRoyale) => GameMode::BattleRoyale,
        Ok(v1::GameMode::EmpireWars) => GameMode::EmpireWars,
        _ => return Err(malformed("typed game mode must be explicit and supported")),
    };
    let starting_resources = match v1::StartingResourcePolicy::try_from(context.starting_resources)
    {
        Ok(v1::StartingResourcePolicy::Standard) => StartingResourcePolicy::Standard,
        Ok(v1::StartingResourcePolicy::Low) => StartingResourcePolicy::Low,
        Ok(v1::StartingResourcePolicy::Medium) => StartingResourcePolicy::Medium,
        Ok(v1::StartingResourcePolicy::High) => StartingResourcePolicy::High,
        Ok(v1::StartingResourcePolicy::UltraHigh) => StartingResourcePolicy::UltraHigh,
        Ok(v1::StartingResourcePolicy::Infinite) => StartingResourcePolicy::Infinite,
        Ok(v1::StartingResourcePolicy::Random) => StartingResourcePolicy::Random,
        _ => {
            return Err(malformed(
                "typed starting-resource policy must be explicit and supported",
            ));
        }
    };
    let starting_age = match v1::StartingAge::try_from(context.starting_age) {
        Ok(v1::StartingAge::Standard) => StartingAge::Standard,
        Ok(v1::StartingAge::DarkAge) => StartingAge::DarkAge,
        Ok(v1::StartingAge::FeudalAge) => StartingAge::FeudalAge,
        Ok(v1::StartingAge::CastleAge) => StartingAge::CastleAge,
        Ok(v1::StartingAge::ImperialAge) => StartingAge::ImperialAge,
        Ok(v1::StartingAge::PostImperialAge) => StartingAge::PostImperialAge,
        _ => {
            return Err(malformed(
                "typed starting age must be explicit and supported",
            ));
        }
    };
    let position_policy = match v1::PositionPolicy::try_from(context.position_policy) {
        Ok(v1::PositionPolicy::Random) => PositionPolicy::Random,
        Ok(v1::PositionPolicy::Fixed) => PositionPolicy::Fixed,
        Ok(v1::PositionPolicy::TeamTogether) => PositionPolicy::TeamTogether,
        _ => {
            return Err(malformed(
                "typed position policy must be explicit and supported",
            ));
        }
    };
    let computer_player_slots = context
        .computer_player_slots
        .iter()
        .map(|slot| u8::try_from(*slot).map_err(|_| ()))
        .collect::<Result<Vec<_>, ()>>()
        .ok()
        .and_then(|slots| ComputerPlayerSlots::from_slots(&slots).ok())
        .ok_or_else(|| malformed("computer player slots must be unique ascending slots 1 to 8"))?;
    let game_mode_modifiers = context
        .game_mode_modifiers
        .iter()
        .map(|modifier| match v1::GameModeModifier::try_from(*modifier) {
            Ok(v1::GameModeModifier::EmpireWars) => Ok(GameModeModifier::EmpireWars),
            Ok(v1::GameModeModifier::SuddenDeath) => Ok(GameModeModifier::SuddenDeath),
            Ok(v1::GameModeModifier::Regicide) => Ok(GameModeModifier::Regicide),
            Ok(v1::GameModeModifier::KingOfTheHill) => Ok(GameModeModifier::KingOfTheHill),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, ()>>()
        .ok()
        .and_then(|modifiers| GameModeModifiers::from_modifiers(&modifiers).ok())
        .ok_or_else(|| {
            malformed("game mode modifiers must be explicit, unique, and in canonical order")
        })?;
    Ok(SetupContext {
        contract_version: SetupContextVersion {
            major: version.major,
            minor: version.minor,
            patch: version.patch,
        },
        game_mode,
        starting_resources,
        starting_age,
        position_policy,
        computer_player_slots,
        lobby_options: LobbyOptions {
            game_mode_modifiers,
            turbo_mode: context.turbo_mode,
            full_tech_tree: context.full_tech_tree,
            antiquity_mode: context.antiquity_mode,
            solid_farms: context.solid_farms,
        },
    })
}

fn protocol_progress(
    event: &GenerationEvent,
    identity: Option<v1::RequestIdentity>,
) -> v1::ProgressEvent {
    v1::ProgressEvent {
        identity,
        completed: event.completed.min(u64::from(u32::MAX)) as u32,
        total: event.total.min(u64::from(u32::MAX)) as u32,
        stage: event.stage.as_str().to_owned(),
    }
}

fn protocol_generation_response(
    request: v1::GenerationRequest,
    program: &rms_semantics::SemanticProgram,
    internal_request: &GenerationRequest,
    _content: &rms_content::NeutralContentPack,
    map: GeneratedMap,
    trace_truncated: bool,
    identity_request_id: &str,
) -> Result<v1::GenerationResponse, ProtocolFailure> {
    let provenance_operations = protocol_provenance_operations(program);
    let mut source_ids = Vec::new();
    for operation in &provenance_operations {
        if !source_ids.iter().any(|value| value == &operation.source_id) {
            source_ids.push(operation.source_id.clone());
        }
    }
    if source_ids.is_empty() {
        source_ids.push(internal_request.document_uri.clone());
    }
    if source_ids.len() > usize::from(u16::MAX) {
        return Err(malformed(
            "generation provenance has too many distinct sources",
        ));
    }
    let tile_sources = map
        .tile_operation_indices
        .iter()
        .map(|index| {
            provenance_operations
                .get(*index as usize)
                .and_then(|operation| {
                    source_ids
                        .iter()
                        .position(|source| source == &operation.source_id)
                })
                .and_then(|index| u16::try_from(index).ok())
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    let tile_byte_starts = map
        .tile_operation_indices
        .iter()
        .map(|index| {
            provenance_operations
                .get(*index as usize)
                .map_or(0, |operation| operation.byte_start)
        })
        .collect::<Vec<_>>();
    let tile_byte_ends = map
        .tile_operation_indices
        .iter()
        .map(|index| {
            provenance_operations
                .get(*index as usize)
                .map_or(0, |operation| operation.byte_end)
        })
        .collect::<Vec<_>>();
    let mut metrics = BTreeMap::from([
        ("allocatedBytes".to_owned(), map.metrics.allocated_bytes),
        ("emittedEvents".to_owned(), map.metrics.emitted_events),
        ("objectCount".to_owned(), map.metrics.object_count),
        ("tileCount".to_owned(), map.metrics.tile_count),
        ("traceTruncated".to_owned(), u64::from(trace_truncated)),
    ]);
    metrics.extend(map.metrics.counters.clone());
    let request_hash = internal_request
        .deterministic_hash()
        .map_err(map_generation_failure)?;
    let document = Some(v1::DocumentIdentity {
        uri: internal_request.document_uri.clone(),
        revision: internal_request.document_revision,
        semantic_hash: program.identity.semantic_hash.to_vec(),
        source_graph_hash: internal_request.source_graph_hash.to_vec(),
        source_catalog_hash: request
            .source_catalog
            .as_ref()
            .map_or_else(Vec::new, |catalog| catalog.catalog_hash.clone()),
    });
    let mut warnings = map
        .warnings
        .iter()
        .map(|warning| v1::GenerationWarning {
            code: warning.code.clone(),
            message: warning.message.clone(),
        })
        .collect::<Vec<_>>();
    if !program.external_dependencies.is_empty() {
        warnings.push(v1::GenerationWarning {
            code: "RMSXS0001".to_owned(),
            message: format!(
                "{} external XS dependency was validated but standalone preview does not execute post-load XS effects",
                program.external_dependencies.len()
            ),
        });
    }
    let connection_routes = if request.connection_routes {
        map.connection_routes
            .as_ref()
            .map(protocol_connection_routes)
    } else {
        None
    };
    let response = v1::GenerationResponse {
        identity: request.identity,
        document,
        map_state: Some(v1::ColumnarMapState {
            width: u32::from(map.dimensions.width),
            height: u32::from(map.dimensions.height),
            terrain_ids_le: encode_u32(map.terrain.iter().map(|value| value.0)),
            pre_connection_terrain_ids_le: encode_u32(
                map.pre_connection_terrain.iter().map(|value| value.0),
            ),
            elevations: encode_i16(map.elevation.iter().copied()),
            zones_le: encode_u32(map.terrain_zone.iter().copied()),
            land_ids_le: encode_u32(map.land_zone.iter().copied()),
            cliff_edges: encode_cliffs(&map.cliffs),
            cliff_pieces_le: encode_cliff_pieces(&map.cliff_pieces),
            appearance_objects_le: encode_appearance_objects(&map.appearance_objects),
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
            connection_routes,
        }),
        provenance: Some(v1::ProvenanceColumns {
            source_ids,
            tile_source_indices_le: encode_u16(tile_sources),
            tile_byte_starts_le: encode_u32(tile_byte_starts),
            tile_byte_ends_le: encode_u32(tile_byte_ends),
            include_chain: std::iter::once(program.identity.entry_source.as_str().to_owned())
                .chain(
                    program
                        .resolved_includes
                        .iter()
                        .map(|source| source.as_str().to_owned()),
                )
                .collect(),
            operations: provenance_operations,
            tile_operation_indices_le: encode_u32(map.tile_operation_indices.iter().copied()),
            object_operation_indices_le: encode_u32(map.object_operation_indices.iter().copied()),
            cliff_operation_indices_le: encode_u32(map.cliff_operation_indices.iter().copied()),
            connection_operation_indices_le: encode_u32(
                map.connection_operation_indices.iter().copied(),
            ),
        }),
        semantic_hash: map.final_semantic_hash.to_vec(),
        committed: true,
        request_hash: request_hash.to_vec(),
        stage_hashes: map
            .stage_hashes
            .iter()
            .map(|(stage, hash)| v1::StageHash {
                stage: stage.as_str().to_owned(),
                hash: hash.to_vec(),
            })
            .collect(),
        warnings,
        metrics,
        source_catalog_revision: request
            .source_catalog
            .as_ref()
            .map_or(0, |catalog| catalog.revision),
        source_catalog_hash: request
            .source_catalog
            .as_ref()
            .map_or_else(Vec::new, |catalog| catalog.catalog_hash.clone()),
        source_graph_hash: internal_request.source_graph_hash.to_vec(),
        external_asset_hash: request
            .source_catalog
            .as_ref()
            .map_or_else(Vec::new, |catalog| catalog.external_asset_hash.clone()),
        resolved_rms_source_ids: std::iter::once(program.identity.entry_source.as_str().to_owned())
            .chain(
                program
                    .resolved_includes
                    .iter()
                    .map(|source| source.as_str().to_owned()),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        external_asset_source_ids: program
            .external_dependencies
            .iter()
            .map(|source| source.as_str().to_owned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        certification: v1::GenerationCertification::Unspecified as i32,
        execution_cost: None,
        construct_verification: None,
    };
    if identity_request_id.is_empty() {
        return Err(malformed("generation request identity is invalid"));
    }
    Ok(response)
}

fn protocol_generation_event(
    event: &GenerationEvent,
    identity: Option<v1::RequestIdentity>,
) -> Option<v1::GenerationEvent> {
    let kind = match event.kind {
        rms_trace::GenerationEventKind::StageStarted => v1::GenerationEventKind::StageStarted,
        rms_trace::GenerationEventKind::StageCompleted => v1::GenerationEventKind::StageCompleted,
        rms_trace::GenerationEventKind::MutationBatch => v1::GenerationEventKind::DeltaBatch,
        rms_trace::GenerationEventKind::Progress
        | rms_trace::GenerationEventKind::RngCheckpoint
        | rms_trace::GenerationEventKind::Warning => v1::GenerationEventKind::Diagnostic,
    };
    Some(v1::GenerationEvent {
        identity,
        sequence: event.sequence,
        kind: kind as i32,
        stage: event.stage.as_str().to_owned(),
        completed: event.completed.min(u64::from(u32::MAX)) as u32,
        total: event.total.min(u64::from(u32::MAX)) as u32,
        state_hash: event.state_hash.map_or_else(Vec::new, |hash| hash.to_vec()),
        delta: event.mutations.as_ref().map(protocol_delta_batch),
        detail: event.detail.clone().unwrap_or_default(),
        initialization: None,
    })
}

fn terminal_generation_event(
    identity: Option<v1::RequestIdentity>,
    sequence: u64,
    kind: v1::GenerationEventKind,
    detail: &str,
) -> v1::GenerationEvent {
    v1::GenerationEvent {
        identity,
        sequence,
        kind: kind as i32,
        stage: String::new(),
        completed: 0,
        total: 0,
        state_hash: Vec::new(),
        delta: None,
        detail: detail.chars().take(1024).collect(),
        initialization: None,
    }
}

fn protocol_delta_batch(batch: &rms_trace::MutationBatch) -> v1::DeltaBatch {
    let operation = |value: rms_trace::MutationOperation| match value {
        rms_trace::MutationOperation::Replace => v1::MutationOperation::Replace as i32,
        rms_trace::MutationOperation::Remove => v1::MutationOperation::Remove as i32,
    };
    v1::DeltaBatch {
        tiles: batch
            .tiles
            .iter()
            .map(|value| v1::TileMutation {
                tile_index: value.tile_index,
                terrain_id: value.terrain_id,
                elevation: i32::from(value.elevation),
                terrain_zone: value.terrain_zone,
                land_id: value.land_id,
                layer_id: u32::from(value.layer_id),
                flags: value.flags,
                operation: operation(value.operation),
                provenance_operation_index: value.provenance_operation_index,
            })
            .collect(),
        objects: batch
            .objects
            .iter()
            .map(|value| v1::ObjectMutation {
                object_index: value.object_index,
                object_id: value.object_id,
                x_256: value.x_256,
                y_256: value.y_256,
                owner: u32::from(value.owner),
                facet: u32::from(value.facet),
                footprint_width_256: u32::from(value.footprint_width_256),
                footprint_height_256: u32::from(value.footprint_height_256),
                presentation_kind: u32::from(value.presentation_kind),
                operation: operation(value.operation),
                provenance_operation_index: value.provenance_operation_index,
                resource_type: i32::from(value.resource_type),
                resource_quantity_f32_bits: value.resource_quantity_f32_bits,
                resource_delta: value.resource_delta,
                status: value.status,
                death_state: value.death_state,
                data_status: value.data_status,
                selection_flags: value.selection_flags,
                behavior_flags: value.behavior_flags,
            })
            .collect(),
        cliffs: batch
            .cliffs
            .iter()
            .map(|value| v1::CliffMutation {
                cliff_index: value.cliff_index,
                from_x: u32::from(value.from_x),
                from_y: u32::from(value.from_y),
                to_x: u32::from(value.to_x),
                to_y: u32::from(value.to_y),
                cliff_type: value.cliff_type,
                operation: operation(value.operation),
                provenance_operation_index: value.provenance_operation_index,
            })
            .collect(),
        connections: batch
            .connections
            .iter()
            .map(|value| v1::ConnectionMutation {
                connection_index: value.connection_index,
                start_x: u32::from(value.start_x),
                start_y: u32::from(value.start_y),
                end_x: u32::from(value.end_x),
                end_y: u32::from(value.end_y),
                kind: u32::from(value.kind),
                operation: operation(value.operation),
                provenance_operation_index: value.provenance_operation_index,
            })
            .collect(),
    }
}

fn protocol_provenance_operations(
    program: &rms_semantics::SemanticProgram,
) -> Vec<v1::ProvenanceOperation> {
    program
        .operations
        .iter()
        .map(|operation| {
            let include_chain = operation
                .presentation_include_chain(&program.identity.entry_source)
                .into_iter()
                .map(|source| source.as_str().to_owned())
                .collect();
            v1::ProvenanceOperation {
                source_id: operation.source_id.as_str().to_owned(),
                byte_start: operation.source_range.start.0,
                byte_end: operation.source_range.end.0,
                operation_identity: operation.identity.to_vec(),
                include_chain,
                display_name: operation.name.replace('_', " "),
            }
        })
        .collect()
}

#[cfg(feature = "internal-fixtures")]
fn synthetic_options(value: i32) -> Result<SyntheticGenerationOptions, ProtocolFailure> {
    let scenario = v1::InternalFixtureScenario::try_from(value)
        .map_err(|_| malformed("internal fixture scenario is unsupported"))?;
    let (fixture, delay_per_stage, deliberate_failure) = match scenario {
        v1::InternalFixtureScenario::Unspecified | v1::InternalFixtureScenario::Representative => (
            SyntheticFixtureScenario::Representative,
            Duration::ZERO,
            None,
        ),
        v1::InternalFixtureScenario::Colocated => {
            (SyntheticFixtureScenario::Colocated, Duration::ZERO, None)
        }
        v1::InternalFixtureScenario::Legend => {
            (SyntheticFixtureScenario::Legend, Duration::ZERO, None)
        }
        v1::InternalFixtureScenario::Large => {
            (SyntheticFixtureScenario::Large, Duration::ZERO, None)
        }
        v1::InternalFixtureScenario::Delayed => (
            SyntheticFixtureScenario::Delayed,
            Duration::from_millis(80),
            None,
        ),
        v1::InternalFixtureScenario::Failure => (
            SyntheticFixtureScenario::Failure,
            Duration::from_millis(80),
            Some(rms_trace::GenerationStage::Setup),
        ),
        v1::InternalFixtureScenario::Cancellable => (
            SyntheticFixtureScenario::Cancellable,
            Duration::from_millis(500),
            None,
        ),
    };
    Ok(SyntheticGenerationOptions {
        delay_per_stage,
        deliberate_failure,
        fixture,
    })
}

const MAXIMUM_PRESENTATION_DAT_BYTES: u64 = 256 * 1024 * 1024;

fn presentation_string_ids(
    request: &v1::PresentationStringIdsRequest,
) -> v1::PresentationStringIdsResponse {
    use v1::PresentationStringIdsStatus as Status;
    let unavailable = |status: Status| v1::PresentationStringIdsResponse {
        status: status as i32,
        objects: Vec::new(),
        terrains: Vec::new(),
        object_slots: Vec::new(),
        terrain_slot_count: 0,
        terrain_minimap_indices: Vec::new(),
    };
    let path = std::path::Path::new(&request.dat_path);
    use rms_engine::local_content::{LOCAL_DAT_RELATIVE_PATH, installation_root};
    let acceptable_path = !request.dat_path.is_empty()
        && request.dat_path.len() <= 4096
        && installation_root(path, &LOCAL_DAT_RELATIVE_PATH).is_some();
    if !acceptable_path {
        return unavailable(Status::Unreadable);
    }
    let Ok(path) = rms_engine::local_content::resolve_local_file(path, "game data file") else {
        return unavailable(Status::Unreadable);
    };
    let compressed = match read_bounded_file(&path, MAXIMUM_PRESENTATION_DAT_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => return unavailable(Status::Unreadable),
    };
    match rms_content::read_aoe2de_dat_presentation_string_ids(
        &compressed,
        rms_content::DatImportLimits::default(),
    ) {
        Ok(ids) => {
            let entries = |entries: Vec<rms_content::PresentationStringId>| {
                entries
                    .into_iter()
                    .map(|entry| v1::PresentationStringId {
                        id: entry.id,
                        string_id: entry.string_id,
                    })
                    .collect()
            };
            v1::PresentationStringIdsResponse {
                status: Status::Available as i32,
                objects: entries(ids.objects),
                terrains: entries(ids.terrains),
                object_slots: ids
                    .object_slots
                    .into_iter()
                    .map(|slot| v1::PresentationObjectSlot {
                        id: slot.id,
                        standing_graphic: slot.standing_graphic,
                    })
                    .collect(),
                terrain_slot_count: ids.terrain_slot_count,
                terrain_minimap_indices: ids
                    .terrain_minimap_indices
                    .into_iter()
                    .map(|terrain| v1::PresentationTerrainMinimapIndices {
                        id: terrain.id,
                        high_index: u32::from(terrain.high_index),
                        medium_index: u32::from(terrain.medium_index),
                        low_index: u32::from(terrain.low_index),
                    })
                    .collect(),
            }
        }
        Err(rms_content::ContentError::ResourceLimit(_)) => unavailable(Status::Unreadable),
        Err(_) => unavailable(Status::UnsupportedLayout),
    }
}

fn read_bounded_file(path: &std::path::Path, maximum_bytes: u64) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum_bytes {
        return Err(std::io::Error::other("file is not a bounded regular file"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(std::io::Error::other(
            "file grew past its bound while being read",
        ));
    }
    Ok(bytes)
}

fn configuration_catalog() -> Result<v1::ConfigurationCatalogResponse> {
    let catalog = ProfileCatalog::frozen_current().context("loading the built-in game versions")?;
    let listed = catalog
        .profiles()
        .filter(|profile| profile.is_verified())
        .collect::<Vec<_>>();
    let default_profile = listed
        .first()
        .context("the built-in catalog has no verified game version")?;
    let contents = product_content_packs(&default_profile.profile_id)
        .map_err(|failure| anyhow::anyhow!(failure.message))?
        .into_iter()
        .filter(|content| {
            listed.iter().any(|profile| {
                content
                    .compatible_behavior_profiles
                    .contains(&profile.profile_id)
            })
        })
        .collect::<Vec<_>>();
    let bundles = packaged_support_bundles().context("loading packaged support bundles")?;
    Ok(v1::ConfigurationCatalogResponse {
        behavior_profiles: listed
            .into_iter()
            .map(profile_descriptor)
            .collect::<Result<Vec<_>>>()?,
        content_packs: contents
            .into_iter()
            .map(|content| content_pack_descriptor(&content, bundles))
            .collect::<Result<Vec<_>>>()?,
    })
}

fn profile_descriptor(profile: &BehaviorProfile) -> Result<v1::BehaviorProfileDescriptor> {
    let profile_hash = profile
        .deterministic_hash()
        .context("hashing a built-in game version")?;
    Ok(v1::BehaviorProfileDescriptor {
        profile_id: profile.profile_id.clone(),
        behavior_version: profile.behavior_version.clone(),
        profile_hash: profile_hash.to_vec(),
        product_versions: profile.product_versions.clone(),
        capabilities: profile
            .capabilities
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    match value {
                        CapabilityStatus::Unsupported => "unsupported",
                        CapabilityStatus::Partial => "partial",
                        CapabilityStatus::Complete => "complete",
                    }
                    .to_owned(),
                )
            })
            .collect(),
        minimap_palettes: profile
            .minimap_palettes
            .as_ref()
            .map(|palettes| {
                palettes
                    .entries
                    .iter()
                    .map(|entry| {
                        Ok(v1::MinimapPaletteDescriptor {
                            palette_id: entry.palette_id.clone(),
                            product_version: entry.product_version.clone(),
                            palette_hash: entry
                                .deterministic_hash()
                                .context("hashing minimap palette")?
                                .to_vec(),
                            terrain_colors: entry
                                .terrain_colors
                                .iter()
                                .map(|color| v1::TerrainMinimapColor {
                                    terrain_id: color.terrain_id,
                                    high_color: color.high_color,
                                    medium_color: color.medium_color,
                                    low_color: color.low_color,
                                })
                                .collect(),
                            neutral_object_colors: entry
                                .neutral_object_colors
                                .iter()
                                .map(|color| v1::NeutralObjectMinimapColor {
                                    object_id: color.object_id,
                                    color: color.color,
                                })
                                .collect(),
                            cliff_colors: entry
                                .cliff_colors
                                .iter()
                                .map(|color| v1::CliffMinimapColor {
                                    cliff_type: color.cliff_type,
                                    left_color: color.left_color,
                                    right_color: color.right_color,
                                })
                                .collect(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default(),
        texture_palettes: texture_palette_descriptors(profile)?,
    })
}

fn texture_palette_descriptors(
    profile: &BehaviorProfile,
) -> Result<Vec<v1::TexturePaletteDescriptor>> {
    let Some(palettes) = rms_profile::frozen_texture_palettes(&profile.profile_id)
        .context("loading the shipped texture palettes")?
    else {
        return Ok(Vec::new());
    };
    palettes
        .entries
        .iter()
        .map(|entry| {
            Ok(v1::TexturePaletteDescriptor {
                palette_id: entry.palette_id.clone(),
                product_version: entry.product_version.clone(),
                palette_hash: entry
                    .deterministic_hash()
                    .context("hashing texture palette")?
                    .to_vec(),
                terrain_colors: entry
                    .terrain_colors
                    .iter()
                    .map(|color| v1::TerrainTextureColor {
                        terrain_id: color.terrain_id,
                        color: color.color,
                    })
                    .collect(),
                object_colors: entry
                    .object_colors
                    .iter()
                    .map(|color| v1::ObjectTextureColor {
                        object_id: color.object_id,
                        color: color.color,
                    })
                    .collect(),
                derivation_tool: entry.provenance.tool.clone(),
                installation_build: entry.provenance.installation_build.clone(),
                derived_on: entry.provenance.derived_on.clone(),
                cliff_colors: entry
                    .cliff_colors
                    .iter()
                    .map(|color| v1::CliffTextureColor {
                        cliff_type: color.cliff_type,
                        color: color.color,
                    })
                    .collect(),
            })
        })
        .collect()
}

pub(crate) fn content_pack_descriptor(
    content: &NeutralContentPack,
    bundles: &[rms_content::SupportBundle],
) -> Result<v1::ContentPackDescriptor> {
    let identity = content.identity().context("hashing content pack")?;
    let object_names = content
        .objects
        .iter()
        .map(|object| v1::ObjectNameDescriptor {
            object_id: object.id.0,
            name: object.name.clone(),
        })
        .collect();
    let bundle = bundles
        .iter()
        .find(|bundle| bundle.content.pack_id == identity.pack_id);
    let local = content.source.kind == ContentSourceKind::Aoe2deDat;
    let profile_bundle = bundle.or_else(|| {
        local
            .then(|| {
                bundles.iter().find(|bundle| {
                    content
                        .compatible_behavior_profiles
                        .contains(&bundle.manifest.behavior_profile_id)
                })
            })
            .flatten()
    });
    let vocabulary = content
        .rms_implicit_definitions()
        .context("building content vocabulary")?;
    let art = map_icon_art_classes(content, &vocabulary);
    let implicit_definitions = vocabulary
        .into_iter()
        .map(|(name, value)| v1::ImplicitDefinition { name, value })
        .collect();
    let standard_includes = profile_bundle
        .map(|bundle| bundle.standard_includes.standard_includes.clone())
        .unwrap_or_default();
    let graphicless_object_ids =
        if content.source.kind == ContentSourceKind::ReviewedBundle || local {
            content
                .objects
                .iter()
                .filter(|object| object.standing_graphic_id.is_none())
                .map(|object| object.id.0)
                .collect()
        } else {
            Vec::new()
        };
    Ok(v1::ContentPackDescriptor {
        pack_id: identity.pack_id,
        pack_version: identity.pack_version,
        content_hash: identity.content_hash.to_vec(),
        source_fingerprint: identity.source_fingerprint,
        compatible_profile_ids: content.compatible_behavior_profiles.clone(),
        synthetic: content.source.kind == ContentSourceKind::Synthetic,
        object_names,
        implicit_definitions,
        standard_includes,
        product_version: bundle
            .map(|bundle| bundle.manifest.product_version.clone())
            .unwrap_or_default(),
        packaged_bundle: bundle.is_some(),
        graphicless_object_ids,
        tree_object_ids: art.trees,
        gold_object_ids: art.gold,
        stone_object_ids: art.stone,
    })
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct MapIconArtClasses {
    pub trees: Vec<u32>,
    pub gold: Vec<u32>,
    pub stone: Vec<u32>,
}

pub(crate) fn map_icon_art_classes(
    content: &NeutralContentPack,
    definitions: &BTreeMap<String, String>,
) -> MapIconArtClasses {
    let tree_class = content
        .native_generation_bindings
        .as_ref()
        .map(|bindings| bindings.classes.tree)
        .or(content.object_placement_classes.forest_zone_class_id);
    let primary_resource = |object: &rms_content::ObjectDefinition| {
        object.resource_slots.as_ref().and_then(|slots| {
            slots
                .iter()
                .find(|slot| slot.resource_type >= 0)
                .map(|slot| slot.resource_type)
        })
    };
    let mine_ids = |names: [&str; 2]| -> Vec<u32> {
        let anchor = names.iter().find_map(|name| {
            let id = definitions.get(*name)?.parse::<u32>().ok()?;
            content.objects.iter().find(|object| object.id.0 == id)
        });
        let Some(anchor) = anchor else {
            return Vec::new();
        };
        let Some(resource) = primary_resource(anchor) else {
            return Vec::new();
        };
        content
            .objects
            .iter()
            .filter(|object| {
                object.class_id == anchor.class_id && primary_resource(object) == Some(resource)
            })
            .map(|object| object.id.0)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    MapIconArtClasses {
        trees: tree_class
            .map(|class| {
                content
                    .objects
                    .iter()
                    .filter(|object| object.class_id == class)
                    .map(|object| object.id.0)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default(),
        gold: mine_ids(["GOLD", "GOLD_MINE"]),
        stone: mine_ids(["STONE", "STONE_MINE"]),
    }
}

fn fixed_hash(bytes: &[u8], label: &str) -> Result<[u8; 32], ProtocolFailure> {
    bytes
        .try_into()
        .map_err(|_| malformed(format!("{label} hash must contain exactly 32 bytes")))
}

fn protocol_source_catalog(value: &v1::SourceCatalog) -> Result<SourceCatalog, ProtocolFailure> {
    let version = value
        .contract_version
        .as_ref()
        .ok_or_else(|| malformed("source catalog version is required"))?;
    let roots = value
        .roots
        .as_ref()
        .ok_or_else(|| malformed("source catalog roots are required"))?;
    let mut definitions = BTreeMap::new();
    for definition in &value.implicit_definitions {
        if definitions
            .insert(definition.name.clone(), definition.value.clone())
            .is_some()
        {
            return Err(malformed(
                "source catalog contains duplicate implicit definitions",
            ));
        }
    }
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
                _ => return Err(malformed("source catalog origin must be explicit")),
            };
            let role = match v1::SourceCatalogRole::try_from(source.role) {
                Ok(v1::SourceCatalogRole::RmsEntry) => SourceCatalogRole::RmsEntry,
                Ok(v1::SourceCatalogRole::RmsDependency) => SourceCatalogRole::RmsDependency,
                Ok(v1::SourceCatalogRole::ExternalXs) => SourceCatalogRole::ExternalXs,
                _ => return Err(malformed("source catalog role must be explicit")),
            };
            Ok(CatalogSource {
                path: source.normalized_path.clone(),
                source_id: SourceId::new(source.source_id.clone()).map_err(|error| {
                    malformed(format!("source catalog identity is invalid: {error}"))
                })?,
                raw_hash: fixed_hash(&source.raw_hash, "catalog source")?,
                bytes: source.source.clone().into(),
                origin,
                role,
                buffer_revision: source.buffer_revision,
            })
        })
        .collect::<Result<Vec<_>, ProtocolFailure>>()?;
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
            opened_or_configured: roots.opened_or_configured.clone(),
            deployed_map_context: optional_root(&roots.deployed_map_context),
            game_gamedata_x2: optional_root(&roots.game_gamedata_x2),
            implicit_environment: optional_root(&roots.implicit_environment),
            game_xs: optional_root(&roots.game_xs),
            standard_includes: StandardIncludeAccess {
                identifiers: roots.standard_includes.clone(),
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
        rms_graph_hash: fixed_hash(&value.rms_graph_hash, "RMS source graph")?,
        asset_graph_hash: fixed_hash(&value.external_asset_hash, "external asset graph")?,
    })
    .map_err(source_catalog_failure)
}

fn optional_root(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn protocol_content_identity(identity: &rms_content::ContentPackIdentity) -> String {
    format!(
        "{}@{}#{}",
        identity.pack_id, identity.pack_version, identity.source_fingerprint
    )
}

fn source_mentions_dependency(bytes: &[u8]) -> bool {
    [b"#include".as_slice(), b"#include_drs", b"#includeXS"]
        .iter()
        .any(|needle| bytes.windows(needle.len()).any(|window| window == *needle))
}

fn source_catalog_failure(error: SourceCatalogError) -> ProtocolFailure {
    match error {
        SourceCatalogError::UnsupportedVersion => unsupported(error.to_string()),
        SourceCatalogError::StaleHash
        | SourceCatalogError::StaleImplicitEnvironment
        | SourceCatalogError::StaleCatalogHash => stale(error.to_string()),
        _ => malformed(error.to_string()),
    }
}

fn encode_u16(values: impl IntoIterator<Item = u16>) -> Vec<u8> {
    values.into_iter().flat_map(u16::to_le_bytes).collect()
}

fn encode_i16(values: impl IntoIterator<Item = i16>) -> Vec<u8> {
    values.into_iter().flat_map(i16::to_le_bytes).collect()
}

fn encode_i32(values: impl IntoIterator<Item = i32>) -> Vec<u8> {
    values
        .into_iter()
        .flat_map(i32::to_le_bytes)
        .collect::<Vec<_>>()
}

fn encode_u32(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
    values.into_iter().flat_map(u32::to_le_bytes).collect()
}

fn encode_cliff_pieces(pieces: &[rms_engine::CliffPiece]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pieces.len() * 20);
    for piece in pieces {
        bytes.extend_from_slice(&piece.object_id.0.to_le_bytes());
        bytes.extend_from_slice(&piece.x_256.to_le_bytes());
        bytes.extend_from_slice(&piece.y_256.to_le_bytes());
        bytes.extend_from_slice(&piece.facet.to_le_bytes());
        bytes.extend(piece.edges.map(|edge| edge.to_le_bytes()[0]));
        bytes.extend_from_slice(&[0, 0]);
    }
    bytes
}

fn encode_appearance_objects(objects: &[rms_engine::TerrainAppearanceObject]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(objects.len() * 16);
    for object in objects {
        bytes.extend_from_slice(&object.object_id.0.to_le_bytes());
        bytes.extend_from_slice(&object.x_256.to_le_bytes());
        bytes.extend_from_slice(&object.y_256.to_le_bytes());
        bytes.extend_from_slice(&object.footprint_256.to_le_bytes());
        bytes.extend_from_slice(&[u8::from(!object.tree), 0]);
    }
    bytes
}

fn encode_cliffs(cliffs: &[rms_engine::CliffEdge]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(cliffs.len() * 12);
    for edge in cliffs {
        bytes.extend_from_slice(&edge.from.x.to_le_bytes());
        bytes.extend_from_slice(&edge.from.y.to_le_bytes());
        bytes.extend_from_slice(&edge.to.x.to_le_bytes());
        bytes.extend_from_slice(&edge.to.y.to_le_bytes());
        bytes.extend_from_slice(&edge.cliff_type.to_le_bytes());
    }
    bytes
}

fn malformed(message: impl Into<String>) -> ProtocolFailure {
    ProtocolFailure {
        code: ErrorCode::MalformedRequest,
        message: message.into(),
        retryable: false,
        terminal_sequence: 0,
        details: Default::default(),
    }
}

fn stale(message: impl Into<String>) -> ProtocolFailure {
    ProtocolFailure {
        code: ErrorCode::StaleDocument,
        message: message.into(),
        retryable: true,
        terminal_sequence: 0,
        details: Default::default(),
    }
}

fn unsupported(message: impl Into<String>) -> ProtocolFailure {
    ProtocolFailure {
        code: ErrorCode::UnsupportedCapability,
        message: message.into(),
        retryable: false,
        terminal_sequence: 0,
        details: Default::default(),
    }
}

fn internal_failure(message: impl Into<String>) -> ProtocolFailure {
    ProtocolFailure {
        code: ErrorCode::Internal,
        message: message.into(),
        retryable: false,
        terminal_sequence: 0,
        details: Default::default(),
    }
}

fn map_generation_failure(error: GenerationError) -> ProtocolFailure {
    match error {
        GenerationError::UnsupportedCapability { .. } => unsupported(error.to_string()),
        GenerationError::Cancelled(_) => ProtocolFailure {
            code: ErrorCode::Cancelled,
            message: error.to_string(),
            retryable: true,
            terminal_sequence: 0,
            details: Default::default(),
        },
        GenerationError::StaleSemanticProgram => stale(error.to_string()),
        GenerationError::BackendFailure { .. } | GenerationError::EventSink(_) => {
            internal_failure(error.to_string())
        }
        _ => malformed(error.to_string()),
    }
}

fn missing_content_failure(
    kind: ContentDefinitionKind,
    id: u32,
    pack_id: &str,
    seed: u64,
    certification: GenerationCertification,
    local_product_version: &str,
) -> ProtocolFailure {
    let linked = if certification == GenerationCertification::UnverifiedProductVersion {
        format!(" (the linked game {local_product_version} is not a verified version)")
    } else {
        String::new()
    };
    malformed(format!(
        "{kind} {id} is not in the game data of the selected game version ({pack_id}), but \
         the script uses it with seed {seed}{linked}. It probably comes from a newer game version; seeds that do not \
         use it can still generate."
    ))
}

fn frame_too_large_failure(
    description: &str,
    encoded_bytes: usize,
    terminal_sequence: u64,
) -> ProtocolFailure {
    match frame_too_large_error("", description, encoded_bytes).payload {
        Some(Payload::Error(error)) => ProtocolFailure {
            code: ErrorCode::Internal,
            message: error.message,
            retryable: false,
            terminal_sequence,
            details: error.details,
        },
        _ => with_terminal_sequence(
            internal_failure(format!("{description} exceeds the protocol frame bound")),
            terminal_sequence,
        ),
    }
}

fn with_terminal_sequence(mut failure: ProtocolFailure, sequence: u64) -> ProtocolFailure {
    failure.terminal_sequence = sequence;
    failure
}

fn cancelled_failure(sequence: u64, message: impl Into<String>) -> ProtocolFailure {
    ProtocolFailure {
        code: ErrorCode::Cancelled,
        message: message.into(),
        retryable: true,
        terminal_sequence: sequence,
        details: Default::default(),
    }
}

pub fn require_protocol_major(value: u32) -> Result<()> {
    if value != PROTOCOL_MAJOR {
        bail!("unsupported protocol major {value}");
    }
    Ok(())
}
