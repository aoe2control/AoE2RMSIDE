use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use rms_analysis::{
    ContentKind, InlayHintKind, LintEnvironment, LintFinding, LintFix, LintSeverity,
    MAXIMUM_LINT_RELATED, Predefined, ProgramView, document_definitions, inlay_hints,
    lint_document, lint_rule, missing_closer_fix, suppression_edit, undefined_name_fix,
};
use rms_engine::LOBBY_LABELS;
use rms_semantics::{ParsedDecisionKind, SemanticProgram, StrictParseOptions, WordDefinitions};
use rms_source::{ByteOffset, ByteRange, SourceCatalog, SourceId, SourceText, Utf16Position};
use rms_syntax::{CstKind, TokenKind};
use serde_json::{Value, json};

use crate::{
    OpenDocument, RequestError, RequestResult, Server, byte_offset, catalog_with_entry_override,
    empty_range, include_syntax, lsp_range, required, text_document_uri,
};

pub(crate) const DISABLE_RULE_COMMAND: &str = "rmside.disableRmsLintRule";

const MAXIMUM_INCLUDE_CLOSURE: usize = 256;

type StrictProgram = (Arc<SemanticProgram>, SourceCatalog);

pub(crate) struct StrictReading<'a> {
    pub program: &'a SemanticProgram,
    pub game_definitions: &'a BTreeMap<String, String>,
    pub setup_definitions: BTreeMap<String, String>,
}

impl<'a> StrictReading<'a> {
    pub fn new(
        program: &'a SemanticProgram,
        game_definitions: &'a BTreeMap<String, String>,
        options: &StrictParseOptions,
    ) -> Self {
        let setup_definitions = options
            .implicit_definitions
            .iter()
            .filter(|(name, value)| game_definitions.get(*name) != Some(*value))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        Self {
            program,
            game_definitions,
            setup_definitions,
        }
    }
}

pub(crate) fn is_entry_script(uri: &str) -> bool {
    let path = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .to_ascii_lowercase();
    path.ends_with(".rms") || path.ends_with(".rms2")
}

fn severity_number(severity: LintSeverity) -> u8 {
    match severity {
        LintSeverity::Warning => 2,
        LintSeverity::Information => 3,
        LintSeverity::Hint => 4,
    }
}

pub(crate) fn finding_json(
    source: &SourceText,
    finding: &LintFinding,
    source_of: &dyn Fn(&SourceId) -> Option<SourceText>,
) -> Option<Value> {
    let mut value = json!({
        "range": lsp_range(source, finding.range)?,
        "severity": severity_number(finding.severity),
        "code": finding.code,
        "source": "rms-ls",
        "message": finding.message,
    });
    if finding.unnecessary {
        value["tags"] = json!([1]);
    }
    let related = finding
        .related
        .iter()
        .take(MAXIMUM_LINT_RELATED)
        .filter_map(|related| {
            let (uri, range) = match &related.source_id {
                None => (
                    source.id().as_str().to_owned(),
                    lsp_range(source, related.range)?,
                ),
                Some(id) => (
                    id.as_str().to_owned(),
                    lsp_range(&source_of(id)?, related.range)?,
                ),
            };
            Some(json!({
                "location": { "uri": uri, "range": range },
                "message": related.message,
            }))
        })
        .collect::<Vec<_>>();
    if !related.is_empty() {
        value["relatedInformation"] = Value::Array(related);
    }
    Some(value)
}

fn edits_json(source: &SourceText, fix: &LintFix) -> Option<Vec<Value>> {
    fix.edits
        .iter()
        .map(|edit| {
            Some(json!({
                "range": lsp_range(source, edit.range)?,
                "newText": edit.replacement,
            }))
        })
        .collect()
}

fn fix_action(uri: &str, source: &SourceText, fix: &LintFix, diagnostic: Value) -> Option<Value> {
    let edits = edits_json(source, fix)?;
    Some(json!({
        "title": fix.title,
        "kind": "quickfix",
        "isPreferred": fix.preferred,
        "diagnostics": [diagnostic],
        "edit": { "changes": { uri: edits } },
    }))
}

