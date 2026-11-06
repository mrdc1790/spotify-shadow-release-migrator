# Spotify Playlist Migrator contributor guidance

## Migration safety

This browser app previews Spotify replacements across playlists and Liked Songs.
Only explicit confirmation permits account writes.

- Keep preview, validation, and rendering read-only. Add and verify destination
  tracks before removing source tracks. A failed required add or verification
  blocks removal.
- Preserve every source occurrence. Existing destination occurrences do not
  offset additions owed by source occurrences.
- Treat unreadable playlists, partial results, rate limits, and unverifiable
  state as failures or unknown coverage.
- Keep browser-side PKCE and token refresh. Keep client secrets out of the app
  and tokens and account data out of logs, commits, and tool output.
- The approved localhost relay may forward allowlisted GETs for cooldown
  headers. Reject writes, foreign origins and hosts, and redirects. Never log
  or persist credentials. Confirmed writes stay in the browser.

## Changes and tests

- Trace preview and confirmed execution before changing migrations. Check Liked
  Songs, duplicates, retries, and post-write verification. Describe actual
  guarantees in the UI, including the limits of rollback.
- Change redirect settings, OAuth scopes, or account-write rules only when
  explicitly requested, with corresponding tests and docs.
- Add focused `spotify.test.js` coverage for behavior changes, especially
  failure and ordering. Run `npm test` for JavaScript behavior changes and a
  local read-only preview smoke test for UI changes when practical. Preserve
  safety assertions unless the task explicitly changes an invariant.
- Use four-space indentation and follow the existing Prettier configuration.

See [work status](WORK_STATUS.md) for handoffs. The Personal Music Library is
the sibling catalog.

## Navigation and verification

Use Dekko MCP for unfamiliar code and impact analysis. Resolve the current
checkout's absolute path and pass it as `root` on every call. Check each
repository's map separately with `map_status`. Refresh stale or missing maps
when supported and reuse fresh maps until relevant code changes.

Start with a compact summary and focused searches. Use file-qualified symbols
and bounded context once the target is known. Verify ambiguous calls and
consequential zero-caller results in source, including tests where relevant.
For familiar edits or unavailable indexing, use targeted `rg` and direct
source and test inspection.

Inspect Git status before editing, preserve unrelated changes, and keep diffs
focused. Keep source readable and follow existing formatting conventions.

## Cross-repository changes

Locate the sibling checkout when a task touches shared Spotify rules for
writes, saved tracks, duplicates, coverage, reconciliation, OAuth, or migration
safety. Inspect its source, tests, and docs before deciding on a companion edit.
Keep each repository independently runnable and testable. Shared runtime paths
or imports require an explicit task requirement. Edit both only when behavior,
interfaces, or documented guarantees would otherwise diverge. Report what you
checked and run relevant tests in each changed repository.

## Project tracking

Use the private [Personal Development Project](https://github.com/users/mrdc1790/projects/1)
for substantial work, work spanning repositories, or meaningful blockers.
Skip routine questions and small cleanups. Check the Project and relevant
issues for an existing item before adding one. Keep status, area, and agreed
priority current. Mark Done after verification and link the evidence. Keep
detailed plans in repository docs and private data out of tracking. If access
is unavailable, continue and report the pending update. Summarize tracking
in the final reply.
