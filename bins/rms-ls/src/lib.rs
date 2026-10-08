mod analysis;
mod editor_inventory;
mod facts;
mod formatter;
mod generation_diagnostics;
mod latency;
mod rms_completion;
mod rms_docs;
mod rms_lint;
mod rms_navigation;
mod source_discovery;
mod xs;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};

use anyhow::{Context, Result, bail};
use rms_analysis::{
    DiagnosticSeverity, DocumentAnalysis, OutlineKind, SemanticTokenKind, analyze_document,
    analyze_semantics_catalog, product_strict_options_for_profile,
};
use rms_content::{CivilizationId, packaged_support_bundles};
use rms_engine::{
    ComputerPlayerSlots, GameMode, LobbyOptions, MapDimensions, PlayerConfiguration,
    PositionPolicy, SetupContext, SetupContextVersion, StartingAge, StartingResourcePolicy,
    validate_exact_semantic_scope,
};
use rms_semantics::{
    ParsedDecision, ParsedDecisionKind, SemanticEquivalence, SemanticProgram, StrictParseError,
    StrictParseOptions, command_metadata, compare_semantics, parse_strict,
};
use rms_source::{
    ByteOffset, ByteRange, CatalogSource, DependencyGraph, IncludePath, ResolutionDiagnosticKind,
    ResolverRoots, SourceCatalog, SourceCatalogError, SourceCatalogOrigin, SourceCatalogParts,
    SourceCatalogRole, SourceCatalogVersion, SourceId, SourceText, StandardIncludeAccess,
    Utf16Position, Utf16Range, VirtualSource, VirtualSourceResolver,
};
use rms_syntax::{CstKind, Token};
use serde_json::{Map, Value, json};

use crate::facts::Closed;
use crate::formatter::{
    CONVENTION_VERSION, FormatOptions, apply_edits, format_document,
    formatting_structure_is_equivalent,
};

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_MESSAGE_BYTES: usize = 28 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 1024;
const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_WORKSPACE_SYMBOLS: usize = 20_000;
const MAX_SEMANTIC_CACHE_ENTRIES: usize = 4;
const MAX_PUBLISHED_CODE_ACTION_RANGES: usize = 512;
const PUBLISHED_CODE_ACTIONS_CONTRACT: u64 = 1;
const MAX_CANCELLED_REQUESTS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitReason {
    Orderly,
    ParentClosed,
    ExitWithoutShutdown,
}

const MAX_PARKED_REQUESTS: usize = 64;

const STRICT_REQUESTS: [&str; 2] = ["textDocument/codeAction", "textDocument/inlayHint"];

enum Event {
    Message(Result<Option<Vec<u8>>>),
    Analyzed(analysis::Analyzed),
    WorkerFailed,
}

pub fn run_server(
    input: impl Read + Send,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<ExitReason> {
    std::thread::scope(|scope| {
        run_threads(
            |events, asked| {
                scope.spawn(move || read_messages(input, &events, &asked));
            },
            output,
            diagnostics,
        )
    })
}

pub fn run_server_detached(
    input: impl Read + Send + 'static,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<ExitReason> {
    run_threads(
        |events, asked| {
            std::thread::spawn(move || read_messages(input, &events, &asked));
        },
        output,
        diagnostics,
    )
}

fn read_messages(input: impl Read, events: &mpsc::Sender<Event>, asked: &mpsc::Receiver<()>) {
    let mut reader = BufReader::new(input);
    while asked.recv().is_ok() {
        let message = read_message(&mut reader);
        let last = !matches!(message, Ok(Some(_)));
        if events.send(Event::Message(message)).is_err() || last {
            return;
        }
    }
}

fn run_threads(
    spawn_reader: impl FnOnce(mpsc::Sender<Event>, mpsc::Receiver<()>),
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<ExitReason> {
    let (events, received) = mpsc::channel::<Event>();
    let (ask, asked) = mpsc::channel::<()>();
    spawn_reader(events.clone(), asked);
    std::thread::scope(|scope| {
        let (jobs, queued) = mpsc::channel::<analysis::Job>();
        scope.spawn(move || {
            while let Ok(job) = queued.recv() {
                let event =
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job.run())) {
                        Ok(analyzed) => Event::Analyzed(analyzed),
                        Err(_) => Event::WorkerFailed,
                    };
                if events.send(event).is_err() {
                    return;
                }
            }
        });
        let mut session = Session::default();
        let result = serve(&mut session, &received, &ask, &jobs, output, diagnostics);
        session.analysis.cancel_all();
        result
    })
}

fn serve(
    session: &mut Session,
    events: &mpsc::Receiver<Event>,
    ask: &mpsc::Sender<()>,
    jobs: &mpsc::Sender<analysis::Job>,
    output: &mut impl Write,
    diagnostics: &mut impl Write,
) -> Result<ExitReason> {
    let mut reading = false;
    loop {
        if let Some(job) = session.analysis.dispatch(&session.server) {
            jobs.send(job)
                .map_err(|_| anyhow::anyhow!("the analysis worker stopped"))?;
        }
        match session.settle(output) {
            Ok(Some(reason)) => return Ok(reason),
            Ok(None) => {}
            Err(_) if session.input_closed() => return Ok(ExitReason::ParentClosed),
            Err(error) => return Err(error),
        }
        if !reading && session.reads() {
            ask.send(())
                .map_err(|_| anyhow::anyhow!("the message reader stopped"))?;
            reading = true;
        }
        let event = events
            .recv()
            .map_err(|_| anyhow::anyhow!("the language server threads stopped"))?;
        match event {
            Event::Message(message) => {
                reading = false;
                match message? {
                    Some(message) => {
                        if let Some(reason) = session.message(&message, output, diagnostics)? {
                            return Ok(reason);
                        }
                    }
                    None => {
                        writeln!(diagnostics, "rms-ls: parent input closed; exiting")?;
                        session.close_input();
                    }
                }
            }
            Event::Analyzed(analyzed) => match session.analyzed(analyzed, output) {
                Ok(()) => {}
                Err(_) if session.input_closed() => return Ok(ExitReason::ParentClosed),
                Err(error) => return Err(error),
            },
            Event::WorkerFailed => bail!("the analysis worker failed"),
        }
    }
}

struct Parked {
    id: Value,
    method: String,
    params: Value,
    uri: String,
    version: i64,
    ticket: u64,
    timing: latency::Timing,
}

enum Drain {
    Shutdown { id: Value, timing: latency::Timing },
    InputClosed,
}

#[derive(Default)]
struct Session {
    server: Server,
    analysis: analysis::Analysis,
    parked: Vec<Parked>,
    drain: Option<Drain>,
}

impl Session {
    fn reads(&self) -> bool {
        self.drain.is_none()
    }

    fn input_closed(&self) -> bool {
        matches!(self.drain, Some(Drain::InputClosed))
    }

    fn close_input(&mut self) {
        self.drain = Some(Drain::InputClosed);
    }

    fn message(
        &mut self,
        message: &[u8],
        output: &mut impl Write,
        diagnostics: &mut impl Write,
    ) -> Result<Option<ExitReason>> {
        let mut timing = latency::Timing::start();
        let value: Value = match serde_json::from_slice(message) {
            Ok(value) => value,
            Err(error) => {
                write_message(
                    output,
                    &error_response(
                        Value::Null,
                        -32700,
                        format!("invalid JSON-RPC payload: {error}"),
                    ),
                )?;
                return Ok(None);
            }
        };
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = value.get("id").cloned();
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        timing.step("decode");

        if method == "exit" {
            writeln!(diagnostics, "rms-ls: exit notification received")?;
            return Ok(Some(if self.server.shutdown_requested {
                ExitReason::Orderly
            } else {
                ExitReason::ExitWithoutShutdown
            }));
        }
        if method == "$/cancelRequest" {
            if let Some(cancelled) = params.get("id") {
                let key = id_key(cancelled);
                if let Some(index) = self
                    .parked
                    .iter()
                    .position(|parked| id_key(&parked.id) == key)
                {
                    let parked = self.parked.remove(index);
                    write_message(
                        output,
                        &error_response(parked.id, -32800, "request was cancelled"),
                    )?;
                } else {
                    self.server.remember_cancellation(key);
                }
            }
            return Ok(None);
        }

        if let Some(id) = id {
            if self.server.take_cancellation(&id_key(&id)) {
                write_message(output, &error_response(id, -32800, "request was cancelled"))?;
                return Ok(None);
            }
            if method == "shutdown" {
                self.drain = Some(Drain::Shutdown { id, timing });
                return Ok(None);
            }
            if let Some((uri, version, ticket)) = self.waits_for_analysis(method, &params) {
                self.parked.push(Parked {
                    id,
                    method: method.to_owned(),
                    params,
                    uri,
                    version,
                    ticket,
                    timing,
                });
                return Ok(None);
            }
            self.answer(id, method, &params, timing, output)?;
            self.analysis.observe(&self.server);
            return Ok(None);
        }
        let notified = self.server.notification_deferred(method, &params);
        self.analysis.observe(&self.server);
        match notified {
            Ok(notified) => {
                let mut publications = Vec::with_capacity(notified.publish.len());
                for uri in &notified.publish {
                    self.analysis.forget(uri);
                    match self.server.publish_diagnostics(uri) {
                        Ok(publication) => publications.push(publication),
                        Err(error) => writeln!(
                            diagnostics,
                            "rms-ls: diagnostics of a document were not published: {}",
                            error.message
                        )?,
                    }
                }
                self.server.stamp_editor_publications(&mut publications);
                timing.step("handle");
                for notification in publications.iter().chain(&notified.immediate) {
                    write_message(output, notification)?;
                }
                self.analysis.queue(notified.analyze);
                timing.step("write");
                timing.finish(method, None);
            }
            Err(error) => {
                writeln!(
                    diagnostics,
                    "rms-ls: notification {method} rejected: {}",
                    error.message
                )?;
            }
        }
        self.release_parked(output)?;
        Ok(None)
    }

    fn waits_for_analysis(&self, method: &str, params: &Value) -> Option<(String, i64, u64)> {
        if !STRICT_REQUESTS.contains(&method)
            || !self.server.initialized
            || self.parked.len() >= MAX_PARKED_REQUESTS
        {
            return None;
        }
        let uri = text_document_uri(params).ok()?;
        if !self
            .server
            .source_catalog
            .peek()
            .as_ref()
            .is_some_and(|catalog| is_catalog_entry(catalog, uri))
        {
            return None;
        }
        let version = self.server.documents.get(uri)?.version;
        let ticket = self.analysis.ticket(uri)?;
        Some((uri.to_owned(), version, ticket))
    }

    fn answer(
        &mut self,
        id: Value,
        method: &str,
        params: &Value,
        mut timing: latency::Timing,
        output: &mut impl Write,
    ) -> Result<()> {
        let reported_id = id.clone();
        let wants_facts = facts::requested(params);
        facts::reset();
        if let Some(result) = self.server.request_text(method, params) {
            match result {
                Ok(text) => {
                    timing.step("handle");
                    if wants_facts {
                        let text = facts::envelope_text(&text, facts::closed_read());
                        write_text_response(output, &id, &text)?;
                    } else {
                        write_text_response(output, &id, &text)?;
                    }
                }
                Err(error) => {
                    timing.step("handle");
                    write_message(output, &error_response(id, error.code, error.message))?;
                }
            }
            timing.step("write");
            timing.finish(method, Some(&reported_id));
            return Ok(());
        }
        let response = match self.server.request(method, params) {
            Ok(result) if wants_facts => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": facts::envelope(result, facts::closed_read()),
            }),
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => error_response(id, error.code, error.message),
        };
        timing.step("handle");
        write_message(output, &response)?;
        timing.step("write");
        timing.finish(method, Some(&reported_id));
        Ok(())
    }

    fn analyzed(&mut self, analyzed: analysis::Analyzed, output: &mut impl Write) -> Result<()> {
        if let analysis::Finished::Current(publication) =
            self.analysis.finished(&self.server, analyzed)
        {
            let mut publications = [publication];
            self.server.stamp_editor_publications(&mut publications);
            let [publication] = publications;
            write_message(output, &publication)?;
        }
        self.release_parked(output)
    }

    fn release_parked(&mut self, output: &mut impl Write) -> Result<()> {
        let mut index = 0;
        while index < self.parked.len() {
            let parked = &self.parked[index];
            let current = self
                .server
                .documents
                .get(&parked.uri)
                .is_some_and(|document| document.version == parked.version);
            if current && self.analysis.holds(parked.ticket) {
                index += 1;
                continue;
            }
            let parked = self.parked.remove(index);
            if current {
                self.answer(
                    parked.id,
                    &parked.method,
                    &parked.params,
                    parked.timing,
                    output,
                )?;
                self.analysis.observe(&self.server);
            } else {
                write_message(
                    output,
                    &error_response(
                        parked.id,
                        -32801,
                        "the document changed before the answer was ready",
                    ),
                )?;
            }
        }
        Ok(())
    }

    fn settle(&mut self, output: &mut impl Write) -> Result<Option<ExitReason>> {
        if self.drain.is_none() || !self.analysis.idle() {
            return Ok(None);
        }
        self.release_parked(output)?;
        match self.drain.take() {
            Some(Drain::Shutdown { id, timing }) => {
                self.answer(id, "shutdown", &Value::Null, timing, output)?;
                Ok(None)
            }
            Some(Drain::InputClosed) => Ok(Some(ExitReason::ParentClosed)),
            None => Ok(None),
        }
    }
}

