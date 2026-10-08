use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rms_engine::LOBBY_LABELS;
use rms_source::{ByteOffset, ByteRange, SourceText};
use rms_syntax::{Token, TokenKind};
use serde_json::{Value, json};

use crate::{
    OpenDocument, RequestResult, Server, byte_offset, include_file_name, include_syntax, lsp_range,
    request_position, token_at,
};

const HIGHLIGHT_READ: u8 = 2;
const HIGHLIGHT_WRITE: u8 = 3;

pub(crate) struct DefinitionToken<'d> {
    pub(crate) constant: bool,
    pub(crate) name: &'d Token,
    pub(crate) value: Option<&'d Token>,
}

pub(crate) fn definition_tokens(document: &OpenDocument) -> Vec<DefinitionToken<'_>> {
    let source = &document.source;
    let significant = document
        .analysis
        .cst
        .tokens
        .iter()
        .filter(|token| !token.kind.is_trivia())
        .collect::<Vec<_>>();
    let mut found = Vec::new();
    for (index, token) in significant.iter().enumerate() {
        let constant = match token.bytes(source) {
            b"#const" => true,
            b"#define" => false,
            _ => continue,
        };
        let Some(name) = significant
            .get(index + 1)
            .filter(|name| name.kind == TokenKind::Identifier)
        else {
            continue;
        };
        let value = constant
            .then(|| significant.get(index + 2).copied())
            .flatten()
            .filter(|value| !matches!(value.kind, TokenKind::LBrace | TokenKind::RBrace));
        found.push(DefinitionToken {
            constant,
            name,
            value,
        });
    }
    found
}

pub(crate) fn name_at(document: &OpenDocument, offset: ByteOffset) -> Option<(&Token, String)> {
    let token = token_at(document, offset)?;
    (token.kind == TokenKind::Identifier).then(|| {
        (
            token,
            String::from_utf8_lossy(token.bytes(&document.source)).into_owned(),
        )
    })
}

pub(crate) fn occurrences<'d>(document: &'d OpenDocument, name: &str) -> Vec<&'d Token> {
    document
        .analysis
        .cst
        .tokens
        .iter()
        .filter(|token| {
            token.kind == TokenKind::Identifier && token.bytes(&document.source) == name.as_bytes()
        })
        .collect()
}

fn location(uri: &str, source: &SourceText, range: ByteRange) -> Option<Value> {
    Some(json!({ "uri": uri, "range": lsp_range(source, range)? }))
}

impl Server {
    fn analysis_document(&self, uri: &str) -> Option<&OpenDocument> {
        self.documents
            .get(uri)
            .map(std::sync::Arc::as_ref)
            .or_else(|| self.catalog_documents.get(uri).map(std::sync::Arc::as_ref))
    }

