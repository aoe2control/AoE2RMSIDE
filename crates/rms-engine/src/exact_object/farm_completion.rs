use super::*;
use rms_content::PlayerAttributeId;

#[cfg(any(test, feature = "placement-oracle"))]
fn farm_completion_disabled_for_attribution() -> bool {
    std::env::var_os("RMSIDE_TEST_DISABLE_FARM_COMPLETION_RULE").is_some()
}

#[cfg(not(any(test, feature = "placement-oracle")))]
fn farm_completion_disabled_for_attribution() -> bool {
    false
}

const PERIMETER_INSET: f32 = 0.5;
const PERIMETER_STEP: f32 = 0.3;
const PERIMETER_END: f32 = 1.0;
const MAXIMUM_COMPLETION_ITERATIONS: u64 = 1 << 20;

pub(super) struct OwnerFarmResources {
    values: BTreeMap<u32, f32>,
}

impl OwnerFarmResources {
    fn get(&self, attribute: PlayerAttributeId) -> Result<f32, GenerationError> {
        self.values
            .get(&attribute.0)
            .copied()
            .ok_or(GenerationError::IncompatibleContent)
    }
}

pub(super) fn owner_farm_resources(
    owner: u8,
    farm: &rms_content::FarmCompletionBindings,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    runtime_attributes: &ObjectRuntimeAttributes,
) -> Result<OwnerFarmResources, GenerationError> {
    let effects = content.startup_technology_resource_effects();
    let mut attributes = farm
        .attribute_ids()
        .into_iter()
        .map(|attribute| attribute.0)
        .collect::<BTreeSet<_>>();
    for effect in effects {
        for operation in &effect.operations {
            attributes.insert(operation.resource_id.0);
            attributes.extend(operation.source_resource_id.map(|source| source.0));
        }
    }
    let civilization = owner_resource_civilization(owner, owner_civilization(owner, setup)?);
    let mut values = BTreeMap::new();
    for attribute in attributes {
        let value = content
            .civilization_attribute_value(civilization, PlayerAttributeId(attribute))
            .ok_or(GenerationError::IncompatibleContent)?;
        values.insert(attribute, value);
    }
    if owner != 0 {
        let player = setup
            .players
            .iter()
            .find(|player| player.slot == owner)
            .ok_or_else(|| invalid_object("object owner is absent from setup"))?;
        let allies = setup
            .players
            .iter()
            .filter(|other| other.slot != owner && player.team != 0 && other.team == player.team)
            .map(|other| other.civilization_id)
            .collect::<Vec<_>>();
        let mut sources = vec![(
            player.civilization_id,
            rms_content::StartupTechnologyRoute::Automatic,
        )];
        sources.push((
            player.civilization_id,
            rms_content::StartupTechnologyRoute::Team,
        ));
        sources.extend(
            allies
                .into_iter()
                .map(|civilization| (civilization, rms_content::StartupTechnologyRoute::Team)),
        );
        let mut completed = BTreeSet::new();
        for (source, route) in sources {
            for effect in effects
                .iter()
                .filter(|effect| effect.civilization_id == source && effect.route == route)
            {
                let disabled = content
                    .technology_state_rule(effect.technology_id)
                    .ok_or(GenerationError::IncompatibleContent)?
                    .disabled_civilization_ids
                    .contains(&player.civilization_id);
                if disabled || !completed.insert(effect.technology_id) {
                    continue;
                }
                for operation in &effect.operations {
                    let operand = f32::from_bits(operation.value_f32_bits);
                    let operand = match operation.source_resource_id {
                        Some(source) => values[&source.0] * operand,
                        None => operand,
                    };
                    let current = values[&operation.resource_id.0];
                    let updated = match operation.kind {
                        rms_content::StartupResourceOperationKind::Set => operand,
                        rms_content::StartupResourceOperationKind::Add => current + operand,
                        rms_content::StartupResourceOperationKind::Multiply => current * operand,
                    };
                    values.insert(operation.resource_id.0, updated);
                }
            }
        }
    }
    for (attribute, value) in &mut values {
        *value = runtime_attributes.effective_player_resource(owner, *attribute, *value);
    }
    Ok(OwnerFarmResources { values })
}

