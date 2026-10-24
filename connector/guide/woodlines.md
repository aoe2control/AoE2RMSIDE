# Woodlines and forests

Wood is the hardest resource to make fair. Forests are terrain, painted in
clumps by `create_terrain`, so the per-player object tools (bands,
`set_place_for_every_player`) do not apply to them. Official open-land maps
needed several reworks before a usable woodline near every base became
likely. Plan wood deliberately and measure it.

## What players expect (community norm)

- A safe woodline near or at a medium distance from every base, big enough
  for the first lumber camps.
- Two or three straggler trees close to the Town Center.
- More wood further out, not all of it in the same direction.
- On open maps, forests also shape the fights: lanes, flanks, cover.

The quality check counts tree tiles within 20 walking tiles of each start
and calls a forest of at least 40 tree tiles a large woodline. A start
with no large woodline within 25 tiles and less than half the trees of
the best start fails.

## Pattern A: forest terrain near each player's land

Paint player lands in their own terrain, then grow forest only on that
terrain, outside the start area. Every player land has the same size, so
every player gets the same chance of wood nearby. Afterwards, paint the
placeholder back to the normal ground.

Example:

```
<LAND_GENERATION>
base_terrain GRASS
create_player_lands
{
    terrain_type DIRT3
    land_percent 50
    base_size 12
    other_zone_avoidance_distance 3
}

<TERRAIN_GENERATION>
create_terrain FOREST
{
    base_terrain DIRT3
    number_of_tiles 90
    number_of_clumps 1
    set_scale_by_groups
    set_avoid_player_start_areas 9
    clumping_factor 15
}
create_terrain GRASS
{
    base_terrain DIRT3
    land_percent 100
}
```

Caveats: the number of clumps is map-wide, not per player, so with more
players raise `number_of_clumps` (for example per player-count label).
Clumps can still land unevenly between players. Measure wood per player over
many seeds and tune until the spread is small. Paint the placeholder away
before objects are placed, as here, so objects see the final terrain.

## Pattern B: tree objects per player

A tight group of tree objects per player gives a guaranteed, equal number of
trees in a band, because the object fairness tools apply:

```
create_object OAKTREE
{
    number_of_objects 30
    group_placement_radius 4
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players 12
    max_distance_to_players 16
    min_distance_group_placement 3
}
```

Caveats: the ground under the trees stays the base terrain, so the clump
reads less like a forest; it can look artificial if overused. Combine:
one guaranteed object woodline per player, plus terrain forests elsewhere.
Check the look in Texture colors.

## Straggler trees

Place 2 and 3 single trees per player close to the Town Center:

```
create_object OAKTREE
{
    number_of_objects 2
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players 4
    max_distance_to_players 5
}
```

Use a tree that fits the theme (`PALMTREE` on desert maps, `PINETREE` in
cold maps). Single trees in empty neutral areas also break up bare land
(topic `visuals`). `place_on_forest_zone` places objects right next to
forest, useful for small trees and bushes along forest edges.

## Map-wide forests

- Paint them with `create_terrain` on the ground terrain, with
  `set_avoid_player_start_areas` so they keep off the bases and
  `spacing_to_other_terrain_types` so they do not touch water or other
  features.
- Vary clump sizes: one command with a few large clumps and another with
  many small ones reads more naturally than one size everywhere.
- Scale with `set_scale_by_groups`, and check the smallest and largest map.
- Forests block movement. Before you add many, check that no player is cut
  off and no animal or gold is enclosed. Paths through forest can be painted
  with connections: `replace_terrain FOREST GRASS` with `terrain_cost
  FOREST` high enough that paths prefer open ground.

## Forest maps

For maps where forest fills most of the map, start from forest and carve
the lands out (the IDE snippet "Forest around the map edge" shows the
start):

```
<LAND_GENERATION>
base_terrain FOREST
create_player_lands
{
    terrain_type GRASS
    land_percent 45
    base_size 13
    other_zone_avoidance_distance 6
}
```

Then connect players with lanes of equal width
(`create_connect_all_players_land` with `replace_terrain FOREST GRASS` and
`terrain_size FOREST 1 0`). Mark a forest-separated map for computer players
with the third value of `ai_info_map_type`. See topic `map-closed`.

## Common wood failures

- One player gets wood right behind the base, another only in front or far
  away. Check front/back placement per player.
- A forest closes in sheep, deer or boar.
- Forest reaches the map edge on one side and not the other.
- Wood near one base is small on some seeds only. Look at the worst seed.
- Every forest has the same size and shape.

## Measure

Per player: forest tiles or trees within 10, 15 and 20 tiles of the start,
distance to the nearest large forest, and the direction of the nearest
woodline relative to the nearest enemy. The quality check warns when the
trees within 20 tiles differ by more than 25 % between players.
