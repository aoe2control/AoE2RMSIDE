# Skeleton and section order

## Sections

A script has seven sections. Write them in this order, even though the game
always generates them in this order whatever the script says:

1. `<PLAYER_SETUP>`: how players are placed (`random_placement`,
   `grouped_by_team`, `direct_placement`), nomad settings.
2. `<LAND_GENERATION>`: `base_terrain`, player lands, neutral lands.
3. `<ELEVATION_GENERATION>`: hills with `create_elevation`.
4. `<CLIFF_GENERATION>`: cliff settings. A header alone makes no cliffs; any
   one setting turns them on.
5. `<TERRAIN_GENERATION>`: `create_terrain` in script order; a later terrain
   can paint on an earlier one.
6. `<CONNECTION_GENERATION>`: paths between lands (roads, shallows, lanes).
7. `<OBJECTS_GENERATION>`: everything placed, in script order.

Commands such as `ai_info_map_type`, `effect_amount`, `color_correction` and
`behavior_version` work in any section; keep them near the top.

## Example skeleton

Example, valid syntax; adapt the numbers to the design:

```
/* SETUP */
<PLAYER_SETUP>
random_placement
behavior_version 1
ai_info_map_type ARABIA 0 0 0

<LAND_GENERATION>
base_terrain GRASS
create_player_lands
{
    terrain_type GRASS
    land_percent 40
    base_size 11
    left_border 10
    right_border 10
    top_border 10
    bottom_border 10
    other_zone_avoidance_distance 4
}

<ELEVATION_GENERATION>
create_elevation 3
{
    base_terrain GRASS
    number_of_tiles 500
    number_of_clumps 8
    set_scale_by_groups
    enable_balanced_elevation
}

<TERRAIN_GENERATION>
create_terrain FOREST
{
    base_terrain GRASS
    land_percent 10
    number_of_clumps 14
    set_scale_by_groups
    set_avoid_player_start_areas
    spacing_to_other_terrain_types 2
}

<CONNECTION_GENERATION>

/* PLAYER BASES */
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
create_object SCOUT
{
    set_place_for_every_player
    min_distance_to_players 7
    max_distance_to_players 9
}
if REGICIDE
create_object KING
{
    set_place_for_every_player
    min_distance_to_players 6
    max_distance_to_players 8
}
endif
```

Then add the standard resources (topic `player-base`). The IDE ships
snippets for most blocks: "New map skeleton", "Player lands with a standard
base", "Town Center and starting units", "Gold and stone near every player",
"Berries and deer near every player", "Sheep and boar near every player",
"Scattered gold and stone", "Relics away from the players", "Fish in the
water", "Small forests between the players", "Hills spread over the map",
"A few short cliffs", "Paths between all players", "Forest around the map
edge", "A lake in the middle of the map". Their numbers are starting points,
not checked designs.

`behavior_version 1` makes lands come out at the size you ask for. Use it in
new scripts; do not add it to an existing script without regenerating and
comparing, because it changes land sizes.

Write `VILLAGER` and `SCOUT` once per player, as above, without
`number_of_objects`: the game chooses the count and unit from the
civilization and settings.

## Placement order

Objects are placed in script order. Each one takes space later ones cannot
use, and an object that finds no valid spot is skipped without an error. So:

1. Town Center, villagers, scout (and king).
2. Main gold, main stone, berries, the four sheep.
3. Secondary gold and stone, extra sheep, boar, deer.
4. Straggler trees.
5. Neutral resources, relics, special objects.
6. Fish.
7. Predators, birds, decorations last.

Give important objects room: a large enough `base_size` and land, distance
bands wide enough for a group, and spacing that does not block itself.
Confirm with counts per player over many seeds (`run_quality_check` or a map
test), never with one preview.

## Syntax traps

- Braces, `/*` and `*/` are words of their own: put spaces or line breaks
  around them. Blocks do not nest; the first `}` ends the block.
- `//` and `;` are not comments. The game reads the words after them.
- `#const` math runs strictly left to right without precedence:
  `(2 + 3 * 4)` is 20. Write `(` touching the first value and `)` touching
  the last, with spaces around operators.
- `rnd(3,7)` is one word; its bounds must be plain numbers. Every `rnd` draws
  a number even in branches that do not run, so editing random code shifts
  later results for the same seed. Store one result in a `#const` to reuse it.
- `if` asks only whether a label is defined, not its value.
- `percent_chance` weights should add up to 100, or sometimes no branch runs.
- The first definition of a name wins. `#undefine` does not undefine.
- Terrains and objects must be names, never plain numbers: `terrain_type 0`
  and `create_object 66` are ignored whole. Give a number a name with
  `#const` if you must.
- `max_number_of_cliffs` and `max_length_of_cliff` are one more than the
  largest value used; cliff lengths and gaps count in steps of 3 tiles.
- `max_distance_to_players` keeps objects near a player only with
  `set_place_for_every_player` or `place_on_specific_land_id`.

## Scaling

Test every map size and player count you support.

- Use map size labels (`TINY_MAP`, `SMALL_MAP`, `MEDIUM_MAP`, `LARGE_MAP`,
  `HUGE_MAP`, `GIGANTIC_MAP`, `LUDIKRIS_MAP`) and player labels
  (`2_PLAYER_GAME` and so on) with `if` to choose numbers.
- Terrain and hills scale with `set_scale_by_groups` or `set_scale_by_size`;
  `land_percent` does not scale. Objects scale with `set_scaling_to_map_size`
  or `set_scaling_to_player_number`.
- Cliff counts do not scale by themselves; set them per map size.
- `land_position` is in percent of the map; keep every position inside the
  map at every size.

## Crash causes the IDE knows

The IDE warns about these (full list: topic `known-crashes`). Never silence
such a warning; change the script.

- `accumulate_connections` inside the braces of a connection command. Write
  it once, before the connection commands.
- Any other line inside connection braces that has no terrain.
- A defined name written alone where a command can stand.
- `override_actor_radius_if_required` on small objects such as sheep.
- `override_map_size` after the player lands; put it before them.
- A land position outside the map at some map size.
- A terrain the game's movement data does not cover.

## Includes

The game's own include files need the user's linked game folder. Prefer
self-contained scripts; use `#include` for your own shared files only.

## Comments

Keep comments few. A short label that names a section of the script is fine:

```
/* PLAYER BASES */
/* NEUTRAL GOLD */
```

Add an inline comment only for something truly important or non-obvious:

```
create_object SHEEP
{
    number_of_objects 4
    set_place_for_every_player
    min_distance_to_players 7
    max_distance_to_players 8
    /* no override_actor_radius_if_required: sheep crash the game */
}
```

Do not write header blocks that explain the script. Never write comments
that narrate a request or a change, such as "added per your request",
"changed to 3 gold piles" or "fixed the trapped deer"; say that in your
reply instead. Such comments stay in finished scripts and make them ugly.
When you edit an existing script, keep its comments and comment style, and
add no change-log comments.
