use std::collections::BTreeMap;
use std::io::{self, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rms_source::{
    CatalogSource, ResolverRoots, SourceCatalog, SourceCatalogRole, SourceInventory, SourceText,
};
use serde_json::{Value, json};

use crate::{
    OpenDocument, RequestError, RequestResult, Server, analyze_document, catalog_source_from_json,
    decode_base64, optional_string_field, required, standard_include_access, string_field,
};

const METADATA: usize = 2 * 1024 * 1024;
const CLOSED_BYTES: usize = 16 * 1024 * 1024;
const FILE_BYTES: usize = 4 * 1024 * 1024;
const WIRE_BYTES: usize = 64 * 1024 * 1024;
const NAME_WORK: usize = 64 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);

pub(super) struct Inventory {
    pub sources: SourceInventory,
    pub rms: BTreeMap<String, Arc<OpenDocument>>,
    pub xs: BTreeMap<String, Arc<xs_analysis::XsFile>>,
}

#[derive(Clone, Copy)]
pub(super) enum View<'a> {
    Legacy(&'a SourceCatalog),
    Current(&'a SourceInventory),
}

impl<'a> View<'a> {
    pub fn sources(self) -> &'a [CatalogSource] {
        match self {
            Self::Legacy(v) => v.sources(),
            Self::Current(v) => v.sources(),
        }
    }
    pub fn roots(self) -> &'a ResolverRoots {
        match self {
            Self::Legacy(v) => v.roots(),
            Self::Current(v) => v.roots(),
        }
    }
    pub fn case_sensitive(self) -> bool {
        match self {
            Self::Legacy(v) => v.case_sensitive(),
            Self::Current(v) => v.case_sensitive(),
        }
    }
    pub fn profile_id(self) -> &'a str {
        match self {
            Self::Legacy(v) => v.profile_id(),
            Self::Current(v) => v.profile_id(),
        }
    }
    pub fn content_identity(self) -> &'a str {
        match self {
            Self::Legacy(v) => v.content_identity(),
            Self::Current(v) => v.content_identity(),
        }
    }
    pub fn implicit_definitions(self) -> &'a BTreeMap<String, String> {
        match self {
            Self::Legacy(v) => v.implicit_definitions(),
            Self::Current(v) => v.implicit_definitions(),
        }
    }
}

#[derive(Default)]
pub(super) struct State {
    pub modern: bool,
    pub document_epoch: u64,
    context: String,
    inventory_id: Option<String>,
    active: Option<Arc<Inventory>>,
    selection: Option<SourceInventory>,
    stage: Option<Stage>,
}

struct Descriptor {
    source: CatalogSource,
    length: usize,
    supplied: bool,
}

struct Stage {
    request: String,
    context: String,
    inventory_id: String,
    round: u64,
    started: Instant,
    wire_bytes: usize,
    manifest: Vec<Descriptor>,
    index: Vec<(String, usize)>,
    name_work: usize,
    rms: BTreeMap<String, Arc<OpenDocument>>,
    xs: BTreeMap<String, Arc<xs_analysis::XsFile>>,
    selection: SourceInventory,
}

impl State {
    pub(super) fn analysis_view(&self) -> Self {
        Self {
            modern: self.modern,
            document_epoch: self.document_epoch,
            context: self.context.clone(),
            inventory_id: self.inventory_id.clone(),
            active: self.active.clone(),
            selection: self.selection.clone(),
            stage: None,
        }
    }

    pub(super) fn clear(&mut self) {
        self.active = None;
        self.inventory_id = None;
        self.stage = None;
    }

    pub fn expire(&mut self) -> bool {
        if self
            .stage
            .as_ref()
            .is_some_and(|stage| stage.started.elapsed() >= DEADLINE)
        {
            self.clear();
            return true;
        }
        false
    }

    pub fn stamp(&self) -> Value {
        json!({"contextId": self.context, "inventoryId": self.inventory_id,
            "documentEpoch": self.document_epoch, "complete": self.active.is_some()})
    }

