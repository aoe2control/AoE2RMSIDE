use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictArgumentKind {
    Label,
    Number,
    Token,
    Condition,
    Path,
    TolerantNumber,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictCommandKind {
    Control,
    Section(&'static str),
    Descriptor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrictCommand {
    pub name: &'static str,
    pub arguments: &'static [StrictArgumentKind],
    pub kind: StrictCommandKind,
}

macro_rules! control {
    ($name:literal $(, $argument:ident)*) => {
        StrictCommand {
            name: $name,
            arguments: &[$(StrictArgumentKind::$argument),*],
            kind: StrictCommandKind::Control,
        }
    };
}

macro_rules! section {
    ($name:literal, $normalized:literal) => {
        StrictCommand {
            name: $name,
            arguments: &[],
            kind: StrictCommandKind::Section($normalized),
        }
    };
}

macro_rules! descriptor {
    ($name:literal $(, $argument:ident)*) => {
        StrictCommand {
            name: $name,
            arguments: &[$(StrictArgumentKind::$argument),*],
            kind: StrictCommandKind::Descriptor,
        }
    };
}

const STRICT_COMMANDS: &[StrictCommand] = &[
    control!("#define", Label),
    control!("#undefine", Label),
    control!("#const", Label, Number),
    control!("if", Condition),
    control!("elseif", Condition),
    control!("else"),
    control!("endif"),
    control!("start_random"),
    control!("percent_chance", Number),
    control!("end_random"),
    control!("#include", Path),
    section!("<PLAYER_SETUP>", "player_setup"),
    descriptor!("random_placement"),
    descriptor!("grouped_by_team"),
    descriptor!("min_distance"),
    descriptor!("max_distance"),
    descriptor!("set_position"),
    section!("<LAND_GENERATION>", "land_generation"),
    descriptor!("land_percent", Number),
    descriptor!("base_terrain", Token),
    descriptor!("create_player_lands"),
    descriptor!("terrain_type", Token),
    descriptor!("base_size", Number),
    descriptor!("left_border", Number),
    descriptor!("right_border", Number),
    descriptor!("top_border", Number),
    descriptor!("bottom_border", Number),
    descriptor!("border_fuzziness", Number),
    descriptor!("zone", Number),
    descriptor!("set_zone_by_team"),
    descriptor!("set_zone_randomly"),
    descriptor!("other_zone_avoidance_distance", Number),
    descriptor!("create_land"),
    descriptor!("assign_to_player", Number),
    section!("<CLIFF_GENERATION>", "cliff_generation"),
    descriptor!("min_number_of_cliffs", Number),
    descriptor!("max_number_of_cliffs", Number),
    descriptor!("min_length_of_cliff", Number),
    descriptor!("max_length_of_cliff", Number),
    descriptor!("cliff_curliness", Number),
    descriptor!("min_distance_cliffs", Number),
    descriptor!("min_terrain_distance", Number),
    section!("<TERRAIN_GENERATION>", "terrain_generation"),
    descriptor!("create_terrain", Token),
    descriptor!("percent_of_land", Number),
    descriptor!("number_of_clumps", Number),
    descriptor!("spacing_to_other_terrain_types", Number),
    section!("<OBJECTS_GENERATION>", "objects_generation"),
    descriptor!("create_object", Token),
    descriptor!("set_scaling_to_map_size"),
    descriptor!("number_of_groups", Number),
    descriptor!("number_of_objects", Number),
    descriptor!("group_variance", Number),
    descriptor!("group_placement_radius", Number),
    descriptor!("set_loose_grouping"),
    descriptor!("set_tight_grouping"),
    descriptor!("terrain_to_place_on", Token),
    descriptor!("set_gaia_object_only"),
    descriptor!("set_place_for_every_player"),
    descriptor!("place_on_specific_land_id", Number),
    descriptor!("min_distance_to_players", Number),
    descriptor!("max_distance_to_players", Number),
    section!("<CONNECTION_GENERATION>", "connection_generation"),
    descriptor!("create_connect_all_players_land"),
    descriptor!("create_connect_teams_lands"),
    descriptor!("create_connect_same_land_zones"),
    descriptor!("create_connect_all_lands"),
    control!("{"),
    control!("}"),
    control!("/*"),
    control!("*/"),
    descriptor!("land_position", Number, Number),
    descriptor!("land_id", Number),
    descriptor!("clumping_factor", Number),
    descriptor!("number_of_tiles", Number),
    descriptor!("set_scale_by_groups"),
    descriptor!("set_scale_by_size"),
    descriptor!("set_avoid_player_start_areas", TolerantNumber),
    descriptor!("min_distance_group_placement", Number),
    section!("<ELEVATION_GENERATION>", "elevation_generation"),
    descriptor!("create_elevation", Number),
    descriptor!("spacing", Number),
    descriptor!("default_terrain_replacement", Token),
    descriptor!("replace_terrain", Token, Token),
    descriptor!("terrain_cost", Token, Number),
    descriptor!("terrain_size", Token, Number, Number),
    descriptor!("min_placement_distance", Number),
    descriptor!("set_scaling_to_player_number"),
    descriptor!("height_limits", Number, Number),
    descriptor!("set_flat_terrain_only"),
    descriptor!(
        "ai_info_map_type",
        Token,
        TolerantNumber,
        TolerantNumber,
        TolerantNumber
    ),
    descriptor!("max_distance_to_other_zones", Number),
    control!("#include_drs", Path),
    descriptor!("temp_min_distance_group_placement", Number),
    descriptor!("base_elevation", Number),
    descriptor!("nomad_resources"),
    descriptor!("direct_placement"),
    descriptor!("resource_delta", Number),
    descriptor!("guard_state", Token, Token, Number, Number),
    descriptor!("assign_to", Token, Number, Number, Number),
    descriptor!("terrain_mask", Number),
    descriptor!("circle_radius", Number, TolerantNumber),
    descriptor!("base_layer", Token),
    descriptor!("create_connect_to_nonplayer_land"),
    descriptor!("color_correction", Token),
    descriptor!("enable_waves", Number),
    descriptor!("place_on_forest_zone"),
    descriptor!("avoid_forest_zone", TolerantNumber, TolerantNumber),
    descriptor!("find_closest"),
    descriptor!("actor_area", Number),
    descriptor!("actor_area_radius", Number),
    descriptor!("actor_area_to_place_in", Number),
    descriptor!("avoid_actor_area", Number),
    descriptor!("avoid_all_actor_areas"),
    descriptor!("layer_to_place_on", Token),
    descriptor!("force_placement"),
    descriptor!("second_object", Token),
    descriptor!("avoid_cliff_zone", TolerantNumber),
    descriptor!("set_gaia_unconvertible"),
    descriptor!("set_gaia_civilization", Number),
    descriptor!("enable_balanced_elevation"),
    descriptor!("effect_amount", Token, Token, Token, Number),
    descriptor!("behavior_version", Number),
    control!("#includeXS", Path),
    descriptor!("effect_percent", Token, Token, Token, Number),
    descriptor!("min_connected_tiles", Number),
    descriptor!("accumulate_connections"),
    descriptor!("create_actor_area", Number, Number, Number, Number),
    descriptor!("override_actor_radius_if_required"),
    descriptor!("force_nomad_treaty"),
    descriptor!("ignore_terrain_restrictions"),
    descriptor!("make_indestructible"),
    descriptor!("min_distance_to_map_edge", Number),
    descriptor!("find_closest_to_map_edge", TolerantNumber),
    descriptor!("find_closest_to_map_center", TolerantNumber),
    descriptor!("set_circular_placement"),
    descriptor!("beach_terrain", Token),
    descriptor!("enable_tile_shuffling"),
    descriptor!("set_building_capturable"),
    descriptor!("generate_for_first_land_only"),
    descriptor!("override_map_size", Number),
    descriptor!("set_facet", Number),
    descriptor!("cliff_type", Token),
    descriptor!("require_path", TolerantNumber),
    descriptor!("set_circular_base"),
    descriptor!("avoid_other_land_zones", TolerantNumber),
    descriptor!("water_definition", Number),
    descriptor!("create_object_group", Label),
    descriptor!("add_object", Token, Number),
    descriptor!("land_conformity", Number),
    descriptor!("create_connect_land_zones", Number, Number),
    descriptor!("generate_mode", Number),
    descriptor!("spacing_to_specific_terrain", Token, Number),
];

struct SpellingHasher(u64);

impl Default for SpellingHasher {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Hasher for SpellingHasher {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

type SpellingIndex = HashMap<&'static str, usize, BuildHasherDefault<SpellingHasher>>;

fn strict_command_index() -> &'static SpellingIndex {
    static INDEX: OnceLock<SpellingIndex> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = SpellingIndex::with_capacity_and_hasher(
            STRICT_COMMANDS.len(),
            BuildHasherDefault::default(),
        );
        for (position, command) in STRICT_COMMANDS.iter().enumerate() {
            index.entry(command.name).or_insert(position);
        }
        index
    })
}

pub(crate) fn find_strict_command(name: &str) -> Option<&'static StrictCommand> {
    strict_command_id(name).map(|id| &STRICT_COMMANDS[id])
}

pub fn strict_command_id(name: &str) -> Option<usize> {
    strict_command_index().get(name).copied()
}

pub(crate) fn strict_command_by_id(id: i32) -> Option<&'static StrictCommand> {
    usize::try_from(id)
        .ok()
        .and_then(|index| STRICT_COMMANDS.get(index))
}

pub(crate) fn dispatcher_handles_id(id: i32) -> bool {
    matches!(
        id,
        0..=11 | 17 | 34 | 42 | 47 | 62 | 67..=70 | 79 | 90 | 92 | 119 | 121..=124 | 140
    )
}

pub fn strict_command(name: &str) -> Option<&'static StrictCommand> {
    find_strict_command(name)
}

pub fn strict_commands() -> &'static [StrictCommand] {
    STRICT_COMMANDS
}

pub fn strict_command_names() -> impl ExactSizeIterator<Item = &'static str> {
    STRICT_COMMANDS.iter().map(|command| command.name)
}

pub fn strict_command_arity(name: &str) -> Option<usize> {
    find_strict_command(name).map(|command| command.arguments.len())
}

pub fn reads_missing_operand_from_next_line(name: &str) -> bool {
    !matches!(name, "spacing_to_other_terrain_types" | "avoid_actor_area")
}