#[derive(Default)]
struct Server {
    initialized: bool,
    shutdown_requested: bool,
    documents: BTreeMap<String, Arc<OpenDocument>>,
    source_catalog: Closed<Option<SourceCatalog>>,
    catalog_documents: Closed<BTreeMap<String, Arc<OpenDocument>>>,
    editor: editor_inventory::State,
    dependency_graph: Closed<DependencyGraph>,
    cancelled_requests: VecDeque<String>,
    preview_context: PreviewContext,
    semantic_cache: Arc<Mutex<VecDeque<CachedSemanticAnalysis>>>,
    effective_catalog: Arc<Mutex<Option<EffectiveCatalog>>>,
    xs: xs::XsState,
    lint_disabled: BTreeSet<String>,
    revision: u64,
}

#[derive(Default)]
struct Notified {
    publish: Vec<String>,
    immediate: Vec<Value>,
    analyze: Vec<String>,
}

pub(crate) struct PublicationDraft {
    uri: String,
    document: Arc<OpenDocument>,
    diagnostics: Vec<Value>,
    generation_context: Value,
    strict: Option<StrictDraft>,
    findings: Option<(Vec<rms_analysis::LintFinding>, bool)>,
}

struct StrictDraft {
    catalog: SourceCatalog,
    options: StrictParseOptions,
    program: Result<Arc<SemanticProgram>, StrictParseError>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone)]
struct CachedSemanticAnalysis {
    catalog_hash: [u8; 32],
    options: StrictParseOptions,
    result: Result<Arc<SemanticProgram>, StrictParseError>,
}

struct EffectiveCatalog {
    base_hash: [u8; 32],
    version: i64,
    catalog: SourceCatalog,
}

struct OpenDocument {
    version: i64,
    source: SourceText,
    analysis: DocumentAnalysis,
    facts: std::sync::OnceLock<rms_lint::DocumentFacts>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreviewContext {
    setup: SetupContext,
    seed: u32,
    dimensions: MapDimensions,
    map_size: String,
    players: Vec<PlayerConfiguration>,
}

impl Default for PreviewContext {
    fn default() -> Self {
        Self {
            setup: SetupContext::default(),
            seed: 0,
            dimensions: MapDimensions {
                width: 200,
                height: 200,
            },
            map_size: "normal".to_owned(),
            players: vec![
                PlayerConfiguration {
                    slot: 1,
                    team: 1,
                    civilization_id: CivilizationId(0),
                    color: 0,
                },
                PlayerConfiguration {
                    slot: 2,
                    team: 2,
                    civilization_id: CivilizationId(0),
                    color: 1,
                },
            ],
        }
    }
}

impl PreviewContext {
    fn strict_options(&self, catalog: Option<&SourceCatalog>) -> RequestResult<StrictParseOptions> {
        let (profile_id, vocabulary) = match catalog {
            Some(catalog) => (
                catalog.profile_id().to_owned(),
                catalog.implicit_definitions().clone(),
            ),
            None => {
                let bundle = packaged_support_bundles()
                    .map_err(|error| RequestError::invalid(error.to_string()))?
                    .first()
                    .ok_or_else(|| RequestError::invalid("no packaged support bundle"))?;
                (
                    bundle.manifest.behavior_profile_id.clone(),
                    bundle
                        .vocabulary()
                        .map_err(|error| RequestError::invalid(error.to_string()))?,
                )
            }
        };
        let mut options = product_strict_options_for_profile(&profile_id, &vocabulary)
            .map_err(RequestError::invalid)?;
        self.setup
            .configure_strict_parser(
                &mut options,
                self.seed,
                self.dimensions,
                &self.map_size,
                &self.players,
            )
            .map_err(|error| RequestError::invalid(error.to_string()))?;
        Ok(options)
    }
}

#[derive(Debug)]
struct RequestError {
    code: i64,
    message: String,
}

impl RequestError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: -32002,
            message: message.into(),
        }
    }
}

type RequestResult<T> = std::result::Result<T, RequestError>;

impl Server {
    fn request(&mut self, method: &str, params: &Value) -> RequestResult<Value> {
        if self.editor.expire() {
            self.sync_editor_inventory();
        }
        self.check_editor_request(method, params)?;
        match method {
            "initialize" => {
                self.initialized = true;
                Ok(initialize_result())
            }
            "shutdown" => {
                self.shutdown_requested = true;
                Ok(Value::Null)
            }
            _ if !self.initialized => Err(RequestError::unavailable(
                "initialize must complete before language requests",
            )),
            "rms/xsSyntaxCheck" => xs::syntax_check(params),
            "rms/sourceCatalogDiscovery" => source_discovery::request(params),
            "rms/editorInventory" => self.editor_inventory_request(params),
            "completionItem/resolve" => rms_docs::resolve(params)
                .map_or_else(|| xs::resolve_completion(params, self.xs_build()), Ok),
            _ if self.is_xs_request(params) => self.xs_request(method, params),
            "textDocument/codeAction" => self.rms_code_actions(params),
            "textDocument/inlayHint" => self.rms_inlay_hints(params),
            "textDocument/completion" => self
                .rms_completion(params)
                .map(|list| rms_docs::attach(self, params, list)),
            "textDocument/signatureHelp" => self.rms_signature_help(params),
            "textDocument/hover" => self.hover(params),
            "textDocument/definition" => self.rms_definition(params),
            "textDocument/documentLink" => self.document_links(params),
            "textDocument/references" => self.rms_references(params),
            "textDocument/documentHighlight" => self.rms_document_highlight(params),
            "textDocument/documentSymbol" => self.document_symbols(params),
            "textDocument/foldingRange" => self.folding_ranges(params),
            "textDocument/semanticTokens/full" => self.semantic_tokens(params),
            "workspace/symbol" => self.workspace_symbols(params),
            "textDocument/formatting" => self.formatting(params),
            "textDocument/prepareRename" => self.prepare_rename(params),
            "textDocument/rename" => self.rename(params),
            "rms/semanticIdentity" => self.semantic_identity(params),
            _ => Err(RequestError {
                code: -32601,
                message: "method not found".to_owned(),
            }),
        }
    }

    fn request_text(&mut self, method: &str, params: &Value) -> Option<RequestResult<String>> {
        if !self.initialized {
            return None;
        }
        if self.editor.expire() {
            self.sync_editor_inventory();
        }
        if let Err(error) = self.check_editor_request(method, params) {
            return Some(Err(error));
        }
        match method {
            "textDocument/semanticTokens/full" if self.is_xs_request(params) => {
                let uri = text_document_uri(params).ok()?.to_owned();
                let context = self.xs_context();
                Some(xs::semantic_tokens_text(&self.xs, &uri, &context))
            }
            "textDocument/semanticTokens/full" => Some(
                self.semantic_token_data(params)
                    .map(|data| semantic_tokens_text(&data)),
            ),
            "textDocument/documentSymbol" if !self.is_xs_request(params) => {
                Some(self.document_symbols_text(params))
            }
            _ => None,
        }
    }

    fn notification_deferred(&mut self, method: &str, params: &Value) -> RequestResult<Notified> {
        if self.editor.expire() {
            self.sync_editor_inventory();
        }
        if matches!(
            method,
            "textDocument/didOpen"
                | "textDocument/didChange"
                | "textDocument/didClose"
                | "rms/xsEnvironment"
                | "rms/previewContext"
        ) {
            self.editor.document_epoch = self.editor.document_epoch.saturating_add(1);
        }
        if self.editor.modern
            && matches!(
                method,
                "textDocument/didOpen"
                    | "textDocument/didClose"
                    | "workspace/didChangeWatchedFiles"
                    | "rms/xsEnvironment"
            )
        {
            if self.editor_inventory_current() {
                self.note_xs_listings();
            }
            self.editor.clear();
            self.sync_editor_inventory();
        }
        let mut notified = self.notification_unstamped(method, params)?;
        self.revision = self.revision.wrapping_add(1);
        self.stamp_editor_publications(&mut notified.immediate);
        Ok(notified)
    }

    fn notification_unstamped(&mut self, method: &str, params: &Value) -> RequestResult<Notified> {
        let now = |immediate: Vec<Value>| Notified {
            immediate,
            ..Notified::default()
        };
        match method {
            "initialized" => Ok(Notified::default()),
            "textDocument/didOpen" => {
                if self.documents.len() + self.xs.documents.len() >= MAX_DOCUMENTS {
                    return Err(RequestError::unavailable(
                        "workspace document limit exceeded",
                    ));
                }
                let document = required(params, "textDocument")?;
                let uri = string_field(document, "uri")?.to_owned();
                let version = integer_field(document, "version")?;
                let text = string_field(document, "text")?;
                let language_id = document.get("languageId").and_then(Value::as_str);
                if xs::is_xs_document(&uri, language_id) {
                    self.insert_xs_document(uri.clone(), version, text)?;
                    return Ok(now(self.publish_xs_diagnostics(Some(&uri), false)));
                }
                self.update_rms_document(uri, version, text, false)
            }
            "textDocument/didChange" => {
                let document = required(params, "textDocument")?;
                let uri = string_field(document, "uri")?.to_owned();
                let version = integer_field(document, "version")?;
                if let Some(current) = self.xs.documents.get(&uri) {
                    if version <= current.version {
                        return Ok(now(vec![json!({
                            "jsonrpc": "2.0",
                            "method": "window/logMessage",
                            "params": {
                                "type": 3,
                                "message": format!("ignored stale document version {version} for {uri}")
                            }
                        })]));
                    }
                    let text = params
                        .get("contentChanges")
                        .and_then(Value::as_array)
                        .and_then(|changes| changes.last())
                        .and_then(|change| change.get("text"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| RequestError::invalid("full document text is missing"))?;
                    self.insert_xs_document(uri.clone(), version, text)?;
                    return Ok(now(self.publish_xs_diagnostics(Some(&uri), false)));
                }
                let current = self
                    .documents
                    .get(&uri)
                    .ok_or_else(|| RequestError::invalid("document is not open"))?;
                if version <= current.version {
                    return Ok(now(vec![json!({
                        "jsonrpc": "2.0",
                        "method": "window/logMessage",
                        "params": {
                            "type": 3,
                            "message": format!("ignored stale document version {version} for {uri}")
                        }
                    })]));
                }
                let changes = params
                    .get("contentChanges")
                    .and_then(Value::as_array)
                    .ok_or_else(|| RequestError::invalid("contentChanges must be an array"))?;
                let text = changes
                    .last()
                    .and_then(|change| change.get("text"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| RequestError::invalid("full document text is missing"))?;
                self.update_rms_document(uri, version, text, true)
            }
            "textDocument/didClose" => {
                let uri = text_document_uri(params)?;
                let had_xs_links = self
                    .documents
                    .remove(uri)
                    .is_some_and(|document| !include_xs_paths(&document).is_empty());
                let was_xs = self.xs.documents.remove(uri).is_some() || had_xs_links;
                let mut notifications = vec![json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": { "uri": uri, "diagnostics": [] }
                })];
                if was_xs {
                    notifications.extend(self.publish_xs_diagnostics(None, false));
                }
                Ok(now(notifications))
            }
            "workspace/didChangeWatchedFiles" => Ok(Notified {
                publish: self.documents.keys().cloned().collect(),
                immediate: self.publish_xs_diagnostics(None, true),
                analyze: Vec::new(),
            }),
            "rms/xsEnvironment" => {
                xs::install_environment(&mut self.xs, params)?;
                Ok(now(self.publish_xs_diagnostics(None, true)))
            }
            "rms/previewContext" => {
                let next = preview_context_from_json(params)?;
                if next == self.preview_context {
                    return Ok(Notified::default());
                }
                self.preview_context = next;
                self.rebuild_dependency_graph();
                Ok(Notified {
                    publish: self.documents.keys().cloned().collect(),
                    ..Notified::default()
                })
            }
            "rms/lintSettings" => {
                self.install_lint_settings(params)?;
                Ok(Notified {
                    publish: self.documents.keys().cloned().collect(),
                    ..Notified::default()
                })
            }
            "rms/sourceCatalog" => Ok(Notified {
                publish: self.install_source_catalog(params)?,
                immediate: self.publish_xs_diagnostics(None, true),
                analyze: Vec::new(),
            }),
            "rms/sourceCatalogInvalidated" => self.invalidate_source_catalog(params),
            "rms/editorInventoryChanged" => {
                self.check_editor_request("workspace/symbol", params)?;
                Ok(Notified {
                    publish: self.documents.keys().cloned().collect(),
                    immediate: self.publish_xs_diagnostics(None, true),
                    analyze: Vec::new(),
                })
            }
            _ => Ok(Notified::default()),
        }
    }