    fn begin(&mut self, params: &Value) -> RequestResult<Value> {
        let started = Instant::now();
        self.modern = true;
        let reuse = self.active.take();
        self.clear();
        self.selection = None;
        let request = bounded(params, "requestId")?;
        let context = bounded(params, "contextId")?;
        let inventory_id = bounded(params, "inventoryId")?;
        self.context = context.clone();
        let selection = selection(params)?;
        let records = required(params, "sources")?
            .as_array()
            .filter(|records| records.len() <= 4096)
            .ok_or_else(|| RequestError::invalid("editor inventory source count is invalid"))?;
        let mut manifest = Vec::with_capacity(records.len());
        let mut index = Vec::new();
        let mut total = 0_usize;
        let mut needed = Vec::new();
        let mut name_work = 0;
        let mut old_index = Vec::new();
        if let Some(old) = &reuse {
            for (position, source) in old.sources.sources().iter().enumerate() {
                let key = source.source_id.as_str();
                let at = search(&old_index, key, &mut name_work)?.unwrap_err();
                old_index.insert(at, (key.to_owned(), position));
            }
        }
        let mut rms = BTreeMap::new();
        let mut xs = BTreeMap::new();
        for record in records {
            if record.get("sourceBase64").is_some() {
                return Err(RequestError::invalid(
                    "inventory begin accepts source descriptors only",
                ));
            }
            let length = required(record, "byteLength")?
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .filter(|v| *v <= FILE_BYTES)
                .ok_or_else(|| RequestError::invalid("editor source exceeds its file bound"))?;
            total = total.saturating_add(length);
            if total > CLOSED_BYTES {
                return Err(RequestError::invalid("editor sources exceed 16 MiB"));
            }
            let mut source = catalog_source_from_json(record, Arc::from([]))?;
            let id = source.source_id.as_str().to_owned();
            let at = search(&index, &id, &mut name_work)?
                .err()
                .ok_or_else(|| RequestError::invalid("duplicate editor source identity"))?;
            index.insert(at, (id.clone(), manifest.len()));
            let old_position = search(&old_index, &id, &mut name_work)?
                .ok()
                .map(|at| old_index[at].1);
            let previous = old_position
                .and_then(|at| reuse.as_ref().map(|old| &old.sources.sources()[at]))
                .filter(|old| {
                    old.raw_hash == source.raw_hash
                        && old.bytes.len() == length
                        && old.role == source.role
                });
            let supplied = if let Some(previous) = previous {
                source.bytes = previous.bytes.clone();
                if let Some(old) = &reuse {
                    if let Some(document) = old.rms.get(&id) {
                        rms.insert(id.clone(), document.clone());
                    }
                    if let Some(file) = old.xs.get(&id) {
                        xs.insert(id.clone(), file.clone());
                    }
                }
                true
            } else {
                needed.push(id);
                false
            };
            manifest.push(Descriptor {
                source,
                length,
                supplied,
            });
        }
        let empty = manifest
            .iter()
            .map(|d| {
                CatalogSource::new(
                    d.source.path.clone(),
                    d.source.source_id.clone(),
                    Arc::<[u8]>::from([]),
                    d.source.origin,
                    d.source.role,
                    d.source.buffer_revision,
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| RequestError::invalid(e.to_string()))?;
        assemble(&selection, empty)?;
        self.selection = Some(selection.clone());
        let mut stage = Stage {
            request,
            context,
            inventory_id,
            round: 0,
            started,
            wire_bytes: 0,
            manifest,
            index,
            name_work,
            selection,
            rms,
            xs,
        };
        stage.charge(params)?;
        let response = json!({"requiredSourceIds": needed, "round": 0});
        stage.charge(&response)?;
        if stage.started.elapsed() >= DEADLINE {
            return Err(stale());
        }
        self.stage = Some(stage);
        Ok(response)
    }

    fn advance(&mut self, params: &Value, commit: bool) -> RequestResult<Value> {
        let mut stage = self
            .stage
            .take()
            .ok_or_else(|| RequestError::unavailable("no editor inventory pass"))?;
        stage.check(params)?;
        stage.charge(params)?;
        if commit {
            if params.get("complete").and_then(Value::as_bool) != Some(true)
                || stage.manifest.iter().any(|d| !d.supplied)
            {
                return Err(RequestError::invalid("editor inventory is incomplete"));
            }
            stage.charge(
                &json!({"contextId":stage.context,"inventoryId":stage.inventory_id,
                "documentEpoch":self.document_epoch,"complete":true}),
            )?;
            let sources = assemble(
                &stage.selection,
                stage.manifest.into_iter().map(|d| d.source).collect(),
            )?;
            if stage.started.elapsed() >= DEADLINE {
                return Err(stale());
            }
            self.active = Some(Arc::new(Inventory {
                sources,
                rms: stage.rms,
                xs: stage.xs,
            }));
            self.inventory_id = Some(stage.inventory_id);
            return Ok(self.stamp());
        }
        let records = required(params, "sources")?
            .as_array()
            .filter(|records| !records.is_empty() && records.len() <= 128)
            .ok_or_else(|| {
                RequestError::invalid("editor body batch must contain 1 to 128 sources")
            })?;
        let mut chunk_bytes = 0_usize;
        for record in records {
            let id = string_field(record, "sourceId")?;
            let at = search(&stage.index, id, &mut stage.name_work)?
                .ok()
                .ok_or_else(|| RequestError::invalid("unrequested editor source body"))?;
            let index = stage.index[at].1;
            let descriptor = &mut stage.manifest[index];
            if descriptor.supplied {
                return Err(RequestError::invalid("duplicate editor source body"));
            }
            chunk_bytes = chunk_bytes.saturating_add(descriptor.length);
            if chunk_bytes > FILE_BYTES {
                return Err(RequestError::invalid("editor append exceeds 4 MiB"));
            }
            let encoded = string_field(record, "sourceBase64")?;
            if encoded.len() > descriptor.length.div_ceil(3) * 4 {
                return Err(RequestError::invalid(
                    "editor encoded source exceeds declared length",
                ));
            }
            let bytes = decode_base64(encoded)?;
            if bytes.len() != descriptor.length {
                return Err(RequestError::invalid(
                    "editor source length differs from its descriptor",
                ));
            }
            descriptor.source.bytes = bytes.into();
            let source = &descriptor.source;
            let checked = CatalogSource::new(
                source.path.clone(),
                source.source_id.clone(),
                source.bytes.clone(),
                source.origin,
                source.role,
                source.buffer_revision,
            )
            .map_err(|e| RequestError::invalid(e.to_string()))?;
            if checked.raw_hash != source.raw_hash {
                return Err(RequestError::invalid("editor source hash is stale"));
            }
            let text = SourceText::from_bytes(source.source_id.clone(), source.bytes.clone())
                .map_err(|e| RequestError::invalid(e.to_string()))?;
            if source.role == SourceCatalogRole::ExternalXs {
                stage
                    .xs
                    .insert(id.to_owned(), xs_analysis::XsFile::parse(text));
            } else {
                stage.rms.insert(
                    id.to_owned(),
                    Arc::new(OpenDocument {
                        version: 0,
                        analysis: analyze_document(&text),
                        source: text,
                        facts: Default::default(),
                    }),
                );
            }
            descriptor.supplied = true;
        }
        stage.round += 1;
        let response = json!({"round": stage.round});
        stage.charge(&response)?;
        self.stage = Some(stage);
        Ok(response)
    }
}

impl Stage {
    fn check(&self, value: &Value) -> RequestResult<()> {
        if self.started.elapsed() >= DEADLINE
            || value.get("requestId").and_then(Value::as_str) != Some(self.request.as_str())
            || value.get("contextId").and_then(Value::as_str) != Some(self.context.as_str())
            || value.get("inventoryId").and_then(Value::as_str) != Some(self.inventory_id.as_str())
            || value.get("round").and_then(Value::as_u64) != Some(self.round)
        {
            return Err(stale());
        }
        Ok(())
    }
    fn charge(&mut self, value: &Value) -> RequestResult<()> {
        let count = json_bytes(value)?;
        self.wire_bytes = self.wire_bytes.saturating_add(count);
        if count > crate::MAX_MESSAGE_BYTES || self.wire_bytes > WIRE_BYTES {
            return Err(RequestError::invalid(
                "editor inventory transport budget exceeded",
            ));
        }
        Ok(())
    }
}

fn assemble(
    selection: &SourceInventory,
    sources: Vec<CatalogSource>,
) -> RequestResult<SourceInventory> {
    SourceInventory::new(
        sources,
        selection.roots().clone(),
        selection.case_sensitive(),
        selection.profile_id().to_owned(),
        selection.content_identity().to_owned(),
        selection.implicit_definitions().clone(),
    )
    .map_err(|e| RequestError::invalid(e.to_string()))
}

fn selection(value: &Value) -> RequestResult<SourceInventory> {
    if json_bytes(value)? > METADATA {
        return Err(RequestError::invalid("editor metadata exceeds 2 MiB"));
    }
    let roots = required(value, "roots")?;
    let opened = required(roots, "openedOrConfigured")?
        .as_array()
        .ok_or_else(|| RequestError::invalid("editor roots must be an array"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| RequestError::invalid("editor root is invalid"))
        })
        .collect::<RequestResult<Vec<_>>>()?;
    let definitions = required(value, "implicitDefinitions")?
        .as_object()
        .ok_or_else(|| RequestError::invalid("editor definitions are invalid"))?
        .iter()
        .map(|(k, v)| {
            v.as_str()
                .map(|v| (k.clone(), v.to_owned()))
                .ok_or_else(|| RequestError::invalid("editor definition is invalid"))
        })
        .collect::<RequestResult<BTreeMap<_, _>>>()?;
    SourceInventory::new(
        Vec::new(),
        ResolverRoots {
            opened_or_configured: opened,
            deployed_map_context: optional_string_field(roots, "deployedMapContext")?,
            game_gamedata_x2: optional_string_field(roots, "gameGamedataX2")?,
            implicit_environment: optional_string_field(roots, "implicitEnvironment")?,
            game_xs: optional_string_field(roots, "gameXs")?,
            standard_includes: standard_include_access(roots)?,
        },
        required(value, "caseSensitive")?
            .as_bool()
            .ok_or_else(|| RequestError::invalid("editor case policy is invalid"))?,
        string_field(value, "profileId")?.to_owned(),
        string_field(value, "contentIdentity")?.to_owned(),
        definitions,
    )
    .map_err(|e| RequestError::invalid(e.to_string()))
}

fn bounded(params: &Value, field: &str) -> RequestResult<String> {
    let value = string_field(params, field)?;
    if value.is_empty() || value.len() > 128 {
        return Err(RequestError::invalid("editor identity is invalid"));
    }
    Ok(value.to_owned())
}

fn version(params: &Value) -> RequestResult<()> {
    if params.get("contractVersion") != Some(&json!({"major":1,"minor":0,"patch":0})) {
        return Err(RequestError::invalid(
            "editor inventory contract version is unsupported",
        ));
    }
    Ok(())
}

fn stale() -> RequestError {
    RequestError {
        code: -32801,
        message: "editor inventory context changed or expired".into(),
    }
}

fn search(
    index: &[(String, usize)],
    key: &str,
    work: &mut usize,
) -> RequestResult<Result<usize, usize>> {
    let (mut low, mut high) = (0, index.len());
    while low < high {
        let mid = low + (high - low) / 2;
        *work = work.saturating_add(index[mid].0.len().min(key.len()) + 1);
        if *work > NAME_WORK {
            return Err(RequestError::invalid(
                "editor identity lookup work exceeds 64 MiB",
            ));
        }
        match index[mid].0.as_str().cmp(key) {
            std::cmp::Ordering::Less => low = mid + 1,
            std::cmp::Ordering::Greater => high = mid,
            std::cmp::Ordering::Equal => return Ok(Ok(mid)),
        }
    }
    Ok(Err(low))
}

fn json_bytes(value: &Value) -> RequestResult<usize> {
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(|e| RequestError::invalid(e.to_string()))?;
    Ok(count.0)
}

impl Server {
    pub(super) fn editor_sources(&self) -> Option<View<'_>> {
        if self.editor.modern {
            self.editor.active.as_ref().map(|v| {
                crate::facts::note_closed_read();
                View::Current(&v.sources)
            })
        } else {
            self.source_catalog.peek().as_ref().map(|catalog| {
                crate::facts::note_closed_read();
                View::Legacy(catalog)
            })
        }
    }

