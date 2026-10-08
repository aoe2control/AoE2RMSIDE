use crate::native_context::{OBJECT_DESCRIPTOR_COMMANDS, PLAYER_SETUP_COMMANDS};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum DescriptorBlock {
    Land,
    PlayerLands,
    Terrain,
    Elevation,
    Connection,
    Object,
    ObjectGroup,
}

impl DescriptorBlock {
    pub const ALL: [Self; 7] = [
        Self::Land,
        Self::PlayerLands,
        Self::Terrain,
        Self::Elevation,
        Self::Connection,
        Self::Object,
        Self::ObjectGroup,
    ];

    pub const fn section(self) -> &'static str {
        match self {
            Self::Land | Self::PlayerLands => "land_generation",
            Self::Terrain => "terrain_generation",
            Self::Elevation => "elevation_generation",
            Self::Connection => "connection_generation",
            Self::Object | Self::ObjectGroup => "objects_generation",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct CommandRules {
    pub commands: &'static [&'static str],
    pub repeatable: &'static [&'static str],
    pub exclusive: &'static [&'static [&'static str]],
    pub overridden_by: &'static [(&'static str, &'static [&'static str])],
    pub prerequisites: &'static [(&'static str, &'static [&'static str])],
    pub conditions: &'static [(&'static str, &'static [&'static str])],
}

impl CommandRules {
    pub fn contains(&self, name: &str) -> bool {
        self.commands.contains(&name)
    }

    pub fn is_repeatable(&self, name: &str) -> bool {
        self.repeatable.contains(&name)
    }

    pub fn exclusive_with<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'static str> + 'a {
        self.exclusive
            .iter()
            .filter(move |set| set.contains(&name))
            .flat_map(|set| set.iter().copied())
            .filter(move |other| *other != name)
    }

    pub fn overriding(&self, name: &str) -> &'static [&'static str] {
        self.overridden_by
            .iter()
            .find(|(command, _)| *command == name)
            .map_or(&[], |(_, later)| later)
    }

    pub fn required_by(&self, name: &str) -> &'static [&'static str] {
        self.prerequisites
            .iter()
            .find(|(command, _)| *command == name)
            .map_or(&[], |(_, required)| required)
    }

    pub fn enabled_by(&self, name: &str) -> &'static [&'static str] {
        self.conditions
            .iter()
            .find(|(command, _)| *command == name)
            .map_or(&[], |(_, enabling)| enabling)
    }
}

const NO_NAMES: &[&str] = &[];

const LAND_COMMANDS: &[&str] = &[
    "land_percent",
    "terrain_type",
    "base_size",
    "left_border",
    "right_border",
    "top_border",
    "bottom_border",
    "border_fuzziness",
    "zone",
    "set_zone_by_team",
    "set_zone_randomly",
    "other_zone_avoidance_distance",
    "assign_to_player",
    "land_position",
    "land_id",
    "clumping_factor",
    "number_of_tiles",
    "min_placement_distance",
    "base_elevation",
    "assign_to",
    "circle_radius",
    "set_circular_base",
    "land_conformity",
    "generate_mode",
];

const PLAYER_LANDS_COMMANDS: &[&str] = &[
    "land_percent",
    "terrain_type",
    "base_size",
    "left_border",
    "right_border",
    "top_border",
    "bottom_border",
    "border_fuzziness",
    "zone",
    "set_zone_by_team",
    "set_zone_randomly",
    "other_zone_avoidance_distance",
    "land_id",
    "clumping_factor",
    "number_of_tiles",
    "min_placement_distance",
    "base_elevation",
    "circle_radius",
    "set_circular_base",
    "land_conformity",
    "generate_mode",
];

const LAND_EXCLUSIVE: &[&[&str]] = &[
    &["land_percent", "number_of_tiles"],
    &["zone", "set_zone_by_team", "set_zone_randomly"],
    &["assign_to_player", "assign_to"],
];

const PLAYER_LANDS_EXCLUSIVE: &[&[&str]] = &[
    &["land_percent", "number_of_tiles"],
    &["zone", "set_zone_by_team", "set_zone_randomly"],
];

