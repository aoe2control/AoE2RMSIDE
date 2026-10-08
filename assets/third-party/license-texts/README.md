# Standard license texts

Packaging writes `resources/THIRD-PARTY-NOTICES.txt` into every package
(`tools/third-party-notices.mjs`). A dependency that publishes no license file
of its own is listed there with the standard text of its declared license,
taken from this folder; `{{copyright}}` is replaced by the copyright holders
named in the package's metadata.

- `Apache-2.0.txt`, `MIT.txt`, `BSD-2-Clause.txt`, and `ISC.txt` are the
  license texts the pinned Rust toolchain ships in `share/doc/rust/licenses`.
- `BSD-3-Clause.txt` is the standard BSD 3-Clause text.
- `BSL-1.0.txt` is the Boost Software License 1.0.

Only the copyright placeholders were changed.
