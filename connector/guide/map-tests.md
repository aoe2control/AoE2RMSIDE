# Map tests

A map test is a small script in a `.rmstest` file (Starlark, a Python
dialect) that generates the map on many seeds and checks rules on each one.
Use map tests for what the user asked for, so "does the map do what was
asked" is checked over seeds too, not only on the seed you looked at.
For the standard fairness and playability checks, run the quality check
instead (topic `quality-check`).

## The user's own requirements as map tests

Turn each requirement into a map test.

Example: every player's nearest gold is within 20 walking tiles.

```python
def main():
    seeds = rms.seeds(start = 1, count = 50)
    for sample in rms.generate(rms.source(), seeds, preview = False,
                               analyse = ["walk", "fields:starts"]):
        m = sample.map
        for p in sample.players:
            if p.start == "none":
                sample.report("a player has no start", values = {"player": p.slot})
                continue
            gold = m.distance_field(p, open_for = p.slot).nearest(["GOLD"], count = 1)
            sample.expect(
                len(gold) == 1 and gold[0].distance <= 20,
                message = "nearest gold is more than 20 walking tiles away",
                values = {"player": p.slot, "x": p.start_x + 0.5, "y": p.start_y + 0.5},
            )

main()
```

Prefer built-in functions (`count_tiles`, `components`, `connected`, the
walking queries) over loops across the whole map, which can reach the step
limit.

## Players, walking and placements

Look up any name before you use it: `lookup_reference {name:
'map.distance_field', kind:'test-api'}`.

- `sample.players`: one struct per slot with `slot`, `team`, `start`
  (`"land"`, `"town_center"` or `"none"`), `start_x`, `start_y` (tile, or
  `None`), `land_zone`, `land_zone_shared` and `town_center` (an object or
  `None`).
- A place is a tile `(x, y)`, an object, a player (its Town Center, else its
  start tile) or a list of up to 64 of these.
- `m.walk_distance(x1, y1, x2, y2, open_for = None)`: whole tiles, or `None`
  when no route exists. Walking moves in 8 directions; trees, cliffs, rocks,
  mines, buildings, walls and gates block; units, animals, relics and farms
  do not. `open_for = slot` lets that player through their own buildings,
  walls and gates. It approximates the game's paths; it is not the game's
  pathing.
- `m.distance_field(sources, open_for = None, max_distance = None)` measures
  once; read it with `.at(x, y)`, `.to(place)`, `.reachable(place)`,
  `.nearest(object_ids, owner = None, count = 2, max_distance = None)`
  (structs with `object` and `distance`, nearest first) and
  `.count_tiles(max_distance, <tile filters>)`.
- `m.narrowest_passage(a, b = None, ring = None, open_for = None, limit =
  16)`: the fewest walkable tiles whose blocking separates `a` from `b` (or
  from everything `ring` tiles away). `width` 0 means not connected;
  `capped` means at least `limit`; `passages` lists up to 8 narrow points as
  `width`, `x`, `y`.
- Tile filters (`tiles`, `count_tiles`, `boundaries`, `components`,
  `connected`) take `walkable = True` and `buildable = True` besides terrain,
  zone and layer ids. Without them they look only at terrain and ignore
  objects. They move in 4 directions.
- `sample.placements()`: `create_object` commands that placed fewer groups
  than they asked for, with `line`, `object_id`, `player`,
  `groups_requested` and `groups_placed`; `short_only = False` lists all.
- `rms.generate(..., failures = "record")` keeps a seed whose map fails (a
  game crash, a refusal) as a sample with `failure` (`code`, `message`,
  `crash_id`) and no map; check `sample.failure == None` before reading
  `sample.map`. The default stops the test.
- `analyse = ["walk", "fields:starts"]` prepares walking data and each
  player's start field (`open_for` = the player's slot) while the maps
  generate; results stay the same.

## Settings

Map tests take their map size, players and mode from the preview's current
settings. To sample other sizes and team setups in one run, pass
`settings = [rms.settings(map_size = "tiny", teams = "1v1"),
rms.settings(map_size = "huge", teams = "4v4")]` to `rms.generate`: every
setting gets the same seeds, setting by setting, and `sample.settings` and
`sample.settings_index` say which one a sample used. Settings other than the
run's own work only in a test that loads the quality library
(`load("@rmside/quality", "quality_check")`).

## Writing and running

- Create the file next to the map with `create_file`, for example
  `tests/gold.rmstest`, and run it with `run_map_test {path}`.
- `rms.source()` is the map pinned in the IDE's Run options. To test one
  script whatever is pinned, pass its path: `rms.source("maps/oasis.rms")`.
- Use `preview = False` so the test leaves the user's preview as it is.
- One `sample.expect(condition, message, values, code)` per rule. Keep the
  message short and the same on every seed, and put the player and the
  numbers in `values`: the result groups failures by assertion and lists the
  first failing seeds.
- Put `x` and `y` in `values` to mark a finding on a picture
  (`get_picture` with `findings_of`). They are in tile units: a tile's
  centre is `x + 0.5`, `y + 0.5`; an object's position is `x256 / 256`.
- `sample.report(...)` records a finding without a condition, for numbers
  you want to see on every seed.
- `print` output is counted in the result; read it with
  `get_details {id, part:'output'}`. The findings of one assertion:
  `get_details {id, part:'findings', assertion}`.

## Good rules to test

- Counts per player: the same number of each start resource near every
  Town Center, inside its band.
- The user's features: "a pond for every player", "relics only in the
  middle", "no forest within 8 tiles of a Town Center".
- Mode and setting rules: a king per player under Regicide, no small
  resources under Death Match (topic `map-nomad`).
- Team rules the quality check does not cover (topic `team-games`), with
  `team` from `sample.players`.

Write the rule as the user stated it. When a test fails, fix the script,
not the test, unless the user agrees the rule was wrong.

## Testing XS

When the map loads XS (topic `xs-scripting`):

- `rms.xs("bonus.xs", seed = 0).call("name", arg1, arg2)` runs one function
  of your XS file and returns its result. Only calculation and random
  built-ins work there; keep testable logic in pure functions.
- `sample.xs_start()` runs the XS start check on a sample's map, as the
  preview does, and returns its `status`, `findings`, `chat` lines,
  `changes` per player and the call it stopped at (`stop`). Both need the
  game's `Constants.xs` from the user's linked game folder.

Example: every player gets the start bonus the XS file promises.

```python
def main():
    for sample in rms.generate(rms.source(), rms.seeds(start = 1, count = 10), preview = False):
        start = sample.xs_start()
        sample.expect(start.status == "completed", message = "XS start check did not complete")
        gold = [c for c in start.changes if c.kind == "resource" and c.target == "cAttributeGold"]
        sample.expect(len(gold) == len(sample.players),
                      message = "not every player gets the gold bonus")

main()
```

The start check runs `main()` and the rules active at the start once; it
never changes the map, and its random numbers are the IDE's own. Anything
over game time needs a game test.