const TERRAIN_COMMANDS: &[&str] = &[
    "land_percent",
    "base_terrain",
    "number_of_clumps",
    "spacing_to_other_terrain_types",
    "clumping_factor",
    "number_of_tiles",
    "set_scale_by_groups",
    "set_scale_by_size",
    "set_avoid_player_start_areas",
    "height_limits",
    "set_flat_terrain_only",
    "terrain_mask",
    "base_layer",
    "beach_terrain",
    "spacing_to_specific_terrain",
];

const ELEVATION_COMMANDS: &[&str] = &[
    "base_terrain",
    "number_of_clumps",
    "number_of_tiles",
    "set_scale_by_groups",
    "set_scale_by_size",
    "spacing",
    "base_layer",
    "enable_balanced_elevation",
];

const CONNECTION_COMMANDS: &[&str] = &[
    "default_terrain_replacement",
    "replace_terrain",
    "terrain_cost",
    "terrain_size",
];

const SCALING_EXCLUSIVE: &[&[&str]] = &[&["set_scale_by_groups", "set_scale_by_size"]];

const BORDERS: &[&str] = &["left_border", "right_border", "top_border", "bottom_border"];

const LAND_CONDITIONS: &[(&str, &[&str])] = &[("border_fuzziness", BORDERS)];

const PER_LAND: &[&str] = &["set_place_for_every_player", "place_on_specific_land_id"];

const GROUPING: &[&str] = &[
    "number_of_groups",
    "set_loose_grouping",
    "set_tight_grouping",
];

const OBJECT_CONDITIONS: &[(&str, &[&str])] = &[
    ("group_placement_radius", GROUPING),
    ("set_gaia_object_only", PER_LAND),
    (
        "find_closest",
        &[
            "set_place_for_every_player",
            "place_on_specific_land_id",
            "min_connected_tiles",
        ],
    ),
    ("force_placement", PER_LAND),
    ("min_connected_tiles", GROUPING),
    ("override_actor_radius_if_required", PER_LAND),
    ("find_closest_to_map_edge", PER_LAND),
    ("find_closest_to_map_center", PER_LAND),
    ("generate_for_first_land_only", PER_LAND),
    ("require_path", PER_LAND),
    ("avoid_other_land_zones", PER_LAND),
];

const LAND_RULES: CommandRules = CommandRules {
    commands: LAND_COMMANDS,
    repeatable: NO_NAMES,
    exclusive: LAND_EXCLUSIVE,
    overridden_by: &[("land_id", &["assign_to_player", "assign_to"])],
    prerequisites: &[],
    conditions: LAND_CONDITIONS,
};

const PLAYER_LANDS_RULES: CommandRules = CommandRules {
    commands: PLAYER_LANDS_COMMANDS,
    repeatable: NO_NAMES,
    exclusive: PLAYER_LANDS_EXCLUSIVE,
    overridden_by: &[],
    prerequisites: &[],
    conditions: LAND_CONDITIONS,
};

const TERRAIN_RULES: CommandRules = CommandRules {
    commands: TERRAIN_COMMANDS,
    repeatable: &["spacing_to_specific_terrain"],
    exclusive: &[
        &["land_percent", "number_of_tiles"],
        &["set_scale_by_groups", "set_scale_by_size"],
    ],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[("set_flat_terrain_only", &["spacing_to_other_terrain_types"])],
};