    fn insert_document(&mut self, uri: String, version: i64, text: &str) -> RequestResult<()> {
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(RequestError::invalid("document exceeds the 16 MiB bound"));
        }
        let retained = self.retained_bytes(&uri);
        if retained.saturating_add(text.len()) > MAX_TOTAL_DOCUMENT_BYTES {
            return Err(RequestError::unavailable(
                "open documents exceed their 64 MiB total bound",
            ));
        }
        let source_id =
            SourceId::new(uri.clone()).map_err(|error| RequestError::invalid(error.to_string()))?;
        let source = SourceText::from_bytes(source_id, text.as_bytes())
            .map_err(|error| RequestError::invalid(error.to_string()))?;
        let analysis = analyze_document(&source);
        self.documents.insert(
            uri,
            Arc::new(OpenDocument {
                version,
                source,
                analysis,
                facts: Default::default(),
            }),
        );
        Ok(())
    }

    fn install_source_catalog(&mut self, params: &Value) -> RequestResult<Vec<String>> {
        let next = source_catalog_from_json(params)?;
        lock(&self.effective_catalog).take();
        let previous = self.source_catalog.take();
        let changed = changed_catalog_sources(previous.as_ref(), &next);
        let previous_graph = self.dependency_graph.clone();
        *self.source_catalog = Some(next);
        self.rebuild_dependency_graph();

        let affected = if previous.is_none() {
            None
        } else {
            Some(
                changed
                    .iter()
                    .flat_map(|source| {
                        previous_graph
                            .invalidated_by_change(source)
                            .into_iter()
                            .chain(self.dependency_graph.invalidated_by_change(source))
                    })
                    .collect::<BTreeSet<_>>(),
            )
        };
        Ok(self
            .documents
            .keys()
            .filter(|uri| {
                affected.as_ref().is_none_or(|affected| {
                    SourceId::new((*uri).clone())
                        .is_ok_and(|source_id| affected.contains(&source_id))
                })
            })
            .cloned()
            .collect())
    }

    fn rebuild_dependency_graph(&mut self) {
        *self.dependency_graph = DependencyGraph::default();
        let Some(catalog) = &*self.source_catalog else {
            if !self.editor.modern {
                self.catalog_documents.clear();
                self.xs.catalog_files.clear();
            }
            return;
        };
        if !self.editor.modern {
            *self.xs.catalog_files = catalog
                .sources()
                .iter()
                .filter(|source| source.role == SourceCatalogRole::ExternalXs)
                .filter_map(|source| {
                    let text =
                        SourceText::from_bytes(source.source_id.clone(), source.bytes.clone())
                            .ok()?;
                    Some((
                        source.source_id.as_str().to_owned(),
                        xs_analysis::XsFile::parse(text),
                    ))
                })
                .collect();
            *self.catalog_documents = catalog
                .sources()
                .iter()
                .filter(|source| source.role != SourceCatalogRole::ExternalXs)
                .filter_map(|source| {
                    let text =
                        SourceText::from_bytes(source.source_id.clone(), source.bytes.clone())
                            .ok()?;
                    Some((
                        source.source_id.as_str().to_owned(),
                        Arc::new(OpenDocument {
                            version: i64::try_from(catalog.revision()).unwrap_or(i64::MAX),
                            analysis: analyze_document(&text),
                            source: text,
                            facts: Default::default(),
                        }),
                    ))
                })
                .collect();
        }
        for source in catalog.sources() {
            let _ = self
                .dependency_graph
                .set_dependencies(source.source_id.clone(), Vec::<SourceId>::new());
        }
        let Ok(options) = self.preview_context.strict_options(Some(catalog)) else {
            return;
        };
        let Ok(program) = self.analyze_catalog_shared(catalog, options) else {
            return;
        };
        let mut direct = BTreeMap::<SourceId, BTreeSet<SourceId>>::new();
        for decision in &program.decisions {
            if decision.kind != ParsedDecisionKind::Include {
                continue;
            }
            if let Some(target) = decision
                .values
                .first()
                .and_then(|value| SourceId::new(value.as_str()).ok())
            {
                direct
                    .entry(decision.source_id.clone())
                    .or_default()
                    .insert(target);
            }
        }
        for (source, dependencies) in direct {
            let _ = self.dependency_graph.set_dependencies(source, dependencies);
        }
    }

    fn publish_diagnostics(&self, uri: &str) -> RequestResult<Value> {
        let mut draft = self.publication_strict(uri)?;
        self.publication_lint(&mut draft);
        Ok(self.publication_finish(draft))
    }

    pub(crate) fn publication_strict(&self, uri: &str) -> RequestResult<PublicationDraft> {
        let document = self
            .documents
            .get(uri)
            .cloned()
            .ok_or_else(|| RequestError::invalid("document is not open"))?;
        let diagnostics = document
            .analysis
            .diagnostics
            .iter()
            .filter_map(|diagnostic| {
                Some(json!({
                    "range": lsp_range(&document.source, diagnostic.range)?,
                    "severity": match diagnostic.severity {
                        DiagnosticSeverity::Error => 1,
                        DiagnosticSeverity::Warning => 2,
                    },
                    "code": diagnostic.code,
                    "source": "rms-ls",
                    "message": diagnostic.message,
                }))
            })
            .collect::<Vec<_>>();
        let mut generation_context = self.generation_diagnostic_context();
        let mut strict = None;
        if let Some(catalog) = self
            .source_catalog
            .as_ref()
            .filter(|catalog| is_catalog_entry(catalog, uri))
            && let Ok(effective_catalog) = self.effective_catalog(catalog, &document)
            && let Ok(options) = self
                .preview_context
                .strict_options(Some(&effective_catalog))
        {
            generation_context["effectiveCatalogHash"] =
                json!(hex(&effective_catalog.catalog_hash()));
            generation_context["entryOverlayHash"] =
                json!(hex(&document.analysis.document_revision));
            let program = self.analyze_catalog_shared(&effective_catalog, options.clone());
            strict = Some(StrictDraft {
                catalog: effective_catalog,
                options,
                program,
            });
        }
        Ok(PublicationDraft {
            uri: uri.to_owned(),
            document,
            diagnostics,
            generation_context,
            strict,
            findings: None,
        })
    }

    pub(crate) fn publication_lint(&self, draft: &mut PublicationDraft) {
        let uri = draft.uri.as_str();
        let document = &*draft.document;
        let diagnostics = &mut draft.diagnostics;
        let mut lint = None;
        if let Some(StrictDraft {
            catalog: effective_catalog,
            options,
            program,
        }) = &draft.strict
        {
            match program {
                Ok(program) => {
                    let strict = rms_lint::StrictReading::new(
                        program,
                        effective_catalog.implicit_definitions(),
                        options,
                    );
                    lint = Some(self.lint_findings(uri, document, Some(&strict), Some(options)));
                    if let Err(error) = validate_exact_semantic_scope(program) {
                        diagnostics.push(json!({
                            "range": empty_range(),
                            "severity": 2,
                            "code": "RMSGEN1009",
                            "source": "rms-ls",
                            "message": error.to_string(),
                        }));
                    }
                    if !program.external_dependencies.is_empty() {
                        diagnostics.push(json!({
                            "range": empty_range(),
                            "severity": 3,
                            "code": "RMSXS0001",
                            "source": "rms-ls",
                            "message": "XS dependency is validated and tracked, but standalone preview does not execute XS post-load effects.",
                        }));
                    }
                    for decision in program.decisions.iter().filter(|decision| {
                        decision.kind == ParsedDecisionKind::UndefinedNumericFallback
                    }) {
                        let symbol = decision.values.first().map_or("unknown", String::as_str);
                        let value = decision.values.get(1).map_or("0", String::as_str);
                        diagnostics.push(json!({
                            "range": self.decision_range_in(uri, &document.source, decision),
                            "severity": 2,
                            "code": "RMS2034",
                            "source": "rms-ls",
                            "message": format!(
                                "{symbol} is not defined where {} reads it, so it counts as {value}.",
                                source_file_name(decision.source_id.as_str())
                            ),
                            "data": self.decision_anchor(decision),
                        }));
                    }
                    for decision in program.decisions.iter().filter(|decision| {
                        decision.kind == ParsedDecisionKind::MissingIncludeFallback
                    }) {
                        let path = decision.values.first().map_or("unknown", String::as_str);
                        diagnostics.push(json!({
                            "range": self.decision_range_in(uri, &document.source, decision),
                            "severity": 2,
                            "code": "RMS2022",
                            "source": "rms-ls",
                            "message": format!(
                                "{} skips the missing include {path}, as the game allows.",
                                source_file_name(decision.source_id.as_str())
                            ),
                            "data": self.decision_anchor(decision),
                        }));
                    }
                }
                Err(error) => {
                    lint = Some(self.lint_findings(uri, document, None, Some(options)));
                    let error_source = error.source_chain.last().map(SourceId::as_str);
                    let error_is_in_document = error_source.is_none_or(|source| source == uri);
                    let duplicates_tolerant_diagnostic = error_is_in_document
                        && error.range.is_some_and(|range| {
                            document.analysis.diagnostics.iter().any(|diagnostic| {
                                diagnostic.range == range
                                    && diagnostic.code == error.code
                                    && diagnostic.message == error.message
                            })
                        });
                    if !duplicates_tolerant_diagnostic {
                        diagnostics.push(json!({
                            "range": if error_is_in_document {
                                error.range.and_then(|range| lsp_range(&document.source, range)).unwrap_or_else(empty_range)
                            } else {
                                empty_range()
                            },
                            "severity": 1,
                            "code": error.code,
                            "source": "rms-ls",
                            "message": error_source.filter(|source| *source != uri).map_or_else(
                                || error.message.clone(),
                                |source| format!("{} in {source}", error.message),
                            ),
                        }));
                    }
                }
            }
        }
        let shared_findings = lint.is_some();
        let findings = match lint {
            Some(findings) => findings,
            None => {
                let options = self
                    .preview_context
                    .strict_options(self.source_catalog.as_ref())
                    .ok();
                self.lint_findings(uri, document, None, options.as_ref())
            }
        };
        diagnostics.extend(findings.iter().filter_map(|finding| {
            rms_lint::finding_json(&document.source, finding, &|id| {
                self.generation_source(id.as_str())
            })
        }));
        draft.findings = Some((findings, shared_findings));
    }

    pub(crate) fn publication_finish(&self, draft: PublicationDraft) -> Value {
        let PublicationDraft {
            uri,
            document,
            diagnostics,
            generation_context,
            findings,
            ..
        } = draft;
        let shared = findings
            .as_ref()
            .filter(|(_, shared)| *shared)
            .map(|(findings, _)| findings.as_slice());
        let code_actions = self.published_code_actions(&uri, &document, &diagnostics, shared);
        let mut publication = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "version": document.version,
                "diagnostics": diagnostics,
                "rmsCodeActions": code_actions,
            }
        });
        if self.editor.modern {
            publication["params"]["generationContext"] = generation_context;
        }
        publication
    }

    fn published_code_actions(
        &self,
        uri: &str,
        document: &OpenDocument,
        diagnostics: &[Value],
        findings: Option<&[rms_analysis::LintFinding]>,
    ) -> Value {
        let mut seen = BTreeSet::new();
        let mut ranges = Vec::new();
        for diagnostic in diagnostics {
            if ranges.len() >= MAX_PUBLISHED_CODE_ACTION_RANGES {
                break;
            }
            let key = diagnostic["range"].to_string();
            if !seen.insert(key) {
                continue;
            }
            if let Ok(range) = rms_lint::request_range(&document.source, diagnostic) {
                ranges.push((diagnostic["range"].clone(), range));
            }
        }
        let byte_ranges = ranges.iter().map(|(_, range)| *range).collect::<Vec<_>>();
        let actions = self.rms_code_actions_for(uri, document, &byte_ranges, findings);
        published_code_actions_json(ranges.into_iter().map(|(range, _)| range), actions)
    }

    fn hover(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let includes = include_syntax(document)
            .into_iter()
            .filter(|include| range_contains(include.range, offset))
            .take(1)
            .collect();
        if let Some(link) = self.resolve_includes(uri, includes).first() {
            return Ok(self.include_hover(&document.source, link));
        }
        let Some(token) = token_at(document, offset) else {
            return Ok(Value::Null);
        };
        Ok(rms_docs::hover(self, document, token).unwrap_or(Value::Null))
    }

    fn document_links(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        let links = self.resolve_includes(uri, include_syntax(document));
        Ok(self.include_links_json(&document.source, &links))
    }

    fn resolve_includes(&self, uri: &str, includes: Vec<IncludeSyntax>) -> Vec<IncludeLink> {
        let mut rms_resolver = None;
        let mut xs_resolver = None;
        includes
            .into_iter()
            .map(|include| {
                let target = if include.external_xs {
                    xs_resolver
                        .get_or_insert_with(|| xs::WorkspaceResolver::new(&self.xs))
                        .resolve_path(uri, &include.path)
                        .map(|file| file.id().as_str().to_owned())
                        .ok_or_else(|| {
                            format!(
                                "No XS file named {} is next to the script or in the game's XS folder.",
                                markdown_code(&include.path)
                            )
                        })
                } else {
                    match rms_resolver.get_or_insert_with(|| self.rms_include_resolver(uri)) {
                        Ok((resolver, current_path)) => {
                            resolve_rms_include(resolver, current_path, &include.path)
                        }
                        Err(reason) => Err(reason.clone()),
                    }
                };
                IncludeLink {
                    range: include.range,
                    path: include.path,
                    target,
                }
            })
            .collect()
    }

    fn resolve_rms_includes_of(
        &self,
        documents: Vec<(String, Vec<IncludeSyntax>)>,
    ) -> Vec<(String, Vec<IncludeLink>)> {
        type Cached = Option<Result<VirtualSourceResolver, String>>;
        let mut catalog_resolver: Cached = None;
        let mut open_resolver: Cached = None;
        documents
            .into_iter()
            .map(|(uri, includes)| {
                let catalog_path = self.editor_sources().and_then(|catalog| {
                    catalog
                        .sources()
                        .iter()
                        .find(|source| {
                            source.role != SourceCatalogRole::ExternalXs
                                && source.source_id.as_str() == uri
                        })
                        .map(|source| source.path.clone())
                });
                let (cache, current_path) = match catalog_path {
                    Some(path) => (&mut catalog_resolver, path),
                    None => (&mut open_resolver, uri.clone()),
                };
                let resolver = cache.get_or_insert_with(|| {
                    self.rms_include_resolver(&uri)
                        .map(|(resolver, _)| resolver)
                });
                let links = includes
                    .into_iter()
                    .filter(|include| !include.external_xs)
                    .map(|include| IncludeLink {
                        range: include.range,
                        target: match resolver {
                            Ok(resolver) => {
                                resolve_rms_include(resolver, &current_path, &include.path)
                            }
                            Err(reason) => Err(reason.clone()),
                        },
                        path: include.path,
                    })
                    .collect();
                (uri, links)
            })
            .collect()
    }

    fn rms_include_resolver(&self, uri: &str) -> Result<(VirtualSourceResolver, String), String> {
        let unavailable = |error: String| format!("The include cannot be resolved: {error}.");
        if let Some(catalog) = self.editor_sources()
            && let Some(current) = catalog.sources().iter().find(|source| {
                source.role != SourceCatalogRole::ExternalXs && source.source_id.as_str() == uri
            })
        {
            let sources = catalog
                .sources()
                .iter()
                .filter_map(|source| {
                    let id = source.source_id.as_str();
                    if source.role == SourceCatalogRole::ExternalXs {
                        let file = self
                            .xs
                            .documents
                            .get(id)
                            .map(|document| &document.file)
                            .or_else(|| self.xs.catalog_files.get(id))?;
                        VirtualSource::external_xs(&source.path, file.source.clone()).ok()
                    } else {
                        let document = self
                            .documents
                            .get(id)
                            .map(Arc::as_ref)
                            .or_else(|| self.catalog_documents.get(id).map(Arc::as_ref))?;
                        VirtualSource::new(&source.path, document.source.clone()).ok()
                    }
                })
                .collect();
            let resolver = VirtualSourceResolver::new(
                sources,
                catalog.roots().clone(),
                catalog.case_sensitive(),
            )
            .map_err(|error| unavailable(error.to_string()))?;
            return Ok((resolver, current.path.clone()));
        }
        let sources = self
            .documents
            .iter()
            .filter_map(|(uri, document)| {
                VirtualSource::new(uri.clone(), document.source.clone()).ok()
            })
            .collect();
        let resolver = VirtualSourceResolver::new(sources, ResolverRoots::default(), false)
            .map_err(|error| unavailable(error.to_string()))?;
        Ok((resolver, uri.to_owned()))
    }

    fn is_game_source(&self, uri: &str) -> bool {
        self.editor_sources().is_some_and(|catalog| {
            catalog.sources().iter().any(|source| {
                source.origin == SourceCatalogOrigin::GameData && source.source_id.as_str() == uri
            })
        })
    }

    fn include_data(&self, link: &IncludeLink) -> Value {
        json!({
            "path": link.path,
            "name": include_file_name(&link.path),
            "target": link.target.as_ref().ok(),
            "readOnly": link.target.as_ref().is_ok_and(|target| self.is_game_source(target)),
            "unresolved": link.target.as_ref().err(),
        })
    }

    fn include_links_json(&self, source: &SourceText, links: &[IncludeLink]) -> Value {
        Value::Array(
            links
                .iter()
                .filter_map(|link| {
                    let range = lsp_range(source, link.range)?;
                    let data = self.include_data(link);
                    Some(match &link.target {
                        Ok(target) => json!({
                            "range": range,
                            "target": target,
                            "tooltip": format!("Open {}", include_file_name(&link.path)),
                            "data": data,
                        }),
                        Err(reason) => json!({ "range": range, "tooltip": reason, "data": data }),
                    })
                })
                .collect(),
        )
    }

    fn include_hover(&self, source: &SourceText, link: &IncludeLink) -> Value {
        let data = self.include_data(link);
        let value = match &link.target {
            Ok(_) if data["readOnly"] == true => format!(
                "Included game file {}. It opens read-only.",
                markdown_code(&link.path)
            ),
            Ok(_) => format!("Included file {}.", markdown_code(&link.path)),
            Err(reason) => reason.clone(),
        };
        json!({
            "contents": { "kind": "markdown", "value": value },
            "range": lsp_range(source, link.range),
            "rmsInclude": data,
        })
    }

    fn document_symbols(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        Ok(Value::Array(
            document
                .analysis
                .symbols
                .iter()
                .filter_map(|symbol| {
                    Some(json!({
                        "name": symbol.name,
                        "kind": symbol_kind(symbol.kind),
                        "range": lsp_range(&document.source, symbol.range)?,
                        "selectionRange": lsp_range(&document.source, symbol.selection_range)?,
                    }))
                })
                .collect(),
        ))
    }

    fn document_symbols_text(&self, params: &Value) -> RequestResult<String> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        let mut cursor = 0;
        let mut buffer = itoa_buffer();
        let mut text = String::with_capacity(document.analysis.symbols.len() * 160 + 2);
        text.push('[');
        for symbol in &document.analysis.symbols {
            let Ok(range) = document
                .source
                .byte_range_to_utf16_near(symbol.range, &mut cursor)
            else {
                continue;
            };
            let Ok(selection) = document
                .source
                .byte_range_to_utf16_near(symbol.selection_range, &mut cursor)
            else {
                continue;
            };
            if text.len() > 1 {
                text.push(',');
            }
            text.push_str(r#"{"kind":"#);
            text.push_str(format_u32(&mut buffer, u32::from(symbol_kind(symbol.kind))));
            text.push_str(r#","name":"#);
            push_json_string(&mut text, &symbol.name)?;
            text.push_str(r#","range":"#);
            push_range_text(&mut text, range);
            text.push_str(r#","selectionRange":"#);
            push_range_text(&mut text, selection);
            text.push('}');
        }
        text.push(']');
        Ok(text)
    }

    fn folding_ranges(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        Ok(Value::Array(
            document
                .analysis
                .folds
                .iter()
                .filter_map(|fold| {
                    let range = document.source.byte_range_to_utf16(fold.range).ok()?;
                    (range.end.line > range.start.line).then(|| {
                        json!({
                            "startLine": range.start.line,
                            "startCharacter": range.start.character,
                            "endLine": range.end.line,
                            "endCharacter": range.end.character,
                            "kind": fold.kind,
                        })
                    })
                })
                .collect(),
        ))
    }

    fn semantic_tokens(&self, params: &Value) -> RequestResult<Value> {
        Ok(json!({ "data": self.semantic_token_data(params)? }))
    }

    fn semantic_token_data(&self, params: &Value) -> RequestResult<Vec<u32>> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        Ok(semantic_token_data(
            &document.source,
            document
                .analysis
                .semantic_tokens
                .iter()
                .map(|token| (token.range, semantic_token_kind(token.kind))),
        ))
    }

    fn workspace_symbols(&self, params: &Value) -> RequestResult<Value> {
        let query = params
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut symbols = Vec::new();
        for (uri, document) in self.analysis_documents() {
            for symbol in &document.analysis.symbols {
                if !query.is_empty() && !symbol.name.to_ascii_lowercase().contains(&query) {
                    continue;
                }
                let Some(range) = lsp_range(&document.source, symbol.selection_range) else {
                    continue;
                };
                symbols.push(json!({
                    "name": symbol.name,
                    "kind": symbol_kind(symbol.kind),
                    "location": { "uri": uri, "range": range },
                }));
                if symbols.len() >= MAX_WORKSPACE_SYMBOLS {
                    return Ok(Value::Array(symbols));
                }
            }
        }
        let remaining = MAX_WORKSPACE_SYMBOLS - symbols.len();
        symbols.extend(xs::workspace_symbols(&self.xs, &query, remaining));
        Ok(Value::Array(symbols))
    }

    fn formatting(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        if let Some(version) = params.get("rmsDocumentVersion") {
            let requested = version
                .as_i64()
                .ok_or_else(|| RequestError::invalid("rmsDocumentVersion must be an integer"))?;
            if requested != document.version {
                return Err(RequestError::unavailable(format!(
                    "formatting request is stale: requested document version {requested}, current version {}",
                    document.version
                )));
            }
        }
        if let Some(convention) = params.get("rmsFormatterConvention") {
            let requested = convention.as_u64().ok_or_else(|| {
                RequestError::invalid("rmsFormatterConvention must be an unsigned integer")
            })?;
            if requested != u64::from(CONVENTION_VERSION) {
                return Err(RequestError::unavailable(format!(
                    "unsupported RMS formatter convention {requested}"
                )));
            }
        }
        let mut options = FormatOptions::default();
        if let Some(indent) = params.get("rmsIndentConditionals") {
            options.indent_conditionals = indent
                .as_bool()
                .ok_or_else(|| RequestError::invalid("rmsIndentConditionals must be a boolean"))?;
        }
        let edits = format_document(&document.source, &document.analysis.cst, options).map_err(
            |message| RequestError::unavailable(format!("formatting is unavailable: {message}")),
        )?;
        if edits.is_empty() {
            return Ok(json!([]));
        }
        let candidate = apply_edits(document.source.bytes(), &edits).map_err(|message| {
            RequestError::unavailable(format!("formatting is unavailable: {message}"))
        })?;
        let candidate_text = String::from_utf8(candidate)
            .map_err(|_| RequestError::invalid("formatted document is not UTF-8"))?;
        let candidate_source = source_from_text(uri, &candidate_text)?;
        let candidate_analysis = analyze_document(&candidate_source);
        self.require_formatting_equivalence(
            uri,
            &document.source,
            &document.analysis.cst,
            &candidate_source,
            &candidate_analysis.cst,
        )?;
        edits
            .into_iter()
            .map(|edit| {
                Ok(json!({
                    "range": lsp_range(&document.source, edit.range).ok_or_else(|| {
                        RequestError::invalid("formatter edit range is not representable in UTF-16")
                    })?,
                    "newText": edit.replacement,
                }))
            })
            .collect::<RequestResult<Vec<_>>>()
            .map(Value::Array)
    }

    fn prepare_rename(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let Some((token, name)) = rms_navigation::name_at(document, offset) else {
            return Ok(Value::Null);
        };
        if !is_rename_candidate(&name) {
            return Ok(Value::Null);
        }
        self.rms_rename_plan(uri, document, &name)
            .map_err(RequestError::unavailable)?;
        Ok(json!({
            "range": lsp_range(&document.source, token.range),
            "placeholder": name,
        }))
    }

    fn rename(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let new_name = string_field(params, "newName")?;
        if !valid_identifier(new_name) {
            return Err(RequestError::invalid(
                "newName is not a valid RMS identifier",
            ));
        }
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let (_, old_name) = rms_navigation::name_at(document, offset)
            .ok_or_else(|| RequestError::invalid("rename position is not on an identifier"))?;
        if !is_rename_candidate(&old_name) {
            return Err(RequestError::unavailable(
                "rename is unavailable because this token may change RMS behavior",
            ));
        }
        let plan = self
            .rms_rename_plan(uri, document, &old_name)
            .map_err(RequestError::unavailable)?;
        if new_name != old_name {
            if !is_rename_candidate(new_name) {
                return Err(RequestError::unavailable(format!(
                    "'{new_name}' is an RMS command or keyword, so it cannot be a name."
                )));
            }
            if self.vocabulary().contains_key(new_name) {
                return Err(RequestError::unavailable(format!(
                    "'{new_name}' is defined by the game; choose another name."
                )));
            }
            if rms_engine::LOBBY_LABELS.contains(&new_name)
                || self.run_setting_labels().contains_key(new_name)
            {
                return Err(RequestError::unavailable(format!(
                    "'{new_name}' is set by the run settings; choose another name."
                )));
            }
            if let Some((used, _)) = plan
                .scope
                .iter()
                .find(|(_, member)| !rms_navigation::occurrences(member, new_name).is_empty())
            {
                return Err(RequestError::unavailable(format!(
                    "'{new_name}' is already used in {}; choose another name.",
                    include_file_name(used)
                )));
            }
        }
        let mut renamed = BTreeMap::new();
        let mut changes = Map::new();
        for (file_uri, file) in &plan.files {
            let occurrences = rms_navigation::occurrences(file, &old_name);
            let candidate = replace_tokens(file.source.bytes(), &occurrences, new_name.as_bytes());
            let candidate_text = String::from_utf8(candidate)
                .map_err(|_| RequestError::invalid("renamed document is not UTF-8"))?;
            renamed.insert(
                file_uri.clone(),
                source_from_text(file_uri, &candidate_text)?,
            );
            let edits = occurrences
                .iter()
                .map(|token| {
                    Ok(json!({
                        "range": lsp_range(&file.source, token.range).ok_or_else(|| {
                            RequestError::invalid("rename range is not representable in UTF-16")
                        })?,
                        "newText": new_name,
                    }))
                })
                .collect::<RequestResult<Vec<_>>>()?;
            changes.insert(file_uri.clone(), Value::Array(edits));
        }
        self.require_rename_equivalence(uri, &plan.entries, &renamed)?;
        Ok(json!({ "changes": changes }))
    }

    fn semantic_identity(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        let required_catalog = params.get("requiredSourceCatalog");
        if let Some(required_catalog) = required_catalog {
            let catalog = self
                .source_catalog
                .as_ref()
                .filter(|catalog| is_catalog_entry(catalog, uri))
                .ok_or_else(|| {
                    RequestError::unavailable("the current include graph is unavailable")
                })?;
            let version = required(required_catalog, "documentVersion")?
                .as_i64()
                .ok_or_else(|| RequestError::invalid("the required document version is invalid"))?;
            let current_entry =
                catalog_entry(catalog).map_err(|error| RequestError::invalid(error.to_string()))?;
            let current_source = SourceText::from_bytes(
                current_entry.source_id.clone(),
                current_entry.bytes.to_vec(),
            )
            .map_err(|error| RequestError::invalid(error.to_string()))?;
            let current_text = current_source
                .text()
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            let document_text = document
                .source
                .text()
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            if version != document.version
                || current_text != document_text
                || string_field(required_catalog, "catalogHash")? != hex(&catalog.catalog_hash())
                || string_field(required_catalog, "sourceGraphHash")?
                    != hex(&catalog.rms_graph_hash())
                || string_field(required_catalog, "externalAssetHash")?
                    != hex(&catalog.asset_graph_hash())
            {
                return Err(RequestError::unavailable(
                    "the current include graph changed; run again",
                ));
            }
        }
        let strict_options = params
            .get("previewContext")
            .map(preview_context_from_json)
            .transpose()?
            .unwrap_or_else(|| self.preview_context.clone())
            .strict_options(self.source_catalog.as_ref())?;
        let effective_catalog = self
            .source_catalog
            .as_ref()
            .filter(|catalog| is_catalog_entry(catalog, uri))
            .map(|catalog| {
                if required_catalog.is_some() {
                    Ok(catalog.clone())
                } else {
                    catalog_with_entry_override(catalog, Some(&document.source), document.version)
                }
            })
            .transpose()?;
        let program = if let Some(catalog) = &effective_catalog {
            self.analyze_catalog_cached(catalog, strict_options.clone())
                .map_err(|error| {
                    strict_semantic_unavailable(error, |id| catalog_source_bytes(catalog, id))
                })?
        } else {
            self.semantic_program_with_options(uri, Some(document.source.clone()), strict_options)?
        };
        let operations = program
            .operations
            .iter()
            .map(|operation| {
                let include_chain = operation
                    .presentation_include_chain(&program.identity.entry_source)
                    .into_iter()
                    .map(|source| source.as_str())
                    .collect::<Vec<_>>();
                json!({
                    "sourceId": operation.source_id.as_str(),
                    "byteStart": operation.source_range.start.0,
                    "byteEnd": operation.source_range.end.0,
                    "operationIdentity": hex(&operation.identity),
                    "includeChain": include_chain,
                    "displayName": operation.name.replace('_', " "),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "documentRevision": effective_catalog.as_ref().map_or_else(
                || hex(&document.analysis.document_revision),
                |catalog| hex(&catalog.rms_graph_hash()),
            ),
            "semanticHash": hex(&program.identity.semantic_hash),
            "exactGenerationEligibility": exact_generation_eligibility(&program),
            "profileId": program.identity.profile.profile_id,
            "sourceCatalogHash": effective_catalog.as_ref().map(|catalog| hex(&catalog.catalog_hash())),
            "sourceGraphHash": effective_catalog.as_ref().map(|catalog| hex(&catalog.rms_graph_hash())),
            "externalAssetHash": effective_catalog.as_ref().map(|catalog| hex(&catalog.asset_graph_hash())),
            "operations": operations,
        }))
    }

    fn require_rename_equivalence(
        &self,
        uri: &str,
        entries: &[String],
        renamed: &BTreeMap<String, SourceText>,
    ) -> RequestResult<()> {
        let options = self
            .preview_context
            .strict_options(self.source_catalog.as_ref())?;
        for entry in entries {
            let previous =
                self.semantic_program_with_sources(entry, &BTreeMap::new(), options.clone())?;
            let next = self.semantic_program_with_sources(entry, renamed, options.clone())?;
            if !matches!(
                compare_semantics(&previous, &next),
                SemanticEquivalence::Equal { .. }
            ) {
                return Err(RequestError::unavailable(if entry == uri {
                    "rename is unavailable because it could change what the script generates"
                        .to_owned()
                } else {
                    format!(
                        "rename is unavailable because it could change what {} generates",
                        include_file_name(entry)
                    )
                }));
            }
        }
        Ok(())
    }

    fn semantic_program_with_sources(
        &self,
        entry_uri: &str,
        renamed: &BTreeMap<String, SourceText>,
        strict_options: StrictParseOptions,
    ) -> RequestResult<SemanticProgram> {
        let current = |uri: &str| {
            renamed
                .get(uri)
                .or_else(|| self.documents.get(uri).map(|document| &document.source))
        };
        if let Some(catalog) = self
            .source_catalog
            .as_ref()
            .filter(|catalog| is_catalog_entry(catalog, entry_uri))
        {
            let catalog = catalog_with_sources(catalog, |uri| {
                let version = self
                    .documents
                    .get(uri)
                    .map_or(0, |document| document.version);
                current(uri).map(|source| (source, version))
            })?;
            return self
                .analyze_catalog_cached(&catalog, strict_options)
                .map_err(|error| {
                    strict_semantic_unavailable(error, |id| catalog_source_bytes(&catalog, id))
                });
        }
        let entry = current(entry_uri)
            .cloned()
            .ok_or_else(|| RequestError::invalid("document is not open"))?;
        let resolver = self.open_document_resolver(current)?;
        let entry_bytes: Arc<[u8]> = Arc::from(entry.bytes());
        parse_strict(entry_uri, entry, &resolver, strict_options)
            .map(SemanticProgram::from_parsed)
            .map_err(|error| {
                strict_semantic_unavailable(error, |id| {
                    if id.as_str() == entry_uri {
                        Some(entry_bytes.clone())
                    } else {
                        current(id.as_str()).map(|source| Arc::from(source.bytes()))
                    }
                })
            })
    }

    fn require_formatting_equivalence(
        &self,
        uri: &str,
        previous_source: &SourceText,
        previous_cst: &rms_syntax::CstDocument,
        next_source: &SourceText,
        next_cst: &rms_syntax::CstDocument,
    ) -> RequestResult<()> {
        match (
            self.semantic_program(uri, Some(previous_source.clone())),
            self.semantic_program(uri, Some(next_source.clone())),
        ) {
            (Ok(previous), Ok(next))
                if matches!(
                    compare_semantics(&previous, &next),
                    SemanticEquivalence::Equal { .. }
                ) =>
            {
                Ok(())
            }
            (Err(previous_error), Err(next_error))
                if previous_error.code == next_error.code
                    && previous_error.message == next_error.message
                    && previous_error.message.contains("include was not found")
                    && previous_error.message.contains("(RMS2021)")
                    && formatting_structure_is_equivalent(
                        previous_source,
                        previous_cst,
                        next_source,
                        next_cst,
                    ) =>
            {
                Ok(())
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Err(RequestError::unavailable(
                "formatting is unavailable because it could change what the script generates",
            )),
        }
    }

    fn semantic_program(
        &self,
        entry_uri: &str,
        override_source: Option<SourceText>,
    ) -> RequestResult<SemanticProgram> {
        self.semantic_program_with_options(
            entry_uri,
            override_source,
            self.preview_context
                .strict_options(self.source_catalog.as_ref())?,
        )
    }

    fn semantic_program_with_options(
        &self,
        entry_uri: &str,
        override_source: Option<SourceText>,
        strict_options: StrictParseOptions,
    ) -> RequestResult<SemanticProgram> {
        if let Some(catalog) = self
            .source_catalog
            .as_ref()
            .filter(|catalog| is_catalog_entry(catalog, entry_uri))
        {
            let catalog = catalog_with_entry_override(
                catalog,
                override_source.as_ref(),
                self.documents
                    .get(entry_uri)
                    .map_or(0, |document| document.version),
            )?;
            return self
                .analyze_catalog_cached(&catalog, strict_options)
                .map_err(|error| {
                    strict_semantic_unavailable(error, |id| catalog_source_bytes(&catalog, id))
                });
        }
        let current = |uri: &str| {
            let document = self.documents.get(uri)?;
            Some(
                override_source
                    .as_ref()
                    .filter(|_| uri == entry_uri)
                    .unwrap_or(&document.source),
            )
        };
        let entry = current(entry_uri)
            .cloned()
            .ok_or_else(|| RequestError::invalid("document is not open"))?;
        let resolver = self.open_document_resolver(current)?;
        let entry_bytes: Arc<[u8]> = Arc::from(entry.bytes());
        parse_strict(entry_uri, entry, &resolver, strict_options)
            .map(SemanticProgram::from_parsed)
            .map_err(|error| {
                strict_semantic_unavailable(error, |id| {
                    if id.as_str() == entry_uri {
                        Some(entry_bytes.clone())
                    } else {
                        self.documents
                            .get(id.as_str())
                            .map(|document| Arc::from(document.source.bytes()))
                    }
                })
            })
    }

    fn open_document_resolver<'a>(
        &'a self,
        current: impl Fn(&str) -> Option<&'a SourceText>,
    ) -> RequestResult<VirtualSourceResolver> {
        let mut sources = self
            .documents
            .keys()
            .filter_map(|uri| Some((uri, current(uri)?)))
            .map(|(uri, source)| {
                VirtualSource::new(uri.clone(), source.clone())
                    .map_err(|error| RequestError::invalid(error.to_string()))
            })
            .collect::<RequestResult<Vec<_>>>()?;
        let mut xs_resolver = None;
        let mut placed = BTreeSet::new();
        for (uri, document) in &self.documents {
            for include in include_syntax(document)
                .into_iter()
                .filter(|include| include.external_xs)
            {
                let (Ok(path), Some((folder, _))) = (
                    IncludePath::new(include.path.as_str()),
                    uri.rsplit_once('/'),
                ) else {
                    continue;
                };
                let place = format!("{folder}/{}", path.as_str());
                if !placed.insert(place.to_ascii_lowercase()) {
                    continue;
                }
                let Some(file) = xs_resolver
                    .get_or_insert_with(|| xs::WorkspaceResolver::new(&self.xs))
                    .resolve_path(uri, &include.path)
                else {
                    continue;
                };
                sources.push(
                    VirtualSource::external_xs(place, file.source.clone())
                        .map_err(|error| RequestError::invalid(error.to_string()))?,
                );
            }
        }
        VirtualSourceResolver::new(sources, ResolverRoots::default(), false)
            .map_err(|error| RequestError::invalid(error.to_string()))
    }

    fn decision_range_in(
        &self,
        uri: &str,
        source: &SourceText,
        decision: &ParsedDecision,
    ) -> Value {
        if decision.source_id.as_str() == uri {
            lsp_range(source, decision.source_range).unwrap_or_else(empty_range)
        } else {
            empty_range()
        }
    }

    fn decision_anchor(&self, decision: &ParsedDecision) -> Value {
        let source_uri = decision.source_id.as_str();
        let range = self
            .generation_source(source_uri)
            .and_then(|source| lsp_range(&source, decision.source_range));
        json!({
            "rmsSourceUri": source_uri,
            "rmsSourceRange": range,
        })
    }

    fn generation_source(&self, uri: &str) -> Option<SourceText> {
        self.documents
            .get(uri)
            .map(|document| document.source.clone())
            .or_else(|| {
                let source = self
                    .source_catalog
                    .as_ref()?
                    .sources()
                    .iter()
                    .find(|source| source.source_id.as_str() == uri)?;
                if let Some(document) = self.catalog_documents.get(uri)
                    && self.editor_sources().is_some_and(|view| {
                        view.sources().iter().any(|editor| {
                            editor.source_id == source.source_id
                                && editor.raw_hash == source.raw_hash
                        })
                    })
                {
                    return Some(document.source.clone());
                }
                SourceText::from_bytes(source.source_id.clone(), source.bytes.clone()).ok()
            })
    }

    fn update_rms_document(
        &mut self,
        uri: String,
        version: i64,
        text: &str,
        edit: bool,
    ) -> RequestResult<Notified> {
        let previous_links = self
            .documents
            .get(&uri)
            .map(|document| include_xs_paths(document))
            .unwrap_or_default();
        self.insert_document(uri.clone(), version, text)?;
        let links = self
            .documents
            .get(&uri)
            .map(|document| include_xs_paths(document))
            .unwrap_or_default();
        let immediate = if links != previous_links {
            self.publish_xs_diagnostics(None, false)
        } else {
            Vec::new()
        };
        Ok(if edit {
            Notified {
                immediate,
                analyze: vec![uri],
                ..Notified::default()
            }
        } else {
            Notified {
                publish: vec![uri],
                immediate,
                ..Notified::default()
            }
        })
    }

    fn retained_bytes(&self, replacing: &str) -> usize {
        self.documents
            .iter()
            .filter(|(key, _)| key.as_str() != replacing)
            .map(|(_, document)| document.source.bytes().len())
            .chain(
                self.xs
                    .documents
                    .iter()
                    .filter(|(key, _)| key.as_str() != replacing)
                    .map(|(_, document)| document.file.source.bytes().len()),
            )
            .sum()
    }

    fn insert_xs_document(&mut self, uri: String, version: i64, text: &str) -> RequestResult<()> {
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(RequestError::invalid("document exceeds the 16 MiB bound"));
        }
        if self.retained_bytes(&uri).saturating_add(text.len()) > MAX_TOTAL_DOCUMENT_BYTES {
            return Err(RequestError::unavailable(
                "open documents exceed their 64 MiB total bound",
            ));
        }
        let file = xs::source_for(&uri, text)?;
        self.xs
            .documents
            .insert(uri, xs::XsDocument { version, file });
        Ok(())
    }

    fn xs_context(&self) -> xs::XsContext {
        let listing = |(uri, document): (&String, &OpenDocument)| {
            let names = include_xs_paths(document);
            (!names.is_empty()).then(|| (uri.to_owned(), names))
        };
        let mut links = self
            .documents
            .iter()
            .filter_map(|(uri, document)| listing((uri, document.as_ref())))
            .collect::<Vec<_>>();
        let first_closed_link = links.len();
        links.extend(
            self.catalog_documents
                .peek()
                .iter()
                .filter(|(uri, _)| !self.documents.contains_key(*uri))
                .filter_map(|(uri, document)| listing((uri, document.as_ref()))),
        );
        xs::XsContext {
            links,
            build: self.xs_build(),
            first_closed_link,
        }
    }

    fn note_xs_listings(&mut self) {
        let links = if self.xs.documents.is_empty() && self.xs.catalog_files.is_empty() {
            Vec::new()
        } else {
            self.xs_context().links
        };
        self.xs.note_listings(&links);
    }

    fn xs_build(&self) -> Option<xs_analysis::XsBuild> {
        self.xs.build_override.or_else(|| {
            self.editor_selection()
                .and_then(|catalog| xs_analysis::XsBuild::from_profile_id(catalog.profile_id()))
        })
    }

    fn publish_xs_diagnostics(&mut self, changed: Option<&str>, all: bool) -> Vec<Value> {
        if self.xs.documents.is_empty() {
            self.xs.forget_closed();
            return Vec::new();
        }
        let context = self.xs_context();
        let closed_files_visible = self.editor_inventory_current();
        xs::publish_diagnostics(&mut self.xs, &context, changed, all, closed_files_visible)
    }

    fn is_xs_request(&self, params: &Value) -> bool {
        text_document_uri(params).is_ok_and(|uri| self.xs.documents.contains_key(uri))
    }

    fn xs_request(&mut self, method: &str, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?.to_owned();
        let context = self.xs_context();
        match method {
            "textDocument/completion" => xs::completion(&self.xs, &uri, params, &context),
            "textDocument/signatureHelp" => {
                xs::signature_help_response(&self.xs, &uri, params, &context)
            }
            "textDocument/hover" => {
                xs::hover_response(&self.xs, &uri, params, &context, &|source, link| {
                    self.include_hover(source, link)
                })
            }
            "textDocument/definition" => xs::definition_response(&self.xs, &uri, params, &context),
            "textDocument/documentLink" => {
                let (file, links) = xs::include_links(&self.xs, &uri, &context)
                    .ok_or_else(|| RequestError::invalid("document is not open"))?;
                Ok(self.include_links_json(&file.source, &links))
            }
            "textDocument/references" => xs::references_response(&self.xs, &uri, params, &context),
            "textDocument/documentHighlight" => {
                xs::document_highlight_response(&self.xs, &uri, params, &context)
            }
            "textDocument/documentSymbol" => xs::document_symbols(&self.xs, &uri),
            "textDocument/foldingRange" => xs::folding_ranges(&self.xs, &uri),
            "textDocument/semanticTokens/full" => {
                xs::semantic_tokens_response(&self.xs, &uri, &context)
            }
            "textDocument/formatting" => xs::formatting_response(&self.xs, &uri, params),
            "textDocument/codeAction" => xs::code_actions(&self.xs, &uri, params, &context),
            "textDocument/inlayHint" => xs::inlay_hints_response(&self.xs, &uri, params, &context),
            "textDocument/prepareRename" => xs::prepare_rename(&self.xs, &uri, params, &context),
            "textDocument/rename" => xs::rename(&self.xs, &uri, params, &context),
            "rms/semanticIdentity" => Err(RequestError::invalid(
                "semantic identity is defined for RMS documents only",
            )),
            _ => Err(RequestError {
                code: -32601,
                message: "method not found".to_owned(),
            }),
        }
    }

    fn document(&self, uri: &str) -> RequestResult<&OpenDocument> {
        self.documents
            .get(uri)
            .map(Arc::as_ref)
            .ok_or_else(|| RequestError::invalid("document is not open"))
    }

    fn analysis_documents(&self) -> Vec<(&str, &OpenDocument)> {
        self.documents
            .iter()
            .map(|(uri, document)| (uri.as_str(), document.as_ref()))
            .chain(
                self.catalog_documents
                    .iter()
                    .filter(|(uri, _)| !self.documents.contains_key(*uri))
                    .map(|(uri, document)| (uri.as_str(), document.as_ref())),
            )
            .collect()
    }

    fn analyze_catalog_cached(
        &self,
        catalog: &SourceCatalog,
        options: StrictParseOptions,
    ) -> Result<SemanticProgram, StrictParseError> {
        self.analyze_catalog_shared(catalog, options)
            .map(|program| (*program).clone())
    }

    fn analyze_catalog_shared(
        &self,
        catalog: &SourceCatalog,
        options: StrictParseOptions,
    ) -> Result<Arc<SemanticProgram>, StrictParseError> {
        let catalog_hash = catalog.catalog_hash();
        let cached = |cache: &VecDeque<CachedSemanticAnalysis>| {
            cache
                .iter()
                .find(|entry| entry.catalog_hash == catalog_hash && entry.options == options)
                .map(|entry| entry.result.clone())
        };
        if let Some(result) = cached(&lock(&self.semantic_cache)) {
            return result;
        }
        let result = analyze_semantics_catalog(catalog, options.clone()).map(Arc::new);
        let mut cache = lock(&self.semantic_cache);
        if let Some(result) = cached(&cache) {
            return result;
        }
        cache.push_back(CachedSemanticAnalysis {
            catalog_hash,
            options,
            result: result.clone(),
        });
        while cache.len() > MAX_SEMANTIC_CACHE_ENTRIES {
            cache.pop_front();
        }
        result
    }
}

impl Server {
    pub(crate) fn analysis_view(&self) -> Server {
        Server {
            initialized: self.initialized,
            shutdown_requested: self.shutdown_requested,
            documents: self.documents.clone(),
            source_catalog: self.source_catalog.clone(),
            catalog_documents: self.catalog_documents.clone(),
            editor: self.editor.analysis_view(),
            dependency_graph: self.dependency_graph.clone(),
            cancelled_requests: VecDeque::new(),
            preview_context: self.preview_context.clone(),
            semantic_cache: self.semantic_cache.clone(),
            effective_catalog: self.effective_catalog.clone(),
            xs: self.xs.analysis_view(),
            lint_disabled: self.lint_disabled.clone(),
            revision: self.revision,
        }
    }

    fn effective_catalog(
        &self,
        catalog: &SourceCatalog,
        document: &OpenDocument,
    ) -> RequestResult<SourceCatalog> {
        let base_hash = catalog.catalog_hash();
        if let Some(cached) = lock(&self.effective_catalog).as_ref()
            && cached.base_hash == base_hash
            && cached.version == document.version
            && catalog_entry(&cached.catalog)
                .is_ok_and(|entry| *entry.bytes == *document.source.bytes())
        {
            return Ok(cached.catalog.clone());
        }
        let effective =
            catalog_with_entry_override(catalog, Some(&document.source), document.version)?;
        *lock(&self.effective_catalog) = Some(EffectiveCatalog {
            base_hash,
            version: document.version,
            catalog: effective.clone(),
        });
        Ok(effective)
    }
}

fn strict_semantic_unavailable(
    error: StrictParseError,
    source_bytes: impl Fn(&SourceId) -> Option<Arc<[u8]>>,
) -> RequestError {
    let file = error.source_chain.last();
    let source = file
        .map(|source| format!(" in {}", source.as_str()))
        .unwrap_or_default();
    let location = file
        .zip(error.range)
        .and_then(|(file, range)| line_at(&source_bytes(file)?, range.start.0))
        .map(|line| format!(" at line {line}"))
        .unwrap_or_default();
    RequestError::unavailable(format!(
        "the script could not be analyzed{source}{location}: {} ({})",
        error.message, error.code
    ))
}

fn line_at(bytes: &[u8], offset: u32) -> Option<usize> {
    let end = usize::try_from(offset).ok()?;
    let before = bytes.get(..end)?;
    Some(1 + before.iter().filter(|byte| **byte == b'\n').count())
}

fn catalog_source_bytes(catalog: &SourceCatalog, id: &SourceId) -> Option<Arc<[u8]>> {
    catalog
        .sources()
        .iter()
        .find(|source| source.source_id == *id)
        .map(|source| source.bytes.clone())
}

fn exact_generation_eligibility(program: &SemanticProgram) -> Value {
    match validate_exact_semantic_scope(program) {
        Ok(()) => json!({ "supported": true }),
        Err(error) => json!({
            "supported": false,
            "code": "RMSGEN1009",
            "reason": error.to_string(),
        }),
    }
}

fn catalog_entry(catalog: &SourceCatalog) -> Result<&CatalogSource, SourceCatalogError> {
    let entry = catalog
        .sources()
        .iter()
        .find(|source| source.path == catalog.entry_path())
        .ok_or(SourceCatalogError::InvalidEntry)?;
    SourceText::validate_bytes(&entry.bytes)
        .map_err(|error| SourceCatalogError::InvalidSource(error.to_string()))?;
    Ok(entry)
}

fn is_catalog_entry(catalog: &SourceCatalog, uri: &str) -> bool {
    catalog
        .sources()
        .iter()
        .find(|source| source.path == catalog.entry_path())
        .is_some_and(|entry| entry.source_id.as_str() == uri)
        && catalog_entry(catalog).is_ok()
}

fn catalog_with_entry_override(
    catalog: &SourceCatalog,
    override_source: Option<&SourceText>,
    version: i64,
) -> RequestResult<SourceCatalog> {
    let Some(override_source) = override_source else {
        return Ok(catalog.clone());
    };
    let current =
        catalog_entry(catalog).map_err(|error| RequestError::invalid(error.to_string()))?;
    if *current.bytes == *override_source.bytes() {
        return Ok(catalog.clone());
    }
    let mut sources = catalog.sources().to_vec();
    let entry = sources
        .iter_mut()
        .find(|source| source.path == catalog.entry_path())
        .ok_or_else(|| RequestError::invalid("source catalog entry is missing"))?;
    *entry = CatalogSource::new(
        entry.path.clone(),
        override_source.id().clone(),
        override_source.bytes().to_vec(),
        SourceCatalogOrigin::DirtyBuffer,
        SourceCatalogRole::RmsEntry,
        Some(version.max(0) as u64),
    )
    .map_err(|error| RequestError::invalid(error.to_string()))?;
    SourceCatalog::build(
        catalog.version(),
        catalog.revision(),
        catalog.entry_path(),
        sources,
        catalog.roots().clone(),
        catalog.case_sensitive(),
        catalog.profile_id(),
        catalog.content_identity(),
        catalog.implicit_definitions().clone(),
    )
    .map_err(|error| RequestError::invalid(error.to_string()))
}

fn catalog_with_sources<'s>(
    catalog: &SourceCatalog,
    replacement: impl Fn(&str) -> Option<(&'s SourceText, i64)>,
) -> RequestResult<SourceCatalog> {
    let mut changed = false;
    let mut sources = catalog.sources().to_vec();
    for source in &mut sources {
        if source.role == SourceCatalogRole::ExternalXs {
            continue;
        }
        let Some((text, version)) = replacement(source.source_id.as_str()) else {
            continue;
        };
        if *source.bytes == *text.bytes() {
            continue;
        }
        *source = CatalogSource::new(
            source.path.clone(),
            source.source_id.clone(),
            text.bytes().to_vec(),
            SourceCatalogOrigin::DirtyBuffer,
            source.role,
            Some(version.max(0) as u64),
        )
        .map_err(|error| RequestError::invalid(error.to_string()))?;
        changed = true;
    }
    if !changed {
        return Ok(catalog.clone());
    }
    SourceCatalog::build(
        catalog.version(),
        catalog.revision(),
        catalog.entry_path(),
        sources,
        catalog.roots().clone(),
        catalog.case_sensitive(),
        catalog.profile_id(),
        catalog.content_identity(),
        catalog.implicit_definitions().clone(),
    )
    .map_err(|error| RequestError::invalid(error.to_string()))
}

fn changed_catalog_sources(
    previous: Option<&SourceCatalog>,
    next: &SourceCatalog,
) -> BTreeSet<SourceId> {
    let Some(previous) = previous else {
        return next
            .sources()
            .iter()
            .map(|source| source.source_id.clone())
            .collect();
    };
    let previous_sources = previous
        .sources()
        .iter()
        .map(|source| (source.source_id.clone(), source.raw_hash))
        .collect::<BTreeMap<_, _>>();
    let next_sources = next
        .sources()
        .iter()
        .map(|source| (source.source_id.clone(), source.raw_hash))
        .collect::<BTreeMap<_, _>>();
    let mut changed = previous_sources
        .keys()
        .chain(next_sources.keys())
        .filter(|source| previous_sources.get(*source) != next_sources.get(*source))
        .cloned()
        .collect::<BTreeSet<_>>();
    if changed.is_empty()
        && previous.catalog_hash() != next.catalog_hash()
        && let Ok(entry) = catalog_entry(next)
    {
        changed.insert(entry.source_id.clone());
    }
    changed
}

fn catalog_source_from_json(source: &Value, bytes: Arc<[u8]>) -> RequestResult<CatalogSource> {
    let origin = match string_field(source, "origin")? {
        "workspace" => SourceCatalogOrigin::Workspace,
        "dirty-buffer" => SourceCatalogOrigin::DirtyBuffer,
        "deployed-map" => SourceCatalogOrigin::DeployedMap,
        "game-data" => SourceCatalogOrigin::GameData,
        "implicit-environment" => SourceCatalogOrigin::ImplicitEnvironment,
        _ => return Err(RequestError::invalid("source origin is invalid")),
    };
    let role = match string_field(source, "role")? {
        "rms-entry" => SourceCatalogRole::RmsEntry,
        "rms-dependency" => SourceCatalogRole::RmsDependency,
        "external-xs" => SourceCatalogRole::ExternalXs,
        _ => return Err(RequestError::invalid("source role is invalid")),
    };
    Ok(CatalogSource {
        path: string_field(source, "normalizedPath")?.to_owned(),
        source_id: SourceId::new(string_field(source, "sourceId")?.to_owned())
            .map_err(|error| RequestError::invalid(error.to_string()))?,
        raw_hash: hash_field(source, "rawHash")?,
        bytes,
        origin,
        role,
        buffer_revision: optional_u64_field(source, "bufferRevision")?,
    })
}

fn source_catalog_from_json(value: &Value) -> RequestResult<SourceCatalog> {
    let version = required(value, "contractVersion")?;
    let roots = required(value, "roots")?;
    let sources = value
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| RequestError::invalid("source catalog sources must be an array"))?
        .iter()
        .map(|source| {
            catalog_source_from_json(
                source,
                decode_base64(string_field(source, "sourceBase64")?)?.into(),
            )
        })
        .collect::<RequestResult<Vec<_>>>()?;
    let opened_or_configured = roots
        .get("openedOrConfigured")
        .and_then(Value::as_array)
        .ok_or_else(|| RequestError::invalid("source catalog opened roots must be an array"))?
        .iter()
        .map(|root| {
            root.as_str()
                .map(str::to_owned)
                .ok_or_else(|| RequestError::invalid("source catalog root is invalid"))
        })
        .collect::<RequestResult<Vec<_>>>()?;
    let implicit_definitions = value
        .get("implicitDefinitions")
        .and_then(Value::as_object)
        .ok_or_else(|| RequestError::invalid("source catalog implicit definitions are invalid"))?
        .iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.clone(), value.to_owned()))
                .ok_or_else(|| {
                    RequestError::invalid("source catalog implicit definition is invalid")
                })
        })
        .collect::<RequestResult<BTreeMap<_, _>>>()?;
    SourceCatalog::from_parts(SourceCatalogParts {
        version: SourceCatalogVersion {
            major: json_u32(required(version, "major")?)?,
            minor: json_u32(required(version, "minor")?)?,
            patch: json_u32(required(version, "patch")?)?,
        },
        revision: json_u64(required(value, "revision")?)?,
        entry_path: string_field(value, "entryPath")?.to_owned(),
        sources,
        roots: ResolverRoots {
            opened_or_configured,
            deployed_map_context: optional_string_field(roots, "deployedMapContext")?,
            game_gamedata_x2: optional_string_field(roots, "gameGamedataX2")?,
            implicit_environment: optional_string_field(roots, "implicitEnvironment")?,
            game_xs: optional_string_field(roots, "gameXs")?,
            standard_includes: standard_include_access(roots)?,
        },
        case_sensitive: value
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .ok_or_else(|| RequestError::invalid("source catalog case policy is invalid"))?,
        profile_id: string_field(value, "profileId")?.to_owned(),
        content_identity: string_field(value, "contentIdentity")?.to_owned(),
        implicit_definitions,
        implicit_environment_hash: hash_field(value, "implicitEnvironmentHash")?,
        catalog_hash: hash_field(value, "catalogHash")?,
        rms_graph_hash: hash_field(value, "rmsGraphHash")?,
        asset_graph_hash: hash_field(value, "externalAssetHash")?,
    })
    .map_err(|error| RequestError::invalid(error.to_string()))
}

