use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rms_source::{ByteOffset, ByteRange, SourceId, SourceText, Utf16Position};
use serde_json::{Value, json};
use xs_analysis::{
    AnalysisOptions, CompletionEntry, CompletionKind, FoldKind, IncludeResolver, OutlineKind,
    OutlineSymbol, PreparedEnvironment, RenameTarget, SemanticClass, Target, UnitAnalysis, XsBuild,
    XsFile, XsRuntime, analyze_unit_prepared, builtin_documentation, catalog, completions,
    completions_matching, definition, folds, hover, outline, parameter_hints, quick_fixes,
    rename_locations, rename_target, semantic_tokens, signature_help,
};
use xs_syntax::{DiagnosticTag, Severity, XsDiagnostic};

use crate::facts::{Closed, note_closed_read};
use crate::{
    IncludeLink, RequestError, RequestResult, byte_offset, lsp_range, markdown_code, zero_range,
};

const MAX_XS_FILES: usize = 1_024;
const MAX_RETAINED_UNIT_ANALYSES: usize = 64;
const MAX_RETAINED_UNIT_ITEMS: usize = 1_000_000;

#[derive(Clone)]
pub(crate) struct XsDocument {
    pub version: i64,
    pub file: Arc<XsFile>,
}

#[derive(Default)]
pub(crate) struct XsState {
    pub documents: BTreeMap<String, XsDocument>,
    pub catalog_files: Closed<BTreeMap<String, Arc<XsFile>>>,
    pub environment: Option<Arc<XsFile>>,
    pub build_override: Option<XsBuild>,
    units: RefCell<BTreeMap<String, CachedUnit>>,
    prepared: RefCell<Option<PreparedFor>>,
    next_unit: Cell<u64>,
    clock: Cell<u64>,
    published: BTreeMap<String, (u64, i64)>,
    confirmed_closed_findings: BTreeMap<String, (i64, Vec<Value>)>,
    listed_with_others: BTreeSet<String>,
}

const INCLUDE_NOT_FOUND: &str = "XS4009";
const NOT_DECLARED: [&str; 4] = ["XS3001", "XS3002", "XS4004", "XS4005"];

type PreparedFor = (Option<Arc<XsFile>>, Arc<PreparedEnvironment>);

type Resolution = (SourceId, String, Option<Arc<XsFile>>);

#[derive(Clone)]
struct UnitInputs {
    roots: Vec<Arc<XsFile>>,
    runtime: Option<XsRuntime>,
    build: Option<XsBuild>,
    environment: Option<Arc<XsFile>>,
    resolutions: Vec<Resolution>,
}

impl UnitInputs {
    fn still_hold(&self, current: &UnitRequest<'_>, resolver: &WorkspaceResolver) -> bool {
        self.runtime == current.runtime
            && self.build == current.build
            && same_optional_file(self.environment.as_ref(), current.environment.as_ref())
            && self.roots.len() == current.roots.len()
            && self
                .roots
                .iter()
                .zip(current.roots)
                .all(|(left, right)| same_file(left, right))
            && self.resolutions.iter().all(|(from, path, file)| {
                same_optional_file(file.as_ref(), resolver.resolve(from, path).as_ref())
            })
    }
}

struct UnitRequest<'a> {
    roots: &'a [Arc<XsFile>],
    runtime: Option<XsRuntime>,
    build: Option<XsBuild>,
    environment: Option<Arc<XsFile>>,
}

struct CachedUnit {
    inputs: UnitInputs,
    id: u64,
    analysis: Option<Arc<UnitAnalysis>>,
    used: u64,
}

fn same_file(left: &Arc<XsFile>, right: &Arc<XsFile>) -> bool {
    Arc::ptr_eq(left, right)
        || (left.id() == right.id() && left.source.bytes() == right.source.bytes())
}

fn same_optional_file(left: Option<&Arc<XsFile>>, right: Option<&Arc<XsFile>>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_file(left, right),
        (None, None) => true,
        _ => false,
    }
}

struct RecordingResolver<'a> {
    inner: &'a WorkspaceResolver,
    reads: RefCell<Vec<Resolution>>,
}

impl IncludeResolver for RecordingResolver<'_> {
    fn resolve(&self, from: &SourceId, path: &str) -> Option<Arc<XsFile>> {
        let file = self.inner.resolve(from, path);
        self.reads
            .borrow_mut()
            .push((from.clone(), path.to_owned(), file.clone()));
        file
    }
}

pub(crate) struct Unit {
    pub file: Arc<XsFile>,
    pub id: u64,
    pub analysis: Option<Arc<UnitAnalysis>>,
}

pub(crate) struct XsContext {
    pub links: Vec<(String, Vec<String>)>,
    pub build: Option<XsBuild>,
    pub first_closed_link: usize,
}

impl XsContext {
    pub fn note_listing_read(&self, index: usize) {
        if index >= self.first_closed_link {
            note_closed_read();
        }
    }
}

pub(crate) fn is_xs_uri(uri: &str) -> bool {
    let path = uri.split(['?', '#']).next().unwrap_or(uri);
    path.to_ascii_lowercase().ends_with(".xs")
}

pub(crate) fn is_xs_document(uri: &str, language_id: Option<&str>) -> bool {
    match language_id {
        Some("xs") => true,
        Some("starlark") => false,
        _ => is_xs_uri(uri),
    }
}

pub(crate) fn source_for(uri: &str, text: &str) -> RequestResult<Arc<XsFile>> {
    let id =
        SourceId::new(uri.to_owned()).map_err(|error| RequestError::invalid(error.to_string()))?;
    let source = SourceText::from_bytes(id, text.as_bytes())
        .map_err(|error| RequestError::invalid(error.to_string()))?;
    Ok(XsFile::parse(source))
}

