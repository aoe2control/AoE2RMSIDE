use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

use rms_source::{ByteOffset, SourceId, SourceText};
use xs_analysis::{
    AnalysisOptions, IncludeResolver, Target, XsBuild, XsFile, XsRuntime, analyze_unit,
};
use xs_syntax::{
    ClassDecl, FunctionDecl, Item, PragmaKind, RuleDecl, RuleModifierKind, Severity, VarDecl,
    XsDiagnostic,
};

pub const ENGINE_CONSTANTS_ID: &str = "xs-engine:///EngineConstants.xs";

const ENGINE_CONSTANTS: &str = "const vector cInvalidVector = vector(-1.0, -1.0, -1.0);\n\
const vector cOriginVector = vector(0.0, 0.0, 0.0);\n";

pub fn engine_constants() -> Arc<XsFile> {
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

fn is_constants_file(id: &SourceId) -> bool {
    id.as_str()
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("constants.xs"))
}

#[derive(Clone, Debug, Default)]
pub struct XsFileSet {
    files: BTreeMap<String, Arc<XsFile>>,
    paths: BTreeMap<String, String>,
}

impl XsFileSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, path: &str, file: Arc<XsFile>) {
        let path = normalize_path(path);
        self.paths
            .insert(file.id().as_str().to_owned(), path.clone());
        self.files.insert(path, file);
    }

    pub fn get(&self, path: &str) -> Option<Arc<XsFile>> {
        self.files.get(&normalize_path(path)).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

impl IncludeResolver for XsFileSet {
    fn resolve(&self, from: &SourceId, path: &str) -> Option<Arc<XsFile>> {
        let wanted = normalize_path(path.trim().trim_matches('"'));
        if wanted.is_empty() {
            return None;
        }
        let from = self
            .paths
            .get(from.as_str())
            .cloned()
            .unwrap_or_else(|| normalize_path(from.as_str()));
        let folder = from.rsplit_once('/').map_or("", |(folder, _)| folder);
        let relative = normalize_path(&format!("{folder}/{wanted}"));
        if let Some(file) = self.files.get(&relative) {
            return Some(file.clone());
        }
        let suffix = format!("/{wanted}");
        self.files
            .iter()
            .find(|(candidate, _)| candidate.ends_with(&suffix) || **candidate == wanted)
            .map(|(_, file)| file.clone())
    }
}

fn normalize_path(value: &str) -> String {
    let text = value.replace('\\', "/").to_lowercase();
    let mut segments: Vec<&str> = Vec::new();
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

#[derive(Clone, Debug, PartialEq)]
pub struct CompileErrors {
    pub files: Vec<(SourceId, Vec<XsDiagnostic>)>,
}

impl CompileErrors {
    pub fn count(&self) -> usize {
        self.files.iter().map(|(_, errors)| errors.len()).sum()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PrepareError {
    CompileErrors(CompileErrors),
    Table(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ItemRef {
    pub file: usize,
    pub item: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct RuleInfo {
    pub name: String,
    pub at: ItemRef,
    pub active: bool,
}

#[derive(Debug)]
pub struct Program {
    pub(crate) files: Vec<Arc<XsFile>>,
    pub(crate) unit_start: usize,
    pub(crate) items: Vec<ItemRef>,
    pub(crate) functions: HashMap<String, ItemRef>,
    pub(crate) function_order: Vec<String>,
    pub(crate) rules: Vec<RuleInfo>,
    pub(crate) rule_index: HashMap<String, usize>,
    pub(crate) groups: BTreeMap<String, Vec<usize>>,
    pub(crate) classes: Vec<ItemRef>,
    pub(crate) class_index: HashMap<String, usize>,
    pub(crate) recursion_limit: Option<i64>,
    pub(crate) build: Option<XsBuild>,
    called_builtins: Vec<String>,
    constants_loaded: bool,
}

impl Program {
    pub(crate) fn item(&self, at: ItemRef) -> &Item {
        &self.files[at.file].tree.items[at.item]
    }

    pub(crate) fn function(&self, at: ItemRef) -> &FunctionDecl {
        match self.item(at) {
            Item::Function(function) => function,
            _ => unreachable!("function reference"),
        }
    }

    pub(crate) fn rule(&self, at: ItemRef) -> &RuleDecl {
        match self.item(at) {
            Item::Rule(rule) => rule,
            _ => unreachable!("rule reference"),
        }
    }

    pub(crate) fn class(&self, index: usize) -> &ClassDecl {
        match self.item(self.classes[index]) {
            Item::Class(class) => class,
            _ => unreachable!("class reference"),
        }
    }

    pub(crate) fn global_variables(&self) -> impl Iterator<Item = (usize, &VarDecl)> {
        self.items.iter().filter_map(|at| match self.item(*at) {
            Item::Variable(variable) => Some((at.file, variable)),
            _ => None,
        })
    }

    pub fn function_names(&self) -> Vec<String> {
        self.function_order
            .iter()
            .filter(|name| self.functions.contains_key(*name))
            .cloned()
            .collect()
    }

    pub fn has_function(&self, name: &str) -> bool {
        self.functions.contains_key(name)
    }

    pub fn unit_files(&self) -> Vec<SourceId> {
        self.files[self.unit_start..]
            .iter()
            .map(|file| file.id().clone())
            .collect()
    }

    pub fn called_builtins(&self) -> &[String] {
        &self.called_builtins
    }

    pub fn line_of(&self, source_id: &SourceId, offset: ByteOffset) -> Option<u32> {
        self.report_position(source_id, offset)
            .map(|(line, _)| line)
    }

    pub fn report_position(&self, source_id: &SourceId, offset: ByteOffset) -> Option<(u32, u32)> {
        let file = self.files.iter().find(|file| file.id() == source_id)?;
        let position = file.source.byte_to_utf16(offset).ok()?;
        Some((position.line + 1, position.character + 1))
    }

    pub fn environment_int_constants(&self, prefix: &str) -> BTreeMap<i32, Vec<String>> {
        let mut found: BTreeMap<i32, Vec<String>> = BTreeMap::new();
        for file in &self.files[..self.unit_start] {
            for item in &file.tree.items {
                let Item::Variable(variable) = item else {
                    continue;
                };
                if variable.modifiers.const_.is_none() || !variable.name.text.starts_with(prefix) {
                    continue;
                }
                if let Some(value) = variable.init.as_ref().and_then(literal_int) {
                    found
                        .entry(value)
                        .or_default()
                        .push(variable.name.text.clone());
                }
            }
        }
        found
    }

    pub fn constants_loaded(&self) -> bool {
        self.constants_loaded
    }
}

pub fn prepare(
    roots: &[Arc<XsFile>],
    resolver: &dyn IncludeResolver,
    constants: Option<Arc<XsFile>>,
    build: Option<XsBuild>,
) -> Result<Program, PrepareError> {
    crate::table::call_table().map_err(PrepareError::Table)?;
    let options = AnalysisOptions {
        build,
        runtime: Some(XsRuntime::Rms),
        environment: constants.clone(),
    };
    let analysis = analyze_unit(roots, resolver, &options);
    let mut errors = Vec::new();
    for id in &analysis.files {
        let found = analysis
            .diagnostics_for(id)
            .iter()
            .filter(|diagnostic| {
                diagnostic.severity == Severity::Error
                    || (!analysis.complete && matches!(diagnostic.code, "XS4009" | "XS9001"))
            })
            .cloned()
            .collect::<Vec<_>>();
        if !found.is_empty() {
            errors.push((id.clone(), found));
        }
    }
    if !errors.is_empty() || !analysis.complete {
        return Err(PrepareError::CompileErrors(CompileErrors { files: errors }));
    }

    let mut files = vec![engine_constants()];
    let mut constants_loaded = false;
    if let Some(constants) = constants
        && !roots
            .iter()
            .any(|root| root.id() == constants.id() || is_constants_file(root.id()))
    {
        files.push(constants);
        constants_loaded = true;
    }
    if roots.iter().any(|root| is_constants_file(root.id())) {
        constants_loaded = true;
    }
    let unit_start = files.len();
    let mut items = Vec::new();
    for (index, file) in files.iter().enumerate() {
        for item in 0..file.tree.items.len() {
            items.push(ItemRef { file: index, item });
        }
    }
    for root in roots {
        if files.iter().any(|file| file.id() == root.id()) {
            continue;
        }
        let index = files.len();
        files.push(root.clone());
        let mut stack = vec![root.id().clone()];
        plan(&mut files, &mut items, resolver, index, &mut stack);
    }

    let unit_ids = files[unit_start..]
        .iter()
        .map(|file| file.id().clone())
        .collect::<BTreeSet<_>>();
    let called_builtins = analysis
        .references
        .iter()
        .filter(|reference| unit_ids.contains(&reference.source_id))
        .filter_map(|reference| match &reference.target {
            Target::Builtin(name) => Some(name.clone()),
            Target::Symbol(_) => None,
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let mut program = Program {
        files,
        unit_start,
        items,
        functions: HashMap::new(),
        function_order: Vec::new(),
        rules: Vec::new(),
        rule_index: HashMap::new(),
        groups: BTreeMap::new(),
        classes: Vec::new(),
        class_index: HashMap::new(),
        recursion_limit: None,
        build,
        called_builtins,
        constants_loaded,
    };
    index_items(&mut program);
    Ok(program)
}

fn literal_int(expr: &xs_syntax::Expr) -> Option<i32> {
    match &expr.kind {
        xs_syntax::ExprKind::Literal(xs_syntax::Literal::Integer(value)) => {
            i32::try_from(*value).ok()
        }
        xs_syntax::ExprKind::Unary {
            op: xs_syntax::UnaryOp::Negate,
            operand,
        } => literal_int(operand).and_then(i32::checked_neg),
        _ => None,
    }
}

fn plan(
    files: &mut Vec<Arc<XsFile>>,
    items: &mut Vec<ItemRef>,
    resolver: &dyn IncludeResolver,
    file_index: usize,
    stack: &mut Vec<SourceId>,
) {
    let file = files[file_index].clone();
    for (item_index, item) in file.tree.items.iter().enumerate() {
        if let Item::Include(include) = item
            && let Some(path) = &include.path
            && let Some(target) = resolver.resolve(file.id(), path)
            && !stack.contains(target.id())
            && !files.iter().any(|known| known.id() == target.id())
        {
            let index = files.len();
            files.push(target.clone());
            stack.push(target.id().clone());
            plan(files, items, resolver, index, stack);
            stack.pop();
        }
        items.push(ItemRef {
            file: file_index,
            item: item_index,
        });
    }
}

fn index_items(program: &mut Program) {
    let mut functions = HashMap::new();
    let mut function_order = Vec::new();
    let mut rules: Vec<RuleInfo> = Vec::new();
    let mut rule_index = HashMap::new();
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut classes = Vec::new();
    let mut class_index = HashMap::new();
    let mut recursion_limit = None;
    for at in program.items.clone() {
        match program.item(at) {
            Item::Function(function) => {
                if !function_order.contains(&function.name.text) {
                    function_order.push(function.name.text.clone());
                }
                if function.body.is_some() {
                    functions.insert(function.name.text.clone(), at);
                }
            }
            Item::Rule(rule) => {
                if rule.name.text.is_empty() || rule_index.contains_key(&rule.name.text) {
                    continue;
                }
                let mut active = false;
                let mut group = None;
                for modifier in &rule.modifiers {
                    match modifier.kind {
                        RuleModifierKind::Active => active = true,
                        RuleModifierKind::Inactive => active = false,
                        RuleModifierKind::Group => {
                            group = modifier.name.as_ref().map(|name| name.text.clone());
                        }
                        _ => {}
                    }
                }
                let index = rules.len();
                rule_index.insert(rule.name.text.clone(), index);
                if let Some(group) = &group {
                    groups.entry(group.clone()).or_default().push(index);
                }
                rules.push(RuleInfo {
                    name: rule.name.text.clone(),
                    at,
                    active,
                });
            }
            Item::Class(class) => {
                if !class.name.text.is_empty() && !class_index.contains_key(&class.name.text) {
                    class_index.insert(class.name.text.clone(), classes.len());
                    classes.push(at);
                }
            }
            Item::Pragma {
                kind: PragmaKind::InfiniteRecursionLimit,
                value: Some(value),
                ..
            } => {
                if let xs_syntax::ExprKind::Literal(xs_syntax::Literal::Integer(limit)) =
                    &value.kind
                {
                    recursion_limit = Some(*limit);
                }
            }
            _ => {}
        }
    }
    program.functions = functions;
    program.function_order = function_order;
    program.rules = rules;
    program.rule_index = rule_index;
    program.groups = groups;
    program.classes = classes;
    program.class_index = class_index;
    program.recursion_limit = recursion_limit;
}
