# Spotify Playlist Migrator — contributor guidance

## Project purpose and safety boundary

This browser-based tool previews and, only after explicit user confirmation,
migrates Spotify tracks across playlists and Liked Songs. Correctness and safe
failure take priority over convenience.

- Keep preview paths read-only. The confirmation action is the account-write
  boundary; do not move mutations into preview, validation, or rendering code.
- Preserve the add-before-remove order. If any required add or verification
  fails, do not remove source tracks.
- Preserve duplicate source occurrences: an existing destination occurrence
  must not cancel the occurrence contributed by a source track.
- Treat unreadable playlists, partial data, rate limits, and unverifiable state
  as failures or unknowns—not as empty collections or permission to proceed.
- Do not log, commit, or expose access tokens, client-specific data, or Spotify
  account details. Do not add a client secret to this frontend application.

## Navigation and impact analysis

Use Dekko for unfamiliar-codebase navigation, dependency tracing, symbol
discovery, caller/callee analysis, change-impact analysis, and identifying
relevant tests.

- This repository contains a `.dekko` map. Prefer focused Dekko queries such as
  summary, search, outline, context, diff, affected, and workset before broad
  repository reads.
- Do not use Dekko for a trivial change when the relevant implementation is
  already known.
- Treat the map as navigation help, not implementation truth: read the actual
  source before modifying code.
- Regenerate a stale map when the installed Dekko workflow supports it. If
  Dekko is unavailable, use targeted `rg` searches plus direct source/test
  inspection.
- For low- or zero-caller results that matter to correctness, use Dekko's
  sanity check when available and verify against the source.

## Source formatting

Keep source files human-readable.

- Never minify HTML, CSS, or JavaScript source files.
- Use 4 spaces for indentation; do not use literal tab characters.
- Use normal blank lines between top-level functions and logical sections.
- Prefer separate `const` or `let` declarations when variables represent
  different concepts, and do not chain unrelated declarations with commas.
- Prefer readability over minimizing line count. Keep one statement per line
  where practical and do not compress functions onto single lines.
- Keep formatting compatible with the existing Prettier configuration and
  preserve established conventions when editing existing files.

## Implementation and verification

- Keep authentication on Authorization Code with PKCE and retain the
  client-only/no-client-secret design.
- Before changing migration behavior, trace both the preview and confirmed
  execution paths, including Liked Songs, duplicate occurrences, retry/error
  handling, and post-write verification.
- Make UI copy accurately describe safety guarantees and limitations; never
  imply transactional rollback across Spotify playlists.
- Add or update focused tests in `spotify.test.js` for behavior changes,
  especially failure paths and ordering guarantees.
- Run `npm test` after JavaScript behavior changes. For UI changes, also start
  the app locally and perform a read-only preview smoke test when practical.
- Do not weaken existing safety assertions to make an implementation change pass;
change an established invariant only when the task explicitly requires it.

## Working-tree discipline

- Inspect the working tree before edits and preserve unrelated user changes.
- Keep changes narrow; avoid unrelated refactors and generated-file edits.
- Do not alter OAuth redirect settings, scopes, or account-write behavior
  without an explicit task requirement and corresponding tests/documentation.

## Cross-repository coordination

The sibling repository at
`C:\Users\polla\Documents\ChatGPT\personal-music-library` is a separate,
evidence-preserving catalog with related Spotify audit and reconciliation
workflows. Its behavior is not automatically shared with this application.

- Before changing shared Spotify assumptions—read/write boundaries, saved-track
  handling, duplicate occurrences, partial coverage, reconciliation, OAuth
  scopes, or migration safety—inspect the sibling repository for affected
  code, tests, and user documentation.
- For unfamiliar cross-repository impact, use targeted Dekko queries in this
  repository and targeted `rg` searches in the library repository. Read the
  matching source before deciding whether a companion change is needed.
- Keep each repository independently runnable and testable. Do not create a
  runtime dependency, shared relative path, or cross-repo import without an
  explicit task requirement.
- Make a companion edit only when a behavior, safety promise, interface, or
  documentation claim would otherwise become inconsistent. State that linked
  impact in the change summary and run the relevant tests in every changed
  repository.
- When no sibling change is required, record that the cross-repository impact
  was checked; do not broaden a focused task merely for symmetry.
