# Contributing to AoE2RMSIDE

Thank you for helping. This guide explains what kinds of contributions fit the
project, how to prepare a change, and how to suggest translations without any
development setup.

## What is likely to be accepted

AoE2RMSIDE is created and maintained by one person, who keeps the final say
over scope and integration. Please read this before you invest time:

- **More likely to be considered**: user interface and usability
  improvements, feature requests, translation fixes, and small, focused bug
  fixes that come with clear steps to reproduce and are easy to check.
- **Generally not accepted as pull requests**: changes to RMS parsing,
  interpretation, random number generation, map generation, behavior
  profiles, or claims about how closely maps match the game. Checking those
  depends on the project creator's own research and comparison process
  against the game, which is not part of this repository, so please open an
  issue with a script, seed, and settings instead. Such reports are very
  welcome.
- **Please discuss first**: large features, new dependencies, and anything
  that changes a data format or the application's architecture.

Feature ideas and questions are welcome on
[Discord](https://discord.gg/CpVxzRfvm7). Use the issue forms for bugs and
translation suggestions.

This is guidance, not a promise. No issue or pull request is guaranteed a
review, acceptance, or merge, and the creator decides what fits the project
and how it is integrated. Merged changes may be adjusted afterwards.
Responsible security reports are always welcome; see
[Reporting bugs and security issues](#reporting-bugs-and-security-issues).

## Before you start

Follow the build instructions in [BUILDING.md](BUILDING.md).
The build needs no game installation. [AGENTS.md](AGENTS.md) summarizes the
architecture and the rules a change must never break; read it first.

Source files use Windows line endings in your working copy. Keep Git's
default Windows setting (`core.autocrlf=true`) when you clone, or the
formatting check reports every file.

## Coding guidelines

- Keep changes small and focused. One pull request should do one thing.
- Match the surrounding code: naming, structure, error handling, and
  formatting. Run Prettier and rustfmt; do not reformat unrelated code.
- Keep behavior deterministic. The same input must give the same output, with
  stable ordering and fixed-width integer behavior.
- Bound every input: sizes, counts, nesting depth, and time. Reject input that
  exceeds a bound with a clear error instead of degrading silently.
- Report failures as structured errors with a stable code and a plain message.
  Fail closed: an operation either completes or leaves the previous state
  unchanged.
- Treat every protocol message, schema, profile, and data file as a versioned
  contract. Unsupported major versions must be refused.
- Do not edit generated files by hand. Change the source and regenerate (for
  the Protobuf bindings, `pnpm schema:generate`).
- Pin new dependencies to exact versions, commit the updated lockfile, and
  explain in the pull request why the dependency is needed.
- Never add game files, game art, or anything derived from them that could be
  recognized as game art.

## User interface guidelines

- Build the interface from the existing component layer in
  `apps/desktop/src/renderer/components/ui` and the semantic color tokens in
  `apps/desktop/src/renderer/styles.css`. Do not add another general-purpose
  UI kit or hard-coded colors.
- Controls have no borders. Buttons and badges are told apart by their
  background and their hover and active states; use the `secondary` variant
  for a filled action and `ghost` for a quiet one. Only focus rings and
  validation states draw a border. An on/off setting is a toggle button, not
  a check box.
- Reuse a shared component for a repeated action instead of restyling it at
  each site.
- Popups, menus, dialogs, tooltips, and panels use the shared motion classes
  and tokens (`motion-surface`, `motion-dialog`, `--motion-*`). Do not add
  per-site animations. Respect reduced motion.
- Everything must work with the keyboard alone, with a visible focus
  indicator, readable contrast, and accessible names.
- Check every change in both the light and dark themes, at a small window
  size, and at increased display scaling. Text in other languages is often
  longer than in English; a label that may not fit uses the shared
  overflowing label instead of a fixed width.

## Interface text

Every word the interface shows comes from the language files in
`apps/desktop/src/shared/i18n/catalogs`, never from a literal string in a
component.

- Add new text to the English file, `en.json`, under a new message id, and
  read it with `t('your.message.id')`. Ids are written out in full, never
  assembled from pieces.
- Give each new entry its translator context: `screen` (where it appears),
  `control` (what shows it), `meaning` (what it does and what must stay as
  written), `placeholders` (what each argument stands for), and `maxLength`
  for narrow places such as buttons and menu items.
- Write a sentence as one message with placeholders and plurals, for example
  `{count, plural, one {# file} other {# files}}`, instead of joining pieces
  in code.
- RMS commands, attributes, constants, file names, and error codes stay in
  English.
- You do not need to translate new or changed text into the other
  languages. Say in the pull request which messages you added or changed.

`pnpm lint` reports code that uses a message id `en.json` does not have.

## Checking your change

Before opening a pull request, run these from the repository root:

```powershell
pnpm format:check
pnpm lint
pnpm build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

`pnpm format:check` checks Prettier formatting, `pnpm lint` type-checks the
desktop application, and `pnpm build` builds it. The two `cargo` commands
check Rust formatting and lints; run them when you changed Rust code.

Then try the change in the packaged application (`pnpm package`) and check the
situations it affects, including error cases. In the pull request, describe
what you checked and how. For interface changes, include before and after
screenshots; for motion or animation changes, include a short video.

## Pull requests

- Describe the problem and the change in plain words, and link the related
  issue.
- Keep the description and commit messages about the change itself.
- Contributions are accepted under the project's
  [Apache License 2.0](LICENSE).

## Translations

You do not need to be a developer to help with translations. AoE2RMSIDE's
interface is available in English and 19 other languages, and every
improvement to their wording is welcome.

### Suggest a change

Open a
[translation suggestion](https://github.com/aoe2control/AoE2RMSIDE/issues/new?template=translation_suggestion.yml)
with the language, the current text, your suggestion, and where the text
appears in the application. A screenshot helps. This is also the way to ask
for a language that is not available yet.

### Edit a language file

You can change a translation directly in your browser on GitHub:

1. Open `apps/desktop/src/shared/i18n/catalogs/en.json` and search for the
   English text you want to change. Note the message id above it, for
   example `app-menu.file.open-file`.
2. Open your language's file in the same folder, for example `de.json` for
   German or `pt-BR.json` for Brazilian Portuguese, and search for the same
   message id.
3. Select the pencil icon to edit the file, change the text after
   `"message":`, and propose the change. GitHub creates the pull request for
   you.

The English entry describes where each message appears, what kind of control
shows it, what it means, what its placeholders stand for, and the longest text
that fits. Read it to choose wording that fits the button, menu, or message.

When you edit a language file:

- Keep message ids, placeholders such as `{count}`, and formatting
  instructions such as `{count, number}` unchanged. You may move a
  placeholder within the sentence.
- Keep the plural words such as `one`, `few`, `many`, and `other` that the
  message already has in your language; they follow your language's grammar,
  not English.
- Keep RMS commands, constants, labels, file extensions, and product names as
  written. Lobby settings use the game's own term in your language.
- Messages marked `"translate": false` in the English file stay in English
  and are left out of the other language files.
- Use the same term for the same action across menus, buttons, and messages.

To see the current translation in context, choose the language in
**View → Language…**. Translation changes are checked for placeholders and
length before they are merged.

## Reporting bugs and security issues

Use the bug report form for bugs. Include the application version (the
release you downloaded, or the commit you built from), the game version you
selected, the steps to reproduce, and for map differences the script, seed,
and settings.

Do not report security vulnerabilities in public issues. Report them
privately through
[GitHub's private vulnerability reporting](https://github.com/aoe2control/AoE2RMSIDE/security/advisories/new)
as described in [SECURITY.md](SECURITY.md). Responsible reports are always
welcome.
