export const rmsStarterTemplate = `/* New to RMS? Help > Documentation explains the editor and links to guides for every RMS command. */

<PLAYER_SETUP>
random_placement

<LAND_GENERATION>
base_terrain GRASS

/* A dirt land around each player's start. */
create_player_lands
{
    terrain_type DIRT
    land_percent 40
    base_size 10
}

/* A lake in the middle of the map. */
create_land
{
    terrain_type WATER
    land_percent 8
    land_position 50 50
    base_size 6
}

<TERRAIN_GENERATION>
create_terrain FOREST
{
    base_terrain GRASS
    land_percent 12
    number_of_clumps 10
    spacing_to_other_terrain_types 2
}

<OBJECTS_GENERATION>
create_object TOWN_CENTER
{
    set_place_for_every_player
    max_distance_to_players 0
}

create_object VILLAGER
{
    set_place_for_every_player
    min_distance_to_players 6
    max_distance_to_players 6
}

create_object GOLD
{
    set_gaia_object_only
    set_place_for_every_player
    number_of_objects 7
    set_tight_grouping
    min_distance_to_players 12
    max_distance_to_players 16
}

create_object FORAGE_BUSH
{
    set_gaia_object_only
    set_place_for_every_player
    number_of_objects 6
    set_tight_grouping
    min_distance_to_players 9
    max_distance_to_players 12
}
`;

export function rmsStarterTemplateFor(capabilities: { documentation: boolean }): string {
  if (capabilities.documentation) return rmsStarterTemplate;
  return rmsStarterTemplate.slice(rmsStarterTemplate.indexOf('\n\n') + 2);
}
