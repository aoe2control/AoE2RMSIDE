use std::collections::BTreeSet;
use std::sync::Arc;

use rms_source::{ByteOffset, ByteRange, SourceId};
use xs_syntax::{Block, Expr, ExprKind, Item, Keyword, Literal, Name, Stmt, StmtKind};

use crate::catalog::catalog;
use crate::model::{SymbolId, SymbolKind, Target, UnitAnalysis, XsFile};

const RULE_NAME_CALLS: [&str; 9] = [
    "xsEnableRule",
    "xsDisableRule",
    "xsIsRuleEnabled",
    "xsSetRulePriority",
    "xsSetRuleMinInterval",
    "xsSetRuleMaxInterval",
    "xsEnableRuleGroup",
    "xsDisableRuleGroup",
    "xsIsRuleGroupEnabled",
];

const FUNCTION_NAME_CALLS: [(&str, usize); 2] = [("xsGetFunctionID", 0), ("xsAddRuntimeEvent", 1)];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenameTarget {
    pub name: String,
    pub kind: SymbolKind,
    pub source_id: SourceId,
    pub selection_range: ByteRange,
    pub cursor_range: ByteRange,
}

fn is_local(kind: SymbolKind) -> bool {
    matches!(
        kind,
        SymbolKind::LocalVariable
            | SymbolKind::Parameter
            | SymbolKind::LoopVariable
            | SymbolKind::Label
    )
}

pub fn rename_target(
    analysis: &UnitAnalysis,
    source_id: &SourceId,
    offset: ByteOffset,
) -> Result<RenameTarget, String> {
    let Some((target, cursor_range)) = analysis.target_at(source_id, offset.0) else {
        return Err(if analysis.complete {
            "Place the cursor on a name declared in an XS script to rename it.".to_owned()
        } else {
            "No declaration is known for this name: an include of this script cannot be found."
                .to_owned()
        });
    };
    let id = match target {
        Target::Builtin(name) => {
            return Err(format!(
                "'{name}' is a built-in XS function; built-ins cannot be renamed."
            ));
        }
        Target::Symbol(id) => id,
    };
    let symbol = analysis.symbol(id);
    if symbol.from_environment {
        return Err(format!(
            "'{}' is a game constant (Constants.xs or built into the game); it cannot be renamed.",
            symbol.name
        ));
    }
    match symbol.kind {
        SymbolKind::Class | SymbolKind::Member => {
            return Err("Classes and class members cannot be renamed yet.".to_owned());
        }
        SymbolKind::Function if symbol.is_mutable => {
            return Err(format!(
                "'{}' is mutable, so a later definition can replace it; rename every definition by hand.",
                symbol.name
            ));
        }
        _ => {}
    }
    if catalog().is_ok_and(|catalog| catalog.get(&symbol.name).is_some()) {
        return Err(format!(
            "'{}' is also the name of a built-in XS function, so a use may mean either; rename it by hand.",
            symbol.name
        ));
    }
    Ok(RenameTarget {
        name: symbol.name.clone(),
        kind: symbol.kind,
        source_id: symbol.source_id.clone(),
        selection_range: symbol.selection_range,
        cursor_range,
    })
}

pub fn valid_new_name(name: &str) -> Result<(), String> {
    let mut characters = name.chars();
    let valid = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
        && name.len() <= 255;
    if !valid {
        return Err(format!(
            "'{name}' is not a valid XS name: use letters, digits, and '_', starting with a letter or '_'."
        ));
    }
    if Keyword::from_bytes(name.as_bytes()).is_some()
        || name.eq_ignore_ascii_case("true")
        || name.eq_ignore_ascii_case("false")
    {
        return Err(format!("'{name}' is an XS keyword."));
    }
    if catalog().is_ok_and(|catalog| catalog.get(name).is_some()) {
        return Err(format!("'{name}' is the name of a built-in XS function."));
    }
    Ok(())
}

pub(crate) fn enclosing_body(file: &XsFile, range: ByteRange) -> Option<ByteRange> {
    file.tree.items.iter().find_map(|item| match item {
        Item::Function(function)
            if function.range.start <= range.start && range.end <= function.range.end =>
        {
            Some(function.range)
        }
        Item::Rule(rule) if rule.range.start <= range.start && range.end <= rule.range.end => {
            Some(rule.range)
        }
        _ => None,
    })
}