fn normalize(value: &str) -> String {
    let without_scheme = value
        .strip_prefix("file://")
        .or_else(|| value.strip_prefix("memory://"))
        .unwrap_or(value);
    let bytes = without_scheme.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let (Some(high), Some(low)) = (
                bytes
                    .get(index + 1)
                    .and_then(|byte| (*byte as char).to_digit(16)),
                bytes
                    .get(index + 2)
                    .and_then(|byte| (*byte as char).to_digit(16)),
            )
        {
            decoded.push((high * 16 + low) as u8);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    let text = String::from_utf8_lossy(&decoded)
        .replace('\\', "/")
        .to_lowercase();
    let mut segments = Vec::new();
    for segment in text.split('/') {
        match segment {
            "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}

pub(crate) struct IncludePathQuery {
    relative: String,
    wanted: String,
    suffix: String,
}

impl IncludePathQuery {
    pub fn new(from: &str, path: &str) -> Option<Self> {
        let wanted = normalize(path.trim().trim_matches('"'));
        if wanted.is_empty() {
            return None;
        }
        let from = normalize(from);
        let folder = from.rsplit_once('/').map_or("", |(folder, _)| folder);
        Some(Self {
            relative: normalize(&format!("{folder}/{wanted}")),
            suffix: format!("/{wanted}"),
            wanted,
        })
    }

    fn select_ranked<'a, T>(&self, files: &'a [(String, T)]) -> (Option<&'a T>, bool) {
        if let Some((_, file)) = files
            .iter()
            .find(|(candidate, _)| *candidate == self.relative)
        {
            return (Some(file), true);
        }
        (
            files
                .iter()
                .find(|(candidate, _)| {
                    candidate.ends_with(&self.suffix) || *candidate == self.wanted
                })
                .map(|(_, file)| file),
            false,
        )
    }
}

struct ResolvableFile {
    file: Arc<XsFile>,
    closed: bool,
}

pub(crate) struct WorkspaceResolver {
    files: Vec<(String, ResolvableFile)>,
}

impl WorkspaceResolver {
    pub fn new(state: &XsState) -> Self {
        let mut files = BTreeMap::new();
        for (uri, document) in &state.documents {
            files.insert(
                normalize(uri),
                ResolvableFile {
                    file: document.file.clone(),
                    closed: false,
                },
            );
        }
        for (uri, file) in state.catalog_files.peek() {
            files
                .entry(normalize(uri))
                .or_insert_with(|| ResolvableFile {
                    file: file.clone(),
                    closed: true,
                });
        }
        Self {
            files: files.into_iter().take(MAX_XS_FILES).collect(),
        }
    }

    pub fn resolve_path(&self, from: &str, path: &str) -> Option<Arc<XsFile>> {
        let (found, exact) = IncludePathQuery::new(from, path)?.select_ranked(&self.files);
        if !found.is_some_and(|found| exact && !found.closed) {
            note_closed_read();
        }
        found.map(|found| found.file.clone())
    }
}

impl IncludeResolver for WorkspaceResolver {
    fn resolve(&self, from: &SourceId, path: &str) -> Option<Arc<XsFile>> {
        self.resolve_path(from.as_str(), path)
    }
}

impl XsState {
    pub(crate) fn analysis_view(&self) -> Self {
        Self {
            documents: self.documents.clone(),
            catalog_files: self.catalog_files.clone(),
            environment: self.environment.clone(),
            build_override: self.build_override,
            ..Self::default()
        }
    }

    pub(crate) fn invalidate_closed_inputs(&mut self) {
        self.units.get_mut().clear();
        self.prepared.get_mut().take();
        self.published.clear();
    }

    pub(crate) fn require_complete_resolver(&self) -> RequestResult<()> {
        let files = self
            .documents
            .keys()
            .chain(self.catalog_files.keys())
            .map(|uri| normalize(uri))
            .collect::<BTreeSet<_>>();
        if files.len() > MAX_XS_FILES {
            return Err(RequestError::unavailable(
                "rename requires an XS inventory within the resolver limit",
            ));
        }
        Ok(())
    }

    pub fn file(&self, uri: &str) -> Option<Arc<XsFile>> {
        self.documents
            .get(uri)
            .map(|document| document.file.clone())
            .or_else(|| self.catalog_files.get(uri).cloned())
    }

    pub(crate) fn related_source(&self, id: &SourceId) -> Option<Arc<XsFile>> {
        self.file(id.as_str())
            .or_else(|| self.environment.clone().filter(|file| file.id() == id))
    }

    fn environment_for(&self) -> Option<Arc<XsFile>> {
        let constants =
            |file: &&Arc<XsFile>| normalize(file.id().as_str()).ends_with("/constants.xs");
        if let Some(environment) = &self.environment {
            return Some(environment.clone());
        }
        if let Some(open) = self
            .documents
            .values()
            .map(|document| &document.file)
            .find(constants)
        {
            return Some(open.clone());
        }
        self.catalog_files.values().find(constants).cloned()
    }

    fn unit_roots(
        &self,
        file: &Arc<XsFile>,
        context: &XsContext,
        resolver: &WorkspaceResolver,
    ) -> (Vec<Arc<XsFile>>, Option<XsRuntime>) {
        for (index, (rms_uri, names)) in context.links.iter().enumerate() {
            context.note_listing_read(index);
            let listed = names
                .iter()
                .filter_map(|name| resolver.resolve_path(rms_uri, name))
                .collect::<Vec<_>>();
            if listed.iter().any(|candidate| candidate.id() == file.id()) {
                let mut seen = BTreeSet::new();
                let roots = listed
                    .into_iter()
                    .filter(|candidate| seen.insert(candidate.id().clone()))
                    .collect();
                return (roots, Some(XsRuntime::Rms));
            }
        }
        (vec![file.clone()], None)
    }

    fn prepared_for(&self, environment: Option<&Arc<XsFile>>) -> Arc<PreparedEnvironment> {
        let mut prepared = self.prepared.borrow_mut();
        if let Some((file, state)) = prepared.as_ref()
            && match (file.as_ref(), environment) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
        {
            return state.clone();
        }
        let state = Arc::new(PreparedEnvironment::new(environment.cloned()));
        *prepared = Some((environment.cloned(), state.clone()));
        state
    }

    fn tick(&self) -> u64 {
        let now = self.clock.get() + 1;
        self.clock.set(now);
        now
    }

    fn analyze_request(
        &self,
        request: &UnitRequest<'_>,
        resolver: &dyn IncludeResolver,
    ) -> Arc<UnitAnalysis> {
        let options = AnalysisOptions {
            build: request.build,
            runtime: request.runtime,
            environment: request.environment.clone(),
        };
        let prepared = self.prepared_for(request.environment.as_ref());
        Arc::new(analyze_unit_prepared(
            request.roots,
            resolver,
            &options,
            &prepared,
        ))
    }

    pub fn unit(
        &self,
        uri: &str,
        context: &XsContext,
        resolver: &WorkspaceResolver,
        materialize: bool,
    ) -> Option<Unit> {
        let file = self.file(uri)?;
        let (roots, runtime) = self.unit_roots(&file, context, resolver);
        let request = UnitRequest {
            roots: &roots,
            runtime,
            build: context.build,
            environment: self.environment_for(),
        };
        let kept = self.documents.contains_key(uri);
        if kept {
            let now = self.tick();
            let mut units = self.units.borrow_mut();
            if let Some(entry) = units.get_mut(uri)
                && entry.inputs.still_hold(&request, resolver)
            {
                entry.used = now;
                let id = entry.id;
                if entry.analysis.is_none() && materialize {
                    entry.analysis = Some(self.analyze_request(&request, resolver));
                    self.retain_within_bounds(&mut units, id);
                }
                let analysis = units.get(uri).and_then(|entry| entry.analysis.clone());
                return Some(Unit { file, id, analysis });
            }
            let shared = units
                .values()
                .filter(|entry| entry.analysis.is_some())
                .find(|entry| entry.inputs.still_hold(&request, resolver))
                .map(|entry| (entry.inputs.clone(), entry.id, entry.analysis.clone()));
            if let Some((inputs, id, analysis)) = shared {
                units.insert(
                    uri.to_owned(),
                    CachedUnit {
                        inputs,
                        id,
                        analysis: analysis.clone(),
                        used: now,
                    },
                );
                return Some(Unit { file, id, analysis });
            }
        }
        let recording = RecordingResolver {
            inner: resolver,
            reads: RefCell::new(Vec::new()),
        };
        let analysis = self.analyze_request(&request, &recording);
        let id = self.next_unit.get() + 1;
        self.next_unit.set(id);
        if kept {
            let now = self.tick();
            let mut units = self.units.borrow_mut();
            units.insert(
                uri.to_owned(),
                CachedUnit {
                    inputs: UnitInputs {
                        roots: roots.clone(),
                        runtime,
                        build: request.build,
                        environment: request.environment.clone(),
                        resolutions: recording.reads.into_inner(),
                    },
                    id,
                    analysis: Some(analysis.clone()),
                    used: now,
                },
            );
            self.retain_within_bounds(&mut units, id);
        }
        Some(Unit {
            file,
            id,
            analysis: Some(analysis),
        })
    }

    fn retain_within_bounds(&self, units: &mut BTreeMap<String, CachedUnit>, keep: u64) {
        loop {
            let mut distinct = BTreeMap::new();
            for entry in units.values() {
                if let Some(analysis) = &entry.analysis {
                    distinct.insert(entry.id, analysis.symbols.len() + analysis.references.len());
                }
            }
            let items = distinct.values().sum::<usize>();
            if distinct.len() <= MAX_RETAINED_UNIT_ANALYSES && items <= MAX_RETAINED_UNIT_ITEMS {
                return;
            }
            let Some(oldest) = units
                .values()
                .filter(|entry| entry.analysis.is_some() && entry.id != keep)
                .min_by_key(|entry| entry.used)
                .map(|entry| entry.id)
            else {
                return;
            };
            for entry in units.values_mut() {
                if entry.id == oldest {
                    entry.analysis = None;
                }
            }
        }
    }

    pub fn analyze(
        &self,
        uri: &str,
        context: &XsContext,
    ) -> Option<(Arc<XsFile>, Arc<UnitAnalysis>)> {
        self.analyze_with(uri, context, &WorkspaceResolver::new(self))
    }

    fn analyze_with(
        &self,
        uri: &str,
        context: &XsContext,
        resolver: &WorkspaceResolver,
    ) -> Option<(Arc<XsFile>, Arc<UnitAnalysis>)> {
        let unit = self.unit(uri, context, resolver, true)?;
        Some((unit.file, unit.analysis?))
    }

    pub fn forget_closed(&mut self) {
        let documents = &self.documents;
        self.units
            .get_mut()
            .retain(|uri, _| documents.contains_key(uri));
        self.published.retain(|uri, _| documents.contains_key(uri));
        self.confirmed_closed_findings
            .retain(|uri, _| documents.contains_key(uri));
    }

    pub fn note_listings(&mut self, links: &[(String, Vec<String>)]) {
        let resolver = WorkspaceResolver::new(self);
        self.listed_with_others = links
            .iter()
            .flat_map(|(rms_uri, names)| {
                let listed = names
                    .iter()
                    .filter_map(|name| resolver.resolve_path(rms_uri, name))
                    .map(|file| normalize(file.id().as_str()))
                    .collect::<BTreeSet<_>>();
                if listed.len() > 1 {
                    listed
                } else {
                    BTreeSet::new()
                }
            })
            .collect();
    }

    fn may_have_closed_roots(
        &self,
        file: &XsFile,
        context: &XsContext,
        resolver: &WorkspaceResolver,
    ) -> bool {
        for (index, (rms_uri, names)) in context.links.iter().enumerate() {
            context.note_listing_read(index);
            let listed = names
                .iter()
                .map(|name| resolver.resolve_path(rms_uri, name))
                .collect::<Vec<_>>();
            if listed
                .iter()
                .flatten()
                .any(|candidate| candidate.id() == file.id())
            {
                return listed.iter().any(Option::is_none);
            }
        }
        self.listed_with_others
            .contains(&normalize(file.id().as_str()))
    }

    fn runtime_of(&self, uri: &str, context: &XsContext) -> Option<XsRuntime> {
        let resolver = WorkspaceResolver::new(self);
        let file = self.file(uri)?;
        context
            .links
            .iter()
            .enumerate()
            .any(|(index, (rms_uri, names))| {
                context.note_listing_read(index);
                names.iter().any(|name| {
                    resolver
                        .resolve_path(rms_uri, name)
                        .is_some_and(|candidate| candidate.id() == file.id())
                })
            })
            .then_some(XsRuntime::Rms)
    }
}

pub(crate) fn publish_diagnostics(
    state: &mut XsState,
    context: &XsContext,
    changed: Option<&str>,
    all: bool,
    closed_files_visible: bool,
) -> Vec<Value> {
    state.forget_closed();
    let resolver = WorkspaceResolver::new(state);
    let mut notifications = Vec::new();
    let mut published = Vec::new();
    let mut confirmed = Vec::new();
    for (uri, document) in &state.documents {
        let Some(unit) = state.unit(uri, context, &resolver, false) else {
            continue;
        };
        if !all
            && changed != Some(uri.as_str())
            && state.published.get(uri) == Some(&(unit.id, document.version))
        {
            continue;
        }
        let analysis = match unit.analysis {
            Some(analysis) => analysis,
            None => match state
                .unit(uri, context, &resolver, true)
                .and_then(|unit| unit.analysis)
            {
                Some(analysis) => analysis,
                None => continue,
            },
        };
        let mut diagnostics = analysis
            .diagnostics_for(unit.file.id())
            .iter()
            .map(|diagnostic| {
                diagnostic_json(&unit.file, diagnostic, &|id| state.related_source(id))
            })
            .collect::<Vec<_>>();
        let not_declared = |diagnostic: &Value| {
            diagnostic["code"]
                .as_str()
                .is_some_and(|code| NOT_DECLARED.contains(&code))
        };
        if closed_files_visible {
            let findings = diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic["code"] == INCLUDE_NOT_FOUND || not_declared(diagnostic)
                })
                .cloned()
                .collect();
            confirmed.push((uri.clone(), (document.version, findings)));
        } else {
            let findings = state
                .confirmed_closed_findings
                .get(uri)
                .filter(|(version, _)| *version == document.version)
                .map(|(_, findings)| findings);
            let closed_roots = diagnostics.iter().any(not_declared)
                && state.may_have_closed_roots(&unit.file, context, &resolver);
            diagnostics.retain(|diagnostic| {
                let withheld = diagnostic["code"] == INCLUDE_NOT_FOUND
                    || (closed_roots && not_declared(diagnostic));
                !withheld || findings.is_some_and(|findings| findings.contains(diagnostic))
            });
        }
        let mut seen = BTreeSet::new();
        let code_actions = analysis
            .diagnostics_for(unit.file.id())
            .iter()
            .filter(|diagnostic| seen.insert((diagnostic.range.start, diagnostic.range.end)))
            .take(crate::MAX_PUBLISHED_CODE_ACTION_RANGES)
            .filter_map(|diagnostic| {
                let range = lsp_range(&unit.file.source, diagnostic.range)?;
                Some((
                    range,
                    code_actions_in(
                        &unit.file,
                        &analysis,
                        uri,
                        diagnostic.range,
                        context.build,
                        &|id| state.related_source(id),
                    ),
                ))
            })
            .collect::<Vec<_>>();
        let (ranges, actions): (Vec<_>, Vec<_>) = code_actions.into_iter().unzip();
        notifications.push(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "version": document.version,
                "diagnostics": diagnostics,
                "rmsCodeActions": crate::published_code_actions_json(ranges.into_iter(), actions),
            }
        }));
        published.push((uri.clone(), (unit.id, document.version)));
    }
    state.published.extend(published);
    state.confirmed_closed_findings.extend(confirmed);
    notifications
}

