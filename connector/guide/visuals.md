# Visual quality

Experienced players notice bare land, artificial shapes and clashing themes
at once. A natural look comes from irregular shapes, mixed terrain, a
coherent biome and a little scenery everywhere, without overdoing it.

## Theme first

Choose a biome with the user (temperate, desert, snow, tropical, autumn,
steppe, coast) and keep every element in it: ground terrains, forest,
single trees, animals, water look, scenery and colour mood. Examples of
coherent sets:

| Theme | Ground | Forest and trees | Animals and scenery |
| --- | --- | --- | --- |
| Temperate | `GRASS`, `GRASS2`, `GRASS3`, `DIRT3` | `FOREST`, `OAKTREE` | `DEER`, `BOAR`, `FLOWERS_1`, `PLANT` |
| Desert | `DESERT`, `DIRT` | `PALM_DESERT`, `PALMTREE` | `CACTUS`, `SKELETON`, `ROCK` |
| Snow | `SNOW`, `GRASS_SNOW` | `SNOW_FOREST`, `PINETREE` | `ELK`, `WOLF`, `ROCK_SNOW` |
| Tropical | `DLC_JUNGLEGRASS`, `GRASS2` | `JUNGLE`, `DLC_RAINFOREST`, `JUNGLETREE` | `JAVELINA`, `MACAW` |

Look up any name you are unsure of with `lookup_reference`; use only names
the IDE knows.
`color_correction` and `water_definition` set mood and water look; they do
not change the map.

## Terrain mixing

- One plain ground terrain over a large area looks bare. Paint two or three
  related ground terrains in many clumps of different sizes:

```
create_terrain GRASS3
{
    base_terrain GRASS
    land_percent 8
    number_of_clumps 25
    set_scale_by_groups
    clumping_factor 10
}
create_terrain DIRT3
{
    base_terrain GRASS
    land_percent 4
    number_of_clumps 12
    set_scale_by_groups
    set_avoid_player_start_areas 10
}
```

- `terrain_mask 1` paints a terrain as a layer over the tile while the tile
  keeps its terrain; use it for soft blends. Under a mask the underlying
  terrain still decides the minimap colour (community note).
- Vary clump size within a terrain: one command with a few large clumps and
  another with many small ones.
- Patches of a different ground inside player bases are fine, but keep them
  out of farm areas if they look odd under farms.

## Beaches and edges

- Land meeting water needs a beach, so players can see where ships dock.
  `beach_terrain` sets a terrain's shore if the default does not fit.
- Avoid hard jumps between unrelated terrains; add a transition terrain or
  a mask between them.
- Forest that reaches the map edge on one side and stops short on another
  looks like a bug, and can be unfair. Keep edges consistent.
- Do not use rock or cliff-looking terrain as normal buildable ground.

## Scenery

Empty neutral areas, plateaus and long land strips look bare. Add a little
scenery that fits the theme:

- Single trees and small tree groups away from bases.
- Small decorations in loose groups, scaled with map size:

```
create_object FLOWERS_1
{
    number_of_groups 12
    number_of_objects 3
    set_loose_grouping
    set_gaia_object_only
    set_scaling_to_map_size
    min_distance_to_players 14
    avoid_forest_zone 1
}
```

- Birds (`HAWK`, `MACAW`) for life.
- Keep blocking scenery (rocks, statues, ruins, hay stacks) away from bases,
  paths and resources: it makes tiles unbuildable in ways players cannot
  predict. Prefer decorations that do not block.
- "Enough, not overdone": scenery should catch the eye on a close look, not
  clutter the minimap.

## Natural shapes

- Avoid perfect circles and squares: very high `land_conformity`,
  `set_circular_base` on large neutral lands, lands of one size in a ring.
  Keep `land_conformity` low and `clumping_factor` moderate.
- Avoid identical clusters: rock groups, forests or lakes all the same size.
  Draw sizes with `rnd` or use two commands with different sizes.
- Avoid long straight road strips unless the theme is a road. A connection
  that paints `ROAD` everywhere looks artificial; paint paths only where they
  serve play, and keep them narrow and varied with `terrain_size` variance.
- Avoid hand-placed geometry with fixed coordinates; let lands and terrain
  grow.

## Minimap readability

- Large, contrasting clumps read well; many tiny irregular clumps look
  noisy.
- Make features players need (water, shallows, hills, forest gaps) easy to
  tell apart.
- Many terrains share a minimap colour in the game (for example several
  grass and snow terrains). In the Minimap colors look, two terrains that
  should look different may look the same; check Texture colors too.

## Judging looks from pictures

Minimap colors and Texture colors average colours. They show shapes, clump
sizes, theme colours, bareness and edges well, and blending and masks
poorly. Look `preview` shows the IDE preview's terrain textures when the
IDE has them (its note says blending can be judged): then judge transitions
and masks from that picture. Without them, a verdict about how smooth a
mask looks is weak evidence. Say so in your report, and leave the final
judgement of blending to the user in the game.

## Checklist

- Coherent theme across ground, trees, animals, scenery, water and mood.
- No large single-terrain area without objects.
- Beaches on every shore that ships should reach.
- No perfect geometric shapes, no identical clusters.
- Consistent map edges.
- Variation between seeds visible in a contact sheet.
- Scenery does not block bases, paths or resources.
