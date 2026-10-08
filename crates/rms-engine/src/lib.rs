mod connection_routes;
mod exact_appearance;
mod exact_cliff;
mod exact_cliff_piece;
mod exact_connection;
mod exact_elevation;
mod exact_land;
mod exact_object;
mod exact_path;
mod exact_terrain;
mod exact_world;
mod exact_zone;
mod execution_cost;
mod lobby_labels;
pub mod local_content;
pub mod placement_oracle;
mod visual_checkpoint;

pub use exact_zone::ExactRestrictionZones;
pub use execution_cost::{
    EXACT_EXECUTION_PLAN, EXECUTION_COST_CONTRACT_MAJOR, EXECUTION_COST_CONTRACT_MINOR,
    ExecutionCostCollector, ExecutionCostError, ExecutionCostSummary, ExecutionCounter,
    ExecutionGroup, ExecutionObserver, ExecutionProgress, ExecutionStep, GroupCost,
    MAXIMUM_EXECUTION_GROUPS, MAXIMUM_EXECUTION_STEPS, MAXIMUM_STEP_COUNTERS,
    NoopExecutionObserver, StepCost, observe_exact_script_parse,
};
pub use visual_checkpoint::{
    CoalescingCheckpointLane, MAXIMUM_VISUAL_CHECKPOINT_BYTES, MAXIMUM_VISUAL_CHECKPOINT_CLIFFS,
    MAXIMUM_VISUAL_CHECKPOINT_OBJECTS, MAXIMUM_VISUAL_CHECKPOINTS, MAXIMUM_VISUAL_CHUNKS,
    MINIMUM_SUBSTAGE_CHECKPOINT_INTERVAL, VISUAL_CHECKPOINT_CONTRACT_MAJOR,
    VISUAL_CHECKPOINT_CONTRACT_MINOR, VISUAL_CHUNK_TILES, VISUAL_CLIFF_RECORD_BYTES,
    VISUAL_OBJECT_RECORD_BYTES, VisualCheckpoint, VisualCheckpointError, VisualCheckpointObserver,
    VisualChunk, VisualProjector, VisualStage, VisualState, chunk_grid, chunk_tile_count,
    substage_checkpoint_interval,
};

pub use connection_routes::{
    CONNECTION_ROUTE_RECORD_BYTES, CONNECTION_ROUTE_SUMMARY_BYTES, CONNECTION_ROUTE_VERTEX_BYTES,
    CONNECTION_ROUTES_FORMAT_MAJOR, CONNECTION_ROUTES_FORMAT_MINOR, ConnectionRouteRecord,
    ConnectionRoutes, ConnectionRoutesError, FAILED_CONNECTION_SEARCH,
    MAXIMUM_CONNECTION_ROUTE_BYTES, MAXIMUM_CONNECTION_ROUTE_RECORDS,
    ROUTE_OMISSION_ATTEMPT_RETENTION, ROUTE_OMISSION_FRAME_BUDGET, ROUTE_OMISSION_KNOWN,
    ROUTE_OMISSION_PRESENTATION_BUDGET,
};
pub use exact_appearance::ExactAppearanceObject;

pub use lobby_labels::LOBBY_LABELS;

pub use exact_cliff::{
    ExactCliffAttempt, ExactCliffConfiguration, ExactCliffDirectionSample, ExactCliffState,
    ExactCliffStatistics, resolve_exact_cliff_state,
};

pub use exact_connection::{
    ExactConnectionDescriptor, ExactConnectionPathAttempt, ExactConnectionPathTile,
    ExactConnectionState, ExactConnectionStatistics, ExactConnectionTerrainRule,
    resolve_exact_connection_state,
};

pub use exact_elevation::{
    ExactElevationAttemptOutcome, ExactElevationAttemptSample, ExactElevationDescriptor,
    ExactElevationInitialPopSample, ExactElevationScaling, ExactElevationState,
    ExactElevationStatistics, resolve_exact_elevation_state,
};

pub use exact_land::{
    ExactLandCandidateOutcome, ExactLandCandidateSample, ExactLandCleanupOutcome,
    ExactLandCleanupSample, ExactLandDescriptor, ExactLandState, ExactLandStatistics,
    resolve_exact_land_state,
};

pub use exact_object::{
    ActorAreaCenter, ExactActorArea, ExactObjectAttempt, ExactObjectClassConstraint,
    ExactObjectClassFilter, ExactObjectClassFilterMode, ExactObjectDescriptor,
    ExactObjectDistancePreference, ExactObjectGroup, ExactObjectGroupEntry, ExactObjectGrouping,
    ExactObjectLifecycle, ExactObjectLifecyclePositionBits, ExactObjectScaling, ExactObjectState,
    ExactObjectStatistics, OBJECT_FLAG_BUILDING_CAPTURABLE, OBJECT_FLAG_GAIA_UNCONVERTIBLE,
    OBJECT_FLAG_INDESTRUCTIBLE, resolve_exact_object_state,
};

pub use exact_terrain::{
    ExactTerrainDescriptor, ExactTerrainLayerStatistics, ExactTerrainRngSample,
    ExactTerrainSpacingRule, ExactTerrainState, ExactTerrainStatistics,
    resolve_exact_terrain_state,
};

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU8, Ordering};

