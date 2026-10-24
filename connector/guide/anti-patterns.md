# Anti-patterns

These are the failures that most often separate generated maps from maps by
experienced authors. Most of them are measurable: the quality check
(`run_quality_check`) and side-by-side pictures (`get_picture` view
`bases`) find them. The idea behind a map is rarely the
problem; the execution is.

| Failure | Why it hurts | Prevention |
| --- | --- | --- |
| Neutral relics, gold or stone that land near one player | one player gets more on many seeds; players notice fast | place per player with `set_gaia_object_only`, or check the split by nearest start (topic `fairness`) |
| Objects missing on some seeds | an object without a valid spot is skipped silently, often for one player only | place important objects first; give room; test counts per player over many seeds |
| Testing one seed | problems on 5 to 10 % of seeds are the ones players find | run the quality check over 50 seeds per setting |
| Testing one setting | a map fine in 1v1 breaks in 4v4 or on Tiny | check every supported size, player count and team setup |
| Cramped bases | houses, farms and resources block each other and the paths to sheep and deer | larger lands and `base_size`, gaps between resource groups, check building space |
| Trapped animals or resources | a player loses food or gold for no reason | `avoid_forest_zone`, `avoid_cliff_zone`, `require_path`; check reachability |
| Static layout | the map looks the same every game and gets solved | random variants drawn once per seed and shared by all players |
| Derivative design that is weaker than the original | players compare it with the known map and prefer the original | ask what makes the map different; when remaking a known type, match its standard resources and features |
| One viable strategy | for example every land resource and forest within reach of ships, so only water play works | balance land against water; resources worth expanding to on land (topic `map-water`) |
| Bland visuals | plain roads, no masking, empty areas look unfinished | mix terrains, add scenery and straggler trees, keep roads narrow and purposeful (topic `visuals`) |
| Artificial shapes | perfect circles, square centres, identical clusters, hand-placed geometry | let lands and terrain grow; vary sizes; keep `land_conformity` low |
| Islands or shores without beaches | players cannot tell where ships can dock | beach terrain on every shore that matters |
| Uneven fish | a water map becomes a coin flip | per-player shore fish in a band; check deep-fish split |
| Ignoring scaling | cliffs and features that are fine on Medium overwhelm Tiny or vanish on large maps | `if` per size, `set_scale_by_groups`, scaled object counts |
| Unintended capturable or convertible objects | a decorative tower or fence becomes a mechanic | avoid gaia buildings that are not meant to matter; `set_gaia_unconvertible`; list them in the report |
| Scenery that blocks tiles unpredictably | players cannot build where it looks open | keep blocking decorations away from bases and paths |
| Too much inside closed bases | no reason to expand; games become passive | standard base plus a little; valuable resources outside |
| One choke between players | one-dimensional fights | at least two routes; no single narrow passage unless the design wants it |
| Snowballing centre | the first to take the centre wins | central rewards with counterplay and similar value elsewhere |
| Invented commands, misspelled names, wrong section | the game ignores the line, often without a visible error | use the IDE's documentation (`lookup_reference`); read problems (`get_problems`) after every edit |
| Numbers where names are needed (`create_object 66`) | the game ignores the whole command | always write names such as `GOLD` |
| `//` used as a comment | the game reads the words after it | use `/* ... */` with spaces |
| Narrating comments ("changed per your request") | they stay in the finished script and make it ugly | explain changes in the reply; keep comments few |
| Declaring a map finished without a report | the user cannot tell what was checked | finish with seeds, numbers, remaining risks and what needs an in-game test |

## Habits that prevent most of these

1. Start from the standard base and the skeleton.
2. Write every player resource with `set_place_for_every_player` and a
   distance band.
3. Read problems after every edit (`get_problems`).
4. Look at the bases side by side, not only the whole map.
5. Check several settings early, not at the end.
6. Run the quality check (`run_quality_check`) before calling the map done, and fix causes, not
   seeds.
7. Tell the user honestly what the IDE cannot judge.
