# The quality check

The quality check generates the map for many seeds and measures what
experienced reviewers check by hand: the same deal for every player,
nothing trapped, room to play, and a natural, varied map, without the game.

## When to run it

- Not after every edit. During design, use single previews (`generate_map`),
  pictures (`get_picture`) and small map tests (`run_map_test`).
- When the user says the map is visually finished: ask, and always propose
  running it. If the user asked you to work on your own, run it without
  asking.
- Default: 50 seeds per setting. Run it for every intended setting
  (`settings`): each supported map size, the smallest and largest player
  count, and each team setup.
- Run it again after every fix, on the same seeds (`first_seed`) plus new
  ones. While fixing, rerun only the failed cases (`cases`); run it once in
  full before you finish.

## Quality check or map test

- Standard fairness and playability (the cases below): the quality check;
  do not rebuild them as map tests.
- Rules no case covers, or a deliberately uneven map (leave that case out
  of `cases`): a map test (topic `map-tests`).

## Categories

| Category | Status | Examples |
| --- | --- | --- |
| Bugs and crashes | always on, failures | known crashes, objects missing on some seed |
| Fairness | on unless the user wants an uneven map; failures for clear differences, warnings for small ones | start objects and distances, neutral split, wood, hills, water and fish, islands |
| Playability | failures for missing, unreachable or clearly unequal resources; others warn | nothing trapped, players connected, building space, narrow passages, clashes |
| Variation and looks | advice only | variation between seeds, bare areas, terrain variety, shapes, beaches |

Bugs, missing objects and trapped objects stay on even for uneven maps.

Case ids for `cases`, as the report names them: `generation` (always
on), `start-resources`, `resource-distances`, `shared-resources`, `wood`,
`trapped`, `paths`, `building-space`, `hills`, `water`, `spacing`,
`chokepoints`, `variation`, `looks`. Without `cases`, the user's current
selection in the IDE runs.

## Reading the report

The answer lists `failed` and `warnings` in full, `advice` in one line
each, and passing cases by id. An item has `case`, `code`, `maps` (`bad/of`
samples), the `spread` over the seeds (p5, p50, p95, max) and up to three
`worst` samples: `seed`, `set` (when several settings ran) and `what`, such
as `9 objects, players 3/12, at [57,81]` (value, per-player values in slot
order, tile). Players notice problems on 5 to 10 % of seeds, so a good
median does not excuse a bad tail.

A sample where some players get no start (a 1v1 map with 4 players)
fails only `player-without-start`; the cases that compare players skip it,
so leave out settings the map is not made for.

`at [x,y]` is the problem's tile (the trapped object, the start, the
farthest player's nearest group, a passage's narrow point); `get_picture`
with `findings_of` marks it, and `view:'area'`, `area:{x: x - 12,
y: y - 12, w: 25, h: 25}` shows it up close.

For each failing check:

1. Generate the worst seed (`generate_map {from_run:{run, seed, setting}}`)
   and look at it (`get_picture` with `findings_of`; topic `pictures`: the
   bases side by side, or the area around the marked tile).
2. Find the cause in the script; fix the cause, not the seed.
3. Rerun the check. Changed random code shifts later random results, so
   new seeds may fail where old ones passed; that is expected.

Ask for details (`get_details {id, part:'case', case}`) only when the
summary is not enough. Walking distances are an 8-direction approximation,
not the game's own paths; a difference of a tile or two is noise.

## Common findings and fixes

| Finding | Usual cause | Fix |
| --- | --- | --- |
| Object missing for a player on some seeds | no free spot in the band; placed too late; band too narrow; water or forest fills it | place it earlier, widen the band, enlarge `base_size` or the land, keep forests off with `set_avoid_player_start_areas` |
| Unequal start objects | neutral placement used for a player resource; one-off group | use `set_place_for_every_player` with a band |
| Distance spread too large | wide band; square measurement | narrow the band, add `set_circular_placement`, consider `find_closest` |
| Neutral split uneven (relics, gold) | map-wide random placement | place per player with `set_gaia_object_only`, or on symmetric neutral lands |
| Trapped resource or animal | forest, cliff or water around it | `avoid_forest_zone`, `avoid_cliff_zone`, `require_path`, `max_distance_to_other_zones` |
| Players not connected | water or forest between lands | connections that paint `SHALLOW` or open lanes; smaller avoidance distance |
| Wood near base unequal | map-wide forest clumps | per-player woodline (topic `woodlines`) |
| Low building space | small lands, too much forest or scenery near bases | larger `land_percent` or `base_size`, `set_avoid_player_start_areas` with a larger distance, scenery farther out |
| Hill in front of one base | unbalanced elevation | `enable_balanced_elevation`, fewer or smaller hills, compare bases |
| Resource clash | groups too close | `min_distance_group_placement`, actor areas |
| Shore fish unequal | no water in some players' band | larger band, layout with equal water per player |
| Static layout | no random choices | variants with `start_random` (topic `map-open`) |
| Bare areas | one terrain, no objects | terrain mixing, scenery, straggler trees (topic `visuals`) |

## Thresholds

The defaults are set on reviewed community maps and official maps: maps
reviewers rated well pass at Tiny 1v1 without failures.

- start objects: the same counts for every player; a gap is a warning,
  more than 3 objects (about one pile) a failure; an object in an enemy's
  area counts for no one, one in an ally's still counts;
- neutral gold and stone: a warning when one side gets more than its
  even share by a full share per player, a failure at nearly two shares;
  relics only warn;
- predators such as wolves: a warning when starts' counts differ by more
  than 1 or one is within 12 tiles of a start;
- animals closed in by a player's own buildings, and a start without
  shore while others have one: warnings;
- nearest-distance spread per resource: a warning above 4 tiles, a failure
  above 12;
- wood near base: a warning above 25 % between players; a failure when a
  player has no large woodline and less than half the wood of another;
- building space: a warning above 15 %, a failure above 40 %.

If the user wants a different rule (a relic island for one team, say),
confirm it, leave that case out of `cases`, and say so in the report.

## The quality library in a map test

The check is the library `@rmside/quality`. A map test can load it to run
the check with other limits, or one case on its own samples:
`load("@rmside/quality", "quality_check", "wood")`, then
`print(quality_check(thresholds = {"wood/wood-near-start": {"warning": 25}}).text)`
or `wood(rms.generate(rms.source(), seeds)).items`.

- `quality_check(target, seeds, settings, cases, thresholds)` runs once per
  test and returns `result`, `counts`, `items`, `passed`, `skipped`, `text`.
- Thresholds are named `"case/code"` with `failure`, `warning` or `advice`
  numbers (`DEFAULT_THRESHOLDS`); `None` removes a level.
- Each worst sample becomes a finding `case/code` with `value`, `tile_x` and
  `tile_y`. Only failures fail the test; warnings and advice keep their
  findings and the test passes.

## What the check cannot judge

Play feel, civilization balance, how strong water or hills play, computer
players, XS over game time, and how terrain blending looks in the game.
Name these in your final report as things for the user to try.
