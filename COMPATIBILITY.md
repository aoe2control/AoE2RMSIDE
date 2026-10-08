# Compatibility and game content

This page explains what the AoE2RMSIDE map preview can and cannot promise,
which game versions it supports, and how it handles game files and game art.

## How the preview relates to the game

AoE2RMSIDE has its own, independently written map generator. It reads random
map scripts and builds maps the way Age of Empires II: Definitive Edition
does, based on observed game behavior. It contains no game source code, it is
not an official part of the game, and it does not replace the game.

- **Verified game versions.** Each supported game version has a behavior
  profile (see [profiles/README.md](profiles/README.md)). The verified
  versions are listed [below](#verified-versions). For a verified version,
  generated maps are meant to match the game, within these limits: maps up
  to 512 × 512 tiles and scripts of up to 65,536 operations. Larger scripts
  are refused instead of being approximated.
- **Other game versions.** Newer or otherwise unverified game versions still
  work, but they are clearly marked as unverified, and their maps can differ
  from the game.
- **Quirks on purpose.** Where the game behaves in an unusual way,
  AoE2RMSIDE copies that behavior instead of correcting it, so maps behave
  the same.
- **Same input, same map.** A map only matches when everything is the same:
  the script and all of its include files, the seed, the lobby settings, the
  game version, and compatible game content.
- **Speed is not compared.** How fast AoE2RMSIDE builds a map says nothing
  about how fast the game builds it.

## How closely the preview matches the game

AoE2RMSIDE is checked against maps recorded from the game itself. For each
verified version, the game and AoE2RMSIDE generated the same maps from the
same script, seed, and lobby settings, and the two results were compared:
terrain, elevation, cliffs, and the position of every object. Every map
counted under [Verified versions](#verified-versions) matches.

The maps come from four sources:

- **Official maps** that come with the game.
- **Community maps** published by other map authors.
- **Tournament maps** from recent tournament map packs.
- **Test maps** written to check one rule of the game at a time.

A map here is one script with one seed and one set of lobby settings; a
repeated run of the same map counts once.

### Verified versions

- `101.103.48987.0`: 291 maps (152 official, 85 community, 29 tournament,
  25 test maps).
- `101.103.54800.0`: 549 maps (168 official, 230 community, 30 tournament,
  121 test maps).

### Measured on unseen scripts

Most of the maps above were also used to find and fix differences, so they
show what has been checked, not how often an unknown script matches. To
measure that, large and complex community scripts were picked at random,
recorded in the game with two seeds each, and compared once, before any fix
based on them:

| Date       | Game version      | Scripts | Maps | Maps that matched |
| ---------- | ----------------- | ------- | ---- | ----------------- |
| 2026-10-05 | `101.103.54800.0` | 33      | 66   | 44 (66.7%)        |
| 2026-10-07 | `101.103.54800.0` | 35      | 70   | 64 (91.4%)        |

These rates describe these two samples only. Scripts that could not be
recorded or compared at the time are not counted: three in the first sample,
one in the second. The differences found were fixed afterwards, and every
recorded map of both samples now matches.

### Limits

These maps cover the commands and settings that scripts use most, but not
every possible script: a script that uses something rare that none of the
compared maps used can still give a different map. Output names such
commands next to the result. A script on which the game itself crashes,
such as the official map Stranded in one verified version or the community
map Noble Bypass, is refused with an error instead of previewed.

If AoE2RMSIDE shows a different map than the game on a verified version,
please [report it](https://github.com/aoe2control/AoE2RMSIDE/issues/new/choose)
with the script, the seed, and the lobby settings.

## Game files

AoE2RMSIDE never ships game files. For each supported game version it
includes only plain numbers and names that scripts need: the values of the
game's built-in definitions and neutral facts about terrains and objects. It
does not include the game's data files, definition files, or standard include
scripts. Standard includes are read only from your own linked game folder.

You do not need the game installed to write, preview, and test scripts.
Linking your game folder adds the game's standard includes and installed
maps, the game version you have installed, deployment, and live testing.
Installations from the Xbox app or the Microsoft Store can be linked by
selecting their game folder; they are untested.

## Game art

AoE2RMSIDE never bundles, ships, uploads, or redistributes game art. The
**Minimap colors** and **Texture colors** looks of the preview and the map
icon are drawn from numbers only: minimap colors and one averaged color per
terrain or object. Graphics from your own game installation are only read
locally and never leave your computer.

The project's own artwork (the application icon and the map icon sprites) is
original and has a provenance record in
[assets/original](assets/original/README.md).

## Live testing and AoE2Control

Live testing starts a single-player match in the game with your script. It
uses a separately installed
[AoE2Control](https://github.com/aoe2control/AoE2Control/releases) release,
version 1.1.1 or newer;
AoE2RMSIDE does not include AoE2Control, and everything else works without
it. Live tests refuse to run in multiplayer.

## Your responsibility

Make sure you have the rights to the scripts and mod content you open,
deploy, or share.

## Trademarks

AoE2RMSIDE is an independent project. It is not affiliated with, endorsed by,
or sponsored by Microsoft, Xbox Game Studios, World's Edge, or Activision.
Age of Empires is a trademark of Microsoft Corporation. Product names are
used only to describe compatibility.
