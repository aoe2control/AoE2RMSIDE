# Water and hybrid maps

Water maps add a second economy (fish) and a second battlefield (ships).
Unequal water access turns them into a coin flip. Hybrid maps (land and
water both matter) are the hardest to balance: water control should matter
without deciding everything.

## Defaults

- Every player gets the same shore access, the same shore fish, and a
  dockable shore at a similar distance.
- Deep-water fish split evenly between players.
- Beaches wherever land meets water, so players can tell where to dock.
- Land resources not all reachable from warships.
- Every island has food, wood and gold.
- Larger map sizes than open land maps for the same player count, if the
  user agrees.

## Layouts

- **Islands:** `base_terrain WATER`, player lands with
  `other_zone_avoidance_distance` large enough to keep water between them.
  Team islands: `set_zone_by_team` in the player land block, so teammates'
  lands can merge.
- **Lakes and ponds:** neutral lands of water with `land_position`, or a
  central lake (the IDE snippet "A lake in the middle of the map"). Make
  sure every player reaches the lake at a similar distance.
- **Rivers and shallows:** water lands or terrain, crossed by connections
  that paint `SHALLOW`:

```
<CONNECTION_GENERATION>
create_connect_all_players_land
{
    replace_terrain WATER SHALLOW
    replace_terrain DEEP_WATER SHALLOW
    terrain_cost WATER 7
    terrain_cost DEEP_WATER 9
    terrain_size WATER 2 1
    terrain_size DEEP_WATER 1 0
}
```

- **Coastal:** one sea along a side or around the map; positions must give
  every player the same coast, which random placement rarely does without
  borders or `direct_placement`. Check shore distance per player.

## Shore fish per player

Place shore fish per player, in a band, on water:

```
create_object SHORE_FISH
{
    number_of_objects 4
    set_loose_grouping
    set_gaia_object_only
    set_place_for_every_player
    terrain_to_place_on WATER
    min_distance_to_players 8
    max_distance_to_players 18
    group_placement_radius 4
}
```

If some player has no water inside the band on some seed, their fish are
skipped silently. Check counts per player over many seeds. The quality
check warns when players' shore fish groups within 20 tiles of the start
differ by more than 1, and when a start has no shore within 25 tiles while
others do.

## Deep fish

Deep fish (`DORADO` and other ocean fish) are usually neutral. Spread them
with `temp_min_distance_group_placement` and `set_scaling_to_map_size`, then
check the split by nearest start. If one player's water is smaller, they
lose; prefer layouts where each player's water area is equal, or place deep
fish per player with `set_gaia_object_only`.

## Beaches and shores

- After connections, land next to water gets the shore terrain. Set a
  terrain's shore with `beach_terrain` in its `create_terrain` block when the
  default does not fit the theme.
- Islands without beaches confuse players about docking, and hard water
  transitions look wrong. Check shores in the pictures.

## Water versus land balance

- Count how many of each player's land resources and forest tiles lie within
  reach of ships from navigable water. If nearly all are, the map is a water
  map whatever its name. The quality check gives advice when more than
  80 % of the gold, stone and berries lie within 8 tiles of water.
- Give land something worth expanding to: gold or relics away from shores.
- Consider dividing waterways (shallows, land bridges) so one fleet cannot
  control every shore.
- Ponds in player bases: make each pond equally easy to dock and fish for
  every player.

## Pitfalls

- Shore fish only around some islands, the rest of the sea empty.
- Cramped islands where houses and resources block paths to sheep and deer.
- An island with no food or no gold.
- Gold or berries placed on shore tiles where ships can kill villagers,
  for one player only.
- Computer players handle water poorly (community reports); mention it if
  the user plans to play against them.

## Check

- `run_quality_check`: water access and shore fish per player, deep fish split,
  island sizes and resources, beaches, water exposure, start parity.
- Pictures: the whole map in Minimap colors (`get_picture` look `minimap`;
  water depth reads well there), bases side by side with their shores.
- Report what only play can tell: how strong water is in practice, and
  whether docking and fishing feel equal.
