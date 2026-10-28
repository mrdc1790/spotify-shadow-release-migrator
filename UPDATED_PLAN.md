# Migrator recovery and personal-library integration plan

Status reviewed against both local working trees on **October 27, 2026**. This
updates the implementation sequence from the earlier handoff; it does not announce
a published release. Existing uncommitted work is retained. This documentation
refresh changes no runtime code, OAuth settings, personal database, or Spotify
membership.

## Goal and supplied track pair

Produce a complete, inspectable read-only preview for a reviewed source/destination
mapping across editable playlists and selected Liked Songs membership, then
execute only after explicit confirmation with fresh safety checks. Preserve every
source occurrence plus pre-existing destination occurrences. Failed or incomplete
coverage remains unknown and blocks confirmation.

The supplied track IDs are `5DdmY05GZLzvkvbAHrUVYv` and
`3xm40MKtw5Xu7FeBmruQWZ`. Fixtures use the first as source and the second as
destination. That test direction is not an approved live mapping or proof of
recording equivalence. Review the exact IDs and available release metadata before
any account write. The earlier roughly 20-minute failure still lacks its final
error/version/progress evidence; do not assign its cause from fixture results.

## Delivered versus pending

| Area | Status | Evidence or limit |
|---|---|---|
| Durable preview recovery | Implemented locally in `preview-store.js`, `spotify.js`, and `app.js` | IndexedDB transaction completion is awaited; session/memory fallback is visible; tab-close recovery depends on retained site data |
| Resume and progress | Implemented locally | Saved draft, fresh version validation, Stop scan, checked/remaining/reused/resumed/changed/page/unresolved counts |
| Account and mapping safety | Implemented locally | Account checked before cache access, immutable identity preferred, legacy checkpoints promoted, edited mappings invalidate approval |
| Confirmed execution | Existing separate fresh-read path | No preview checkpoint is trusted for final preflight or readback; no durable browser mutation journal or journal-based rollback |
| Personal Music Library runtime | Existing Python/SQLite capture, import, history, and query foundations | October 22 recovery work and this docs refresh add no catalog schema/query feature and populate no personal database |
| Catalog discovery export/import | Planned | No bridge CLI, browser importer, shared storage, credentials, or runtime dependency |
| Recording resolver and rich metadata | Planned catalog work | Exact selected-ID discovery need not wait for canonical recording matching, enrichment, DJ features, or recommendations |
| Account-backed acceptance | Pending for the supplied pair | Synthetic tests do not establish membership, quota availability, direction approval, or migration success |

The catalog is not a prerequisite for this browser recovery feature. Its database
remains the intended long-lived evidence/query engine; IndexedDB is a recoverable
preview cache. Keep their capture/enrichment jobs and credentials independent.

## Next delivery sequence

1. **Validate the current browser preview against the account.** Use an authorized
   sign-in and the exact reviewed links. Record actual endpoint/read counts,
   completion and unresolved coverage, pause/recovery behavior, and the sanitized
   final error if one occurs. Do not infer absence from a failed source. A preview
   does not authorize execution.
2. **Validate useful catalog capture/import coverage.** Resume the existing
   read-only Python capture workflow, retain partial/failed evidence, explicitly
   export a completed capture, and import it into the separate historical catalog.
   Keep capture SQLite and catalog SQLite formats distinct. Coordinate network
   work with known cooldowns; overlapping requests are not a quota strategy.
3. **Measure and improve local queries.** Benchmark capture/import size and cost,
   exact-instance lookup latency, and memory. The catalog's general lookup,
   set-query, and comparison paths still materialize snapshot rows. Add focused
   indexed SQL operations where justified, with duplicate/order/coverage tests;
   do not promise full-library latency before measuring it.