fn preview_context_from_json(value: &Value) -> RequestResult<PreviewContext> {
    let version = required(value, "contractVersion")?;
    let players = value
        .get("players")
        .and_then(Value::as_array)
        .ok_or_else(|| RequestError::invalid("preview context players must be an array"))?
        .iter()
        .map(|player| {
            let slot = u8::try_from(unsigned_field(player, "slot")?)
                .map_err(|_| RequestError::invalid("preview player slot is out of range"))?;
            let color = match player.get("color") {
                None | Some(Value::Null) => slot.saturating_sub(1),
                Some(_) => u8::try_from(unsigned_field(player, "color")?)
                    .ok()
                    .filter(|color| usize::from(*color) < rms_engine::MAXIMUM_PLAYERS)
                    .ok_or_else(|| RequestError::invalid("preview player color is out of range"))?,
            };
            Ok(PlayerConfiguration {
                slot,
                team: u8::try_from(unsigned_field(player, "team")?)
                    .map_err(|_| RequestError::invalid("preview player team is out of range"))?,
                civilization_id: CivilizationId(
                    u32::try_from(unsigned_field(player, "civilizationId")?).map_err(|_| {
                        RequestError::invalid("preview player civilization is out of range")
                    })?,
                ),
                color,
            })
        })
        .collect::<RequestResult<Vec<_>>>()?;
    let game_mode = match string_field(value, "gameMode")? {
        "random-map" => GameMode::RandomMap,
        "regicide" => GameMode::Regicide,
        "death-match" => GameMode::DeathMatch,
        "king-of-the-hill" => GameMode::KingOfTheHill,
        "wonder-race" => GameMode::WonderRace,
        "defend-the-wonder" => GameMode::DefendTheWonder,
        "turbo-random-map" => GameMode::TurboRandomMap,
        "capture-the-relic" => GameMode::CaptureTheRelic,
        "sudden-death" => GameMode::SuddenDeath,
        "battle-royale" => GameMode::BattleRoyale,
        "empire-wars" => GameMode::EmpireWars,
        _ => return Err(RequestError::invalid("preview game mode is unsupported")),
    };
    let starting_resources = match string_field(value, "startingResources")? {
        "standard" => StartingResourcePolicy::Standard,
        "low" => StartingResourcePolicy::Low,
        "medium" => StartingResourcePolicy::Medium,
        "high" => StartingResourcePolicy::High,
        "ultra-high" => StartingResourcePolicy::UltraHigh,
        "infinite" => StartingResourcePolicy::Infinite,
        "random" => StartingResourcePolicy::Random,
        _ => {
            return Err(RequestError::invalid(
                "preview starting resources are unsupported",
            ));
        }
    };
    let starting_age = match string_field(value, "startingAge")? {
        "standard" => StartingAge::Standard,
        "dark-age" => StartingAge::DarkAge,
        "feudal-age" => StartingAge::FeudalAge,
        "castle-age" => StartingAge::CastleAge,
        "imperial-age" => StartingAge::ImperialAge,
        "post-imperial-age" => StartingAge::PostImperialAge,
        _ => return Err(RequestError::invalid("preview starting age is unsupported")),
    };
    let position_policy = match string_field(value, "positionPolicy")? {
        "random" => PositionPolicy::Random,
        "fixed" => PositionPolicy::Fixed,
        "team-together" => PositionPolicy::TeamTogether,
        _ => {
            return Err(RequestError::invalid(
                "preview position policy is unsupported",
            ));
        }
    };
    let computer_player_slots = match value.get("computerPlayerSlots") {
        None => ComputerPlayerSlots::default(),
        Some(Value::Array(values)) => ComputerPlayerSlots::from_slots(
            &values
                .iter()
                .map(|slot| {
                    slot.as_u64()
                        .and_then(|slot| u8::try_from(slot).ok())
                        .ok_or_else(|| {
                            RequestError::invalid("preview computer player slot is out of range")
                        })
                })
                .collect::<RequestResult<Vec<_>>>()?,
        )
        .map_err(RequestError::invalid)?,
        Some(_) => {
            return Err(RequestError::invalid(
                "preview computerPlayerSlots must be an array",
            ));
        }
    };
    let lobby_options = serde_json::from_value::<LobbyOptions>(value.clone())
        .map_err(|error| RequestError::invalid(format!("preview lobby options: {error}")))?;
    let context = PreviewContext {
        setup: SetupContext {
            contract_version: SetupContextVersion {
                major: u32::try_from(unsigned_field(version, "major")?).map_err(|_| {
                    RequestError::invalid("preview context major version is out of range")
                })?,
                minor: u32::try_from(unsigned_field(version, "minor")?).map_err(|_| {
                    RequestError::invalid("preview context minor version is out of range")
                })?,
                patch: u32::try_from(unsigned_field(version, "patch")?).map_err(|_| {
                    RequestError::invalid("preview context patch version is out of range")
                })?,
            },
            game_mode,
            starting_resources,
            starting_age,
            position_policy,
            computer_player_slots,
            lobby_options,
        },
        seed: u32::try_from(unsigned_field(value, "seed")?)
            .map_err(|_| RequestError::invalid("preview seed is out of range"))?,
        dimensions: MapDimensions {
            width: u16::try_from(unsigned_field(value, "width")?)
                .map_err(|_| RequestError::invalid("preview width is out of range"))?,
            height: u16::try_from(unsigned_field(value, "height")?)
                .map_err(|_| RequestError::invalid("preview height is out of range"))?,
        },
        map_size: string_field(value, "mapSize")?.to_owned(),
        players,
    };
    context.strict_options(None)?;
    Ok(context)
}

