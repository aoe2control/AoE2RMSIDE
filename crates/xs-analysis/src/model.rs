use std::collections::BTreeMap;
use std::sync::Arc;

use rms_source::{ByteRange, SourceId, SourceText};
use xs_syntax::{SyntaxTree, XsDiagnostic, XsLexerLimits, parse};

use crate::catalog::{XsBuild, XsRuntime};
use crate::types::Ty;

#[derive(Debug)]
pub struct XsFile {
    pub source: SourceText,
    pub tree: SyntaxTree,
}

impl XsFile {
    pub fn parse(source: SourceText) -> Arc<Self> {
        let tree = parse(&source, XsLexerLimits::default());
        Arc::new(Self { source, tree })
    }

    pub fn id(&self) -> &SourceId {
        self.source.id()
    }
}

pub trait IncludeResolver {
    fn resolve(&self, from: &SourceId, path: &str) -> Option<Arc<XsFile>>;
}

pub struct NoIncludes;

impl IncludeResolver for NoIncludes {
    fn resolve(&self, _from: &SourceId, _path: &str) -> Option<Arc<XsFile>> {
        None
    }
}

#[derive(Clone, Debug, Default)]
pub struct AnalysisOptions {
    pub build: Option<XsBuild>,
    pub runtime: Option<XsRuntime>,
    pub environment: Option<Arc<XsFile>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SymbolId(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SymbolKind {
    Function,
    Rule,
    RuleGroup,
    GlobalVariable,
    Constant,
    LocalVariable,
    Parameter,
    LoopVariable,
    Class,
    Member,
    Label,
}

impl SymbolKind {
    pub const fn is_variable(self) -> bool {
        matches!(
            self,
            Self::GlobalVariable
                | Self::Constant
                | Self::LocalVariable
                | Self::Parameter
                | Self::LoopVariable
        )
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Rule => "rule",
            Self::RuleGroup => "rule group",
            Self::GlobalVariable => "global variable",
            Self::Constant => "constant",
            Self::LocalVariable => "local variable",
            Self::Parameter => "parameter",
            Self::LoopVariable => "loop variable",
            Self::Class => "class",
            Self::Member => "member",
            Self::Label => "label",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FunctionSignature {
    pub return_type: Ty,
    pub params: Vec<(String, Ty)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub ty: Ty,
    pub source_id: SourceId,
    pub selection_range: ByteRange,
    pub range: ByteRange,
    pub detail: String,
    pub documentation: Option<String>,
    pub container: Option<SymbolId>,
    pub signature: Option<FunctionSignature>,
    pub is_const: bool,
    pub is_mutable: bool,
    pub from_environment: bool,
    pub scope: Option<ByteRange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Target {
    Symbol(SymbolId),
    Builtin(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reference {
    pub source_id: SourceId,
    pub range: ByteRange,
    pub target: Target,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncludeLink {
    pub source_id: SourceId,
    pub range: ByteRange,
    pub target: Option<SourceId>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UnitAnalysis {
    pub symbols: Vec<Symbol>,
    pub references: Vec<Reference>,
    pub diagnostics: BTreeMap<SourceId, Vec<XsDiagnostic>>,
    pub files: Vec<SourceId>,
    pub includes: Vec<IncludeLink>,
    pub environment_loaded: bool,
    pub complete: bool,
}

impl UnitAnalysis {
    pub fn symbol(&self, id: SymbolId) -> &Symbol {
        &self.symbols[id.0 as usize]
    }

    pub fn diagnostics_for(&self, source_id: &SourceId) -> &[XsDiagnostic] {
        self.diagnostics
            .get(source_id)
            .map_or(&[], |diagnostics| diagnostics.as_slice())
    }

    pub fn target_at(&self, source_id: &SourceId, offset: u32) -> Option<(Target, ByteRange)> {
        let contains = |range: &ByteRange| range.start.0 <= offset && offset <= range.end.0;
        if let Some(reference) = self
            .references
            .iter()
            .find(|reference| reference.source_id == *source_id && contains(&reference.range))
        {
            return Some((reference.target.clone(), reference.range));
        }
        self.symbols
            .iter()
            .enumerate()
            .find(|(_, symbol)| {
                symbol.source_id == *source_id
                    && !symbol.from_environment
                    && contains(&symbol.selection_range)
            })
            .map(|(index, symbol)| {
                (
                    Target::Symbol(SymbolId(index as u32)),
                    symbol.selection_range,
                )
            })
    }

    pub fn locations_of(
        &self,
        target: &Target,
        include_declaration: bool,
    ) -> Vec<(SourceId, ByteRange)> {
        let mut locations = Vec::new();
        if include_declaration && let Target::Symbol(id) = target {
            let symbol = self.symbol(*id);
            locations.push((symbol.source_id.clone(), symbol.selection_range));
        }
        for reference in &self.references {
            if reference.target == *target {
                locations.push((reference.source_id.clone(), reference.range));
            }
        }
        locations.sort_by(|left, right| {
            (left.0.as_str(), left.1.start, left.1.end).cmp(&(
                right.0.as_str(),
                right.1.start,
                right.1.end,
            ))
        });
        locations.dedup();
        locations
    }
}