4. **Implement a versioned catalog discovery export.** Follow the catalog's
   [handoff requirements](https://github.com/mrdc1790/personal-music-library/blob/main/docs/INTEGRATION_DESIGN.md#catalog-to-migrator-discovery-handoff-planned).
   Retain account, capture/snapshot dates, source IDs/versions, coverage and errors,
   original/returned identity evidence, all ordered occurrences, and existing
   destinations. Include negative and unreadable sources; export no credentials.
   Missing fields remain unknown. This is future implementation, not an available
   command or a finalized JSON schema.
5. **Add explicit read-only browser import.** Validate schema/account/counts/
   positions/coverage and display historical observations with their dates. Import
   itself performs zero provider calls and cannot enable migration. Keep both
   repositories independently runnable without cross-repo imports or a local
   database service.
6. **Validate current discovery from imported evidence.** Freshly enumerate all
   playlists, check versions across positive and negative historical results, read
   changed/new/unresolved sources, and freshly check selected Liked Songs and
   releases. Only unchanged complete evidence may be reused. Keep complete-coverage
   confirmation gates and fresh execution preflight/readback.
7. **Expand catalog intelligence separately.** Reviewed recording relationships,
   local/device reconciliation, artist/release history, permitted enrichment,
   offline playlist/DJ/placement queries, and later publishing retain their own
   prerequisites. Ordinary queries use committed local data with no hidden
   provider requests. Browser mutation journaling needs a separate design.

The browser validation and catalog coverage work may progress independently.
Do not delay a selected-ID preview until the entire rich library is complete, or
add a second hidden scanner merely to avoid an explicit handoff.

## Integration acceptance

- Reject unsupported/corrupt formats, wrong accounts, invalid positions/counts,
  and incomplete evidence masquerading as complete. Retain missing/local rows
  and identity uncertainty.
- Preserve ordering and duplicate multiplicity. Two source occurrences plus one
  existing destination must contribute three destination occurrences after a
  confirmed replacement; migration is not deduplication.
- Test unchanged positives and negatives, changed formerly negative playlists,
  newly created playlists, partial pages, repeated pages, changing snapshots,
  unknown Liked Songs freshness, interrupted storage commits, and failed reads.
- Test historical import with a request adapter that rejects every network call;
  imported evidence alone must never enable execution.
- Keep fresh execution checks and add/verify-before-remove tests, including
  failures that leave successful additions present while sources remain.
- Measure requests, storage, time, and memory. No unmeasured speed estimate,
  guaranteed instant preview, aggressive default concurrency, or quota bypass.

## Validation record and startup

On October 27, `npm test` passed **65/65** migrator tests and
`python -m unittest test_library.py` passed **11** catalog tests. These are offline
fixtures, including the supplied IDs and an interrupted 581-playlist scan with a
changed formerly negative source. The October 22 native browser smoke test
demonstrated interrupted preview, tab close/reopen, and resume with one completed
playlist reused and one partial playlist resumed. It used synthetic metadata and
no Spotify credentials; it was not rerun for this docs-only refresh.

Default startup remains `npm start` on `http://127.0.0.1:5173/`. On October 22,
Windows reserved 5141–5240 and refused port 5173; an alternative startup on 18080
worked. That is dated workstation evidence, not a current port probe or proof the
server is still running. See [setup and port recovery](README.md#2-start-the-tool).
Register the exact actual redirect URI before sign-in. Changing host/port/profile
uses different browser storage and does not transfer a saved cooldown or cache;
never switch origins to evade a known wait. No developer-dashboard or Windows
reservation change was made by the recovery work.

Use [README](README.md) for operation, [incident history](RATE_LIMIT_INCIDENT.md)
for earlier failures and superseded policies, and
[reconciliation](CROSS_CLIENT_RECONCILIATION.md) for identity/device limits. The
catalog [roadmap](https://github.com/mrdc1790/personal-music-library/blob/main/docs/ROADMAP.md)
owns its database delivery priorities. Dated external research in those documents
has not been revalidated by this local documentation review.

## Historical plan and research — October 2 and 19, 2026

This supersedes the September conversation's performance estimates and proposed
integration. It is a design update, not an implemented bridge or live benchmark.
Personal Music Library was reviewed at commit
`ba6d7df625b7cdd23735184241424a5bb5590149`; companion browser documentation
was read from main on October 2.

### Current coordination — October 19, 2026

The [shared integration roadmap](https://github.com/mrdc1790/personal-music-library/blob/main/docs/CATALOG_MIGRATOR_ROADMAP.md) now owns the authoritative
implementation order and acceptance criteria. Its sequence supersedes the
October 2 sequence below: align docs, validate a manual workflow,
specify a proposal contract, add read-only export/import, return outcomes, then
consider incremental preview and executor consolidation. Those phases are planned
except documentation alignment; no bridge or live trial was implemented here.

The catalog owns discovery/history/evidence; the browser is the preferred future
reviewed execution interface. Existing Python execution retains its restrictions
and remains available pending a capability/recovery comparison. The corrections,
performance caveats, and technical research below remain reference material.

### Current state

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

### Corrections

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

### October 2 implementation sequence (superseded)

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

### Performance expectations to validate

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

### Updated references

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

The October 2 review checked the catalog documentation and lookup/scanner source.
The October 19 documentation update checked both projects' current guidance and
plans and links them to the shared roadmap; neither project's runtime behavior
changed.
