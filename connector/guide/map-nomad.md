# Nomad starts and game modes

The lobby defines labels for the game mode, modifiers, resources and
starting age. Test them with `if` and adapt the map. Generate with each mode
the user wants supported (`generate_map` with `settings.game_mode`); the
IDE's lobby settings define the same labels.

## Regicide (always support it)

A player without a king loses at once, so every map must place a king per
player when Regicide is on, as the game mode or as a modifier:

```
if REGICIDE
create_object KING
{
    set_place_for_every_player
    min_distance_to_players 6
    max_distance_to_players 8
}
endif
```

Community practice adds a castle and extra villagers in Regicide; follow it
if the user wants the familiar Regicide start. `guard_state` ties a defeat
condition or a trickle to an object type; use it only for deliberate rules,
and only once per script (community note).

## Nomad

Players start without a Town Center and must build one.

- Mark the map: `ai_info_map_type` with the second value 1, for example
  `ai_info_map_type ARABIA 1 0 0`.
- `nomad_resources` gives each player the resources for a Town Center.
  `force_nomad_treaty` keeps players from fighting before they settle.
- Do not place a Town Center. Place villagers per player, spread apart
  enough that each has a reasonable spot to settle.
- Community guidance: no scouts and no predators that can kill villagers
  early.
- Fairness is about possible settling spots: wood, gold, stone, food and,
  on water maps, coast near every start. Check from each start what a Town
  Center placed there would have nearby.

## Death Match and infinite resources

- `DEATH_MATCH` (also defined with the highest starting resources): players
  start rich. Remove the small resources that only clutter: berries, sheep,
  deer, boar, wolves, straggler trees, shore fish.
- `INFINITE_RESOURCES`: remove gatherable resources except what the look
  needs. Keep relics; some civilizations use them.

```
if DEATH_MATCH
#define NO_SMALL_RESOURCES
elseif INFINITE_RESOURCES
#define NO_SMALL_RESOURCES
endif
```

Wrap the small-resource blocks in `if NO_SMALL_RESOURCES` ... `else` ...
`endif`.

## Empire Wars

Empire Wars starts with a ready Feudal Age economy. The game does not build
it on custom maps; the script must place the buildings, villagers on
resources and units (about 28 economic population, community norm). This
is much work: build it only if the user asks, and copy the standard set
closely.

## Other modes

- **Sudden Death:** players lose with their Town Center and cannot build
  new ones (except nomad starts). Extra Town Centers placed by the map change
  this mode; avoid them.
- **King of the Hill, Defend the Wonder, Wonder Race, Battle Royale:** the
  mode adds its own objects at the start of the match, which the preview
  does not show. Keep the map centre open and equally far from every player.
- **Capture the Relic:** relics matter more; keep the relic split even and
  relics reachable.
- **Turbo, starting ages, low or high resources:** usually no map changes
  needed; test that nothing breaks.

## Casual, free-for-all and event maps

Casual maps may trade balance for spectacle when the user asks. Keep these
always on even then:

- no generation bugs, nothing missing, nothing trapped;
- the same rules for each player unless the asymmetry is the point;
- free for all: every player can be attacked from more than one side, and
  no corner is far safer than the others.

Ask the user which unfair elements are wanted, and keep all other parts
fair. Tell the user in the report which parts are deliberately uneven.

## Check

- Generate with each supported mode and label; a quick map test per mode
  (`run_map_test`) can count kings, Town Centers and removed resources.
- Report which modes you tested and which only the game can show (the
  objects a mode adds at the start, how a nomad start plays).