pub(crate) fn diagnostic_json(
    file: &XsFile,
    diagnostic: &XsDiagnostic,
    source_of: &dyn Fn(&SourceId) -> Option<Arc<XsFile>>,
) -> Value {
    let mut value = json!({
        "range": lsp_range(&file.source, diagnostic.range)
            .unwrap_or_else(|| zero_range(&file.source)),
        "severity": match diagnostic.severity {
            Severity::Error => 1,
            Severity::Warning => 2,
            Severity::Information => 3,
            Severity::Hint => 4,
        },
        "code": diagnostic.code,
        "source": "rms-ls",
        "message": diagnostic.message,
    });
    if !diagnostic.tags.is_empty() {
        value["tags"] = Value::Array(
            diagnostic
                .tags
                .iter()
                .map(|tag| match tag {
                    DiagnosticTag::Unnecessary => json!(1),
                    DiagnosticTag::Deprecated => json!(2),
                })
                .collect(),
        );
    }
    let related = diagnostic
        .related
        .iter()
        .take(xs_syntax::MAXIMUM_RELATED_LOCATIONS)
        .filter_map(|related| {
            let range = if related.source_id == *file.id() {
                lsp_range(&file.source, related.range)?
            } else {
                lsp_range(&source_of(&related.source_id)?.source, related.range)?
            };
            Some(json!({
                "location": { "uri": related.source_id.as_str(), "range": range },
                "message": related.message,
            }))
        })
        .collect::<Vec<_>>();
    if !related.is_empty() {
        value["relatedInformation"] = Value::Array(related);
    }
    value
}

