use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dat::{DatDocument, DatTechnology, decode_ver89};
use crate::dat_projection::{ObjectSlotAccount, project};
use crate::native_bindings::NativeContentBindings;
use crate::{
    AutomaticSpawnTechnology, BuildingSpawnCommand, BuildingSpawnVariantRule,
    BuildingTechnologyTrigger, CONTENT_SCHEMA_MAJOR, CONTENT_SCHEMA_VERSION,
    CivilizationAttributeValue, CivilizationId, CivilizationObjectAttributeValue,
    CompatibilityRange, ContentError, ContentSource, ContentSourceKind, DatImportLimits,
    FarmCompletionBindings, NeutralContentPack, ObjectId, ObjectReplacementRule, PlayerAttributeId,
    StartupResourceOperation, StartupResourceOperationKind, StartupTechnologyResourceEffect,
    StartupTechnologyRoute, TechnologyStateGate, TechnologyStateRule, decode_aoe2de_dat, hex_bytes,
};

pub const AOE2DE_VER89_LAYOUT_ID: &str = "aoe2de-ver89-complete-v1";
pub const COMPLETENESS_MANIFEST_SCHEMA: &str =
    "https://rmside.invalid/schemas/content-completeness/v1";
pub const COMPLETENESS_MANIFEST_SCHEMA_VERSION: &str = "1.0.0";
const MAXIMUM_OBJECT_REPLACEMENT_BYTES: usize = 1024 * 1024;
const MAXIMUM_OBJECT_REPLACEMENT_RECORDS: usize = 4096;
const MAXIMUM_GATE_TECHNOLOGIES: usize = 16;
const MAXIMUM_SPAWN_TECHNOLOGY_CANDIDATES: usize = 2 * 1024;

pub struct Aoe2deContentInputs<'a> {
    pub dat: &'a [u8],
    pub object_replacements: &'a [u8],
    pub implicit_definitions: &'a BTreeMap<String, i32>,
    pub bindings: &'a NativeContentBindings,
    pub behavior_profile_id: &'a str,
    pub product_version_label: Option<&'a str>,
    pub pack_id: &'a str,
    pub pack_version: &'a str,
    pub limits: DatImportLimits,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCompletenessManifest {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub layout_id: String,
    pub behavior_profile_id: String,
    pub content_schema_version: String,
    pub native_bindings_canonical_sha256: String,
    pub dat_version_header: String,
    pub civilization_count: u32,
    pub terrain_slot_count: u32,
    pub emitted_terrain_count: u32,
    pub object_slot_count: u32,
    pub emitted_object_count: u32,
    pub excluded_objects: Vec<ObjectSlotAccount>,
    pub restriction_count: u32,
    pub resource_count: u32,
    pub object_replacement_record_count: u32,
    pub emitted_object_replacement_rule_count: u32,
    pub implicit_definition_count: u32,
    pub implicit_definitions_canonical_sha256: String,
}

impl ContentCompletenessManifest {
    pub fn require_supported(&self) -> Result<(), ContentError> {
        if self.schema != COMPLETENESS_MANIFEST_SCHEMA
            || self.schema_version != COMPLETENESS_MANIFEST_SCHEMA_VERSION
            || self.compatibility.minimum_major != 1
            || self.compatibility.maximum_major != 1
        {
            return Err(ContentError::UnsupportedSchema(self.schema_version.clone()));
        }
        Ok(())
    }
}

pub fn implicit_definitions_canonical_sha256(
    definitions: &BTreeMap<String, i32>,
) -> Result<String, ContentError> {
    let bytes = serde_json::to_vec(definitions).map_err(ContentError::Serialize)?;
    Ok(hex_bytes(&Sha256::digest(bytes)))
}