fn visit_calls(file: &XsFile, visit: &mut dyn FnMut(&Name, &[Expr])) {
    visit_calls_within(file, None, visit);
}

pub(crate) fn visit_calls_within(
    file: &XsFile,
    within: Option<ByteRange>,
    visit: &mut dyn FnMut(&Name, &[Expr]),
) {
    fn expr(value: &Expr, visit: &mut dyn FnMut(&Name, &[Expr])) {
        match &value.kind {
            ExprKind::Call { callee, args, .. } => {
                visit(callee, args);
                for arg in args {
                    expr(arg, visit);
                }
            }
            ExprKind::Unary { operand, .. } => expr(operand, visit),
            ExprKind::Binary { left, right, .. } => {
                expr(left, visit);
                expr(right, visit);
            }
            ExprKind::Cast { operand, .. } | ExprKind::ParenthesizedType { operand, .. } => {
                if let Some(operand) = operand {
                    expr(operand, visit);
                }
            }
            ExprKind::Vector(parts) => {
                for part in parts {
                    expr(part, visit);
                }
            }
            ExprKind::Member { object, .. } => expr(object, visit),
            ExprKind::Paren(inner) => expr(inner, visit),
            ExprKind::Literal(_) | ExprKind::Name(_) | ExprKind::Error => {}
        }
    }
    fn stmt(value: &Stmt, visit: &mut dyn FnMut(&Name, &[Expr])) {
        match &value.kind {
            StmtKind::Block(inner) => block(inner, visit),
            StmtKind::Variable(declaration) => {
                if let Some(init) = &declaration.init {
                    expr(init, visit);
                }
            }
            StmtKind::Assign { target, value, .. } => {
                expr(target, visit);
                if let Some(value) = value {
                    expr(value, visit);
                }
            }
            StmtKind::Expr(value) => expr(value, visit),
            StmtKind::If {
                condition,
                then_branch,
                else_branch,
            } => {
                if let Some(condition) = condition {
                    expr(condition, visit);
                }
                for branch in [then_branch, else_branch].into_iter().flatten() {
                    stmt(branch, visit);
                }
            }
            StmtKind::While { condition, body } => {
                if let Some(condition) = condition {
                    expr(condition, visit);
                }
                if let Some(body) = body {
                    stmt(body, visit);
                }
            }
            StmtKind::For {
                start, limit, body, ..
            } => {
                for part in [start, limit].into_iter().flatten() {
                    expr(part, visit);
                }
                if let Some(body) = body {
                    stmt(body, visit);
                }
            }
            StmtKind::Switch { scrutinee, cases } => {
                if let Some(scrutinee) = scrutinee {
                    expr(scrutinee, visit);
                }
                for case in cases {
                    for inner in &case.body {
                        stmt(inner, visit);
                    }
                }
            }
            StmtKind::Return(Some(value)) => expr(value, visit),
            _ => {}
        }
    }
    fn block(value: &Block, visit: &mut dyn FnMut(&Name, &[Expr])) {
        for inner in &value.stmts {
            stmt(inner, visit);
        }
    }
    let overlaps = |range: ByteRange| {
        within.is_none_or(|within| range.start <= within.end && within.start <= range.end)
    };
    for item in &file.tree.items {
        match item {
            Item::Variable(declaration) if overlaps(declaration.range) => {
                if let Some(init) = &declaration.init {
                    expr(init, visit);
                }
            }
            Item::Function(function) if overlaps(function.range) => {
                if let Some(body) = &function.body {
                    block(body, visit);
                }
            }
            Item::Rule(rule) if overlaps(rule.range) => {
                if let Some(body) = &rule.body {
                    block(body, visit);
                }
            }
            _ => {}
        }
    }
}

fn string_inner(range: ByteRange) -> ByteRange {
    ByteRange {
        start: ByteOffset(range.start.0 + 1),
        end: ByteOffset(range.end.0.saturating_sub(1).max(range.start.0 + 1)),
    }
}