const ELEVATION_RULES: CommandRules = CommandRules {
    commands: ELEVATION_COMMANDS,
    repeatable: NO_NAMES,
    exclusive: SCALING_EXCLUSIVE,
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const CONNECTION_RULES: CommandRules = CommandRules {
    commands: CONNECTION_COMMANDS,
    repeatable: &["replace_terrain", "terrain_cost", "terrain_size"],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const OBJECT_RULES: CommandRules = CommandRules {
    commands: OBJECT_DESCRIPTOR_COMMANDS,
    repeatable: &[
        "place_on_forest_zone",
        "avoid_forest_zone",
        "avoid_actor_area",
        "avoid_cliff_zone",
    ],
    exclusive: &[
        &["set_loose_grouping", "set_tight_grouping"],
        &["set_scaling_to_map_size", "set_scaling_to_player_number"],
    ],
    overridden_by: &[],
    prerequisites: &[],
    conditions: OBJECT_CONDITIONS,
};

const OBJECT_GROUP_RULES: CommandRules = CommandRules {
    commands: &["add_object"],
    repeatable: &["add_object"],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

pub fn block_rules(block: DescriptorBlock) -> &'static CommandRules {
    match block {
        DescriptorBlock::Land => &LAND_RULES,
        DescriptorBlock::PlayerLands => &PLAYER_LANDS_RULES,
        DescriptorBlock::Terrain => &TERRAIN_RULES,
        DescriptorBlock::Elevation => &ELEVATION_RULES,
        DescriptorBlock::Connection => &CONNECTION_RULES,
        DescriptorBlock::Object => &OBJECT_RULES,
        DescriptorBlock::ObjectGroup => &OBJECT_GROUP_RULES,
    }
}

pub fn descriptor_block(opener: &str) -> Option<DescriptorBlock> {
    Some(match opener {
        "create_land" => DescriptorBlock::Land,
        "create_player_lands" => DescriptorBlock::PlayerLands,
        "create_terrain" => DescriptorBlock::Terrain,
        "create_elevation" => DescriptorBlock::Elevation,
        "create_connect_all_players_land"
        | "create_connect_teams_lands"
        | "create_connect_same_land_zones"
        | "create_connect_all_lands"
        | "create_connect_to_nonplayer_land"
        | "create_connect_land_zones" => DescriptorBlock::Connection,
        "create_object" => DescriptorBlock::Object,
        "create_object_group" => DescriptorBlock::ObjectGroup,
        _ => return None,
    })
}

const PLAYER_SETUP_RULES: CommandRules = CommandRules {
    commands: PLAYER_SETUP_COMMANDS,
    repeatable: NO_NAMES,
    exclusive: &[&["random_placement", "grouped_by_team", "direct_placement"]],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const LAND_SECTION_RULES: CommandRules = CommandRules {
    commands: &[
        "base_terrain",
        "create_player_lands",
        "create_land",
        "base_layer",
    ],
    repeatable: &["create_player_lands", "create_land"],
    exclusive: &[],
    overridden_by: &[("base_layer", &["base_terrain"])],
    prerequisites: &[],
    conditions: &[],
};

const CLIFF_SECTION_RULES: CommandRules = CommandRules {
    commands: &[
        "min_number_of_cliffs",
        "max_number_of_cliffs",
        "min_length_of_cliff",
        "max_length_of_cliff",
        "cliff_curliness",
        "min_distance_cliffs",
        "min_terrain_distance",
        "cliff_type",
    ],
    repeatable: NO_NAMES,
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const TERRAIN_SECTION_RULES: CommandRules = CommandRules {
    commands: &["create_terrain"],
    repeatable: &["create_terrain"],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const ELEVATION_SECTION_RULES: CommandRules = CommandRules {
    commands: &["create_elevation"],
    repeatable: &["create_elevation"],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const CONNECTION_CREATORS: &[&str] = &[
    "create_connect_all_players_land",
    "create_connect_teams_lands",
    "create_connect_same_land_zones",
    "create_connect_all_lands",
    "create_connect_to_nonplayer_land",
    "accumulate_connections",
    "create_connect_land_zones",
];

const CONNECTION_SECTION_RULES: CommandRules = CommandRules {
    commands: CONNECTION_CREATORS,
    repeatable: &[
        "create_connect_all_players_land",
        "create_connect_teams_lands",
        "create_connect_same_land_zones",
        "create_connect_all_lands",
        "create_connect_to_nonplayer_land",
        "create_connect_land_zones",
    ],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

const OBJECTS_SECTION_RULES: CommandRules = CommandRules {
    commands: &["create_object", "create_actor_area", "create_object_group"],
    repeatable: &["create_object", "create_actor_area", "create_object_group"],
    exclusive: &[],
    overridden_by: &[],
    prerequisites: &[],
    conditions: &[],
};

pub fn section_rules(section: &str) -> Option<&'static CommandRules> {
    Some(match section {
        "player_setup" => &PLAYER_SETUP_RULES,
        "land_generation" => &LAND_SECTION_RULES,
        "cliff_generation" => &CLIFF_SECTION_RULES,
        "terrain_generation" => &TERRAIN_SECTION_RULES,
        "elevation_generation" => &ELEVATION_SECTION_RULES,
        "connection_generation" => &CONNECTION_SECTION_RULES,
        "objects_generation" => &OBJECTS_SECTION_RULES,
        _ => return None,
    })
}
