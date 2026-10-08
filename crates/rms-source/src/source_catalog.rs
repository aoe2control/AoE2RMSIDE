use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::resolver::normalize_catalog_path;
use crate::{ResolverRoots, SourceId, SourceText, VirtualSource, VirtualSourceResolver};

pub const SOURCE_CATALOG_MAJOR: u32 = 1;
pub const SOURCE_CATALOG_MAX_SOURCES: usize = 4_096;
pub const SOURCE_CATALOG_MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub const SOURCE_CATALOG_MAX_AGGREGATE_BYTES: usize = 16 * 1024 * 1024;
pub const SOURCE_CATALOG_MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
pub const SOURCE_CATALOG_MAX_ROOTS: usize = 256;
const MAXIMUM_DEFINITIONS: usize = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceCatalogVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Default for SourceCatalogVersion {
    fn default() -> Self {
        Self {
            major: SOURCE_CATALOG_MAJOR,
            minor: 0,
            patch: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SourceCatalogOrigin {
    Workspace,
    DirtyBuffer,
    DeployedMap,
    GameData,
    ImplicitEnvironment,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SourceCatalogRole {
    RmsEntry,
    RmsDependency,
    ExternalXs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogSource {
    pub path: String,
    pub source_id: SourceId,
    pub raw_hash: [u8; 32],
    pub bytes: Arc<[u8]>,
    pub origin: SourceCatalogOrigin,
    pub role: SourceCatalogRole,
    pub buffer_revision: Option<u64>,
}

impl CatalogSource {
    pub fn new(
        path: impl Into<String>,
        source_id: SourceId,
        bytes: impl Into<Arc<[u8]>>,
        origin: SourceCatalogOrigin,
        role: SourceCatalogRole,
        buffer_revision: Option<u64>,
    ) -> Result<Self, SourceCatalogError> {
        let path = normalize_catalog_path(&path.into())
            .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
        let bytes = bytes.into();
        let raw_hash = Sha256::digest(&bytes).into();
        Ok(Self {
            path,
            source_id,
            raw_hash,
            bytes,
            origin,
            role,
            buffer_revision,
        })
    }
}

#[derive(Clone, Debug)]
pub struct SourceCatalog {
    version: SourceCatalogVersion,
    revision: u64,
    entry_path: String,
    sources: Arc<[CatalogSource]>,
    roots: ResolverRoots,
    case_sensitive: bool,
    profile_id: String,
    content_identity: String,
    implicit_definitions: Arc<BTreeMap<String, String>>,
    implicit_environment_hash: [u8; 32],
    catalog_hash: [u8; 32],
    rms_graph_hash: [u8; 32],
    asset_graph_hash: [u8; 32],
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SourceCatalogError {
    #[error("source catalog version is unsupported")]
    UnsupportedVersion,
    #[error("source catalog {0}")]
    ResourceLimit(&'static str),
    #[error("source catalog path is invalid: {0}")]
    InvalidPath(String),
    #[error("source catalog contains a duplicate source identity or path")]
    DuplicateIdentity,
    #[error("source catalog source ordering is not canonical")]
    NonCanonicalOrdering,
    #[error("source catalog entry identity is invalid")]
    InvalidEntry,
    #[error("source catalog source hash is stale")]
    StaleHash,
    #[error("source catalog source role or extension is invalid")]
    InvalidRole,
    #[error("source catalog root list contains a duplicate")]
    DuplicateRoot,
    #[error("source catalog profile/content identity is invalid")]
    InvalidContext,
    #[error("source catalog implicit environment hash is stale")]
    StaleImplicitEnvironment,
    #[error("source catalog whole-catalog hashes are stale")]
    StaleCatalogHash,
    #[error("source catalog source bytes are invalid: {0}")]
    InvalidSource(String),
}

#[derive(Clone, Debug)]
pub struct SourceCatalogParts {
    pub version: SourceCatalogVersion,
    pub revision: u64,
    pub entry_path: String,
    pub sources: Vec<CatalogSource>,
    pub roots: ResolverRoots,
    pub case_sensitive: bool,
    pub profile_id: String,
    pub content_identity: String,
    pub implicit_definitions: BTreeMap<String, String>,
    pub implicit_environment_hash: [u8; 32],
    pub catalog_hash: [u8; 32],
    pub rms_graph_hash: [u8; 32],
    pub asset_graph_hash: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct SourceInventory {
    sources: Arc<[CatalogSource]>,
    roots: ResolverRoots,
    case_sensitive: bool,
    profile_id: String,
    content_identity: String,
    implicit_definitions: Arc<BTreeMap<String, String>>,
}

impl SourceInventory {
    pub fn new(
        sources: Vec<CatalogSource>,
        roots: ResolverRoots,
        case_sensitive: bool,
        profile_id: String,
        content_identity: String,
        implicit_definitions: BTreeMap<String, String>,
    ) -> Result<Self, SourceCatalogError> {
        Self::validated(
            sources,
            roots,
            case_sensitive,
            profile_id,
            content_identity,
            implicit_definitions,
            0,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn validated(
        sources: Vec<CatalogSource>,
        roots: ResolverRoots,
        case_sensitive: bool,
        profile_id: String,
        content_identity: String,
        implicit_definitions: BTreeMap<String, String>,
        extra_metadata: usize,
    ) -> Result<Self, SourceCatalogError> {
        if sources.len() > SOURCE_CATALOG_MAX_SOURCES {
            return Err(SourceCatalogError::ResourceLimit(
                "source count exceeds its bound",
            ));
        }
        if profile_id.is_empty()
            || profile_id.len() > 256
            || content_identity.is_empty()
            || content_identity.len() > 512
        {
            return Err(SourceCatalogError::InvalidContext);
        }
        let roots = validate_roots(roots, case_sensitive)?;
        hash_implicit_definitions(&implicit_definitions)?;
        let mut metadata_bytes = extra_metadata + profile_id.len() + content_identity.len();
        for root in roots
            .opened_or_configured
            .iter()
            .chain(roots.deployed_map_context.iter())
            .chain(roots.game_gamedata_x2.iter())
            .chain(roots.implicit_environment.iter())
            .chain(roots.game_xs.iter())
        {
            metadata_bytes = metadata_bytes.saturating_add(root.len() + 8);
        }
        for name in &roots.standard_includes.identifiers {
            metadata_bytes = metadata_bytes.saturating_add(name.len() + 8);
        }
        for (name, value) in &implicit_definitions {
            metadata_bytes = metadata_bytes.saturating_add(name.len() + value.len() + 16);
        }
        if !sources.windows(2).all(|pair| {
            pair[0]
                .path
                .cmp(&pair[1].path)
                .then_with(|| pair[0].source_id.cmp(&pair[1].source_id))
                .is_le()
        }) {
            return Err(SourceCatalogError::NonCanonicalOrdering);
        }
        let mut source_ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        let mut aggregate_bytes = 0_usize;
        for source in &sources {
            metadata_bytes = metadata_bytes
                .saturating_add(source.path.len() + source.source_id.as_str().len() + 64);
            let normalized = normalize_catalog_path(&source.path)
                .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
            if normalized != source.path {
                return Err(SourceCatalogError::InvalidPath(source.path.clone()));
            }
            let key = if case_sensitive {
                source.path.clone()
            } else {
                source.path.to_ascii_lowercase()
            };
            if !source_ids.insert(source.source_id.clone()) || !paths.insert(key) {
                return Err(SourceCatalogError::DuplicateIdentity);
            }
            if source.bytes.len() > SOURCE_CATALOG_MAX_FILE_BYTES {
                return Err(SourceCatalogError::ResourceLimit(
                    "individual file exceeds its bound",
                ));
            }
            aggregate_bytes = aggregate_bytes.saturating_add(source.bytes.len());
            if aggregate_bytes > SOURCE_CATALOG_MAX_AGGREGATE_BYTES {
                return Err(SourceCatalogError::ResourceLimit(
                    "aggregate bytes exceed their bound",
                ));
            }
            if Sha256::digest(&source.bytes).as_slice() != source.raw_hash {
                return Err(SourceCatalogError::StaleHash);
            }
            validate_role(source)?;
            SourceText::validate_bytes(&source.bytes)
                .map_err(|error| SourceCatalogError::InvalidSource(error.to_string()))?;
        }
        if metadata_bytes > SOURCE_CATALOG_MAX_METADATA_BYTES {
            return Err(SourceCatalogError::ResourceLimit(
                "metadata bytes exceed their bound",
            ));
        }
        Ok(Self {
            sources: sources.into(),
            roots,
            case_sensitive,
            profile_id,
            content_identity,
            implicit_definitions: Arc::new(implicit_definitions),
        })
    }

    pub fn sources(&self) -> &[CatalogSource] {
        &self.sources
    }
    pub fn roots(&self) -> &ResolverRoots {
        &self.roots
    }
    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
    pub fn content_identity(&self) -> &str {
        &self.content_identity
    }
    pub fn implicit_definitions(&self) -> &BTreeMap<String, String> {
        &self.implicit_definitions
    }
}

impl SourceCatalog {
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        version: SourceCatalogVersion,
        revision: u64,
        entry_path: impl Into<String>,
        mut sources: Vec<CatalogSource>,
        roots: ResolverRoots,
        case_sensitive: bool,
        profile_id: impl Into<String>,
        content_identity: impl Into<String>,
        implicit_definitions: BTreeMap<String, String>,
    ) -> Result<Self, SourceCatalogError> {
        let entry_path = normalize_catalog_path(&entry_path.into())
            .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
        sources.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.source_id.cmp(&right.source_id))
        });
        let profile_id = profile_id.into();
        let content_identity = content_identity.into();
        let implicit_environment_hash = hash_implicit_definitions(&implicit_definitions)?;
        let rms_graph_hash = hash_sources(&sources, false);
        let asset_graph_hash = hash_sources(&sources, true);
        let catalog_hash = hash_catalog(
            version,
            revision,
            &entry_path,
            &sources,
            &roots,
            case_sensitive,
            &profile_id,
            &content_identity,
            &implicit_environment_hash,
            &rms_graph_hash,
            &asset_graph_hash,
        );
        Self::from_parts(SourceCatalogParts {
            version,
            revision,
            entry_path,
            sources,
            roots,
            case_sensitive,
            profile_id,
            content_identity,
            implicit_definitions,
            implicit_environment_hash,
            catalog_hash,
            rms_graph_hash,
            asset_graph_hash,
        })
    }

    pub fn from_parts(parts: SourceCatalogParts) -> Result<Self, SourceCatalogError> {
        if parts.version.major != SOURCE_CATALOG_MAJOR {
            return Err(SourceCatalogError::UnsupportedVersion);
        }
        if parts.sources.is_empty() || parts.sources.len() > SOURCE_CATALOG_MAX_SOURCES {
            return Err(SourceCatalogError::ResourceLimit(
                "source count exceeds its bound",
            ));
        }
        let entry_path = normalize_catalog_path(&parts.entry_path)
            .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
        let inventory = SourceInventory::validated(
            parts.sources.clone(),
            parts.roots.clone(),
            parts.case_sensitive,
            parts.profile_id.clone(),
            parts.content_identity.clone(),
            parts.implicit_definitions.clone(),
            entry_path.len(),
        )?;
        let roots = inventory.roots;
        if !parts.sources.iter().any(|source| source.path == entry_path)
            || parts.sources.iter().any(|source| {
                (source.path == entry_path) != (source.role == SourceCatalogRole::RmsEntry)
            })
        {
            return Err(SourceCatalogError::InvalidEntry);
        }
        let computed_implicit = hash_implicit_definitions(&parts.implicit_definitions)?;
        if computed_implicit != parts.implicit_environment_hash {
            return Err(SourceCatalogError::StaleImplicitEnvironment);
        }
        let computed_rms = hash_sources(&parts.sources, false);
        let computed_assets = hash_sources(&parts.sources, true);
        let computed_catalog = hash_catalog(
            parts.version,
            parts.revision,
            &entry_path,
            &parts.sources,
            &roots,
            parts.case_sensitive,
            &parts.profile_id,
            &parts.content_identity,
            &computed_implicit,
            &computed_rms,
            &computed_assets,
        );
        if computed_rms != parts.rms_graph_hash
            || computed_assets != parts.asset_graph_hash
            || computed_catalog != parts.catalog_hash
        {
            return Err(SourceCatalogError::StaleCatalogHash);
        }
        Ok(Self {
            version: parts.version,
            revision: parts.revision,
            entry_path,
            sources: parts.sources.into(),
            roots,
            case_sensitive: parts.case_sensitive,
            profile_id: parts.profile_id,
            content_identity: parts.content_identity,
            implicit_definitions: Arc::new(parts.implicit_definitions),
            implicit_environment_hash: computed_implicit,
            catalog_hash: computed_catalog,
            rms_graph_hash: computed_rms,
            asset_graph_hash: computed_assets,
        })
    }

    pub fn resolver(&self) -> Result<VirtualSourceResolver, SourceCatalogError> {
        let sources = self
            .sources
            .iter()
            .map(|entry| {
                let source =
                    SourceText::from_bytes(entry.source_id.clone(), entry.bytes.clone())
                        .map_err(|error| SourceCatalogError::InvalidSource(error.to_string()))?;
                match entry.role {
                    SourceCatalogRole::ExternalXs => {
                        VirtualSource::external_xs(&entry.path, source)
                    }
                    SourceCatalogRole::RmsEntry | SourceCatalogRole::RmsDependency => {
                        VirtualSource::new(&entry.path, source)
                    }
                }
                .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        VirtualSourceResolver::new(sources, self.roots.clone(), self.case_sensitive)
            .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))
    }

    pub fn entry_source(&self) -> Result<SourceText, SourceCatalogError> {
        let entry = self
            .sources
            .iter()
            .find(|source| source.path == self.entry_path)
            .ok_or(SourceCatalogError::InvalidEntry)?;
        SourceText::from_bytes(entry.source_id.clone(), entry.bytes.clone())
            .map_err(|error| SourceCatalogError::InvalidSource(error.to_string()))
    }

    pub fn version(&self) -> SourceCatalogVersion {
        self.version
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn entry_path(&self) -> &str {
        &self.entry_path
    }
    pub fn sources(&self) -> &[CatalogSource] {
        &self.sources
    }
    pub fn roots(&self) -> &ResolverRoots {
        &self.roots
    }
    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
    pub fn content_identity(&self) -> &str {
        &self.content_identity
    }
    pub fn implicit_definitions(&self) -> &BTreeMap<String, String> {
        &self.implicit_definitions
    }
    pub fn implicit_environment_hash(&self) -> [u8; 32] {
        self.implicit_environment_hash
    }
    pub fn catalog_hash(&self) -> [u8; 32] {
        self.catalog_hash
    }
    pub fn rms_graph_hash(&self) -> [u8; 32] {
        self.rms_graph_hash
    }
    pub fn asset_graph_hash(&self) -> [u8; 32] {
        self.asset_graph_hash
    }
}

fn validate_role(source: &CatalogSource) -> Result<(), SourceCatalogError> {
    let extension = source
        .path
        .rsplit_once('.')
        .map(|(_, value)| value.to_ascii_lowercase());
    let valid = match source.role {
        SourceCatalogRole::RmsEntry => matches!(extension.as_deref(), Some("rms" | "rms2")),
        SourceCatalogRole::RmsDependency => {
            matches!(extension.as_deref(), Some("rms" | "rms2" | "inc" | "def"))
        }
        SourceCatalogRole::ExternalXs => extension.as_deref() == Some("xs"),
    };
    if !valid
        || (source.origin == SourceCatalogOrigin::DirtyBuffer && source.buffer_revision.is_none())
    {
        return Err(SourceCatalogError::InvalidRole);
    }
    Ok(())
}

fn validate_roots(
    roots: ResolverRoots,
    case_sensitive: bool,
) -> Result<ResolverRoots, SourceCatalogError> {
    let root_count = roots.opened_or_configured.len()
        + usize::from(roots.deployed_map_context.is_some())
        + usize::from(roots.game_gamedata_x2.is_some())
        + usize::from(roots.implicit_environment.is_some())
        + usize::from(roots.game_xs.is_some());
    if root_count > SOURCE_CATALOG_MAX_ROOTS {
        return Err(SourceCatalogError::ResourceLimit(
            "root count exceeds its bound",
        ));
    }
    let mut seen = BTreeSet::new();
    for root in roots
        .opened_or_configured
        .iter()
        .chain(roots.deployed_map_context.iter())
        .chain(roots.game_gamedata_x2.iter())
        .chain(roots.implicit_environment.iter())
        .chain(roots.game_xs.iter())
    {
        let normalized = normalize_catalog_path(root)
            .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
        if normalized != *root {
            return Err(SourceCatalogError::InvalidPath(root.clone()));
        }
        let key = if case_sensitive {
            normalized
        } else {
            normalized.to_ascii_lowercase()
        };
        if !seen.insert(key) {
            return Err(SourceCatalogError::DuplicateRoot);
        }
    }
    roots
        .standard_includes
        .validate()
        .map_err(|error| SourceCatalogError::InvalidPath(error.to_string()))?;
    if roots.standard_includes.authorized && roots.game_gamedata_x2.is_none() {
        return Err(SourceCatalogError::InvalidContext);
    }
    Ok(roots)
}

fn hash_implicit_definitions(
    definitions: &BTreeMap<String, String>,
) -> Result<[u8; 32], SourceCatalogError> {
    if definitions.len() > MAXIMUM_DEFINITIONS {
        return Err(SourceCatalogError::ResourceLimit(
            "implicit definitions exceed their bound",
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"rms-implicit-environment-v1");
    for (name, value) in definitions {
        if name.is_empty() || name.len() > 256 || value.is_empty() || value.len() > 256 {
            return Err(SourceCatalogError::InvalidContext);
        }
        update_string(&mut hasher, name);
        update_string(&mut hasher, value);
    }
    Ok(hasher.finalize().into())
}

fn hash_sources(sources: &[CatalogSource], external_assets: bool) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let domain: &[u8] = if external_assets {
        b"rms-external-assets-v1"
    } else {
        b"rms-source-graph-v1"
    };
    hasher.update(domain);
    for source in sources {
        if (source.role == SourceCatalogRole::ExternalXs) != external_assets {
            continue;
        }
        update_string(&mut hasher, &source.path);
        update_string(&mut hasher, source.source_id.as_str());
        hasher.update(source.raw_hash);
        hasher.update([source.origin as u8, source.role as u8]);
    }
    hasher.finalize().into()
}

#[allow(clippy::too_many_arguments)]
fn hash_catalog(
    version: SourceCatalogVersion,
    _revision: u64,
    entry_path: &str,
    sources: &[CatalogSource],
    roots: &ResolverRoots,
    case_sensitive: bool,
    profile_id: &str,
    content_identity: &str,
    implicit_environment_hash: &[u8; 32],
    rms_graph_hash: &[u8; 32],
    asset_graph_hash: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"source-catalog-v1");
    hasher.update(version.major.to_le_bytes());
    hasher.update(version.minor.to_le_bytes());
    hasher.update(version.patch.to_le_bytes());
    update_string(&mut hasher, entry_path);
    update_string(&mut hasher, profile_id);
    update_string(&mut hasher, content_identity);
    hasher.update([u8::from(case_sensitive)]);
    for root in &roots.opened_or_configured {
        update_string(&mut hasher, root);
    }
    for root in [
        &roots.deployed_map_context,
        &roots.game_gamedata_x2,
        &roots.implicit_environment,
        &roots.game_xs,
    ] {
        if let Some(root) = root {
            hasher.update([1]);
            update_string(&mut hasher, root);
        } else {
            hasher.update([0]);
        }
    }
    for source in sources {
        update_string(&mut hasher, &source.path);
        update_string(&mut hasher, source.source_id.as_str());
        hasher.update(source.raw_hash);
        hasher.update([source.origin as u8, source.role as u8]);
    }
    hasher.update(implicit_environment_hash);
    hasher.update(rms_graph_hash);
    hasher.update(asset_graph_hash);
    let access = &roots.standard_includes;
    if !access.is_empty() {
        hasher.update(b"standard-include-access-v1");
        hasher.update([u8::from(access.authorized)]);
        hasher.update((access.identifiers.len() as u32).to_le_bytes());
        for identifier in &access.identifiers {
            update_string(&mut hasher, identifier);
        }
    }
    hasher.finalize().into()
}

fn update_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u32).to_le_bytes());
    hasher.update(value.as_bytes());
}
