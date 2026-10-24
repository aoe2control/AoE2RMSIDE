# Known game crashes

The game crashes on these script patterns. The IDE knows each one: some show
as warnings in `get_problems` while you edit, the others when a seed or
setting reaches them during generation (`generate_map` warnings, and the
`generation` case of `run_quality_check`). Never silence such a warning;
change the script. Many of them depend on the seed, the map size or the
player count, so one clean preview proves little.

## Found while you edit

**A line in a connection block has no terrain.** Inside the braces of a
connection command (`create_connect_all_players_land` and the others in
`<CONNECTION_GENERATION>`) the game reads a terrain from every line. A line
without one, for example `accumulate_connections`, crashes it. Fix: move the
line out of the block and write it once, before the connection commands.

**A defined name runs as a command.** A name made with `#define` and
written alone where a command can stand is run by the game as a command
with no value, and the game crashes. Fix: remove the defined name, or write
the command it was meant to be. The places and commands:

- `<PLAYER_SETUP>`: `guard_state`;
- anywhere: `ai_info_map_type`, `effect_amount`, `effect_percent`;
- `<LAND_GENERATION>`: `base_terrain`, `base_layer`;
- braces of `create_land` and `create_player_lands`: `terrain_type`,
  `assign_to`;
- `<TERRAIN_GENERATION>`: `create_terrain`, `color_correction`;
- braces of `create_elevation`: `base_terrain`, `base_layer`;
- `<CLIFF_GENERATION>`: `cliff_type`;
- braces of `create_object`: `terrain_to_place_on`, `layer_to_place_on`,
  `second_object`.

**`add_object` without an object in a named group.** When a group is named,
every `add_object` entry needs an object; the game crashes when an empty
entry is chosen, so only some seeds crash. Fix: give `add_object` an object.

**`override_map_size` after the player lands.** When it makes the map
smaller after `create_player_lands`, a player can start outside the map and
the game crashes on some seeds. Fix: write it before the player lands.

## Found during generation

**`override_actor_radius_if_required` on a small object.** The attribute
moves an object that does not fit where it was placed. For an object too
small for the game's search for a free tile, such as a sheep, the move
crashes the game. Fix: remove the attribute from that object.

**A connection or an object reaches a land outside the map.** A connection
that starts or ends at a land, or an object placed per land, on a land whose
`land_position` lies outside the map at this map size. Large positions on a
small map do this. Fix: keep `land_position` inside the map for every map
size.

**A terrain without movement data.** The map paints a terrain that the
game's movement data does not cover; the game crashes during the match, not
while it generates. Fix: use a terrain the movement data covers.

**Grouped player placement around a circle of length zero.** Players placed
in team groups around a circle of length zero make the game divide by zero.
No fix is established; when generation reports it, tell the user.

## XS

Researching the same technology twice for the same player crashes the game
(topic `xs-scripting`).
