# Standard player base

Competitive players have build orders tuned to a well-known starting set.
Give every player this set unless the user asks for something else, and
change it only on purpose.

## The standard table (community norm)

Per player, distances in tiles from the player's start (the Town Center).
The counts and minimum distances are the community's documented standard;
the official maps vary them a little.

| Item | Count | Minimum distance | Notes |
| --- | --- | --- | --- |
| Town Center, villagers, scout | 1 each | at the start | write `VILLAGER` and `SCOUT` once; the game picks the count |
| Berry bushes (`FORAGE_BUSH`) | 6, one tight group | 10 | |
| Main gold (`GOLD`) | 7, one tight group | 10 | |
| Second gold | 4, one tight group | 18 | |
| Third gold | 4, one tight group | 21 | |
| Main stone (`STONE`) | 5, one tight group | 12 | |
| Second stone | 4, one tight group | 16 | |
| Sheep (`SHEEP`) | 4, player-owned | about 7 | |
| Extra sheep | 2 pairs | one shared random minimum, 14 to 24 | |
| Boar (`BOAR`) | 2, single | 16 | |
| Deer (`DEER`) | 3 or 4, one loose group | one shared random minimum, 14 to 24 | |
| Predator (`WOLF`) | 1 | 34 | |
| Straggler trees | 2 + 3 | 4 to 5, and 6 to 8 | single trees near the TC |

Map-wide on top of this: relics (official maps: 5 on Tiny, one or two
more per larger size), a few neutral gold and stone groups that scale
with map size, birds, and decorations.

**Maximum distances** are not part of the documented norm. Working
assumption: minimum plus 3 to 5 tiles for clusters, wider
for hunt.

## How to write it

Example: main gold and stone in bands, spaced apart and kept clear of
forest so nothing blocks them.

```
create_object GOLD
{
    number_of_objects 7
    group_placement_radius 2
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    set_circular_placement
    min_distance_to_players 10
    max_distance_to_players 14
    min_distance_group_placement 5
    avoid_forest_zone 2
    avoid_cliff_zone 2
    require_path 2
}
create_object STONE
{
    number_of_objects 5
    group_placement_radius 2
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    set_circular_placement
    min_distance_to_players 12
    max_distance_to_players 16
    min_distance_group_placement 5
    avoid_forest_zone 2
    avoid_cliff_zone 2
    require_path 2
}
```

Example: one shared random distance for every player's deer, so the
variation is the same for all players.

```
#const DEER_MIN rnd(14,20)
create_object DEER
{
    number_of_objects 4
    set_loose_grouping
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players DEER_MIN
    max_distance_to_players 24
    avoid_forest_zone 2
}
```

A `#const` is worked out once, so every player shares the value, and other
commands (the extra sheep) can reuse it.

Notes:

- Distances are squares by default: a spot on the diagonal of a square band
  is about 1.4 times farther away than one straight ahead. Use
  `set_circular_placement` when the band should be a ring.
- `min_distance_group_placement` keeps a free square around each group for
  every later command; `temp_min_distance_group_placement` spaces only this
  command's groups.
- `require_path` only accepts spots reachable from the player's land; the
  number is the detour allowed. Only the first object of a group is checked.
- Keep 2 to 3 tiles between different resource groups (community norm), so
  berries do not touch stone and mining camps do not overlap. The quality
  check warns when different resources touch, or lie within 2 tiles of a
  Town Center.
- Sheep are player-owned (no `set_gaia_object_only`); far sheep pairs are
  usually Gaia. Never use `override_actor_radius_if_required` on sheep: the
  game crashes when it moves them.
- `find_closest` takes the nearest free spots first. It makes distances
  more uniform between players but also less varied between seeds.

## Deviating on purpose

Change the base only for a reason the user agreed to, and keep it the same
for every player:

- **Low or high resources:** fewer or more piles, or `resource_delta` to
  change what each holds. Say what this does to build orders.
- **Closed maps:** players expect somewhat more inside the walls, but not
  enough to reach late game alone (topic `map-closed`).
- **Water maps:** fewer land hunt, shore fish per player instead
  (topic `map-water`).
- **Theme animals:** swap kinds, not amounts of food. The community norm
  replaces 4 sheep with 3 cows (`DLC_COW`); keep the total food comparable.
- **Death Match and infinite resources:** drop the small resources
  (topic `map-nomad`).
- **Nomad:** no Town Center; different start (topic `map-nomad`).

Whatever you change, list the final per-player table in your report.

## Check it

Run `run_quality_check` or a map test (`run_map_test`): every player has the same count of
every item, inside its band, reachable, on every seed. Look at the bases side
by side (`get_picture` view `bases`; topic `pictures`).