use rms_content::{
    CivilizationId, CompatibleContentView, ContentPackIdentity, ObjectId, RestrictionDefinition,
    TerrainId,
};
use rms_profile::ProfileIdentity;
use rms_semantics::{
    ArgumentKind, ExecutionPlayerSetup, ResolvedArgument, RmsRandom, SemanticOperation,
    SemanticProgram, StrictParseOptions,
};
use rms_trace::{
    CliffMutation, ConnectionMutation, GenerationEvent, GenerationEventKind, GenerationEventSink,
    GenerationStage, MutationBatch, MutationOperation, ObjectMutation, TileMutation, TraceLevel,
    TraceSinkError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAXIMUM_MAP_DIMENSION: u16 = 512;
pub const MAXIMUM_PLAYERS: usize = 8;
pub const MAXIMUM_TEAMS: u8 = 4;
pub const SETUP_CONTEXT_MAJOR: u32 = 1;
pub const SETUP_CONTEXT_MINOR: u32 = 0;
pub const SETUP_CONTEXT_PATCH: u32 = 0;
pub const SETUP_CONTEXT_MAXIMUM_MINOR: u32 = 2;
pub const SETUP_CONTEXT_COMPUTER_PLAYER_MINOR: u32 = 1;
pub const SETUP_CONTEXT_LOBBY_OPTIONS_MINOR: u32 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDimensions {
    pub width: u16,
    pub height: u16,
}

impl MapDimensions {
    pub fn tile_count(self) -> Result<usize, GenerationError> {
        if self.width == 0
            || self.height == 0
            || self.width > MAXIMUM_MAP_DIMENSION
            || self.height > MAXIMUM_MAP_DIMENSION
        {
            return Err(GenerationError::InvalidRequest {
                code: "RMSGEN1001",
                message: "map dimensions must be between 1 and 512".to_owned(),
            });
        }
        Ok(usize::from(self.width) * usize::from(self.height))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapCoordinate {
    pub x: u16,
    pub y: u16,
}

impl MapCoordinate {
    pub fn index(self, dimensions: MapDimensions) -> Option<usize> {
        (self.x < dimensions.width && self.y < dimensions.height)
            .then_some(usize::from(self.y) * usize::from(dimensions.width) + usize::from(self.x))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRectangle {
    pub origin: MapCoordinate,
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupContextVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Default for SetupContextVersion {
    fn default() -> Self {
        Self {
            major: SETUP_CONTEXT_MAJOR,
            minor: SETUP_CONTEXT_MINOR,
            patch: SETUP_CONTEXT_PATCH,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameMode {
    RandomMap,
    Regicide,
    DeathMatch,
    KingOfTheHill,
    WonderRace,
    DefendTheWonder,
    TurboRandomMap,
    CaptureTheRelic,
    SuddenDeath,
    BattleRoyale,
    EmpireWars,
}

impl GameMode {
    pub const fn native_value(self) -> u8 {
        match self {
            Self::RandomMap => 0,
            Self::Regicide => 1,
            Self::DeathMatch => 2,
            Self::KingOfTheHill => 5,
            Self::WonderRace => 6,
            Self::DefendTheWonder => 7,
            Self::TurboRandomMap => 8,
            Self::CaptureTheRelic => 10,
            Self::SuddenDeath => 11,
            Self::BattleRoyale => 12,
            Self::EmpireWars => 13,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartingResourcePolicy {
    Standard,
    Low,
    Medium,
    High,
    UltraHigh,
    Infinite,
    Random,
}

impl StartingResourcePolicy {
    pub const fn native_value(self) -> u8 {
        match self {
            Self::Standard => 0,
            Self::Low => 1,
            Self::Medium => 2,
            Self::High => 3,
            Self::UltraHigh => 4,
            Self::Infinite => 5,
            Self::Random => 6,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartingAge {
    Standard,
    DarkAge,
    FeudalAge,
    CastleAge,
    ImperialAge,
    PostImperialAge,
}

impl StartingAge {
    pub const fn native_value(self) -> u8 {
        match self {
            Self::Standard => 0,
            Self::DarkAge => 2,
            Self::FeudalAge => 3,
            Self::CastleAge => 4,
            Self::ImperialAge => 5,
            Self::PostImperialAge => 6,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PositionPolicy {
    Random,
    Fixed,
    TeamTogether,
}

impl PositionPolicy {
    pub const fn native_value(self) -> u8 {
        match self {
            Self::Random => 0,
            Self::Fixed => 1,
            Self::TeamTogether => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ComputerPlayerSlots(u8);

impl ComputerPlayerSlots {
    pub fn from_slots(slots: &[u8]) -> Result<Self, &'static str> {
        let mut mask = 0_u8;
        let mut previous = 0_u8;
        for &slot in slots {
            if slot == 0 || usize::from(slot) > MAXIMUM_PLAYERS {
                return Err("computer player slots must be from 1 to 8");
            }
            if slot <= previous {
                return Err("computer player slots must be unique and ascending");
            }
            previous = slot;
            mask |= 1 << (slot - 1);
        }
        Ok(Self(mask))
    }

    pub const fn is_empty(&self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, slot: u8) -> bool {
        slot >= 1 && slot <= 8 && self.0 & (1 << (slot - 1)) != 0
    }

    pub const fn mask(self) -> u8 {
        self.0
    }

    pub fn slots(self) -> Vec<u8> {
        (1..=8).filter(|slot| self.contains(*slot)).collect()
    }
}

impl Serialize for ComputerPlayerSlots {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.slots().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ComputerPlayerSlots {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let slots = Vec::<u8>::deserialize(deserializer)?;
        Self::from_slots(&slots).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameModeModifier {
    EmpireWars,
    SuddenDeath,
    Regicide,
    KingOfTheHill,
}

impl GameModeModifier {
    pub const ALL: [Self; 4] = [
        Self::EmpireWars,
        Self::SuddenDeath,
        Self::Regicide,
        Self::KingOfTheHill,
    ];

    pub const fn bit(self) -> u8 {
        match self {
            Self::EmpireWars => 1,
            Self::SuddenDeath => 2,
            Self::Regicide => 4,
            Self::KingOfTheHill => 8,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::EmpireWars => "EMPIRE_WARS",
            Self::SuddenDeath => "SUDDEN_DEATH",
            Self::Regicide => "REGICIDE",
            Self::KingOfTheHill => "KING_OT_HILL",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GameModeModifiers(u8);

impl GameModeModifiers {
    pub fn from_modifiers(modifiers: &[GameModeModifier]) -> Result<Self, &'static str> {
        let mut mask = 0_u8;
        let mut previous: Option<GameModeModifier> = None;
        for &modifier in modifiers {
            if previous.is_some_and(|previous| modifier <= previous) {
                return Err("game mode modifiers must be unique and in canonical order");
            }
            previous = Some(modifier);
            mask |= modifier.bit();
        }
        Ok(Self(mask))
    }

    pub const fn is_empty(&self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, modifier: GameModeModifier) -> bool {
        self.0 & modifier.bit() != 0
    }

    pub const fn mask(self) -> u8 {
        self.0
    }

    pub fn modifiers(self) -> Vec<GameModeModifier> {
        GameModeModifier::ALL
            .into_iter()
            .filter(|modifier| self.contains(*modifier))
            .collect()
    }
}

impl Serialize for GameModeModifiers {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.modifiers().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for GameModeModifiers {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let modifiers = Vec::<GameModeModifier>::deserialize(deserializer)?;
        Self::from_modifiers(&modifiers).map_err(serde::de::Error::custom)
    }
}

const fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyOptions {
    #[serde(default, skip_serializing_if = "GameModeModifiers::is_empty")]
    pub game_mode_modifiers: GameModeModifiers,
    #[serde(default, skip_serializing_if = "is_false")]
    pub turbo_mode: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub full_tech_tree: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub antiquity_mode: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub solid_farms: bool,
}

impl LobbyOptions {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub const fn flag_bits(self) -> u8 {
        (self.turbo_mode as u8)
            | ((self.full_tech_tree as u8) << 1)
            | ((self.antiquity_mode as u8) << 2)
            | ((self.solid_farms as u8) << 3)
    }

    pub const fn changes_technology_state(self) -> bool {
        self.full_tech_tree || self.antiquity_mode
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupContext {
    pub contract_version: SetupContextVersion,
    pub game_mode: GameMode,
    pub starting_resources: StartingResourcePolicy,
    pub starting_age: StartingAge,
    pub position_policy: PositionPolicy,
    #[serde(default, skip_serializing_if = "ComputerPlayerSlots::is_empty")]
    pub computer_player_slots: ComputerPlayerSlots,
    #[serde(flatten)]
    pub lobby_options: LobbyOptions,
}

impl Default for SetupContext {
    fn default() -> Self {
        Self {
            contract_version: SetupContextVersion::default(),
            game_mode: GameMode::RandomMap,
            starting_resources: StartingResourcePolicy::Standard,
            starting_age: StartingAge::Standard,
            position_policy: PositionPolicy::Random,
            computer_player_slots: ComputerPlayerSlots::default(),
            lobby_options: LobbyOptions::default(),
        }
    }
}

impl SetupContext {
    fn validate(self) -> Result<(), GenerationError> {
        if self.contract_version.major != SETUP_CONTEXT_MAJOR
            || self.contract_version.minor > SETUP_CONTEXT_MAXIMUM_MINOR
            || (!self.computer_player_slots.is_empty()
                && self.contract_version.minor < SETUP_CONTEXT_COMPUTER_PLAYER_MINOR)
            || (!self.lobby_options.is_default()
                && self.contract_version.minor < SETUP_CONTEXT_LOBBY_OPTIONS_MINOR)
        {
            return Err(invalid_request(
                "RMSGEN1004",
                "typed setup context version is unsupported",
            ));
        }
        Ok(())
    }

    fn validate_players(self, players: &[PlayerConfiguration]) -> Result<(), GenerationError> {
        let active = players
            .iter()
            .filter(|player| player.slot >= 1 && usize::from(player.slot) <= MAXIMUM_PLAYERS)
            .fold(0_u8, |mask, player| mask | (1 << (player.slot - 1)));
        if self.computer_player_slots.mask() & !active != 0 {
            return Err(invalid_request(
                "RMSGEN1010",
                "computer player slots must be active lobby players",
            ));
        }
        Ok(())
    }

    pub fn configure_strict_parser(
        self,
        options: &mut StrictParseOptions,
        seed: u32,
        dimensions: MapDimensions,
        map_size: &str,
        players: &[PlayerConfiguration],
    ) -> Result<(), GenerationError> {
        self.validate()?;
        dimensions.tile_count()?;
        if players.is_empty() || players.len() > MAXIMUM_PLAYERS {
            return Err(invalid_request(
                "RMSGEN1005",
                "generation needs between 1 and 8 explicit players",
            ));
        }
        options.execution_context.seed = seed;
        options.execution_context.map_width = dimensions.width;
        options.execution_context.map_height = dimensions.height;
        options.execution_context.players = players
            .iter()
            .map(|player| ExecutionPlayerSetup {
                slot: player.slot,
                team: player.team,
                civilization_id: player.civilization_id.0,
                color: player.color,
            })
            .collect();
        options.execution_context.game_mode = self.game_mode.native_value();
        options.execution_context.starting_resources = self.starting_resources.native_value();
        options.execution_context.starting_age = self.starting_age.native_value();
        options.execution_context.position_policy = self.position_policy.native_value();
        for (name, value) in self.lobby_implicit_definitions(map_size, players)? {
            options.implicit_definitions.insert(name, value);
        }
        Ok(())
    }

    pub fn lobby_implicit_definitions(
        self,
        map_size: &str,
        players: &[PlayerConfiguration],
    ) -> Result<BTreeMap<String, String>, GenerationError> {
        self.validate()?;
        self.validate_players(players)?;
        let mut definitions = BTreeMap::new();
        let mut define = |name: &str| {
            definitions.insert(name.to_owned(), "1".to_owned());
        };

        define("DE_AVAILABLE");
        define("DE_GAME_AGE2");

        let map_conditions: &[&str] = match map_size {
            "tiny" => &["TINY_MAP", "MAPSIZE_TINY"],
            "small" => &["SMALL_MAP", "MAPSIZE_SMALL"],
            "medium" => &["MEDIUM_MAP", "MAPSIZE_MEDIUM"],
            "normal" => &["LARGE_MAP", "MAPSIZE_NORMAL"],
            "large" => &["HUGE_MAP", "MAPSIZE_LARGE"],
            "huge" => &["GIGANTIC_MAP", "MAPSIZE_HUGE"],
            "ludicrous" => &["LUDIKRIS_MAP", "MAPSIZE_LUDICROUS"],
            "custom" => &[],
            _ => {
                return Err(invalid_request(
                    "RMSGEN1008",
                    "map size has no setup-context 1.x lobby classification",
                ));
            }
        };
        for condition in map_conditions {
            define(condition);
        }

        let mode_conditions: &[&str] = match self.game_mode {
            GameMode::RandomMap => &["RANDOM_MAP"],
            GameMode::Regicide => &["REGICIDE"],
            GameMode::DeathMatch => &["DEATH_MATCH"],
            GameMode::KingOfTheHill => &["KING_OT_HILL"],
            GameMode::WonderRace => &["WONDER_RACE"],
            GameMode::DefendTheWonder => &["DEFEND_WONDER"],
            GameMode::TurboRandomMap => &["TURBO_RANDOM_MAP", "TURBO_MODE"],
            GameMode::CaptureTheRelic => &["CAPTURE_THE_RELIC"],
            GameMode::SuddenDeath => &["SUDDEN_DEATH"],
            GameMode::BattleRoyale => &["BATTLE_ROYALE"],
            GameMode::EmpireWars => &["EMPIRE_WARS"],
        };
        for condition in mode_conditions {
            define(condition);
        }
        for modifier in self.lobby_options.game_mode_modifiers.modifiers() {
            define(modifier.label());
        }
        if self.lobby_options.turbo_mode {
            define("TURBO_MODE");
            if self.game_mode == GameMode::RandomMap {
                define("TURBO_RANDOM_MAP");
            }
        }

        let resource_condition = match (self.game_mode, self.starting_resources) {
            (GameMode::DeathMatch, _) | (_, StartingResourcePolicy::UltraHigh) => "DEATH_MATCH",
            (_, StartingResourcePolicy::Standard) => "DEFAULT_RESOURCES",
            (_, StartingResourcePolicy::Low) => "LOW_RESOURCES",
            (_, StartingResourcePolicy::Medium) => "MEDIUM_RESOURCES",
            (_, StartingResourcePolicy::High) => "HIGH_RESOURCES",
            (_, StartingResourcePolicy::Infinite) => "INFINITE_RESOURCES",
            (_, StartingResourcePolicy::Random) => "RANDOM_RESOURCES",
        };
        define(resource_condition);

        let age_condition = match self.starting_age {
            StartingAge::Standard => match self.game_mode {
                GameMode::DeathMatch | GameMode::BattleRoyale => "POST_IMPERIAL_AGE_START",
                GameMode::EmpireWars => "FEUDAL_AGE_START",
                _ => "DARK_AGE_START",
            },
            StartingAge::DarkAge => "DARK_AGE_START",
            StartingAge::FeudalAge => "FEUDAL_AGE_START",
            StartingAge::CastleAge => "CASTLE_AGE_START",
            StartingAge::ImperialAge => "IMPERIAL_AGE_START",
            StartingAge::PostImperialAge => "POST_IMPERIAL_AGE_START",
        };
        define(age_condition);
        match self.position_policy {
            PositionPolicy::Random => {}
            PositionPolicy::TeamTogether => define("FIXED_POSITIONS"),
            PositionPolicy::Fixed => {
                define("FIXED_POSITIONS");
                define("TEAM_POSITIONS");
            }
        }
        if !self.computer_player_slots.is_empty() {
            define("AI_PLAYERS");
        }
        if self.lobby_options.full_tech_tree {
            define("FULL_TECH_TREE");
        }
        if self.lobby_options.antiquity_mode {
            define("ANTIQUITY_MODE");
        }
        if self.lobby_options.solid_farms {
            define("SOLID_FARMS");
        }

        let mut ordered_players = players.iter().collect::<Vec<_>>();
        ordered_players.sort_by_key(|player| player.slot);
        define(&format!("{}_PLAYER_GAME", ordered_players.len()));

        let mut selected_team_sizes = BTreeMap::<u8, usize>::new();
        for player in &ordered_players {
            if player.team != 0 {
                *selected_team_sizes.entry(player.team).or_default() += 1;
            }
        }
        let qualifying_teams = selected_team_sizes
            .iter()
            .filter_map(|(team, size)| (*size >= 2).then_some((*team, *size)))
            .collect::<BTreeMap<_, _>>();
        if qualifying_teams.len() > 4 {
            return Err(invalid_request(
                "RMSGEN1009",
                "setup has more than four lobby teams",
            ));
        }
        define(&format!("{}_TEAM_GAME", qualifying_teams.len()));

        let mut team_ordinals = BTreeMap::<u8, usize>::new();
        for player in &ordered_players {
            if qualifying_teams.contains_key(&player.team)
                && !team_ordinals.contains_key(&player.team)
            {
                let ordinal = team_ordinals.len() + 1;
                team_ordinals.insert(player.team, ordinal);
            }
        }
        let mut group_sizes = [0_usize; MAXIMUM_PLAYERS + 1];
        let mut team_groups = BTreeMap::<u8, usize>::new();
        let mut opened_groups = 0_usize;
        for player in &ordered_players {
            let group = match team_groups.get(&player.team) {
                Some(group) if player.team != 0 => *group,
                _ => {
                    opened_groups += 1;
                    if player.team != 0 {
                        team_groups.insert(player.team, opened_groups);
                    }
                    opened_groups
                }
            };
            group_sizes[group] += 1;
        }
        for (group, size) in group_sizes.iter().take(5).enumerate() {
            define(&format!("TEAM{group}_SIZE{size}"));
        }
        for player in ordered_players {
            let team = team_ordinals.get(&player.team).copied().unwrap_or(0);
            define(&format!("PLAYER{}_TEAM{team}", player.slot));
        }

        Ok(definitions)
    }
}

impl MapRectangle {
    pub fn contains(self, coordinate: MapCoordinate) -> bool {
        coordinate.x >= self.origin.x
            && coordinate.y >= self.origin.y
            && coordinate.x < self.origin.x.saturating_add(self.width)
            && coordinate.y < self.origin.y.saturating_add(self.height)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerConfiguration {
    pub slot: u8,
    pub team: u8,
    pub civilization_id: CivilizationId,
    pub color: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerPlacementStyle {
    Random,
    GroupedByTeam,
    Direct,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactSetupPlayer {
    pub slot: u8,
    pub team: u8,
    pub civilization_id: CivilizationId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactPlayerPosition {
    pub slot: u8,
    pub coordinate: MapCoordinate,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCirclePlacement {
    pub radius_tiles: i32,
    pub jitter_tiles: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeGenerationProgramMode {
    Ordinary,
    ExplicitMaximumSeed,
}

impl NativeGenerationProgramMode {
    fn for_explicit_seed(seed: u32) -> Self {
        if seed == u32::MAX {
            Self::ExplicitMaximumSeed
        } else {
            Self::Ordinary
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactSetupState {
    pub contract_version: SetupContextVersion,
    pub map_size: String,
    pub requested_dimensions: MapDimensions,
    pub effective_dimensions: MapDimensions,
    pub game_mode: GameMode,
    pub starting_resources: StartingResourcePolicy,
    pub starting_age: StartingAge,
    pub position_policy: PositionPolicy,
    pub players: Vec<ExactSetupPlayer>,
    pub player_positions: Vec<ExactPlayerPosition>,
    pub placement_style: PlayerPlacementStyle,
    pub circle_placement: Option<PlayerCirclePlacement>,
    pub nomad_resources: bool,
    pub force_nomad_treaty: bool,
    pub behavior_version: Option<i32>,
    pub gaia_civilization_id: CivilizationId,
    #[serde(default, skip_serializing_if = "ComputerPlayerSlots::is_empty")]
    pub computer_player_slots: ComputerPlayerSlots,
    #[serde(default, skip_serializing_if = "LobbyOptions::is_default")]
    pub lobby_options: LobbyOptions,
}

impl ExactSetupState {
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut writer = CanonicalWriter::new("rms-exact-setup-state-v1");
        writer.u32(self.contract_version.major);
        writer.u32(self.contract_version.minor);
        writer.u32(self.contract_version.patch);
        writer.string(&self.map_size);
        writer.u16(self.requested_dimensions.width);
        writer.u16(self.requested_dimensions.height);
        writer.u16(self.effective_dimensions.width);
        writer.u16(self.effective_dimensions.height);
        writer.u8(self.game_mode.native_value());
        writer.u8(self.starting_resources.native_value());
        writer.u8(self.starting_age.native_value());
        writer.u8(self.position_policy.native_value());
        writer.u8(match self.placement_style {
            PlayerPlacementStyle::Random => 0,
            PlayerPlacementStyle::GroupedByTeam => 1,
            PlayerPlacementStyle::Direct => 2,
        });
        match self.circle_placement {
            Some(circle) => {
                writer.u8(1);
                writer.u32(circle.radius_tiles as u32);
                writer.u32(circle.jitter_tiles as u32);
            }
            None => writer.u8(0),
        }
        writer.u8(u8::from(self.nomad_resources));
        writer.u8(u8::from(self.force_nomad_treaty));
        match self.behavior_version {
            Some(value) => {
                writer.u8(1);
                writer.u32(value as u32);
            }
            None => writer.u8(0),
        }
        writer.u32(self.gaia_civilization_id.0);
        writer.u32(self.players.len() as u32);
        for player in &self.players {
            writer.u8(player.slot);
            writer.u8(player.team);
            writer.u32(player.civilization_id.0);
        }
        writer.u32(self.player_positions.len() as u32);
        for position in &self.player_positions {
            writer.u8(position.slot);
            writer.coordinate(position.coordinate);
        }
        if !self.computer_player_slots.is_empty() {
            writer.u8(1);
            writer.u8(self.computer_player_slots.mask());
        }
        if !self.lobby_options.is_default() {
            writer.u8(2);
            writer.u8(self.lobby_options.game_mode_modifiers.mask());
            writer.u8(self.lobby_options.flag_bits());
        }
        Sha256::digest(writer.finish()).into()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationRequest {
    pub document_uri: String,
    pub document_revision: u64,
    pub document_hash: [u8; 32],
    pub source_graph_hash: [u8; 32],
    pub semantic_hash: [u8; 32],
    pub behavior_profile: ProfileIdentity,
    pub behavior_profile_hash: [u8; 32],
    pub content_pack: ContentPackIdentity,
    pub backend_id: String,
    pub seed: u32,
    pub dimensions: MapDimensions,
    pub map_size: String,
    pub players: Vec<PlayerConfiguration>,
    pub setup_context: SetupContext,
    pub trace_level: TraceLevel,
}

impl GenerationRequest {
    pub fn validate(&self) -> Result<(), GenerationError> {
        self.dimensions.tile_count()?;
        if self.document_uri.is_empty() || self.document_uri.len() > 4096 {
            return Err(invalid_request("RMSGEN1002", "document URI is invalid"));
        }
        if self.map_size.is_empty() || self.map_size.len() > 64 {
            return Err(invalid_request(
                "RMSGEN1003",
                "map size identity is invalid",
            ));
        }
        self.setup_context.validate()?;
        self.setup_context.validate_players(&self.players)?;
        if self.players.is_empty() || self.players.len() > MAXIMUM_PLAYERS {
            return Err(invalid_request(
                "RMSGEN1005",
                "generation needs between 1 and 8 explicit players",
            ));
        }
        let mut occupied_slots = 0_u16;
        let mut occupied_colors = 0_u16;
        for player in &self.players {
            if player.slot == 0 || usize::from(player.slot) > MAXIMUM_PLAYERS {
                return Err(invalid_request(
                    "RMSGEN1006",
                    "player slots must be unique and bounded",
                ));
            }
            let slot_bit = 1_u16 << (player.slot - 1);
            if occupied_slots & slot_bit != 0
                || player.team > MAXIMUM_TEAMS
                || usize::from(player.color) >= MAXIMUM_PLAYERS
            {
                return Err(invalid_request(
                    "RMSGEN1006",
                    "player slots, teams, and colors must be bounded",
                ));
            }
            let color_bit = 1_u16 << player.color;
            if occupied_colors & color_bit != 0 {
                return Err(invalid_request(
                    "RMSGEN1006",
                    "player colors must be unique",
                ));
            }
            occupied_slots |= slot_bit;
            occupied_colors |= color_bit;
        }
        if self.behavior_profile.profile_id.is_empty()
            || self.content_pack.pack_id.is_empty()
            || self.backend_id.is_empty()
            || self.backend_id.len() > 64
            || self.behavior_profile_hash == [0; 32]
            || self.source_graph_hash == [0; 32]
            || self.content_pack.content_hash == [0; 32]
        {
            return Err(invalid_request(
                "RMSGEN1007",
                "profile and content identities must be explicit",
            ));
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, GenerationError> {
        self.validate()?;
        let mut writer = CanonicalWriter::new("rms-generation-request-v3");
        writer.string(&self.document_uri);
        writer.u64(self.document_revision);
        writer.bytes(&self.document_hash);
        writer.bytes(&self.source_graph_hash);
        writer.bytes(&self.semantic_hash);
        writer.string(&self.behavior_profile.schema_version);
        writer.string(&self.behavior_profile.profile_id);
        writer.string(&self.behavior_profile.behavior_version);
        writer.bytes(&self.behavior_profile_hash);
        writer.string(&self.content_pack.pack_id);
        writer.string(&self.content_pack.pack_version);
        writer.string(&self.content_pack.source_fingerprint);
        writer.bytes(&self.content_pack.content_hash);
        writer.string(&self.backend_id);
        writer.u32(self.seed);
        writer.u16(self.dimensions.width);
        writer.u16(self.dimensions.height);
        writer.string(&self.map_size);
        let mut players = self.players.iter().collect::<Vec<_>>();
        players.sort_by_key(|player| player.slot);
        writer.u32(players.len() as u32);
        for player in players {
            writer.u8(player.slot);
            writer.u8(player.team);
            writer.u32(player.civilization_id.0);
        }
        writer.u32(self.setup_context.contract_version.major);
        writer.u32(self.setup_context.contract_version.minor);
        writer.u32(self.setup_context.contract_version.patch);
        writer.u8(self.setup_context.game_mode.native_value());
        writer.u8(self.setup_context.starting_resources.native_value());
        writer.u8(self.setup_context.starting_age.native_value());
        writer.u8(self.setup_context.position_policy.native_value());
        if !self.setup_context.computer_player_slots.is_empty() {
            writer.u8(1);
            writer.u8(self.setup_context.computer_player_slots.mask());
        }
        if !self.setup_context.lobby_options.is_default() {
            writer.u8(2);
            writer.u8(self.setup_context.lobby_options.game_mode_modifiers.mask());
            writer.u8(self.setup_context.lobby_options.flag_bits());
        }
        writer.u8(match self.trace_level {
            TraceLevel::Off => 0,
            TraceLevel::Summary => 1,
            TraceLevel::Full => 2,
        });
        Ok(writer.finish())
    }

    pub fn deterministic_hash(&self) -> Result<[u8; 32], GenerationError> {
        Ok(Sha256::digest(self.canonical_bytes()?).into())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ResolvedGenerationInput<'a> {
    pub semantic_program: &'a SemanticProgram,
    pub request: &'a GenerationRequest,
    pub content: CompatibleContentView<'a>,
}

impl ResolvedGenerationInput<'_> {
    pub fn validate(&self) -> Result<(), GenerationError> {
        self.request.validate()?;
        if self.semantic_program.identity.semantic_hash != self.request.semantic_hash {
            return Err(GenerationError::StaleSemanticProgram);
        }
        if self.semantic_program.identity.profile != self.request.behavior_profile {
            return Err(GenerationError::IncompatibleProfile);
        }
        let context = &self.semantic_program.execution_context;
        let mut expected_players = self
            .request
            .players
            .iter()
            .map(|player| ExecutionPlayerSetup {
                slot: player.slot,
                team: player.team,
                civilization_id: player.civilization_id.0,
                color: player.color,
            })
            .collect::<Vec<_>>();
        expected_players.sort_by_key(|player| player.slot);
        let mut actual_players = context.players.clone();
        actual_players.sort_by_key(|player| player.slot);
        if context.seed != self.request.seed
            || context.map_width != self.request.dimensions.width
            || context.map_height != self.request.dimensions.height
            || actual_players != expected_players
            || context.game_mode != self.request.setup_context.game_mode.native_value()
            || context.starting_resources
                != self.request.setup_context.starting_resources.native_value()
            || context.starting_age != self.request.setup_context.starting_age.native_value()
            || context.position_policy != self.request.setup_context.position_policy.native_value()
        {
            return Err(GenerationError::IncompatibleExecutionContext);
        }
        let content_identity = self
            .content
            .identity()
            .map_err(|error| GenerationError::InvalidContent(error.to_string()))?;
        if content_identity != self.request.content_pack {
            return Err(GenerationError::IncompatibleContent);
        }
        Ok(())
    }

    pub fn validate_for_backend(&self, backend_id: &str) -> Result<(), GenerationError> {
        self.validate()?;
        if self.request.backend_id != backend_id {
            return Err(GenerationError::IncompatibleBackend {
                expected: backend_id.to_owned(),
                actual: self.request.backend_id.clone(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TileFlags(pub u32);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliffEdge {
    pub from: MapCoordinate,
    pub to: MapCoordinate,
    pub cliff_type: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
    Land,
    Water,
    Road,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapConnection {
    pub start: MapCoordinate,
    pub end: MapCoordinate,
    pub kind: ConnectionKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedObject {
    #[serde(default)]
    pub instance_id: u32,
    pub object_id: ObjectId,
    pub x_256: u32,
    pub y_256: u32,
    #[serde(default)]
    pub z_256: i32,
    pub owner: u8,
    pub facet: u16,
    pub footprint_width_256: u16,
    pub footprint_height_256: u16,
    pub presentation_kind: u8,
    pub resource_type: i16,
    pub resource_quantity_f32_bits: u32,
    #[serde(default)]
    pub resource_delta: i32,
    #[serde(default)]
    pub status: i32,
    #[serde(default)]
    pub death_state: i8,
    #[serde(default)]
    pub data_status: i16,
    #[serde(default)]
    pub selection_flags: u8,
    #[serde(default)]
    pub behavior_flags: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliffPiece {
    pub object_id: ObjectId,
    pub x_256: u32,
    pub y_256: u32,
    pub facet: u16,
    pub edges: [i8; 4],
}

pub const MAXIMUM_PRESENTATION_CLIFF_PIECES: usize = 65_536;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PresentationAdjustments {
    clamped: u64,
    dropped: u64,
}

impl PresentationAdjustments {
    fn counters(self) -> impl Iterator<Item = (String, u64)> {
        [
            ("presentation-entries-clamped", self.clamped),
            ("presentation-entries-dropped", self.dropped),
        ]
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(name, count)| (name.to_owned(), count))
    }
}

fn presentation_axis(value_256: u64, extent: u16) -> Option<(u32, bool)> {
    let limit = u64::from(extent) * 256;
    if value_256 < limit {
        Some((value_256 as u32, false))
    } else if value_256 == limit && limit > 0 {
        Some(((limit - 1) as u32, true))
    } else {
        None
    }
}

fn presentation_position(
    x_256: u64,
    y_256: u64,
    dimensions: MapDimensions,
    adjustments: &mut PresentationAdjustments,
) -> Option<(u32, u32)> {
    match (
        presentation_axis(x_256, dimensions.width),
        presentation_axis(y_256, dimensions.height),
    ) {
        (Some((x, x_clamped)), Some((y, y_clamped))) => {
            if x_clamped || y_clamped {
                adjustments.clamped += 1;
            }
            Some((x, y))
        }
        _ => {
            adjustments.dropped += 1;
            None
        }
    }
}

fn presentation_cliff_pieces(
    pieces: &[PlacedObject],
    style: Option<&rms_content::CliffDefinition>,
    dimensions: MapDimensions,
    adjustments: &mut PresentationAdjustments,
) -> Vec<CliffPiece> {
    adjustments.dropped += pieces
        .len()
        .saturating_sub(MAXIMUM_PRESENTATION_CLIFF_PIECES) as u64;
    pieces
        .iter()
        .take(MAXIMUM_PRESENTATION_CLIFF_PIECES)
        .filter_map(|piece| {
            let (x_256, y_256) = presentation_position(
                u64::from(piece.x_256),
                u64::from(piece.y_256),
                dimensions,
                adjustments,
            )?;
            let facet = u8::try_from(piece.facet).ok();
            let edges = style
                .and_then(|style| {
                    style.piece_rules.iter().find(|rule| {
                        [Some(rule.primary), rule.alternate]
                            .into_iter()
                            .flatten()
                            .any(|variant| {
                                variant.object_id == piece.object_id && Some(variant.facet) == facet
                            })
                    })
                })
                .map_or([0; 4], |rule| rule.edges);
            Some(CliffPiece {
                object_id: piece.object_id,
                x_256,
                y_256,
                facet: piece.facet,
                edges,
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainAppearanceObject {
    pub object_id: ObjectId,
    pub x_256: u32,
    pub y_256: u32,
    pub footprint_256: u16,
    pub tree: bool,
}

pub const MAXIMUM_PRESENTATION_APPEARANCE_OBJECTS: usize = 524_288;

fn presentation_appearance_objects(
    standing: &[(ObjectId, [u32; 2])],
    content: CompatibleContentView<'_>,
    dimensions: MapDimensions,
    adjustments: &mut PresentationAdjustments,
) -> Vec<TerrainAppearanceObject> {
    let tree_class = content.object_placement_classes().forest_zone_class_id;
    let fixed = |bits: u32| {
        let value = f32::from_bits(bits);
        (value.is_finite() && value >= 0.0).then(|| (f64::from(value) * 256.0).round() as u64)
    };
    adjustments.dropped += standing
        .len()
        .saturating_sub(MAXIMUM_PRESENTATION_APPEARANCE_OBJECTS) as u64;
    standing
        .iter()
        .take(MAXIMUM_PRESENTATION_APPEARANCE_OBJECTS)
        .filter_map(|(object_id, [x_bits, y_bits])| {
            let position = match (fixed(*x_bits), fixed(*y_bits)) {
                (Some(x), Some(y)) => presentation_position(x, y, dimensions, adjustments),
                _ => {
                    adjustments.dropped += 1;
                    None
                }
            };
            let (x_256, y_256) = position?;
            let definition = content.object(*object_id);
            Some(TerrainAppearanceObject {
                object_id: *object_id,
                x_256,
                y_256,
                footprint_256: definition.map_or(0, |definition| {
                    definition
                        .footprint_width_256
                        .min(definition.footprint_height_256)
                }),
                tree: definition
                    .zip(tree_class)
                    .is_some_and(|(definition, class)| definition.class_id == class),
            })
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceReference {
    pub source_id: String,
    pub byte_start: u32,
    pub byte_end: u32,
    pub operation_identity: [u8; 32],
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationMetrics {
    pub tile_count: u64,
    pub object_count: u64,
    pub allocated_bytes: u64,
    pub emitted_events: u64,
    pub counters: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedMap {
    pub dimensions: MapDimensions,
    pub terrain: Vec<TerrainId>,
    pub pre_connection_terrain: Vec<TerrainId>,
    pub layer: Vec<u16>,
    pub elevation: Vec<i16>,
    pub land_zone: Vec<u32>,
    pub terrain_zone: Vec<u32>,
    pub flags: Vec<TileFlags>,
    pub cliffs: Vec<CliffEdge>,
    pub cliff_pieces: Vec<CliffPiece>,
    pub appearance_objects: Vec<TerrainAppearanceObject>,
    pub connections: Vec<MapConnection>,
    pub connection_routes: Option<ConnectionRoutes>,
    pub objects: Vec<PlacedObject>,
    pub tile_operation_indices: Vec<u32>,
    pub object_operation_indices: Vec<u32>,
    pub cliff_operation_indices: Vec<u32>,
    pub connection_operation_indices: Vec<u32>,
    pub stage_hashes: Vec<(GenerationStage, [u8; 32])>,
    pub final_semantic_hash: [u8; 32],
    pub warnings: Vec<GenerationWarning>,
    pub metrics: GenerationMetrics,
    pub provenance: Vec<ProvenanceReference>,
}

impl GeneratedMap {
    pub fn validate(&self) -> Result<(), GenerationError> {
        let tiles = self.dimensions.tile_count()?;
        if [
            self.terrain.len(),
            self.pre_connection_terrain.len(),
            self.layer.len(),
            self.elevation.len(),
            self.land_zone.len(),
            self.terrain_zone.len(),
            self.flags.len(),
            self.tile_operation_indices.len(),
        ]
        .into_iter()
        .any(|length| length != tiles)
        {
            return Err(GenerationError::InvalidMap(
                "column lengths do not match dimensions".to_owned(),
            ));
        }
        if self.stage_hashes.len() != GenerationStage::ORDERED.len()
            || !self
                .stage_hashes
                .iter()
                .zip(GenerationStage::ORDERED)
                .all(|((stage, _), expected)| *stage == expected)
        {
            return Err(GenerationError::InvalidMap(
                "stage hashes are incomplete or unordered".to_owned(),
            ));
        }
        if self.object_operation_indices.len() != self.objects.len()
            || self.cliff_operation_indices.len() != self.cliffs.len()
            || self.connection_operation_indices.len() != self.connections.len()
        {
            return Err(GenerationError::InvalidMap(
                "provenance operation columns do not match map collections".to_owned(),
            ));
        }
        let maximum_edges = tiles.saturating_mul(8);
        if self.cliffs.len() > maximum_edges
            || self.connections.len() > maximum_edges
            || self.objects.len() > 1_000_000
            || self.warnings.len() > 4096
            || self.provenance.len() > 1_000_000
        {
            return Err(GenerationError::InvalidMap(
                "generated collection exceeds its bounded size".to_owned(),
            ));
        }
        for edge in &self.cliffs {
            if edge.from.index(self.dimensions).is_none()
                || edge.to.index(self.dimensions).is_none()
            {
                return Err(GenerationError::InvalidMap(
                    "cliff edge lies outside map bounds".to_owned(),
                ));
            }
        }
        for connection in &self.connections {
            if connection.start.index(self.dimensions).is_none()
                || connection.end.index(self.dimensions).is_none()
            {
                return Err(GenerationError::InvalidMap(
                    "connection lies outside map bounds".to_owned(),
                ));
            }
        }
        let maximum_x_256 = u32::from(self.dimensions.width) * 256;
        let maximum_y_256 = u32::from(self.dimensions.height) * 256;
        for object in &self.objects {
            if !object_position_in_map(object.x_256, object.y_256, self.dimensions)
                || object.owner > 8
            {
                return Err(GenerationError::InvalidMap(
                    "placed object lies outside map or owner bounds".to_owned(),
                ));
            }
        }
        if self.cliff_pieces.len() > MAXIMUM_PRESENTATION_CLIFF_PIECES
            || self
                .cliff_pieces
                .iter()
                .any(|piece| piece.x_256 >= maximum_x_256 || piece.y_256 >= maximum_y_256)
        {
            return Err(GenerationError::InvalidMap(
                "cliff piece lies outside map bounds".to_owned(),
            ));
        }
        if self.appearance_objects.len() > MAXIMUM_PRESENTATION_APPEARANCE_OBJECTS
            || self
                .appearance_objects
                .iter()
                .any(|object| object.x_256 >= maximum_x_256 || object.y_256 >= maximum_y_256)
        {
            return Err(GenerationError::InvalidMap(
                "terrain appearance lies outside map bounds".to_owned(),
            ));
        }
        for reference in &self.provenance {
            if reference.source_id.is_empty()
                || reference.source_id.len() > 4096
                || reference.byte_start > reference.byte_end
            {
                return Err(GenerationError::InvalidMap(
                    "provenance reference is invalid".to_owned(),
                ));
            }
        }
        if self.metrics.tile_count != tiles as u64
            || self.metrics.object_count != self.objects.len() as u64
        {
            return Err(GenerationError::InvalidMap(
                "generation metrics do not match map state".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn canonical_state_bytes(&self) -> Result<Vec<u8>, GenerationError> {
        self.validate()?;
        Ok(canonical_semantic_state_bytes(
            self.dimensions,
            &self.terrain,
            &self.layer,
            &self.elevation,
            &self.land_zone,
            &self.terrain_zone,
            &self.flags,
            &self.cliffs,
            &self.connections,
            &self.objects,
        ))
    }

    pub fn computed_semantic_hash(&self) -> Result<[u8; 32], GenerationError> {
        Ok(Sha256::digest(self.canonical_state_bytes()?).into())
    }

    pub fn finalize_semantic_hash(&mut self) -> Result<(), GenerationError> {
        self.final_semantic_hash = self.computed_semantic_hash()?;
        Ok(())
    }
}

fn object_position_in_map(x_256: u32, y_256: u32, dimensions: MapDimensions) -> bool {
    x_256 <= u32::from(dimensions.width) * 256 && y_256 <= u32::from(dimensions.height) * 256
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_semantic_state_bytes(
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    cliffs: &[CliffEdge],
    connections: &[MapConnection],
    objects: &[PlacedObject],
) -> Vec<u8> {
    let mut writer = CanonicalWriter::new("rms-generated-map-v3");
    writer.u16(dimensions.width);
    writer.u16(dimensions.height);
    writer.u32(terrain.len() as u32);
    for value in terrain {
        writer.u32(value.0);
    }
    for value in layer {
        writer.u16(*value);
    }
    for value in elevation {
        writer.i16(*value);
    }
    for value in land_zone {
        writer.u32(*value);
    }
    for value in terrain_zone {
        writer.u32(*value);
    }
    for value in flags {
        writer.u32(value.0);
    }
    writer.u32(cliffs.len() as u32);
    for edge in cliffs {
        writer.coordinate(edge.from);
        writer.coordinate(edge.to);
        writer.u32(edge.cliff_type);
    }
    writer.u32(connections.len() as u32);
    for connection in connections {
        writer.coordinate(connection.start);
        writer.coordinate(connection.end);
        writer.u8(match connection.kind {
            ConnectionKind::Land => 0,
            ConnectionKind::Water => 1,
            ConnectionKind::Road => 2,
        });
    }
    writer.u32(objects.len() as u32);
    for object in objects {
        writer.u32(object.object_id.0);
        writer.u32(object.x_256);
        writer.u32(object.y_256);
        writer.u8(object.owner);
        writer.u16(object.facet);
        writer.u16(object.footprint_width_256);
        writer.u16(object.footprint_height_256);
        writer.u8(object.presentation_kind);
        writer.i16(object.resource_type);
        writer.u32(object.resource_quantity_f32_bits);
    }
    writer.finish()
}

#[allow(clippy::too_many_arguments)]
pub fn semantic_state_hash(
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    cliffs: &[CliffEdge],
    connections: &[MapConnection],
    objects: &[PlacedObject],
) -> [u8; 32] {
    Sha256::digest(canonical_semantic_state_bytes(
        dimensions,
        terrain,
        layer,
        elevation,
        land_zone,
        terrain_zone,
        flags,
        cliffs,
        connections,
        objects,
    ))
    .into()
}

#[allow(clippy::too_many_arguments)]
pub fn presentation_stage_hash(
    stage: GenerationStage,
    dimensions: MapDimensions,
    terrain: &[TerrainId],
    layer: &[u16],
    elevation: &[i16],
    land_zone: &[u32],
    terrain_zone: &[u32],
    flags: &[TileFlags],
    cliffs: &[CliffEdge],
    connections: &[MapConnection],
    objects: &[PlacedObject],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"rms-generated-stage-v2");
    hasher.update(stage.as_str().as_bytes());
    hasher.update(semantic_state_hash(
        dimensions,
        terrain,
        layer,
        elevation,
        land_zone,
        terrain_zone,
        flags,
        cliffs,
        connections,
        objects,
    ));
    hasher.finalize().into()
}

pub trait CancellationToken: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

#[derive(Debug, Default)]
pub struct AtomicCancellationToken {
    state: AtomicU8,
}

impl AtomicCancellationToken {
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn begin_commit(&self) -> bool {
        self.state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

impl CancellationToken for AtomicCancellationToken {
    fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == 1
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NeverCancelled;

impl CancellationToken for NeverCancelled {
    fn is_cancelled(&self) -> bool {
        false
    }
}

pub trait GenerationBackend {
    fn backend_id(&self) -> &'static str;

    fn generate(
        &self,
        input: ResolvedGenerationInput<'_>,
        events: &mut dyn GenerationEventSink,
        cancellation: &dyn CancellationToken,
    ) -> Result<GeneratedMap, GenerationError>;
}

pub const MAXIMUM_QUALIFIED_EXACT_OPERATIONS: usize = 65_536;

pub fn validate_exact_semantic_scope(
    semantic_program: &SemanticProgram,
) -> Result<(), GenerationError> {
    validate_exact_operation_count(semantic_program.operations.len())
}

fn validate_exact_operation_count(operation_count: usize) -> Result<(), GenerationError> {
    if operation_count > MAXIMUM_QUALIFIED_EXACT_OPERATIONS {
        return Err(GenerationError::InvalidRequest {
            code: "RMSGEN1009",
            message: format!(
                "the script expands to {} generation steps; a preview supports up to {MAXIMUM_QUALIFIED_EXACT_OPERATIONS}",
                operation_count
            ),
        });
    }
    Ok(())
}

pub fn exact_effective_dimensions(
    semantic_program: &SemanticProgram,
    request: &GenerationRequest,
) -> Result<MapDimensions, GenerationError> {
    let mut dimensions = request.dimensions;
    for operation in semantic_program.executable_operations() {
        if operation.name == "override_map_size" {
            let side = setup_i32_argument(operation, 0)?.clamp(36, 480) as u16;
            dimensions = MapDimensions {
                width: side,
                height: side,
            };
        }
    }
    dimensions.tile_count()?;
    Ok(dimensions)
}

pub fn resolve_exact_setup_state(
    semantic_program: &SemanticProgram,
    request: &GenerationRequest,
) -> Result<ExactSetupState, GenerationError> {
    request.validate()?;
    let mut players = request
        .players
        .iter()
        .map(|player| ExactSetupPlayer {
            slot: player.slot,
            team: player.team,
            civilization_id: player.civilization_id,
        })
        .collect::<Vec<_>>();
    players.sort_by_key(|player| player.slot);
    let mut state = ExactSetupState {
        contract_version: request.setup_context.contract_version,
        map_size: request.map_size.clone(),
        requested_dimensions: request.dimensions,
        effective_dimensions: exact_effective_dimensions(semantic_program, request)?,
        game_mode: request.setup_context.game_mode,
        starting_resources: request.setup_context.starting_resources,
        starting_age: request.setup_context.starting_age,
        position_policy: request.setup_context.position_policy,
        players,
        player_positions: Vec::new(),
        placement_style: PlayerPlacementStyle::Random,
        circle_placement: None,
        nomad_resources: false,
        force_nomad_treaty: false,
        behavior_version: None,
        gaia_civilization_id: CivilizationId(0),
        computer_player_slots: request.setup_context.computer_player_slots,
        lobby_options: request.setup_context.lobby_options,
    };

    for operation in semantic_program.executable_operations() {
        if rms_semantics::is_player_setup_command(&operation.name)
            && operation.section != "player_setup"
        {
            continue;
        }
        match operation.name.as_str() {
            "random_placement" => state.placement_style = PlayerPlacementStyle::Random,
            "grouped_by_team" => state.placement_style = PlayerPlacementStyle::GroupedByTeam,
            "direct_placement" => state.placement_style = PlayerPlacementStyle::Direct,
            "nomad_resources" => state.nomad_resources = true,
            "force_nomad_treaty" => state.force_nomad_treaty = true,
            "behavior_version" => {
                state.behavior_version = Some(setup_i32_argument(operation, 0)?);
            }
            "set_gaia_civilization" => {
                let value = setup_i32_argument(operation, 0)?;
                if value < 0 {
                    return Err(invalid_request(
                        "RMSGEN2001",
                        "gaia civilization cannot be negative",
                    ));
                }
                state.gaia_civilization_id = CivilizationId(value as u32);
            }
            _ => {}
        }
    }
    state.circle_placement = resolve_player_circle_placement(
        semantic_program,
        &state.players,
        state.effective_dimensions.width,
    )?;
    state.player_positions = resolve_exact_player_positions(semantic_program, request, &state)?;
    Ok(state)
}

#[derive(Clone, Copy, Debug)]
struct PlayerLandSetup {
    slot: u8,
    base_size: i32,
    left_border: f32,
    right_border: f32,
    top_border: f32,
    bottom_border: f32,
    direct_position_percent: Option<(f32, f32)>,
}

#[derive(Clone, Debug, Default)]
struct PlayerLandLayout {
    lands: Vec<PlayerLandSetup>,
    descriptor_count: usize,
    first_descriptor: Option<FirstLandDescriptor>,
}

#[derive(Clone, Copy, Debug)]
struct FirstLandDescriptor {
    base_size: i32,
    is_player_land: bool,
}

fn resolve_exact_player_positions(
    semantic_program: &SemanticProgram,
    request: &GenerationRequest,
    state: &ExactSetupState,
) -> Result<Vec<ExactPlayerPosition>, GenerationError> {
    let layout = collect_player_land_setup(semantic_program, &state.players)?;
    let lands = &layout.lands;

    if state.placement_style == PlayerPlacementStyle::Direct {
        let positions = lands
            .iter()
            .map(|land| {
                let Some((x_percent, y_percent)) = land.direct_position_percent else {
                    return Ok(ExactPlayerPosition {
                        slot: land.slot,
                        coordinate: MapCoordinate {
                            x: native_signed_land_coordinate(-1),
                            y: native_signed_land_coordinate(-1),
                        },
                    });
                };
                Ok(ExactPlayerPosition {
                    slot: land.slot,
                    coordinate: MapCoordinate {
                        x: percent_coordinate(x_percent, state.effective_dimensions.width)?,
                        y: percent_coordinate(y_percent, state.effective_dimensions.height)?,
                    },
                })
            })
            .collect::<Result<Vec<_>, GenerationError>>()?;
        return Ok(positions);
    }

    recovered_reference_player_positions(semantic_program, request, state, &layout)
}

fn missing_player_land_warning(
    players: &[ExactSetupPlayer],
    positions: &[ExactPlayerPosition],
) -> Option<GenerationWarning> {
    let missing = players
        .iter()
        .map(|player| player.slot)
        .filter(|slot| !positions.iter().any(|position| position.slot == *slot))
        .collect::<BTreeSet<_>>();
    if missing.is_empty() {
        return None;
    }
    let slot_list = |slots: &BTreeSet<u8>| {
        slots
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let assigned = positions
        .iter()
        .map(|position| position.slot)
        .collect::<BTreeSet<_>>();
    let missing_text = if missing.len() == 1 {
        format!("lobby slot {} has none", slot_list(&missing))
    } else {
        format!("lobby slots {} have none", slot_list(&missing))
    };
    let assigned_text = if assigned.is_empty() {
        "no active player received a player land".to_owned()
    } else if assigned.len() == 1 {
        format!("only slot {} received a player land", slot_list(&assigned))
    } else {
        format!("player lands went to slots {}", slot_list(&assigned))
    };
    Some(GenerationWarning {
        code: "RMSGEN2002".to_owned(),
        message: format!(
            "an explicit player has no active player land; {missing_text} ({assigned_text}); \
             as in the game, such a player starts without a land and receives no per-player objects"
        ),
    })
}

fn undefined_object_warning(
    descriptors: &[ExactObjectDescriptor],
    content: CompatibleContentView<'_>,
) -> Option<GenerationWarning> {
    let identities = exact_object::undefined_object_identities(descriptors, content);
    if identities.is_empty() {
        return None;
    }
    let list = identities
        .iter()
        .map(|id| id.0.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let message = if identities.len() == 1 {
        format!(
            "object {list} is not defined by the selected game data; \
             as in the game, nothing is placed for it"
        )
    } else {
        format!(
            "objects {list} are not defined by the selected game data; \
             as in the game, nothing is placed for them"
        )
    };
    Some(GenerationWarning {
        code: "RMSGEN5001".to_owned(),
        message,
    })
}

fn resolve_player_circle_placement(
    semantic_program: &SemanticProgram,
    players: &[ExactSetupPlayer],
    map_width: u16,
) -> Result<Option<PlayerCirclePlacement>, GenerationError> {
    let mut placement = None;
    let blocks = exact_land::interpret_land_blocks(semantic_program, players)?;
    for operation in blocks.controller_commands {
        if operation.name != "circle_radius" {
            continue;
        }
        let radius_percent = setup_f32_argument(operation, 0)?;
        let jitter_tiles = operation
            .arguments
            .get(1)
            .map(|_| setup_i32_argument(operation, 1))
            .transpose()?
            .unwrap_or(0)
            .max(0);
        let scaled = (f32::from(map_width) * radius_percent / 100.0).round();
        if !scaled.is_finite() || scaled < i32::MIN as f32 || scaled > i32::MAX as f32 {
            return Err(invalid_request(
                "RMSGEN2002",
                "circle radius exceeds its fixed-width range",
            ));
        }
        placement = Some(PlayerCirclePlacement {
            radius_tiles: scaled as i32,
            jitter_tiles,
        });
    }
    Ok(placement)
}

fn recovered_reference_player_positions(
    semantic_program: &SemanticProgram,
    request: &GenerationRequest,
    state: &ExactSetupState,
    layout: &PlayerLandLayout,
) -> Result<Vec<ExactPlayerPosition>, GenerationError> {
    native_random_player_positions(request.seed, semantic_program, state, layout)
        .map(|(positions, _)| positions)
}

#[derive(Clone, Copy, Debug)]
struct PlayerPositionGeometry {
    minimum_x: i32,
    minimum_y: i32,
    sixty_percent_x: i32,
    sixty_percent_y: i32,
    twenty_percent_x: i32,
    circumference: i32,
}

fn native_random_player_positions(
    seed: u32,
    semantic_program: &SemanticProgram,
    state: &ExactSetupState,
    layout: &PlayerLandLayout,
) -> Result<(Vec<ExactPlayerPosition>, RmsRandom), GenerationError> {
    debug_assert_eq!(seed, semantic_program.execution_context.seed);
    let lands = layout.lands.as_slice();
    let mut rng = setup_rng_after_parser(semantic_program, state.players.len())?;
    let rejection_route = uses_rejection_player_perimeters(state);
    if !rejection_route && layout.descriptor_count == 0 {
        return Ok((Vec::new(), rng));
    }
    if state.placement_style == PlayerPlacementStyle::Direct {
        if rejection_route {
            rejection_lobby_slots(&mut rng);
            rng.next_u32();
        } else {
            let mut order = shuffled_lobby_slots(&mut rng);
            if state.position_policy == PositionPolicy::Fixed {
                preprocess_fixed_lobby_slots(state, &mut order, &mut rng);
            }
            rng.next_u32();
            for _ in lands {
                rng.next_u32();
            }
        }
        return Ok((Vec::new(), rng));
    }
    let geometry = player_position_geometry(state, lands)?;
    let circle_coordinates = state
        .circle_placement
        .is_some_and(|circle| circle.radius_tiles > 0);
    let perimeter_by_land = if rejection_route {
        rejection_player_perimeters(lands, geometry.circumference, &mut rng)?
    } else {
        let mut order = shuffled_lobby_slots(&mut rng);
        if state.position_policy == PositionPolicy::Fixed {
            preprocess_fixed_lobby_slots(state, &mut order, &mut rng);
        }
        match state.placement_style {
            PlayerPlacementStyle::Random | PlayerPlacementStyle::Direct => {
                random_player_perimeters(state, lands, &order, geometry.circumference, &mut rng)?
            }
            PlayerPlacementStyle::GroupedByTeam => {
                grouped_player_perimeters(state, layout, &order, geometry.circumference, &mut rng)?
            }
        }
    };

    let mut positions = Vec::with_capacity(lands.len());
    for (land, perimeter) in lands.iter().zip(perimeter_by_land) {
        let (x, y) = if circle_coordinates {
            circle_player_coordinate(state, land, perimeter, geometry.circumference, &mut rng)?
        } else {
            rectangular_player_coordinate(state, land, perimeter, geometry, &mut rng)?
        };
        positions.push(ExactPlayerPosition {
            slot: land.slot,
            coordinate: MapCoordinate { x, y },
        });
    }
    Ok((positions, rng))
}

fn uses_rejection_player_perimeters(state: &ExactSetupState) -> bool {
    state.position_policy == PositionPolicy::Random
}

fn shuffled_lobby_slots(rng: &mut RmsRandom) -> [u8; 8] {
    let mut order = [1_u8, 2, 3, 4, 5, 6, 7, 8];
    for index in 1..order.len() {
        let selected = native_uniform_index(rng, (index + 1) as u32) as usize;
        order.swap(index, selected);
    }
    order
}

fn native_uniform_index(rng: &mut RmsRandom, upper_exclusive: u32) -> u32 {
    debug_assert!(upper_exclusive > 0);
    let maximum_quotient = u32::MAX / upper_exclusive;
    let complete_final_bucket = u32::MAX % upper_exclusive == upper_exclusive - 1;
    loop {
        let raw = rng.next_u32();
        if complete_final_bucket || raw / upper_exclusive < maximum_quotient {
            return raw % upper_exclusive;
        }
    }
}

fn preprocess_fixed_lobby_slots(state: &ExactSetupState, order: &mut [u8; 8], rng: &mut RmsRandom) {
    let descending_selected_group = (rng.next_u32() & 0x7fff) % 100 < 50;
    let selected_team = if state.players.len() > 1 && (rng.next_u32() & 0x7fff) % 100 < 50 {
        let selected = (rng.next_u32() & 0x7fff) as usize % state.players.len();
        fixed_position_group_for_player_id(state, selected)
    } else {
        None
    };

    let teams = state
        .players
        .iter()
        .filter_map(|player| (player.team != 0).then_some(player.team))
        .collect::<BTreeSet<_>>();
    for team in teams {
        let indices = order
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                state
                    .players
                    .iter()
                    .any(|player| player.slot == *slot && player.team == team)
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        if indices.len() < 2 {
            continue;
        }
        let mut slots = indices
            .iter()
            .map(|index| order[*index])
            .collect::<Vec<_>>();
        let descending = selected_team == Some(team) && descending_selected_group
            || selected_team != Some(team) && !descending_selected_group;
        slots.sort_unstable();
        if descending {
            slots.reverse();
        }
        for (index, slot) in indices.into_iter().zip(slots) {
            order[index] = slot;
        }
    }
}

fn fixed_position_group_for_player_id(state: &ExactSetupState, player_id: usize) -> Option<u8> {
    let slot = u8::try_from(player_id).ok()?;
    state
        .players
        .iter()
        .find(|player| player.slot == slot)
        .map(|player| player.team)
}

fn native_player_land_divisor(lands: &[PlayerLandSetup]) -> Result<i32, GenerationError> {
    i32::try_from(lands.len().max(1))
        .map_err(|_| invalid_request("RMSGEN2002", "player-land count exceeds i32"))
}

fn rejection_player_perimeters(
    lands: &[PlayerLandSetup],
    circumference: i32,
    rng: &mut RmsRandom,
) -> Result<Vec<i32>, GenerationError> {
    let step = circumference.wrapping_div(native_player_land_divisor(lands)?);

    let order = rejection_lobby_slots(rng);

    let mut current = rng.bounded(circumference as u32).result as i32;
    let mut positions = vec![0_i32; lands.len()];
    for slot in order {
        for (index, land) in lands.iter().enumerate() {
            if land.slot != slot {
                continue;
            }
            positions[index] = current;
            current = current.wrapping_add(step);
            if current >= circumference {
                current = current.wrapping_sub(circumference);
            }
        }
    }
    Ok(positions)
}

fn rejection_lobby_slots(rng: &mut RmsRandom) -> [u8; 8] {
    let mut order = [0_u8; 8];
    for index in 0..order.len() {
        loop {
            let slot = rng.bounded(8).result as u8 + 1;
            if !order[..index].contains(&slot) {
                order[index] = slot;
                break;
            }
        }
    }
    order
}

fn players_share_position_group(state: &ExactSetupState, left: u8, right: u8) -> bool {
    if left == right {
        return true;
    }
    let team = |slot| {
        state
            .players
            .iter()
            .find(|player| player.slot == slot)
            .map(|player| player.team)
    };
    matches!((team(left), team(right)), (Some(left), Some(right)) if left != 0 && left == right)
}

fn random_player_perimeters(
    state: &ExactSetupState,
    lands: &[PlayerLandSetup],
    order: &[u8; 8],
    circumference: i32,
    rng: &mut RmsRandom,
) -> Result<Vec<i32>, GenerationError> {
    let land_count = native_player_land_divisor(lands)?;
    let step = circumference.wrapping_div(land_count);
    let jitter_span = step.wrapping_div(land_count);
    let mut current = rng.bounded(circumference as u32).result as i32;
    let mut handled = BTreeSet::new();
    let mut positions = vec![0_i32; lands.len()];
    for outer in order {
        for inner in order {
            if !players_share_position_group(state, *outer, *inner)
                || handled.contains(inner)
                || !lands.iter().any(|land| land.slot == *inner)
            {
                continue;
            }
            for (index, land) in lands.iter().enumerate() {
                if land.slot != *inner {
                    continue;
                }
                let mut position = (rng.bounded(jitter_span as u32).result as i32)
                    .wrapping_add(current)
                    .wrapping_sub(jitter_span / 2);
                if position < 0 {
                    position = position.wrapping_add(circumference);
                }
                if position > circumference {
                    position = position.wrapping_sub(circumference);
                }
                positions[index] = position;
                current = current.wrapping_add(step);
                if current >= circumference {
                    current = current.wrapping_sub(circumference);
                }
            }
            handled.insert(*inner);
        }
    }
    Ok(positions)
}

fn grouped_player_perimeters(
    state: &ExactSetupState,
    layout: &PlayerLandLayout,
    order: &[u8; 8],
    circumference: i32,
    rng: &mut RmsRandom,
) -> Result<Vec<i32>, GenerationError> {
    let lands = layout.lands.as_slice();
    let mut group_representatives = Vec::new();
    for player in &state.players {
        if !group_representatives
            .iter()
            .any(|representative| players_share_position_group(state, *representative, player.slot))
        {
            group_representatives.push(player.slot);
        }
    }
    let position_group_count = i32::try_from(group_representatives.len())
        .ok()
        .filter(|count| *count > 0)
        .ok_or_else(|| invalid_request("RMSGEN2002", "player-position group count exceeds i32"))?;
    let step = circumference.wrapping_div(position_group_count);
    let mut current = rng.bounded(circumference as u32).result as i32;
    if circumference == 0 {
        return Err(invalid_request(
            "RMSGEN2002",
            "grouped player placement divides by a zero perimeter, which stops the game",
        ));
    }
    let record_zero = layout.first_descriptor;
    let active_slots = state
        .players
        .iter()
        .map(|player| player.slot)
        .collect::<BTreeSet<_>>();
    let mut handled = BTreeSet::new();
    let mut positions = vec![0_i32; lands.len()];
    for outer in order {
        if handled.contains(outer) || !active_slots.contains(outer) {
            continue;
        }
        let mut members = Vec::new();
        let mut team_span = 0_i32;
        for inner in order.iter().copied().filter(|inner| {
            active_slots.contains(inner) && players_share_position_group(state, *outer, *inner)
        }) {
            let land_index = lands.iter().position(|land| land.slot == inner);
            if let Some(index) = land_index {
                team_span = team_span
                    .wrapping_add(lands[index].base_size.wrapping_mul(2))
                    .wrapping_add(5);
            }
            members.push((inner, land_index));
        }
        if !members.is_empty() {
            team_span = team_span.wrapping_sub(5);
        }
        let mut cursor = current.wrapping_sub(team_span / 2);
        for (member_index, (slot, land_index)) in members.into_iter().enumerate() {
            let (base_size, target) = match land_index {
                Some(index) => (lands[index].base_size, Some(index)),
                None => {
                    let record = record_zero.ok_or_else(|| {
                        invalid_request("RMSGEN2002", "grouped player lands are absent")
                    })?;
                    (record.base_size, record.is_player_land.then_some(0))
                }
            };
            if member_index > 0 {
                cursor = cursor
                    .wrapping_add(5)
                    .wrapping_add(base_size)
                    .wrapping_rem(circumference);
            }
            if let Some(index) = target {
                positions[index] = cursor;
            }
            handled.insert(slot);
            cursor = base_size.wrapping_add(cursor).wrapping_rem(circumference);
        }
        current = current.wrapping_add(step).wrapping_rem(circumference);
    }
    Ok(positions)
}

fn player_position_geometry(
    state: &ExactSetupState,
    lands: &[PlayerLandSetup],
) -> Result<PlayerPositionGeometry, GenerationError> {
    let dimensions = state.effective_dimensions;
    let width = i32::from(dimensions.width);
    let height = i32::from(dimensions.height);
    let mut available_width = width;
    let mut available_height = height;
    let mut minimum_x = 0_i32;
    let mut minimum_y = 0_i32;
    for land in lands {
        let left = player_border_tile(land.left_border, dimensions.width, false)?;
        let right = player_border_tile(land.right_border, dimensions.width, true)?;
        let top = player_border_tile(land.top_border, dimensions.height, false)?;
        let bottom = player_border_tile(land.bottom_border, dimensions.height, true)?;
        available_width = available_width.min(
            right
                .wrapping_sub(left)
                .wrapping_sub(land.base_size.wrapping_mul(2)),
        );
        available_height = available_height.min(
            bottom
                .wrapping_sub(top)
                .wrapping_sub(land.base_size.wrapping_mul(2)),
        );
        minimum_x = minimum_x.max(left.wrapping_add(land.base_size));
        minimum_y = minimum_y.max(top.wrapping_add(land.base_size));
    }
    let sixty_percent_x = available_width.wrapping_mul(6) / 10;
    let sixty_percent_y = available_height.wrapping_mul(6) / 10;
    let twenty_percent_x = available_width.wrapping_mul(2) / 10;
    let circumference = if let Some(circle) = state.circle_placement
        && circle.radius_tiles > 0
    {
        (circle.radius_tiles as f32 * std::f32::consts::TAU).trunc() as i32
    } else {
        2_i32.wrapping_mul(sixty_percent_x.wrapping_add(sixty_percent_y))
    };
    Ok(PlayerPositionGeometry {
        minimum_x,
        minimum_y,
        sixty_percent_x,
        sixty_percent_y,
        twenty_percent_x,
        circumference,
    })
}

fn rectangular_player_coordinate(
    state: &ExactSetupState,
    land: &PlayerLandSetup,
    perimeter: i32,
    geometry: PlayerPositionGeometry,
    rng: &mut RmsRandom,
) -> Result<(u16, u16), GenerationError> {
    let x_segment = geometry.sixty_percent_x;
    let y_segment = geometry.sixty_percent_y;
    let twenty = geometry.twenty_percent_x;
    let first_boundary = x_segment;
    let second_boundary = x_segment.wrapping_add(y_segment);
    let third_boundary = x_segment.wrapping_mul(2).wrapping_add(y_segment);
    let jitter_half = twenty / 2;
    let jitter =
        |rng: &mut RmsRandom| (rng.bounded(twenty as u32).result as i32).wrapping_sub(jitter_half);
    let (x, y) = if perimeter < first_boundary {
        (
            perimeter
                .wrapping_add(twenty)
                .wrapping_add(geometry.minimum_x),
            geometry
                .minimum_y
                .wrapping_add(jitter_half)
                .wrapping_add(jitter(rng)),
        )
    } else if perimeter < second_boundary {
        (
            geometry
                .minimum_x
                .wrapping_add(x_segment)
                .wrapping_add(twenty)
                .wrapping_add(jitter_half)
                .wrapping_add(jitter(rng)),
            perimeter
                .wrapping_sub(x_segment)
                .wrapping_add(twenty)
                .wrapping_add(geometry.minimum_y),
        )
    } else if perimeter < third_boundary {
        (
            second_boundary
                .wrapping_sub(perimeter)
                .wrapping_add(twenty)
                .wrapping_add(x_segment)
                .wrapping_add(geometry.minimum_x),
            geometry
                .minimum_y
                .wrapping_add(y_segment)
                .wrapping_add(twenty)
                .wrapping_add(jitter_half)
                .wrapping_add(jitter(rng)),
        )
    } else {
        (
            geometry
                .minimum_x
                .wrapping_add(jitter_half)
                .wrapping_add(jitter(rng)),
            third_boundary
                .wrapping_sub(perimeter)
                .wrapping_add(twenty)
                .wrapping_add(y_segment)
                .wrapping_add(geometry.minimum_y),
        )
    };
    checked_player_coordinate(state, land, x, y)
}

fn circle_player_coordinate(
    state: &ExactSetupState,
    land: &PlayerLandSetup,
    perimeter: i32,
    circumference: i32,
    rng: &mut RmsRandom,
) -> Result<(u16, u16), GenerationError> {
    let circle = state
        .circle_placement
        .expect("positive circle placement was checked");
    let angle = (std::f32::consts::TAU / circumference as f32) * perimeter as f32;
    let center = (i32::from(state.effective_dimensions.width) / 2) as f32;
    let radius = circle.radius_tiles as f32;
    let mut x = (angle.cos() * radius + center).trunc() as i32;
    let mut y = (angle.sin() * radius + center).trunc() as i32;
    if circle.jitter_tiles > 0 {
        let span = u32::try_from(circle.jitter_tiles.saturating_mul(2)).map_err(|_| {
            invalid_request(
                "RMSGEN2002",
                "circle jitter is outside the range the preview supports",
            )
        })?;
        x += rng.bounded(span).result as i32 - circle.jitter_tiles;
        y += rng.bounded(span).result as i32 - circle.jitter_tiles;
    }
    let clamp = |value: i32, maximum: i32| {
        if value < land.base_size {
            land.base_size
        } else if value > maximum {
            maximum
        } else {
            value
        }
    };
    x = clamp(
        x,
        i32::from(state.effective_dimensions.width) - land.base_size,
    );
    y = clamp(
        y,
        i32::from(state.effective_dimensions.height) - land.base_size,
    );
    checked_player_coordinate(state, land, x, y)
}

fn checked_player_coordinate(
    state: &ExactSetupState,
    _land: &PlayerLandSetup,
    x: i32,
    y: i32,
) -> Result<(u16, u16), GenerationError> {
    if x < 0 || y < 0 {
        return Ok((
            native_signed_land_coordinate(x),
            native_signed_land_coordinate(y),
        ));
    }
    let x = u16::try_from(x).ok();
    let y = u16::try_from(y).ok();
    match (x, y) {
        (Some(x), Some(y))
            if x < state.effective_dimensions.width && y < state.effective_dimensions.height =>
        {
            Ok((x, y))
        }
        _ => Err(invalid_request(
            "RMSGEN2002",
            "player positioning put a player start beyond the map edge; the preview cannot place player lands outside the map",
        )),
    }
}

fn native_signed_land_coordinate(value: i32) -> u16 {
    value.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16 as u16
}

fn player_border_tile(
    percent: f32,
    dimension: u16,
    from_far_edge: bool,
) -> Result<i32, GenerationError> {
    exact_land::native_border_tile(percent, dimension, from_far_edge).ok_or_else(|| {
        invalid_request(
            "RMSGEN2002",
            "player-land border exceeds its fixed-width range",
        )
    })
}

fn collect_player_land_setup(
    semantic_program: &SemanticProgram,
    players: &[ExactSetupPlayer],
) -> Result<PlayerLandLayout, GenerationError> {
    let blocks = exact_land::interpret_land_blocks(semantic_program, players)?;
    let mut lands = Vec::new();
    let mut first_descriptor = None;
    for record in &blocks.records {
        let mut base_size = 3;
        let mut left_border = 0.0;
        let mut right_border = 0.0;
        let mut top_border = 0.0;
        let mut bottom_border = 0.0;
        let mut assigned_slot = record.player_slot;
        let mut direct_position_percent = None;
        for command in &record.commands {
            if let Some(slot) = command.assignment {
                assigned_slot = Some(slot);
                continue;
            }
            let property = command.operation;
            match property.name.as_str() {
                "base_size" => base_size = setup_i32_argument(property, 0)?,
                "left_border" => left_border = setup_border_percent(property)?,
                "right_border" => right_border = setup_border_percent(property)?,
                "top_border" => top_border = setup_border_percent(property)?,
                "bottom_border" => bottom_border = setup_border_percent(property)?,
                "land_position" => {
                    direct_position_percent = Some((
                        setup_f32_argument(property, 0)?,
                        setup_f32_argument(property, 1)?,
                    ));
                }
                _ => {}
            }
        }
        if base_size < 0 {
            return Err(invalid_request(
                "RMSGEN2002",
                "player-land base size exceeds its fixed-width range",
            ));
        }
        let owner = assigned_slot.filter(|slot| *slot > 0);
        if first_descriptor.is_none() {
            first_descriptor = Some(FirstLandDescriptor {
                base_size,
                is_player_land: owner.is_some(),
            });
        }
        if let Some(slot) = owner {
            lands.push(PlayerLandSetup {
                slot,
                base_size,
                left_border,
                right_border,
                top_border,
                bottom_border,
                direct_position_percent,
            });
        }
    }
    Ok(PlayerLandLayout {
        lands,
        descriptor_count: blocks.records.len(),
        first_descriptor,
    })
}

fn is_at_player_assignment(argument: Option<&ResolvedArgument>) -> bool {
    argument.is_some_and(|argument| match argument.kind {
        ArgumentKind::Identifier => argument.value == "AT_PLAYER",
        ArgumentKind::Number => argument.value == "0",
        _ => false,
    })
}

fn percent_coordinate(percent: f32, dimension: u16) -> Result<u16, GenerationError> {
    if !(0.0..=100.0).contains(&percent) {
        return Err(invalid_request(
            "RMSGEN2002",
            "land_position percentages must be between 0 and 100",
        ));
    }
    let scaled = f32::from(dimension) * percent / 100.0;
    let coordinate = scaled.round().clamp(0.0, f32::from(dimension));
    Ok(coordinate as u16)
}

fn setup_i32_argument(
    operation: &rms_semantics::SemanticOperation,
    index: usize,
) -> Result<i32, GenerationError> {
    setup_i32_value(setup_f32_argument(operation, index)?)
}

fn setup_border_percent(
    operation: &rms_semantics::SemanticOperation,
) -> Result<f32, GenerationError> {
    let percent = setup_f32_argument(operation, 0)?;
    if !percent.is_finite() {
        return Err(invalid_request(
            "RMSGEN2001",
            "player-land border percentage is not finite",
        ));
    }
    Ok(percent)
}

fn setup_f32_argument(
    operation: &rms_semantics::SemanticOperation,
    index: usize,
) -> Result<f32, GenerationError> {
    operation
        .arguments
        .get(index)
        .ok_or_else(|| invalid_request("RMSGEN2001", "setup operation is missing an argument"))?
        .value
        .parse::<f32>()
        .map_err(|_| invalid_request("RMSGEN2001", "setup operation argument is not numeric"))
}

fn setup_i32_value(value: f32) -> Result<i32, GenerationError> {
    if !value.is_finite() || value < i32::MIN as f32 || value > i32::MAX as f32 {
        return Err(invalid_request(
            "RMSGEN2001",
            "setup operation argument exceeds fixed-width range",
        ));
    }
    Ok(value.round() as i32)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ExactRmsGenerationBackend;

impl GenerationBackend for ExactRmsGenerationBackend {
    fn backend_id(&self) -> &'static str {
        "exact-rms-v1"
    }

    fn generate(
        &self,
        input: ResolvedGenerationInput<'_>,
        events: &mut dyn GenerationEventSink,
        cancellation: &dyn CancellationToken,
    ) -> Result<GeneratedMap, GenerationError> {
        self.generate_observed(input, events, cancellation, &mut NoopExecutionObserver)
    }
}

impl ExactRmsGenerationBackend {
    pub fn generate_observed(
        &self,
        input: ResolvedGenerationInput<'_>,
        events: &mut dyn GenerationEventSink,
        cancellation: &dyn CancellationToken,
        observer: &mut dyn ExecutionObserver,
    ) -> Result<GeneratedMap, GenerationError> {
        input.validate_for_backend(self.backend_id())?;
        validate_exact_semantic_scope(input.semantic_program)?;
        cancellation_checkpoint(cancellation, GenerationStage::Setup, 0)?;
        let rng = replay_parser_rng(input.semantic_program, cancellation)?;
        let mut sequence = 0_u64;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Setup,
                kind: GenerationEventKind::StageStarted,
                completed: 0,
                total: input.semantic_program.rng_draws.len() as u64,
                state_hash: None,
                detail: Some("exact RMS orchestration".to_owned()),
                mutations: None,
            },
            false,
        )?;
        for draw in &input.semantic_program.rng_draws {
            cancellation_checkpoint(cancellation, GenerationStage::Setup, draw.sample.ordinal)?;
            emit_exact_event(
                input.request.trace_level,
                events,
                &mut sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Setup,
                    kind: GenerationEventKind::RngCheckpoint,
                    completed: draw.sample.ordinal,
                    total: input.semantic_program.rng_state_after_parser.draws(),
                    state_hash: Some(draw.sample.checkpoint_hash()),
                    detail: Some(draw.purpose.as_str().to_owned()),
                    mutations: None,
                },
                true,
            )?;
        }
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Setup,
                kind: GenerationEventKind::RngCheckpoint,
                completed: rng.state().draws(),
                total: rng.state().draws(),
                state_hash: Some(rng.state().checkpoint_hash()),
                detail: Some("parser-to-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        observer.step_started(ExecutionStep::SetupPlayers);
        let setup = resolve_exact_setup_state(input.semantic_program, input.request)?;
        let tile_count = setup.effective_dimensions.tile_count()?;
        let setup_rng =
            resolve_exact_setup_generator_rng(input.request.seed, &setup, input.semantic_program)?;
        observer.step_finished(
            ExecutionStep::SetupPlayers,
            &[(
                ExecutionCounter::RngDraws,
                setup_rng
                    .state()
                    .draws()
                    .saturating_sub(rng.state().draws()),
            )],
        );
        let blank_layer = vec![0; tile_count];
        let presentation_flags = vec![TileFlags::default(); tile_count];
        let blank_terrain = vec![TerrainId(0); tile_count];
        let blank_elevation = vec![0; tile_count];
        let blank_land_zone = vec![0; tile_count];
        let blank_terrain_zone = vec![0; tile_count];
        let setup_stage_hash = presentation_stage_hash(
            GenerationStage::Setup,
            setup.effective_dimensions,
            &blank_terrain,
            &blank_layer,
            &blank_elevation,
            &blank_land_zone,
            &blank_terrain_zone,
            &presentation_flags,
            &[],
            &[],
            &[],
        );
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Setup,
                kind: GenerationEventKind::RngCheckpoint,
                completed: setup_rng.state().draws(),
                total: setup_rng.state().draws(),
                state_hash: Some(setup_rng.state().checkpoint_hash()),
                detail: Some("player-position-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Setup,
            setup_rng.state().draws(),
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Setup,
                kind: GenerationEventKind::StageCompleted,
                completed: setup_rng.state().draws(),
                total: setup_rng.state().draws(),
                state_hash: Some(setup_stage_hash),
                detail: Some("typed global/player setup 1.0 complete".to_owned()),
                mutations: None,
            },
            false,
        )?;
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Land,
            setup_rng.state().draws(),
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::StageStarted,
                completed: 0,
                total: setup.effective_dimensions.tile_count()? as u64,
                state_hash: None,
                detail: Some("exact RMS land generation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        let setup_rng_draws = setup_rng.state().draws();
        observer.step_started(ExecutionStep::LandGenerate);
        let land = exact_land::resolve_exact_land_state(
            input.semantic_program,
            &setup,
            input.content,
            setup_rng,
            cancellation,
        )?;
        observer.step_finished(
            ExecutionStep::LandGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    land.rng_state.draws().saturating_sub(setup_rng_draws),
                ),
                (
                    ExecutionCounter::CandidatesExamined,
                    land.statistics.popped_candidates,
                ),
                (
                    ExecutionCounter::TilesAccepted,
                    land.statistics.accepted_tiles,
                ),
            ],
        );
        observer.visual_boundary(
            VisualStage::Land,
            &VisualState {
                dimensions: land.dimensions,
                terrain: &land.terrain,
                elevation: &land.elevation,
                cliffs: &[],
                objects: &[],
            },
        );
        let presentation_land_zone = exact_land::project_search_zones(&land.search_zone);
        emit_exact_land_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &land,
            &presentation_land_zone,
            cancellation,
        )?;
        let land_stage_hash = presentation_stage_hash(
            GenerationStage::Land,
            land.dimensions,
            &land.terrain,
            &land.elevation_land_id,
            &land.elevation,
            &presentation_land_zone,
            &blank_terrain_zone,
            &presentation_flags,
            &[],
            &[],
            &[],
        );
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::RngCheckpoint,
                completed: land.rng_state.draws(),
                total: land.rng_state.draws(),
                state_hash: Some(land.rng_state.checkpoint_hash()),
                detail: Some("land-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::StageCompleted,
                completed: land.statistics.popped_candidates,
                total: land.statistics.popped_candidates,
                state_hash: Some(land_stage_hash),
                detail: Some("exact land state complete".to_owned()),
                mutations: None,
            },
            false,
        )?;
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Terrain,
            land.rng_state.draws(),
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::StageStarted,
                completed: 0,
                total: land.dimensions.tile_count()? as u64,
                state_hash: None,
                detail: Some("exact RMS elevation generation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        observer.step_started(ExecutionStep::ElevationGenerate);
        let elevation = exact_elevation::resolve_exact_elevation_state(
            input.semantic_program,
            &land,
            input.content,
            RmsRandom::from_state(land.rng_state),
            cancellation,
        )?;
        observer.step_finished(
            ExecutionStep::ElevationGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    elevation
                        .rng_state
                        .draws()
                        .saturating_sub(land.rng_state.draws()),
                ),
                (
                    ExecutionCounter::CandidatesExamined,
                    elevation.statistics.popped_candidates,
                ),
                (
                    ExecutionCounter::TilesAccepted,
                    elevation.statistics.accepted_tiles,
                ),
            ],
        );
        observer.visual_boundary(
            VisualStage::Elevation,
            &VisualState {
                dimensions: land.dimensions,
                terrain: &land.terrain,
                elevation: &elevation.elevation,
                cliffs: &[],
                objects: &[],
            },
        );
        emit_exact_elevation_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &land,
            &presentation_land_zone,
            &elevation,
            cancellation,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::RngCheckpoint,
                completed: elevation.rng_state.draws(),
                total: elevation.rng_state.draws(),
                state_hash: Some(elevation.rng_state.checkpoint_hash()),
                detail: Some("elevation-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        observer.step_started(ExecutionStep::CliffsGenerate);
        let cliff = exact_cliff::resolve_exact_cliff_state(
            input.semantic_program,
            &land,
            &elevation,
            input.content,
            RmsRandom::from_state(elevation.rng_state),
            cancellation,
        )?;
        observer.step_finished(
            ExecutionStep::CliffsGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    cliff
                        .rng_state
                        .draws()
                        .saturating_sub(elevation.rng_state.draws()),
                ),
                (
                    ExecutionCounter::CandidatesExamined,
                    cliff.statistics.candidate_count,
                ),
            ],
        );
        observer.visual_boundary(
            VisualStage::Cliffs,
            &VisualState {
                dimensions: land.dimensions,
                terrain: &cliff.terrain,
                elevation: &elevation.elevation,
                cliffs: &cliff.cliffs,
                objects: &[],
            },
        );
        emit_exact_cliff_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &presentation_land_zone,
            &elevation,
            &cliff,
            cancellation,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::RngCheckpoint,
                completed: cliff.rng_state.draws(),
                total: cliff.rng_state.draws(),
                state_hash: Some(cliff.rng_state.checkpoint_hash()),
                detail: Some("cliff-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        observer.step_started(ExecutionStep::TerrainGenerate);
        let terrain = exact_terrain::resolve_exact_terrain_state(
            input.semantic_program,
            &land,
            &elevation,
            &cliff,
            input.content,
            RmsRandom::from_state(cliff.rng_state),
            cancellation,
        )?;
        observer.step_finished(
            ExecutionStep::TerrainGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    terrain
                        .rng_state
                        .draws()
                        .saturating_sub(cliff.rng_state.draws()),
                ),
                (
                    ExecutionCounter::TilesAccepted,
                    terrain
                        .statistics
                        .layers
                        .iter()
                        .fold(0_u64, |total, layer| {
                            total.saturating_add(layer.accepted_tiles)
                        }),
                ),
            ],
        );
        observer.visual_boundary(
            VisualStage::Terrain,
            &VisualState {
                dimensions: land.dimensions,
                terrain: &terrain.terrain,
                elevation: &terrain.elevation,
                cliffs: &cliff.cliffs,
                objects: &[],
            },
        );
        emit_exact_terrain_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &presentation_land_zone,
            &terrain,
            cancellation,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::RngCheckpoint,
                completed: terrain.rng_state.draws(),
                total: terrain.rng_state.draws(),
                state_hash: Some(terrain.rng_state.checkpoint_hash()),
                detail: Some("terrain-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        observer.step_started(ExecutionStep::ConnectionsGenerate);
        let connection = exact_connection::resolve_exact_connection_state_with_substages(
            input.semantic_program,
            &setup,
            &land,
            &terrain,
            input.content,
            RmsRandom::from_state(terrain.rng_state),
            cancellation,
            &mut |connection_terrain| {
                observer.visual_substage(
                    VisualStage::Connections,
                    &VisualState {
                        dimensions: land.dimensions,
                        terrain: connection_terrain,
                        elevation: &terrain.elevation,
                        cliffs: &cliff.cliffs,
                        objects: &[],
                    },
                );
            },
        )?;
        observer.step_finished(
            ExecutionStep::ConnectionsGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    connection
                        .rng_state
                        .draws()
                        .saturating_sub(terrain.rng_state.draws()),
                ),
                (
                    ExecutionCounter::TilesAccepted,
                    connection.statistics.painted_tiles,
                ),
                (
                    ExecutionCounter::PathSearches,
                    connection.statistics.path_attempts,
                ),
                (ExecutionCounter::PathWork, connection.statistics.path_work),
            ],
        );
        observer.visual_boundary(
            VisualStage::Connections,
            &VisualState {
                dimensions: connection.dimensions,
                terrain: &connection.terrain,
                elevation: &connection.elevation,
                cliffs: &cliff.cliffs,
                objects: &[],
            },
        );
        emit_exact_connection_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &presentation_land_zone,
            &connection,
            cancellation,
        )?;
        let terrain_stage_hash = presentation_stage_hash(
            GenerationStage::Terrain,
            connection.dimensions,
            &connection.terrain,
            &connection.land_id,
            &connection.elevation,
            &presentation_land_zone,
            &connection.terrain_zone,
            &presentation_flags,
            &cliff.cliffs,
            &connection.connections,
            &[],
        );
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::RngCheckpoint,
                completed: connection.rng_state.draws(),
                total: connection.rng_state.draws(),
                state_hash: Some(connection.rng_state.checkpoint_hash()),
                detail: Some("connection-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::StageCompleted,
                completed: connection
                    .statistics
                    .path_work
                    .saturating_add(connection.statistics.painted_tiles),
                total: connection
                    .statistics
                    .path_work
                    .saturating_add(connection.statistics.painted_tiles),
                state_hash: Some(terrain_stage_hash),
                detail: Some("exact terrain and connection state complete".to_owned()),
                mutations: None,
            },
            false,
        )?;
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Objects,
            connection.rng_state.draws(),
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Objects,
                kind: GenerationEventKind::StageStarted,
                completed: 0,
                total: input
                    .semantic_program
                    .executable_operations()
                    .filter(|operation| {
                        operation.section == "objects_generation"
                            && operation.depth == 0
                            && operation.name == "create_object"
                    })
                    .count() as u64,
                state_hash: None,
                detail: Some("exact RMS object generation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        exact_zone::refuse_terrain_past_restriction_tables(&connection.terrain, input.content)?;
        observer.step_started(ExecutionStep::ObjectsGenerate);
        let mut object = exact_object::resolve_exact_object_state_with_substages(
            input.semantic_program,
            &setup,
            &land,
            &cliff,
            &connection,
            input.content,
            RmsRandom::from_state(connection.rng_state),
            RmsRandom::from_state(cliff.auxiliary_rng_state),
            cancellation,
            &mut |object_terrain, objects| {
                observer.visual_substage(
                    VisualStage::Objects,
                    &VisualState {
                        dimensions: connection.dimensions,
                        terrain: object_terrain,
                        elevation: &connection.elevation,
                        cliffs: &cliff.cliffs,
                        objects,
                    },
                );
            },
        )?;
        exact_zone::refuse_terrain_past_restriction_tables(&object.terrain, input.content)?;
        observer.step_finished(
            ExecutionStep::ObjectsGenerate,
            &[
                (
                    ExecutionCounter::RngDraws,
                    object
                        .rng_state
                        .draws()
                        .saturating_sub(connection.rng_state.draws()),
                ),
                (
                    ExecutionCounter::CandidatesExamined,
                    object.statistics.candidate_tiles,
                ),
                (
                    ExecutionCounter::PlacementRejections,
                    object.statistics.rejected_groups,
                ),
                (ExecutionCounter::ObjectsPlaced, object.objects.len() as u64),
            ],
        );
        observer.visual_boundary(
            VisualStage::Objects,
            &VisualState {
                dimensions: connection.dimensions,
                terrain: &object.terrain,
                elevation: &connection.elevation,
                cliffs: &cliff.cliffs,
                objects: &object.objects,
            },
        );
        emit_exact_object_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &presentation_land_zone,
            &connection,
            &object,
            cancellation,
        )?;
        let object_stage_hash = presentation_stage_hash(
            GenerationStage::Objects,
            connection.dimensions,
            &object.terrain,
            &object.land_id,
            &connection.elevation,
            &presentation_land_zone,
            &connection.terrain_zone,
            &presentation_flags,
            &cliff.cliffs,
            &connection.connections,
            &object.objects,
        );
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Objects,
                kind: GenerationEventKind::RngCheckpoint,
                completed: object.rng_state.draws(),
                total: object.rng_state.draws(),
                state_hash: Some(object.rng_state.checkpoint_hash()),
                detail: Some("object-generator-continuation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Objects,
                kind: GenerationEventKind::StageCompleted,
                completed: object.objects.len() as u64,
                total: object.objects.len() as u64,
                state_hash: Some(object_stage_hash),
                detail: Some("exact object state complete".to_owned()),
                mutations: None,
            },
            false,
        )?;
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Finalize,
            object.objects.len() as u64,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Finalize,
                kind: GenerationEventKind::StageStarted,
                completed: 0,
                total: 1,
                state_hash: None,
                detail: Some("exact semantic commit preparation".to_owned()),
                mutations: None,
            },
            false,
        )?;
        let provenance = input
            .semantic_program
            .operations
            .iter()
            .map(|operation| ProvenanceReference {
                source_id: operation.source_id.as_str().to_owned(),
                byte_start: operation.source_range.start.0,
                byte_end: operation.source_range.end.0,
                operation_identity: operation.identity,
            })
            .collect::<Vec<_>>();
        let objects_before_finalization = object.objects.len() as u64;
        let draws_before_finalization = object.rng_state.draws();
        observer.step_started(ExecutionStep::FinalizeGameMode);
        let mut post_rms_rng = RmsRandom::from_state(object.rng_state);
        consume_post_rms_generation_boundaries(&mut post_rms_rng);
        object.rng_state = post_rms_rng.state();
        exact_object::finalize_player_starts(
            &mut object,
            &setup,
            &connection,
            input.semantic_program,
            NativeGenerationProgramMode::for_explicit_seed(input.request.seed),
            input.content,
            cancellation,
        )?;
        exact_terrain::finalize_game_mode_terrain(
            connection.dimensions,
            &mut object.terrain,
            &mut object.land_id,
            setup.game_mode.native_value(),
            input.content,
        )?;
        exact_object::finalize_game_mode_player_objects(
            &mut object,
            &setup,
            &land,
            &connection,
            NativeGenerationProgramMode::for_explicit_seed(input.request.seed),
            input.content,
            cancellation,
        )?;
        observer.step_finished(
            ExecutionStep::FinalizeGameMode,
            &[
                (
                    ExecutionCounter::RngDraws,
                    object
                        .rng_state
                        .draws()
                        .saturating_sub(draws_before_finalization),
                ),
                (
                    ExecutionCounter::ObjectsPlaced,
                    (object.objects.len() as u64).saturating_sub(objects_before_finalization),
                ),
            ],
        );
        observer.step_started(ExecutionStep::FinalizeObjectOrder);
        let (final_objects, final_object_operation_indices) =
            match exact_object::native_identity_order(&object.objects, input.content) {
                None => (
                    object.objects.clone(),
                    object.object_operation_indices.clone(),
                ),
                Some(order) => (
                    order
                        .iter()
                        .map(|&index| object.objects[index].clone())
                        .collect(),
                    order
                        .iter()
                        .map(|&index| object.object_operation_indices[index])
                        .collect(),
                ),
            };
        observer.step_finished(ExecutionStep::FinalizeObjectOrder, &[]);
        observer.step_started(ExecutionStep::FinalizeCompositeTerrain);
        let mut final_terrain = object.terrain.clone();
        let mut final_layer = object.land_id.clone();
        exact_terrain::finalize_composite_terrain(
            &mut final_terrain,
            &mut final_layer,
            input.content,
        )?;
        observer.step_finished(ExecutionStep::FinalizeCompositeTerrain, &[]);
        let mut presentation_adjustments = PresentationAdjustments::default();
        let cliff_pieces = presentation_cliff_pieces(
            object.module_exit_pieces(),
            input
                .content
                .cliff(u32::from(cliff.configuration.cliff_type)),
            connection.dimensions,
            &mut presentation_adjustments,
        );
        let appearance_objects = presentation_appearance_objects(
            &object.standing_appearance_objects(),
            input.content,
            connection.dimensions,
            &mut presentation_adjustments,
        );
        let mut map = GeneratedMap {
            dimensions: connection.dimensions,
            terrain: final_terrain,
            pre_connection_terrain: terrain.terrain,
            layer: final_layer,
            elevation: connection.elevation.clone(),
            land_zone: presentation_land_zone,
            terrain_zone: connection.terrain_zone.clone(),
            flags: presentation_flags,
            cliffs: cliff.cliffs.clone(),
            cliff_pieces,
            appearance_objects,
            connections: connection.connections.clone(),
            connection_routes: ConnectionRoutes::from_connection_state(&connection),
            objects: final_objects,
            tile_operation_indices: object.tile_operation_indices.clone(),
            object_operation_indices: final_object_operation_indices,
            cliff_operation_indices: cliff.cliff_operation_indices.clone(),
            connection_operation_indices: connection.connection_operation_indices.clone(),
            stage_hashes: vec![
                (GenerationStage::Setup, setup_stage_hash),
                (GenerationStage::Land, land_stage_hash),
                (GenerationStage::Terrain, terrain_stage_hash),
                (GenerationStage::Objects, object_stage_hash),
                (GenerationStage::Finalize, [0; 32]),
            ],
            final_semantic_hash: [0; 32],
            warnings: missing_player_land_warning(&setup.players, &setup.player_positions)
                .into_iter()
                .chain(undefined_object_warning(&object.descriptors, input.content))
                .collect(),
            metrics: GenerationMetrics {
                tile_count: tile_count as u64,
                object_count: object.objects.len() as u64,
                allocated_bytes: exact_allocation_bytes(tile_count, &cliff, &connection, &object),
                emitted_events: sequence.saturating_add(1),
                counters: BTreeMap::from([
                    (
                        "object-appearance-rng-draws".to_owned(),
                        object.statistics.appearance_rng_draws,
                    ),
                    (
                        "object-candidate-rng-draws".to_owned(),
                        object.statistics.candidate_rng_draws,
                    ),
                    (
                        "object-placement-rng-draws".to_owned(),
                        object.statistics.placement_rng_draws,
                    ),
                    (
                        "object-auxiliary-rng-draws".to_owned(),
                        object.statistics.auxiliary_rng_draws,
                    ),
                    (
                        "object-rejected-groups".to_owned(),
                        object.statistics.rejected_groups,
                    ),
                    (
                        "object-exhausted-descriptors".to_owned(),
                        object.statistics.exhausted_descriptors,
                    ),
                    (
                        "object-foundation-tiles-painted".to_owned(),
                        object.statistics.foundation_tiles_painted,
                    ),
                ])
                .into_iter()
                .chain(presentation_adjustments.counters())
                .collect(),
            },
            provenance,
        };
        map.finalize_semantic_hash()?;
        let finalize_stage_hash = presentation_stage_hash(
            GenerationStage::Finalize,
            map.dimensions,
            &map.terrain,
            &map.layer,
            &map.elevation,
            &map.land_zone,
            &map.terrain_zone,
            &map.flags,
            &map.cliffs,
            &map.connections,
            &map.objects,
        );
        map.stage_hashes[4].1 = finalize_stage_hash;
        map.validate()?;
        emit_exact_final_trace(
            input.request.trace_level,
            events,
            &mut sequence,
            &map,
            cancellation,
        )?;
        emit_exact_event(
            input.request.trace_level,
            events,
            &mut sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Finalize,
                kind: GenerationEventKind::StageCompleted,
                completed: 1,
                total: 1,
                state_hash: Some(finalize_stage_hash),
                detail: Some("exact semantic map committed".to_owned()),
                mutations: None,
            },
            false,
        )?;
        Ok(map)
    }
}

fn consume_post_rms_generation_boundaries(rng: &mut RmsRandom) {
    rng.next_u32();
    rng.next_u32();
}

fn emit_exact_final_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    map: &GeneratedMap,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let tile_count = map.terrain.len();
    for first in (0..tile_count).step_by(1024) {
        cancellation_checkpoint(cancellation, GenerationStage::Finalize, first as u64)?;
        let end = (first + 1024).min(tile_count);
        let tiles = (first..end)
            .map(|index| TileMutation {
                tile_index: index as u32,
                terrain_id: map.terrain[index].0,
                elevation: map.elevation[index],
                terrain_zone: map.terrain_zone[index],
                land_id: map.land_zone[index],
                layer_id: map.layer[index],
                flags: map.flags[index].0,
                operation: MutationOperation::Replace,
                provenance_operation_index: map.tile_operation_indices[index],
            })
            .collect();
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Finalize,
                kind: GenerationEventKind::MutationBatch,
                completed: end as u64,
                total: tile_count as u64,
                state_hash: None,
                detail: Some("committed semantic tiles".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    ..MutationBatch::default()
                }),
            },
            true,
        )?;
    }
    for first in (0..map.objects.len()).step_by(256) {
        cancellation_checkpoint(cancellation, GenerationStage::Finalize, first as u64)?;
        let end = (first + 256).min(map.objects.len());
        let objects = (first..end)
            .map(|index| {
                let placed = &map.objects[index];
                ObjectMutation {
                    object_index: index as u32,
                    object_id: placed.object_id.0,
                    x_256: placed.x_256,
                    y_256: placed.y_256,
                    owner: placed.owner,
                    facet: placed.facet,
                    footprint_width_256: placed.footprint_width_256,
                    footprint_height_256: placed.footprint_height_256,
                    presentation_kind: placed.presentation_kind,
                    operation: MutationOperation::Replace,
                    provenance_operation_index: map.object_operation_indices[index],
                    resource_type: placed.resource_type,
                    resource_quantity_f32_bits: placed.resource_quantity_f32_bits,
                    resource_delta: placed.resource_delta,
                    status: placed.status,
                    death_state: i32::from(placed.death_state),
                    data_status: i32::from(placed.data_status),
                    selection_flags: u32::from(placed.selection_flags),
                    behavior_flags: u32::from(placed.behavior_flags),
                }
            })
            .collect();
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Finalize,
                kind: GenerationEventKind::MutationBatch,
                completed: end as u64,
                total: map.objects.len() as u64,
                state_hash: None,
                detail: Some("committed semantic objects".to_owned()),
                mutations: Some(MutationBatch {
                    objects,
                    ..MutationBatch::default()
                }),
            },
            true,
        )?;
    }
    Ok(())
}

fn emit_exact_object_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    presentation_land_zone: &[u32],
    connection: &ExactConnectionState,
    object: &ExactObjectState,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let changed_tiles = object
        .terrain
        .iter()
        .zip(&connection.terrain)
        .zip(object.land_id.iter().zip(&connection.land_id))
        .filter(
            |((after_terrain, before_terrain), (after_land, before_land))| {
                after_terrain != before_terrain || after_land != before_land
            },
        )
        .count() as u64;
    let mut tiles = Vec::with_capacity(256);
    let mut emitted = 0_u64;
    for (index, ((after_terrain, before_terrain), (after_land, before_land))) in object
        .terrain
        .iter()
        .zip(&connection.terrain)
        .zip(object.land_id.iter().zip(&connection.land_id))
        .enumerate()
    {
        if after_terrain == before_terrain && after_land == before_land {
            continue;
        }
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: after_terrain.0,
            elevation: connection.elevation[index],
            terrain_zone: connection.terrain_zone[index],
            land_id: presentation_land_zone[index],
            layer_id: *after_land,
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: object.tile_operation_indices[index],
        });
        if tiles.len() == 256 {
            cancellation_checkpoint(cancellation, GenerationStage::Objects, emitted)?;
            emitted += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Objects,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted,
                    total: changed_tiles,
                    state_hash: None,
                    detail: Some("exact object foundation map replacement".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
        }
    }
    if !tiles.is_empty() {
        emitted += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Objects,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted,
                total: changed_tiles,
                state_hash: None,
                detail: Some("exact object foundation terrain".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    for first in (0..object.objects.len()).step_by(256) {
        cancellation_checkpoint(cancellation, GenerationStage::Objects, first as u64)?;
        let end = (first + 256).min(object.objects.len());
        let mutations = object.objects[first..end]
            .iter()
            .zip(&object.object_operation_indices[first..end])
            .enumerate()
            .map(|(offset, (placed, operation_index))| ObjectMutation {
                object_index: (first + offset) as u32,
                object_id: placed.object_id.0,
                x_256: placed.x_256,
                y_256: placed.y_256,
                owner: placed.owner,
                facet: placed.facet,
                footprint_width_256: placed.footprint_width_256,
                footprint_height_256: placed.footprint_height_256,
                presentation_kind: placed.presentation_kind,
                operation: MutationOperation::Replace,
                provenance_operation_index: *operation_index,
                resource_type: placed.resource_type,
                resource_quantity_f32_bits: placed.resource_quantity_f32_bits,
                resource_delta: placed.resource_delta,
                status: placed.status,
                death_state: i32::from(placed.death_state),
                data_status: i32::from(placed.data_status),
                selection_flags: u32::from(placed.selection_flags),
                behavior_flags: u32::from(placed.behavior_flags),
            })
            .collect();
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Objects,
                kind: GenerationEventKind::MutationBatch,
                completed: end as u64,
                total: object.objects.len() as u64,
                state_hash: None,
                detail: Some(format!("replace objects {first} through {}", end - 1)),
                mutations: Some(MutationBatch {
                    tiles: Vec::new(),
                    objects: mutations,
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    if level == TraceLevel::Full {
        for attempt in &object.statistics.attempts {
            let accepted =
                !attempt.exhausted && attempt.groups_accepted == attempt.groups_requested;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Objects,
                    kind: if accepted {
                        GenerationEventKind::Progress
                    } else {
                        GenerationEventKind::Warning
                    },
                    completed: u64::from(attempt.groups_accepted),
                    total: u64::from(attempt.groups_requested),
                    state_hash: None,
                    detail: Some(format!(
                        "attempt:object-placement:d{}:slot{}:candidates{}:created{}:exhausted{}",
                        attempt.descriptor_index,
                        attempt.player_slot.map_or(0, u64::from),
                        attempt.candidate_count,
                        attempt.objects_created,
                        u8::from(attempt.exhausted)
                    )),
                    mutations: None,
                },
                true,
            )?;
        }
    }
    Ok(())
}

fn exact_allocation_bytes(
    tile_count: usize,
    cliff: &ExactCliffState,
    connection: &ExactConnectionState,
    object: &ExactObjectState,
) -> u64 {
    let tile_columns = tile_count as u64
        * (std::mem::size_of::<TerrainId>() * 2
            + std::mem::size_of::<u16>()
            + std::mem::size_of::<i16>()
            + std::mem::size_of::<u32>() * 4) as u64;
    tile_columns
        .saturating_add((object.terrain.len() * std::mem::size_of::<TerrainId>()) as u64)
        .saturating_add((object.land_id.len() * std::mem::size_of::<u16>()) as u64)
        .saturating_add((object.tile_operation_indices.len() * std::mem::size_of::<u32>()) as u64)
        .saturating_add((cliff.cliffs.len() * std::mem::size_of::<CliffEdge>()) as u64)
        .saturating_add(
            (connection.connections.len() * std::mem::size_of::<MapConnection>()) as u64,
        )
        .saturating_add((object.objects.len() * std::mem::size_of::<PlacedObject>()) as u64)
}

fn emit_exact_connection_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    presentation_land_zone: &[u32],
    connection: &ExactConnectionState,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let tile_total = connection.terrain.len() as u64;
    let mut tiles = Vec::with_capacity(1024);
    let mut emitted = 0_u64;
    for (index, after) in connection.terrain.iter().enumerate() {
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: after.0,
            elevation: connection.elevation[index],
            terrain_zone: connection.terrain_zone[index],
            land_id: presentation_land_zone[index],
            layer_id: connection.land_id[index],
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: connection.tile_operation_indices[index],
        });
        if tiles.len() == 1024 {
            cancellation_checkpoint(cancellation, GenerationStage::Terrain, emitted)?;
            emitted += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Terrain,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted,
                    total: tile_total,
                    state_hash: None,
                    detail: Some("exact connection terrain paint".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
        }
    }
    if !tiles.is_empty() {
        emitted += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted,
                total: tile_total,
                state_hash: None,
                detail: Some("exact connection terrain paint".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    for (chunk_index, chunk) in connection.connections.chunks(256).enumerate() {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, chunk_index as u64)?;
        let mutations = chunk
            .iter()
            .enumerate()
            .map(|(offset, value)| {
                let index = chunk_index * 256 + offset;
                ConnectionMutation {
                    connection_index: index as u32,
                    start_x: value.start.x,
                    start_y: value.start.y,
                    end_x: value.end.x,
                    end_y: value.end.y,
                    kind: match value.kind {
                        ConnectionKind::Land => 0,
                        ConnectionKind::Water => 1,
                        ConnectionKind::Road => 2,
                    },
                    operation: MutationOperation::Replace,
                    provenance_operation_index: connection.connection_operation_indices[index],
                }
            })
            .collect();
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: ((chunk_index + 1) * 256).min(connection.connections.len()) as u64,
                total: connection.connections.len() as u64,
                state_hash: None,
                detail: Some("exact connection graph".to_owned()),
                mutations: Some(MutationBatch {
                    tiles: Vec::new(),
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: mutations,
                }),
            },
            true,
        )?;
    }
    Ok(())
}

fn emit_exact_terrain_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    presentation_land_zone: &[u32],
    terrain: &ExactTerrainState,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let tile_total = terrain.terrain.len() as u64;
    let mut tiles = Vec::with_capacity(1024);
    let mut emitted = 0_u64;
    for (index, after) in terrain.terrain.iter().enumerate() {
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: after.0,
            elevation: terrain.elevation[index],
            terrain_zone: terrain.terrain_zone[index],
            land_id: presentation_land_zone[index],
            layer_id: terrain.land_id[index],
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: terrain.tile_operation_indices[index],
        });
        if tiles.len() == 1024 {
            cancellation_checkpoint(cancellation, GenerationStage::Terrain, emitted)?;
            emitted += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Terrain,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted,
                    total: tile_total,
                    state_hash: None,
                    detail: Some("terrain-tile-provenance".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
        }
    }
    if !tiles.is_empty() {
        emitted += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted,
                total: tile_total,
                state_hash: None,
                detail: Some("terrain-tile-provenance".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_exact_cliff_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    presentation_land_zone: &[u32],
    elevation: &ExactElevationState,
    cliff: &ExactCliffState,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let tile_total = cliff.tile_operation_indices.len() as u64;
    let mut tiles = Vec::with_capacity(1024);
    let mut emitted = 0_u64;
    for (index, operation_index) in cliff.tile_operation_indices.iter().enumerate() {
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: cliff.terrain[index].0,
            elevation: elevation.elevation[index],
            terrain_zone: 0,
            land_id: presentation_land_zone[index],
            layer_id: cliff.layer[index],
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: *operation_index,
        });
        if tiles.len() == 1024 {
            cancellation_checkpoint(cancellation, GenerationStage::Terrain, emitted)?;
            emitted += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Terrain,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted,
                    total: tile_total,
                    state_hash: None,
                    detail: Some("cliff-visual-facet-provenance".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
            tiles.reserve(1024);
        }
    }
    if !tiles.is_empty() {
        emitted += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted,
                total: tile_total,
                state_hash: None,
                detail: Some("cliff-visual-facet-provenance".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    for (chunk_index, chunk) in cliff.cliffs.chunks(256).enumerate() {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, chunk_index as u64)?;
        let start = chunk_index * 256;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: (start + chunk.len()) as u64,
                total: cliff.cliffs.len() as u64,
                state_hash: None,
                detail: Some("logical-cliff-edge-provenance".to_owned()),
                mutations: Some(MutationBatch {
                    tiles: Vec::new(),
                    objects: Vec::new(),
                    cliffs: chunk
                        .iter()
                        .enumerate()
                        .map(|(offset, edge)| CliffMutation {
                            cliff_index: (start + offset) as u32,
                            from_x: edge.from.x,
                            from_y: edge.from.y,
                            to_x: edge.to.x,
                            to_y: edge.to.y,
                            cliff_type: edge.cliff_type,
                            operation: MutationOperation::Replace,
                            provenance_operation_index: cliff.cliff_operation_indices
                                [start + offset],
                        })
                        .collect(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    emit_exact_event(
        level,
        sink,
        sequence,
        GenerationEvent {
            sequence: 0,
            stage: GenerationStage::Terrain,
            kind: GenerationEventKind::Progress,
            completed: cliff.cliffs.len() as u64,
            total: cliff.cliffs.len() as u64,
            state_hash: Some(cliff.canonical_hash()),
            detail: Some("exact cliff state complete".to_owned()),
            mutations: None,
        },
        false,
    )
}

fn emit_exact_elevation_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    land: &ExactLandState,
    presentation_land_zone: &[u32],
    elevation: &ExactElevationState,
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let total_tiles = elevation.tile_operation_indices.len() as u64;
    let mut tiles = Vec::with_capacity(1024);
    let mut emitted_tiles = 0_u64;
    for (index, operation_index) in elevation.tile_operation_indices.iter().enumerate() {
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: land.terrain[index].0,
            elevation: elevation.elevation[index],
            terrain_zone: 0,
            land_id: presentation_land_zone[index],
            layer_id: land.elevation_land_id[index],
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: *operation_index,
        });
        if tiles.len() == 1024 {
            cancellation_checkpoint(cancellation, GenerationStage::Terrain, emitted_tiles)?;
            emitted_tiles += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Terrain,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted_tiles,
                    total: total_tiles,
                    state_hash: None,
                    detail: Some("elevation-tile-provenance".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
            tiles.reserve(1024);
        }
    }
    if !tiles.is_empty() {
        cancellation_checkpoint(cancellation, GenerationStage::Terrain, emitted_tiles)?;
        emitted_tiles += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted_tiles,
                total: total_tiles,
                state_hash: None,
                detail: Some("elevation-tile-provenance".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }
    let rejected = elevation
        .statistics
        .attempt_samples
        .iter()
        .filter(|sample| sample.outcome != ExactElevationAttemptOutcome::Accepted)
        .collect::<Vec<_>>();
    for (chunk_index, chunk) in rejected.chunks(32).enumerate() {
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Terrain,
            emitted_tiles + chunk_index as u64,
        )?;
        let detail = chunk
            .iter()
            .map(|sample| {
                format!(
                    "d{}@{},{}:matches{}:{}",
                    sample.descriptor_index,
                    sample.x,
                    sample.y,
                    sample.match_count,
                    sample.outcome.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::Warning,
                completed: ((chunk_index + 1) * 32).min(rejected.len()) as u64,
                total: rejected.len() as u64,
                state_hash: None,
                detail: Some(format!("rejection:elevation-growth:{detail}")),
                mutations: None,
            },
            true,
        )?;
    }
    if elevation.statistics.popped_candidates > elevation.statistics.attempt_samples.len() as u64 {
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Terrain,
                kind: GenerationEventKind::Warning,
                completed: elevation.statistics.attempt_samples.len() as u64,
                total: elevation.statistics.popped_candidates,
                state_hash: None,
                detail: Some("elevation-growth-attempt-trace-truncated".to_owned()),
                mutations: None,
            },
            true,
        )?;
    }
    Ok(())
}

fn emit_exact_land_trace(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    land: &ExactLandState,
    presentation_land_zone: &[u32],
    cancellation: &dyn CancellationToken,
) -> Result<(), GenerationError> {
    if level != TraceLevel::Full {
        return Ok(());
    }
    let total_tiles = land.tile_operation_indices.len() as u64;
    let mut tiles = Vec::with_capacity(1024);
    let mut emitted_tiles = 0_u64;
    for (index, operation_index) in land.tile_operation_indices.iter().enumerate() {
        tiles.push(TileMutation {
            tile_index: index as u32,
            terrain_id: land.terrain[index].0,
            elevation: land.elevation[index],
            terrain_zone: 0,
            land_id: presentation_land_zone[index],
            layer_id: land.elevation_land_id[index],
            flags: 0,
            operation: MutationOperation::Replace,
            provenance_operation_index: *operation_index,
        });
        if tiles.len() == 1024 {
            cancellation_checkpoint(cancellation, GenerationStage::Land, emitted_tiles)?;
            emitted_tiles += tiles.len() as u64;
            emit_exact_event(
                level,
                sink,
                sequence,
                GenerationEvent {
                    sequence: 0,
                    stage: GenerationStage::Land,
                    kind: GenerationEventKind::MutationBatch,
                    completed: emitted_tiles,
                    total: total_tiles,
                    state_hash: None,
                    detail: Some("land-tile-provenance".to_owned()),
                    mutations: Some(MutationBatch {
                        tiles: std::mem::take(&mut tiles),
                        objects: Vec::new(),
                        cliffs: Vec::new(),
                        connections: Vec::new(),
                    }),
                },
                true,
            )?;
            tiles.reserve(1024);
        }
    }
    if !tiles.is_empty() {
        cancellation_checkpoint(cancellation, GenerationStage::Land, emitted_tiles)?;
        emitted_tiles += tiles.len() as u64;
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::MutationBatch,
                completed: emitted_tiles,
                total: total_tiles,
                state_hash: None,
                detail: Some("land-tile-provenance".to_owned()),
                mutations: Some(MutationBatch {
                    tiles,
                    objects: Vec::new(),
                    cliffs: Vec::new(),
                    connections: Vec::new(),
                }),
            },
            true,
        )?;
    }

    let rejected = land
        .statistics
        .candidate_samples
        .iter()
        .filter(|sample| sample.outcome != ExactLandCandidateOutcome::Accepted)
        .collect::<Vec<_>>();
    for (chunk_index, chunk) in rejected.chunks(32).enumerate() {
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Land,
            emitted_tiles + chunk_index as u64,
        )?;
        let detail = chunk
            .iter()
            .map(|sample| {
                format!(
                    "d{}@{},{}:cost{}:{}",
                    sample.descriptor_index,
                    sample.x,
                    sample.y,
                    sample.cost,
                    sample.outcome.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::Warning,
                completed: ((chunk_index + 1) * 32).min(rejected.len()) as u64,
                total: rejected.len() as u64,
                state_hash: None,
                detail: Some(format!("rejection:land-growth:{detail}")),
                mutations: None,
            },
            true,
        )?;
    }
    if land.statistics.popped_candidates > land.statistics.candidate_samples.len() as u64 {
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::Warning,
                completed: land.statistics.candidate_samples.len() as u64,
                total: land.statistics.popped_candidates,
                state_hash: None,
                detail: Some("land-growth-attempt-trace-truncated".to_owned()),
                mutations: None,
            },
            true,
        )?;
    }

    let rejected_cleanup = land
        .statistics
        .cleanup_samples
        .iter()
        .filter(|sample| sample.outcome != ExactLandCleanupOutcome::Painted)
        .collect::<Vec<_>>();
    for (chunk_index, chunk) in rejected_cleanup.chunks(32).enumerate() {
        cancellation_checkpoint(
            cancellation,
            GenerationStage::Land,
            emitted_tiles + rejected.len() as u64 + chunk_index as u64,
        )?;
        let detail = chunk
            .iter()
            .map(|sample| {
                format!(
                    "d{}@{},{}:{}",
                    sample.descriptor_index,
                    sample.x,
                    sample.y,
                    sample.outcome.as_str()
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::Warning,
                completed: ((chunk_index + 1) * 32).min(rejected_cleanup.len()) as u64,
                total: rejected_cleanup.len() as u64,
                state_hash: None,
                detail: Some(format!("rejection:land-cleanup:{detail}")),
                mutations: None,
            },
            true,
        )?;
    }
    if land.statistics.cleanup_candidates > land.statistics.cleanup_samples.len() as u64 {
        emit_exact_event(
            level,
            sink,
            sequence,
            GenerationEvent {
                sequence: 0,
                stage: GenerationStage::Land,
                kind: GenerationEventKind::Warning,
                completed: land.statistics.cleanup_samples.len() as u64,
                total: land.statistics.cleanup_candidates,
                state_hash: None,
                detail: Some("land-cleanup-attempt-trace-truncated".to_owned()),
                mutations: None,
            },
            true,
        )?;
    }
    Ok(())
}

pub fn resolve_exact_setup_generator_rng(
    seed: u32,
    setup: &ExactSetupState,
    semantic_program: &SemanticProgram,
) -> Result<RmsRandom, GenerationError> {
    let layout = collect_player_land_setup(semantic_program, &setup.players)?;
    let (_, rng) = native_random_player_positions(seed, semantic_program, setup, &layout)?;
    Ok(rng)
}

fn setup_rng_after_parser(
    semantic_program: &SemanticProgram,
    player_count: usize,
) -> Result<RmsRandom, GenerationError> {
    let randomization =
        exact_land::resolve_pre_position_land_randomization(semantic_program, player_count)?;
    let observed_draw_count = randomization.rng.state().draws().saturating_add(4);
    Ok(randomization
        .rng
        .with_observed_draw_count(observed_draw_count))
}

fn replay_parser_rng(
    semantic_program: &SemanticProgram,
    cancellation: &dyn CancellationToken,
) -> Result<RmsRandom, GenerationError> {
    let mut rng = RmsRandom::random_map(semantic_program.execution_context.seed);
    for draw in &semantic_program.rng_draws {
        cancellation_checkpoint(cancellation, GenerationStage::Setup, draw.sample.ordinal)?;
        let replayed = rng.bounded(draw.sample.upper_exclusive);
        if replayed != draw.sample {
            return Err(GenerationError::InvalidRngTranscript {
                ordinal: draw.sample.ordinal,
                message: "parser RNG draw differs from deterministic replay".to_owned(),
            });
        }
    }
    if rng.state() != semantic_program.rng_state_after_parser {
        return Err(GenerationError::InvalidRngTranscript {
            ordinal: rng.state().draws(),
            message: "parser RNG continuation state differs from its transcript".to_owned(),
        });
    }
    Ok(rng)
}

fn emit_exact_event(
    level: TraceLevel,
    sink: &mut dyn GenerationEventSink,
    sequence: &mut u64,
    mut event: GenerationEvent,
    full_only: bool,
) -> Result<(), GenerationError> {
    let structural = matches!(
        event.kind,
        GenerationEventKind::StageStarted
            | GenerationEventKind::MutationBatch
            | GenerationEventKind::StageCompleted
    );
    if !structural && (level == TraceLevel::Off || full_only && level != TraceLevel::Full) {
        return Ok(());
    }
    *sequence = (*sequence).wrapping_add(1);
    event.sequence = *sequence;
    sink.emit(event)?;
    Ok(())
}

fn cancellation_checkpoint(
    cancellation: &dyn CancellationToken,
    stage: GenerationStage,
    completed_units: u64,
) -> Result<(), GenerationError> {
    if cancellation.is_cancelled() {
        return Err(GenerationError::Cancelled(CancellationOutcome {
            stage,
            completed_units,
            transactional: true,
        }));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancellationOutcome {
    pub stage: GenerationStage,
    pub completed_units: u64,
    pub transactional: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum GenerationError {
    #[error("map generation is not available for game version {profile_id}")]
    UnsupportedCapability {
        capability: String,
        profile_id: String,
    },
    #[error("generation was cancelled during {stage:?}", stage = .0.stage)]
    Cancelled(CancellationOutcome),
    #[error("invalid generation request {code}: {message}")]
    InvalidRequest { code: &'static str, message: String },
    #[error("the script changed after this generation was requested")]
    StaleSemanticProgram,
    #[error("the game version does not match this generation request")]
    IncompatibleProfile,
    #[error("the run settings do not match this generation request")]
    IncompatibleExecutionContext,
    #[error("generation backend identity differs: expected {expected}, received {actual}")]
    IncompatibleBackend { expected: String, actual: String },
    #[error("invalid parser RNG transcript at draw {ordinal}: {message}")]
    InvalidRngTranscript { ordinal: u64, message: String },
    #[error("the game data does not match this generation request")]
    IncompatibleContent,
    #[error("content pack is invalid: {0}")]
    InvalidContent(String),
    #[error("the game data of the selected game version does not define {kind} {id}")]
    MissingContentDefinition {
        kind: ContentDefinitionKind,
        id: u32,
    },
    #[error("generation resource limit exceeded for {resource} (limit {limit})")]
    ResourceLimit { resource: String, limit: u64 },
    #[error("generated map is invalid: {0}")]
    InvalidMap(String),
    #[error("generation event sink failed: {0}")]
    EventSink(TraceSinkError),
    #[error("synthetic backend deliberate failure at {stage:?}: {message}")]
    BackendFailure {
        stage: GenerationStage,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentDefinitionKind {
    Object,
    Terrain,
}

impl std::fmt::Display for ContentDefinitionKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Object => "object",
            Self::Terrain => "terrain",
        })
    }
}

impl From<TraceSinkError> for GenerationError {
    fn from(value: TraceSinkError) -> Self {
        Self::EventSink(value)
    }
}

fn invalid_request(code: &'static str, message: &str) -> GenerationError {
    GenerationError::InvalidRequest {
        code,
        message: message.to_owned(),
    }
}

fn exact_terrain_argument(
    operation: &SemanticOperation,
    index: usize,
    content: CompatibleContentView<'_>,
    code: &'static str,
) -> Result<TerrainId, GenerationError> {
    let value = operation
        .arguments
        .get(index)
        .ok_or_else(|| invalid_request(code, "terrain operation is missing an argument"))?
        .value
        .as_str();
    let terrain_id = if let Ok(value) = value.parse::<u32>() {
        TerrainId(value)
    } else {
        content
            .terrain_by_rms_name(value)
            .map(|terrain| terrain.id)
            .ok_or_else(|| invalid_request(code, "terrain identity is unresolved"))?
    };
    if terrain_id.0 > u32::from(u8::MAX) {
        return Err(invalid_request(
            code,
            "terrain id exceeds the target profile byte range",
        ));
    }
    Ok(terrain_id)
}

struct CanonicalWriter {
    bytes: Vec<u8>,
}

impl CanonicalWriter {
    fn new(domain: &str) -> Self {
        let mut writer = Self { bytes: Vec::new() };
        writer.string(domain);
        writer
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn i16(&mut self, value: i16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value);
    }

    fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    fn coordinate(&mut self, coordinate: MapCoordinate) {
        self.u16(coordinate.x);
        self.u16(coordinate.y);
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

pub(crate) fn generation_rules(
    profile: &ProfileIdentity,
) -> Result<rms_profile::GenerationRules, GenerationError> {
    let catalog = rms_profile::ProfileCatalog::frozen_shared()
        .map_err(|error| invalid_request("RMSGEN1011", &error.to_string()))?;
    let frozen = catalog.get(&profile.profile_id).ok_or_else(|| {
        invalid_request(
            "RMSGEN1011",
            "map generation needs a game version from the built-in catalog",
        )
    })?;
    if frozen.identity() != *profile {
        return Err(GenerationError::IncompatibleProfile);
    }
    frozen
        .generation_rules()
        .map_err(|error| invalid_request("RMSGEN1011", &error.to_string()))
}

pub(crate) fn native_generation_bindings(
    content: CompatibleContentView<'_>,
) -> Result<&rms_content::NativeGenerationBindings, GenerationError> {
    content.native_generation_bindings().ok_or_else(|| {
        GenerationError::InvalidContent(
            "the game data lacks the generation settings the preview needs".to_owned(),
        )
    })
}