fn position_offset(file: &XsFile, params: &Value) -> RequestResult<ByteOffset> {
    let (_, position) = crate::request_position(params)?;
    byte_offset(&file.source, position)
}

fn analyzed(
    state: &XsState,
    uri: &str,
    context: &XsContext,
) -> RequestResult<(Arc<XsFile>, Arc<UnitAnalysis>)> {
    state
        .analyze(uri, context)
        .ok_or_else(|| RequestError::invalid("document is not open"))
}

const COMPLETION_FILTER_CONTRACT: u64 = 1;
const EDITOR_MATCH_LIMIT: usize = 128;

pub(crate) fn editor_may_match(word: &str, label: &str) -> bool {
    let word = word.as_bytes();
    let label = label.as_bytes();
    if word.is_empty() {
        return true;
    }
    if !word.is_ascii()
        || !label.is_ascii()
        || word.len() > EDITOR_MATCH_LIMIT
        || label.len() > EDITOR_MATCH_LIMIT
    {
        return true;
    }
    if word.len() > label.len() {
        return false;
    }
    let lower = word.to_ascii_lowercase();
    let mut variants = vec![lower.clone()];
    if lower.len() >= 3 {
        let tries = 7.min(lower.len() - 1);
        for position in 1..tries {
            if lower[position] != lower[position + 1] {
                let mut swapped = lower.clone();
                swapped.swap(position, position + 1);
                variants.push(swapped);
            }
        }
    }
    let label_lower = label.to_ascii_lowercase();
    (0..label.len()).any(|start| {
        label_lower[start] == lower[0]
            && strong_match_start(label, start)
            && variants
                .iter()
                .any(|variant| is_subsequence(&variant[1..], &label_lower[start + 1..]))
    })
}