pub(crate) fn request_range(source: &SourceText, params: &Value) -> RequestResult<ByteRange> {
    let range = required(params, "range")?;
    let position = |name: &str| -> RequestResult<ByteOffset> {
        let value = required(range, name)?;
        let field = |field: &str| {
            value
                .get(field)
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| RequestError::invalid(format!("range {field} is invalid")))
        };
        let position = Utf16Position {
            line: field("line")?,
            character: field("character")?,
        };
        if position.line >= source.line_index().line_count() {
            return Ok(ByteOffset(source.bytes().len() as u32));
        }
        byte_offset(source, position)
    };
    Ok(ByteRange {
        start: position("start")?,
        end: position("end")?,
    })
}

fn overlaps(left: ByteRange, right: ByteRange) -> bool {
    left.start <= right.end && right.start <= left.end
}

#[derive(Default)]
pub(crate) struct DocumentFacts {
    defined: Vec<String>,
    values: Vec<(String, Option<String>)>,
    identifiers: Vec<String>,
}

impl OpenDocument {
    pub(crate) fn facts(&self) -> &DocumentFacts {
        self.facts.get_or_init(|| DocumentFacts {
            defined: definitions_of(self).collect(),
            values: document_definitions(&self.source, &self.analysis),
            identifiers: self
                .analysis
                .cst
                .tokens
                .iter()
                .filter(|token| token.kind == TokenKind::Identifier)
                .map(|token| String::from_utf8_lossy(token.bytes(&self.source)).into_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        })
    }
}

fn definitions_of(document: &OpenDocument) -> impl Iterator<Item = String> + '_ {
    document
        .analysis
        .cst
        .nodes
        .iter()
        .filter(|node| node.kind == CstKind::Definition)
        .filter_map(|node| {
            let mut tokens = document.analysis.cst.tokens
                [node.token_start as usize..node.token_end as usize]
                .iter()
                .filter(|token| !token.kind.is_trivia());
            let _directive = tokens.next()?;
            let name = tokens.next()?;
            (name.kind == TokenKind::Identifier)
                .then(|| String::from_utf8_lossy(name.bytes(&document.source)).into_owned())
        })
}

impl Server {
    pub(crate) fn install_lint_settings(&mut self, params: &Value) -> RequestResult<()> {
        let rules = required(params, "disabledRules")?
            .as_array()
            .ok_or_else(|| RequestError::invalid("disabledRules must be an array"))?;
        if rules.len() > 64 {
            return Err(RequestError::invalid("disabledRules lists too many rules"));
        }
        let mut disabled = BTreeSet::new();
        for rule in rules {
            let code = rule
                .as_str()
                .ok_or_else(|| RequestError::invalid("a disabled rule must be a code string"))?;
            if lint_rule(code).is_none() {
                return Err(RequestError::invalid(format!(
                    "{code} is not an RMS lint rule"
                )));
            }
            disabled.insert(code.to_owned());
        }
        self.lint_disabled = disabled;
        Ok(())
    }

    pub(crate) fn implicit_names(&self, setup: Option<&StrictParseOptions>) -> BTreeSet<String> {
        match setup {
            Some(options) => options.implicit_definitions.keys().cloned().collect(),
            None => self
                .vocabulary()
                .keys()
                .cloned()
                .chain(self.run_setting_labels().into_keys())
                .chain(LOBBY_LABELS.iter().map(|label| (*label).to_owned()))
                .collect(),
        }
    }

    fn implicit_values(&self, setup: Option<&StrictParseOptions>) -> BTreeMap<String, String> {
        let mut values = match setup {
            Some(options) => options.implicit_definitions.clone(),
            None => {
                let mut values = self.vocabulary().clone();
                values.extend(self.run_setting_labels());
                values
            }
        };
        for label in LOBBY_LABELS {
            values
                .entry((*label).to_owned())
                .or_insert_with(|| "1".to_owned());
        }
        values
    }

