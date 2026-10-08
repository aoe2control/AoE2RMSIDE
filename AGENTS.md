# AoE2RMSIDE contributor guide

This file is a short orientation for anyone changing the code, whether by hand
or with automated coding tools. Everything else, including what kinds of
changes are accepted, how to check a change, the interface rules, and how to
help with translations, is in [CONTRIBUTING.md](CONTRIBUTING.md). Build
instructions are in [BUILDING.md](BUILDING.md).

## What the application is

AoE2RMSIDE is a Windows desktop editor for Age of Empires II: Definitive
Edition random map scripts (RMS), with XS script support. An Electron, React,
and TypeScript application hosts a Monaco code editor and a live map preview.
Separate Rust executables parse, analyze, and generate maps from scripts,
using versioned behavior profiles that describe each supported game version.
The application works without the game; a linked game folder adds the game's
own maps, deployment as a local mod, and the optional Game textures look.

## Rules a change must never break

- **Windows 10 and 11, x64** is the only target platform.
- **The renderer stays sandboxed.** Renderer code never gets direct Node.js,
  file system, or child process access. It talks to the Electron main process
  only through the typed preload bridge, and main validates every request.
- **No game art in the repository.** Never add game files, game art, or
  recognizable derivatives of them to the repository, the package, or the
  data files. Artwork must be original and come with a provenance manifest.
  Art from the user's own installation is read only from that linked
  installation into a local cache under the application's data, after the
  user turns it on, and never enters the repository or the package.
- **Never write into the game installation.** Game folders are read-only. In
  the user's game profile, the application writes only files it created and
  recorded itself (its managed mods and staged live-test files), and never
  overwrites a file the user owns or changed.
- **Native code runs out of process.** Rust executables talk to the
  application through versioned, length-framed Protobuf messages over
  standard input and output. Do not add a Node.js native addon.
- **Contracts are versioned and fail closed.** Every protocol, schema,
  profile, and data file has a version, and an unsupported major version is
  refused. Changing a contract means a new version, not a silent edit.
- **Behavior is deterministic and bounded.** Same input, same output, with
  stable ordering, fixed-width arithmetic, bounded input sizes, structured
  errors, and transactional failure that leaves the previous state intact.
- **One UI component layer.** The interface uses the existing component layer
  and semantic tokens. Do not add another general-purpose UI kit.
- **Every interface word comes from the language files.** User-facing text is
  a message in `en.json` with its translator context, never a literal string
  in a component.
- **Claims about matching the game stay scoped.** Maps are only described as
  matching the game for verified behavior profiles within their limits. Do
  not change parsing, random number generation, generation rules, or profiles
  to "fix" a difference; report it instead (see CONTRIBUTING.md).
- **Builds stay self-contained.** The build must not depend on an installed
  game, another repository, or network services at run time.

## Repository layout

| Path                                      | Contents                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| `apps/desktop/src/main`                   | Electron main process: files, processes, game discovery.  |
| `apps/desktop/src/preload`                | The typed bridge between main and the renderer.           |
| `apps/desktop/src/renderer`               | The React interface, editor, and map preview.             |
| `apps/desktop/src/renderer/components/ui` | The owned component layer (buttons, dialogs, menus).      |
| `apps/desktop/src/shared`                 | Types and contracts shared by main and the renderer.      |
| `apps/desktop/src/shared/i18n/catalogs`   | Interface language files (`en.json` is the source).       |
| `apps/desktop/src/generated`              | Generated Protobuf bindings (`pnpm schema:generate`).     |
| `bins/rmsd`                               | Generation daemon.                                        |
| `bins/rms-ls`                             | RMS and XS language server.                               |
| `bins/rms-test`                           | Map test runner and its language server.                  |
| `crates/rms-*`                            | RMS source, syntax, semantics, profiles, content, engine. |
| `crates/xs-*`                             | XS syntax and analysis.                                   |
| `proto`                                   | Protobuf contract.                                        |
| `schemas`                                 | JSON schemas of the data files.                           |
| `profiles`                                | Behavior profiles and presentation palettes.              |
| `assets`                                  | Original artwork and third-party licenses.                |
| `tools`                                   | Build and packaging scripts.                              |

Generated files are regenerated, not edited by hand. Lockfiles are committed;
install with `pnpm install --frozen-lockfile` and build Rust with `--locked`.
Before you finish a change, run the checks listed under "Checking your
change" in [CONTRIBUTING.md](CONTRIBUTING.md).
