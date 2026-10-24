# Fairness toolkit

Fair means: on every seed, every player gets the same deal. Unequal starts
decide matches, and players find the bad seeds quickly. Use the engine's
tools so fairness comes from the script, not from luck.

## 1. Fair player placement

- Let `create_player_lands` share `land_percent` equally between players.
  Use the same `base_size` for all; it also keeps players apart and away from
  the map edge.
- `random_placement` places players around a rectangle, or on a circle when a
  land block sets `circle_radius`. Keep the variance (second value) small:
  `circle_radius 38 1`. A large variance gives some players shorter rush
  distances.
- Borders (`left_border` and the others) keep player lands off the edges.
  With `border_fuzziness` at its default, growth respects them loosely.
- `other_zone_avoidance_distance` keeps lands of different zones apart, so
  player lands do not merge.
- Avoid `direct_placement` with hand-picked positions unless the design needs
  them; fixed positions often favour one side and look static.

## 2. Per-player instead of neutral

The strongest fairness tool: place a resource **for every player**, in a
distance band, even when it is meant to be "neutral" and far away.

```
create_object GOLD
{
    number_of_objects 4
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players 24
    max_distance_to_players 30
    min_distance_group_placement 6
    avoid_forest_zone 2
}
```

`set_gaia_object_only` keeps the objects neutral even though they are placed
around each player. Use truly neutral placement (no
`set_place_for_every_player`) only for things that should be contested or
random: relics, scattered map-wide gold, decorations. Then check the split
(section 6).

`max_distance_to_players` does not keep neutral objects near anyone, and 0
there can leave them unplaced.

## 3. Bands, rings and order

- `min_distance_to_players` and `max_distance_to_players` set the band.
  Default measurement is a square; `set_circular_placement` makes it a ring.
- `find_closest` takes the nearest free spots first: very even distances,
  less variety. `enable_tile_shuffling` mixes spots at equal distance.
- `find_closest_to_map_center` or `find_closest_to_map_edge` (with 1 for the
  opposite) put a resource in front of or behind each base in the same way
  for everyone.
- `temp_min_distance_group_placement` spreads one command's groups;
  `min_distance_group_placement` also keeps later commands away.
- Place important objects first (topic `skeleton`). An object
  that finds no spot is skipped silently, often for only one player.
- `force_placement` places what is left even when no spot fits every rule,
  one object at a time without its group. Use it only as a last resort and
  check what it does to fairness.

## 4. Nothing trapped, nothing blocked

- `avoid_forest_zone 2` and `avoid_cliff_zone 2` keep resources and animals
  out of forests and away from cliffs.
- `require_path` (per-player placement) accepts only spots reachable from the
  player's land; its number is the detour allowed. It checks the first object
  of each group.
- `max_distance_to_other_zones` keeps land objects away from terrain they
  cannot stand on, such as water.
- `avoid_other_land_zones` keeps per-player objects inside the player's own
  zone, so they do not end up across a river or on another island.
- Hunt and herdables need open land around them: forests placed after them
  can still close them in. Place forests (terrain) first, which the section
  order already does, and keep animals' bands clear of forest.

## 5. Actor areas against clashes

Actor areas mark space for later rules:

```
create_object STONE
{
    number_of_objects 5
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players 12
    max_distance_to_players 16
    actor_area 11
    actor_area_radius 4
}
create_object FORAGE_BUSH
{
    number_of_objects 6
    set_tight_grouping
    set_gaia_object_only
    set_place_for_every_player
    min_distance_to_players 10
    max_distance_to_players 14
    avoid_actor_area 11
}
```

`create_actor_area x y id radius` marks a square at fixed tile coordinates,
for example a central feature. `actor_area_to_place_in` places objects only
inside a marked area. Do not add `override_actor_radius_if_required` to small
objects: the game crashes when it has to move them.

## 6. Neutral resources: check the split

For every neutral or contested item, assign each object to the nearest
start and compare players. Community expectations:

- relics differ by at most 1 between players, and not always in the same
  player's favour;
- neutral gold and stone groups differ by at most 1 per type;
- contested features (centre, sacred site, monument) are about equally far
  from each player or team; the quality check warns when the nearest relic
  or the map centre is more than 10 tiles nearer to some players than to
  others (or a third of the average distance, when that is more).

If the split fails often, make the item per-player (section 2), or place it
on neutral lands you position symmetrically and target with
`place_on_specific_land_id`.

## 7. Elevation

- `enable_balanced_elevation` spreads hills more evenly; without it hills
  lean towards one side of the map.
- Hills keep about 9 tiles clear of each player land's origin. A big hill
  right in front of one base favours the attacker; check bases side by side.
- Small hills near gold or berries are fine when every player gets similar
  ones.

## 8. Same variation for everyone

Randomness is welcome when it is the same for every player on a seed:

- Draw a random choice once (`start_random` with `#define`, or a `#const`
  with `rnd`) and use it for all players.
- Never give one player a random feature another player might not get.
- Mirror-style designs: build features per player, not as one map-wide
  object that lands nearer someone.

## 9. Verify

Fairness claims need numbers over many seeds: per-player counts, nearest
distances, neutral shares, wood and building space near each base, elevation
around each base. Use `run_quality_check` (topic `quality-check`) and look at the
worst seed, not only the average.
