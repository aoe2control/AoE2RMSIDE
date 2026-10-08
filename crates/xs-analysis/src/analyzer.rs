use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

use rms_source::{ByteOffset, ByteRange, SourceId, SourceText};
use xs_syntax::{
    AssignOp, Block, ClassDecl, DiagnosticTag, Expr, ExprKind, FunctionDecl, Item, Keyword,
    Literal, Modifiers, Name, Param, RelatedLocation, RuleDecl, RuleModifierKind, Severity, Stmt,
    StmtKind, TokenKind, TypeName, TypeRef, UnaryOp, VarDecl, XsDiagnostic,
};

use crate::catalog::{Builtin, XsBuild, XsCatalog, XsRuntime, catalog};
use crate::model::*;
use crate::types::{Ty, incompatible};

pub const MAXIMUM_INCLUDE_DEPTH: usize = 32;
pub const MAXIMUM_UNIT_FILES: usize = 512;
pub const MAXIMUM_FILE_DIAGNOSTICS: usize = 2_048;

const RULE_NAME_BUILTINS: [&str; 6] = [
    "xsEnableRule",
    "xsDisableRule",
    "xsIsRuleEnabled",
    "xsSetRulePriority",
    "xsSetRuleMinInterval",
    "xsSetRuleMaxInterval",
];
const RULE_GROUP_BUILTINS: [&str; 3] = [
    "xsEnableRuleGroup",
    "xsDisableRuleGroup",
    "xsIsRuleGroupEnabled",
];

const SILENT_REJECTION: &str = "; the game rejects this without showing an error message, and none of the script's XS code runs.";

pub(crate) const ENGINE_CONSTANTS_ID: &str = "xs-engine:///EngineConstants.xs";

const ENGINE_CONSTANTS: &str = "// Built into every XS runtime by the game: an invalid position.\n\
const vector cInvalidVector = vector(-1.0, -1.0, -1.0);\n\
// Built into every XS runtime by the game: the map origin.\n\
const vector cOriginVector = vector(0.0, 0.0, 0.0);\n";

pub(crate) fn engine_constants() -> Arc<XsFile> {
    static FILE: OnceLock<Arc<XsFile>> = OnceLock::new();
    FILE.get_or_init(|| {
        XsFile::parse(
            SourceText::from_bytes(
                SourceId::new(ENGINE_CONSTANTS_ID).expect("valid source id"),
                ENGINE_CONSTANTS.as_bytes(),
            )
            .expect("valid engine constants"),
        )
    })
    .clone()
}

pub(crate) fn is_constants_file(id: &SourceId) -> bool {
    id.as_str()
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("constants.xs"))
}

pub fn analyze_unit(
    roots: &[Arc<XsFile>],
    resolver: &dyn IncludeResolver,
    options: &AnalysisOptions,
) -> UnitAnalysis {
    let mut analyzer = Analyzer::new(resolver, options);
    analyzer.run(roots, None);
    analyzer.finish()
}

pub fn analyze_unit_prepared(
    roots: &[Arc<XsFile>],
    resolver: &dyn IncludeResolver,
    options: &AnalysisOptions,
    prepared: &PreparedEnvironment,
) -> UnitAnalysis {
    let mut analyzer = Analyzer::new(resolver, options);
    analyzer.run(roots, Some(prepared));
    analyzer.finish()
}

pub struct PreparedEnvironment {
    state: EnvironmentState,
}

#[derive(Clone)]
struct EnvironmentState {
    files: Vec<Arc<XsFile>>,
    events: Vec<Event>,
    symbols: Vec<Symbol>,
    globals: BTreeMap<String, Vec<(usize, SymbolId)>>,
    rules: BTreeMap<String, SymbolId>,
    groups: BTreeMap<String, SymbolId>,
    classes: BTreeMap<String, SymbolId>,
    members: BTreeMap<SymbolId, BTreeMap<String, SymbolId>>,
}

impl PreparedEnvironment {
    pub fn new(environment: Option<Arc<XsFile>>) -> Self {
        let options = AnalysisOptions {
            environment,
            ..AnalysisOptions::default()
        };
        let mut analyzer = Analyzer::new(&NoIncludes, &options);
        let files = analyzer.environment_files_for(&[]);
        analyzer.load_environment(files);
        let events = analyzer.events.clone();
        for (order, event) in events.iter().enumerate() {
            analyzer.current_order = order;
            analyzer.current_file = event.file;
            analyzer.declare_item(*event, order);
        }
        Self {
            state: EnvironmentState {
                files: analyzer.files,
                events,
                symbols: analyzer.out.symbols,
                globals: analyzer.globals,
                rules: analyzer.rules,
                groups: analyzer.groups,
                classes: analyzer.classes,
                members: analyzer.members,
            },
        }
    }

    fn declares(&self, files: &[Arc<XsFile>]) -> bool {
        self.state.files.len() == files.len()
            && self
                .state
                .files
                .iter()
                .zip(files)
                .all(|(left, right)| Arc::ptr_eq(left, right))
    }
}

#[derive(Clone, Copy)]
struct Event {
    file: usize,
    item: usize,
}

#[derive(Default)]
struct FunctionContext {
    return_type: Option<Ty>,
    is_rule: bool,
    order: usize,
    scopes: Vec<BTreeMap<String, SymbolId>>,
    scope_declarations: Vec<BTreeMap<String, Option<ByteRange>>>,
    scope_ranges: Vec<ByteRange>,
    all_locals: Vec<SymbolId>,
    labels: BTreeMap<String, SymbolId>,
    loop_depth: u32,
    switch_depth: u32,
    reads: BTreeMap<SymbolId, u32>,
    has_value_return: bool,
}

enum Resolution {
    Symbol(SymbolId),
    Later(SymbolId),
    Builtin(&'static Builtin),
    None,
}

struct CheckedArgument {
    ty: Ty,
    variable: Option<SymbolId>,
}

struct CheckedArguments {
    values: Vec<CheckedArgument>,
    error_free: bool,
}

struct ArgumentOrderHint {
    left: SymbolId,
    right: SymbolId,
    range: ByteRange,
    callee: Option<SymbolId>,
}

struct Analyzer<'a> {
    options: &'a AnalysisOptions,
    resolver: &'a dyn IncludeResolver,
    catalog: Option<&'static XsCatalog>,
    files: Vec<Arc<XsFile>>,
    environment_files: usize,
    events: Vec<Event>,
    out: UnitAnalysis,
    globals: BTreeMap<String, Vec<(usize, SymbolId)>>,
    rules: BTreeMap<String, SymbolId>,
    groups: BTreeMap<String, SymbolId>,
    classes: BTreeMap<String, SymbolId>,
    members: BTreeMap<SymbolId, BTreeMap<String, SymbolId>>,
    pending_rule_names: Vec<(SourceId, ByteRange, String, bool)>,
    current_order: usize,
    current_file: usize,
    fx: FunctionContext,
    suppressed: BTreeMap<SourceId, usize>,
    argument_order_complete: bool,
    ambiguous_locals: BTreeSet<SymbolId>,
    argument_order_hints: BTreeMap<SourceId, Vec<ArgumentOrderHint>>,
    reported_errors: usize,
}

impl<'a> Analyzer<'a> {
    fn new(resolver: &'a dyn IncludeResolver, options: &'a AnalysisOptions) -> Self {
        Self {
            options,
            resolver,
            catalog: catalog().ok(),
            files: Vec::new(),
            environment_files: 0,
            events: Vec::new(),
            out: UnitAnalysis {
                complete: true,
                ..UnitAnalysis::default()
            },
            globals: BTreeMap::new(),
            rules: BTreeMap::new(),
            groups: BTreeMap::new(),
            classes: BTreeMap::new(),
            members: BTreeMap::new(),
            pending_rule_names: Vec::new(),
            current_order: 0,
            current_file: 0,
            fx: FunctionContext::default(),
            suppressed: BTreeMap::new(),
            argument_order_complete: true,
            ambiguous_locals: BTreeSet::new(),
            argument_order_hints: BTreeMap::new(),
            reported_errors: 0,
        }
    }

    fn environment_files_for(&mut self, roots: &[Arc<XsFile>]) -> Vec<Arc<XsFile>> {
        let mut environment = vec![engine_constants()];
        if let Some(constants) = &self.options.environment {
            self.out.environment_loaded = true;
            if !roots
                .iter()
                .any(|root| root.id() == constants.id() || is_constants_file(root.id()))
            {
                environment.push(constants.clone());
            }
        }
        environment
    }

    fn load_environment(&mut self, environment: Vec<Arc<XsFile>>) {
        for file in environment {
            let index = self.files.len();
            for item in 0..file.tree.items.len() {
                self.events.push(Event { file: index, item });
            }
            self.files.push(file);
        }
        self.environment_files = self.files.len();
    }