    pub(crate) fn lint_findings(
        &self,
        uri: &str,
        document: &OpenDocument,
        strict: Option<&StrictReading<'_>>,
        setup: Option<&StrictParseOptions>,
    ) -> Vec<LintFinding> {
        let mut known = self.implicit_names(setup);
        let mut values = BTreeMap::<String, Vec<Option<String>>>::new();
        for (name, value) in self.implicit_values(setup) {
            values.entry(name).or_default().push(Some(value));
        }
        for (candidate_uri, candidate) in self.analysis_documents() {
            if candidate_uri != uri {
                let facts = candidate.facts();
                known.extend(facts.defined.iter().cloned());
                for (name, value) in &facts.values {
                    values.entry(name.clone()).or_default().push(value.clone());
                }
            }
        }
        let entry = is_entry_script(uri);
        let external = (entry && !self.lint_disabled.contains(rms_analysis::UNUSED_DEFINITION))
            .then(|| self.include_closure_names(uri))
            .flatten();
        let included_definitions = (entry
            && !self
                .lint_disabled
                .contains(rms_analysis::POSSIBLY_UNDEFINED_NAME))
        .then(|| self.include_closure_definitions(uri))
        .flatten();
        let vocabulary = self.vocabulary();
        let run_labels = self.run_setting_labels();
        let predefined = |name: &str| {
            if LOBBY_LABELS.binary_search(&name).is_ok() || run_labels.contains_key(name) {
                Predefined::Maybe
            } else if vocabulary.contains_key(name) {
                Predefined::Always
            } else if setup.is_some_and(|options| options.implicit_definitions.contains_key(name))
                || included_definitions
                    .as_ref()
                    .is_some_and(|names| names.contains(name))
            {
                Predefined::Maybe
            } else {
                Predefined::Never
            }
        };
        let source_of = |id: &SourceId| -> Option<&SourceText> {
            if id.as_str() == uri {
                return Some(&document.source);
            }
            self.documents
                .get(id.as_str())
                .map(std::sync::Arc::as_ref)
                .or_else(|| {
                    self.catalog_documents
                        .get(id.as_str())
                        .map(std::sync::Arc::as_ref)
                })
                .map(|document| &document.source)
        };
        let defined_elsewhere = |name: &str| known.contains(name);
        let definitions_elsewhere = |name: &str| match values.get(name) {
            None => WordDefinitions::Undefined,
            Some(list) => list
                .iter()
                .cloned()
                .collect::<Option<Vec<_>>>()
                .map_or(WordDefinitions::Unknown, WordDefinitions::Values),
        };
        let environment = LintEnvironment {
            external_names: external.as_ref(),
            defined_elsewhere: &defined_elsewhere,
            definitions_elsewhere: &definitions_elsewhere,
            is_entry_script: entry,
            program: strict.map(|strict| ProgramView {
                program: strict.program,
                game_definitions: strict.game_definitions,
                setup_definitions: &strict.setup_definitions,
                source: &source_of,
            }),
            predefined: included_definitions
                .is_some()
                .then_some(&predefined as &dyn Fn(&str) -> Predefined),
            disabled: &self.lint_disabled,
        };
        lint_document(&document.source, &document.analysis, &environment)
    }

    fn include_closure_names(&self, uri: &str) -> Option<BTreeSet<String>> {
        self.include_closure_facts(uri, |facts| &facts.identifiers)
    }

    fn include_closure_definitions(&self, uri: &str) -> Option<BTreeSet<String>> {
        self.include_closure_facts(uri, |facts| &facts.defined)
    }

