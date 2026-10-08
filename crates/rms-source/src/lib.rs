mod resolver;
mod source_catalog;
mod source_text;

pub use resolver::{
    DependencyGraph, IncludePath, ResolutionDiagnostic, ResolutionDiagnosticKind, ResolvedInclude,
    ResolverRoots, StandardIncludeAccess, VirtualSource, VirtualSourceKind, VirtualSourceResolver,
    standard_include_unavailable_message,
};
pub use source_catalog::{
    CatalogSource, SOURCE_CATALOG_MAJOR, SOURCE_CATALOG_MAX_AGGREGATE_BYTES,
    SOURCE_CATALOG_MAX_FILE_BYTES, SOURCE_CATALOG_MAX_METADATA_BYTES, SOURCE_CATALOG_MAX_ROOTS,
    SOURCE_CATALOG_MAX_SOURCES, SourceCatalog, SourceCatalogError, SourceCatalogOrigin,
    SourceCatalogParts, SourceCatalogRole, SourceCatalogVersion, SourceInventory,
};
pub use source_text::{
    ByteOffset, ByteRange, LineIndex, NewlineStyle, SourceEncoding, SourceError, SourceId,
    SourceText, Utf16Position, Utf16Range,
};