    pub(crate) fn include_closure<'a>(
        &'a self,
        uri: &str,
        document: &'a OpenDocument,
    ) -> Vec<(String, &'a OpenDocument)> {
        let mut documents = vec![(uri.to_owned(), document)];
        let mut visited = BTreeSet::from([uri.to_owned()]);
        let mut next = 0;
        while let Some((current, current_document)) = documents
            .get(next)
            .map(|(current, found)| (current.clone(), *found))
        {
            next += 1;
            let includes = include_syntax(current_document)
                .into_iter()
                .filter(|include| !include.external_xs)
                .collect::<Vec<_>>();
            for link in self.resolve_includes(&current, includes) {
                let Ok(target) = link.target else {
                    continue;
                };
                if visited.len() >= crate::rms_completion::MAXIMUM_INCLUDE_CLOSURE {
                    break;
                }
                if visited.insert(target.clone())
                    && let Some(found) = self.analysis_document(&target)
                {
                    documents.push((target, found));
                }
            }
        }
        if let Some(catalog) = self.editor_sources()
            && catalog
                .sources()
                .iter()
                .any(|source| source.source_id.as_str() == uri)
        {
            for source in catalog.sources() {
                let id = source.source_id.as_str();
                if visited.insert(id.to_owned())
                    && let Some(found) = self.analysis_document(id)
                {
                    documents.push((id.to_owned(), found));
                }
            }
        }
        documents
    }

    fn related_documents<'a>(
        &'a self,
        uri: &str,
        document: &'a OpenDocument,
    ) -> Vec<(String, &'a OpenDocument)> {
        let mut related = self.include_closure(uri, document);
        let mut known = related
            .iter()
            .map(|(known, _)| known.clone())
            .collect::<BTreeSet<_>>();
        for (candidate_uri, candidate) in &self.documents {
            if known.contains(candidate_uri) {
                continue;
            }
            let includes = include_syntax(candidate)
                .into_iter()
                .filter(|include| !include.external_xs)
                .collect::<Vec<_>>();
            if includes.is_empty() {
                continue;
            }
            let includes_this = self
                .resolve_includes(candidate_uri, includes)
                .iter()
                .any(|link| link.target.as_deref() == Ok(uri));
            if !includes_this {
                continue;
            }
            for (member, found) in self.include_closure(candidate_uri, candidate) {
                if known.insert(member.clone()) {
                    related.push((member, found));
                }
            }
        }
        related
    }

    pub(crate) fn rms_definition(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let includes = include_syntax(document)
            .into_iter()
            .filter(|include| crate::range_contains(include.statement, offset))
            .take(1)
            .collect();
        if let Some(link) = self.resolve_includes(uri, includes).first() {
            return Ok(link.target.as_ref().map_or(
                Value::Null,
                |target| json!({ "uri": target, "range": crate::empty_range() }),
            ));
        }
        let Some((_, name)) = name_at(document, offset) else {
            return Ok(Value::Null);
        };
        let locations = self
            .related_documents(uri, document)
            .into_iter()
            .flat_map(|(candidate_uri, candidate)| {
                definition_tokens(candidate)
                    .into_iter()
                    .filter(|definition| {
                        definition.name.bytes(&candidate.source) == name.as_bytes()
                    })
                    .filter_map(|definition| {
                        location(&candidate_uri, &candidate.source, definition.name.range)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        Ok(if locations.is_empty() {
            Value::Null
        } else {
            Value::Array(locations)
        })
    }

    pub(crate) fn rms_references(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let Some((_, name)) = name_at(document, offset) else {
            return Ok(json!([]));
        };
        let declarations = params
            .pointer("/context/includeDeclaration")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut locations = Vec::new();
        for (candidate_uri, candidate) in self.related_documents(uri, document) {
            let defined = definition_tokens(candidate)
                .into_iter()
                .map(|definition| definition.name.range.start)
                .collect::<BTreeSet<_>>();
            for token in occurrences(candidate, &name) {
                if !declarations && defined.contains(&token.range.start) {
                    continue;
                }
                locations.extend(location(&candidate_uri, &candidate.source, token.range));
            }
        }
        Ok(Value::Array(locations))
    }

    pub(crate) fn rms_document_highlight(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let Some((_, name)) = name_at(document, offset) else {
            return Ok(json!([]));
        };
        let defined = definition_tokens(document)
            .into_iter()
            .map(|definition| definition.name.range.start)
            .collect::<BTreeSet<_>>();
        Ok(Value::Array(
            occurrences(document, &name)
                .into_iter()
                .filter_map(|token| {
                    Some(json!({
                        "range": lsp_range(&document.source, token.range)?,
                        "kind": if defined.contains(&token.range.start) {
                            HIGHLIGHT_WRITE
                        } else {
                            HIGHLIGHT_READ
                        },
                    }))
                })
                .collect(),
        ))
    }

    pub(crate) fn rms_rename_plan<'a>(
        &'a self,
        uri: &str,
        document: &'a OpenDocument,
        name: &str,
    ) -> Result<RenamePlan<'a>, String> {
        if self.vocabulary().contains_key(name) {
            return Err(format!(
                "'{name}' is defined by the game, so it cannot be renamed."
            ));
        }
        if LOBBY_LABELS.contains(&name) || self.run_setting_labels().contains_key(name) {
            return Err(format!(
                "'{name}' is set by the run settings, so it cannot be renamed."
            ));
        }
        let graph = IncludeGraph::new(self, uri, document);
        let mut edited = BTreeSet::from([uri.to_owned()]);
        let mut scope = BTreeSet::new();
        let mut queue = VecDeque::from([uri.to_owned()]);
        while let Some(current) = queue.pop_front() {
            let shared = graph.shared_with(&current);
            if let Some(path) = shared.unreadable.first() {
                return Err(format!(
                    "'{name}' may also be used in {}, which is not open; open it to rename there too.",
                    include_file_name(path)
                ));
            }
            for member in shared.members {
                let Some(found) = graph.documents.get(member.as_str()) else {
                    continue;
                };
                if !occurrences(found, name).is_empty() && edited.insert(member.clone()) {
                    queue.push_back(member.clone());
                }
                scope.insert(member);
            }
            if scope.len() > crate::rms_completion::MAXIMUM_INCLUDE_CLOSURE {
                return Err(format!(
                    "'{name}' is used across too many files to rename them together."
                ));
            }
        }
        let mut files = vec![(uri.to_owned(), document)];
        for other in edited.iter().filter(|other| other.as_str() != uri) {
            if self.is_game_source(other) {
                return Err(format!(
                    "'{name}' is also used in {}, a game file, so it cannot be renamed.",
                    include_file_name(other)
                ));
            }
            let Some(open) = self.documents.get(other) else {
                return Err(format!(
                    "'{name}' is also used in {}, which is not open; open it to rename there too.",
                    include_file_name(other)
                ));
            };
            files.push((other.clone(), open));
        }
        let catalog_entry = self
            .source_catalog
            .as_ref()
            .and_then(|catalog| crate::catalog_entry(catalog).ok())
            .map(|entry| entry.source_id.as_str().to_owned());
        let mut entries = scope
            .iter()
            .filter(|member| {
                (self.documents.contains_key(member.as_str())
                    && crate::rms_lint::is_entry_script(member))
                    || catalog_entry.as_deref() == Some(member.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        if entries.is_empty() {
            entries.push(uri.to_owned());
        }
        let scope = scope
            .into_iter()
            .filter_map(|member| {
                let found = graph.documents.get(member.as_str())?;
                Some((member, *found))
            })
            .collect();
        Ok(RenamePlan {
            files,
            scope,
            entries,
        })
    }
}

pub(crate) struct RenamePlan<'a> {
    pub(crate) files: Vec<(String, &'a OpenDocument)>,
    pub(crate) scope: Vec<(String, &'a OpenDocument)>,
    pub(crate) entries: Vec<String>,
}

struct SharedGraph {
    members: Vec<String>,
    unreadable: Vec<String>,
}

struct IncludeGraph<'a> {
    documents: BTreeMap<String, &'a OpenDocument>,
    includes: BTreeMap<String, Vec<crate::IncludeLink>>,
    included_by: BTreeMap<String, BTreeSet<String>>,
    in_catalog: BTreeSet<String>,
    standard_includes: Vec<String>,
}

impl<'a> IncludeGraph<'a> {
    fn new(server: &'a Server, uri: &str, document: &'a OpenDocument) -> Self {
        let mut documents = server
            .analysis_documents()
            .into_iter()
            .map(|(candidate, found)| (candidate.to_owned(), found))
            .collect::<BTreeMap<_, _>>();
        documents.insert(uri.to_owned(), document);
        let mut includes = BTreeMap::new();
        let mut included_by = BTreeMap::<String, BTreeSet<String>>::new();
        let with_includes = documents
            .iter()
            .filter_map(|(candidate, found)| {
                let lines = include_syntax(found)
                    .into_iter()
                    .filter(|include| !include.external_xs)
                    .collect::<Vec<_>>();
                (!lines.is_empty()).then(|| (candidate.clone(), lines))
            })
            .collect();
        for (candidate, links) in server.resolve_rms_includes_of(with_includes) {
            for link in &links {
                if let Ok(target) = &link.target {
                    included_by
                        .entry(target.clone())
                        .or_default()
                        .insert(candidate.clone());
                }
            }
            includes.insert(candidate.clone(), links);
        }
        let in_catalog = server
            .editor_sources()
            .map(|catalog| {
                catalog
                    .sources()
                    .iter()
                    .map(|source| source.source_id.as_str().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let standard_includes = crate::rms_completion::standard_include_names(
            server.editor_sources().map(|catalog| catalog.profile_id()),
        );
        Self {
            documents,
            includes,
            included_by,
            in_catalog,
            standard_includes,
        }
    }

    fn shared_with(&self, start: &str) -> SharedGraph {
        let mut roots = BTreeSet::from([start.to_owned()]);
        let mut queue = VecDeque::from([start.to_owned()]);
        while let Some(current) = queue.pop_front() {
            for includer in self.included_by.get(&current).into_iter().flatten() {
                if roots.len() > crate::rms_completion::MAXIMUM_INCLUDE_CLOSURE {
                    break;
                }
                if roots.insert(includer.clone()) {
                    queue.push_back(includer.clone());
                }
            }
        }
        let mut members = roots.clone();
        let mut queue = roots.into_iter().collect::<VecDeque<_>>();
        let mut unreadable = Vec::new();
        while let Some(current) = queue.pop_front() {
            for link in self.includes.get(&current).into_iter().flatten() {
                match &link.target {
                    Ok(target) => {
                        if members.len() > crate::rms_completion::MAXIMUM_INCLUDE_CLOSURE {
                            break;
                        }
                        if members.insert(target.clone()) {
                            queue.push_back(target.clone());
                        }
                    }
                    Err(_)
                        if !self.in_catalog.contains(&current)
                            && !self
                                .standard_includes
                                .iter()
                                .any(|standard| standard.eq_ignore_ascii_case(&link.path)) =>
                    {
                        unreadable.push(link.path.clone());
                    }
                    Err(_) => {}
                }
            }
        }
        SharedGraph {
            members: members.into_iter().collect(),
            unreadable,
        }
    }
}