fn standard_include_access(roots: &Value) -> RequestResult<StandardIncludeAccess> {
    let identifiers = match roots.get("standardIncludes") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value.as_str().map(str::to_owned).ok_or_else(|| {
                    RequestError::invalid("standard include identifier must be a string")
                })
            })
            .collect::<RequestResult<Vec<_>>>()?,
        Some(_) => {
            return Err(RequestError::invalid(
                "standardIncludes must be an array of strings",
            ));
        }
    };
    let authorized = match roots.get("standardIncludesAuthorized") {
        None | Some(Value::Null) => false,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| RequestError::invalid("standardIncludesAuthorized must be a boolean"))?,
    };
    Ok(StandardIncludeAccess {
        identifiers,
        authorized,
    })
}

fn optional_string_field(value: &Value, field: &str) -> RequestResult<Option<String>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| RequestError::invalid(format!("{field} must be a string"))),
    }
}

fn hash_field(value: &Value, field: &str) -> RequestResult<[u8; 32]> {
    let encoded = string_field(value, field)?;
    if encoded.len() != 64 {
        return Err(RequestError::invalid(format!(
            "{field} must be a SHA-256 hash"
        )));
    }
    let mut hash = [0_u8; 32];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        hash[index] = hex_nibble(pair[0])?
            .checked_mul(16)
            .and_then(|high| high.checked_add(hex_nibble(pair[1]).ok()?))
            .ok_or_else(|| RequestError::invalid(format!("{field} is invalid")))?;
    }
    Ok(hash)
}

