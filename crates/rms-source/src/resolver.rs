use std::collections::{BTreeMap, BTreeSet, VecDeque};

use thiserror::Error;

use crate::{SourceId, SourceText};

const MAX_INCLUDE_PATH_BYTES: usize = 4096;
const MAX_RESOLVER_SOURCES: usize = 65_536;
const MAX_DEPENDENCIES_PER_SOURCE: usize = 4096;
const MAX_STANDARD_INCLUDES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncludePath(String);

impl IncludePath {
    pub fn new(value: impl Into<String>) -> Result<Self, ResolutionDiagnostic> {
        let value = value.into().replace('\\', "/");
        if value.is_empty()
            || value.len() > MAX_INCLUDE_PATH_BYTES
            || value.starts_with('/')
            || value.contains(':')
            || value
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(ResolutionDiagnostic::new(
                ResolutionDiagnosticKind::PathTraversal,
                "include path must be relative and cannot traverse directories",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResolverRoots {
    pub opened_or_configured: Vec<String>,
    pub deployed_map_context: Option<String>,
    pub game_gamedata_x2: Option<String>,
    pub implicit_environment: Option<String>,
    pub game_xs: Option<String>,
    pub standard_includes: StandardIncludeAccess,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StandardIncludeAccess {
    pub identifiers: Vec<String>,
    pub authorized: bool,
}

impl StandardIncludeAccess {
    pub fn new(
        identifiers: impl IntoIterator<Item = impl AsRef<str>>,
        authorized: bool,
    ) -> Result<Self, ResolutionDiagnostic> {
        let mut canonical = identifiers
            .into_iter()
            .map(|identifier| {
                IncludePath::new(identifier.as_ref()).map(|path| path.0.to_ascii_lowercase())
            })
            .collect::<Result<Vec<_>, _>>()?;
        canonical.sort();
        canonical.dedup();
        if canonical.len() > MAX_STANDARD_INCLUDES {
            return Err(ResolutionDiagnostic::new(
                ResolutionDiagnosticKind::ResourceLimit,
                "standard include inventory exceeds its bounded size",
            ));
        }
        Ok(Self {
            identifiers: canonical,
            authorized,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.identifiers.is_empty() && !self.authorized
    }

    fn contains(&self, include: &IncludePath) -> bool {
        self.identifiers
            .binary_search(&include.as_str().to_ascii_lowercase())
            .is_ok()
    }

    pub(crate) fn validate(&self) -> Result<(), ResolutionDiagnostic> {
        let canonical = Self::new(&self.identifiers, self.authorized)?;
        if canonical.identifiers != self.identifiers {
            return Err(ResolutionDiagnostic::new(
                ResolutionDiagnosticKind::PathTraversal,
                "standard include inventory is not canonical",
            ));
        }
        Ok(())
    }
}

pub fn standard_include_unavailable_message(include: &str) -> String {
    format!(
        "Standard game include '{include}' requires a linked game folder with its local version selected."
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VirtualSource {
    pub path: String,
    pub source: SourceText,
    pub kind: VirtualSourceKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VirtualSourceKind {
    RmsText,
    ExternalXs,
}

impl VirtualSource {
    pub fn new(path: impl Into<String>, source: SourceText) -> Result<Self, ResolutionDiagnostic> {
        Ok(Self {
            path: normalize_catalog_path(&path.into())?,
            source,
            kind: VirtualSourceKind::RmsText,
        })
    }

    pub fn external_xs(
        path: impl Into<String>,
        source: SourceText,
    ) -> Result<Self, ResolutionDiagnostic> {
        Ok(Self {
            path: normalize_catalog_path(&path.into())?,
            source,
            kind: VirtualSourceKind::ExternalXs,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedInclude {
    pub selected: VirtualSource,
    pub shadowed_candidates: Vec<VirtualSource>,
}

impl ResolvedInclude {
    pub fn ambiguity_diagnostic(&self, source_chain: &[SourceId]) -> Option<ResolutionDiagnostic> {
        if self.shadowed_candidates.is_empty() {
            return None;
        }
        Some(ResolutionDiagnostic {
            kind: ResolutionDiagnosticKind::Ambiguous,
            message: "include resolves to more than one virtual source".to_owned(),
            source_chain: source_chain.to_vec(),
            candidates: std::iter::once(&self.selected)
                .chain(&self.shadowed_candidates)
                .map(|candidate| candidate.path.clone())
                .collect(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionDiagnosticKind {
    Missing,
    Ambiguous,
    Cycle,
    PathTraversal,
    ResourceLimit,
    StandardIncludeUnavailable,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct ResolutionDiagnostic {
    pub kind: ResolutionDiagnosticKind,
    pub message: String,
    pub source_chain: Vec<SourceId>,
    pub candidates: Vec<String>,
}

impl ResolutionDiagnostic {
    fn new(kind: ResolutionDiagnosticKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            source_chain: Vec::new(),
            candidates: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct VirtualSourceResolver {
    sources: Vec<VirtualSource>,
    roots: ResolverRoots,
    case_sensitive: bool,
}

impl VirtualSourceResolver {
    pub fn new(
        sources: Vec<VirtualSource>,
        roots: ResolverRoots,
        case_sensitive: bool,
    ) -> Result<Self, ResolutionDiagnostic> {
        if sources.len() > MAX_RESOLVER_SOURCES {
            return Err(ResolutionDiagnostic::new(
                ResolutionDiagnosticKind::ResourceLimit,
                "virtual source catalog exceeds its bounded size",
            ));
        }
        Ok(Self {
            sources,
            roots: normalize_roots(roots)?,
            case_sensitive,
        })
    }

    pub fn resolve(
        &self,
        current_source_path: &str,
        include: &IncludePath,
        source_chain: &[SourceId],
    ) -> Result<ResolvedInclude, ResolutionDiagnostic> {
        self.resolve_kind(
            current_source_path,
            include,
            source_chain,
            VirtualSourceKind::RmsText,
        )
    }

    pub fn resolve_external_xs(
        &self,
        current_source_path: &str,
        include: &IncludePath,
        source_chain: &[SourceId],
    ) -> Result<ResolvedInclude, ResolutionDiagnostic> {
        self.resolve_kind(
            current_source_path,
            include,
            source_chain,
            VirtualSourceKind::ExternalXs,
        )
    }

    fn resolve_kind(
        &self,
        current_source_path: &str,
        include: &IncludePath,
        source_chain: &[SourceId],
        expected_kind: VirtualSourceKind,
    ) -> Result<ResolvedInclude, ResolutionDiagnostic> {
        let candidate_paths =
            self.lookup_paths(current_source_path, include, source_chain, expected_kind)?;
        let mut matches = Vec::new();
        let mut seen_sources = BTreeSet::new();
        for candidate_path in candidate_paths {
            for source in &self.sources {
                if source.kind == expected_kind
                    && path_equals(&source.path, &candidate_path, self.case_sensitive)
                    && seen_sources.insert(source.source.id().clone())
                {
                    matches.push(source.clone());
                }
            }
        }

        if matches.is_empty() {
            return Err(ResolutionDiagnostic {
                kind: ResolutionDiagnosticKind::Missing,
                message: format!("include was not found: {}", include.as_str()),
                source_chain: source_chain.to_vec(),
                candidates: Vec::new(),
            });
        }
        let selected = matches.remove(0);
        Ok(ResolvedInclude {
            selected,
            shadowed_candidates: matches,
        })
    }

    pub fn lookup_paths(
        &self,
        current_source_path: &str,
        include: &IncludePath,
        source_chain: &[SourceId],
        expected_kind: VirtualSourceKind,
    ) -> Result<Vec<String>, ResolutionDiagnostic> {
        let current_source_path = normalize_catalog_path(current_source_path)?;
        let mut roots = Vec::new();
        if let Some(folder) = virtual_parent(&current_source_path) {
            roots.push(folder);
        }
        roots.extend(self.roots.opened_or_configured.iter().cloned());
        roots.extend(self.roots.deployed_map_context.iter().cloned());
        roots.extend(self.roots.game_gamedata_x2.iter().cloned());
        roots.extend(self.roots.implicit_environment.iter().cloned());
        if expected_kind == VirtualSourceKind::ExternalXs {
            roots.extend(self.roots.game_xs.iter().cloned());
        }
        deduplicate_roots(&mut roots, self.case_sensitive);
        if expected_kind == VirtualSourceKind::RmsText
            && self.is_standard_request(&current_source_path, include)
        {
            let access = &self.roots.standard_includes;
            let Some(game_root) = self
                .roots
                .game_gamedata_x2
                .as_deref()
                .filter(|_| access.authorized)
            else {
                return Err(ResolutionDiagnostic {
                    kind: ResolutionDiagnosticKind::StandardIncludeUnavailable,
                    message: standard_include_unavailable_message(include.as_str()),
                    source_chain: source_chain.to_vec(),
                    candidates: Vec::new(),
                });
            };
            roots.retain(|root| is_within(root, game_root, self.case_sensitive));
        }

        Ok(roots
            .iter()
            .map(|root| join_virtual(root, include.as_str()))
            .collect())
    }

    pub fn standard_namespace_probe(
        &self,
        include: &IncludePath,
        expected_kind: VirtualSourceKind,
    ) -> Option<String> {
        (expected_kind == VirtualSourceKind::RmsText
            && self.roots.standard_includes.authorized
            && include.as_str().to_ascii_lowercase().ends_with(".inc")
            && !self.roots.standard_includes.contains(include))
        .then(|| {
            self.roots
                .game_gamedata_x2
                .as_deref()
                .map(|root| join_virtual(root, include.as_str()))
        })
        .flatten()
    }
}

impl VirtualSourceResolver {
    fn is_standard_request(&self, current_source_path: &str, include: &IncludePath) -> bool {
        self.roots.standard_includes.contains(include)
            || self
                .roots
                .game_gamedata_x2
                .as_deref()
                .is_some_and(|game_root| {
                    virtual_parent(current_source_path)
                        .is_some_and(|folder| is_within(&folder, game_root, self.case_sensitive))
                })
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DependencyGraph {
    direct: BTreeMap<SourceId, BTreeSet<SourceId>>,
    reverse: BTreeMap<SourceId, BTreeSet<SourceId>>,
}

impl DependencyGraph {
    pub fn set_dependencies(
        &mut self,
        source: SourceId,
        dependencies: impl IntoIterator<Item = SourceId>,
    ) -> Result<Vec<SourceId>, ResolutionDiagnostic> {
        let dependencies: BTreeSet<_> = dependencies.into_iter().collect();
        if dependencies.len() > MAX_DEPENDENCIES_PER_SOURCE {
            return Err(ResolutionDiagnostic::new(
                ResolutionDiagnosticKind::ResourceLimit,
                "document has too many direct include dependencies",
            ));
        }
        self.direct.insert(source.clone(), dependencies);
        self.rebuild_reverse();
        Ok(self.invalidated_by_change(&source))
    }

    pub fn invalidated_by_change(&self, changed: &SourceId) -> Vec<SourceId> {
        let mut pending = VecDeque::from([changed.clone()]);
        let mut affected = BTreeSet::new();
        while let Some(source) = pending.pop_front() {
            if !affected.insert(source.clone()) {
                continue;
            }
            if let Some(dependents) = self.reverse.get(&source) {
                pending.extend(dependents.iter().cloned());
            }
        }
        affected.into_iter().collect()
    }

    pub fn cycle_diagnostic(&self, entry: &SourceId) -> Option<ResolutionDiagnostic> {
        let mut visited = BTreeSet::new();
        let mut stack = Vec::new();
        let mut active = BTreeMap::new();
        let chain = self.find_cycle(entry, &mut visited, &mut stack, &mut active)?;
        Some(ResolutionDiagnostic {
            kind: ResolutionDiagnosticKind::Cycle,
            message: "include cycle detected".to_owned(),
            source_chain: chain,
            candidates: Vec::new(),
        })
    }

    fn rebuild_reverse(&mut self) {
        self.reverse.clear();
        for (source, dependencies) in &self.direct {
            self.reverse.entry(source.clone()).or_default();
            for dependency in dependencies {
                self.reverse
                    .entry(dependency.clone())
                    .or_default()
                    .insert(source.clone());
            }
        }
    }

    fn find_cycle(
        &self,
        source: &SourceId,
        visited: &mut BTreeSet<SourceId>,
        stack: &mut Vec<SourceId>,
        active: &mut BTreeMap<SourceId, usize>,
    ) -> Option<Vec<SourceId>> {
        if let Some(start) = active.get(source).copied() {
            let mut cycle = stack[start..].to_vec();
            cycle.push(source.clone());
            return Some(cycle);
        }
        if !visited.insert(source.clone()) {
            return None;
        }
        active.insert(source.clone(), stack.len());
        stack.push(source.clone());
        if let Some(dependencies) = self.direct.get(source) {
            for dependency in dependencies {
                if let Some(cycle) = self.find_cycle(dependency, visited, stack, active) {
                    return Some(cycle);
                }
            }
        }
        stack.pop();
        active.remove(source);
        None
    }
}

fn normalize_roots(roots: ResolverRoots) -> Result<ResolverRoots, ResolutionDiagnostic> {
    roots.standard_includes.validate()?;
    if roots.standard_includes.authorized && roots.game_gamedata_x2.is_none() {
        return Err(ResolutionDiagnostic::new(
            ResolutionDiagnosticKind::StandardIncludeUnavailable,
            "standard include authorization requires a linked game root",
        ));
    }
    Ok(ResolverRoots {
        opened_or_configured: roots
            .opened_or_configured
            .iter()
            .map(|root| normalize_catalog_path(root))
            .collect::<Result<_, _>>()?,
        deployed_map_context: roots
            .deployed_map_context
            .as_deref()
            .map(normalize_catalog_path)
            .transpose()?,
        game_gamedata_x2: roots
            .game_gamedata_x2
            .as_deref()
            .map(normalize_catalog_path)
            .transpose()?,
        implicit_environment: roots
            .implicit_environment
            .as_deref()
            .map(normalize_catalog_path)
            .transpose()?,
        game_xs: roots
            .game_xs
            .as_deref()
            .map(normalize_catalog_path)
            .transpose()?,
        standard_includes: roots.standard_includes,
    })
}

pub(crate) fn normalize_catalog_path(value: &str) -> Result<String, ResolutionDiagnostic> {
    let value = value.replace('\\', "/");
    if value.is_empty()
        || value.len() > MAX_INCLUDE_PATH_BYTES * 4
        || value.contains('\0')
        || value.split('/').any(|segment| segment == "..")
    {
        return Err(ResolutionDiagnostic::new(
            ResolutionDiagnosticKind::PathTraversal,
            "virtual source path is invalid",
        ));
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn virtual_parent(path: &str) -> Option<String> {
    path.rsplit_once('/').map(|(parent, _)| parent.to_owned())
}

fn join_virtual(root: &str, include: &str) -> String {
    if root.is_empty() {
        include.to_owned()
    } else {
        format!("{root}/{include}")
    }
}

fn is_within(path: &str, root: &str, case_sensitive: bool) -> bool {
    path_equals(path, root, case_sensitive)
        || path.len() > root.len()
            && path.as_bytes()[root.len()] == b'/'
            && path.is_char_boundary(root.len())
            && path_equals(&path[..root.len()], root, case_sensitive)
}

fn path_equals(left: &str, right: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        left == right
    } else {
        left.eq_ignore_ascii_case(right)
    }
}

fn deduplicate_roots(roots: &mut Vec<String>, case_sensitive: bool) {
    let mut seen = BTreeSet::new();
    roots.retain(|root| {
        let key = if case_sensitive {
            root.clone()
        } else {
            root.to_ascii_lowercase()
        };
        seen.insert(key)
    });
}
