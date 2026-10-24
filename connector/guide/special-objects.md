# Gimmicks and special objects

A special mechanic can make a map memorable: capturable buildings, neutral
monuments, unusual resources, changed object stats, XS effects. The best
ones feel like part of the game: they add a decision, every player has the
same access, and they have counterplay. A gimmick never replaces the basics;
the map still needs a fair base, room to build and a natural look.

## Design questions to ask

1. What decision does the mechanic add? ("Take the tower early or boom?")
2. Is access the same for every player and team on every seed?
3. What is the counterplay?
4. Can it snowball, so that the first player to get it wins?
5. Does it work in every supported mode, size and player count?
6. Does it need XS? If RMS can do it, use RMS (topic `xs-scripting`).

## Gaia buildings and units

Neutral buildings (for example `WATCH_TOWER`, `MONUMENT`, `MARKET`,
`FORTRESS`, `CASTLE`) and neutral units have behaviour beyond their spot on
the map:

- `set_building_capturable` lets units capture the buildings of that
  command. Without it, decide whether players can capture them at all.
- `set_gaia_unconvertible` stops monks from converting the Gaia objects of
  that command.
- `make_indestructible` makes the objects indestructible. Community note:
  it can crash the scenario editor's test mode.
- `set_gaia_civilization` picks the civilization of Gaia objects, which
  changes their variants.

These attributes change nothing on the generated map: the preview, map
tests and the quality check cannot show their effect. Name every such
object and attribute in your report, and list what the user should check in
the game.

Watch for accidental mechanics: a captured tower that throws out its
garrison, a fence or gate a monk can convert, a decoration that turns out to
be a building. If an object only exists for looks, choose one that has no
behaviour, or make it unconvertible and uncapturable.

## Changing object data

`effect_amount` and `effect_percent` change an object type or a player
resource when the game starts, like a technology:

```
effect_amount SET_ATTRIBUTE FORAGE ATTR_STORAGE_VALUE 200
effect_percent MUL_ATTRIBUTE DEER ATTR_STORAGE_VALUE 150
```

- The effect, object and attribute must be names; a plain number makes the
  game ignore the whole command.
- `GAIA_` forms change only Gaia objects; the others change every player.
  Use them to apply a change to all players equally.
- Some attributes reach the preview (footprint, speed, stored resources, hit
  points); technology effects do not change the map.
- Keep changed objects in proportion: walls or gates with far more hit
  points than alternatives, or resources that hold much more, shift the
  balance of the whole game. Tell the user what changed.

`resource_delta` changes how much the objects of one `create_object`
command hold, for example a richer central gold pile.

## Stacked and special placement

- `second_object` places a second object on the spot of each object, for
  example a decoration on a resource, with no room of its own.
- `set_facet` picks one look of an object instead of a random one; use it
  sparingly, since random facets look more natural.
- `ignore_terrain_restrictions` places land objects on terrain they cannot
  normally stand on. Check that nothing becomes unreachable.
- Central features: mark the area with `create_actor_area`, place the
  feature with `actor_area_to_place_in`, and keep other objects out with
  `avoid_actor_area`. Keep it equally far from every player.

## Special victory and trickle rules

`guard_state` ties a defeat condition, a resource trickle, or both, to an
object type. It changes the rules of the match, not the map. Use it only
when the user wants that rule, and only once per script (community note).

## XS gimmicks

XS runs when the match starts and can create units, change resources,
research technologies and run timed rules. It cannot change terrain. See
topic `xs-scripting` before writing any.

## Check

- The quality check (`run_quality_check`, case `generation`) lists Gaia buildings and other objects with side
  effects; review the list.
- Count the special objects per player or per team over many seeds; their
  split must be even unless the user asked otherwise.
- Report every behaviour the IDE cannot show (capture, conversion, changed
  stats, XS over time), and ask the user to try it in the game.