    pub(super) fn editor_inventory_current(&self) -> bool {
        !self.editor.modern || self.editor.active.is_some()
    }

    pub(super) fn editor_selection(&self) -> Option<View<'_>> {
        if self.editor.modern {
            self.editor.selection.as_ref().map(View::Current)
        } else {
            self.source_catalog.peek().as_ref().map(|catalog| {
                crate::facts::note_closed_read();
                View::Legacy(catalog)
            })
        }
    }

    pub(super) fn sync_editor_inventory(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        if !self.editor.modern {
            return;
        }
        *self.catalog_documents = self
            .editor
            .active
            .as_ref()
            .map(|v| v.rms.clone())
            .unwrap_or_default();
        *self.xs.catalog_files = self
            .editor
            .active
            .as_ref()
            .map(|v| v.xs.clone())
            .unwrap_or_default();
        self.xs.invalidate_closed_inputs();
    }

    pub(super) fn editor_inventory_request(&mut self, params: &Value) -> RequestResult<Value> {
        if let Err(error) = version(params) {
            self.editor.clear();
            self.sync_editor_inventory();
            return Err(error);
        }
        let action = match string_field(params, "action") {
            Ok(action) => action,
            Err(error) => {
                self.editor.clear();
                self.sync_editor_inventory();
                return Err(error);
            }
        };
        let result = (|| match action {
            "begin" => self.editor.begin(params),
            "append" => self.editor.advance(params, false),
            "commit" => self.editor.advance(params, true),
            "abort" | "invalidate" => {
                self.editor.modern = true;
                self.editor.clear();
                if action == "invalidate" {
                    self.editor.selection = None;
                    self.editor.context = bounded(params, "contextId")?;
                }
                Ok(self.editor.stamp())
            }
            "state" => Ok(self.editor.stamp()),
            _ => Err(RequestError::invalid(
                "editor inventory action is unsupported",
            )),
        })();
        if result.is_err() {
            self.editor.clear();
        }
        if result.is_err() || matches!(action, "begin" | "commit" | "abort" | "invalidate") {
            self.sync_editor_inventory();
        }
        if action == "commit"
            && result.is_ok()
            && let Err(error) = self.xs.require_complete_resolver()
        {
            self.editor.clear();
            self.sync_editor_inventory();
            return Err(error);
        }
        result
    }

    pub(super) fn check_editor_request(&self, method: &str, params: &Value) -> RequestResult<()> {
        if !self.editor.modern
            || !(method.starts_with("textDocument/") || method == "workspace/symbol")
        {
            return Ok(());
        }
        let proof = required(params, "editorContext")?;
        let stamp = self.editor.stamp();
        for key in ["contextId", "inventoryId", "documentEpoch"] {
            if proof.get(key) != stamp.get(key) {
                return Err(stale());
            }
        }
        if let Ok(uri) = crate::text_document_uri(params) {
            let version = self
                .documents
                .get(uri)
                .map(|d| d.version)
                .or_else(|| self.xs.documents.get(uri).map(|d| d.version));
            if proof.get("documentVersion").and_then(Value::as_i64) != version || version.is_none()
            {
                return Err(stale());
            }
        }
        if matches!(method, "textDocument/prepareRename" | "textDocument/rename") {
            if self.editor.active.is_none() {
                return Err(RequestError::unavailable(
                    "rename requires the complete current editor inventory",
                ));
            }
            self.xs.require_complete_resolver()?;
        }
        Ok(())
    }

    pub(super) fn stamp_editor_publications(&self, notifications: &mut [Value]) {
        if !self.editor.modern {
            return;
        }
        for notification in notifications {
            if notification["method"] == "textDocument/publishDiagnostics" {
                notification["params"]["editorContext"] = self.editor.stamp();
                if notification["params"].get("generationContext").is_none() {
                    notification["params"]["generationContext"] =
                        self.generation_diagnostic_context();
                }
            }
        }
    }
}
