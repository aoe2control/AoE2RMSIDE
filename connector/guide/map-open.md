# Open land maps

Open land maps (the Arabia family) are the most played competitive type.
Players value mobile, aggressive play: the map should be hard to wall
completely, with open ground between bases, scattered small forests and a
few hills.

## Defaults

- Player lands with the standard base (topic `player-base`).
- A safe woodline near or at a medium distance from every base, plus many
  small and medium forests map-wide (topic `woodlines`).
- Hills spread over the map with `enable_balanced_elevation`; none large
  and directly in front of a base.
- Few or no cliffs; short ones if any (`min_number_of_cliffs` and
  `max_number_of_cliffs` per map size, `min_length_of_cliff` small).
- Secondary gold and stone that may need map control: far groups per player
  (topic `fairness`, section 2).
- Relics neutral, split evenly.
- Little water: at most small ponds, with or without fish, the same for
  every player.

## What makes open maps good

- **Openness:** most of the land walkable, few long forest walls, several
  routes between any two bases.
- **Walling cost:** a base that needs many wall tiles to close. Big forests
  that cover a whole side make walling cheap and change the map type.
- **Something worth leaving the base for:** far gold, hunt, relics. A base
  with everything inside invites passive play.
- **Hills that matter but do not decide:** elevation gives combat bonuses;
  small hills near resources are fine if every player gets similar ones.

## Variation that stays fair

Open maps get stale when they look the same on every seed, and they are
easy to clone. Add variation that is the same for all players:

- Draw one variant per seed with `start_random` and `#define`, then use the
  label throughout:

```
start_random
percent_chance 50
    #define VARIANT_OASIS
percent_chance 30
    #define VARIANT_CLIFFS
percent_chance 20
    #define VARIANT_PLAIN
end_random
```

- Oases or small lakes in the middle; a scattering of short cliffs; patches
  of a second ground terrain; different forest densities.
- Ask the user what should make the map different. "Arabia with a different
  wall layout" is a weak idea; a feature that changes decisions (where to
  expand, what to fight over) is a strong one.

## Pitfalls

- Hills raised in front of one base on some seeds. Look at the bases side
  by side on several seeds.
- Cliffs that create one narrow choke between two players.
- A forest that grows over the far gold for one player.
- Forest clumps all the same size, in an even grid.
- Neutral gold that lands nearer one player.
- Map-wide resources that do not scale: test Tiny and the largest size you
  support.

## Hills and cliffs, briefly

- `create_elevation` raises hills on its `base_terrain`; each level starts
  from `number_of_clumps` seeds and grows to `number_of_tiles`. Hills keep
  about 9 tiles clear of each player land's origin.
- Example hills: the IDE snippet "Hills spread over the map". Add
  `enable_balanced_elevation`.
- Cliffs keep clear of land origins and water. Their counts do not scale,
  so set them per map size:

```
<CLIFF_GENERATION>
cliff_type CT_GRANITE
min_length_of_cliff 3
max_length_of_cliff 6
cliff_curliness 15
min_distance_cliffs 4
if TINY_MAP
    min_number_of_cliffs 0
    max_number_of_cliffs 2
elseif SMALL_MAP
    min_number_of_cliffs 1
    max_number_of_cliffs 3
else
    min_number_of_cliffs 2
    max_number_of_cliffs 5
endif
```

## Check

- `run_quality_check`: start parity, distance parity, wood near base, neutral
  split, elevation around each base, building space, players connected.
- Pictures: `contact_sheet` of six to nine seeds for variation and one-seed
  bugs; bases side by side (`get_picture` view `bases`) for hills and wood.
- Report what only play can tell: whether the map rewards aggression or
  booming, and how strong the hills are in real fights.
