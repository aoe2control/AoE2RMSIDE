use rms_source::{ByteOffset, ByteRange};
use xs_syntax::{
    AssignOp, Block, Expr, ExprKind, Item, Severity, Stmt, StmtKind, TokenKind,
    VOID_PARAMETER_LIST, XsDiagnostic,
};

use crate::catalog::{XsBuild, catalog};
use crate::format::TextEdit;
use crate::model::{SymbolKind, Target, UnitAnalysis, XsFile};

#[derive(Clone, Debug, PartialEq)]
pub struct QuickFix {
    pub title: String,
    pub diagnostic: XsDiagnostic,
    pub edits: Vec<TextEdit>,
    pub preferred: bool,
}

pub fn quick_fixes(
    file: &XsFile,
    analysis: &UnitAnalysis,
    range: ByteRange,
    build: Option<XsBuild>,
) -> Vec<QuickFix> {
    let mut fixes = Vec::new();
    let overlaps = |diagnostic: &XsDiagnostic| {
        diagnostic.range.start <= range.end && range.start <= diagnostic.range.end
    };
    for diagnostic in analysis.diagnostics_for(file.id()) {
        if !overlaps(diagnostic) {
            continue;
        }
        let fix = match diagnostic.code {
            "XS3008" => renamed_builtin_fix(file, diagnostic, build),
            "XS4001" => unused_local_fix(file, analysis, diagnostic),
            "XS4012" => self_assignment_fix(file, diagnostic),
            "XS2001" if diagnostic.message == VOID_PARAMETER_LIST => {
                void_parameter_list_fix(file, diagnostic)
            }
            "XS2001" => missing_semicolon_fix(file, diagnostic),
            _ => None,
        };
        fixes.extend(fix);
    }
    fixes
}

fn text(file: &XsFile, range: ByteRange) -> &str {
    std::str::from_utf8(&file.source.bytes()[range.start.0 as usize..range.end.0 as usize])
        .unwrap_or("")
}

pub fn version_correct_builtin_name(name: &str, build: XsBuild) -> Option<String> {
    let catalog = catalog().ok()?;
    let builtin = catalog.get(name)?;
    if builtin.available_in(build) {
        return None;
    }
    if let Some((successor_build, successor)) = &builtin.successor
        && *successor_build == build
        && catalog
            .get(successor)
            .is_some_and(|candidate| candidate.available_in(build))
    {
        return Some(successor.clone());
    }
    let mut predecessors = catalog.builtins().iter().filter(|candidate| {
        candidate.available_in(build)
            && candidate
                .successor
                .as_ref()
                .is_some_and(|(_, successor)| successor == name)
    });
    let first = predecessors.next()?;
    predecessors.next().is_none().then(|| first.name.clone())
}

fn renamed_builtin_fix(
    file: &XsFile,
    diagnostic: &XsDiagnostic,
    build: Option<XsBuild>,
) -> Option<QuickFix> {
    let build = build?;
    let name = text(file, diagnostic.range);
    let replacement = version_correct_builtin_name(name, build)?;
    Some(QuickFix {
        title: format!("Use '{replacement}'"),
        diagnostic: diagnostic.clone(),
        edits: vec![TextEdit {
            range: diagnostic.range,
            replacement,
        }],
        preferred: true,
    })
}

fn has_effects(expr: &Expr) -> bool {
    match &expr.kind {
        ExprKind::Literal(_) | ExprKind::Name(_) => false,
        ExprKind::Unary { operand, .. } => has_effects(operand),
        ExprKind::Binary { left, right, .. } => has_effects(left) || has_effects(right),
        ExprKind::Cast { operand, .. } | ExprKind::ParenthesizedType { operand, .. } => {
            operand.as_deref().is_some_and(has_effects)
        }
        ExprKind::Vector(parts) => parts.iter().any(has_effects),
        ExprKind::Member { object, .. } => has_effects(object),
        ExprKind::Paren(inner) => has_effects(inner),
        ExprKind::Call { .. } | ExprKind::Error => true,
    }
}

fn find_listed_statement<'t>(
    file: &'t XsFile,
    matches: &dyn Fn(&Stmt) -> bool,
) -> Option<&'t Stmt> {
    fn in_list<'t>(stmts: &'t [Stmt], matches: &dyn Fn(&Stmt) -> bool) -> Option<&'t Stmt> {
        for stmt in stmts {
            if matches(stmt) {
                return Some(stmt);
            }
            if let Some(found) = nested(stmt, matches) {
                return Some(found);
            }
        }
        None
    }
    fn nested<'t>(stmt: &'t Stmt, matches: &dyn Fn(&Stmt) -> bool) -> Option<&'t Stmt> {
        match &stmt.kind {
            StmtKind::Block(block) => in_list(&block.stmts, matches),
            StmtKind::If {
                then_branch,
                else_branch,
                ..
            } => then_branch
                .as_deref()
                .and_then(|branch| nested(branch, matches))
                .or_else(|| {
                    else_branch
                        .as_deref()
                        .and_then(|branch| nested(branch, matches))
                }),
            StmtKind::While { body, .. } | StmtKind::For { body, .. } => {
                body.as_deref().and_then(|body| nested(body, matches))
            }
            StmtKind::Switch { cases, .. } => {
                cases.iter().find_map(|case| in_list(&case.body, matches))
            }
            _ => None,
        }
    }
    let body = |item: &'t Item| -> Option<&'t Block> {
        match item {
            Item::Function(function) => function.body.as_ref(),
            Item::Rule(rule) => rule.body.as_ref(),
            _ => None,
        }
    };
    file.tree
        .items
        .iter()
        .filter_map(body)
        .find_map(|block| in_list(&block.stmts, matches))
}

