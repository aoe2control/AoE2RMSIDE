# Notices and third-party material

AoE2RMSIDE is licensed under Apache-2.0. The project is independently authored
and is not affiliated with or endorsed by Microsoft, Xbox Game Studios,
World's Edge, or Activision. Product names are used only to describe interoperability.

Every package of the application carries `resources/THIRD-PARTY-NOTICES.txt`,
written at packaging time from the local dependency caches: the Rust crates
linked into the native programs (from the committed `Cargo.lock`), the Rust
standard library, and the npm packages bundled into the application (from the
committed `pnpm-lock.yaml`), each with its license and its own license and
notice files copied without changing their terms. A dependency that publishes
no license file is listed with the standard text of its declared license from
`assets/third-party/license-texts`. A dependency with an unknown or
incompatible license stops packaging. Electron's and Chromium's notices ship
beside the executable as `LICENSE` and `LICENSES.chromium.html`.

The desktop interface bundles Inter Variable from
`@fontsource-variable/inter`, Copyright 2016 The Inter Project Authors, under
the SIL Open Font License 1.1. Its license is preserved at
`assets/third-party/inter/LICENSE.txt`.

The interface components in `apps/desktop/src/renderer/components/ui` that
`apps/desktop/shadcn-preset.json` lists were generated from the shadcn/ui
registry with the pinned shadcn CLI and then adapted. shadcn/ui is Copyright
(c) 2023 shadcn, under the MIT License, kept at
`assets/third-party/shadcn-ui/LICENSE.txt`.

The native daemon links `bcdec_rs` 0.2.0 (MIT), a Rust port of the `bcdec`
block-compression library (`iOrange/bcdec`, MIT), to decode BC1, BC3, BC4, and
BC7 blocks for the optional local Game textures look. It is pinned
exactly. Its published package ships no license file, so the MIT license text
with the copyright notices of both projects is kept at
`assets/third-party/bcdec_rs/LICENSE.txt` and copied into the third-party
notices of every package.

Nontrivial visual assets and the bundled game-version data files carry a
provenance manifest stored beside them that records authorship, license, hash,
and a declaration that they contain no game content. Official game files, extracted or derived
game art, executable material, and captures are never inputs to this
repository.
