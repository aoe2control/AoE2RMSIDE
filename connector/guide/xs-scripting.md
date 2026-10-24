# XS scripting for maps

XS is the game's scripting language. A map loads it with
`#includeXS file.xs`. Few published maps use XS; most map ideas need only
RMS. Prefer RMS whenever it can do the job, keep XS short, and keep its
effects the same for every player unless the user asks otherwise.

## What map XS can and cannot do

- It runs **when the match starts**: `main()` once, then the rules. Rules
  keep running over game time at their intervals.
- It **cannot change the generated terrain** or elevation. Everything about
  land, forests, water and hills belongs in RMS.
- It **can** create, remove, move or re-own units, change player resources,
  research technologies, change object and technology data, rename players
  and units, set diplomacy, and print chat lines.
- XS files are **not stored in recorded games** (community note), so replays
  of an XS map miss that part.
- Lobby transfer of XS files is reported both ways by community sources. The
  safe path for multiplayer is a published mod that every player
  subscribes to. Tell the user.
- The IDE's preview never runs XS; the map shows no XS changes.

## Writing valid XS

**Use only functions from the IDE's XS catalog.** The editor checks names,
types and argument counts, and knows which functions exist in the selected
game version and which are available to map scripts. Look a function up
before you use it (`lookup_reference {name, kind:'xs'}`); never invent one. Functions marked as not synchronized
(`xsUnsync...`) differ between players' machines; never use them to change
the game.

**Types:** `int` (32-bit), `float`, `bool`, `string`, `vector` (three
floats). Build vectors from variables with `xsVectorSet(x, y, z)`.

**Structure:**

Example, a start bonus for every player:

```
void main()
{
    int numPlayers = xsGetNumPlayers();
    for (player = 1; <= numPlayers)
    {
        xsEffectAmount(cModResource, cAttributeFood, cAttributeAdd, 100.0, player);
        xsChatData("Start bonus for player %d", player);
    }
}
```

- `main()` takes no parameters; `main(void)` is refused by the game.
- Players are numbered from 1; 0 is Gaia. `xsGetNumPlayers()` does not count
  Gaia.
- Names such as `cModResource`, `cAttributeFood` and `cAttributeAdd` come
  from the game's `Constants.xs`. The editor knows them when the user's game
  folder is linked. Where no constant exists (for example many technology
  ids), give the number a name with `const int` in your file.

Example, a rule that runs every 60 seconds and stops itself after
10 minutes:

```
rule trickleGold
    active
    minInterval 60
    maxInterval 60
    priority 50
{
    if (xsGetGameTime() >= 600)
    {
        xsDisableSelf();
    }
    else
    {
        int numPlayers = xsGetNumPlayers();
        for (player = 1; <= numPlayers)
        {
            xsEffectAmount(cModResource, cAttributeGold, cAttributeAdd, 20.0, player);
        }
    }
}
```

- Rules are declared outside functions. `active` or `inactive` sets the
  start state; `xsEnableRule` and `xsDisableRule` switch them by name;
  `priority` orders rules that run at the same time.
- `include "other.xs";` loads another XS file of your own.
- Keep the `.xs` file in the open folder next to the map. Deploying puts it
  into the mod; a live test copies it into the user's profile.

## Common mistakes

- **Mixed numbers:** in a mixed `int`/`float` calculation the left operand
  sets the result type (community reports: `9 * 5.5` gives 49, `5.5 * 9`
  gives 49.5). Write decimals as floats (`9.0 * 5.5`) and store them in
  `float` variables.
- **Integer division** truncates: `5 / 2` is 2.
- **Arrays:** `xsArrayCreateInt(size, defaultValue, name)` needs a name no
  other array uses; indices run from 0 to size - 1. Check bounds yourself;
  never rely on what an out-of-range read returns.
- **Loops:** every loop needs a clear end. A rule that never disables itself
  runs for the whole game; make sure that is intended and cheap.
- **Chat output:** identical consecutive `xsChatData` lines are shown only
  once. Add a counter or the player number when debugging.
- **Context player:** `xsSetContextPlayer` changes whom calls act for; avoid
  it unless a function needs it.
- **Fairness:** apply bonuses in a loop over all players, and draw random
  bonuses once for everyone rather than per player.

## The known XS crash

Researching the same technology twice for the same player with
`xsResearchTechnology` crashes the game (community known-bug list). Research
each technology at most once per player, and do not research one the
lobby's mode may already give.

## Verifying XS in the IDE

1. **Problems:** after every edit, read the XS problems (`get_problems`) (syntax, unknown
   names, wrong types, functions not available to map scripts or in the
   selected version). Deploying and live tests refuse XS with syntax errors.
2. **XS start check:** with every preview of a map that loads XS, the IDE
   runs `main()` and the rules active at the start, once, against the
   preview; `get_details {id, part:'xs'}` shows the result. It reports chat lines, the changes per player (resources,
   technologies, units, names, colours) and runtime findings such as step
   limits, array bounds and division by zero. It needs the user's linked
   game folder for `Constants.xs`. Know its limits:
   - it never changes the preview map;
   - its random numbers are the IDE's own, not the game's;
   - rules that run later in the match are not run;
   - calls that need a running match or game data stop the run, naming the
     call;
   - its results are not compared against the game.
3. **Map tests:** a map test can call a function from your XS file and check
   its result: `rms.xs("file.xs", seed = 0).call("name", arg1, arg2)`
   (topic `map-tests`). Only
   calculation and random built-ins work there; keep testable logic in pure
   functions.
4. **In the game:** anything over game time, the real random numbers, how
   units behave and any multiplayer behaviour need an in-game test by the
   user. Name these in your report.

## Before you write XS, ask

- Can RMS do it? Starting units, resources on the map, object stats at
  start (`effect_amount`) and Regicide kings all work in RMS.
- Is the effect the same for every player?
- Does it still work in each supported game mode?
- Will the user play it in multiplayer, where file transfer can fail?
