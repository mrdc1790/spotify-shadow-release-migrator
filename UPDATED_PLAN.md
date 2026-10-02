# Catalog and migrator plan — October 2, 2026

This supersedes the September conversation's performance estimates and proposed
integration. It is a design update, not an implemented bridge or live benchmark.
Personal Music Library was reviewed at commit
`ba6d7df625b7cdd23735184241424a5bb5590149`; companion browser documentation
was read from main on October 2.

## Current state

The catalog already provides durable resumable SQLite capture, imported snapshot
history, ordered occurrences, an exact-identity index, and a membership view.
Operational scan databases and historical catalog databases are different
formats. Data defaults to `%USERPROFILE%\MusicLibraryData`. Read-only local
inventory is available for explicit roots, with filename candidates and optional
WAV duration evidence. Recording equivalence, device reconciliation, and
full-library scale validation remain planned.

The separate browser migrator already supports selected Liked Songs membership,
verified replacement reads, a restricted localhost GET relay, serialized reads,
persisted cooldowns, and session preview page checkpoints. Resume revalidates
playlist snapshots. Discovery and selected saved membership are read again;
confirmed migration uses fresh reads. These checkpoints are recovery state,
not historical catalog backups or a durable mutation journal.

Neither project reads the other's data/code/credentials. The browser app is not
a frontend to the Python migration engine. That engine's execution restrictions
and durable journal remain separate.

## Corrections

- Withdraw the 10–30+ minute versus 2–8 minute estimates and guaranteed
  millisecond previews: no full-account measurements supported them.
- Withdraw the default recommendation for 5–10 concurrent playlist reads.
  A captured response reported `QUOTA_EXCEEDED` and a multi-hour `Retry-After`.
  The original quota consumer remains unknown; concurrency cannot increase quota.
- Development Mode apps owned by one developer share quota across Client IDs.
  Running both projects together is not an independent quota workaround.
- Do not stop scanning a playlist at its first match: migration must preserve
  all source occurrences and pre-existing destination occurrences.
- Refreshing only old positive matches cannot establish every current location.
  Formerly negative and newly created playlists may now contain the source.
- Complete API traversal establishes endpoint-scoped evidence, not universal
  desktop/phone Local Files or Liked Songs coverage.

## Revised implementation order

1. Resume the existing durable capture respecting its cooldown, validate useful
   coverage, and import a supported snapshot into the historical catalog. Keep
   partial evidence browseable with unknown coverage visible.
2. Measure request counts, pages, retries, cooldown time, imported rows, lookup
   latency, and memory. Current generic search loads snapshot rows; add a narrow
   SQL exact-instance query using the existing index before promising scale.
3. Define a versioned catalog discovery export: account, snapshot/time, schema,
   coverage, source IDs/versions, all occurrences/positions, returned/original
   identity evidence, reviewed mappings, and existing destination occurrences.
   Exclude credentials. Test duplicates, partial coverage, unknown identities,
   pre-existing targets, and account/version mismatches.
4. Add explicit read-only browser import. Label locations as observations from
   the selected capture, including age and coverage. Keep both apps independently
   runnable; export/import is the first bridge, with a local API considered later.
5. Add current-location refresh: fetch the editable playlist manifest, compare
   fresh versions across previously covered playlists, and read changed/new/unread
   sources. Reuse complete unchanged negative as well as positive results.
   Recheck selected Liked Songs membership separately. Preserve fresh target
   preflight and replacement verification; unknown coverage cannot bypass the
   executor's completeness/confirmation gates.
6. Build the catalog's planned recording resolver after coverage and exact-ID
   queries work. Single/album/deluxe candidates need evidence and review. Grouping,
   preferred release choice, migration, and deduplication are separate decisions.
   Local file/device evidence remains a separate source.

## Performance expectations to validate

| Workflow | Spotify reads | Remaining work |
|---|---|---|
| Historical catalog discovery | Zero | Local query and coverage display |
| Existing browser resume | Reuses validated completed pages | Discovery, version checks, changed/remaining pages |
| Future incremental current preview | Avoids unchanged content reads | Manifest/versions plus changed/new/unread sources |
| Migration confirmation | Fresh reads remain | Target preflight and write verification |
| Initial useful capture | No guaranteed duration | Durable progress and quota/cooldowns |

Illustration only: reducing a 3,000-read traversal to a 650-read incremental
preview saves about 78% of requests. This is not an account measurement or a
4.6× elapsed-time guarantee. Quota cooldowns can dominate duration. The largest
predictable saving is avoiding network scans for historical discovery and review.

## Updated references

- [Evidence/model, replacing DATA_MODEL.md](https://github.com/mrdc1790/personal-music-library/blob/ba6d7df625b7cdd23735184241424a5bb5590149/docs/EVIDENCE_AND_MODEL.md)
- [Roadmap and resolver/executor boundary](https://github.com/mrdc1790/personal-music-library/blob/ba6d7df625b7cdd23735184241424a5bb5590149/docs/ROADMAP.md)
- [SQLite decision](https://github.com/mrdc1790/personal-music-library/blob/ba6d7df625b7cdd23735184241424a5bb5590149/docs/STORAGE_DECISION.md)
- [Reference-tool review](https://github.com/mrdc1790/personal-music-library/blob/ba6d7df625b7cdd23735184241424a5bb5590149/docs/REFERENCE_PROJECTS.md)
- [Browser migrator current behavior](https://github.com/mrdc1790/spotify-shadow-release-migrator/blob/main/README.md)
- [Rate-limit incident; old sections are superseded](https://github.com/mrdc1790/spotify-shadow-release-migrator/blob/main/RATE_LIMIT_INCIDENT.md)
- [Spotify shared developer-account quotas](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)
- [Spotify rate limits and snapshot reuse](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)

Spotify Dedup is a heuristic duplicate-review reference, including distinct
single/album IDs; it does not prove audio equivalence or comparable quota.
The identified older tool is
[AfterForever667/spotify_songs_relink](https://github.com/AfterForever667/spotify_songs_relink).
Its one-playlist/Liked Songs scope and occurrence-collapsing behavior make it
unsuitable as a full-library migration performance benchmark. The current
catalog reference review records these differences; no account-backed runtime
comparison was performed.

Cross-repository impact was checked against the catalog's current documentation
and lookup/scanner source. No companion edit is required: this documents a
proposed interface and does not change either project's runtime behavior.