    fn include_closure_facts(
        &self,
        uri: &str,
        names_of: impl Fn(&DocumentFacts) -> &Vec<String>,
    ) -> Option<BTreeSet<String>> {
        let documents = self.analysis_documents();
        let find = |target: &str| {
            documents
                .iter()
                .find(|(candidate, _)| *candidate == target)
                .map(|(_, document)| *document)
        };
        let mut names = BTreeSet::new();
        let mut visited = BTreeSet::from([uri.to_owned()]);
        let mut queue = VecDeque::from([uri.to_owned()]);
        while let Some(current) = queue.pop_front() {
            let document = find(&current)?;
            if current != uri {
                names.extend(names_of(document.facts()).iter().cloned());
            }
            let includes = include_syntax(document)
                .into_iter()
                .filter(|include| !include.external_xs)
                .collect::<Vec<_>>();
            for link in self.resolve_includes(&current, includes) {
                let target = link.target.ok()?;
                if visited.len() >= MAXIMUM_INCLUDE_CLOSURE {
                    return None;
                }
                if visited.insert(target.clone()) {
                    queue.push_back(target);
                }
            }
        }
        Some(names)
    }

    fn strict_parts(
        &self,
        uri: &str,
        document: &OpenDocument,
    ) -> (Option<StrictParseOptions>, Option<StrictProgram>) {
        let Some(catalog) = self
            .source_catalog
            .as_ref()
            .filter(|catalog| crate::is_catalog_entry(catalog, uri))
        else {
            return (
                self.preview_context
                    .strict_options(self.source_catalog.as_ref())
                    .ok(),
                None,
            );
        };
        let Ok(effective) = self.effective_catalog(catalog, document) else {
            return (
                self.preview_context.strict_options(Some(catalog)).ok(),
                None,
            );
        };
        let Ok(options) = self.preview_context.strict_options(Some(&effective)) else {
            return (None, None);
        };
        let program = self
            .analyze_catalog_shared(&effective, options.clone())
            .ok();
        (Some(options), program.map(|program| (program, effective)))
    }

    pub(crate) fn rms_code_actions(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        let requested = request_range(&document.source, params)?;
        Ok(Value::Array(
            self.rms_code_actions_for(uri, document, &[requested], None)
                .pop()
                .unwrap_or_default(),
        ))
    }

