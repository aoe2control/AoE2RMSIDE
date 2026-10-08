use crate::SemanticProgram;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObjectBlockCommandEffect {
    Descriptor,
    Global,
    GroupEntry,
    Ignored,
}

pub(crate) const OBJECT_DESCRIPTOR_COMMANDS: &[&str] = &[
    "set_scaling_to_map_size",
    "number_of_groups",
    "number_of_objects",
    "group_variance",
    "group_placement_radius",
    "set_loose_grouping",
    "set_tight_grouping",
    "terrain_to_place_on",
    "set_gaia_object_only",
    "set_place_for_every_player",
    "place_on_specific_land_id",
    "min_distance_to_players",
    "max_distance_to_players",
    "min_distance_group_placement",
    "set_scaling_to_player_number",
    "max_distance_to_other_zones",
    "temp_min_distance_group_placement",
    "resource_delta",
    "place_on_forest_zone",
    "avoid_forest_zone",
    "find_closest",
    "actor_area",
    "actor_area_radius",
    "actor_area_to_place_in",
    "avoid_actor_area",
    "avoid_all_actor_areas",
    "layer_to_place_on",
    "force_placement",
    "second_object",
    "avoid_cliff_zone",
    "set_gaia_unconvertible",
    "min_connected_tiles",
    "override_actor_radius_if_required",
    "ignore_terrain_restrictions",
    "make_indestructible",
    "min_distance_to_map_edge",
    "find_closest_to_map_edge",
    "find_closest_to_map_center",
    "set_circular_placement",
    "enable_tile_shuffling",
    "set_building_capturable",
    "generate_for_first_land_only",
    "set_facet",
    "require_path",
    "avoid_other_land_zones",
];

const GLOBAL_DESCRIPTOR_COMMANDS: &[&str] = &[
    "ai_info_map_type",
    "set_gaia_civilization",
    "effect_amount",
    "behavior_version",
    "effect_percent",
    "override_map_size",
];

pub(crate) const PLAYER_SETUP_COMMANDS: &[&str] = &[
    "random_placement",
    "grouped_by_team",
    "nomad_resources",
    "direct_placement",
    "force_nomad_treaty",
];

pub const BLOCK_OPENING_COMMANDS: &[&str] = &[
    "create_player_lands",
    "create_land",
    "create_elevation",
    "create_terrain",
    "create_object",
    "create_object_group",
    "create_connect_all_players_land",
    "create_connect_teams_lands",
    "create_connect_same_land_zones",
    "create_connect_all_lands",
    "create_connect_to_nonplayer_land",
    "create_connect_land_zones",
];

pub fn opens_descriptor_block(name: &str) -> bool {
    BLOCK_OPENING_COMMANDS.contains(&name)
}

pub fn object_block_command_effect(name: &str) -> ObjectBlockCommandEffect {
    if name == "add_object" {
        ObjectBlockCommandEffect::GroupEntry
    } else if is_global_descriptor_command(name) {
        ObjectBlockCommandEffect::Global
    } else if OBJECT_DESCRIPTOR_COMMANDS.contains(&name) {
        ObjectBlockCommandEffect::Descriptor
    } else {
        ObjectBlockCommandEffect::Ignored
    }
}

pub fn is_global_descriptor_command(name: &str) -> bool {
    GLOBAL_DESCRIPTOR_COMMANDS.contains(&name)
}

pub fn is_player_setup_command(name: &str) -> bool {
    PLAYER_SETUP_COMMANDS.contains(&name)
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum NativeIgnoredContext {
    ObjectBlock,
    ObjectBlockWithoutDescriptor,
    ObjectCreateInsideBraces,
    ObjectGroupEntryOutsideBraces,
    TerrainPercentOfLand,
    ElevationLandId,
    PlayerLandsPosition,
    CircleRadiusOutsideLandBlock,
    AccumulateConnectionsInsideBraces,
    PlayerSetupCommandOutsidePlayerSetup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeIgnoredOperation {
    pub operation_index: usize,
    pub context: NativeIgnoredContext,
}

impl SemanticProgram {
    pub fn native_ignored_operations(&self) -> Vec<NativeIgnoredOperation> {
        let mut ignored = Vec::new();
        let mut section = None::<&str>;
        let mut opener = None::<&str>;
        let mut object_descriptor_exists = false;
        let mut object_group_named = false;
        let mut land_descriptor_exists = false;
        for (operation_index, operation) in self.operations.iter().enumerate() {
            if !operation.accepted_by_target_parser() {
                continue;
            }
            if section != Some(operation.section.as_str()) {
                section = Some(operation.section.as_str());
                opener = None;
            }
            let name = operation.name.as_str();
            let inside_braces = operation.depth > 0;
            if !inside_braces {
                opener = Some(name);
            }
            let mut push = |context| {
                ignored.push(NativeIgnoredOperation {
                    operation_index,
                    context,
                })
            };
            if is_player_setup_command(name) && operation.section != "player_setup" {
                push(NativeIgnoredContext::PlayerSetupCommandOutsidePlayerSetup);
                continue;
            }
            match operation.section.as_str() {
                "objects_generation" => {
                    if !inside_braces {
                        match name {
                            "create_object" => object_descriptor_exists = true,
                            "create_object_group" => object_group_named = true,
                            "add_object" => {
                                push(NativeIgnoredContext::ObjectGroupEntryOutsideBraces)
                            }
                            _ => {}
                        }
                        continue;
                    }
                    if matches!(
                        name,
                        "create_object" | "create_object_group" | "create_actor_area"
                    ) {
                        push(NativeIgnoredContext::ObjectCreateInsideBraces);
                        continue;
                    }
                    match object_block_command_effect(name) {
                        ObjectBlockCommandEffect::Ignored => {
                            push(NativeIgnoredContext::ObjectBlock)
                        }
                        ObjectBlockCommandEffect::GroupEntry if !object_group_named => {
                            push(NativeIgnoredContext::ObjectBlock)
                        }
                        ObjectBlockCommandEffect::Descriptor if !object_descriptor_exists => {
                            push(NativeIgnoredContext::ObjectBlockWithoutDescriptor)
                        }
                        _ => {}
                    }
                }
                "terrain_generation" if name == "percent_of_land" => {
                    push(NativeIgnoredContext::TerrainPercentOfLand)
                }
                "elevation_generation" if inside_braces && name == "land_id" => {
                    push(NativeIgnoredContext::ElevationLandId)
                }
                "land_generation" => {
                    if !inside_braces && matches!(name, "create_land" | "create_player_lands") {
                        land_descriptor_exists = true;
                    }
                    if name == "land_position"
                        && inside_braces
                        && opener == Some("create_player_lands")
                    {
                        push(NativeIgnoredContext::PlayerLandsPosition);
                    } else if name == "circle_radius" && (!inside_braces || !land_descriptor_exists)
                    {
                        push(NativeIgnoredContext::CircleRadiusOutsideLandBlock);
                    }
                }
                "connection_generation" if inside_braces && name == "accumulate_connections" => {
                    push(NativeIgnoredContext::AccumulateConnectionsInsideBraces)
                }
                _ => {}
            }
        }
        ignored
    }
}