    fn run(&mut self, roots: &[Arc<XsFile>], prepared: Option<&PreparedEnvironment>) {
        let environment = self.environment_files_for(roots);
        let mut declared = 0;
        match prepared.filter(|prepared| prepared.declares(&environment)) {
            Some(prepared) => {
                let state = prepared.state.clone();
                self.files = state.files;
                self.environment_files = self.files.len();
                self.events = state.events;
                declared = self.events.len();
                self.out.symbols = state.symbols;
                self.globals = state.globals;
                self.rules = state.rules;
                self.groups = state.groups;
                self.classes = state.classes;
                self.members = state.members;
            }
            None => self.load_environment(environment),
        }
        for root in roots {
            if self.files.iter().any(|file| file.id() == root.id()) {
                continue;
            }
            if self.files.len() >= MAXIMUM_UNIT_FILES {
                self.argument_order_complete = false;
                break;
            }
            let index = self.files.len();
            self.files.push(root.clone());
            self.out.files.push(root.id().clone());
            let mut stack = vec![root.id().clone()];
            self.plan(index, &mut stack);
        }
        self.argument_order_complete &= self.files.iter().all(|file| {
            !file
                .tree
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.severity == Severity::Error)
        });
        for file in &self.files[self.environment_files..] {
            for diagnostic in &file.tree.diagnostics {
                let id = file.id().clone();
                Self::push_diagnostic(&mut self.out, &mut self.suppressed, &id, diagnostic.clone());
            }
        }
        let events = self.events.clone();
        for (order, event) in events.iter().enumerate().skip(declared) {
            self.current_order = order;
            self.current_file = event.file;
            self.declare_item(*event, order);
        }
        for (order, event) in events.iter().enumerate() {
            self.current_order = order;
            self.current_file = event.file;
            self.check_item(*event, order);
        }
        self.resolve_rule_names();
        if !self.out.environment_loaded {
            for id in self.out.files.clone() {
                self.report_at(
                    &id,
                    XsDiagnostic::new(
                        "XS4010",
                        Severity::Information,
                        "The game's constants file (Constants.xs) is not loaded, so names that are not declared in this script are not checked. Link a game installation to enable the check.",
                        empty_range(),
                    ),
                );
            }
        }
    }

    fn finish(mut self) -> UnitAnalysis {
        self.flush_argument_order_hints();
        for (id, count) in std::mem::take(&mut self.suppressed) {
            self.out
                .diagnostics
                .entry(id)
                .or_default()
                .push(XsDiagnostic::new(
                    "XS9002",
                    Severity::Information,
                    format!("{count} more XS findings in this file were omitted."),
                    empty_range(),
                ));
        }
        for diagnostics in self.out.diagnostics.values_mut() {
            diagnostics.sort_by(|left, right| {
                (left.range.start, left.range.end, left.code).cmp(&(
                    right.range.start,
                    right.range.end,
                    right.code,
                ))
            });
            diagnostics.dedup();
        }
        self.out
    }

    fn plan(&mut self, file_index: usize, stack: &mut Vec<SourceId>) {
        let file = self.files[file_index].clone();
        for (item_index, item) in file.tree.items.iter().enumerate() {
            if let Item::Include(include) = item
                && let (Some(path), Some(path_range)) = (&include.path, include.path_range)
            {
                let target = self.resolver.resolve(file.id(), path);
                self.out.includes.push(IncludeLink {
                    source_id: file.id().clone(),
                    range: path_range,
                    target: target.as_ref().map(|target| target.id().clone()),
                });
                match target {
                    None => {
                        self.out.complete = false;
                        self.report_at(
                            file.id(),
                            XsDiagnostic::new(
                                "XS4009",
                                Severity::Warning,
                                format!(
                                    "The included file '{path}' was not found in the workspace or the linked game's XS folder, so its declarations are unknown."
                                ),
                                path_range,
                            ),
                        );
                    }
                    Some(target) => {
                        if stack.contains(target.id()) {
                            self.argument_order_complete = false;
                            self.report_at(
                                file.id(),
                                XsDiagnostic::error(
                                    "XS3022",
                                    format!("Including '{path}' here creates a circular include."),
                                    path_range,
                                ),
                            );
                        } else if self.files.iter().any(|known| known.id() == target.id()) {
                        } else if stack.len() >= MAXIMUM_INCLUDE_DEPTH
                            || self.files.len() >= MAXIMUM_UNIT_FILES
                        {
                            self.out.complete = false;
                            self.report_at(
                                file.id(),
                                XsDiagnostic::new(
                                    "XS9001",
                                    Severity::Warning,
                                    "Includes are nested too deeply or name too many files for the editor to analyze; this include is skipped.",
                                    path_range,
                                ),
                            );
                        } else {
                            let index = self.files.len();
                            self.files.push(target.clone());
                            self.out.files.push(target.id().clone());
                            stack.push(target.id().clone());
                            self.plan(index, stack);
                            stack.pop();
                        }
                    }
                }
            }
            self.events.push(Event {
                file: file_index,
                item: item_index,
            });
        }
    }

    fn push_diagnostic(
        out: &mut UnitAnalysis,
        suppressed: &mut BTreeMap<SourceId, usize>,
        id: &SourceId,
        diagnostic: XsDiagnostic,
    ) {
        let list = out.diagnostics.entry(id.clone()).or_default();
        if list.len() < MAXIMUM_FILE_DIAGNOSTICS {
            list.push(diagnostic);
        } else {
            *suppressed.entry(id.clone()).or_default() += 1;
        }
    }

    fn report_at(&mut self, id: &SourceId, diagnostic: XsDiagnostic) {
        if self.files[..self.environment_files]
            .iter()
            .any(|file| file.id() == id)
        {
            return;
        }
        self.reported_errors += usize::from(diagnostic.severity == Severity::Error);
        Self::push_diagnostic(&mut self.out, &mut self.suppressed, id, diagnostic);
    }

    fn report(&mut self, diagnostic: XsDiagnostic) {
        if self.in_environment() {
            return;
        }
        self.reported_errors += usize::from(diagnostic.severity == Severity::Error);
        let id = self.files[self.current_file].id().clone();
        Self::push_diagnostic(&mut self.out, &mut self.suppressed, &id, diagnostic);
    }

    fn error(&mut self, code: &'static str, message: String, range: ByteRange) {
        self.report(XsDiagnostic::error(code, message, range));
    }

    fn error_related(
        &mut self,
        code: &'static str,
        message: String,
        range: ByteRange,
        related: Option<RelatedLocation>,
    ) {
        self.report(XsDiagnostic::error(code, message, range).with_related(related));
    }

    fn declared_at(&self, id: SymbolId, message: String) -> Option<RelatedLocation> {
        let symbol = self.out.symbol(id);
        (symbol.source_id.as_str() != ENGINE_CONSTANTS_ID).then(|| RelatedLocation {
            source_id: symbol.source_id.clone(),
            range: symbol.selection_range,
            message,
        })
    }

    fn related_here(&self, range: ByteRange, message: String) -> Option<RelatedLocation> {
        Some(RelatedLocation {
            source_id: self.current_id(),
            range,
            message,
        })
    }

    fn warning(&mut self, code: &'static str, message: String, range: ByteRange) {
        self.report(XsDiagnostic::new(code, Severity::Warning, message, range));
    }

    fn current_id(&self) -> SourceId {
        self.files[self.current_file].id().clone()
    }

    fn current(&self) -> Arc<XsFile> {
        self.files[self.current_file].clone()
    }

    fn in_environment(&self) -> bool {
        self.current_file < self.environment_files
    }

    fn location(&self, id: SymbolId) -> String {
        let symbol = self.out.symbol(id);
        let file = self
            .files
            .iter()
            .find(|file| *file.id() == symbol.source_id);
        let line = file
            .and_then(|file| file.source.byte_to_utf16(symbol.selection_range.start).ok())
            .map_or(0, |position| position.line + 1);
        let name = symbol
            .source_id
            .as_str()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_owned();
        if symbol.source_id.as_str() == ENGINE_CONSTANTS_ID {
            "the game's built-in constants".to_owned()
        } else if symbol.from_environment {
            "the game's constants file".to_owned()
        } else {
            format!("{name} line {line}")
        }
    }

    fn add_symbol(&mut self, symbol: Symbol) -> SymbolId {
        let id = SymbolId(self.out.symbols.len() as u32);
        self.out.symbols.push(symbol);
        id
    }

    fn add_reference(&mut self, range: ByteRange, target: Target) {
        if self.in_environment() {
            return;
        }
        let source_id = self.current_id();
        self.out.references.push(Reference {
            source_id,
            range,
            target,
        });
    }

    fn new_symbol(
        &self,
        name: &str,
        kind: SymbolKind,
        ty: Ty,
        selection: ByteRange,
        range: ByteRange,
    ) -> Symbol {
        let file = self.current();
        Symbol {
            name: name.to_owned(),
            kind,
            ty,
            source_id: file.id().clone(),
            selection_range: selection,
            range,
            detail: String::new(),
            documentation: leading_comment(&file, range.start),
            container: None,
            signature: None,
            is_const: false,
            is_mutable: false,
            from_environment: self.in_environment(),
            scope: None,
        }
    }

    fn declare_global(&mut self, symbol: Symbol, order: usize) -> SymbolId {
        let name = symbol.name.clone();
        let range = symbol.selection_range;
        let kind = symbol.kind;
        let new_signature = symbol.signature.clone();
        let id = self.add_symbol(symbol);
        if name.is_empty() {
            return id;
        }
        self.check_builtin_conflict(&name, kind, range);
        if let Some(previous) = self
            .globals
            .get(&name)
            .and_then(|entries| entries.last())
            .map(|(_, id)| *id)
        {
            let previous_symbol = self.out.symbol(previous).clone();
            let overridable = previous_symbol.kind == SymbolKind::Function
                && kind == SymbolKind::Function
                && self.globals.get(&name).is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|(_, id)| self.out.symbol(*id).is_mutable)
                });
            if overridable {
                if let (Some(old), Some(new)) = (&previous_symbol.signature, &new_signature) {
                    self.check_override(&name, previous, old, new, range);
                }
            } else {
                let what = if kind == SymbolKind::Rule {
                    "cannot be a rule name"
                } else if kind == SymbolKind::RuleGroup {
                    "cannot be a rule group name"
                } else if kind == SymbolKind::Function {
                    "cannot be redefined (declare the first definition 'mutable' to allow overriding)"
                } else {
                    "cannot be declared again"
                };
                let location = self.location(previous);
                let related =
                    self.declared_at(previous, format!("'{name}' is already defined here"));
                self.error_related(
                    "XS3004",
                    format!("'{name}' is already defined ({location}) and {what}."),
                    range,
                    related,
                );
            }
        }
        self.globals.entry(name).or_default().push((order, id));
        id
    }

    fn check_override(
        &mut self,
        name: &str,
        previous: SymbolId,
        old: &FunctionSignature,
        new: &FunctionSignature,
        range: ByteRange,
    ) {
        let problem = if old.return_type != new.return_type {
            Some(format!(
                "returns {} but the mutable definition returns {}",
                new.return_type.label(),
                old.return_type.label()
            ))
        } else if old.params.len() != new.params.len() {
            Some(format!(
                "takes {} parameters but the mutable definition takes {}",
                new.params.len(),
                old.params.len()
            ))
        } else {
            old.params
                .iter()
                .zip(&new.params)
                .position(|(left, right)| left.1 != right.1)
                .map(|index| {
                    format!(
                        "parameter {} has a different type than in the mutable definition",
                        index + 1
                    )
                })
        };
        if let Some(problem) = problem {
            let related = self.declared_at(
                previous,
                format!("the definition of '{name}' this override must match"),
            );
            self.error_related(
                "XS3019",
                format!(
                    "This override of '{name}' {problem}; overrides must keep the same signature."
                ),
                range,
                related,
            );
        }
    }

    fn check_builtin_conflict(&mut self, name: &str, kind: SymbolKind, range: ByteRange) {
        if self.in_environment() {
            return;
        }
        let Some(builtin) = self.catalog.and_then(|catalog| catalog.get(name)) else {
            return;
        };
        let conflicts_now = match self.options.build {
            Some(build) => builtin.available_in(build),
            None => crate::catalog::XsBuild::ALL
                .iter()
                .all(|build| builtin.available_in(*build)),
        };
        let what = kind.label();
        if conflicts_now {
            self.error(
                "XS3005",
                format!("'{name}' is the name of a built-in XS function; choose another name for this {what}."),
                range,
            );
        } else {
            let versions = if self.options.build.is_some() {
                "another game version"
            } else {
                "some game versions"
            };
            self.warning(
                "XS4008",
                format!("'{name}' is the name of a built-in XS function in {versions}; this {what} will not compile there."),
                range,
            );
        }
    }

    fn declare_item(&mut self, event: Event, order: usize) {
        let file = self.files[event.file].clone();
        match &file.tree.items[event.item] {
            Item::Variable(variable) => {
                let kind = if variable.modifiers.const_.is_some() {
                    SymbolKind::Constant
                } else {
                    SymbolKind::GlobalVariable
                };
                let mut symbol = self.new_symbol(
                    &variable.name.text,
                    kind,
                    self.resolved_type(&variable.ty),
                    variable.name.range,
                    variable.range,
                );
                symbol.is_const = variable.modifiers.const_.is_some();
                symbol.detail = variable_detail(&file, variable);
                self.declare_global(symbol, order);
            }
            Item::Function(function) => {
                let mut symbol = self.new_symbol(
                    &function.name.text,
                    SymbolKind::Function,
                    self.resolved_type(&function.return_type),
                    function.name.range,
                    function.range,
                );
                symbol.is_mutable = function.modifiers.mutable.is_some();
                symbol.signature = Some(FunctionSignature {
                    return_type: self.resolved_type(&function.return_type),
                    params: function
                        .params
                        .iter()
                        .map(|param| (param.name.text.clone(), self.resolved_type(&param.ty)))
                        .collect(),
                });
                symbol.detail = function_detail(&file, function);
                self.declare_global(symbol, order);
            }
            Item::Rule(rule) => {
                let mut symbol = self.new_symbol(
                    &rule.name.text,
                    SymbolKind::Rule,
                    Ty::Void,
                    rule.name.range,
                    rule.range,
                );
                symbol.detail = rule_detail(&file, rule);
                let id = self.declare_global(symbol, order);
                if !rule.name.text.is_empty() {
                    self.rules.entry(rule.name.text.clone()).or_insert(id);
                }
                for modifier in &rule.modifiers {
                    if let (RuleModifierKind::Group, Some(group)) = (modifier.kind, &modifier.name)
                        && !self.groups.contains_key(&group.text)
                    {
                        let mut symbol = self.new_symbol(
                            &group.text,
                            SymbolKind::RuleGroup,
                            Ty::Void,
                            group.range,
                            group.range,
                        );
                        symbol.detail = format!("rule group {}", group.text);
                        symbol.documentation = None;
                        let id = self.declare_global(symbol, order);
                        self.groups.insert(group.text.clone(), id);
                    }
                }
            }
            Item::Class(class) => self.declare_class(&file, class, order),
            Item::Include(_) | Item::Pragma { .. } | Item::Error(_) => {}
        }
    }

    fn declare_class(&mut self, file: &XsFile, class: &ClassDecl, order: usize) {
        let mut symbol = self.new_symbol(
            &class.name.text,
            SymbolKind::Class,
            Ty::Class(class.name.text.clone()),
            class.name.range,
            class.range,
        );
        symbol.detail = format!("class {}", class.name.text);
        let id = self.declare_global(symbol, order);
        if class.name.text.is_empty() {
            return;
        }
        self.classes.entry(class.name.text.clone()).or_insert(id);
        let mut members = BTreeMap::new();
        for member in &class.members {
            let mut symbol = self.new_symbol(
                &member.name.text,
                SymbolKind::Member,
                self.resolved_type(&member.ty),
                member.name.range,
                member.range,
            );
            symbol.container = Some(id);
            symbol.detail = variable_detail(file, member);
            let member_id = self.add_symbol(symbol);
            if let Some(previous) = members.insert(member.name.text.clone(), member_id) {
                let related = self.declared_at(
                    previous,
                    format!("'{}' is already defined here", member.name.text),
                );
                self.error_related(
                    "XS3004",
                    format!("Class member '{}' is already defined.", member.name.text),
                    member.name.range,
                    related,
                );
            }
        }
        self.members.insert(id, members);
    }

    fn check_item(&mut self, event: Event, order: usize) {
        let file = self.files[event.file].clone();
        if self.in_environment() {
            return;
        }
        match &file.tree.items[event.item] {
            Item::Variable(variable) => self.check_global_variable(variable),
            Item::Function(function) => self.check_function(function, order),
            Item::Rule(rule) => self.check_rule(rule, order),
            Item::Class(class) => {
                for member in &class.members {
                    self.check_type_exists(&member.ty);
                    self.check_constant_declaration(member, "Class member");
                }
            }
            Item::Pragma { value, .. } => {
                if let Some(value) = value {
                    self.expr(value);
                }
            }
            Item::Include(_) | Item::Error(_) => {}
        }
    }

    fn resolved_type(&self, reference: &TypeRef) -> Ty {
        match reference {
            TypeRef::Class(name) if !self.classes.contains_key(&name.text) => Ty::Unknown,
            _ => Ty::from_ref(reference),
        }
    }

    fn check_type_exists(&mut self, ty: &TypeRef) {
        if let TypeRef::Class(name) = ty {
            match self.classes.get(&name.text).copied() {
                Some(id) => self.add_reference(name.range, Target::Symbol(id)),
                None => self.error(
                    "XS3024",
                    format!("'{}' is not a type: XS types are int, float, bool, string, vector, and declared classes.", name.text),
                    name.range,
                ),
            }
        }
    }

    fn check_global_variable(&mut self, variable: &VarDecl) {
        self.check_type_exists(&variable.ty);
        let modifiers = variable.modifiers;
        if let Some(range) = modifiers.static_ {
            self.error(
                "XS3020",
                format!("'static' is only valid for variables inside a function{SILENT_REJECTION}"),
                range,
            );
        }
        self.check_modifier_combinations(&modifiers);
        self.check_reserved_name(&variable.name);
        self.check_constant_declaration(variable, "Global variable");
    }

    fn check_reserved_name(&mut self, name: &Name) {
        if Keyword::from_bytes(name.text.as_bytes()).is_some_and(Keyword::is_reserved_rule_word) {
            self.warning(
                "XS4024",
                format!(
                    "'{}' is a reserved XS word (a rule setting): the game accepts this declaration, but any use of the name in an expression fails to compile. Choose another name.",
                    name.text
                ),
                name.range,
            );
        }
    }

    fn check_modifier_combinations(&mut self, modifiers: &Modifiers) {
        if let (Some(range), true) = (
            modifiers.export,
            modifiers.const_.is_some() || modifiers.static_.is_some(),
        ) {
            self.error(
                "XS3020",
                format!(
                    "An 'export' variable cannot also be 'const' or 'static'{SILENT_REJECTION}"
                ),
                range,
            );
        } else if let (Some(range), true) = (modifiers.extern_, modifiers.static_.is_some()) {
            self.error(
                "XS3020",
                format!("An 'extern' variable cannot also be 'static'{SILENT_REJECTION}"),
                range,
            );
        } else if let (Some(range), true) = (modifiers.const_, modifiers.static_.is_some()) {
            self.error(
                "XS3020",
                format!("A 'const' variable cannot also be 'static'{SILENT_REJECTION}"),
                range,
            );
        }
    }

    fn check_constant_declaration(&mut self, variable: &VarDecl, what: &str) {
        let target = self.resolved_type(&variable.ty);
        match &variable.init {
            None => self.error(
                "XS3027",
                format!(
                    "{what} '{}' needs an initial value written as a literal or constant, for example '= {}'.",
                    variable.name.text,
                    example_value(&target)
                ),
                variable.name.range,
            ),
            Some(init) => self.check_constant_value(init, &target),
        }
    }

    fn check_constant_value(&mut self, value: &Expr, target: &Ty) {
        let ty = match constant_shape(value) {
            ConstantShape::Literal(ty) => ty,
            ConstantShape::Name(name, range) => match self.resolve(&name) {
                Resolution::Symbol(id) => {
                    self.add_reference(range, Target::Symbol(id));
                    let symbol = self.out.symbol(id).clone();
                    if !symbol.is_const {
                        self.error(
                            "XS3016",
                            format!(
                                "'{name}' is not a constant; this value must be a literal or a const variable."
                            ),
                            range,
                        );
                        return;
                    }
                    symbol.ty.clone()
                }
                Resolution::Later(id) => {
                    self.add_reference(range, Target::Symbol(id));
                    let location = self.location(id);
                    let related = self.declared_at(id, format!("'{name}' is declared here"));
                    self.error_related(
                        "XS3003",
                        format!("'{name}' is used before its declaration ({location}); XS reads scripts top to bottom."),
                        range,
                        related,
                    );
                    return;
                }
                Resolution::Builtin(_) | Resolution::None => {
                    self.report_undefined_variable(&name, range);
                    return;
                }
            },
            ConstantShape::Vector(components) => {
                for component in components {
                    if !matches!(
                        constant_shape(component),
                        ConstantShape::Literal(Ty::Int | Ty::Float)
                    ) {
                        self.error(
                            "XS3016",
                            "A vector constant needs number literals: vector(x, y, z).".to_owned(),
                            component.range,
                        );
                    }
                }
                Ty::Vector
            }
            ConstantShape::Other => {
                self.expr(value);
                self.error(
                    "XS3016",
                    "This value must be a literal or a const variable; expressions and calls are not allowed here.".to_owned(),
                    value.range,
                );
                return;
            }
        };
        if incompatible(target, &ty) {
            self.error(
                "XS3006",
                format!(
                    "Expected a {} value here, found {}.",
                    target.label(),
                    ty.label()
                ),
                value.range,
            );
        }
    }

    fn begin_body(&mut self, return_type: Ty, is_rule: bool, order: usize, range: ByteRange) {
        self.fx = FunctionContext {
            return_type: Some(return_type),
            is_rule,
            order,
            scopes: vec![BTreeMap::new()],
            scope_declarations: vec![BTreeMap::new()],
            scope_ranges: vec![range],
            ..FunctionContext::default()
        };
    }

    fn end_body(&mut self) {
        let locals = std::mem::take(&mut self.fx.all_locals);
        for id in locals {
            let symbol = self.out.symbol(id).clone();
            if symbol.kind == SymbolKind::LocalVariable
                && self.fx.reads.get(&id).copied().unwrap_or(0) == 0
            {
                self.report(
                    XsDiagnostic::new(
                        "XS4001",
                        Severity::Warning,
                        format!("Local variable '{}' is never read.", symbol.name),
                        symbol.selection_range,
                    )
                    .with_tag(DiagnosticTag::Unnecessary),
                );
            }
        }
        self.fx = FunctionContext::default();
    }

    fn check_function(&mut self, function: &FunctionDecl, order: usize) {
        self.check_type_exists(&function.return_type);
        let return_type = self.resolved_type(&function.return_type);
        self.begin_body(return_type.clone(), false, order, function.range);
        for param in &function.params {
            record_scope_declaration(&mut self.fx.scope_declarations[0], &param.name);
        }
        self.check_reserved_name(&function.name);
        if function.name.text == "main" && !function.params.is_empty() {
            self.error(
                "XS3018",
                "The main function cannot take parameters.".to_owned(),
                function.params_range,
            );
        }
        for param in &function.params {
            self.declare_parameter(param, function.range);
        }
        if let Some(body) = &function.body {
            self.collect_labels(&body.stmts);
            self.block_contents(body, false);
            if return_type != Ty::Void && return_type.is_known() && !self.fx.has_value_return {
                self.error(
                    "XS3011",
                    format!(
                        "'{}' returns {} but never returns a value.",
                        function.name.text,
                        return_type.label()
                    ),
                    function.name.range,
                );
            }
        }
        self.end_body();
    }

    fn declare_parameter(&mut self, param: &Param, scope: ByteRange) {
        self.check_type_exists(&param.ty);
        self.check_reserved_name(&param.name);
        let ty = self.resolved_type(&param.ty);
        if let Some(default) = &param.default {
            self.check_constant_value(default, &ty);
        }
        let mut symbol = self.new_symbol(
            &param.name.text,
            SymbolKind::Parameter,
            ty.clone(),
            param.name.range,
            param.range,
        );
        symbol.documentation = None;
        symbol.detail = format!("{} {}", ty.label(), param.name.text);
        symbol.scope = Some(scope);
        self.check_shadowing(&param.name.text, param.name.range);
        let id = self.add_symbol(symbol);
        if let Some(previous) = self.fx.scopes[0].insert(param.name.text.clone(), id) {
            self.ambiguous_locals.extend([previous, id]);
            let related = self.declared_at(
                previous,
                format!("'{}' is already defined here", param.name.text),
            );
            self.error_related(
                "XS3004",
                format!("Parameter '{}' is already defined.", param.name.text),
                param.name.range,
                related,
            );
        }
    }

    fn check_rule(&mut self, rule: &RuleDecl, order: usize) {
        self.check_reserved_name(&rule.name);
        let mut seen = BTreeMap::<&'static str, ByteRange>::new();
        let mut min_interval = None;
        let mut max_interval = None;
        for modifier in &rule.modifiers {
            let slot = match modifier.kind {
                RuleModifierKind::Active | RuleModifierKind::Inactive => Some("active/inactive"),
                RuleModifierKind::Priority => Some("priority"),
                RuleModifierKind::MinInterval => Some("minInterval"),
                RuleModifierKind::MaxInterval => Some("maxInterval"),
                RuleModifierKind::RunImmediately => Some("runImmediately"),
                RuleModifierKind::Group | RuleModifierKind::HighFrequency => None,
            };
            if let Some(slot) = slot {
                match seen.get(slot).copied() {
                    Some(first) => {
                        let related =
                            self.related_here(first, format!("{slot} is first given here"));
                        self.error_related(
                            "XS3017",
                            format!("The rule setting {slot} is given more than once."),
                            modifier.range,
                            related,
                        );
                    }
                    None => {
                        seen.insert(slot, modifier.range);
                    }
                }
            }
            if let Some(group) = &modifier.name
                && let Some(id) = self.groups.get(&group.text).copied()
            {
                self.add_reference(group.range, Target::Symbol(id));
            }
            if let Some(value) = &modifier.value {
                self.check_constant_value(value, &Ty::Int);
                let literal = match &value.kind {
                    ExprKind::Literal(Literal::Integer(number)) => Some(*number),
                    _ => None,
                };
                match modifier.kind {
                    RuleModifierKind::MinInterval => {
                        min_interval = literal.map(|value| (value, modifier.range))
                    }
                    RuleModifierKind::MaxInterval => {
                        max_interval = literal.map(|value| (value, modifier.range))
                    }
                    _ => {}
                }
            }
        }
        if let (Some((minimum, minimum_range)), Some((maximum, range))) =
            (min_interval, max_interval)
            && minimum > maximum
        {
            let related = self.related_here(minimum_range, format!("minInterval {minimum}"));
            self.report(
                XsDiagnostic::new(
                    "XS4023",
                    Severity::Warning,
                    format!("maxInterval {maximum} is smaller than minInterval {minimum}."),
                    range,
                )
                .with_related(related),
            );
        }
        self.begin_body(Ty::Void, true, order, rule.range);
        if let Some(body) = &rule.body {
            self.collect_labels(&body.stmts);
            self.block_contents(body, false);
        }
        self.end_body();
    }

    fn collect_labels(&mut self, stmts: &[Stmt]) {
        for stmt in stmts {
            self.collect_labels_in(stmt);
        }
    }

    fn collect_labels_in(&mut self, stmt: &Stmt) {
        match &stmt.kind {
            StmtKind::Label(Some(name)) => {
                let mut symbol = self.new_symbol(
                    &name.text,
                    SymbolKind::Label,
                    Ty::Void,
                    name.range,
                    stmt.range,
                );
                symbol.documentation = None;
                symbol.detail = format!("label {}", name.text);
                let id = self.add_symbol(symbol);
                if let Some(previous) = self.fx.labels.insert(name.text.clone(), id) {
                    let related = self
                        .declared_at(previous, format!("'{}' is already defined here", name.text));
                    self.error_related(
                        "XS3004",
                        format!("Label '{}' is already defined.", name.text),
                        name.range,
                        related,
                    );
                }
            }
            StmtKind::Block(block) => self.collect_labels(&block.stmts),
            StmtKind::If {
                then_branch,
                else_branch,
                ..
            } => {
                for branch in [then_branch, else_branch].into_iter().flatten() {
                    self.collect_labels_in(branch);
                }
            }
            StmtKind::While { body, .. } | StmtKind::For { body, .. } => {
                if let Some(body) = body {
                    self.collect_labels_in(body);
                }
            }
            StmtKind::Switch { cases, .. } => {
                for case in cases {
                    self.collect_labels(&case.body);
                }
            }
            _ => {}
        }
    }

    fn push_scope(&mut self, range: ByteRange, stmts: &[Stmt]) {
        self.fx.scopes.push(BTreeMap::new());
        self.fx.scope_declarations.push(local_declarations(stmts));
        self.fx.scope_ranges.push(range);
    }

    fn pop_scope(&mut self) {
        self.fx.scopes.pop();
        self.fx.scope_declarations.pop();
        self.fx.scope_ranges.pop();
    }

    fn block_contents(&mut self, block: &Block, new_scope: bool) -> bool {
        if new_scope {
            self.push_scope(block.range, &block.stmts);
        } else if let Some(declarations) = self.fx.scope_declarations.last_mut() {
            for stmt in &block.stmts {
                if let StmtKind::Variable(variable) = &stmt.kind {
                    record_scope_declaration(declarations, &variable.name);
                }
            }
        }
        let terminates = self.statement_list(&block.stmts);
        if new_scope {
            self.pop_scope();
        }
        terminates
    }

    fn statement_list(&mut self, stmts: &[Stmt]) -> bool {
        let mut terminated = false;
        let mut reported = false;
        for (index, stmt) in stmts.iter().enumerate() {
            if matches!(stmt.kind, StmtKind::Label(_)) {
                terminated = false;
                reported = false;
            } else if terminated && !reported && !matches!(stmt.kind, StmtKind::Empty) {
                reported = true;
                let end = stmts[index..]
                    .iter()
                    .take_while(|stmt| !matches!(stmt.kind, StmtKind::Label(_)))
                    .last()
                    .map_or(stmt.range.end, |last| last.range.end);
                self.report(
                    XsDiagnostic::new(
                        "XS4003",
                        Severity::Warning,
                        "This code can never run because the code before it always leaves this block.",
                        ByteRange {
                            start: stmt.range.start,
                            end,
                        },
                    )
                    .with_tag(DiagnosticTag::Unnecessary),
                );
            }
            if self.statement(stmt) {
                terminated = true;
            }
        }
        terminated
    }

    fn nested_statement(&mut self, stmt: &Stmt) -> bool {
        if let StmtKind::Block(block) = &stmt.kind {
            return self.block_contents(block, true);
        }
        if matches!(stmt.kind, StmtKind::Empty) {
            self.warning(
                "XS4013",
                "This ';' is the whole body; the following code is not part of it.".to_owned(),
                stmt.range,
            );
        }
        self.push_scope(stmt.range, std::slice::from_ref(stmt));
        let terminates = self.statement(stmt);
        self.pop_scope();
        terminates
    }

    fn statement(&mut self, stmt: &Stmt) -> bool {
        match &stmt.kind {
            StmtKind::Block(block) => self.block_contents(block, true),
            StmtKind::Variable(variable) => {
                self.local_variable(variable);
                false
            }
            StmtKind::Class(class) => {
                self.error(
                    "XS3023",
                    "Classes must be declared at file scope, not inside a function or rule."
                        .to_owned(),
                    class.name.range,
                );
                false
            }
            StmtKind::Assign { target, op, value } => {
                self.assignment(target, *op, value.as_ref());
                false
            }
            StmtKind::Expr(expr) => {
                self.expression_statement(expr);
                false
            }
            StmtKind::If {
                condition,
                then_branch,
                else_branch,
            } => {
                if let Some(condition) = condition {
                    self.value_expr(condition);
                }
                let then_terminates = then_branch
                    .as_ref()
                    .is_some_and(|branch| self.nested_statement(branch));
                let else_terminates = else_branch
                    .as_ref()
                    .is_some_and(|branch| self.nested_statement(branch));
                then_terminates && else_terminates
            }
            StmtKind::While { condition, body } => {
                if let Some(condition) = condition {
                    self.value_expr(condition);
                }
                self.fx.loop_depth += 1;
                if let Some(body) = body {
                    self.nested_statement(body);
                }
                self.fx.loop_depth -= 1;
                false
            }
            StmtKind::For {
                variable,
                start,
                limit,
                body,
                ..
            } => {
                if let Some(variable) = variable {
                    self.loop_variable(variable, stmt.range);
                }
                for value in [start, limit].into_iter().flatten() {
                    let ty = self.value_expr(value);
                    if incompatible(&Ty::Int, &ty) {
                        self.error(
                            "XS3006",
                            format!("Loop bounds must be numbers, found {}.", ty.label()),
                            value.range,
                        );
                    }
                }
                self.fx.loop_depth += 1;
                if let Some(body) = body {
                    self.nested_statement(body);
                }
                self.fx.loop_depth -= 1;
                false
            }
            StmtKind::Switch { scrutinee, cases } => {
                if let Some(scrutinee) = scrutinee {
                    self.value_expr(scrutinee);
                }
                self.fx.switch_depth += 1;
                for case in cases {
                    if let Some(label) = &case.label {
                        self.value_expr(label);
                    }
                    self.push_scope(case.range, &case.body);
                    self.statement_list(&case.body);
                    self.pop_scope();
                }
                self.fx.switch_depth -= 1;
                false
            }
            StmtKind::Break => {
                if self.fx.loop_depth == 0 && self.fx.switch_depth == 0 {
                    self.error(
                        "XS3013",
                        "'break' is only valid inside a loop or a switch.".to_owned(),
                        stmt.range,
                    );
                }
                true
            }
            StmtKind::Continue => {
                if self.fx.loop_depth == 0 {
                    self.error(
                        "XS3014",
                        "'continue' is only valid inside a loop.".to_owned(),
                        stmt.range,
                    );
                }
                true
            }
            StmtKind::Return(value) => {
                self.return_statement(value.as_ref(), stmt.range);
                true
            }
            StmtKind::Goto(name) => {
                if let Some(name) = name {
                    match self.fx.labels.get(&name.text).copied() {
                        Some(id) => self.add_reference(name.range, Target::Symbol(id)),
                        None => self.error(
                            "XS3021",
                            format!("There is no label '{}' in this function.", name.text),
                            name.range,
                        ),
                    }
                }
                true
            }
            StmtKind::Label(_) => false,
            StmtKind::Dbg(name) => {
                if let Some(name) = name {
                    self.name_value(&name.text, name.range);
                }
                false
            }
            StmtKind::Pragma { value, .. } => {
                if let Some(value) = value {
                    self.value_expr(value);
                }
                false
            }
            StmtKind::Breakpoint | StmtKind::Empty | StmtKind::Error => false,
        }
    }

    fn return_statement(&mut self, value: Option<&Expr>, range: ByteRange) {
        let expected = self.fx.return_type.clone().unwrap_or(Ty::Unknown);
        match value {
            Some(value) => {
                let ty = self.value_expr(value);
                if expected == Ty::Void {
                    let what = if self.fx.is_rule {
                        "A rule"
                    } else {
                        "A void function"
                    };
                    self.error(
                        "XS3012",
                        format!("{what} cannot return a value."),
                        value.range,
                    );
                } else {
                    self.fx.has_value_return = true;
                    if incompatible(&expected, &ty) {
                        self.error(
                            "XS3006",
                            format!(
                                "This function returns {}, but the value is {}.",
                                expected.label(),
                                ty.label()
                            ),
                            value.range,
                        );
                    }
                }
            }
            None => {
                let _ = range;
            }
        }
    }

    fn local_variable(&mut self, variable: &VarDecl) {
        self.check_type_exists(&variable.ty);
        let modifiers = variable.modifiers;
        if let Some(range) = modifiers.export {
            self.error(
                "XS3020",
                format!("'export' is only valid for file-scope variables{SILENT_REJECTION}"),
                range,
            );
        } else if let Some(range) = modifiers.extern_ {
            self.error(
                "XS3020",
                format!("'extern' is only valid for file-scope variables{SILENT_REJECTION}"),
                range,
            );
        }
        self.check_modifier_combinations(&modifiers);
        let ty = self.resolved_type(&variable.ty);
        if modifiers.const_.is_some() || modifiers.static_.is_some() {
            self.check_reserved_name(&variable.name);
            self.check_constant_declaration(variable, "A const or static variable");
        } else if let Some(init) = &variable.init {
            let value = self.value_expr(init);
            if incompatible(&ty, &value) {
                self.error(
                    "XS3006",
                    format!(
                        "'{}' is {}, but the value is {}.",
                        variable.name.text,
                        ty.label(),
                        value.label()
                    ),
                    init.range,
                );
            }
        }
        let scope_range = self
            .fx
            .scope_ranges
            .last()
            .copied()
            .unwrap_or(variable.range);
        let mut symbol = self.new_symbol(
            &variable.name.text,
            SymbolKind::LocalVariable,
            ty,
            variable.name.range,
            variable.range,
        );
        symbol.is_const = modifiers.const_.is_some();
        symbol.detail = variable_detail(&self.current(), variable);
        symbol.documentation = None;
        symbol.scope = Some(ByteRange {
            start: variable.range.start,
            end: scope_range.end,
        });
        self.declare_local(symbol);
    }

    fn declare_local(&mut self, symbol: Symbol) -> SymbolId {
        let name = symbol.name.clone();
        let range = symbol.selection_range;
        let in_current = self
            .fx
            .scopes
            .last()
            .and_then(|scope| scope.get(&name).copied());
        if let Some(previous) = in_current {
            let related = self.declared_at(previous, format!("'{name}' is already defined here"));
            self.error_related(
                "XS3004",
                format!("'{name}' is already defined in this block."),
                range,
                related,
            );
        } else {
            self.check_shadowing(&name, range);
        }
        if !name.is_empty() {
            self.check_builtin_conflict(&name, symbol.kind, range);
        }
        let id = self.add_symbol(symbol);
        if let Some(scope) = self.fx.scopes.last_mut()
            && let Some(previous) = scope.insert(name, id)
        {
            self.ambiguous_locals.extend([previous, id]);
        }
        self.fx.all_locals.push(id);
        id
    }

    fn check_shadowing(&mut self, name: &str, range: ByteRange) {
        if name.is_empty() {
            return;
        }
        let outer_local = self
            .fx
            .scopes
            .iter()
            .rev()
            .skip(1)
            .find_map(|scope| scope.get(name).copied());
        let global = self
            .globals
            .get(name)
            .and_then(|entries| entries.first())
            .map(|(_, id)| *id);
        if let Some(outer) = outer_local {
            let related = self.declared_at(outer, format!("the hidden '{name}' is declared here"));
            self.report(
                XsDiagnostic::new(
                    "XS4017",
                    Severity::Warning,
                    format!("'{name}' hides another variable with the same name in this function."),
                    range,
                )
                .with_related(related),
            );
        } else if let Some(global) = global {
            let location = self.location(global);
            let related = self.declared_at(global, format!("the hidden '{name}' is declared here"));
            self.report(
                XsDiagnostic::new(
                    "XS4017",
                    Severity::Warning,
                    format!(
                        "'{name}' hides the file-scope declaration with the same name ({location})."
                    ),
                    range,
                )
                .with_related(related),
            );
        }
    }

    fn loop_variable(&mut self, variable: &xs_syntax::Name, range: ByteRange) {
        match self.resolve(&variable.text) {
            Resolution::Symbol(id) if self.out.symbol(id).kind.is_variable() => {
                self.add_reference(variable.range, Target::Symbol(id));
                *self.fx.reads.entry(id).or_default() += 1;
                let symbol = self.out.symbol(id).clone();
                if symbol.is_const {
                    let related =
                        self.declared_at(id, format!("'{}' is declared const here", variable.text));
                    self.error_related(
                        "XS3015",
                        format!(
                            "'{}' is a constant and cannot be a loop variable.",
                            variable.text
                        ),
                        variable.range,
                        related,
                    );
                }
            }
            _ => {
                let scope_end = self
                    .fx
                    .scope_ranges
                    .last()
                    .map_or(range.end, |scope| scope.end);
                let mut symbol = self.new_symbol(
                    &variable.text,
                    SymbolKind::LoopVariable,
                    Ty::Int,
                    variable.range,
                    range,
                );
                symbol.documentation = None;
                symbol.detail = format!("int {} (loop variable)", variable.text);
                symbol.scope = Some(ByteRange {
                    start: range.start,
                    end: scope_end,
                });
                let id = self.add_symbol(symbol);
                if let Some(scope) = self.fx.scopes.last_mut() {
                    scope.insert(variable.text.clone(), id);
                }
                self.fx.all_locals.push(id);
            }
        }
    }

    fn assignment(&mut self, target: &Expr, op: AssignOp, value: Option<&Expr>) {
        let target_ty = match &target.kind {
            ExprKind::Name(name) => self.assignment_target(&name.text, name.range),
            ExprKind::Member { .. } => self.expr(target),
            _ => {
                self.expr(target);
                self.error(
                    "XS3026",
                    "Only a variable or a class member can be assigned.".to_owned(),
                    target.range,
                );
                Ty::Unknown
            }
        };
        match op {
            AssignOp::Assign => {
                if let Some(value) = value {
                    let ty = self.value_expr(value);
                    if incompatible(&target_ty, &ty) {
                        self.error(
                            "XS3006",
                            format!(
                                "Cannot assign a {} value to a {} variable.",
                                ty.label(),
                                target_ty.label()
                            ),
                            value.range,
                        );
                    }
                    if let (ExprKind::Name(left), ExprKind::Name(right)) =
                        (&target.kind, &value.kind)
                        && left.text == right.text
                    {
                        self.warning(
                            "XS4012",
                            format!("'{}' is assigned to itself.", left.text),
                            target.range,
                        );
                    }
                }
            }
            AssignOp::Increment | AssignOp::Decrement => {
                if target_ty.is_known() && !matches!(target_ty, Ty::Int | Ty::Float) {
                    let operator = if op == AssignOp::Increment {
                        "++"
                    } else {
                        "--"
                    };
                    self.error(
                        "XS3030",
                        format!(
                            "'{operator}' works only on int and float variables, not {}.",
                            target_ty.label()
                        ),
                        target.range,
                    );
                }
            }
        }
    }

    fn assignment_target(&mut self, name: &str, range: ByteRange) -> Ty {
        match self.resolve(name) {
            Resolution::Symbol(id) => {
                self.add_reference(range, Target::Symbol(id));
                let symbol = self.out.symbol(id).clone();
                if !symbol.kind.is_variable() {
                    self.error(
                        "XS3026",
                        format!(
                            "'{name}' is a {} and cannot be assigned.",
                            symbol.kind.label()
                        ),
                        range,
                    );
                    return Ty::Unknown;
                }
                if symbol.is_const {
                    let related = self.declared_at(id, format!("'{name}' is declared const here"));
                    self.error_related(
                        "XS3015",
                        format!("'{name}' is a constant and cannot be changed."),
                        range,
                        related,
                    );
                }
                symbol.ty
            }
            Resolution::Later(id) => {
                self.add_reference(range, Target::Symbol(id));
                let location = self.location(id);
                let related = self.declared_at(id, format!("'{name}' is declared here"));
                self.error_related(
                    "XS3003",
                    format!("'{name}' is used before its declaration ({location}); XS reads scripts top to bottom."),
                    range,
                    related,
                );
                self.out.symbol(id).ty.clone()
            }
            Resolution::Builtin(builtin) => {
                self.add_reference(range, Target::Builtin(builtin.name.clone()));
                self.error(
                    "XS3026",
                    format!("'{name}' is a built-in function and cannot be assigned."),
                    range,
                );
                Ty::Unknown
            }
            Resolution::None => {
                self.report_undefined_variable(name, range);
                Ty::Unknown
            }
        }
    }

    fn expression_statement(&mut self, expr: &Expr) {
        let _ = self.expr(expr);
    }

    fn value_expr(&mut self, expr: &Expr) -> Ty {
        let ty = self.expr(expr);
        self.used_value_type(ty, expr.range)
    }

    fn used_value_type(&mut self, ty: Ty, range: ByteRange) -> Ty {
        if ty == Ty::Void {
            self.error(
                "XS3010",
                "This call returns nothing (void), so its result cannot be used as a value."
                    .to_owned(),
                range,
            );
            return Ty::Unknown;
        }
        ty
    }

    fn expr(&mut self, expr: &Expr) -> Ty {
        match &expr.kind {
            ExprKind::Literal(literal) => literal_type(literal),
            ExprKind::Name(name) => self.name_value(&name.text, name.range),
            ExprKind::Unary { op, operand } => {
                let ty = self.value_expr(operand);
                match op {
                    UnaryOp::Negate | UnaryOp::Plus => match ty {
                        Ty::Int | Ty::Float => ty,
                        _ => Ty::Unknown,
                    },
                }
            }
            ExprKind::Binary { op, left, right } => {
                let left_ty = self.value_expr(left);
                let right_ty = self.value_expr(right);
                if op.is_comparison() || op.is_logical() {
                    return Ty::Bool;
                }
                match op {
                    xs_syntax::BinaryOp::BitAnd | xs_syntax::BinaryOp::BitOr => Ty::Int,
                    xs_syntax::BinaryOp::Add if left_ty == Ty::String || right_ty == Ty::String => {
                        Ty::String
                    }
                    _ => match (&left_ty, &right_ty) {
                        (Ty::Int, Ty::Int) => Ty::Int,
                        (Ty::Int | Ty::Float, Ty::Int | Ty::Float) => Ty::Float,
                        _ => Ty::Unknown,
                    },
                }
            }
            ExprKind::Call {
                callee,
                args,
                extra_commas,
                closed,
                ..
            } => self.call(callee, args, extra_commas, *closed),
            ExprKind::ParenthesizedType {
                ty,
                type_range,
                operand,
            } => {
                let value = match ty {
                    TypeName::Int => "the value 0",
                    TypeName::Float => "the value 0.0",
                    TypeName::Bool => "the value true",
                    _ => "the text \"string\"",
                };
                let message = match operand {
                    Some(operand) => {
                        self.value_expr(operand);
                        let shown = shorten(&slice(&self.current(), operand.range), 32);
                        format!(
                            "XS has no type casts: the game reads '({})' as {value} and ignores '{shown}', so the result is always {value}.",
                            ty.as_str()
                        )
                    }
                    None => format!(
                        "XS has no type casts: the game reads '({})' as {value}.",
                        ty.as_str()
                    ),
                };
                self.warning("XS4025", message, *type_range);
                Ty::from_name(*ty)
            }
            ExprKind::Cast { ty, operand } => {
                if let Some(operand) = operand {
                    let source = self.value_expr(operand);
                    if *ty == TypeName::Int
                        && matches!(source, Ty::String | Ty::Vector | Ty::Class(_))
                    {
                        self.error(
                            "XS3025",
                            format!(
                                "Only int, float, and bool values convert to int, not {}.",
                                source.label()
                            ),
                            operand.range,
                        );
                    }
                }
                if *ty == TypeName::Void {
                    self.error(
                        "XS3025",
                        "Nothing can be converted to void.".to_owned(),
                        expr.range,
                    );
                }
                Ty::from_name(*ty)
            }
            ExprKind::Vector(components) => {
                for component in components {
                    let ty = self.value_expr(component);
                    if incompatible(&Ty::Float, &ty) {
                        self.error(
                            "XS3006",
                            format!("Vector components must be numbers, found {}.", ty.label()),
                            component.range,
                        );
                    }
                }
                if components.len() != 3 {
                    self.error(
                        "XS3007",
                        format!(
                            "vector(x, y, z) takes three components, found {}.",
                            components.len()
                        ),
                        expr.range,
                    );
                }
                Ty::Vector
            }
            ExprKind::Member { object, member } => {
                let object_ty = self.value_expr(object);
                let Ty::Class(class) = object_ty else {
                    return Ty::Unknown;
                };
                let Some(class_id) = self.classes.get(&class).copied() else {
                    return Ty::Unknown;
                };
                match self
                    .members
                    .get(&class_id)
                    .and_then(|members| members.get(&member.text))
                    .copied()
                {
                    Some(id) => {
                        self.add_reference(member.range, Target::Symbol(id));
                        self.out.symbol(id).ty.clone()
                    }
                    None => {
                        self.error(
                            "XS3024",
                            format!("Class '{class}' has no member '{}'.", member.text),
                            member.range,
                        );
                        Ty::Unknown
                    }
                }
            }
            ExprKind::Paren(inner) => self.expr(inner),
            ExprKind::Error => Ty::Unknown,
        }
    }

    fn report_undefined_variable(&mut self, name: &str, range: ByteRange) {
        if !self.out.environment_loaded || !self.out.complete || name.is_empty() {
            return;
        }
        self.error(
            "XS3001",
            format!(
                "'{name}' is not declared in this script, its includes, or the game's constants."
            ),
            range,
        );
    }

    fn name_value(&mut self, name: &str, range: ByteRange) -> Ty {
        self.name_value_with_binding(name, range).0
    }

    fn name_value_with_binding(&mut self, name: &str, range: ByteRange) -> (Ty, Option<SymbolId>) {
        match self.resolve(name) {
            Resolution::Symbol(id) => {
                self.add_reference(range, Target::Symbol(id));
                *self.fx.reads.entry(id).or_default() += 1;
                let symbol = self.out.symbol(id);
                if symbol.kind.is_variable() || symbol.kind == SymbolKind::Member {
                    (
                        symbol.ty.clone(),
                        self.argument_variable_binding(name, id).then_some(id),
                    )
                } else {
                    (Ty::Unknown, None)
                }
            }
            Resolution::Later(id) => {
                self.add_reference(range, Target::Symbol(id));
                let location = self.location(id);
                let related = self.declared_at(id, format!("'{name}' is declared here"));
                self.error_related(
                    "XS3003",
                    format!("'{name}' is used before its declaration ({location}); XS reads scripts top to bottom."),
                    range,
                    related,
                );
                (self.out.symbol(id).ty.clone(), None)
            }
            Resolution::Builtin(builtin) => {
                self.add_reference(range, Target::Builtin(builtin.name.clone()));
                self.check_builtin_availability(builtin, range);
                (builtin.return_type_for(self.options.build), None)
            }
            Resolution::None => {
                self.report_undefined_variable(name, range);
                (Ty::Unknown, None)
            }
        }
    }

    fn resolve(&self, name: &str) -> Resolution {
        for scope in self.fx.scopes.iter().rev() {
            if let Some(id) = scope.get(name) {
                return Resolution::Symbol(*id);
            }
        }
        if let Some(id) = self
            .fx
            .all_locals
            .iter()
            .rev()
            .find(|id| self.out.symbol(**id).name == name)
        {
            return Resolution::Symbol(*id);
        }
        if let Some(entries) = self.globals.get(name) {
            let current = if self.fx.return_type.is_some() {
                self.fx.order
            } else {
                self.current_order
            };
            if let Some((_, id)) = entries.iter().rev().find(|(order, _)| *order <= current) {
                return Resolution::Symbol(*id);
            }
            if let Some((_, id)) = entries.first() {
                return Resolution::Later(*id);
            }
        }
        if let Some(builtin) = self.catalog.and_then(|catalog| catalog.get(name)) {
            return Resolution::Builtin(builtin);
        }
        Resolution::None
    }

    fn check_builtin_availability(&mut self, builtin: &Builtin, range: ByteRange) {
        if let Some(build) = self.options.build
            && !builtin.available_in(build)
        {
            let successor = builtin
                .successor
                .as_ref()
                .filter(|(successor_build, _)| *successor_build == build)
                .map(|(_, name)| name.clone());
            let message = match &successor {
                Some(successor) => format!(
                    "'{}' is not available in the selected game version; it was renamed to '{successor}'.",
                    builtin.name
                ),
                None => format!(
                    "'{}' is not available in the selected game version.",
                    builtin.name
                ),
            };
            let mut diagnostic = XsDiagnostic::error("XS3008", message, range);
            if successor.is_some() {
                diagnostic = diagnostic.with_tag(DiagnosticTag::Deprecated);
            }
            self.report(diagnostic);
        }
        if let Some(runtime) = self.options.runtime
            && !builtin.available_in_runtime(runtime)
        {
            let available = builtin
                .runtimes
                .iter()
                .map(|runtime| runtime.label())
                .collect::<Vec<_>>()
                .join(" and ");
            self.error(
                "XS3009",
                format!(
                    "'{}' is available only to {available}, not to {}.",
                    builtin.name,
                    runtime.label()
                ),
                range,
            );
        }
    }

    fn call(
        &mut self,
        callee: &xs_syntax::Name,
        args: &[Expr],
        extra_commas: &[ByteRange],
        closed: bool,
    ) -> Ty {
        let name = callee.text.as_str();
        match self.resolve(name) {
            Resolution::Symbol(id) => self.user_call(callee, id, false, args, extra_commas, closed),
            Resolution::Later(id) => self.user_call(callee, id, true, args, extra_commas, closed),
            Resolution::Builtin(builtin) => {
                self.add_reference(callee.range, Target::Builtin(builtin.name.clone()));
                self.check_builtin_availability(builtin, callee.range);
                let params = builtin
                    .params_for(self.options.build)
                    .iter()
                    .map(|param| (param.name.clone(), param.ty.clone()))
                    .collect::<Vec<_>>();
                let checked = self.check_arguments(name, &params, args, extra_commas);
                if self.builtin_argument_order_available(builtin, &checked) {
                    self.check_argument_order(
                        name,
                        None,
                        &params,
                        args,
                        extra_commas,
                        closed,
                        &checked,
                    );
                }
                if builtin.is_file_io() {
                    self.report(XsDiagnostic::new(
                        "XS4006",
                        Severity::Information,
                        format!(
                            "'{name}' works with data files in the player's profile while the game runs; the editor does not simulate file access."
                        ),
                        callee.range,
                    ));
                }
                if builtin.is_unsynchronized() {
                    self.report(XsDiagnostic::new(
                        "XS4007",
                        Severity::Information,
                        format!(
                            "'{name}' returns a value that can differ on each player's computer; using it to change the game state can desynchronize multiplayer games."
                        ),
                        callee.range,
                    ));
                }
                if let Some(Expr {
                    kind: ExprKind::Literal(Literal::String(value)),
                    range,
                }) = args.first()
                {
                    let is_rule = RULE_NAME_BUILTINS.contains(&name);
                    let is_group = RULE_GROUP_BUILTINS.contains(&name);
                    if (is_rule || is_group) && !self.in_environment() {
                        let inner = string_inner_range(*range);
                        self.pending_rule_names.push((
                            self.current_id(),
                            inner,
                            value.clone(),
                            is_group,
                        ));
                    }
                }
                builtin.return_type_for(self.options.build)
            }
            Resolution::None => {
                for arg in args {
                    self.value_expr(arg);
                }
                if self.out.complete {
                    self.error(
                        "XS3002",
                        format!("'{name}' is not a declared function or a built-in XS function."),
                        callee.range,
                    );
                }
                Ty::Unknown
            }
        }
    }

    fn user_call(
        &mut self,
        callee: &xs_syntax::Name,
        id: SymbolId,
        later: bool,
        args: &[Expr],
        extra_commas: &[ByteRange],
        closed: bool,
    ) -> Ty {
        let name = callee.text.as_str();
        self.add_reference(callee.range, Target::Symbol(id));
        let symbol = self.out.symbol(id).clone();
        if later {
            let location = self.location(id);
            let related = self.declared_at(id, format!("'{name}' is declared here"));
            self.error_related(
                "XS3003",
                format!("'{name}' is called before its declaration ({location}); XS reads scripts top to bottom (declare it earlier or add a 'mutable' placeholder)."),
                callee.range,
                related,
            );
        }
        let Some(signature) = symbol.signature.clone() else {
            for arg in args {
                self.value_expr(arg);
            }
            self.error(
                "XS3029",
                format!("'{name}' is a {}, not a function.", symbol.kind.label()),
                callee.range,
            );
            return Ty::Unknown;
        };
        let params = signature
            .params
            .iter()
            .map(|(name, ty)| (name.clone(), ty.clone()))
            .collect::<Vec<_>>();
        let checked = self.check_arguments(name, &params, args, extra_commas);
        if !later
            && symbol.kind == SymbolKind::Function
            && !symbol.is_mutable
            && self
                .globals
                .get(name)
                .is_some_and(|entries| entries.len() == 1)
            && self
                .catalog
                .is_none_or(|catalog| catalog.get(name).is_none())
        {
            self.check_argument_order(
                name,
                Some(id),
                &params,
                args,
                extra_commas,
                closed,
                &checked,
            );
        }
        signature.return_type
    }

    fn check_arguments(
        &mut self,
        name: &str,
        params: &[(String, Ty)],
        args: &[Expr],
        extra_commas: &[ByteRange],
    ) -> CheckedArguments {
        let errors_before = self.reported_errors;
        let mut values = Vec::with_capacity(args.len());
        for (index, arg) in args.iter().enumerate() {
            let (ty, variable) = match &arg.kind {
                ExprKind::Name(name) => {
                    let (ty, variable) = self.name_value_with_binding(&name.text, name.range);
                    (self.used_value_type(ty, arg.range), variable)
                }
                _ => (self.value_expr(arg), None),
            };
            if let Some((param_name, param_ty)) = params.get(index)
                && incompatible(param_ty, &ty)
            {
                self.error(
                    "XS3006",
                    format!(
                        "Argument {} of '{name}' ({param_name}) must be {}, found {}.",
                        index + 1,
                        param_ty.label(),
                        ty.label()
                    ),
                    arg.range,
                );
            }
            values.push(CheckedArgument { ty, variable });
        }
        if args.len() > params.len() {
            let start = args[params.len()].range.start;
            let end = args.last().map_or(start, |arg| arg.range.end);
            self.error(
                "XS3007",
                format!(
                    "'{name}' takes at most {} argument{}, but {} were given.",
                    params.len(),
                    if params.len() == 1 { "" } else { "s" },
                    args.len()
                ),
                ByteRange { start, end },
            );
        }
        if params.is_empty() {
            if args.is_empty()
                && let Some(comma) = extra_commas.first()
            {
                self.error(
                    "XS3007",
                    format!("'{name}' takes no arguments, so its parentheses must be empty."),
                    *comma,
                );
            }
        } else {
            for comma in extra_commas {
                self.warning(
                    "XS4026",
                    "The game skips this extra comma: it does not leave a parameter at its default value, so the values after it still fill the parameters in order.".to_owned(),
                    *comma,
                );
            }
        }
        CheckedArguments {
            values,
            error_free: errors_before == self.reported_errors,
        }
    }

    fn argument_variable_binding(&self, name: &str, id: SymbolId) -> bool {
        if !self.out.symbol(id).kind.is_variable() || self.ambiguous_locals.contains(&id) {
            return false;
        }
        for (scope, declarations) in self.fx.scopes.iter().zip(&self.fx.scope_declarations).rev() {
            if let Some(bound) = scope.get(name) {
                return *bound == id
                    && match declarations.get(name) {
                        None => true,
                        Some(Some(range)) => *range == self.out.symbol(id).selection_range,
                        Some(None) => false,
                    };
            }
        }
        self.globals
            .get(name)
            .is_some_and(|entries| entries.len() == 1 && entries[0].1 == id)
    }

    fn builtin_argument_order_available(
        &self,
        builtin: &Builtin,
        checked: &CheckedArguments,
    ) -> bool {
        if !builtin.parameter_names_known {
            return false;
        }
        let runtimes = self.options.runtime.as_slice();
        let admitted_runtime = if runtimes.is_empty() {
            [XsRuntime::Rms, XsRuntime::Trigger, XsRuntime::Ai]
                .iter()
                .all(|runtime| builtin.available_in_runtime(*runtime))
        } else {
            runtimes
                .iter()
                .all(|runtime| builtin.available_in_runtime(*runtime))
        };
        if !admitted_runtime {
            return false;
        }
        let builds = if self.options.build.is_some() {
            self.options.build.as_slice()
        } else {
            &XsBuild::ALL
        };
        let current = builtin.params_for(self.options.build);
        builds.iter().all(|build| {
            let params = builtin.params_for(Some(*build));
            builtin.available_in(*build)
                && checked.values.len() <= params.len()
                && checked
                    .values
                    .iter()
                    .zip(params)
                    .zip(current)
                    .all(|((arg, param), selected)| {
                        param.name == selected.name
                            && param.ty == selected.ty
                            && self.argument_order_compatible(&param.ty, &arg.ty)
                    })
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn check_argument_order(
        &mut self,
        name: &str,
        callee: Option<SymbolId>,
        params: &[(String, Ty)],
        args: &[Expr],
        extra_commas: &[ByteRange],
        closed: bool,
        checked: &CheckedArguments,
    ) {
        if !closed
            || !extra_commas.is_empty()
            || !self.argument_order_complete
            || !self.out.complete
            || self.in_environment()
            || !checked.error_free
            || args.len() > params.len()
            || !checked
                .values
                .iter()
                .zip(params)
                .all(|(arg, (_, ty))| self.argument_order_compatible(ty, &arg.ty))
        {
            return;
        }
        let mut positions = HashMap::with_capacity(params.len());
        for (index, (formal, _)) in params.iter().enumerate() {
            if positions.insert(formal.as_str(), index).is_some() {
                return;
            }
        }
        for (i, arg) in args.iter().enumerate() {
            let ExprKind::Name(left_name) = &arg.kind else {
                continue;
            };
            let Some(&j) = positions.get(left_name.text.as_str()) else {
                continue;
            };
            if j <= i || j >= args.len() {
                continue;
            }
            let ExprKind::Name(right_name) = &args[j].kind else {
                continue;
            };
            if right_name.text != params[i].0
                || !argument_order_name_known(name, &params[i].0)
                || !argument_order_name_known(name, &params[j].0)
                || !self.argument_order_compatible(&params[j].1, &checked.values[i].ty)
                || !self.argument_order_compatible(&params[i].1, &checked.values[j].ty)
            {
                continue;
            }
            let (Some(left), Some(right)) =
                (checked.values[i].variable, checked.values[j].variable)
            else {
                continue;
            };
            if left == right {
                continue;
            }
            let id = self.current_id();
            let pending = self.argument_order_hints.entry(id.clone()).or_default();
            if pending.len() == MAXIMUM_FILE_DIAGNOSTICS {
                *self.suppressed.entry(id).or_default() += 1;
                continue;
            }
            pending.push(ArgumentOrderHint {
                left,
                right,
                range: ByteRange {
                    start: left_name.range.start,
                    end: right_name.range.end,
                },
                callee,
            });
        }
    }

    fn argument_order_compatible(&self, target: &Ty, source: &Ty) -> bool {
        [target, source].into_iter().all(|ty| match ty {
            Ty::Class(name) => self.classes.get(name).is_some_and(|id| {
                self.globals.get(name).is_some_and(|entries| {
                    entries.len() == 1
                        && entries[0].1 == *id
                        && self.out.symbol(*id).kind == SymbolKind::Class
                })
            }),
            Ty::Unknown | Ty::Void => false,
            _ => true,
        }) && (target == source || (target.is_numeric_like() && source.is_numeric_like()))
    }

    fn flush_argument_order_hints(&mut self) {
        for (id, pending) in std::mem::take(&mut self.argument_order_hints) {
            let remaining = MAXIMUM_FILE_DIAGNOSTICS
                .saturating_sub(self.out.diagnostics.get(&id).map_or(0, Vec::len));
            let retained = remaining.min(pending.len());
            if retained < pending.len() {
                *self.suppressed.entry(id.clone()).or_default() += pending.len() - retained;
            }
            for hint in pending.into_iter().take(retained) {
                let left = &self.out.symbol(hint.left).name;
                let right = &self.out.symbol(hint.right).name;
                let related = hint.callee.and_then(|callee| {
                    let name = &self.out.symbol(callee).name;
                    self.declared_at(callee, format!("'{name}' is declared here"))
                });
                let diagnostic = XsDiagnostic::new(
                    "XS4027",
                    Severity::Hint,
                    format!(
                        "Check the argument order: '{left}' fills '{right}', and '{right}' fills '{left}'. This may be intentional."
                    ),
                    hint.range,
                )
                .with_related(related);
                Self::push_diagnostic(&mut self.out, &mut self.suppressed, &id, diagnostic);
            }
        }
    }

    fn resolve_rule_names(&mut self) {
        let pending = std::mem::take(&mut self.pending_rule_names);
        for (source_id, range, name, is_group) in pending {
            let table = if is_group { &self.groups } else { &self.rules };
            match table.get(&name).copied() {
                Some(id) => self.out.references.push(Reference {
                    source_id,
                    range,
                    target: Target::Symbol(id),
                }),
                None if self.out.complete => {
                    let what = if is_group { "rule group" } else { "rule" };
                    self.report_at(
                        &source_id,
                        XsDiagnostic::new(
                            if is_group { "XS4005" } else { "XS4004" },
                            Severity::Warning,
                            format!("No {what} named '{name}' is declared in this script or its includes."),
                            range,
                        ),
                    );
                }
                None => {}
            }
        }
    }
}

enum ConstantShape<'e> {
    Literal(Ty),
    Name(String, ByteRange),
    Vector(&'e [Expr]),
    Other,
}

fn constant_shape(expr: &Expr) -> ConstantShape<'_> {
    match &expr.kind {
        ExprKind::Literal(literal) => ConstantShape::Literal(literal_type(literal)),
        ExprKind::Unary {
            op: UnaryOp::Negate | UnaryOp::Plus,
            operand,
        } => match &operand.kind {
            ExprKind::Literal(Literal::Integer(_)) => ConstantShape::Literal(Ty::Int),
            ExprKind::Literal(Literal::Float(_)) => ConstantShape::Literal(Ty::Float),
            _ => ConstantShape::Other,
        },
        ExprKind::Name(name) => ConstantShape::Name(name.text.clone(), name.range),
        ExprKind::Vector(components) => ConstantShape::Vector(components),
        _ => ConstantShape::Other,
    }
}

fn record_scope_declaration(
    declarations: &mut BTreeMap<String, Option<ByteRange>>,
    name: &xs_syntax::Name,
) {
    declarations
        .entry(name.text.clone())
        .and_modify(|range| *range = None)
        .or_insert(Some(name.range));
}

fn local_declarations(stmts: &[Stmt]) -> BTreeMap<String, Option<ByteRange>> {
    let mut declarations = BTreeMap::new();
    for stmt in stmts {
        if let StmtKind::Variable(variable) = &stmt.kind {
            record_scope_declaration(&mut declarations, &variable.name);
        }
    }
    declarations
}

pub(crate) fn argument_order_name_known(callee: &str, formal: &str) -> bool {
    !(callee == "xsDisplayInstructions" && matches!(formal, "playerColorForText" | "playSound"))
}

fn literal_type(literal: &Literal) -> Ty {
    match literal {
        Literal::Integer(_) => Ty::Int,
        Literal::Float(_) => Ty::Float,
        Literal::Bool(_) => Ty::Bool,
        Literal::String(_) => Ty::String,
    }
}

fn example_value(ty: &Ty) -> &'static str {
    match ty {
        Ty::Int => "0",
        Ty::Float => "0.0",
        Ty::Bool => "false",
        Ty::String => "\"\"",
        Ty::Vector => "vector(0, 0, 0)",
        _ => "...",
    }
}

