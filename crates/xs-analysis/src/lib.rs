mod analyzer;
mod catalog;
mod documentation;
mod fixes;
mod format;
mod ide;
mod inlay;
mod model;
mod rename;
mod types;

pub use analyzer::{
    MAXIMUM_FILE_DIAGNOSTICS, MAXIMUM_INCLUDE_DEPTH, MAXIMUM_UNIT_FILES, PreparedEnvironment,
    analyze_unit, analyze_unit_prepared,
};
pub use catalog::{
    Builtin, BuiltinParam, DefaultValue, Documentation, DocumentationBasis, DocumentationSource,
    XsBuild, XsCatalog, XsRuntime, catalog,
};
pub use documentation::{
    BuiltinDocumentation, MAXIMUM_BUILTIN_DOCUMENTATION_BYTES, builtin_documentation,
    builtin_documentation_view,
};
pub use fixes::{QuickFix, quick_fixes, version_correct_builtin_name};
pub use format::{TextEdit, XS_FORMATTER_CONVENTION, apply as apply_edits, format_document};
pub use ide::{
    CompletionEntry, CompletionKind, Fold, FoldKind, HoverInfo, OutlineKind, OutlineSymbol,
    SemanticClass, SemanticToken, SignatureInfo, SignatureParameter, completions,
    completions_matching, declares_main, definition, folds, hover, outline, semantic_tokens,
    signature_help,
};
pub use inlay::{MAXIMUM_XS_INLAY_HINTS, ParameterHint, parameter_hints};
pub use model::{
    AnalysisOptions, FunctionSignature, IncludeLink, IncludeResolver, NoIncludes, Reference,
    Symbol, SymbolId, SymbolKind, Target, UnitAnalysis, XsFile,
};
pub use rename::{RenameTarget, rename_locations, rename_target, valid_new_name};
pub use types::{Ty, incompatible};
