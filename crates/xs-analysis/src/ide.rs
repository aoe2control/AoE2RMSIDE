use rms_source::{ByteOffset, ByteRange, SourceId};
use xs_syntax::{Item, Keyword, TokenKind};

use crate::analyzer::{function_detail, slice, variable_detail};
use crate::catalog::{XsBuild, XsRuntime, catalog};
use crate::documentation::{builtin_documentation, builtin_documentation_view};
use crate::model::{SymbolId, SymbolKind, Target, UnitAnalysis, XsFile};
use crate::types::Ty;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutlineKind {
    Include,
    Function,
    Rule,
    Variable,
    Constant,
    Class,
    Member,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutlineSymbol {
    pub name: String,
    pub kind: OutlineKind,
    pub detail: String,
    pub range: ByteRange,
    pub selection_range: ByteRange,
    pub children: Vec<OutlineSymbol>,
}

pub fn outline(file: &XsFile) -> Vec<OutlineSymbol> {
    let mut symbols = Vec::new();
    for item in &file.tree.items {
        match item {
            Item::Include(include) => {
                if let (Some(path), Some(range)) = (&include.path, include.path_range) {
                    symbols.push(OutlineSymbol {
                        name: path.clone(),
                        kind: OutlineKind::Include,
                        detail: "include".to_owned(),
                        range: include.range,
                        selection_range: range,
                        children: Vec::new(),
                    });
                }
            }
            Item::Variable(variable) if !variable.name.text.is_empty() => {
                symbols.push(OutlineSymbol {
                    name: variable.name.text.clone(),
                    kind: if variable.modifiers.const_.is_some() {
                        OutlineKind::Constant
                    } else {
                        OutlineKind::Variable
                    },
                    detail: variable_detail(file, variable),
                    range: variable.range,
                    selection_range: variable.name.range,
                    children: Vec::new(),
                });
            }
            Item::Function(function) if !function.name.text.is_empty() => {
                symbols.push(OutlineSymbol {
                    name: function.name.text.clone(),
                    kind: OutlineKind::Function,
                    detail: function_detail(file, function),
                    range: function.range,
                    selection_range: function.name.range,
                    children: Vec::new(),
                });
            }
            Item::Rule(rule) if !rule.name.text.is_empty() => {
                symbols.push(OutlineSymbol {
                    name: rule.name.text.clone(),
                    kind: OutlineKind::Rule,
                    detail: "rule".to_owned(),
                    range: rule.range,
                    selection_range: rule.name.range,
                    children: Vec::new(),
                });
            }
            Item::Class(class) if !class.name.text.is_empty() => {
                symbols.push(OutlineSymbol {
                    name: class.name.text.clone(),
                    kind: OutlineKind::Class,
                    detail: "class".to_owned(),
                    range: class.range,
                    selection_range: class.name.range,
                    children: class
                        .members
                        .iter()
                        .map(|member| OutlineSymbol {
                            name: member.name.text.clone(),
                            kind: OutlineKind::Member,
                            detail: variable_detail(file, member),
                            range: member.range,
                            selection_range: member.name.range,
                            children: Vec::new(),
                        })
                        .collect(),
                });
            }
            _ => {}
        }
    }
    symbols
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FoldKind {
    Region,
    Comment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fold {
    pub range: ByteRange,
    pub kind: FoldKind,
}

pub fn folds(file: &XsFile) -> Vec<Fold> {
    let mut folds = file
        .tree
        .brace_pairs
        .iter()
        .map(|range| Fold {
            range: *range,
            kind: FoldKind::Region,
        })
        .collect::<Vec<_>>();
    let tokens = &file.tree.tokens;
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        if token.kind == TokenKind::BlockComment {
            folds.push(Fold {
                range: token.range,
                kind: FoldKind::Comment,
            });
        } else if token.kind == TokenKind::LineComment {
            let mut end = token.range.end;
            let mut count = 1;
            let mut newlines = 0;
            let mut cursor = index + 1;
            let mut resume = index + 1;
            while cursor < tokens.len() {
                match tokens[cursor].kind {
                    TokenKind::Whitespace => {}
                    TokenKind::Newline => {
                        newlines += 1;
                        if newlines > 1 {
                            break;
                        }
                    }
                    TokenKind::LineComment => {
                        end = tokens[cursor].range.end;
                        count += 1;
                        newlines = 0;
                        resume = cursor + 1;
                    }
                    _ => break,
                }
                cursor += 1;
            }
            if count >= 2 {
                folds.push(Fold {
                    range: ByteRange {
                        start: token.range.start,
                        end,
                    },
                    kind: FoldKind::Comment,
                });
                index = resume;
                continue;
            }
        }
        index += 1;
    }
    folds.sort_by_key(|fold| (fold.range.start, fold.range.end));
    folds
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticClass {
    Comment,
    Keyword,
    Namespace,
    Function,
    Property,
    Number,
    String,
    Variable,
    Operator,
    Control,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SemanticToken {
    pub range: ByteRange,
    pub class: SemanticClass,
}

pub fn semantic_tokens(file: &XsFile, analysis: Option<&UnitAnalysis>) -> Vec<SemanticToken> {
    let id = file.id();
    let mut resolved = std::collections::BTreeMap::new();
    if let Some(analysis) = analysis {
        for reference in analysis
            .references
            .iter()
            .filter(|reference| reference.source_id == *id)
        {
            resolved.insert(
                reference.range.start,
                class_of_target(analysis, &reference.target),
            );
        }
        for symbol in analysis
            .symbols
            .iter()
            .filter(|symbol| symbol.source_id == *id && !symbol.from_environment)
        {
            resolved.insert(symbol.selection_range.start, class_of_kind(symbol.kind));
        }
    }
    let mut tokens = Vec::new();
    for token in &file.tree.tokens {
        let class = match token.kind {
            TokenKind::LineComment | TokenKind::BlockComment => SemanticClass::Comment,
            TokenKind::Keyword(keyword) if keyword.is_control() => SemanticClass::Control,
            TokenKind::Keyword(_) | TokenKind::BoolLiteral => SemanticClass::Keyword,
            TokenKind::Integer | TokenKind::Float => SemanticClass::Number,
            TokenKind::String => SemanticClass::String,
            TokenKind::Identifier => match resolved.get(&token.range.start) {
                Some(class) => *class,
                None => {
                    let text = slice(file, token.range);
                    if catalog()
                        .ok()
                        .and_then(|catalog| catalog.get(&text))
                        .is_some()
                    {
                        SemanticClass::Function
                    } else {
                        SemanticClass::Variable
                    }
                }
            },
            kind if kind.is_operator() => SemanticClass::Operator,
            _ => continue,
        };
        tokens.push(SemanticToken {
            range: token.range,
            class,
        });
    }
    tokens
}

fn class_of_kind(kind: SymbolKind) -> SemanticClass {
    match kind {
        SymbolKind::Function => SemanticClass::Function,
        SymbolKind::Rule | SymbolKind::RuleGroup | SymbolKind::Class | SymbolKind::Label => {
            SemanticClass::Namespace
        }
        SymbolKind::Member => SemanticClass::Property,
        _ => SemanticClass::Variable,
    }
}

fn class_of_target(analysis: &UnitAnalysis, target: &Target) -> SemanticClass {
    match target {
        Target::Builtin(_) => SemanticClass::Function,
        Target::Symbol(id) => {
            let symbol = analysis.symbol(*id);
            if symbol.kind == SymbolKind::Rule || symbol.kind == SymbolKind::RuleGroup {
                SemanticClass::Namespace
            } else {
                class_of_kind(symbol.kind)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionKind {
    Function,
    Variable,
    Constant,
    Keyword,
    Class,
    Field,
    Event,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompletionEntry {
    pub label: String,
    pub kind: CompletionKind,
    pub detail: String,
    pub documentation: Option<String>,
    pub deprecated: bool,
    pub builtin: bool,
}

const COMPLETION_KEYWORDS: [Keyword; 30] = [
    Keyword::Int,
    Keyword::Float,
    Keyword::Bool,
    Keyword::String,
    Keyword::Vector,
    Keyword::Void,
    Keyword::Const,
    Keyword::Static,
    Keyword::Extern,
    Keyword::Export,
    Keyword::Mutable,
    Keyword::Class,
    Keyword::Rule,
    Keyword::Include,
    Keyword::If,
    Keyword::Else,
    Keyword::For,
    Keyword::While,
    Keyword::Switch,
    Keyword::Case,
    Keyword::Default,
    Keyword::Break,
    Keyword::Continue,
    Keyword::Return,
    Keyword::Active,
    Keyword::Inactive,
    Keyword::MinInterval,
    Keyword::MaxInterval,
    Keyword::HighFrequency,
    Keyword::RunImmediately,
];

pub fn completions(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
    build: Option<XsBuild>,
    runtime: Option<XsRuntime>,
) -> Vec<CompletionEntry> {
    collect_completions(file, analysis, offset, build, runtime, &|_| true, true)
}

pub fn completions_matching(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
    build: Option<XsBuild>,
    runtime: Option<XsRuntime>,
    wanted: &dyn Fn(&str) -> bool,
) -> Vec<CompletionEntry> {
    collect_completions(file, analysis, offset, build, runtime, wanted, false)
}

fn collect_completions(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
    build: Option<XsBuild>,
    runtime: Option<XsRuntime>,
    wanted: &dyn Fn(&str) -> bool,
    builtin_documentation_inline: bool,
) -> Vec<CompletionEntry> {
    if let Some(mut members) = member_completions(file, analysis, offset) {
        members.retain(|entry| wanted(&entry.label));
        return members;
    }
    if let Some(mut labels) = label_completions(file, analysis, offset) {
        labels.retain(|entry| wanted(&entry.label));
        return labels;
    }
    let mut entries = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let id = file.id();
    let body = crate::rename::enclosing_body(
        file,
        ByteRange {
            start: offset,
            end: offset,
        },
    );
    for symbol in &analysis.symbols {
        let visible = match symbol.kind {
            SymbolKind::LocalVariable | SymbolKind::Parameter | SymbolKind::LoopVariable => {
                symbol.source_id == *id
                    && (symbol
                        .scope
                        .is_some_and(|scope| scope.start <= offset && offset <= scope.end)
                        || body.is_some_and(|body| {
                            body.start <= symbol.selection_range.start
                                && symbol.selection_range.end <= offset
                        }))
            }
            SymbolKind::Member | SymbolKind::Label => false,
            _ => true,
        };
        if !visible
            || symbol.name.is_empty()
            || !seen.insert(symbol.name.clone())
            || !wanted(&symbol.name)
        {
            continue;
        }
        entries.push(CompletionEntry {
            label: symbol.name.clone(),
            kind: match symbol.kind {
                SymbolKind::Function => CompletionKind::Function,
                SymbolKind::Constant => CompletionKind::Constant,
                SymbolKind::Class => CompletionKind::Class,
                SymbolKind::Rule | SymbolKind::RuleGroup => CompletionKind::Event,
                _ => CompletionKind::Variable,
            },
            detail: symbol.detail.clone(),
            documentation: symbol.documentation.clone(),
            deprecated: false,
            builtin: false,
        });
    }
    if let Ok(catalog) = catalog() {
        for builtin in catalog.builtins() {
            let in_build = build.is_none_or(|build| builtin.available_in(build));
            let in_runtime = runtime.is_none_or(|runtime| builtin.available_in_runtime(runtime));
            if !in_build
                || !in_runtime
                || !seen.insert(builtin.name.clone())
                || !wanted(&builtin.name)
            {
                continue;
            }
            entries.push(CompletionEntry {
                label: builtin.name.clone(),
                kind: CompletionKind::Function,
                detail: builtin.signature(build),
                documentation: builtin_documentation_inline
                    .then(|| builtin_documentation(builtin, build)),
                deprecated: builtin.successor.is_some(),
                builtin: true,
            });
        }
    }
    for keyword in COMPLETION_KEYWORDS {
        if !wanted(keyword.as_str()) {
            continue;
        }
        entries.push(CompletionEntry {
            label: keyword.as_str().to_owned(),
            kind: CompletionKind::Keyword,
            detail: "keyword".to_owned(),
            documentation: None,
            deprecated: false,
            builtin: false,
        });
    }
    for word in ["true", "false"] {
        if !wanted(word) {
            continue;
        }
        entries.push(CompletionEntry {
            label: word.to_owned(),
            kind: CompletionKind::Keyword,
            detail: "bool".to_owned(),
            documentation: None,
            deprecated: false,
            builtin: false,
        });
    }
    entries
}

fn label_completions(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
) -> Option<Vec<CompletionEntry>> {
    let end = file
        .tree
        .tokens
        .partition_point(|token| token.range.start < offset);
    let mut previous = file.tree.tokens[..end]
        .iter()
        .rev()
        .filter(|token| !token.kind.is_trivia());
    let mut last = previous.next()?;
    if last.kind == TokenKind::Identifier && last.range.end >= offset {
        last = previous.next()?;
    }
    if last.kind != TokenKind::Keyword(Keyword::Goto) {
        return None;
    }
    let body = file.tree.items.iter().find_map(|item| match item {
        Item::Function(function)
            if function.range.start <= offset && offset <= function.range.end =>
        {
            Some(function.range)
        }
        Item::Rule(rule) if rule.range.start <= offset && offset <= rule.range.end => {
            Some(rule.range)
        }
        _ => None,
    })?;
    Some(
        analysis
            .symbols
            .iter()
            .filter(|symbol| {
                symbol.kind == SymbolKind::Label
                    && symbol.source_id == *file.id()
                    && body.start <= symbol.selection_range.start
                    && symbol.selection_range.end <= body.end
            })
            .map(|symbol| CompletionEntry {
                label: symbol.name.clone(),
                kind: CompletionKind::Event,
                detail: symbol.detail.clone(),
                documentation: None,
                deprecated: false,
                builtin: false,
            })
            .collect(),
    )
}

fn member_completions(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
) -> Option<Vec<CompletionEntry>> {
    let tokens = &file.tree.tokens;
    let mut index = tokens.partition_point(|token| token.range.end <= offset);
    if index < tokens.len()
        && tokens[index].range.start < offset
        && tokens[index].kind == TokenKind::Identifier
    {
    } else if index > 0
        && tokens[index - 1].kind == TokenKind::Identifier
        && tokens[index - 1].range.end == offset
    {
        index -= 1;
    }
    let mut cursor = index.checked_sub(1)?;
    while tokens[cursor].kind.is_trivia() {
        cursor = cursor.checked_sub(1)?;
    }
    if tokens[cursor].kind != TokenKind::Period {
        return None;
    }
    let mut object = cursor.checked_sub(1)?;
    while tokens[object].kind.is_trivia() {
        object = object.checked_sub(1)?;
    }
    let (target, _) = analysis.target_at(file.id(), tokens[object].range.start.0)?;
    let Target::Symbol(id) = target else {
        return Some(Vec::new());
    };
    let Ty::Class(class) = analysis.symbol(id).ty.clone() else {
        return Some(Vec::new());
    };
    let class_id = analysis
        .symbols
        .iter()
        .position(|symbol| symbol.kind == SymbolKind::Class && symbol.name == class)
        .map(|index| SymbolId(index as u32))?;
    Some(
        analysis
            .symbols
            .iter()
            .filter(|symbol| {
                symbol.kind == SymbolKind::Member && symbol.container == Some(class_id)
            })
            .map(|symbol| CompletionEntry {
                label: symbol.name.clone(),
                kind: CompletionKind::Field,
                detail: symbol.detail.clone(),
                documentation: symbol.documentation.clone(),
                deprecated: false,
                builtin: false,
            })
            .collect(),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HoverInfo {
    pub markdown: String,
    pub range: ByteRange,
}

pub fn hover(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
    build: Option<XsBuild>,
) -> Option<HoverInfo> {
    let (target, range) = analysis.target_at(file.id(), offset.0)?;
    let markdown = match target {
        Target::Builtin(name) => {
            let builtin = catalog().ok()?.get(&name)?;
            {
                let view = builtin_documentation_view(builtin, build);
                format!("{}\n\n{}", view.hover_signature, view.body)
            }
        }
        Target::Symbol(id) => {
            let symbol = analysis.symbol(id);
            let mut text = format!("```xs\n{}\n```", symbol.detail);
            if let Some(documentation) = &symbol.documentation {
                text.push_str("\n\n");
                text.push_str(documentation);
            }
            let origin = if symbol.from_environment {
                "game constant".to_owned()
            } else {
                symbol.kind.label().to_owned()
            };
            text.push_str(&format!("\n\n_{origin}_"));
            text
        }
    };
    Some(HoverInfo { markdown, range })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureInfo {
    pub label: String,
    pub parameters: Vec<SignatureParameter>,
    pub active_parameter: u32,
    pub documentation: Option<String>,
}

pub fn signature_help(
    file: &XsFile,
    analysis: &UnitAnalysis,
    offset: ByteOffset,
    build: Option<XsBuild>,
) -> Option<SignatureInfo> {
    let tokens = &file.tree.tokens;
    let end = tokens.partition_point(|token| token.range.end <= offset);
    let mut depth = 0_u32;
    let mut commas = 0_u32;
    let mut cursor = end;
    let mut steps = 0;
    while cursor > 0 && steps < 4_096 {
        cursor -= 1;
        steps += 1;
        match tokens[cursor].kind {
            TokenKind::RParen => depth += 1,
            TokenKind::LParen if depth > 0 => depth -= 1,
            TokenKind::LParen => {
                let mut name = cursor.checked_sub(1)?;
                while tokens[name].kind.is_trivia() {
                    name = name.checked_sub(1)?;
                }
                if tokens[name].kind != TokenKind::Identifier {
                    return None;
                }
                let callee = slice(file, tokens[name].range);
                return call_signature(analysis, &callee, commas, build);
            }
            TokenKind::Comma if depth == 0 => commas += 1,
            TokenKind::Semicolon | TokenKind::LBrace | TokenKind::RBrace => return None,
            _ => {}
        }
    }
    None
}

fn call_signature(
    analysis: &UnitAnalysis,
    callee: &str,
    active: u32,
    build: Option<XsBuild>,
) -> Option<SignatureInfo> {
    if let Some(symbol) = analysis
        .symbols
        .iter()
        .rev()
        .find(|symbol| symbol.kind == SymbolKind::Function && symbol.name == callee)
    {
        let signature = symbol.signature.as_ref()?;
        return Some(SignatureInfo {
            label: symbol.detail.clone(),
            parameters: signature
                .params
                .iter()
                .map(|(name, ty)| SignatureParameter {
                    label: format!("{} {name}", ty.label()),
                    documentation: None,
                })
                .collect(),
            active_parameter: active,
            documentation: symbol.documentation.clone(),
        });
    }
    let builtin = catalog().ok()?.get(callee)?;
    let view = builtin_documentation_view(builtin, build);
    Some(SignatureInfo {
        label: builtin.signature(build),
        parameters: builtin
            .params_for(build)
            .iter()
            .zip(view.parameters)
            .map(|(param, documentation)| SignatureParameter {
                label: param.label(),
                documentation,
            })
            .collect(),
        active_parameter: active,
        documentation: Some(view.signature_body),
    })
}

pub fn definition(
    analysis: &UnitAnalysis,
    source_id: &SourceId,
    offset: ByteOffset,
) -> Option<(SourceId, ByteRange)> {
    if let Some(link) = analysis.includes.iter().find(|link| {
        link.source_id == *source_id && link.range.start <= offset && offset <= link.range.end
    }) {
        return link.target.clone().map(|target| {
            (
                target,
                ByteRange {
                    start: ByteOffset(0),
                    end: ByteOffset(0),
                },
            )
        });
    }
    let (target, _) = analysis.target_at(source_id, offset.0)?;
    match target {
        Target::Symbol(id) => {
            let symbol = analysis.symbol(id);
            Some((symbol.source_id.clone(), symbol.selection_range))
        }
        Target::Builtin(_) => None,
    }
}

pub fn declares_main(file: &XsFile) -> bool {
    file.tree
        .items
        .iter()
        .any(|item| matches!(item, Item::Function(function) if function.name.text == "main"))
}
