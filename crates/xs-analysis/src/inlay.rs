use std::collections::HashMap;

use rms_source::{ByteOffset, ByteRange};
use xs_syntax::{Expr, ExprKind};

use crate::analyzer::argument_order_name_known;
use crate::catalog::{Builtin, XsBuild, catalog};
use crate::model::{SymbolKind, Target, UnitAnalysis, XsFile};
use crate::rename::visit_calls_within;

pub const MAXIMUM_XS_INLAY_HINTS: usize = 2_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParameterHint {
    pub position: ByteOffset,
    pub label: String,
}

pub fn parameter_hints(
    file: &XsFile,
    analysis: &UnitAnalysis,
    range: ByteRange,
    build: Option<XsBuild>,
) -> Vec<ParameterHint> {
    let callees = analysis
        .references
        .iter()
        .filter(|reference| reference.source_id == *file.id())
        .map(|reference| {
            (
                reference.range.start.0,
                (reference.range, &reference.target),
            )
        })
        .collect::<HashMap<_, _>>();
    let builtins = catalog().ok();
    let mut hints = Vec::new();
    visit_calls_within(file, Some(range), &mut |callee, args| {
        if args.len() < 2 || hints.len() >= MAXIMUM_XS_INLAY_HINTS {
            return;
        }
        let Some(&(reference_range, target)) = callees.get(&callee.range.start.0) else {
            return;
        };
        if reference_range != callee.range {
            return;
        }
        let names: Vec<Option<&str>> = match target {
            Target::Symbol(id) => {
                let symbol = analysis.symbol(*id);
                let Some(signature) = symbol
                    .signature
                    .as_ref()
                    .filter(|_| symbol.kind == SymbolKind::Function)
                else {
                    return;
                };
                signature
                    .params
                    .iter()
                    .map(|(name, _)| Some(name.as_str()))
                    .collect()
            }
            Target::Builtin(name) => {
                let Some(builtin) = builtins.and_then(|catalog| catalog.get(name)) else {
                    return;
                };
                builtin_parameter_names(builtin, build)
            }
        };
        for (argument, name) in args.iter().zip(names) {
            if hints.len() >= MAXIMUM_XS_INLAY_HINTS {
                return;
            }
            let Some(name) = name.filter(|name| !name.is_empty()) else {
                continue;
            };
            if argument.range.start < range.start
                || argument.range.start > range.end
                || matches!(argument.kind, ExprKind::Error)
                || names_the_parameter(argument, name)
            {
                continue;
            }
            hints.push(ParameterHint {
                position: argument.range.start,
                label: format!("{name}:"),
            });
        }
    });
    hints.sort_by_key(|hint| hint.position);
    hints.dedup();
    hints
}

fn builtin_parameter_names(builtin: &Builtin, build: Option<XsBuild>) -> Vec<Option<&str>> {
    if !builtin.parameter_names_known || build.is_some_and(|build| !builtin.available_in(build)) {
        return Vec::new();
    }
    let selected = builtin.params_for(build);
    selected
        .iter()
        .enumerate()
        .map(|(index, param)| {
            let agreed = build.is_some()
                || XsBuild::ALL
                    .iter()
                    .filter(|candidate| builtin.available_in(**candidate))
                    .all(|candidate| {
                        builtin
                            .params_for(Some(*candidate))
                            .get(index)
                            .is_none_or(|other| other.name == param.name)
                    });
            (agreed && argument_order_name_known(&builtin.name, &param.name))
                .then_some(param.name.as_str())
        })
        .collect()
}

fn names_the_parameter(argument: &Expr, parameter: &str) -> bool {
    let mut expression = argument;
    while let ExprKind::Paren(inner) = &expression.kind {
        expression = inner;
    }
    match &expression.kind {
        ExprKind::Name(name) => name.text.eq_ignore_ascii_case(parameter),
        ExprKind::Member { member, .. } => member.text.eq_ignore_ascii_case(parameter),
        _ => false,
    }
}
