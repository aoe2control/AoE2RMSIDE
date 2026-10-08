# Original visual assets

Only independently authored, redistributable source art and deterministic atlas
inputs may be added here. Each nontrivial asset requires a provenance manifest.
The app's own placeholders are drawn in CSS and contain no game art or derived
art.

`branding/` contains independently authored project identity assets. Its
manifest records authorship, licensing, hashes, and the no-game-content
declaration required by the repository policy.

`map-icon-trees/` contains the original 4 x 4 tree sprite sheet of the
generated map icon's tree layer, created for AoE2RMSIDE by the project owner.
Its manifest records the cell order, hash, authorship, license, and the
no-game-content declaration.

`map-icon-resources/` contains the original 2 x 2 gold and stone sprite sheet
of the generated map icon's gold and stone layer, in the tree sheet's style,
created and recorded the same way.

`map-icon-players/` contains the original spawn marker sprites of the
generated map icon. `player-squares-v1.png` is a transparent sheet of
player-colored diamond markers supplied by the project owner, who states it
contains no game content; only its bottom row is used.
`nomad-feet-v1.webp` is a 4 x 2 sheet of sandals with player-colored cuffs in
the tree sheet's style, created for AoE2RMSIDE by the project owner. The
manifest beside them records the cell order, hashes, authorship, license, and
the no-game-content declaration.

The desktop renderer bundles every sheet and processes them at run time into
the map icon's sprites (magenta chroma key, one-pixel erosion, re-outline,
per-cell crop, downscale; the player squares are sliced by cell and keep their
own transparency). No game art is used for the map icon.
