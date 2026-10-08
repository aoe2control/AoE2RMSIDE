# Behavior profiles

A behavior profile describes how one game version parses and generates random
map scripts: its parser, random number, generator, and failure decisions. A
profile is kept separate from executable and content identities, and a
published profile file never changes. A new game version gets a new profile.

| Profile                       | Game version      | Status   |
| ----------------------------- | ----------------- | -------- |
| `aoe2de-101.103.48987-rms-v1` | `101.103.48987.0` | verified |
| `aoe2de-101.103.54800-rms-v1` | `101.103.54800.0` | verified |

- **Verified** means the profile's version label is listed in
  `productVersions`. The label does not prove that a particular user's
  installation is that same build, and a verified profile is not a promise
  that every script produces the same map as the game.
- **Unverified** means the version is listed only in
  `unverifiedProductVersions`. The profile is usable, and every result it
  produces is labelled as coming from an unverified version. Its maps are not
  guaranteed to match the game. Every shipped profile is verified; a game
  version newer than every profile uses the newest profile below it, and its
  results are labelled as unverified.

A version label selects at most one profile. A linked game version without a
profile of its own stays usable, and its results are labelled as unverified.

For a verified profile, the strict parser and every generation stage are covered
for maps up to 512 × 512 tiles and scripts of up to 65,536 operations. Scripts
beyond those limits are refused before generation instead of producing an
approximate map.

Profile schema `1.1.0` adds version-gated generator decisions
(`object-group-roll-filter` and `path-no-route-result`). A `1.0.0` profile
cannot carry them and always uses the original rules.

## Minimap palettes

The optional `minimapPalettes` section is presentation data only. It is not
part of the behavior-profile hash or any generation identity. Each entry
holds 24-bit sRGB colors resolved from the game's dedicated minimap palette
indices for terrains, neutral objects, and cliff types; no texture, sprite, or
image is sampled. A terrain without an entry falls back to the linked
installation's own palette or to a family color, never to black.

## Texture palettes

`texture-palettes/<profile id>.json` (schema
`schemas/texture-palettes.schema.json`) holds one averaged color per terrain,
neutral object, and cliff type for the preview's **Texture colors** look and
the default map icon look. These are presentation data only and are bound to
their profile by `profileId`, so the profile files themselves stay unchanged.
They are averaged, derived data, never an image, and each entry records its
derivation tool, the game build it was derived from, and the date.

## Constant kinds

`constant-kinds/<profile id>.json` (schema
`schemas/constant-kinds.schema.json`) gives each built-in constant name of
that game version one kind (object, terrain, cliff type, map type,
civilization, attribute, and so on), so completion without a linked game
offers object names where an object fits and terrain names where a terrain
fits. The kinds come from the section headings of that version's definition
file; the documents hold only names, which the support bundle already ships,
and kinds, never the file's text. They are editor help only, bound to their
profile by `profileId`, and each entry records its derivation tool, the game
build and input file hash it was derived from, and the date.

## Certified constructs

`certified-constructs/<profile id>.json` (schema
`schemas/certified-constructs.schema.json`) lists, for that game version, the
commands and block attributes (each in the place where it ran) that at least
one recorded game map that matched the preview has used. A preview whose
script uses others says so ("3 commands not compared against the game").
The documents hold only names and places, never script text, are bound to
their profile by `profileId`, and each entry records its derivation tool, the
game build of the recorded maps, how many maps it merged, and the date. A
version that is not verified makes no such claim.