fn editor_separator(byte: u8) -> bool {
    matches!(
        byte,
        b'_' | b'-'
            | b'.'
            | b' '
            | b'/'
            | b'\\'
            | b'\''
            | b'"'
            | b':'
            | b'$'
            | b'<'
            | b'>'
            | b'('
            | b')'
            | b'['
            | b']'
            | b'{'
            | b'}'
    )
}

fn strong_match_start(label: &[u8], position: usize) -> bool {
    if position == 0 {
        return true;
    }
    let previous = label[position - 1];
    (label[position].is_ascii_uppercase() && !previous.is_ascii_uppercase())
        || (editor_separator(label[position]) && !editor_separator(previous))
        || editor_separator(previous)
        || previous == b' '
        || previous == b'\t'
}

fn is_subsequence(needle: &[u8], haystack: &[u8]) -> bool {
    let mut rest = haystack.iter();
    needle
        .iter()
        .all(|wanted| rest.any(|candidate| candidate == wanted))
}

fn completion_item(entry: CompletionEntry, insert_text: bool) -> Value {
    let mut item = json!({
        "label": entry.label,
        "kind": match entry.kind {
            CompletionKind::Function => 3,
            CompletionKind::Variable => 6,
            CompletionKind::Constant => 21,
            CompletionKind::Keyword => 14,
            CompletionKind::Class => 7,
            CompletionKind::Field => 5,
            CompletionKind::Event => 23,
        },
        "detail": entry.detail,
    });
    if insert_text {
        item["insertText"] = json!(entry.label);
    }
    if let Some(documentation) = entry.documentation {
        item["documentation"] = json!({ "kind": "markdown", "value": documentation });
    } else if entry.builtin && !insert_text {
        item["data"] = json!({ "xsBuiltin": entry.label });
    }
    if entry.deprecated {
        item["tags"] = json!([1]);
    }
    item
}

pub(crate) fn completion(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let runtime = state.runtime_of(uri, context);
    let items = match params.get("rmsCompletion") {
        None | Some(Value::Null) => completions(&file, &analysis, offset, context.build, runtime)
            .into_iter()
            .map(|entry| completion_item(entry, true))
            .collect::<Vec<_>>(),
        Some(filter) => {
            let contract = filter.get("contract").and_then(Value::as_u64);
            if contract != Some(COMPLETION_FILTER_CONTRACT) {
                return Err(RequestError::invalid(
                    "rmsCompletion names an unsupported completion filter contract",
                ));
            }
            let word = filter
                .get("word")
                .and_then(Value::as_str)
                .ok_or_else(|| RequestError::invalid("rmsCompletion word must be a string"))?;
            completions_matching(&file, &analysis, offset, context.build, runtime, &|label| {
                editor_may_match(word, label)
            })
            .into_iter()
            .map(|entry| completion_item(entry, false))
            .collect::<Vec<_>>()
        }
    };
    Ok(json!({ "isIncomplete": false, "items": items }))
}

pub(crate) fn resolve_completion(params: &Value, build: Option<XsBuild>) -> RequestResult<Value> {
    if !params.is_object() {
        return Err(RequestError::invalid("a completion item must be an object"));
    }
    let mut item = params.clone();
    if let Some(builtin) = params
        .get("data")
        .and_then(|data| data.get("xsBuiltin"))
        .and_then(Value::as_str)
        .and_then(|name| catalog().ok()?.get(name))
    {
        item.as_object_mut().unwrap().remove("documentation");
        if build.is_none_or(|build| builtin.available_in(build))
            && params.get("detail").and_then(Value::as_str)
                == Some(builtin.signature(build).as_str())
        {
            item["documentation"] =
                json!({ "kind": "markdown", "value": builtin_documentation(builtin, build) });
        }
    }
    Ok(item)
}

pub(crate) fn signature_help_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let Some(help) = signature_help(&file, &analysis, offset, context.build) else {
        return Ok(Value::Null);
    };
    let mut signature = json!({
        "label": help.label,
        "parameters": help.parameters.iter().map(|parameter| {
            let mut value = json!({ "label": parameter.label });
            if let Some(documentation) = &parameter.documentation {
                value["documentation"] = json!({ "kind": "markdown", "value": documentation });
            }
            value
        }).collect::<Vec<_>>(),
    });
    if let Some(documentation) = help.documentation {
        signature["documentation"] = json!({ "kind": "markdown", "value": documentation });
    }
    Ok(json!({
        "signatures": [signature],
        "activeSignature": 0,
        "activeParameter": help.active_parameter,
    }))
}

pub(crate) fn inlay_hints_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let requested = crate::rms_lint::request_range(&file.source, params)?;
    Ok(Value::Array(
        parameter_hints(&file, &analysis, requested, context.build)
            .into_iter()
            .filter_map(|hint| {
                let position = file.source.byte_to_utf16(hint.position).ok()?;
                Some(json!({
                    "position": { "line": position.line, "character": position.character },
                    "label": hint.label,
                    "kind": 2,
                    "paddingRight": true,
                }))
            })
            .collect(),
    ))
}

fn file_include_links(file: &XsFile, analysis: &UnitAnalysis) -> Vec<IncludeLink> {
    analysis
        .includes
        .iter()
        .filter(|link| link.source_id == *file.id())
        .map(|link| {
            let path = file
                .source
                .bytes()
                .get(link.range.start.0 as usize..link.range.end.0 as usize)
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default()
                .trim()
                .trim_matches('"')
                .replace('\\', "/");
            IncludeLink {
                range: link.range,
                target: link
                    .target
                    .as_ref()
                    .map(|target| target.as_str().to_owned())
                    .ok_or_else(|| {
                        format!(
                            "{} was not found in the workspace or the linked game's XS folder.",
                            markdown_code(&path)
                        )
                    }),
                path,
            }
        })
        .collect()
}

pub(crate) fn include_links(
    state: &XsState,
    uri: &str,
    context: &XsContext,
) -> Option<(Arc<XsFile>, Vec<IncludeLink>)> {
    let (file, analysis) = state.analyze(uri, context)?;
    let links = file_include_links(&file, &analysis);
    Some((file, links))
}