fn hex_nibble(value: u8) -> RequestResult<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(RequestError::invalid(
            "hash contains a non-hexadecimal byte",
        )),
    }
}

fn decode_base64(value: &str) -> RequestResult<Vec<u8>> {
    if !value.len().is_multiple_of(4) || value.len() > 24 * 1024 * 1024 {
        return Err(RequestError::invalid(
            "source catalog base64 is invalid or unbounded",
        ));
    }
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    let chunks = value.as_bytes().chunks_exact(4);
    for (chunk_index, chunk) in chunks.enumerate() {
        let last = (chunk_index + 1) * 4 == value.len();
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c_padding = chunk[2] == b'=';
        let d_padding = chunk[3] == b'=';
        if c_padding && (!d_padding || !last) || d_padding && !last {
            return Err(RequestError::invalid(
                "source catalog base64 padding is invalid",
            ));
        }
        let c = if c_padding {
            0
        } else {
            base64_value(chunk[2])?
        };
        let d = if d_padding {
            0
        } else {
            base64_value(chunk[3])?
        };
        output.push((a << 2) | (b >> 4));
        if !c_padding {
            output.push((b << 4) | (c >> 2));
        }
        if !d_padding {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

fn base64_value(value: u8) -> RequestResult<u8> {
    match value {
        b'A'..=b'Z' => Ok(value - b'A'),
        b'a'..=b'z' => Ok(value - b'a' + 26),
        b'0'..=b'9' => Ok(value - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(RequestError::invalid(
            "source catalog base64 contains an invalid byte",
        )),
    }
}

fn json_u32(value: &Value) -> RequestResult<u32> {
    json_u64(value)?
        .try_into()
        .map_err(|_| RequestError::invalid("source catalog integer exceeds its bound"))
}

fn json_u64(value: &Value) -> RequestResult<u64> {
    value
        .as_u64()
        .ok_or_else(|| RequestError::invalid("source catalog integer is invalid"))
}

fn optional_u64_field(value: &Value, field: &str) -> RequestResult<Option<u64>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => json_u64(value).map(Some),
    }
}

fn source_file_name(source_id: &str) -> String {
    let segment = source_id
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(source_id);
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Some(byte) = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| segment.to_owned())
}

fn published_code_actions_json(
    ranges: impl Iterator<Item = Value>,
    actions: Vec<Vec<Value>>,
) -> Value {
    json!({
        "contract": PUBLISHED_CODE_ACTIONS_CONTRACT,
        "ranges": ranges
            .zip(actions)
            .map(|(range, actions)| json!({ "range": range, "actions": actions }))
            .collect::<Vec<_>>(),
    })
}

fn empty_range() -> Value {
    json!({
        "start": { "line": 0, "character": 0 },
        "end": { "line": 0, "character": 0 },
    })
}

fn initialize_result() -> Value {
    json!({
        "capabilities": {
            "positionEncoding": "utf-16",
            "textDocumentSync": { "openClose": true, "change": 1 },
            "completionProvider": { "triggerCharacters": ["#", "<", "_", " ", "/"], "resolveProvider": true },
            "signatureHelpProvider": { "triggerCharacters": [" ", "(", ","] },
            "hoverProvider": true,
            "definitionProvider": true,
            "documentLinkProvider": { "resolveProvider": false },
            "referencesProvider": true,
            "documentHighlightProvider": true,
            "documentSymbolProvider": true,
            "foldingRangeProvider": true,
            "workspaceSymbolProvider": true,
            "documentFormattingProvider": true,
            "renameProvider": { "prepareProvider": true },
            "codeActionProvider": { "codeActionKinds": ["quickfix"] },
            "inlayHintProvider": true,
            "semanticTokensProvider": {
                "legend": {
                    "tokenTypes": [
                        "comment", "keyword", "namespace", "function", "property",
                        "number", "string", "variable", "operator", "control"
                    ],
                    "tokenModifiers": []
                },
                "full": true
            },
            "experimental": { "sourceCatalogV1": true, "sourceCatalogDiscoveryV1": true, "sourceCatalogDiagnosticsV1": true, "editorInventoryV1": true, "xsLanguageV1": true }
        },
        "serverInfo": {
            "name": "rms-ls",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn text_document_uri(params: &Value) -> RequestResult<&str> {
    string_field(required(params, "textDocument")?, "uri")
}

fn request_position(params: &Value) -> RequestResult<(&str, Utf16Position)> {
    let uri = text_document_uri(params)?;
    let position = required(params, "position")?;
    let line = unsigned_field(position, "line")?;
    let character = unsigned_field(position, "character")?;
    Ok((
        uri,
        Utf16Position {
            line: u32::try_from(line).map_err(|_| RequestError::invalid("line is out of range"))?,
            character: u32::try_from(character)
                .map_err(|_| RequestError::invalid("character is out of range"))?,
        },
    ))
}

fn required<'a>(value: &'a Value, name: &str) -> RequestResult<&'a Value> {
    value
        .get(name)
        .ok_or_else(|| RequestError::invalid(format!("{name} is missing")))
}

fn string_field<'a>(value: &'a Value, name: &str) -> RequestResult<&'a str> {
    required(value, name)?
        .as_str()
        .ok_or_else(|| RequestError::invalid(format!("{name} must be a string")))
}

fn integer_field(value: &Value, name: &str) -> RequestResult<i64> {
    required(value, name)?
        .as_i64()
        .ok_or_else(|| RequestError::invalid(format!("{name} must be an integer")))
}

fn unsigned_field(value: &Value, name: &str) -> RequestResult<u64> {
    required(value, name)?
        .as_u64()
        .ok_or_else(|| RequestError::invalid(format!("{name} must be an unsigned integer")))
}

fn source_from_text(uri: &str, text: &str) -> RequestResult<SourceText> {
    let id =
        SourceId::new(uri.to_owned()).map_err(|error| RequestError::invalid(error.to_string()))?;
    SourceText::from_bytes(id, text.as_bytes())
        .map_err(|error| RequestError::invalid(error.to_string()))
}

fn byte_offset(source: &SourceText, position: Utf16Position) -> RequestResult<ByteOffset> {
    source
        .utf16_to_byte(position)
        .map_err(|error| RequestError::invalid(error.to_string()))
}

fn token_at(document: &OpenDocument, offset: ByteOffset) -> Option<&Token> {
    document
        .analysis
        .cst
        .tokens
        .iter()
        .find(|token| offset >= token.range.start && offset < token.range.end)
        .or_else(|| {
            document
                .analysis
                .cst
                .tokens
                .iter()
                .rev()
                .find(|token| token.range.end == offset && !token.kind.is_trivia())
        })
}

fn section_at(document: &OpenDocument, offset: ByteOffset) -> String {
    document
        .analysis
        .outline
        .iter()
        .rfind(|item| item.kind == OutlineKind::Section && item.range.start <= offset)
        .map(|item| item.name.trim_matches(['<', '>']).to_ascii_lowercase())
        .unwrap_or_default()
}

struct IncludeSyntax {
    statement: ByteRange,
    range: ByteRange,
    path: String,
    external_xs: bool,
}

pub(crate) struct IncludeLink {
    pub range: ByteRange,
    pub path: String,
    pub target: Result<String, String>,
}

fn range_contains(range: ByteRange, offset: ByteOffset) -> bool {
    range.start <= offset && offset <= range.end
}

fn include_syntax(document: &OpenDocument) -> Vec<IncludeSyntax> {
    document
        .analysis
        .cst
        .nodes
        .iter()
        .filter(|node| node.kind == CstKind::Include)
        .filter_map(|node| {
            let mut tokens = document.analysis.cst.tokens
                [node.token_start as usize..node.token_end as usize]
                .iter()
                .filter(|token| !token.kind.is_trivia());
            let directive = tokens.next()?;
            let path_tokens = tokens.collect::<Vec<_>>();
            let (first, last) = (path_tokens.first()?, path_tokens.last()?);
            let path = path_tokens
                .iter()
                .map(|token| String::from_utf8_lossy(token.bytes(&document.source)))
                .collect::<String>()
                .trim_matches(['"', '\''])
                .replace('\\', "/");
            (!path.is_empty()).then(|| IncludeSyntax {
                statement: node.range,
                range: ByteRange {
                    start: first.range.start,
                    end: last.range.end,
                },
                path,
                external_xs: String::from_utf8_lossy(directive.bytes(&document.source))
                    .eq_ignore_ascii_case("#includeXS"),
            })
        })
        .collect()
}

fn resolve_rms_include(
    resolver: &VirtualSourceResolver,
    current_path: &str,
    path: &str,
) -> Result<String, String> {
    let include = IncludePath::new(path).map_err(|_| {
        format!(
            "{} is not a relative path inside the script's folder or the game, so it cannot be opened.",
            markdown_code(path)
        )
    })?;
    match resolver.resolve(current_path, &include, &[]) {
        Ok(resolved) if resolved.shadowed_candidates.is_empty() => {
            Ok(resolved.selected.source.id().as_str().to_owned())
        }
        Ok(_) => Err(format!(
            "{} matches more than one file, so the script cannot use it.",
            markdown_code(path)
        )),
        Err(diagnostic) => Err(match diagnostic.kind {
            ResolutionDiagnosticKind::Missing => format!(
                "No file named {} is next to the script or in the game.",
                markdown_code(path)
            ),
            ResolutionDiagnosticKind::StandardIncludeUnavailable => diagnostic.message,
            _ => {
                let mut message = diagnostic.message;
                if let Some(first) = message.get_mut(..1) {
                    first.make_ascii_uppercase();
                }
                format!("{}.", message.trim_end_matches('.'))
            }
        }),
    }
}

fn markdown_code(text: &str) -> String {
    format!("`{}`", text.replace('`', "'"))
}

fn include_file_name(path: &str) -> &str {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
}

fn include_node_parts(
    document: &OpenDocument,
    node: &rms_syntax::CstNode,
) -> Option<(String, String)> {
    let mut tokens = document.analysis.cst.tokens
        [node.token_start as usize..node.token_end as usize]
        .iter()
        .filter(|token| !token.kind.is_trivia());
    let directive = String::from_utf8_lossy(tokens.next()?.bytes(&document.source)).into_owned();
    let path = tokens
        .map(|token| String::from_utf8_lossy(token.bytes(&document.source)))
        .collect::<String>()
        .trim_matches(['"', '\''])
        .replace('\\', "/");
    (!path.is_empty()).then_some((directive, path))
}

fn include_xs_paths(document: &OpenDocument) -> Vec<String> {
    document
        .analysis
        .cst
        .nodes
        .iter()
        .filter(|node| node.kind == CstKind::Include)
        .filter_map(|node| include_node_parts(document, node))
        .filter(|(directive, _)| directive.eq_ignore_ascii_case("#includeXS"))
        .map(|(_, path)| path)
        .collect()
}

fn semantic_tokens_text(data: &[u32]) -> String {
    let mut text = String::with_capacity(data.len() * 4 + 10);
    text.push_str(r#"{"data":["#);
    let mut buffer = itoa_buffer();
    for (index, value) in data.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(format_u32(&mut buffer, *value));
    }
    text.push_str("]}");
    text
}

fn itoa_buffer() -> [u8; 10] {
    [0; 10]
}

fn format_u32(buffer: &mut [u8; 10], mut value: u32) -> &str {
    let mut start = buffer.len();
    loop {
        start -= 1;
        buffer[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    std::str::from_utf8(&buffer[start..]).unwrap_or("0")
}

fn push_json_string(text: &mut String, value: &str) -> RequestResult<()> {
    if value
        .bytes()
        .all(|byte| byte >= 0x20 && byte != b'"' && byte != b'\\')
    {
        text.push('"');
        text.push_str(value);
        text.push('"');
        return Ok(());
    }
    text.push_str(
        &serde_json::to_string(value).map_err(|error| RequestError::invalid(error.to_string()))?,
    );
    Ok(())
}

fn push_range_text(text: &mut String, range: Utf16Range) {
    let mut item = [0_u8; 101];
    let mut length = 0;
    let mut put = |bytes: &[u8]| {
        item[length..length + bytes.len()].copy_from_slice(bytes);
        length += bytes.len();
    };
    let mut buffer = itoa_buffer();
    put(br#"{"end":{"character":"#);
    put(format_u32(&mut buffer, range.end.character).as_bytes());
    put(br#","line":"#);
    put(format_u32(&mut buffer, range.end.line).as_bytes());
    put(br#"},"start":{"character":"#);
    put(format_u32(&mut buffer, range.start.character).as_bytes());
    put(br#","line":"#);
    put(format_u32(&mut buffer, range.start.line).as_bytes());
    put(b"}}");
    text.push_str(std::str::from_utf8(&item[..length]).unwrap_or_default());
}

fn semantic_token_data(
    source: &SourceText,
    candidates: impl IntoIterator<Item = (ByteRange, u32)>,
) -> Vec<u32> {
    let mut line_lengths: Option<Vec<u32>> = None;
    let mut line_length = |line: u32| {
        line_lengths
            .get_or_insert_with(|| {
                let mut lengths = vec![0_u32; source.line_index().line_count() as usize];
                for (_, position) in source.line_index().valid_boundaries() {
                    if let Some(length) = lengths.get_mut(position.line as usize) {
                        *length = (*length).max(position.character);
                    }
                }
                lengths
            })
            .get(line as usize)
            .copied()
            .unwrap_or(0)
    };
    let mut tokens = Vec::new();
    for (range, kind) in candidates {
        let Ok(range) = source.byte_range_to_utf16(range) else {
            continue;
        };
        for line in range.start.line..=range.end.line {
            let character = if line == range.start.line {
                range.start.character
            } else {
                0
            };
            let end_character = if line == range.end.line {
                range.end.character
            } else {
                line_length(line)
            };
            if end_character > character {
                tokens.push((line, character, end_character - character, kind));
            }
        }
    }
    tokens.sort_unstable();
    let mut data = Vec::<u32>::with_capacity(tokens.len() * 5);
    let mut previous_line = 0;
    let mut previous_character = 0;
    for (line, character, length, kind) in tokens {
        let delta_line = line - previous_line;
        let delta_character = if delta_line == 0 {
            character - previous_character
        } else {
            character
        };
        data.extend([delta_line, delta_character, length, kind, 0]);
        previous_line = line;
        previous_character = character;
    }
    data
}

fn lsp_range(source: &SourceText, range: ByteRange) -> Option<Value> {
    let range = source.byte_range_to_utf16(range).ok()?;
    Some(json!({
        "start": { "line": range.start.line, "character": range.start.character },
        "end": { "line": range.end.line, "character": range.end.character },
    }))
}

fn zero_range(source: &SourceText) -> Value {
    let start = source
        .byte_to_utf16(ByteOffset(0))
        .unwrap_or(Utf16Position {
            line: 0,
            character: 0,
        });
    json!({
        "start": { "line": start.line, "character": start.character },
        "end": { "line": start.line, "character": start.character },
    })
}

fn symbol_kind(kind: OutlineKind) -> u8 {
    match kind {
        OutlineKind::Section => 3,
        OutlineKind::Command => 12,
        OutlineKind::Attribute => 7,
        OutlineKind::Definition => 14,
        OutlineKind::Include => 1,
        OutlineKind::Conditional => 17,
        OutlineKind::RandomBranch => 22,
    }
}

fn semantic_token_kind(kind: SemanticTokenKind) -> u32 {
    match kind {
        SemanticTokenKind::Comment => 0,
        SemanticTokenKind::Keyword => 1,
        SemanticTokenKind::Section => 2,
        SemanticTokenKind::Command => 3,
        SemanticTokenKind::Attribute => 4,
        SemanticTokenKind::Number => 5,
        SemanticTokenKind::String => 6,
        SemanticTokenKind::Variable => 7,
        SemanticTokenKind::Operator => 8,
        SemanticTokenKind::Control => 9,
    }
}

fn is_control_keyword(value: &str) -> bool {
    matches!(
        value,
        "#const"
            | "#define"
            | "#undefine"
            | "#include_drs"
            | "#includexs"
            | "if"
            | "elseif"
            | "else"
            | "endif"
            | "start_random"
            | "percent_chance"
            | "end_random"
    )
}

fn is_rename_candidate(value: &str) -> bool {
    !is_control_keyword(value)
        && !value.starts_with('<')
        && rms_semantics::strict_command(value).is_none()
        && command_metadata()
            .iter()
            .all(|command| !command.name.eq_ignore_ascii_case(value))
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}

fn replace_tokens(source: &[u8], tokens: &[&Token], replacement: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(source.len());
    let mut cursor = 0;
    for token in tokens {
        let start = token.range.start.0 as usize;
        let end = token.range.end.0 as usize;
        result.extend_from_slice(&source[cursor..start]);
        result.extend_from_slice(replacement);
        cursor = end;
    }
    result.extend_from_slice(&source[cursor..]);
    result
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    result
}

fn id_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

impl Server {
    fn remember_cancellation(&mut self, key: String) {
        if self.cancelled_requests.contains(&key) {
            return;
        }
        if self.cancelled_requests.len() >= MAX_CANCELLED_REQUESTS {
            self.cancelled_requests.pop_front();
        }
        self.cancelled_requests.push_back(key);
    }

    fn take_cancellation(&mut self, key: &str) -> bool {
        let Some(index) = self
            .cancelled_requests
            .iter()
            .position(|entry| entry == key)
        else {
            return false;
        };
        self.cancelled_requests.remove(index);
        true
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>> {
    let mut content_length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let remaining = (MAX_HEADER_BYTES - header_bytes + 1) as u64;
        let count = reader.by_ref().take(remaining).read_line(&mut line)?;
        if count == 0 {
            if header_bytes == 0 {
                return Ok(None);
            }
            bail!("truncated LSP header");
        }
        header_bytes += count;
        if header_bytes > MAX_HEADER_BYTES {
            bail!("LSP header exceeds bounded length");
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("Content-Length")
        {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .context("invalid Content-Length")?,
            );
        }
    }
    let length = content_length.context("missing Content-Length")?;
    if length > MAX_MESSAGE_BYTES {
        bail!("LSP message exceeds bounded length");
    }
    let mut body = Vec::with_capacity(length.min(64 * 1024));
    let read = reader.take(length as u64).read_to_end(&mut body)?;
    if read != length {
        bail!("truncated LSP body");
    }
    Ok(Some(body))
}

fn write_message(output: &mut impl Write, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}

fn write_text_response(output: &mut impl Write, id: &Value, result: &str) -> Result<()> {
    let id = serde_json::to_string(id)?;
    let length = r#"{"id":,"jsonrpc":"2.0","result":}"#.len() + id.len() + result.len();
    write!(
        output,
        "Content-Length: {length}\r\n\r\n{{\"id\":{id},\"jsonrpc\":\"2.0\",\"result\":{result}}}"
    )?;
    output.flush()?;
    Ok(())
}