fn generation_read_resources(
    farm: &rms_content::FarmCompletionBindings,
    content: CompatibleContentView<'_>,
) -> BTreeSet<u32> {
    let mut read = farm
        .attribute_ids()
        .into_iter()
        .map(|attribute| attribute.0)
        .collect::<BTreeSet<_>>();
    if let Some(starts) = content
        .native_generation_bindings()
        .and_then(|bindings| bindings.player_start_bindings)
    {
        read.extend([
            starts.packed_town_center_attribute_id.0,
            starts.starting_villagers_attribute_id.0,
            starts.starting_scout_attribute_id.0,
        ]);
    }
    for rule in content.object_replacement_rules() {
        read.extend(rule.replacement_attribute_id.map(|attribute| attribute.0));
        read.extend(rule.required_attribute_id.map(|attribute| attribute.0));
    }
    read
}

#[allow(clippy::too_many_arguments)]
pub(super) fn complete_farm(
    index: usize,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    if farm_completion_disabled_for_attribution() || objects[index].status != 2 {
        return Ok(());
    }
    let Some(farm) = content.farm_completion_bindings() else {
        return Ok(());
    };
    let farm_class = native_generation_bindings(content)?.classes.farm;
    let parent = objects[index].clone();
    let definition = foundation_map
        .runtime_attributes
        .definition(parent.object_id, parent.owner, content)
        .ok_or_else(|| missing_object_definition(parent.object_id))?;
    if definition.class_id != farm_class {
        return Ok(());
    }
    let parent_master = definition.id;
    let perimeter = farm.parent_object_ids.contains(&parent_master);
    let resources = owner_farm_resources(
        parent.owner,
        farm,
        setup,
        content,
        foundation_map.runtime_attributes,
    )?;
    let bonus_resource = truncate_f32_to_i32(resources.get(farm.bonus_resource_attribute_id)?);
    let bonus_anchor = truncate_f32_to_i32(resources.get(farm.bonus_anchor_attribute_id)?);
    if bonus_resource >= 0
        && bonus_anchor >= 0
        && generation_read_resources(farm, content).contains(&(bonus_resource as u32))
    {
        return Err(invalid_object(
            "a farm bonus that changes a resource generation reads is unsupported",
        ));
    }
    if !perimeter {
        return Ok(());
    }
    if later_starting_age(setup) || setup.lobby_options.changes_technology_state() {
        return Err(invalid_object(
            "farm completion under a later starting age, the full tech tree or antiquity mode is unsupported",
        ));
    }
    spawn_perimeter_children(
        index,
        &parent,
        definition.collision_half_extents()[0],
        farm,
        &resources,
        descriptor,
        setup,
        content,
        auxiliary_rng,
        objects,
        operation_indices,
        foundation_map,
    )
}

pub(super) fn perimeter_candidates(center: [f32; 2], half_width: f32) -> Vec<[f32; 2]> {
    let inset = half_width - PERIMETER_INSET;
    let low = [center[0] - inset, center[1] - inset];
    let corner_one = [center[0] + inset, center[1] - inset];
    let high = [center[0] + inset, center[1] + inset];
    let corner_three = [center[0] - inset, center[1] + inset];
    let edges = [
        (low, corner_one),
        (high, corner_one),
        (high, corner_three),
        (low, corner_three),
    ];
    let mut candidates = Vec::with_capacity(16);
    for (start, end) in edges {
        let mut t = 0.0_f32;
        loop {
            candidates.push([
                (end[0] - start[0]) * t + start[0],
                (end[1] - start[1]) * t + start[1],
            ]);
            t += PERIMETER_STEP;
            if t > PERIMETER_END {
                break;
            }
        }
    }
    candidates
}

fn low15(rng: &mut RmsRandom) -> u64 {
    u64::from(rng.next_u32() & 0x7fff)
}