pub fn rename_locations(
    target: &RenameTarget,
    units: &[(&UnitAnalysis, Vec<Arc<XsFile>>)],
    new_name: Option<&str>,
) -> Result<Vec<(SourceId, ByteRange)>, String> {
    if let Some(new_name) = new_name {
        valid_new_name(new_name)?;
    }
    let mut locations = BTreeSet::new();
    let mut found = false;
    for (unit, files) in units {
        let Some(index) = unit.symbols.iter().position(|symbol| {
            symbol.source_id == target.source_id && symbol.selection_range == target.selection_range
        }) else {
            continue;
        };
        found = true;
        let id = SymbolId(index as u32);
        if !unit.complete {
            return Err(
                "An include of this script cannot be found, so not every use of the name is known."
                    .to_owned(),
            );
        }
        if !is_local(target.kind)
            && let Some(other) = unit.symbols.iter().enumerate().find_map(|(other, symbol)| {
                (other != index && !is_local(symbol.kind) && symbol.name == target.name)
                    .then_some(symbol)
            })
        {
            return Err(
                if target.kind == SymbolKind::Function && other.kind == SymbolKind::Function {
                    format!(
                        "'{}' is defined more than once (an override); rename every definition by hand.",
                        target.name
                    )
                } else {
                    format!(
                        "'{}' is defined more than once; remove the duplicate definition before renaming.",
                        target.name
                    )
                },
            );
        }
        for (source_id, range) in unit.locations_of(&Target::Symbol(id), true) {
            locations.insert((source_id.as_str().to_owned(), range.start.0, range.end.0));
        }
        let mut refusal = None;
        for file in files {
            visit_calls(file, &mut |callee, args| {
                if refusal.is_some() {
                    return;
                }
                let callee = callee.text.as_str();
                let index = match target.kind {
                    SymbolKind::Rule | SymbolKind::RuleGroup
                        if RULE_NAME_CALLS.contains(&callee) =>
                    {
                        0
                    }
                    SymbolKind::Function => {
                        match FUNCTION_NAME_CALLS.iter().find(|(name, _)| *name == callee) {
                            Some((_, index)) => *index,
                            None => return,
                        }
                    }
                    _ => return,
                };
                match args.get(index).map(|arg| (&arg.kind, arg.range)) {
                    Some((ExprKind::Literal(Literal::String(value)), range)) => {
                        if target.kind == SymbolKind::Function && value == &target.name {
                            let inner = string_inner(range);
                            locations.insert((
                                file.id().as_str().to_owned(),
                                inner.start.0,
                                inner.end.0,
                            ));
                        }
                    }
                    Some(_) => {
                        refusal = Some(format!(
                            "'{callee}' is called with a computed name in {}; rename by hand.",
                            display_name(file.id())
                        ));
                    }
                    None => {}
                }
            });
        }
        if let Some(refusal) = refusal {
            return Err(refusal);
        }
        if let Some(new_name) = new_name {
            check_collisions(unit, files, index, target, new_name)?;
        }
    }
    if !found {
        return Err(format!(
            "'{}' is not declared in an open XS script.",
            target.name
        ));
    }
    Ok(locations
        .into_iter()
        .filter_map(|(id, start, end)| {
            Some((
                SourceId::new(id).ok()?,
                ByteRange {
                    start: ByteOffset(start),
                    end: ByteOffset(end),
                },
            ))
        })
        .collect())
}

fn display_name(id: &SourceId) -> String {
    id.as_str()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(id.as_str())
        .replace("%20", " ")
}

fn check_collisions(
    unit: &UnitAnalysis,
    files: &[Arc<XsFile>],
    index: usize,
    target: &RenameTarget,
    new_name: &str,
) -> Result<(), String> {
    if new_name == target.name {
        return Ok(());
    }
    let body = if is_local(target.kind) {
        let file = files.iter().find(|file| *file.id() == target.source_id);
        file.and_then(|file| enclosing_body(file, target.selection_range))
    } else {
        None
    };
    for (other, symbol) in unit.symbols.iter().enumerate() {
        if other == index || symbol.name != new_name {
            continue;
        }
        let clashes = if symbol.from_environment || !is_local(symbol.kind) {
            true
        } else if is_local(target.kind) {
            symbol.source_id == target.source_id
                && body.is_some_and(|body| {
                    body.start <= symbol.selection_range.start
                        && symbol.selection_range.end <= body.end
                })
        } else {
            true
        };
        if clashes {
            let place = if symbol.from_environment {
                "Constants.xs".to_owned()
            } else {
                display_name(&symbol.source_id)
            };
            return Err(format!(
                "'{new_name}' is already used by a {} in {place}.",
                symbol.kind.label()
            ));
        }
    }
    Ok(())
}