pub(crate) fn hover_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
    include_hover: &dyn Fn(&SourceText, &IncludeLink) -> Value,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    if let Some(link) = file_include_links(&file, &analysis)
        .iter()
        .find(|link| link.range.start <= offset && offset <= link.range.end)
    {
        return Ok(include_hover(&file.source, link));
    }
    Ok(
        hover(&file, &analysis, offset, context.build).map_or(Value::Null, |info| {
            json!({
                "contents": { "kind": "markdown", "value": info.markdown },
                "range": lsp_range(&file.source, info.range),
            })
        }),
    )
}

fn location(
    state: &XsState,
    analysis_files: &[Arc<XsFile>],
    id: &SourceId,
    range: ByteRange,
) -> Option<Value> {
    let file = analysis_files
        .iter()
        .find(|file| file.id() == id)
        .cloned()
        .or_else(|| state.file(id.as_str()))
        .or_else(|| state.environment.clone().filter(|file| file.id() == id))?;
    Some(json!({ "uri": id.as_str(), "range": lsp_range(&file.source, range)? }))
}

pub(crate) fn definition_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let Some((target, range)) = definition(&analysis, file.id(), offset) else {
        return Ok(Value::Null);
    };
    Ok(location(state, &[file], &target, range).unwrap_or(Value::Null))
}

pub(crate) fn references_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let include_declaration = params
        .get("context")
        .and_then(|context| context.get("includeDeclaration"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let Some((target, _)) = analysis.target_at(file.id(), offset.0) else {
        return Ok(json!([]));
    };
    let declaration = match &target {
        Target::Symbol(id) => {
            let symbol = analysis.symbol(*id);
            Some((symbol.source_id.clone(), symbol.selection_range))
        }
        Target::Builtin(_) => None,
    };
    let mut found = BTreeSet::new();
    let mut uris = state.documents.keys().cloned().collect::<Vec<_>>();
    uris.extend(state.catalog_files.keys().cloned());
    uris.sort();
    uris.dedup();
    let mut files = vec![file.clone()];
    let resolver = WorkspaceResolver::new(state);
    for candidate in std::iter::once(uri.to_owned()).chain(uris) {
        let Some((candidate_file, unit)) = state.analyze_with(&candidate, context, &resolver)
        else {
            continue;
        };
        files.push(candidate_file);
        let unit_target = match (&target, &declaration) {
            (Target::Builtin(name), _) => Some(Target::Builtin(name.clone())),
            (_, Some((source_id, range))) => unit
                .symbols
                .iter()
                .position(|symbol| {
                    symbol.source_id == *source_id && symbol.selection_range == *range
                })
                .map(|index| Target::Symbol(xs_analysis::SymbolId(index as u32))),
            _ => None,
        };
        if let Some(unit_target) = unit_target {
            for (source_id, range) in unit.locations_of(&unit_target, include_declaration) {
                found.insert((source_id.as_str().to_owned(), range.start.0, range.end.0));
            }
        }
    }
    Ok(Value::Array(
        found
            .into_iter()
            .filter_map(|(id, start, end)| {
                let id = SourceId::new(id).ok()?;
                location(
                    state,
                    &files,
                    &id,
                    ByteRange {
                        start: ByteOffset(start),
                        end: ByteOffset(end),
                    },
                )
            })
            .collect(),
    ))
}

pub(crate) fn document_highlight_response(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let Some((target, _)) = analysis.target_at(file.id(), offset.0) else {
        return Ok(json!([]));
    };
    let declarations = analysis
        .locations_of(&target, true)
        .into_iter()
        .filter(|(source_id, _)| source_id == file.id())
        .map(|(_, range)| (range.start.0, range.end.0))
        .collect::<BTreeSet<_>>();
    let uses = analysis
        .locations_of(&target, false)
        .into_iter()
        .filter(|(source_id, _)| source_id == file.id())
        .map(|(_, range)| (range.start.0, range.end.0))
        .collect::<BTreeSet<_>>();
    Ok(Value::Array(
        declarations
            .iter()
            .filter_map(|range| {
                let lsp = file
                    .source
                    .byte_range_to_utf16(ByteRange {
                        start: ByteOffset(range.0),
                        end: ByteOffset(range.1),
                    })
                    .ok()?;
                Some(json!({
                    "range": {
                        "start": { "line": lsp.start.line, "character": lsp.start.character },
                        "end": { "line": lsp.end.line, "character": lsp.end.character },
                    },
                    "kind": if uses.contains(range) { 2 } else { 3 },
                }))
            })
            .collect(),
    ))
}

fn outline_kind(kind: OutlineKind) -> u8 {
    match kind {
        OutlineKind::Include => 1,
        OutlineKind::Function => 12,
        OutlineKind::Rule => 24,
        OutlineKind::Variable => 13,
        OutlineKind::Constant => 14,
        OutlineKind::Class => 5,
        OutlineKind::Member => 8,
    }
}

fn outline_json(source: &SourceText, symbol: &OutlineSymbol) -> Option<Value> {
    Some(json!({
        "name": symbol.name,
        "detail": symbol.detail,
        "kind": outline_kind(symbol.kind),
        "range": lsp_range(source, symbol.range)?,
        "selectionRange": lsp_range(source, symbol.selection_range)?,
        "children": symbol
            .children
            .iter()
            .filter_map(|child| outline_json(source, child))
            .collect::<Vec<_>>(),
    }))
}

pub(crate) fn document_symbols(state: &XsState, uri: &str) -> RequestResult<Value> {
    let file = state
        .file(uri)
        .ok_or_else(|| RequestError::invalid("document is not open"))?;
    Ok(Value::Array(
        outline(&file)
            .iter()
            .filter_map(|symbol| outline_json(&file.source, symbol))
            .collect(),
    ))
}

pub(crate) fn workspace_symbols(state: &XsState, query: &str, limit: usize) -> Vec<Value> {
    let mut symbols = Vec::new();
    for (uri, document) in &state.documents {
        for symbol in outline(&document.file) {
            if symbol.kind == OutlineKind::Include
                || (!query.is_empty() && !symbol.name.to_ascii_lowercase().contains(query))
            {
                continue;
            }
            if let Some(range) = lsp_range(&document.file.source, symbol.selection_range) {
                symbols.push(json!({
                    "name": symbol.name,
                    "kind": outline_kind(symbol.kind),
                    "location": { "uri": uri, "range": range },
                }));
            }
            if symbols.len() >= limit {
                return symbols;
            }
        }
    }
    symbols
}

pub(crate) fn folding_ranges(state: &XsState, uri: &str) -> RequestResult<Value> {
    let file = state
        .file(uri)
        .ok_or_else(|| RequestError::invalid("document is not open"))?;
    Ok(Value::Array(
        folds(&file)
            .into_iter()
            .filter_map(|fold| {
                let range = file.source.byte_range_to_utf16(fold.range).ok()?;
                (range.end.line > range.start.line).then(|| {
                    json!({
                        "startLine": range.start.line,
                        "startCharacter": range.start.character,
                        "endLine": range.end.line,
                        "endCharacter": range.end.character,
                        "kind": match fold.kind {
                            FoldKind::Region => "region",
                            FoldKind::Comment => "comment",
                        },
                    })
                })
            })
            .collect(),
    ))
}

pub(crate) fn semantic_tokens_response(
    state: &XsState,
    uri: &str,
    context: &XsContext,
) -> RequestResult<Value> {
    Ok(json!({ "data": semantic_token_data(state, uri, context)? }))
}

pub(crate) fn semantic_tokens_text(
    state: &XsState,
    uri: &str,
    context: &XsContext,
) -> RequestResult<String> {
    Ok(crate::semantic_tokens_text(&semantic_token_data(
        state, uri, context,
    )?))
}

fn semantic_token_data(state: &XsState, uri: &str, context: &XsContext) -> RequestResult<Vec<u32>> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let tokens = semantic_tokens(&file, Some(&analysis))
        .into_iter()
        .map(|token| {
            (
                token.range,
                match token.class {
                    SemanticClass::Comment => 0,
                    SemanticClass::Keyword => 1,
                    SemanticClass::Namespace => 2,
                    SemanticClass::Function => 3,
                    SemanticClass::Property => 4,
                    SemanticClass::Number => 5,
                    SemanticClass::String => 6,
                    SemanticClass::Variable => 7,
                    SemanticClass::Operator => 8,
                    SemanticClass::Control => 9,
                },
            )
        })
        .collect::<Vec<_>>();
    Ok(crate::semantic_token_data(&file.source, tokens))
}