    pub(crate) fn rms_code_actions_for(
        &self,
        uri: &str,
        document: &OpenDocument,
        ranges: &[ByteRange],
        findings: Option<&[LintFinding]>,
    ) -> Vec<Vec<Value>> {
        let (options, strict_parts) = self.strict_parts(uri, document);
        let strict =
            strict_parts
                .as_ref()
                .zip(options.as_ref())
                .map(|((program, catalog), options)| {
                    StrictReading::new(program, catalog.implicit_definitions(), options)
                });
        let computed;
        let findings = match findings {
            Some(findings) => findings,
            None => {
                computed = self.lint_findings(uri, document, strict.as_ref(), options.as_ref());
                &computed
            }
        };
        let source = &document.source;
        let mut defined_names: Option<BTreeSet<String>> = None;
        let mut rejected = None;
        ranges
            .iter()
            .map(|&requested| {
                let mut actions = Vec::new();
                let mut silenced_lines = BTreeSet::new();
                for finding in findings {
                    if !overlaps(finding.range, requested) {
                        continue;
                    }
                    let Some(diagnostic) =
                        finding_json(source, finding, &|id| self.generation_source(id.as_str()))
                    else {
                        continue;
                    };
                    if let Some(fix) = &finding.fix {
                        actions.extend(fix_action(uri, source, fix, diagnostic.clone()));
                    }
                    let line = source
                        .byte_to_utf16(finding.range.start)
                        .map_or(0, |position| position.line);
                    if silenced_lines.insert((line, finding.code)) {
                        let silence = LintFix {
                            title: format!("Ignore {} on this line", finding.code),
                            edits: vec![suppression_edit(
                                source,
                                finding.range.start,
                                finding.code,
                            )],
                            preferred: false,
                        };
                        actions.extend(fix_action(uri, source, &silence, diagnostic.clone()));
                        actions.push(json!({
                            "title": format!("Turn off {} in this workspace", finding.code),
                            "kind": "quickfix",
                            "isPreferred": false,
                            "diagnostics": [diagnostic],
                            "command": {
                                "title": format!("Turn off {} in this workspace", finding.code),
                                "command": DISABLE_RULE_COMMAND,
                                "arguments": [finding.code],
                            },
                        }));
                    }
                }
                for diagnostic in &document.analysis.diagnostics {
                    if !matches!(diagnostic.code.as_str(), "RMS1103" | "RMS1104")
                        || !overlaps(diagnostic.range, requested)
                    {
                        continue;
                    }
                    let Some(fix) = missing_closer_fix(
                        source,
                        &document.analysis,
                        &diagnostic.code,
                        diagnostic.range,
                    ) else {
                        continue;
                    };
                    let Some(range) = lsp_range(source, diagnostic.range) else {
                        continue;
                    };
                    actions.extend(fix_action(
                        uri,
                        source,
                        &fix,
                        json!({
                            "range": range,
                            "severity": 1,
                            "code": diagnostic.code,
                            "source": "rms-ls",
                            "message": diagnostic.message,
                        }),
                    ));
                }
                if let Some(((program, catalog), options)) =
                    strict_parts.as_ref().zip(options.as_ref())
                {
                    let undefined = program
                        .decisions
                        .iter()
                        .filter(|decision| {
                            decision.kind == ParsedDecisionKind::UndefinedNumericFallback
                                && decision.source_id.as_str() == uri
                                && overlaps(decision.source_range, requested)
                        })
                        .filter_map(|decision| Some((decision, decision.values.first()?)))
                        .collect::<Vec<_>>();
                    if undefined.is_empty() {
                        return actions;
                    }
                    let defined = defined_names.get_or_insert_with(|| {
                        let mut defined = BTreeSet::new();
                        defined.extend(catalog.implicit_definitions().keys().cloned());
                        defined.extend(options.implicit_definitions.keys().cloned());
                        for (_, candidate) in self.analysis_documents() {
                            defined.extend(candidate.facts().defined.iter().cloned());
                        }
                        defined.extend(definitions_of(document));
                        defined
                    });
                    let defined = defined.iter().map(String::as_str).collect::<Vec<_>>();
                    for (decision, name) in undefined {
                        let Some(fix) = undefined_name_fix(
                            source,
                            &document.analysis,
                            decision.source_range,
                            name,
                            &defined,
                        ) else {
                            continue;
                        };
                        actions.extend(fix_action(
                            uri,
                            source,
                            &fix,
                            json!({
                                "range": lsp_range(source, decision.source_range).unwrap_or_else(empty_range),
                                "severity": 2,
                                "code": "RMS2034",
                                "source": "rms-ls",
                                "message": format!(
                                    "{name} is not defined where {} reads it, so it counts as {}.",
                                    crate::source_file_name(decision.source_id.as_str()),
                                    decision.values.get(1).map_or("0", String::as_str)
                                ),
                            }),
                        ));
                    }
                } else if let Some(options) = options.as_ref() {
                    let rejection = rejected.get_or_insert_with(|| {
                        self.source_catalog
                            .as_ref()
                            .filter(|catalog| crate::is_catalog_entry(catalog, uri))
                            .and_then(|catalog| {
                                catalog_with_entry_override(
                                    catalog,
                                    Some(source),
                                    document.version,
                                )
                                .ok()
                            })
                            .and_then(|effective| {
                                let error = self
                                    .analyze_catalog_shared(&effective, options.clone())
                                    .err()?;
                                Some((effective, error))
                            })
                    });
                    if let Some((effective, error)) = rejection.as_ref()
                        && error.code == "RMS2032"
                        && error
                            .source_chain
                            .last()
                            .is_none_or(|last| last.as_str() == uri)
                        && let Some(range) = error.range
                        && overlaps(range, requested)
                        && let Some(name) = error
                            .message
                            .strip_suffix(" is not a defined numeric value")
                    {
                        let mut defined = effective
                            .implicit_definitions()
                            .keys()
                            .cloned()
                            .collect::<BTreeSet<_>>();
                        defined.extend(options.implicit_definitions.keys().cloned());
                        for (_, candidate) in self.analysis_documents() {
                            defined.extend(candidate.facts().defined.iter().cloned());
                        }
                        let defined = defined.iter().map(String::as_str).collect::<Vec<_>>();
                        if let Some(fix) =
                            undefined_name_fix(source, &document.analysis, range, name, &defined)
                        {
                            actions.extend(fix_action(
                                uri,
                                source,
                                &fix,
                                json!({
                                    "range": lsp_range(source, range).unwrap_or_else(empty_range),
                                    "severity": 1,
                                    "code": "RMS2032",
                                    "source": "rms-ls",
                                    "message": error.message,
                                }),
                            ));
                        }
                    }
                }
                actions
            })
            .collect()
    }