fn empty_range() -> ByteRange {
    ByteRange {
        start: ByteOffset(0),
        end: ByteOffset(0),
    }
}

fn string_inner_range(range: ByteRange) -> ByteRange {
    if range.end.0 >= range.start.0 + 2 {
        ByteRange {
            start: ByteOffset(range.start.0 + 1),
            end: ByteOffset(range.end.0 - 1),
        }
    } else {
        range
    }
}

pub(crate) fn slice(file: &XsFile, range: ByteRange) -> String {
    let bytes = file.source.bytes();
    let start = (range.start.0 as usize).min(bytes.len());
    let end = (range.end.0 as usize).clamp(start, bytes.len());
    String::from_utf8_lossy(&bytes[start..end]).into_owned()
}

fn shorten(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > limit {
        format!("{}...", collapsed.chars().take(limit).collect::<String>())
    } else {
        collapsed
    }
}

fn modifiers_prefix(modifiers: &Modifiers) -> String {
    let mut prefix = String::new();
    for (present, word) in [
        (modifiers.mutable.is_some(), "mutable "),
        (modifiers.extern_.is_some(), "extern "),
        (modifiers.export.is_some(), "export "),
        (modifiers.static_.is_some(), "static "),
        (modifiers.const_.is_some(), "const "),
    ] {
        if present {
            prefix.push_str(word);
        }
    }
    prefix
}