pub fn native_bindings_canonical_sha256(
    bindings: &NativeContentBindings,
) -> Result<String, ContentError> {
    let bytes = serde_json::to_vec(bindings).map_err(ContentError::Serialize)?;
    Ok(hex_bytes(&Sha256::digest(bytes)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplacementDocument {
    objects: Vec<ReplacementRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplacementRecord {
    #[allow(dead_code)]
    name: String,
    object_id: u32,
    object_override: ReplacementOverride,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplacementOverride {
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
    #[serde(default)]
    replacement_object: Option<u32>,
    #[serde(default)]
    chance: Option<i32>,
    #[serde(default)]
    #[allow(dead_code)]
    attribute_name: Option<String>,
    #[serde(default)]
    replacement_attribute: Option<u32>,
    #[serde(default)]
    required_attribute: Option<i32>,
    #[serde(default)]
    excluded_computer_players: Option<bool>,
    #[serde(default)]
    technology: Option<Vec<u16>>,
    #[serde(default)]
    technology_state: Option<u16>,
}

pub fn import_aoe2de_content(
    inputs: &Aoe2deContentInputs<'_>,
) -> Result<(NeutralContentPack, ContentCompletenessManifest), ContentError> {
    let (preflight, decompressed) = decode_aoe2de_dat(inputs.dat, inputs.limits)?;
    let document = decode_ver89(&decompressed)?;
    drop(decompressed);
    let projection = project(&document, inputs.bindings)?;
    let emitted = projection
        .objects
        .iter()
        .map(|object| object.id)
        .collect::<BTreeSet<_>>();
    let mut replacements = object_replacements(inputs.object_replacements, &emitted)?;
    if let Some(starts) = inputs
        .bindings
        .native_generation_bindings
        .player_start_bindings
    {
        replacements
            .numeric_attributes
            .insert(starts.packed_town_center_attribute_id.0);
        replacements
            .object_attributes
            .insert(starts.starting_scout_attribute_id.0);
        let attributes = [
            starts.packed_town_center_attribute_id.0,
            starts.starting_villagers_attribute_id.0,
            starts.starting_scout_attribute_id.0,
        ]
        .into_iter()
        .collect();
        require_research_static_attributes(&document, &attributes)?;
        if !inputs
            .bindings
            .single_request_counts
            .iter()
            .any(|binding| binding.object_id == starts.villager_object_id)
        {
            return Err(ContentError::InvalidField(
                "player start villager count binding",
            ));
        }
    }
    let civilization_object_attribute_values =
        civilization_object_attributes(&document, &replacements.object_attributes, &emitted)?;
    require_research_static_attributes(&document, &replacements.numeric_attributes)?;
    require_uniform_starting_villagers(&document, inputs.bindings)?;
    let farm = match &inputs
        .bindings
        .native_generation_bindings
        .farm_completion_bindings
    {
        Some(farm) => Some(farm_completion_facts(&document, farm)?),
        None => None,
    };
    let mut numeric_attributes = replacements.numeric_attributes.clone();
    let mut gate_technologies = replacements.gate_technologies.clone();
    if let Some(farm) = &farm {
        numeric_attributes.extend(&farm.attribute_ids);
        gate_technologies.extend(&farm.technology_ids);
    }
    let civilization_attribute_values =
        civilization_attribute_values(&document, &numeric_attributes)?;
    let technology_state_rules = technology_state_rules(&document, &gate_technologies)?;
    let replacement_records = replacements.records;
    let object_replacement_rules = replacements.rules;
    let technologies = technology_tables(&document, &emitted)?;
    let building_spawn_variant_rules = object_replacement_rules
        .iter()
        .filter(|rule| {
            rule.required_attribute_id.is_none()
                && !rule.excludes_computer_players
                && rule.technology_gate.is_none()
        })
        .filter_map(|rule| {
            Some(BuildingSpawnVariantRule {
                source_object_id: rule.source_object_id,
                alternate_object_id: rule.replacement_object_id?,
                alternate_from_percent: rule.maximum_roll_inclusive?,
            })
        })
        .filter(|rule| {
            technologies
                .automatic_spawn_technologies
                .iter()
                .flat_map(|technology| &technology.commands)
                .any(|command| command.spawned_object_id == rule.source_object_id)
        })
        .collect::<Vec<_>>();
    let bindings = inputs.bindings;
    let source = ContentSource {
        kind: ContentSourceKind::Aoe2deDat,
        fingerprint: preflight.source_fingerprint.clone(),
        product_version_label: inputs.product_version_label.map(str::to_owned),
        dat_version_header: Some(preflight.version_header.clone()),
        object_replacement_fingerprint: Some(hex_bytes(&Sha256::digest(
            inputs.object_replacements,
        ))),
    };
    let content_schema_version = if farm.is_some() {
        CONTENT_SCHEMA_VERSION
    } else if inputs
        .bindings
        .native_generation_bindings
        .player_start_bindings
        .is_some()
    {
        crate::PLAYER_START_SCHEMA_VERSION
    } else if inputs
        .bindings
        .native_generation_bindings
        .construction_site_exemptions
        .is_some()
    {
        crate::CONSTRUCTION_SITE_SCHEMA_VERSION
    } else {
        crate::NATIVE_BINDINGS_SCHEMA_VERSION
    };
    let mut pack = NeutralContentPack {
        schema: None,
        schema_version: content_schema_version.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: CONTENT_SCHEMA_MAJOR,
            maximum_major: CONTENT_SCHEMA_MAJOR,
        },
        pack_id: inputs.pack_id.to_owned(),
        pack_version: inputs.pack_version.to_owned(),
        source,
        compatible_behavior_profiles: vec![inputs.behavior_profile_id.to_owned()],
        rms_implicit_definitions: inputs.implicit_definitions.clone(),
        rms_path_reference_object_id: Some(bindings.rms_path_reference_object_id),
        terrains: projection.terrains,
        foundation_terrain_rules: bindings.foundation_terrain_rules.clone(),
        composite_terrain_rules: bindings.composite_terrain_rules.clone(),
        game_mode_terrain_rules: bindings.game_mode_terrain_rules.clone(),
        game_mode_player_object_rules: bindings.game_mode_player_object_rules.clone(),
        initial_automatic_technology_ids: technologies.initial_automatic_technology_ids,
        building_technology_triggers: technologies.building_technology_triggers,
        automatic_spawn_technologies: technologies.automatic_spawn_technologies,
        setup_dependent_spawn_technologies: technologies.setup_dependent_spawn_technologies,
        building_spawn_variant_rules,
        objects: projection.objects,
        object_resource_slot_variants: projection.resource_slot_variants,
        object_movement_speed_variants: projection.movement_speed_variants,
        civilization_substitutions: Vec::new(),
        object_replacement_rules,
        wall_placement_rules: bindings.wall_placement_rules.clone(),
        civilization_object_attribute_values,
        civilization_attribute_values,
        technology_state_rules,
        startup_technology_resource_effects: farm.map(|farm| farm.effects).unwrap_or_default(),
        resources: projection.resources,
        cliffs: projection.cliffs,
        restrictions: projection.restrictions,
        terrain_topology: bindings.terrain_topology.clone(),
        object_placement_classes: bindings.object_placement_classes,
        native_generation_bindings: Some(bindings.native_generation_bindings.clone()),
        graphics: projection.graphics,
    };
    pack.building_technology_triggers.sort();
    pack.automatic_spawn_technologies
        .sort_by_key(|technology| technology.technology_id);
    pack.building_spawn_variant_rules.sort();
    pack.validate()?;
    let manifest = ContentCompletenessManifest {
        schema: COMPLETENESS_MANIFEST_SCHEMA.to_owned(),
        schema_version: COMPLETENESS_MANIFEST_SCHEMA_VERSION.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: 1,
            maximum_major: 1,
        },
        layout_id: AOE2DE_VER89_LAYOUT_ID.to_owned(),
        behavior_profile_id: inputs.behavior_profile_id.to_owned(),
        content_schema_version: content_schema_version.to_owned(),
        native_bindings_canonical_sha256: native_bindings_canonical_sha256(bindings)?,
        dat_version_header: preflight.version_header,
        civilization_count: projection.civilization_count as u32,
        terrain_slot_count: projection.terrain_slot_count as u32,
        emitted_terrain_count: pack.terrains.len() as u32,
        object_slot_count: projection.object_slot_count as u32,
        emitted_object_count: pack.objects.len() as u32,
        excluded_objects: projection.excluded_objects,
        restriction_count: pack.restrictions.len() as u32,
        resource_count: pack.resources.len() as u32,
        object_replacement_record_count: replacement_records as u32,
        emitted_object_replacement_rule_count: pack.object_replacement_rules.len() as u32,
        implicit_definition_count: inputs.implicit_definitions.len() as u32,
        implicit_definitions_canonical_sha256: implicit_definitions_canonical_sha256(
            inputs.implicit_definitions,
        )?,
    };
    if manifest.emitted_object_count as usize + manifest.excluded_objects.len()
        != projection.object_slot_count
        || manifest.emitted_terrain_count != manifest.terrain_slot_count
    {
        return Err(ContentError::InvalidField("content slot accounting"));
    }
    Ok((pack, manifest))
}

struct ReplacementImport {
    rules: Vec<ObjectReplacementRule>,
    object_attributes: BTreeSet<u32>,
    numeric_attributes: BTreeSet<u32>,
    gate_technologies: BTreeSet<u16>,
    records: usize,
}

fn object_replacements(
    bytes: &[u8],
    emitted: &BTreeSet<ObjectId>,
) -> Result<ReplacementImport, ContentError> {
    if bytes.len() > MAXIMUM_OBJECT_REPLACEMENT_BYTES {
        return Err(ContentError::ResourceLimit("object replacement input"));
    }
    let document: ReplacementDocument =
        serde_json::from_slice(bytes).map_err(ContentError::Parse)?;
    if document.objects.len() > MAXIMUM_OBJECT_REPLACEMENT_RECORDS {
        return Err(ContentError::ResourceLimit("object replacement records"));
    }
    let mut import = ReplacementImport {
        rules: Vec::new(),
        object_attributes: BTreeSet::new(),
        numeric_attributes: BTreeSet::new(),
        gate_technologies: BTreeSet::new(),
        records: document.objects.len(),
    };
    for record in &document.objects {
        let replacement = &record.object_override;
        let source_object_id = ObjectId(record.object_id);
        if !emitted.contains(&source_object_id) {
            return Err(ContentError::DanglingReference("object replacement source"));
        }
        let maximum_roll_inclusive = match replacement.chance {
            None | Some(-1) => None,
            Some(value @ 0..=99) => Some(value as u8),
            Some(_) => return Err(ContentError::InvalidField("object replacement chance")),
        };
        let replacement_object_id = replacement
            .replacement_object
            .map(|object| {
                let object = ObjectId(object);
                if emitted.contains(&object) {
                    Ok(object)
                } else {
                    Err(ContentError::DanglingReference("object replacement target"))
                }
            })
            .transpose()?;
        if replacement_object_id.is_none() == replacement.replacement_attribute.is_none() {
            return Err(ContentError::InvalidField("object replacement target"));
        }
        import
            .object_attributes
            .extend(replacement.replacement_attribute);
        let required_attribute_id = match replacement.required_attribute {
            None | Some(-1) => None,
            Some(attribute) => {
                let attribute = u32::try_from(attribute)
                    .map_err(|_| ContentError::InvalidField("object replacement attribute"))?;
                import.numeric_attributes.insert(attribute);
                Some(PlayerAttributeId(attribute))
            }
        };
        let technology_gate = match (&replacement.technology, replacement.technology_state) {
            (None, None) => None,
            (Some(technologies), Some(state)) if !technologies.is_empty() => {
                let mut technology_ids = technologies.clone();
                technology_ids.sort_unstable();
                technology_ids.dedup();
                if technology_ids.len() > MAXIMUM_GATE_TECHNOLOGIES {
                    return Err(ContentError::ResourceLimit(
                        "object replacement technology gate",
                    ));
                }
                import.gate_technologies.extend(&technology_ids);
                Some(TechnologyStateGate {
                    technology_ids,
                    state: i16::try_from(state)
                        .map_err(|_| ContentError::InvalidField("object replacement state"))?,
                })
            }
            _ => return Err(ContentError::InvalidField("object replacement technology")),
        };
        import.rules.push(ObjectReplacementRule {
            source_object_id,
            replacement_object_id,
            replacement_attribute_id: replacement.replacement_attribute.map(PlayerAttributeId),
            maximum_roll_inclusive,
            required_attribute_id,
            excludes_computer_players: replacement.excluded_computer_players.unwrap_or(false),
            technology_gate,
        });
    }
    import.rules.sort_by_key(|rule| rule.source_object_id);
    if import
        .rules
        .windows(2)
        .any(|pair| pair[0].source_object_id == pair[1].source_object_id)
    {
        return Err(ContentError::InvalidField(
            "duplicate object replacement source",
        ));
    }
    Ok(import)
}

const RESOURCE_EFFECT_COMMANDS: [u8; 6] = [1, 6, 11, 16, 21, 26];

fn require_research_static_attributes(
    document: &DatDocument,
    attributes: &BTreeSet<u32>,
) -> Result<(), ContentError> {
    let modified = document.effects.iter().flatten().any(|command| {
        RESOURCE_EFFECT_COMMANDS.contains(&command.kind)
            && u32::try_from(command.a).is_ok_and(|attribute| attributes.contains(&attribute))
    });
    if modified {
        return Err(ContentError::UnsupportedLayout(
            "an object replacement gate attribute is modified by an effect".to_owned(),
        ));
    }
    Ok(())
}

struct FarmCompletionFacts {
    attribute_ids: BTreeSet<u32>,
    technology_ids: BTreeSet<u16>,
    effects: Vec<StartupTechnologyResourceEffect>,
}

const ALL_RESOURCE_EFFECT_COMMANDS: [u8; 10] = [1, 6, 11, 16, 21, 26, 31, 36, 41, 46];
const TECHNOLOGY_TIME_COMMAND: u8 = 103;

fn farm_completion_facts(
    document: &DatDocument,
    farm: &FarmCompletionBindings,
) -> Result<FarmCompletionFacts, ContentError> {
    let roles = farm
        .attribute_ids()
        .into_iter()
        .map(|attribute| attribute.0)
        .collect::<BTreeSet<_>>();
    let effect_rows = |technology: &DatTechnology| {
        usize::try_from(technology.effect_id)
            .ok()
            .map(|effect| {
                document
                    .effects
                    .get(effect)
                    .ok_or(ContentError::DanglingReference("technology effect"))
            })
            .transpose()
            .map(|rows| rows.map_or(&[][..], Vec::as_slice))
    };
    let writes_role = |technology: &DatTechnology| -> Result<bool, ContentError> {
        Ok(effect_rows(technology)?.iter().any(|row| {
            ALL_RESOURCE_EFFECT_COMMANDS.contains(&row.kind)
                && u32::try_from(row.a).is_ok_and(|attribute| roles.contains(&attribute))
        }))
    };
    let mut candidates = BTreeSet::new();
    for (index, technology) in document.technologies.iter().enumerate() {
        if !is_automatic(technology) || !writes_role(technology)? {
            continue;
        }
        if technology.required_count > 0 {
            return Err(ContentError::UnsupportedLayout(format!(
                "automatic technology {index} with a farm attribute effect needs another technology first"
            )));
        }
        let id =
            u16::try_from(index).map_err(|_| ContentError::InvalidField("technology identity"))?;
        match technology.civilization {
            -1 => {
                for civilization in 0..document.civilizations.len() {
                    candidates.insert((civilization as u32, StartupTechnologyRoute::Automatic, id));
                }
            }
            civilization => {
                let civilization = u32::try_from(civilization)
                    .ok()
                    .filter(|civilization| (*civilization as usize) < document.civilizations.len())
                    .ok_or(ContentError::InvalidField("technology civilization"))?;
                candidates.insert((civilization, StartupTechnologyRoute::Automatic, id));
            }
        }
    }
    for (civilization, table) in document.civilizations.iter().enumerate() {
        let Ok(effect) = usize::try_from(table.team_bonus_effect) else {
            continue;
        };
        let rows = document
            .effects
            .get(effect)
            .ok_or(ContentError::DanglingReference("team bonus effect"))?;
        for row in rows {
            if row.kind != TECHNOLOGY_TIME_COMMAND
                || row.c != 0
                || f32::from_bits(row.d_bits) != 0.0
            {
                continue;
            }
            let Some(technology) = usize::try_from(row.a)
                .ok()
                .and_then(|index| document.technologies.get(index))
            else {
                return Err(ContentError::DanglingReference("team bonus technology"));
            };
            if !writes_role(technology)? {
                continue;
            }
            if technology.civilization != -1
                || technology.required_count > 0
                || technology.full_tech_mode != 0
            {
                return Err(ContentError::UnsupportedLayout(format!(
                    "team bonus technology {} with a farm attribute effect is not open at startup",
                    row.a
                )));
            }
            candidates.insert((
                civilization as u32,
                StartupTechnologyRoute::Team,
                row.a as u16,
            ));
        }
    }
    let mut attribute_ids = roles.clone();
    let mut technology_ids = BTreeSet::new();
    let mut effects = Vec::new();
    for (civilization, route, technology_id) in candidates {
        let technology = &document.technologies[usize::from(technology_id)];
        let mut operations = Vec::new();
        for row in effect_rows(technology)? {
            if !ALL_RESOURCE_EFFECT_COMMANDS.contains(&row.kind) {
                continue;
            }
            let resource = u32::try_from(row.a)
                .map_err(|_| ContentError::InvalidField("startup resource row"))?;
            let source = match row.c {
                -1 => None,
                source => {
                    Some(PlayerAttributeId(u32::try_from(source).map_err(|_| {
                        ContentError::InvalidField("startup resource row")
                    })?))
                }
            };
            let kind = match (row.kind, row.b) {
                (1, 0) => StartupResourceOperationKind::Set,
                (1, 1) => StartupResourceOperationKind::Add,
                (6, _) if source.is_none() => StartupResourceOperationKind::Multiply,
                _ => {
                    return Err(ContentError::UnsupportedLayout(format!(
                        "startup technology {technology_id} has a resource row the preview cannot execute"
                    )));
                }
            };
            if !f32::from_bits(row.d_bits).is_finite() {
                return Err(ContentError::InvalidField("startup resource row"));
            }
            attribute_ids.insert(resource);
            attribute_ids.extend(source.map(|source| source.0));
            operations.push(StartupResourceOperation {
                kind,
                resource_id: PlayerAttributeId(resource),
                source_resource_id: source,
                value_f32_bits: row.d_bits,
            });
        }
        technology_ids.insert(technology_id);
        effects.push(StartupTechnologyResourceEffect {
            civilization_id: CivilizationId(civilization),
            route,
            technology_id,
            operations,
        });
    }
    Ok(FarmCompletionFacts {
        attribute_ids,
        technology_ids,
        effects,
    })
}

const STARTING_VILLAGERS_RESOURCE: usize = 84;

fn require_uniform_starting_villagers(
    document: &DatDocument,
    bindings: &NativeContentBindings,
) -> Result<(), ContentError> {
    let resource = bindings
        .native_generation_bindings
        .player_start_bindings
        .map_or(STARTING_VILLAGERS_RESOURCE, |starts| {
            starts.starting_villagers_attribute_id.0 as usize
        });
    for binding in &bindings.single_request_counts {
        let expected = binding.count as f32;
        let uniform = document.civilizations.iter().all(|table| {
            table
                .resource_bits
                .get(resource)
                .is_some_and(|bits| f32::from_bits(*bits) == expected)
        });
        if !uniform {
            return Err(ContentError::UnsupportedLayout(format!(
                "a civilization's starting villagers differ from the single-request count of object {}",
                binding.object_id.0
            )));
        }
    }
    let modified = document.effects.iter().flatten().any(|command| {
        RESOURCE_EFFECT_COMMANDS.contains(&command.kind)
            && usize::try_from(command.a).is_ok_and(|attribute| attribute == resource)
    });
    if !bindings.single_request_counts.is_empty() && modified {
        return Err(ContentError::UnsupportedLayout(
            "an effect changes the starting villagers".to_owned(),
        ));
    }
    Ok(())
}

fn civilization_attribute_values(
    document: &DatDocument,
    attributes: &BTreeSet<u32>,
) -> Result<Vec<CivilizationAttributeValue>, ContentError> {
    let mut values = Vec::new();
    for (civilization, table) in document.civilizations.iter().enumerate() {
        for &attribute in attributes {
            let bits = table
                .resource_bits
                .get(attribute as usize)
                .copied()
                .ok_or(ContentError::InvalidField("civilization attribute"))?;
            if !f32::from_bits(bits).is_finite() {
                return Err(ContentError::InvalidField("civilization attribute"));
            }
            values.push(CivilizationAttributeValue {
                civilization_id: CivilizationId(civilization as u32),
                attribute_id: PlayerAttributeId(attribute),
                value_f32_bits: bits,
            });
        }
    }
    Ok(values)
}

fn technology_state_rules(
    document: &DatDocument,
    technologies: &BTreeSet<u16>,
) -> Result<Vec<TechnologyStateRule>, ContentError> {
    let disabled_by_tree = document
        .civilizations
        .iter()
        .map(|table| {
            usize::try_from(table.technology_tree_effect)
                .ok()
                .and_then(|effect| document.effects.get(effect))
                .map(|commands| {
                    commands
                        .iter()
                        .filter(|command| command.kind == 102)
                        .filter_map(|command| {
                            let value = f32::from_bits(command.d_bits);
                            ((0.0..=f32::from(u16::MAX)).contains(&value) && value.fract() == 0.0)
                                .then_some(value as u16)
                        })
                        .collect::<BTreeSet<u16>>()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let mut rules = Vec::new();
    for &technology_id in technologies {
        let technology = document
            .technologies
            .get(usize::from(technology_id))
            .ok_or(ContentError::DanglingReference("gate technology"))?;
        let mut required_technology_ids = technology
            .required_technologies
            .iter()
            .filter(|id| **id >= 0)
            .map(|id| *id as u16)
            .collect::<Vec<_>>();
        required_technology_ids.sort_unstable();
        required_technology_ids.dedup();
        let required_count = u8::try_from(technology.required_count)
            .ok()
            .filter(|count| usize::from(*count) <= required_technology_ids.len())
            .ok_or(ContentError::InvalidField("gate technology requirements"))?;
        let mut disabled_civilization_ids = Vec::new();
        let mut researched_civilization_ids = Vec::new();
        for (civilization, disabled) in disabled_by_tree.iter().enumerate() {
            let foreign = technology.civilization >= 0
                && usize::try_from(technology.civilization).ok() != Some(civilization);
            let civilization_id = CivilizationId(civilization as u32);
            if foreign || disabled.contains(&technology_id) {
                disabled_civilization_ids.push(civilization_id);
            } else if is_automatic(technology) && technology.required_count == 0 {
                researched_civilization_ids.push(civilization_id);
            }
        }
        rules.push(TechnologyStateRule {
            technology_id,
            required_technology_ids,
            required_count,
            disabled_civilization_ids,
            researched_civilization_ids,
        });
    }
    Ok(rules)
}

fn civilization_object_attributes(
    document: &DatDocument,
    attributes: &BTreeSet<u32>,
    emitted: &BTreeSet<ObjectId>,
) -> Result<Vec<CivilizationObjectAttributeValue>, ContentError> {
    let mut values = Vec::new();
    for (civilization, table) in document.civilizations.iter().enumerate() {
        for &attribute in attributes {
            let bits = table
                .resource_bits
                .get(attribute as usize)
                .copied()
                .ok_or(ContentError::InvalidField("civilization object attribute"))?;
            let value = f32::from_bits(bits);
            if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u32::MAX as f32
            {
                return Err(ContentError::InvalidField("civilization object attribute"));
            }
            let object_id = ObjectId(value as u32);
            if !emitted.contains(&object_id) {
                return Err(ContentError::DanglingReference(
                    "civilization object attribute value",
                ));
            }
            values.push(CivilizationObjectAttributeValue {
                civilization_id: CivilizationId(civilization as u32),
                attribute_id: PlayerAttributeId(attribute),
                object_id,
            });
        }
    }
    Ok(values)
}

struct TechnologyTables {
    initial_automatic_technology_ids: Vec<u16>,
    building_technology_triggers: Vec<BuildingTechnologyTrigger>,
    automatic_spawn_technologies: Vec<AutomaticSpawnTechnology>,
    setup_dependent_spawn_technologies: Vec<AutomaticSpawnTechnology>,
}

fn is_automatic(technology: &DatTechnology) -> bool {
    technology
        .research_locations
        .iter()
        .all(|location| location.location_unit_id == -1 && location.research_time == 0)
}

fn technology_tables(
    document: &DatDocument,
    emitted: &BTreeSet<ObjectId>,
) -> Result<TechnologyTables, ContentError> {
    let technology_id = |index: usize| {
        u16::try_from(index).map_err(|_| ContentError::InvalidField("technology identity"))
    };
    let mut initial_automatic_technology_ids = Vec::new();
    let mut automatic_spawn_technologies = Vec::new();
    for (index, technology) in document.technologies.iter().enumerate() {
        if !is_automatic(technology) {
            continue;
        }
        let required = technology
            .required_technologies
            .iter()
            .take(usize::try_from(technology.required_count).unwrap_or(0))
            .filter(|required| **required >= 0)
            .map(|required| *required as u16)
            .collect::<Vec<_>>();
        if technology.required_count == 0 && technology.civilization == -1 {
            initial_automatic_technology_ids.push(technology_id(index)?);
        }
        let Ok(effect) = usize::try_from(technology.effect_id) else {
            continue;
        };
        let commands = document
            .effects
            .get(effect)
            .ok_or(ContentError::DanglingReference("technology effect"))?
            .iter()
            .filter(|command| command.kind == 7)
            .map(|command| {
                if command.c <= 0 || f32::from_bits(command.d_bits) != 0.0 {
                    return Err(ContentError::InvalidField("spawn command"));
                }
                let spawned = ObjectId(
                    u32::try_from(command.a).map_err(|_| ContentError::InvalidField("spawn"))?,
                );
                let building = ObjectId(
                    u32::try_from(command.b).map_err(|_| ContentError::InvalidField("spawn"))?,
                );
                if !emitted.contains(&spawned) || !emitted.contains(&building) {
                    return Err(ContentError::DanglingReference("spawn command object"));
                }
                Ok(BuildingSpawnCommand {
                    spawned_object_id: spawned,
                    building_object_id: building,
                    count: command.c as u16,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if commands.is_empty() {
            continue;
        }
        let civilization_id = match technology.civilization {
            -1 => None,
            civilization => Some(CivilizationId(
                u32::try_from(civilization)
                    .ok()
                    .filter(|civilization| (*civilization as usize) < document.civilizations.len())
                    .ok_or(ContentError::InvalidField("technology civilization"))?,
            )),
        };
        if required.is_empty() || required.len() != technology.required_count as usize {
            continue;
        }
        automatic_spawn_technologies.push(AutomaticSpawnTechnology {
            technology_id: technology_id(index)?,
            civilization_id,
            required_technology_ids: required,
            commands,
        });
    }
    let mut building_technology_triggers = Vec::new();
    for (civilization, table) in document.civilizations.iter().enumerate() {
        for (slot, master) in table.masters.iter().enumerate() {
            let Some(building) = master.as_ref().and_then(|master| master.building.as_ref()) else {
                continue;
            };
            let object_id = ObjectId(slot as u32);
            if building.technology_id < 0 || !emitted.contains(&object_id) {
                continue;
            }
            building_technology_triggers.push(BuildingTechnologyTrigger {
                civilization_id: CivilizationId(civilization as u32),
                object_id,
                technology_id: building.technology_id as u16,
            });
        }
    }
    let researchable = initial_automatic_technology_ids
        .iter()
        .copied()
        .chain(
            building_technology_triggers
                .iter()
                .map(|trigger| trigger.technology_id),
        )
        .collect::<BTreeSet<_>>();
    automatic_spawn_technologies.retain(|technology: &AutomaticSpawnTechnology| {
        !researchable.contains(&technology.technology_id)
    });
    if automatic_spawn_technologies.len() > MAXIMUM_SPAWN_TECHNOLOGY_CANDIDATES {
        return Err(ContentError::ResourceLimit("automatic spawn technologies"));
    }
    let mut setup_dependent_spawn_technologies = Vec::new();
    loop {
        let before = automatic_spawn_technologies.len();
        let reachable = researchable
            .iter()
            .copied()
            .chain(
                automatic_spawn_technologies
                    .iter()
                    .map(|technology| technology.technology_id),
            )
            .collect::<BTreeSet<_>>();
        let (retained, unreached): (Vec<_>, Vec<_>) = automatic_spawn_technologies
            .into_iter()
            .partition(|technology| {
                technology
                    .required_technology_ids
                    .iter()
                    .all(|id| reachable.contains(id) && *id != technology.technology_id)
            });
        automatic_spawn_technologies = retained;
        setup_dependent_spawn_technologies.extend(unreached);
        if automatic_spawn_technologies.len() == before {
            break;
        }
    }
    initial_automatic_technology_ids.sort_unstable();
    setup_dependent_spawn_technologies.sort_by_key(|technology| technology.technology_id);
    Ok(TechnologyTables {
        initial_automatic_technology_ids,
        building_technology_triggers,
        automatic_spawn_technologies,
        setup_dependent_spawn_technologies,
    })
}