    pub(crate) fn rms_inlay_hints(&self, params: &Value) -> RequestResult<Value> {
        let uri = text_document_uri(params)?;
        let document = self.document(uri)?;
        let requested = request_range(&document.source, params)?;
        let (_, strict_parts) = self.strict_parts(uri, document);
        let values = strict_parts
            .as_ref()
            .map(|(program, _)| self.script_constant_values(uri, document, program))
            .unwrap_or_default();
        let value_of = |name: &str| values.get(name).cloned();
        let hints = inlay_hints(&document.source, &document.analysis, requested, &value_of);
        Ok(Value::Array(
            hints
                .into_iter()
                .filter_map(|hint| {
                    let position = document.source.byte_to_utf16(hint.position).ok()?;
                    let mut value = json!({
                        "position": { "line": position.line, "character": position.character },
                        "label": hint.label,
                    });
                    match hint.kind {
                        InlayHintKind::Parameter => {
                            value["kind"] = json!(2);
                            value["paddingRight"] = json!(true);
                        }
                        InlayHintKind::Value => {
                            value["kind"] = json!(1);
                            value["paddingLeft"] = json!(true);
                        }
                        InlayHintKind::Content(kind) => {
                            value["kind"] = json!(1);
                            value["paddingLeft"] = json!(true);
                            value["data"] = json!({
                                "rmsContent": {
                                    "kind": match kind {
                                        ContentKind::Object => "object",
                                        ContentKind::Terrain => "terrain",
                                    },
                                    "id": hint.content_id,
                                }
                            });
                        }
                    }
                    Some(value)
                })
                .collect(),
        ))
    }

    fn script_constant_values(
        &self,
        uri: &str,
        document: &OpenDocument,
        program: &SemanticProgram,
    ) -> BTreeMap<String, String> {
        let mut values = BTreeMap::new();
        for decision in &program.decisions {
            if decision.kind != ParsedDecisionKind::Definition || !decision.result {
                continue;
            }
            let source = if decision.source_id.as_str() == uri {
                Some(document.source.clone())
            } else {
                self.generation_source(decision.source_id.as_str())
            };
            let Some(source) = source else {
                continue;
            };
            let start = decision.source_range.start.0 as usize;
            let end = (decision.source_range.end.0 as usize).min(source.bytes().len());
            let Some(statement) = source.bytes().get(start..end) else {
                continue;
            };
            let mut words = statement
                .split(u8::is_ascii_whitespace)
                .filter(|word| !word.is_empty());
            if words.next() != Some(b"#const".as_slice()) {
                continue;
            }
            let (Some(name), Some(value)) = (words.next(), decision.values.first()) else {
                continue;
            };
            values
                .entry(String::from_utf8_lossy(name).into_owned())
                .or_insert_with(|| value.clone());
        }
        values
    }
}