fn type_text(ty: &TypeRef) -> String {
    match ty {
        TypeRef::Builtin(name, _) => name.as_str().to_owned(),
        TypeRef::Class(name) => name.text.clone(),
    }
}

pub(crate) fn variable_detail(file: &XsFile, variable: &VarDecl) -> String {
    let mut detail = format!(
        "{}{} {}",
        modifiers_prefix(&variable.modifiers),
        type_text(&variable.ty),
        variable.name.text
    );
    if let Some(init) = &variable.init {
        detail.push_str(" = ");
        detail.push_str(&shorten(&slice(file, init.range), 80));
    }
    detail
}

pub(crate) fn function_detail(file: &XsFile, function: &FunctionDecl) -> String {
    let params = function
        .params
        .iter()
        .map(|param| {
            let mut text = format!("{} {}", type_text(&param.ty), param.name.text);
            if let Some(default) = &param.default {
                text.push_str(" = ");
                text.push_str(&shorten(&slice(file, default.range), 40));
            }
            text
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{}{} {}({params})",
        modifiers_prefix(&function.modifiers),
        type_text(&function.return_type),
        function.name.text
    )
}

fn rule_detail(file: &XsFile, rule: &RuleDecl) -> String {
    let mut detail = format!("rule {}", rule.name.text);
    for modifier in &rule.modifiers {
        detail.push(' ');
        detail.push_str(&shorten(&slice(file, modifier.range), 40));
    }
    detail
}

pub(crate) fn leading_comment(file: &XsFile, start: ByteOffset) -> Option<String> {
    let tokens = &file.tree.tokens;
    let index = tokens.partition_point(|token| token.range.start < start);
    let mut cursor = index;
    let mut lines = Vec::new();
    let mut newlines = 0;
    while cursor > 0 {
        cursor -= 1;
        let token = tokens[cursor];
        match token.kind {
            TokenKind::Whitespace => {}
            TokenKind::Newline => {
                newlines += 1;
                if newlines > 1 {
                    break;
                }
            }
            TokenKind::LineComment => {
                newlines = 0;
                lines.push(
                    slice(file, token.range)
                        .trim_start_matches('/')
                        .trim()
                        .to_owned(),
                );
            }
            TokenKind::BlockComment => {
                newlines = 0;
                let text = slice(file, token.range);
                let inner = text.trim_start_matches("/*").trim_end_matches("*/");
                for line in inner.lines().rev() {
                    lines.push(line.trim().trim_start_matches('*').trim().to_owned());
                }
            }
            _ => break,
        }
        if lines.len() > 40 {
            break;
        }
    }
    lines.reverse();
    while lines.first().is_some_and(|line| {
        line.chars()
            .all(|character| matches!(character, '=' | '-' | '*' | '/' | ' '))
    }) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| {
        line.chars()
            .all(|character| matches!(character, '=' | '-' | '*' | '/' | ' '))
    }) {
        lines.pop();
    }
    let text = lines.join("\n");
    (!text.trim().is_empty()).then_some(text)
}