#[allow(clippy::too_many_arguments)]
fn spawn_perimeter_children(
    parent_index: usize,
    parent: &PlacedObject,
    half_width: f32,
    farm: &rms_content::FarmCompletionBindings,
    resources: &OwnerFarmResources,
    descriptor: &ExactObjectDescriptor,
    setup: &ExactSetupState,
    content: CompatibleContentView<'_>,
    auxiliary_rng: &mut RmsRandom,
    objects: &mut Vec<PlacedObject>,
    operation_indices: &mut Vec<u32>,
    foundation_map: &mut FoundationMap<'_>,
) -> Result<(), GenerationError> {
    let center = foundation_map
        .construction_positions
        .get(&parent_index)
        .map(|bits| bits.map(f32::from_bits))
        .unwrap_or([parent.x_256 as f32 / 256.0, parent.y_256 as f32 / 256.0]);
    let mut candidates = perimeter_candidates(center, half_width);
    let count = truncate_f32_to_i32(resources.get(farm.spawn_count_attribute_id)?);
    let quantity = resources.get(farm.total_resource_quantity_attribute_id)? / count as f32;
    let masters = &farm.spawned_object_ids;
    let owner = parent.owner;
    let mut child_descriptor = descriptor.clone();
    child_descriptor.explicit_facet = None;
    child_descriptor.resource_delta = 0;
    child_descriptor.behavior_flags = 0;
    let mut child_tiles = Vec::<(i32, i32)>::new();
    let dimensions = foundation_map.dimensions;
    let mut iterations = 0_u64;
    for _ in 0..count.max(0) {
        iterations += 1;
        if iterations > MAXIMUM_COMPLETION_ITERATIONS {
            return Err(object_limit(
                "farm completion iterations",
                MAXIMUM_COMPLETION_ITERATIONS as usize,
            ));
        }
        if candidates.is_empty() {
            break;
        }
        let master = masters[(low15(auxiliary_rng) % masters.len() as u64) as usize];
        let mut position = (low15(auxiliary_rng) % candidates.len() as u64) as usize;
        loop {
            let candidate = candidates[position];
            let tile = (
                truncate_f32_to_i32(candidate[0]),
                truncate_f32_to_i32(candidate[1]),
            );
            let inside = (0..i32::from(dimensions.width)).contains(&tile.0)
                && (0..i32::from(dimensions.height)).contains(&tile.1);
            if inside && !child_tiles.contains(&tile) {
                break;
            }
            candidates.remove(position);
            if candidates.is_empty() {
                return Ok(());
            }
            position = (low15(auxiliary_rng) % candidates.len() as u64) as usize;
        }
        if !object_available_to_owner(master, owner, setup, content)? {
            continue;
        }
        let candidate = candidates.remove(position);
        let child_index = objects.len();
        construct_one_at(
            master,
            candidate,
            owner,
            &child_descriptor,
            setup,
            content,
            auxiliary_rng,
            objects,
            operation_indices,
            foundation_map,
            1,
            None,
        )?;
        let child_definition = foundation_map
            .runtime_attributes
            .definition(master, owner, content)
            .ok_or_else(|| missing_object_definition(master))?;
        objects[child_index].resource_quantity_f32_bits = quantity.to_bits();
        if masters.contains(&child_definition.id) {
            child_tiles.push((
                truncate_f32_to_i32(candidate[0]),
                truncate_f32_to_i32(candidate[1]),
            ));
        }
        let graphic = foundation_map
            .runtime_attributes
            .standing_graphic_id(master, owner, child_definition)
            .and_then(|graphic| content.graphic(graphic));
        if let Some(graphic) = graphic.filter(|graphic| graphic.random_facet) {
            let divisor = i32::from(graphic.signed_angle_count()) - 1;
            if divisor == 0 {
                return Err(invalid_object(
                    "a farm child with a one-direction random-facet graphic is unsupported",
                ));
            }
            let sample = (auxiliary_rng.next_u32() & 0x7fff) as i32;
            objects[child_index].facet = u16::from((sample % divisor) as u8);
        }
    }
    Ok(())
}
