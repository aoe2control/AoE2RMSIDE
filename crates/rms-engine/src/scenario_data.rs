use std::collections::BTreeSet;

use rms_content::{CompatibleContentView, ObjectId};
use rms_semantics::SemanticOperation;

use crate::{GeneratedMap, ResolvedGenerationInput};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScenarioObjectKind {
    pub object_id: ObjectId,
    pub facet_count: u16,
    pub random_facet: bool,
    pub random_angle: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScenarioScriptEffect {
    pub effect: i32,
    pub target: i32,
    pub attribute: i32,
    pub value: f32,
    pub operation_index: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScenarioData {
    pub object_kinds: Vec<ScenarioObjectKind>,
    pub script_effects: Vec<ScenarioScriptEffect>,
    pub xs_includes: Vec<String>,
}

pub fn scenario_data(input: &ResolvedGenerationInput<'_>, map: &GeneratedMap) -> ScenarioData {
    let ids = map
        .objects
        .iter()
        .map(|object| object.object_id)
        .chain(map.appearance_objects.iter().map(|object| object.object_id))
        .chain(map.cliff_pieces.iter().map(|piece| piece.object_id))
        .collect::<BTreeSet<_>>();
    ScenarioData {
        object_kinds: ids
            .into_iter()
            .map(|id| object_kind(id, input.content))
            .collect(),
        script_effects: script_effects(&input.semantic_program.operations),
        xs_includes: input
            .semantic_program
            .external_dependencies
            .iter()
            .map(|source| source.as_str().to_owned())
            .collect(),
    }
}

fn object_kind(object_id: ObjectId, content: CompatibleContentView<'_>) -> ScenarioObjectKind {
    let Some(definition) = content.object(object_id) else {
        return ScenarioObjectKind {
            object_id,
            facet_count: 1,
            random_facet: false,
            random_angle: false,
        };
    };
    let rng = definition.creation_rng;
    ScenarioObjectKind {
        object_id,
        facet_count: rng.facet_count.max(1),
        random_facet: rng.random_facet,
        random_angle: rng.random_angle,
    }
}

fn script_effects(operations: &[SemanticOperation]) -> Vec<ScenarioScriptEffect> {
    operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| {
            matches!(operation.name.as_str(), "effect_amount" | "effect_percent")
                && operation.accepted_by_target_parser()
        })
        .filter_map(|(index, operation)| {
            let value = number_argument(operation, 3)?;
            Some(ScenarioScriptEffect {
                effect: integer_argument(operation, 0)?,
                target: integer_argument(operation, 1)?,
                attribute: integer_argument(operation, 2)?,
                value: if operation.name == "effect_percent" {
                    value / 100.0
                } else {
                    value
                },
                operation_index: u32::try_from(index).ok()?,
            })
        })
        .collect()
}

fn number_argument(operation: &SemanticOperation, index: usize) -> Option<f32> {
    let value = operation.arguments.get(index)?.value.parse::<f32>().ok()?;
    value.is_finite().then_some(value)
}

fn integer_argument(operation: &SemanticOperation, index: usize) -> Option<i32> {
    let value = number_argument(operation, index)?;
    (value.abs() < 2_147_483_648.0).then(|| value.trunc() as i32)
}