fn statement_deletion(file: &XsFile, range: ByteRange) -> TextEdit {
    let bytes = file.source.bytes();
    let start = range.start.0 as usize;
    let end = range.end.0 as usize;
    let line_start = bytes[..start]
        .iter()
        .rposition(|byte| *byte == b'\n' || *byte == b'\r')
        .map_or(0, |index| index + 1);
    let mut after = end;
    while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
        after += 1;
    }
    let alone_before = bytes[line_start..start]
        .iter()
        .all(|byte| *byte == b' ' || *byte == b'\t');
    let at_line_end = after == bytes.len() || bytes[after] == b'\n' || bytes[after] == b'\r';
    let (delete_start, delete_end) = if alone_before && at_line_end {
        let mut line_end = after;
        if line_end < bytes.len() && bytes[line_end] == b'\r' {
            line_end += 1;
        }
        if line_end < bytes.len() && bytes[line_end] == b'\n' {
            line_end += 1;
        }
        (line_start, line_end)
    } else {
        (start, after)
    };
    TextEdit {
        range: ByteRange {
            start: ByteOffset(delete_start as u32),
            end: ByteOffset(delete_end as u32),
        },
        replacement: String::new(),
    }
}

fn unused_local_fix(
    file: &XsFile,
    analysis: &UnitAnalysis,
    diagnostic: &XsDiagnostic,
) -> Option<QuickFix> {
    let (index, symbol) = analysis.symbols.iter().enumerate().find(|(_, symbol)| {
        symbol.kind == SymbolKind::LocalVariable
            && symbol.source_id == *file.id()
            && symbol.selection_range == diagnostic.range
    })?;
    let target = Target::Symbol(crate::model::SymbolId(index as u32));
    if analysis
        .references
        .iter()
        .any(|reference| reference.target == target)
    {
        return None;
    }
    let stmt = find_listed_statement(
        file,
        &|stmt| matches!(&stmt.kind, StmtKind::Variable(declaration) if declaration.name.range == diagnostic.range),
    )?;
    let StmtKind::Variable(declaration) = &stmt.kind else {
        return None;
    };
    if declaration.init.as_ref().is_some_and(has_effects) {
        return None;
    }
    Some(QuickFix {
        title: format!("Remove the unused variable '{}'", symbol.name),
        diagnostic: diagnostic.clone(),
        edits: vec![statement_deletion(file, stmt.range)],
        preferred: true,
    })
}

fn self_assignment_fix(file: &XsFile, diagnostic: &XsDiagnostic) -> Option<QuickFix> {
    let stmt = find_listed_statement(file, &|stmt| {
        let StmtKind::Assign {
            target,
            op: AssignOp::Assign,
            value: Some(value),
        } = &stmt.kind
        else {
            return false;
        };
        let (ExprKind::Name(left), ExprKind::Name(right)) = (&target.kind, &value.kind) else {
            return false;
        };
        left.text == right.text
            && stmt.range.start <= diagnostic.range.start
            && diagnostic.range.end <= stmt.range.end
    })?;
    Some(QuickFix {
        title: "Remove the self-assignment".to_owned(),
        diagnostic: diagnostic.clone(),
        edits: vec![statement_deletion(file, stmt.range)],
        preferred: true,
    })
}

fn void_parameter_list_fix(file: &XsFile, diagnostic: &XsDiagnostic) -> Option<QuickFix> {
    if !text(file, diagnostic.range).eq_ignore_ascii_case("void") {
        return None;
    }
    let tokens = &file.tree.tokens;
    let index = tokens
        .iter()
        .position(|token| token.range == diagnostic.range)?;
    let mut start = diagnostic.range.start;
    let mut end = diagnostic.range.end;
    if let Some(previous) = index.checked_sub(1).map(|index| &tokens[index])
        && previous.kind == TokenKind::Whitespace
    {
        start = previous.range.start;
    }
    if let Some(next) = tokens.get(index + 1)
        && next.kind == TokenKind::Whitespace
    {
        end = next.range.end;
    }
    Some(QuickFix {
        title: "Remove 'void' from the parameter list".to_owned(),
        diagnostic: diagnostic.clone(),
        edits: vec![TextEdit {
            range: ByteRange { start, end },
            replacement: String::new(),
        }],
        preferred: true,
    })
}

fn missing_semicolon_fix(file: &XsFile, diagnostic: &XsDiagnostic) -> Option<QuickFix> {
    if diagnostic.severity != Severity::Error || !diagnostic.message.starts_with("Expected ';'") {
        return None;
    }
    let previous = file
        .tree
        .tokens
        .iter()
        .rev()
        .find(|token| !token.kind.is_trivia() && token.range.end <= diagnostic.range.start)?;
    if matches!(
        previous.kind,
        TokenKind::Semicolon | TokenKind::LBrace | TokenKind::RBrace | TokenKind::Unknown
    ) {
        return None;
    }
    let between =
        &file.source.bytes()[previous.range.end.0 as usize..diagnostic.range.start.0 as usize];
    if !between.contains(&b'\n') {
        return None;
    }
    Some(QuickFix {
        title: "Insert the missing ';'".to_owned(),
        diagnostic: diagnostic.clone(),
        edits: vec![TextEdit {
            range: ByteRange {
                start: previous.range.end,
                end: previous.range.end,
            },
            replacement: ";".to_owned(),
        }],
        preferred: true,
    })
}
