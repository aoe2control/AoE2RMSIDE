# Closed maps: walls, forests, hideouts

Closed maps give each player a protected base: stone or palisade walls
(Arena-like), a ring of forest (Black Forest or hideout-like), or natural
barriers such as cliffs and rock. They favour booming and late-game play.
Their risk is the opposite of open maps: one-dimensional games, decided by
who has more inside the walls.

## Defaults

- Equal enclosed space for every player, with room to build and farm.
- Equal wall or forest perimeter, and the same number and width of
  openings per player.
- The standard base inside the enclosure, usually with a little extra; not
  enough to reach late game alone.
- Some valuable resources outside, so expansion pays: far gold and stone,
  relics, hunt.
- More than one route between enemies, so attacks have options.

## Walled bases

Place walls per player at a fixed distance. Put the Town Center and
villagers first; walls placed before them can centre on the wrong spot.

```
create_object STONE_WALL
{
    set_place_for_every_player
    min_distance_to_players 19
    max_distance_to_players 19
}
```

Then keep resources that belong inside within a band that ends a few tiles
inside the wall, and resources that belong outside beyond it:

- inside: `max_distance_to_players` at least 3 tiles less than the wall
  distance;
- outside: `min_distance_to_players` at least 3 tiles more.

Community reports: walls behave badly when players are separated by water,
or when all players are on one team. Test those setups if the map allows
them. Check with a map test (`run_map_test`) that every player's resources are on the right
side of the wall on every seed (`map.walls` lists wall pieces).

## Forest-enclosed bases

Start from forest and carve player lands out (topic `woodlines`,
"Forest maps"), or ring each player land with a forest terrain:

- Carved lands: `base_terrain FOREST`, player lands of equal size, then
  lanes painted with `create_connect_all_players_land` (or
  `create_connect_teams_lands` for team games), `replace_terrain FOREST
  GRASS`, a fixed `terrain_size` without variance so every lane has the same
  width.
- Mark forest-separated maps for computer players with the third value of
  `ai_info_map_type` set to 1.
- Watch for animals and resources enclosed by forest. Use
  `avoid_forest_zone` and `require_path` on every per-player resource.

## Natural barriers

Cliffs, rock terrain or water can protect a base. Cliffs are random and do
not follow player positions, so they rarely protect bases fairly. Use
terrain rings or forest instead when the protection must be equal. Do not
use rock-looking terrain as buildable ground: players read it as
impassable.

## Pitfalls

- Overlapping or touching player lands put one player's stone inside the
  neighbour's walls. Keep `other_zone_avoidance_distance` large enough.
- Herdables or hunt spawning outside one player's walls.
- A base that holds everything needed for a long game: no reason to leave.
- A single entrance per base or a single route between players: games
  become one-dimensional.
- Gaps in rock or forest borders on some seeds.
- Walls with far more hit points than the alternatives, if you change them
  with `effect_amount`; keep changes balanced.

## Building space

Closed maps live and die by space. Check buildable land (not forest, water,
cliff or object) within 12, 16 and 20 tiles of each start; the spread
between players should be small. The quality check counts buildable tiles
within 16 walking tiles of each start and warns when players differ by
more than 15 %, and fails above 40 %.

## Check

- `run_quality_check`: start parity, resources inside versus outside per player,
  building space, enclosure perimeter, players connected (through lanes or
  gates), nothing trapped.
- Pictures: bases side by side at equal scale (`get_picture` view `bases`);
  a `contact_sheet` to find seeds with gaps in borders.
- Report what only play can tell: how safe the bases feel and whether
  expansion pays off.
