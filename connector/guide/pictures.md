# Pictures

Pictures show what numbers miss: shapes, theme, bare areas, artificial
geometry, and one-seed oddities. Ask `get_picture` for the view you need;
each picture costs context, so request the smallest view that answers your
question.

## Looks and layers

Pictures come in three looks (`look`):

- **Texture colors** (`texture`, the default): each terrain and nature
  object in the average colour of its game graphic. Best for theme, terrain
  mixing, bareness and natural shapes.
- **Minimap colors** (`minimap`): the game's minimap colours. Best for
  water depth, readability and how the map reads at a glance. Many terrains share one
  colour here (several grasses and snow look alike; all forests share one
  green).
- **Preview** (`preview`): the IDE preview's own look. When the IDE has its
  terrain textures, terrain shows them with their blending and masks, as
  the preview draws them; cliffs and objects look as in Texture colors.
  Without the textures the picture uses Texture colors. The note says
  which.

Useful extras:

- **Minimap objects** (`objects:'minimap'`): every object as a square in
  its minimap colour (gold orange, stone grey, relics white, berries light green, hunt brown, fish
  light blue). Best for counting and comparing resources.
- **Terrain relief** (`relief`, on by default): shows hills and their
  position relative to bases.
- **Overlays** (`overlays`): `grid` (tile ticks every 10 tiles in the
  margin), `players` (each start as a ring with its number), `findings`
  (positions of quality-check or map-test findings, with `findings_of`).
- **Perspective:** `grid` by default, an axis-aligned square whose rows
  and columns line up with tile coordinates `[x,y]` (x right, y down).
  `top_down` and `diamond` are the IDE preview's two views under the same
  names: `top_down` turns the square 45 degrees, `diamond` also flattens it
  like the game's minimap. When the user says "top-down" or "diamond", they
  mean these.

Texture colors and Minimap colors average colours. They are good evidence
for layout, shapes, clump sizes, colours and edges, and weak evidence for
blending and masking. A `preview` picture whose note says blending can be
judged shows the terrain transitions and masks the preview draws: judge
them from it. Otherwise do not claim that masks look smooth; say the user
should judge blending in the game.

## Which view for which question

| Question | View |
| --- | --- |
| Does the layout match the idea? | whole map (`view:'whole'`), Texture colors |
| Is it fair? | all player bases side by side, same scale and orientation (`view:'bases'`), Minimap objects |
| Does it vary between seeds? Any one-seed bug? | `contact_sheet` of 6 to 9 seeds, whole map, small size |
| What went wrong on the worst seed? | that seed (`generate_map {from_run}`), the area or base the finding names (`view:'area'` or `'base'`, `findings_of`) |
| Is it natural and themed? | whole map or a neutral area, Texture colors |
| Where are the hills? | whole map or bases, Terrain relief |
| Can players dock? | shoreline area, Minimap colors |
| Do terrain transitions and masks blend well? | an area or a base, `look:'preview'` (only when its note says blending can be judged) |
| What did my change do? | `view:'compare'` with `compare_to` (before and after side by side) |

Typical sequence: whole map of the first seed; bases side by side; after
changes, a contact sheet; for each quality-check failure, the worst seed's
area.

## What to look for

**Whole map**
- Does it look like the map the user described?
- Bare single-terrain areas, long straight roads, perfect circles or
  squares, identical clumps.
- Forest along the map edge on one side but not the other.
- Beaches on every shore.
- A coherent theme; no object or terrain that does not fit.
- The minimap reads clearly: water, forests and open land are easy to
  separate.

**Player bases side by side**
- The same resources at similar distances and directions.
- Wood behind one base but in front of another.
- A hill directly in front of one base.
- Resources touching each other or the Town Center.
- Animals or gold enclosed by forest, cliffs or water.
- Room to build and farm, about equal for every player.
- In team games: pocket versus flank space, and teammates' resources not
  overlapping.

**Contact sheet**
- The layout changes between seeds, within the rules of fairness.
- No seed with a broken feature: a missing lake, a forest that swallowed a
  base, a land that did not grow.
- Player positions vary but distances stay similar.

## Showing the map to the user

- When the user asks to see the map, show it in the IDE's preview with
  `show_map`. When they want it in this chat, send a picture of the preview
  as they see it (`get_picture` view `as_shown`).
- Choose the look and perspective the user asks for: Minimap colors,
  Texture colors or the preview's own look (`preview`); the Top-down
  (`top_down`) or Diamond (`diamond`) view. View `as_shown` already uses
  the look the preview shows.
  Two looks or two perspectives can go side by side in one picture
  (`compare`).
- When the user works remotely, for example from a phone, send a picture
  after each visible change with one sentence on what changed, and ask
  before large rewrites. If the user cannot see pictures in the chat,
  save the picture (`save:true`) and send the file. Edits stay unsaved unless the user
  allowed AI apps to save files; tell the user. Anything that needs a
  click at the PC (a new app, a live test) has to wait until they are back.

## Limits

- One picture is one seed at one setting. Fairness needs the quality check
  (`run_quality_check`) over many seeds; pictures support it, they do not
  replace it.
- Small pictures hide single objects. Zoom to an area or a base before
  saying something is missing.
- Pictures show the map at the start of the match. Objects that the game
  mode or XS adds at the start are not shown.
