# Team games

Team games add two fairness questions: are the teams equal, and are the
positions inside a team (flank and pocket) each playable? Test team setups
explicitly; a map that is fair in 1v1 can fail in 4v4.

## Placement

- With the lobby's "teams together" setting, `random_placement` already
  seats teammates next to each other. `grouped_by_team` places teammates
  together with a gap between teams; it takes effect when the lobby keeps
  teams together or fixes positions. Teammates are spaced by their lands'
  `base_size`.
- `FIXED_POSITIONS` and `TEAM_POSITIONS` tell the script what the lobby
  chose. Labels such as `2_TEAM_GAME`, `TEAM1_SIZE4` and `PLAYER3_TEAM2`
  describe the teams.
- `set_zone_by_team` in the player land block lets teammates' lands merge
  (team islands, shared team areas). `assign_to AT_TEAM` gives a neutral
  land to a team.
- `create_connect_teams_lands` connects teammates only; use it for team
  islands with shallows inside each team.

Example: team islands joined inside each team by shallows.

```
<LAND_GENERATION>
base_terrain WATER
create_player_lands
{
    terrain_type GRASS
    land_percent 45
    base_size 10
    set_zone_by_team
    other_zone_avoidance_distance 10
}

<CONNECTION_GENERATION>
create_connect_teams_lands
{
    replace_terrain WATER SHALLOW
    terrain_cost WATER 5
    terrain_size WATER 2 0
}
```

## Fairness between teams

- Neutral and contested features (relics, central gold, sacred sites,
  markets, monuments, the centre) split evenly between **teams**, not just
  between players. Assign each object to the nearest start, then sum per
  team.
- The same shape for each team's area: equal wood, water and space.
- With uneven teams (2v1 and the like), the map cannot be fair; do not try,
  but keep it free of bugs.

## Flank and pocket

- Pocket players sit between teammates and are safer; flank players face
  more early pressure. Both positions should have the standard base, and the
  pocket should not be squeezed for space.
- Check that teammates' resources do not overlap or block each other, and
  that a pocket player's resources are not on a flank player's side.
- Distances between teammates should be about equal across the team and
  across seeds. The quality check warns when the walking distances to the
  nearest teammate differ by more than 10 % between players.

## Distances between enemies

- Opposing players should face similar walking distances to their nearest
  enemy. On a circle, keep the `circle_radius` variance small; on maps with
  lakes, rivers or forest walls, check that no pair of enemies is much
  closer than the others.
- In 2v2 and larger, check flank-to-flank and pocket-to-pocket distances
  across teams; a pocket that borders the enemy directly is no pocket.
  The quality check warns when the walking distances to the nearest enemy
  differ by more than 10 % between players.

## Scaling with player count

- Map sizes in the lobby usually grow with player count; test the sizes
  players will pick for 4v4 and for 1v1.
- Map-wide features (forests, relics, neutral gold, deep fish) need to scale
  with the map or with players: `set_scale_by_groups`,
  `set_scaling_to_map_size`, `set_scaling_to_player_number`, or `if` per
  player-count label.
- `land_percent` for player lands is shared between players, so each player
  gets less with more players. Check building space per player at the
  largest player count.

## Walls and teams

Community reports say walls placed by the map behave badly when all players
are on one team. If the map places walls, test that setup.

## Testing team setups

- Set the teams before you generate: `settings.teams` of `generate_map` and
  `run_quality_check`; the position policy comes from the IDE's lobby
  settings. Generate and run the quality check for each team setup you
  support, for example 2v2, 3v3, 4v4.
- The quality check compares players (and distances to teammates), not
  team totals. Write team rules as map tests: `sample.players` gives each
  player's `team` and start, and the walking queries measure per team
  (topic `map-tests`).
- Look at pictures of all bases of one team side by side (`get_picture` view
  `bases`), then the two teams' halves of the map.

## Pitfalls

- Relics or central gold nearer one team on most seeds.
- One team's side gets the water or the hills.
- Pocket players without room to build.
- Teammates' resources merging, so one player's gold sits in the
  neighbour's base.
- Testing only 1v1 and assuming team games work.