pub(crate) fn install_environment(state: &mut XsState, params: &Value) -> RequestResult<()> {
    state.environment = match params.get("constants") {
        None | Some(Value::Null) => None,
        Some(constants) => {
            let uri = crate::string_field(constants, "uri")?;
            let text = crate::string_field(constants, "text")?;
            if text.len() > 16 * 1024 * 1024 {
                return Err(RequestError::invalid(
                    "constants text exceeds the 16 MiB bound",
                ));
            }
            Some(source_for(uri, text)?)
        }
    };
    state.build_override = match params.get("gameBuild") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(
            XsBuild::from_id(id)
                .ok_or_else(|| RequestError::invalid("gameBuild is unsupported"))?,
        ),
        Some(_) => return Err(RequestError::invalid("gameBuild must be a string")),
    };
    Ok(())
}

pub(crate) fn formatting_response(
    state: &XsState,
    uri: &str,
    params: &Value,
) -> RequestResult<Value> {
    let document = state
        .documents
        .get(uri)
        .ok_or_else(|| RequestError::invalid("document is not open"))?;
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
    if let Some(convention) = params.get("xsFormatterConvention") {
        let requested = convention.as_u64().ok_or_else(|| {
            RequestError::invalid("xsFormatterConvention must be an unsigned integer")
        })?;
        if requested != u64::from(xs_analysis::XS_FORMATTER_CONVENTION) {
            return Err(RequestError::unavailable(format!(
                "unsupported XS formatter convention {requested}"
            )));
        }
    }
    let options = params.get("options");
    let insert_spaces = options
        .and_then(|options| options.get("insertSpaces"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let tab_size = options
        .and_then(|options| options.get("tabSize"))
        .and_then(Value::as_u64)
        .unwrap_or(4)
        .clamp(1, 16) as usize;
    let indent = if insert_spaces {
        " ".repeat(tab_size)
    } else {
        "	".to_owned()
    };
    let edits = xs_analysis::format_document(&document.file, &indent).map_err(|message| {
        RequestError::unavailable(format!("formatting is unavailable: {message}"))
    })?;
    edits
        .into_iter()
        .map(|edit| {
            Ok(json!({
                "range": lsp_range(&document.file.source, edit.range).ok_or_else(|| {
                    RequestError::invalid("formatter edit range is not representable in UTF-16")
                })?,
                "newText": edit.replacement,
            }))
        })
        .collect::<RequestResult<Vec<_>>>()
        .map(Value::Array)
}

pub(crate) fn code_actions(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let range = crate::required(params, "range")?;
    let position = |name: &str| -> RequestResult<ByteOffset> {
        let value = crate::required(range, name)?;
        let line = value
            .get("line")
            .and_then(Value::as_u64)
            .and_then(|line| u32::try_from(line).ok())
            .ok_or_else(|| RequestError::invalid("range line is invalid"))?;
        let character = value
            .get("character")
            .and_then(Value::as_u64)
            .and_then(|character| u32::try_from(character).ok())
            .ok_or_else(|| RequestError::invalid("range character is invalid"))?;
        byte_offset(&file.source, Utf16Position { line, character })
    };
    let requested = ByteRange {
        start: position("start")?,
        end: position("end")?,
    };
    Ok(Value::Array(code_actions_in(
        &file,
        &analysis,
        uri,
        requested,
        context.build,
        &|id| state.related_source(id),
    )))
}

fn code_actions_in(
    file: &XsFile,
    analysis: &UnitAnalysis,
    uri: &str,
    requested: ByteRange,
    build: Option<XsBuild>,
    source_of: &dyn Fn(&SourceId) -> Option<Arc<XsFile>>,
) -> Vec<Value> {
    quick_fixes(file, analysis, requested, build)
        .into_iter()
        .filter_map(|fix| {
            let edits = fix
                .edits
                .iter()
                .map(|edit| {
                    Some(json!({
                        "range": lsp_range(&file.source, edit.range)?,
                        "newText": edit.replacement,
                    }))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(json!({
                "title": fix.title,
                "kind": "quickfix",
                "isPreferred": fix.preferred,
                "diagnostics": [diagnostic_json(file, &fix.diagnostic, source_of)],
                "edit": { "changes": { uri: edits } },
            }))
        })
        .collect::<Vec<_>>()
}

type RenameUnit = (Arc<UnitAnalysis>, Vec<Arc<XsFile>>);

fn rename_units(
    state: &XsState,
    target: &RenameTarget,
    context: &XsContext,
    require_complete: bool,
) -> RequestResult<Vec<RenameUnit>> {
    let mut uris = state.documents.keys().cloned().collect::<Vec<_>>();
    uris.extend(state.catalog_files.keys().cloned());
    uris.sort();
    uris.dedup();
    let mut seen = BTreeSet::new();
    let mut units = Vec::new();
    let resolver = WorkspaceResolver::new(state);
    for candidate in uris {
        let Some((file, unit)) = state.analyze_with(&candidate, context, &resolver) else {
            continue;
        };
        if require_complete {
            let (roots, _) = state.unit_roots(&file, context, &resolver);
            if roots.iter().any(|root| !unit.files.contains(root.id()))
                || unit
                    .diagnostics
                    .values()
                    .flatten()
                    .any(|d| d.code == "XS9001")
            {
                return Err(RequestError::unavailable(
                    "rename requires every XS unit within its analysis limits",
                ));
            }
        }
        let declares = unit.symbols.iter().any(|symbol| {
            symbol.source_id == target.source_id && symbol.selection_range == target.selection_range
        });
        let key = unit
            .files
            .iter()
            .map(|id| id.as_str().to_owned())
            .collect::<Vec<_>>();
        if !declares || !seen.insert(key) {
            continue;
        }
        let files = unit
            .files
            .iter()
            .filter_map(|id| state.file(id.as_str()))
            .collect::<Vec<_>>();
        units.push((unit, files));
    }
    Ok(units)
}

fn display_name(uri: &str) -> String {
    let name = uri.rsplit(['/', '\\']).next().unwrap_or(uri);
    let bytes = name.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(value) = name
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(value);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

type RenamePlan = (Arc<XsFile>, RenameTarget, Vec<(SourceId, ByteRange)>);

fn rename_plan(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
    new_name: Option<&str>,
) -> RequestResult<RenamePlan> {
    let (file, analysis) = analyzed(state, uri, context)?;
    let offset = position_offset(&file, params)?;
    let target = rename_target(&analysis, file.id(), offset).map_err(RequestError::unavailable)?;
    if normalize(target.source_id.as_str()).ends_with("/constants.xs") {
        return Err(RequestError::unavailable(format!(
            "'{}' is declared in the game's Constants.xs; it cannot be renamed.",
            target.name
        )));
    }
    let units = rename_units(
        state,
        &target,
        context,
        params.get("editorContext").is_some(),
    )?;
    let references = units
        .iter()
        .map(|(unit, files)| (unit.as_ref(), files.clone()))
        .collect::<Vec<_>>();
    let locations =
        rename_locations(&target, &references, new_name).map_err(RequestError::unavailable)?;
    if let Some((closed, _)) = locations
        .iter()
        .find(|(id, _)| !state.documents.contains_key(id.as_str()))
    {
        return Err(RequestError::unavailable(format!(
            "'{}' is also used in {}, which is not open; open it to rename there too.",
            target.name,
            display_name(closed.as_str())
        )));
    }
    Ok((file, target, locations))
}

pub(crate) fn prepare_rename(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let (file, target, _) = rename_plan(state, uri, params, context, None)?;
    Ok(json!({
        "range": lsp_range(&file.source, target.cursor_range),
        "placeholder": target.name,
    }))
}

pub(crate) fn rename(
    state: &XsState,
    uri: &str,
    params: &Value,
    context: &XsContext,
) -> RequestResult<Value> {
    let new_name = crate::string_field(params, "newName")?;
    let (_, _, locations) = rename_plan(state, uri, params, context, Some(new_name))?;
    let mut changes = serde_json::Map::new();
    for (id, range) in locations {
        let Some(file) = state.file(id.as_str()) else {
            continue;
        };
        let range = lsp_range(&file.source, range)
            .ok_or_else(|| RequestError::invalid("rename range is not representable in UTF-16"))?;
        if let Value::Array(edits) = changes
            .entry(id.as_str().to_owned())
            .or_insert_with(|| Value::Array(Vec::new()))
        {
            edits.push(json!({ "range": range, "newText": new_name }));
        }
    }
    Ok(json!({ "changes": changes }))
}

const MAX_SYNTAX_CHECK_FILES: usize = 512;
const MAX_SYNTAX_CHECK_ERRORS: usize = 20;

pub(crate) fn syntax_check(params: &Value) -> RequestResult<Value> {
    let files = crate::required(params, "files")?
        .as_array()
        .ok_or_else(|| RequestError::invalid("files must be an array"))?;
    if files.len() > MAX_SYNTAX_CHECK_FILES {
        return Err(RequestError::invalid(format!(
            "at most {MAX_SYNTAX_CHECK_FILES} XS files can be checked at once"
        )));
    }
    let mut total = 0_usize;
    let mut results = Vec::with_capacity(files.len());
    for entry in files {
        let uri = crate::string_field(entry, "uri")?;
        let text = crate::string_field(entry, "text")?;
        total = total.saturating_add(text.len());
        if text.len() > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 {
            return Err(RequestError::invalid(
                "XS files to check exceed the 16 MiB file or 64 MiB total bound",
            ));
        }
        let file = source_for(uri, text)?;
        let errors = file
            .tree
            .diagnostics
            .iter()
            .filter(|diagnostic| {
                diagnostic.severity == Severity::Error
                    && (diagnostic.code.starts_with("XS1") || diagnostic.code.starts_with("XS2"))
            })
            .take(MAX_SYNTAX_CHECK_ERRORS)
            .map(|diagnostic| {
                let position = file.source.byte_to_utf16(diagnostic.range.start).ok();
                json!({
                    "code": diagnostic.code,
                    "message": diagnostic.message,
                    "line": position.map_or(0, |position| position.line),
                    "character": position.map_or(0, |position| position.character),
                })
            })
            .collect::<Vec<_>>();
        results.push(json!({ "uri": uri, "errors": errors }));
    }
    Ok(json!({ "files": results }))
}
