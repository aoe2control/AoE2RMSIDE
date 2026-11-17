use std::collections::{BTreeMap, BTreeSet};

use rms_content::{
    BUILDING_CONSTRUCTOR_TYPE, CivilizationId, CompatibleContentView, ObjectId, StartSight,
    StartSightAge, StartSightEffect, StartSightOperationKind, StartSightRoute,
};
use rms_semantics::SemanticOperation;

use crate::{
    GameMode, GeneratedMap, MapDimensions, PlacedObject, PlayerConfiguration,
    ResolvedGenerationInput, SetupContext, StartingAge,
};

pub const START_VISION_GAIA_BIT: u16 = 1;
pub const START_VISION_MAXIMUM_SLOT: u8 = 8;
pub const START_VISION_MERGES_ALLIES: bool = false;
const MAXIMUM_SIGHT_RADIUS: i32 = 20;
const ACTIVE_OBJECT_STATUS: i32 = 2;
const SIGHT_SHARING_RESOURCES: [i64; 5] = [50, 366, 418, 570, 572];
const CLASS_TARGET_BASE: i64 = 900;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartVisionUnavailable {
    TechnologyState,
    StartingAge,
    GameMode,
    ScriptEffect,
    UnknownObject,
    ConstructionState,
    Dimensions,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SightShape {
    TileCentred,
    CornerCentred,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SightConstruction {
    Finished,
    UnderConstruction,
    Unstarted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SightSource {
    pub x_256: u32,
    pub y_256: u32,
    pub owner: u8,
    pub line_of_sight: f32,
    pub building: bool,
    pub collision_half_extents: [f32; 2],
    pub construction: SightConstruction,
}

impl SightSource {
    pub fn radius(&self) -> i32 {
        (self.line_of_sight as i32).min(MAXIMUM_SIGHT_RADIUS)
    }

    pub fn shape(&self) -> SightShape {
        let sum = self.collision_half_extents[0] + self.collision_half_extents[1];
        if self.building
            && self.construction == SightConstruction::Finished
            && (sum as i32) % 2 == 0
        {
            SightShape::CornerCentred
        } else {
            SightShape::TileCentred
        }
    }
}

pub fn reveal_start_sight(
    dimensions: MapDimensions,
    sources: &[SightSource],
) -> Result<Vec<u16>, StartVisionUnavailable> {
    let tiles = dimensions
        .tile_count()
        .map_err(|_| StartVisionUnavailable::Dimensions)?;
    let width = i32::from(dimensions.width);
    let height = i32::from(dimensions.height);
    let mut bits = vec![0_u16; tiles];
    for source in sources {
        if source.owner > START_VISION_MAXIMUM_SLOT {
            return Err(StartVisionUnavailable::UnknownObject);
        }
        let bit = 1_u16 << source.owner;
        let x = source.x_256 as f32 / 256.0;
        let y = source.y_256 as f32 / 256.0;
        let mut mark = |row: i32, first: i32, last: i32| {
            if !(0..height).contains(&row) {
                return;
            }
            let first = first.clamp(0, width - 1);
            let last = last.clamp(0, width - 1);
            let start = (row * width) as usize;
            for column in first..=last {
                bits[start + column as usize] |= bit;
            }
        };
        match source.construction {
            SightConstruction::Unstarted if source.building => continue,
            SightConstruction::UnderConstruction if source.building => {
                let [half_width, half_height] = source.collision_half_extents;
                let first_column = (x - half_width) as i32;
                let first_row = (y - half_height) as i32;
                let last_column = (x + half_width - 0.01) as i32;
                let last_row = (y + half_height - 0.01) as i32;
                if last_column < 0 || first_column >= width {
                    continue;
                }
                for row in first_row..=last_row {
                    mark(row, first_column, last_column);
                }
                continue;
            }
            _ => {}
        }
        let radius = source.radius();
        if radius <= 0 {
            continue;
        }
        let rows = match source.shape() {
            SightShape::TileCentred => TILE_CENTRED_ROWS[radius as usize],
            SightShape::CornerCentred => CORNER_CENTRED_ROWS[radius as usize],
        };
        let (centre_x, centre_y) = (x as i32, y as i32);
        for &[dy, first, last] in rows {
            mark(
                centre_y + i32::from(dy),
                centre_x + i32::from(first),
                centre_x + i32::from(last),
            );
        }
    }
    Ok(bits)
}

fn start_age(setup: &SetupContext) -> Result<StartSightAge, StartVisionUnavailable> {
    if setup.lobby_options.changes_technology_state() {
        return Err(StartVisionUnavailable::TechnologyState);
    }
    if setup.game_mode == GameMode::CaptureTheRelic {
        return Err(StartVisionUnavailable::GameMode);
    }
    match setup.starting_age {
        StartingAge::Standard => match setup.game_mode {
            GameMode::DeathMatch | GameMode::BattleRoyale | GameMode::EmpireWars => {
                Err(StartVisionUnavailable::StartingAge)
            }
            _ => Ok(StartSightAge::Dark),
        },
        StartingAge::DarkAge => Ok(StartSightAge::Dark),
        StartingAge::FeudalAge => Ok(StartSightAge::Feudal),
        StartingAge::CastleAge => Ok(StartSightAge::Castle),
        StartingAge::ImperialAge => Ok(StartSightAge::Imperial),
        StartingAge::PostImperialAge => Err(StartVisionUnavailable::StartingAge),
    }
}

fn integer_argument(operation: &SemanticOperation, index: usize) -> Option<i64> {
    let value = operation.arguments.get(index)?.value.parse::<f32>().ok()?;
    (value.is_finite() && value.abs() < 2_147_483_648.0).then(|| value.trunc() as i64)
}

fn object_argument(operation: &SemanticOperation, index: usize) -> Option<u32> {
    integer_argument(operation, index).and_then(|value| u32::try_from(value).ok())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ScriptSightEffect {
    Attribute {
        gaia_only: bool,
        target: u32,
        attribute: SightAttribute,
        kind: StartSightOperationKind,
        value: f32,
    },
    Upgrade {
        gaia_only: bool,
        object: ObjectId,
        target: ObjectId,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SightAttribute {
    LineOfSight,
    Radius(usize),
}

fn finishes_by_hit_points(object: ObjectId, content: CompatibleContentView<'_>) -> bool {
    content.object(object).is_none_or(|definition| {
        definition.constructor_type != Some(BUILDING_CONSTRUCTOR_TYPE)
            || definition
                .hit_points
                .is_some_and(|hit_points| hit_points >= 1)
    })
}

fn script_sight_effects(
    operations: &[SemanticOperation],
    content: CompatibleContentView<'_>,
) -> Option<Vec<ScriptSightEffect>> {
    let named = |names: &[&str]| -> Vec<i64> {
        names
            .iter()
            .filter_map(|name| content.rms_implicit_definition(name).map(i64::from))
            .collect()
    };
    let definition = |name: &str| content.rms_implicit_definition(name).map(i64::from);
    let attribute_effects = [
        ("SET_ATTRIBUTE", false, StartSightOperationKind::Set),
        ("GAIA_SET_ATTRIBUTE", true, StartSightOperationKind::Set),
        ("ADD_ATTRIBUTE", false, StartSightOperationKind::Add),
        ("GAIA_ADD_ATTRIBUTE", true, StartSightOperationKind::Add),
        ("MUL_ATTRIBUTE", false, StartSightOperationKind::Multiply),
        (
            "GAIA_MUL_ATTRIBUTE",
            true,
            StartSightOperationKind::Multiply,
        ),
    ]
    .into_iter()
    .filter_map(|(name, gaia_only, kind)| Some((definition(name)?, gaia_only, kind)))
    .collect::<Vec<_>>();
    let upgrade_effects = [("UPGRADE_UNIT", false), ("GAIA_UPGRADE_UNIT", true)]
        .into_iter()
        .filter_map(|(name, gaia_only)| Some((definition(name)?, gaia_only)))
        .collect::<Vec<_>>();
    let resource_effects = named(&[
        "MOD_RESOURCE",
        "GAIA_MOD_RESOURCE",
        "MUL_RESOURCE",
        "GAIA_MUL_RESOURCE",
    ]);
    let neutral_effects = named(&[
        "ENABLE_OBJECT",
        "GAIA_ENABLE_OBJECT",
        "SET_TECH_COST",
        "GAIA_SET_TECH_COST",
        "ADD_TECH_COST",
        "GAIA_ADD_TECH_COST",
    ]);
    let line_of_sight = definition("ATTR_LINE_OF_SIGHT")?;
    let radii = named(&["ATTR_RADIUS_1", "ATTR_RADIUS_2"]);
    let hit_points = definition("ATTR_HITPOINTS")?;
    if radii.len() != 2 || attribute_effects.len() != 6 || upgrade_effects.len() != 2 {
        return None;
    }
    let mut effects = Vec::new();
    for operation in operations {
        if operation.name == "#includeXS" {
            return None;
        }
        if !operation.accepted_by_target_parser()
            || !matches!(operation.name.as_str(), "effect_amount" | "effect_percent")
        {
            continue;
        }
        let effect = integer_argument(operation, 0)?;
        let target = integer_argument(operation, 1)?;
        if neutral_effects.contains(&effect) {
            continue;
        }
        if resource_effects.contains(&effect) {
            if SIGHT_SHARING_RESOURCES.contains(&target) {
                return None;
            }
            continue;
        }
        if let Some(&(_, gaia_only)) = upgrade_effects.iter().find(|(id, _)| *id == effect) {
            let object = ObjectId(object_argument(operation, 1)?);
            let replacement = ObjectId(object_argument(operation, 2)?);
            let (Some(source), Some(copied)) =
                (content.object(object), content.object(replacement))
            else {
                continue;
            };
            match (source.constructor_type, copied.constructor_type) {
                (Some(source), Some(copied)) if source != copied => continue,
                (Some(_), Some(_)) => {}
                _ => return None,
            }
            if !finishes_by_hit_points(object, content)
                || !finishes_by_hit_points(replacement, content)
            {
                return None;
            }
            effects.push(ScriptSightEffect::Upgrade {
                gaia_only,
                object,
                target: replacement,
            });
            continue;
        }
        let &(_, gaia_only, kind) = attribute_effects.iter().find(|(id, ..)| *id == effect)?;
        let attribute = integer_argument(operation, 2)?;
        if attribute == hit_points {
            let unit = target < CLASS_TARGET_BASE
                && u32::try_from(target)
                    .ok()
                    .and_then(|id| content.object(ObjectId(id)))
                    .is_some_and(|definition| {
                        definition.constructor_type != Some(BUILDING_CONSTRUCTOR_TYPE)
                    });
            if !unit {
                return None;
            }
            continue;
        }
        let attribute = if attribute == line_of_sight {
            SightAttribute::LineOfSight
        } else if let Some(axis) = radii.iter().position(|id| *id == attribute) {
            SightAttribute::Radius(axis)
        } else {
            continue;
        };
        let value = operation.arguments.get(3)?.value.parse::<f32>().ok()?;
        let value = if operation.name == "effect_percent" {
            value / 100.0
        } else {
            value
        };
        if !value.is_finite() {
            return None;
        }
        effects.push(ScriptSightEffect::Attribute {
            gaia_only,
            target: u32::try_from(target).ok()?,
            attribute,
            kind,
            value,
        });
    }
    Some(effects)
}

pub fn script_keeps_start_sight(
    operations: &[SemanticOperation],
    content: CompatibleContentView<'_>,
) -> bool {
    script_sight_effects(operations, content).is_some()
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SightSlot {
    master: ObjectId,
    line_of_sight: Option<f32>,
    half_extents: Option<[f32; 2]>,
}

fn apply_operation(kind: StartSightOperationKind, current: Option<f32>, value: f32) -> Option<f32> {
    match kind {
        StartSightOperationKind::Set => Some(value),
        StartSightOperationKind::Add => current.map(|current| current + value),
        StartSightOperationKind::Multiply => current.map(|current| current * value),
    }
}

fn owner_slots(
    start: &PlayerStart<'_>,
    gaia: bool,
    tracked: &BTreeSet<ObjectId>,
    effects: &[ScriptSightEffect],
    sight: &StartSight,
    content: CompatibleContentView<'_>,
) -> BTreeMap<ObjectId, SightSlot> {
    let mut slots = tracked
        .iter()
        .map(|&id| {
            let master = start.effective_master(id);
            let definition = content.object(master);
            let line_of_sight = definition
                .and_then(|definition| start.line_of_sight(master, definition.class_id, sight));
            (
                id,
                SightSlot {
                    master,
                    line_of_sight,
                    half_extents: definition.map(|definition| definition.collision_half_extents()),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    for effect in effects {
        match *effect {
            ScriptSightEffect::Attribute {
                gaia_only,
                target,
                attribute,
                kind,
                value,
            } => {
                if gaia_only && !gaia {
                    continue;
                }
                let class = target
                    .checked_sub(CLASS_TARGET_BASE as u32)
                    .filter(|class| *class < 100);
                for (id, slot) in &mut slots {
                    let addressed = match class {
                        Some(class) => content
                            .object(slot.master)
                            .is_some_and(|definition| definition.class_id == class),
                        None => id.0 == target,
                    };
                    if !addressed {
                        continue;
                    }
                    match attribute {
                        SightAttribute::LineOfSight => {
                            slot.line_of_sight = apply_operation(kind, slot.line_of_sight, value);
                        }
                        SightAttribute::Radius(axis) => {
                            slot.half_extents = slot.half_extents.and_then(|mut extents| {
                                extents[axis] = apply_operation(kind, Some(extents[axis]), value)?;
                                Some(extents)
                            });
                        }
                    }
                }
            }
            ScriptSightEffect::Upgrade {
                gaia_only,
                object,
                target,
            } => {
                if gaia_only && !gaia {
                    continue;
                }
                if let Some(copy) = slots.get(&target).copied()
                    && let Some(slot) = slots.get_mut(&object)
                {
                    *slot = copy;
                }
            }
        }
    }
    slots
}

struct PlayerStart<'a> {
    civilization: CivilizationId,
    effects: Vec<&'a StartSightEffect>,
}

impl<'a> PlayerStart<'a> {
    fn new(
        player: &PlayerConfiguration,
        players: &[PlayerConfiguration],
        age: StartSightAge,
        sight: &'a StartSight,
    ) -> Self {
        let teammates = players
            .iter()
            .filter(|other| {
                other.slot == player.slot || (player.team != 0 && other.team == player.team)
            })
            .map(|other| other.civilization_id)
            .collect::<Vec<_>>();
        let effects = sight
            .technology_effects
            .iter()
            .filter(|effect| match effect.route {
                StartSightRoute::Own => {
                    effect.names_civilization(player.civilization_id) && effect.required_age <= age
                }
                StartSightRoute::Team => teammates
                    .iter()
                    .any(|&civilization| effect.names_civilization(civilization)),
            })
            .collect();
        Self {
            civilization: player.civilization_id,
            effects,
        }
    }

    fn gaia() -> Self {
        Self {
            civilization: CivilizationId(0),
            effects: Vec::new(),
        }
    }

    fn effective_master(&self, object_id: ObjectId) -> ObjectId {
        let mut current = object_id;
        for upgrade in self.effects.iter().flat_map(|effect| &effect.upgrades) {
            if upgrade.object_id == current {
                current = upgrade.target_object_id;
            }
        }
        current
    }

    fn line_of_sight(&self, object_id: ObjectId, class_id: u32, sight: &StartSight) -> Option<f32> {
        let mut value = sight.line_of_sight(object_id, self.civilization)?;
        for operation in self.effects.iter().flat_map(|effect| &effect.operations) {
            if operation.addresses(object_id, class_id) {
                value = operation.apply(value);
            }
        }
        Some(value)
    }
}

fn construction(
    object: &PlacedObject,
    content: CompatibleContentView<'_>,
) -> Result<SightConstruction, StartVisionUnavailable> {
    let definition = content
        .object(object.object_id)
        .ok_or(StartVisionUnavailable::UnknownObject)?;
    if definition.constructor_type != Some(BUILDING_CONSTRUCTOR_TYPE) {
        return Ok(SightConstruction::Finished);
    }
    let hit_points = definition
        .hit_points
        .ok_or(StartVisionUnavailable::ConstructionState)?;
    if hit_points >= 1 {
        return Ok(SightConstruction::Finished);
    }
    let exemptions = content
        .native_generation_bindings()
        .and_then(|bindings| bindings.construction_site_exemptions.as_ref())
        .ok_or(StartVisionUnavailable::ConstructionState)?;
    let facts = definition
        .building_construction
        .ok_or(StartVisionUnavailable::ConstructionState)?;
    Ok(
        if exemptions.starts_as_construction_site(definition.id, definition.class_id, facts) {
            SightConstruction::Finished
        } else {
            SightConstruction::Unstarted
        },
    )
}

pub fn start_vision(
    input: &ResolvedGenerationInput<'_>,
    map: &GeneratedMap,
    sight: &StartSight,
) -> Result<Vec<u16>, StartVisionUnavailable> {
    let age = start_age(&input.request.setup_context)?;
    if !input.semantic_program.external_dependencies.is_empty() {
        return Err(StartVisionUnavailable::ScriptEffect);
    }
    let effects = script_sight_effects(&input.semantic_program.operations, input.content)
        .ok_or(StartVisionUnavailable::ScriptEffect)?;
    let players = &input.request.players;
    if players
        .iter()
        .any(|player| player.slot == 0 || player.slot > START_VISION_MAXIMUM_SLOT)
    {
        return Err(StartVisionUnavailable::UnknownObject);
    }
    let active = map
        .objects
        .iter()
        .filter(|object| object.status == ACTIVE_OBJECT_STATUS)
        .collect::<Vec<_>>();
    let mut tracked = active
        .iter()
        .map(|object| object.object_id)
        .collect::<BTreeSet<_>>();
    tracked.extend(effects.iter().filter_map(|effect| match *effect {
        ScriptSightEffect::Upgrade { target, .. } => Some(target),
        ScriptSightEffect::Attribute { .. } => None,
    }));
    let slots_of = |start: &PlayerStart<'_>, gaia: bool| {
        owner_slots(start, gaia, &tracked, &effects, sight, input.content)
    };
    let owners = std::iter::once((0, slots_of(&PlayerStart::gaia(), true)))
        .chain(players.iter().map(|player| {
            let start = PlayerStart::new(player, players, age, sight);
            (player.slot, slots_of(&start, false))
        }))
        .collect::<Vec<_>>();
    let mut sources = Vec::new();
    for object in active {
        let slot = owners
            .iter()
            .find(|(owner, _)| *owner == object.owner)
            .and_then(|(_, slots)| slots.get(&object.object_id))
            .ok_or(StartVisionUnavailable::UnknownObject)?;
        let construction = construction(object, input.content)?;
        let master = input
            .content
            .object(slot.master)
            .ok_or(StartVisionUnavailable::UnknownObject)?;
        let line_of_sight = slot
            .line_of_sight
            .ok_or(StartVisionUnavailable::UnknownObject)?;
        let collision_half_extents = slot
            .half_extents
            .filter(|extents| {
                extents
                    .iter()
                    .all(|extent| extent.is_finite() && *extent >= 0.0)
            })
            .ok_or(StartVisionUnavailable::UnknownObject)?;
        sources.push(SightSource {
            x_256: object.x_256,
            y_256: object.y_256,
            owner: object.owner,
            line_of_sight,
            building: master.constructor_type == Some(BUILDING_CONSTRUCTOR_TYPE),
            collision_half_extents,
            construction,
        });
    }
    reveal_start_sight(map.dimensions, &sources)
}

#[rustfmt::skip]
const TILE_CENTRED_ROWS: [&[[i8; 3]]; 21] = [
    &[[0, 0, 0]],
    &[[-1, -1, 1], [0, -1, 1], [1, -1, 1]],
    &[[-2, -1, 1], [-1, -2, 2], [0, -2, 2], [1, -2, 2], [2, -1, 1]],
    &[[-3, -1, 1], [-2, -2, 2], [-1, -3, 3], [0, -3, 3], [1, -3, 3], [2, -2, 2], [3, -1, 1]],
    &[
        [-4, -1, 1], [-3, -3, 3], [-2, -3, 3], [-1, -4, 4], [0, -4, 4], [1, -4, 4], [2, -3, 3],
        [3, -3, 3], [4, -1, 1],
    ],
    &[
        [-5, -2, 2], [-4, -3, 3], [-3, -4, 4], [-2, -5, 5], [-1, -5, 5], [0, -5, 5], [1, -5, 5],
        [2, -5, 5], [3, -4, 4], [4, -3, 3], [5, -2, 2],
    ],
    &[
        [-6, -2, 2], [-5, -4, 4], [-4, -5, 5], [-3, -5, 5], [-2, -6, 6], [-1, -6, 6], [0, -6, 6],
        [1, -6, 6], [2, -6, 6], [3, -5, 5], [4, -5, 5], [5, -4, 4], [6, -2, 2],
    ],
    &[
        [-7, -2, 2], [-6, -4, 4], [-5, -5, 5], [-4, -6, 6], [-3, -6, 6], [-2, -7, 7], [-1, -7, 7],
        [0, -7, 7], [1, -7, 7], [2, -7, 7], [3, -6, 6], [4, -6, 6], [5, -5, 5], [6, -4, 4],
        [7, -2, 2],
    ],
    &[
        [-8, -2, 2], [-7, -4, 4], [-6, -5, 5], [-5, -6, 6], [-4, -7, 7], [-3, -7, 7], [-2, -8, 8],
        [-1, -8, 8], [0, -8, 8], [1, -8, 8], [2, -8, 8], [3, -7, 7], [4, -7, 7], [5, -6, 6],
        [6, -5, 5], [7, -4, 4], [8, -2, 2],
    ],
    &[
        [-9, -2, 2], [-8, -5, 5], [-7, -6, 6], [-6, -7, 7], [-5, -8, 8], [-4, -8, 8], [-3, -8, 8],
        [-2, -9, 9], [-1, -9, 9], [0, -9, 9], [1, -9, 9], [2, -9, 9], [3, -8, 8], [4, -8, 8],
        [5, -8, 8], [6, -7, 7], [7, -6, 6], [8, -5, 5], [9, -2, 2],
    ],
    &[
        [-10, -3, 3], [-9, -5, 5], [-8, -6, 6], [-7, -7, 7], [-6, -8, 8], [-5, -9, 9], [-4, -9, 9],
        [-3, -10, 10], [-2, -10, 10], [-1, -10, 10], [0, -10, 10], [1, -10, 10], [2, -10, 10],
        [3, -10, 10], [4, -9, 9], [5, -9, 9], [6, -8, 8], [7, -7, 7], [8, -6, 6], [9, -5, 5],
        [10, -3, 3],
    ],
    &[
        [-11, -3, 3], [-10, -5, 5], [-9, -7, 7], [-8, -8, 8], [-7, -9, 9], [-6, -9, 9],
        [-5, -10, 10], [-4, -10, 10], [-3, -11, 11], [-2, -11, 11], [-1, -11, 11], [0, -11, 11],
        [1, -11, 11], [2, -11, 11], [3, -11, 11], [4, -10, 10], [5, -10, 10], [6, -9, 9],
        [7, -9, 9], [8, -8, 8], [9, -7, 7], [10, -5, 5], [11, -3, 3],
    ],
    &[
        [-12, -3, 3], [-11, -5, 5], [-10, -7, 7], [-9, -8, 8], [-8, -9, 9], [-7, -10, 10],
        [-6, -10, 10], [-5, -11, 11], [-4, -11, 11], [-3, -12, 12], [-2, -12, 12], [-1, -12, 12],
        [0, -12, 12], [1, -12, 12], [2, -12, 12], [3, -12, 12], [4, -11, 11], [5, -11, 11],
        [6, -10, 10], [7, -10, 10], [8, -9, 9], [9, -8, 8], [10, -7, 7], [11, -5, 5], [12, -3, 3],
    ],
    &[
        [-13, -3, 3], [-12, -6, 6], [-11, -7, 7], [-10, -8, 8], [-9, -9, 9], [-8, -10, 10],
        [-7, -11, 11], [-6, -12, 12], [-5, -12, 12], [-4, -12, 12], [-3, -13, 13], [-2, -13, 13],
        [-1, -13, 13], [0, -13, 13], [1, -13, 13], [2, -13, 13], [3, -13, 13], [4, -12, 12],
        [5, -12, 12], [6, -12, 12], [7, -11, 11], [8, -10, 10], [9, -9, 9], [10, -8, 8],
        [11, -7, 7], [12, -6, 6], [13, -3, 3],
    ],
    &[
        [-14, -3, 3], [-13, -6, 6], [-12, -8, 8], [-11, -9, 9], [-10, -10, 10], [-9, -11, 11],
        [-8, -12, 12], [-7, -12, 12], [-6, -13, 13], [-5, -13, 13], [-4, -13, 13], [-3, -14, 14],
        [-2, -14, 14], [-1, -14, 14], [0, -14, 14], [1, -14, 14], [2, -14, 14], [3, -14, 14],
        [4, -13, 13], [5, -13, 13], [6, -13, 13], [7, -12, 12], [8, -12, 12], [9, -11, 11],
        [10, -10, 10], [11, -9, 9], [12, -8, 8], [13, -6, 6], [14, -3, 3],
    ],
    &[
        [-15, -3, 3], [-14, -6, 6], [-13, -8, 8], [-12, -9, 9], [-11, -10, 10], [-10, -11, 11],
        [-9, -12, 12], [-8, -13, 13], [-7, -13, 13], [-6, -14, 14], [-5, -14, 14], [-4, -14, 14],
        [-3, -15, 15], [-2, -15, 15], [-1, -15, 15], [0, -15, 15], [1, -15, 15], [2, -15, 15],
        [3, -15, 15], [4, -14, 14], [5, -14, 14], [6, -14, 14], [7, -13, 13], [8, -13, 13],
        [9, -12, 12], [10, -11, 11], [11, -10, 10], [12, -9, 9], [13, -8, 8], [14, -6, 6],
        [15, -3, 3],
    ],
    &[
        [-16, -3, 3], [-15, -6, 6], [-14, -8, 8], [-13, -10, 10], [-12, -11, 11], [-11, -12, 12],
        [-10, -13, 13], [-9, -13, 13], [-8, -14, 14], [-7, -14, 14], [-6, -15, 15], [-5, -15, 15],
        [-4, -15, 15], [-3, -16, 16], [-2, -16, 16], [-1, -16, 16], [0, -16, 16], [1, -16, 16],
        [2, -16, 16], [3, -16, 16], [4, -15, 15], [5, -15, 15], [6, -15, 15], [7, -14, 14],
        [8, -14, 14], [9, -13, 13], [10, -13, 13], [11, -12, 12], [12, -11, 11], [13, -10, 10],
        [14, -8, 8], [15, -6, 6], [16, -3, 3],
    ],
    &[
        [-17, -3, 3], [-16, -6, 6], [-15, -8, 8], [-14, -10, 10], [-13, -11, 11], [-12, -12, 12],
        [-11, -13, 13], [-10, -14, 14], [-9, -14, 14], [-8, -15, 15], [-7, -15, 15], [-6, -16, 16],
        [-5, -16, 16], [-4, -16, 16], [-3, -17, 17], [-2, -17, 17], [-1, -17, 17], [0, -17, 17],
        [1, -17, 17], [2, -17, 17], [3, -17, 17], [4, -16, 16], [5, -16, 16], [6, -16, 16],
        [7, -15, 15], [8, -15, 15], [9, -14, 14], [10, -14, 14], [11, -13, 13], [12, -12, 12],
        [13, -11, 11], [14, -10, 10], [15, -8, 8], [16, -6, 6], [17, -3, 3],
    ],
    &[
        [-18, -4, 4], [-17, -7, 7], [-16, -9, 9], [-15, -10, 10], [-14, -12, 12], [-13, -13, 13],
        [-12, -14, 14], [-11, -14, 14], [-10, -15, 15], [-9, -16, 16], [-8, -16, 16], [-7, -17, 17],
        [-6, -17, 17], [-5, -17, 17], [-4, -18, 18], [-3, -18, 18], [-2, -18, 18], [-1, -18, 18],
        [0, -18, 18], [1, -18, 18], [2, -18, 18], [3, -18, 18], [4, -18, 18], [5, -17, 17],
        [6, -17, 17], [7, -17, 17], [8, -16, 16], [9, -16, 16], [10, -15, 15], [11, -14, 14],
        [12, -14, 14], [13, -13, 13], [14, -12, 12], [15, -10, 10], [16, -9, 9], [17, -7, 7],
        [18, -4, 4],
    ],
    &[
        [-19, -4, 4], [-18, -7, 7], [-17, -9, 9], [-16, -11, 11], [-15, -12, 12], [-14, -13, 13],
        [-13, -14, 14], [-12, -15, 15], [-11, -16, 16], [-10, -16, 16], [-9, -17, 17],
        [-8, -17, 17], [-7, -18, 18], [-6, -18, 18], [-5, -18, 18], [-4, -19, 19], [-3, -19, 19],
        [-2, -19, 19], [-1, -19, 19], [0, -19, 19], [1, -19, 19], [2, -19, 19], [3, -19, 19],
        [4, -19, 19], [5, -18, 18], [6, -18, 18], [7, -18, 18], [8, -17, 17], [9, -17, 17],
        [10, -16, 16], [11, -16, 16], [12, -15, 15], [13, -14, 14], [14, -13, 13], [15, -12, 12],
        [16, -11, 11], [17, -9, 9], [18, -7, 7], [19, -4, 4],
    ],
    &[
        [-20, -4, 4], [-19, -7, 7], [-18, -9, 9], [-17, -11, 11], [-16, -12, 12], [-15, -13, 13],
        [-14, -14, 14], [-13, -15, 15], [-12, -16, 16], [-11, -17, 17], [-10, -17, 17],
        [-9, -18, 18], [-8, -18, 18], [-7, -19, 19], [-6, -19, 19], [-5, -19, 19], [-4, -20, 20],
        [-3, -20, 20], [-2, -20, 20], [-1, -20, 20], [0, -20, 20], [1, -20, 20], [2, -20, 20],
        [3, -20, 20], [4, -20, 20], [5, -19, 19], [6, -19, 19], [7, -19, 19], [8, -18, 18],
        [9, -18, 18], [10, -17, 17], [11, -17, 17], [12, -16, 16], [13, -15, 15], [14, -14, 14],
        [15, -13, 13], [16, -12, 12], [17, -11, 11], [18, -9, 9], [19, -7, 7], [20, -4, 4],
    ],
];

#[rustfmt::skip]
const CORNER_CENTRED_ROWS: [&[[i8; 3]]; 21] = [
    &[[0, 0, 0]],
    &[[-1, -1, 0], [0, -1, 0]],
    &[[-2, -2, 1], [-1, -2, 1], [0, -2, 1], [1, -2, 1]],
    &[[-3, -2, 1], [-2, -3, 2], [-1, -3, 2], [0, -3, 2], [1, -3, 2], [2, -2, 1]],
    &[
        [-4, -2, 1], [-3, -3, 2], [-2, -4, 3], [-1, -4, 3], [0, -4, 3], [1, -4, 3], [2, -3, 2],
        [3, -2, 1],
    ],
    &[
        [-5, -2, 1], [-4, -4, 3], [-3, -4, 3], [-2, -5, 4], [-1, -5, 4], [0, -5, 4], [1, -5, 4],
        [2, -4, 3], [3, -4, 3], [4, -2, 1],
    ],
    &[
        [-6, -2, 1], [-5, -4, 3], [-4, -5, 4], [-3, -5, 4], [-2, -6, 5], [-1, -6, 5], [0, -6, 5],
        [1, -6, 5], [2, -5, 4], [3, -5, 4], [4, -4, 3], [5, -2, 1],
    ],
    &[
        [-7, -2, 1], [-6, -4, 3], [-5, -5, 4], [-4, -6, 5], [-3, -6, 5], [-2, -7, 6], [-1, -7, 6],
        [0, -7, 6], [1, -7, 6], [2, -6, 5], [3, -6, 5], [4, -5, 4], [5, -4, 3], [6, -2, 1],
    ],
    &[
        [-8, -3, 2], [-7, -5, 4], [-6, -6, 5], [-5, -7, 6], [-4, -7, 6], [-3, -8, 7], [-2, -8, 7],
        [-1, -8, 7], [0, -8, 7], [1, -8, 7], [2, -8, 7], [3, -7, 6], [4, -7, 6], [5, -6, 5],
        [6, -5, 4], [7, -3, 2],
    ],
    &[
        [-9, -3, 2], [-8, -5, 4], [-7, -6, 5], [-6, -7, 6], [-5, -8, 7], [-4, -8, 7], [-3, -9, 8],
        [-2, -9, 8], [-1, -9, 8], [0, -9, 8], [1, -9, 8], [2, -9, 8], [3, -8, 7], [4, -8, 7],
        [5, -7, 6], [6, -6, 5], [7, -5, 4], [8, -3, 2],
    ],
    &[
        [-10, -3, 2], [-9, -5, 4], [-8, -7, 6], [-7, -8, 7], [-6, -8, 7], [-5, -9, 8], [-4, -9, 8],
        [-3, -10, 9], [-2, -10, 9], [-1, -10, 9], [0, -10, 9], [1, -10, 9], [2, -10, 9], [3, -9, 8],
        [4, -9, 8], [5, -8, 7], [6, -8, 7], [7, -7, 6], [8, -5, 4], [9, -3, 2],
    ],
    &[
        [-11, -3, 2], [-10, -5, 4], [-9, -7, 6], [-8, -8, 7], [-7, -9, 8], [-6, -9, 8],
        [-5, -10, 9], [-4, -10, 9], [-3, -11, 10], [-2, -11, 10], [-1, -11, 10], [0, -11, 10],
        [1, -11, 10], [2, -11, 10], [3, -10, 9], [4, -10, 9], [5, -9, 8], [6, -9, 8], [7, -8, 7],
        [8, -7, 6], [9, -5, 4], [10, -3, 2],
    ],
    &[
        [-12, -3, 2], [-11, -6, 5], [-10, -7, 6], [-9, -8, 7], [-8, -9, 8], [-7, -10, 9],
        [-6, -11, 10], [-5, -11, 10], [-4, -11, 10], [-3, -12, 11], [-2, -12, 11], [-1, -12, 11],
        [0, -12, 11], [1, -12, 11], [2, -12, 11], [3, -11, 10], [4, -11, 10], [5, -11, 10],
        [6, -10, 9], [7, -9, 8], [8, -8, 7], [9, -7, 6], [10, -6, 5], [11, -3, 2],
    ],
    &[
        [-13, -3, 2], [-12, -6, 5], [-11, -8, 7], [-10, -9, 8], [-9, -10, 9], [-8, -11, 10],
        [-7, -11, 10], [-6, -12, 11], [-5, -12, 11], [-4, -12, 11], [-3, -13, 12], [-2, -13, 12],
        [-1, -13, 12], [0, -13, 12], [1, -13, 12], [2, -13, 12], [3, -12, 11], [4, -12, 11],
        [5, -12, 11], [6, -11, 10], [7, -11, 10], [8, -10, 9], [9, -9, 8], [10, -8, 7], [11, -6, 5],
        [12, -3, 2],
    ],
    &[
        [-14, -4, 3], [-13, -6, 5], [-12, -8, 7], [-11, -9, 8], [-10, -10, 9], [-9, -11, 10],
        [-8, -12, 11], [-7, -12, 11], [-6, -13, 12], [-5, -13, 12], [-4, -14, 13], [-3, -14, 13],
        [-2, -14, 13], [-1, -14, 13], [0, -14, 13], [1, -14, 13], [2, -14, 13], [3, -14, 13],
        [4, -13, 12], [5, -13, 12], [6, -12, 11], [7, -12, 11], [8, -11, 10], [9, -10, 9],
        [10, -9, 8], [11, -8, 7], [12, -6, 5], [13, -4, 3],
    ],
    &[
        [-15, -4, 3], [-14, -6, 5], [-13, -8, 7], [-12, -10, 9], [-11, -11, 10], [-10, -12, 11],
        [-9, -12, 11], [-8, -13, 12], [-7, -13, 12], [-6, -14, 13], [-5, -14, 13], [-4, -15, 14],
        [-3, -15, 14], [-2, -15, 14], [-1, -15, 14], [0, -15, 14], [1, -15, 14], [2, -15, 14],
        [3, -15, 14], [4, -14, 13], [5, -14, 13], [6, -13, 12], [7, -13, 12], [8, -12, 11],
        [9, -12, 11], [10, -11, 10], [11, -10, 9], [12, -8, 7], [13, -6, 5], [14, -4, 3],
    ],
    &[
        [-16, -4, 3], [-15, -7, 6], [-14, -8, 7], [-13, -10, 9], [-12, -11, 10], [-11, -12, 11],
        [-10, -13, 12], [-9, -13, 12], [-8, -14, 13], [-7, -15, 14], [-6, -15, 14], [-5, -15, 14],
        [-4, -16, 15], [-3, -16, 15], [-2, -16, 15], [-1, -16, 15], [0, -16, 15], [1, -16, 15],
        [2, -16, 15], [3, -16, 15], [4, -15, 14], [5, -15, 14], [6, -15, 14], [7, -14, 13],
        [8, -13, 12], [9, -13, 12], [10, -12, 11], [11, -11, 10], [12, -10, 9], [13, -8, 7],
        [14, -7, 6], [15, -4, 3],
    ],
    &[
        [-17, -4, 3], [-16, -7, 6], [-15, -9, 8], [-14, -10, 9], [-13, -11, 10], [-12, -12, 11],
        [-11, -13, 12], [-10, -14, 13], [-9, -15, 14], [-8, -15, 14], [-7, -16, 15], [-6, -16, 15],
        [-5, -16, 15], [-4, -17, 16], [-3, -17, 16], [-2, -17, 16], [-1, -17, 16], [0, -17, 16],
        [1, -17, 16], [2, -17, 16], [3, -17, 16], [4, -16, 15], [5, -16, 15], [6, -16, 15],
        [7, -15, 14], [8, -15, 14], [9, -14, 13], [10, -13, 12], [11, -12, 11], [12, -11, 10],
        [13, -10, 9], [14, -9, 8], [15, -7, 6], [16, -4, 3],
    ],
    &[
        [-18, -4, 3], [-17, -7, 6], [-16, -9, 8], [-15, -11, 10], [-14, -12, 11], [-13, -13, 12],
        [-12, -14, 13], [-11, -15, 14], [-10, -15, 14], [-9, -16, 15], [-8, -16, 15], [-7, -17, 16],
        [-6, -17, 16], [-5, -17, 16], [-4, -18, 17], [-3, -18, 17], [-2, -18, 17], [-1, -18, 17],
        [0, -18, 17], [1, -18, 17], [2, -18, 17], [3, -18, 17], [4, -17, 16], [5, -17, 16],
        [6, -17, 16], [7, -16, 15], [8, -16, 15], [9, -15, 14], [10, -15, 14], [11, -14, 13],
        [12, -13, 12], [13, -12, 11], [14, -11, 10], [15, -9, 8], [16, -7, 6], [17, -4, 3],
    ],
    &[
        [-19, -4, 3], [-18, -7, 6], [-17, -9, 8], [-16, -11, 10], [-15, -12, 11], [-14, -13, 12],
        [-13, -14, 13], [-12, -15, 14], [-11, -16, 15], [-10, -16, 15], [-9, -17, 16],
        [-8, -17, 16], [-7, -18, 17], [-6, -18, 17], [-5, -18, 17], [-4, -19, 18], [-3, -19, 18],
        [-2, -19, 18], [-1, -19, 18], [0, -19, 18], [1, -19, 18], [2, -19, 18], [3, -19, 18],
        [4, -18, 17], [5, -18, 17], [6, -18, 17], [7, -17, 16], [8, -17, 16], [9, -16, 15],
        [10, -16, 15], [11, -15, 14], [12, -14, 13], [13, -13, 12], [14, -12, 11], [15, -11, 10],
        [16, -9, 8], [17, -7, 6], [18, -4, 3],
    ],
    &[
        [-20, -4, 3], [-19, -7, 6], [-18, -10, 9], [-17, -11, 10], [-16, -13, 12], [-15, -14, 13],
        [-14, -15, 14], [-13, -16, 15], [-12, -16, 15], [-11, -17, 16], [-10, -18, 17],
        [-9, -18, 17], [-8, -18, 17], [-7, -19, 18], [-6, -19, 18], [-5, -19, 18], [-4, -20, 19],
        [-3, -20, 19], [-2, -20, 19], [-1, -20, 19], [0, -20, 19], [1, -20, 19], [2, -20, 19],
        [3, -20, 19], [4, -19, 18], [5, -19, 18], [6, -19, 18], [7, -18, 17], [8, -18, 17],
        [9, -18, 17], [10, -17, 16], [11, -16, 15], [12, -16, 15], [13, -15, 14], [14, -14, 13],
        [15, -13, 12], [16, -11, 10], [17, -10, 9], [18, -7, 6], [19, -4, 3],
    ],
];
