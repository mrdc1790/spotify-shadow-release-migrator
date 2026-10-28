# Spotify Playlist Migrator

Safely replace a Spotify track—or an entire shadow re-release of an album—across every playlist you own or collaborate on.

## Implementation and plan status — October 27, 2026

The local implementation includes persistent preview recovery, resume/stop,
progress and fallback reporting, and fresh validation before confirmed writes.
The personal-library database was not extended or populated by that recovery
work. A catalog exporter/browser importer and browser mutation journal remain
planned; recovery can be used without them. See the
[current delivery plan](UPDATED_PLAN.md) for ownership, dependencies, integration
acceptance, and the remaining authenticated test for the supplied track pair.

October 27 checks passed 65 migrator tests and 11 catalog tests. The October 22
browser close/reopen smoke test was synthetic. These are local working-tree
results, not a verified deployed release or successful account migration. No
runtime code, personal database, OAuth setting, or Spotify membership was changed
by this documentation refresh.

## What it does

- **Track mode:** replace one specific track with another.
- **Album mode:** pair two album releases by disc number + track number, then replace every source-album track found in your playlists.
- Shows the exact track mapping, Liked Songs state, and affected playlists before changing anything.
- Track labels include the requested IDs and available album/date metadata, so
  two identically titled releases can still be distinguished during review.
- Adds every needed destination track first. If **any add fails, no source track is removed anywhere**.
- Preserves duplicate source occurrences: an existing destination occurrence does
  not cancel the replacement occurrence that the source contributes.
- Removes all occurrences of each source track after the add phase succeeds.

Spotify has no multi-playlist transaction. A rare failure during the final removal phase can leave both releases in a playlist; the results identify that playlist. This intentionally fails in the safer direction.

## Cross-client disagreement and current scope

The preview screen is read-only: it never adds, removes, likes, or unlikes
anything. Therefore a destination will not appear in the listed playlists merely
because preview found them. The **Confirm migration** button is the account-write
boundary.

If phone and desktop disagree about Saved In or Liked Songs, preserve that as
conflicting evidence rather than treating it as a removal. See
[cross-client reconciliation](CROSS_CLIENT_RECONCILIATION.md).

Migration includes Liked Songs using Spotify's current `/me/library` endpoints.
It freshly checks saved membership, saves and verifies every needed replacement,
and removes old likes only after playlist migration succeeds. Playlist migration
likewise re-fetches every target before mutation and verifies replacements before
source removal. Any changed or unverifiable collection stops in the safe
direction with its old membership intact.

Existing users must reconnect once so Spotify can grant the newly required
`user-library-read` and `user-library-modify` scopes. The app invalidates its
older scope set automatically.

## Setup (one time)

### 1. Create a Spotify developer app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an app and select **Web API**.
3. Open the app settings and add this exact Redirect URI:

    ```text
    http://127.0.0.1:5173/
    ```

4. Copy the app's **Client ID**. You do not need its Client Secret.

Spotify's current development-mode rules may require the app owner to have Premium and may limit which accounts can use the app.

### 2. Start the tool

Install [Node.js](https://nodejs.org/) 14 or newer, then run from this folder:

```powershell
npm start
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), paste the Client ID, and authorize Spotify.

If Windows refuses the port with `EACCES`, it may be in an excluded TCP range
(inspect with `netsh interface ipv4 show excludedportrange protocol=tcp`). Use an
available port without changing Windows reservations, for example:

```powershell
$env:PORT = '18080'
npm start
```

Register `http://127.0.0.1:18080/` as an additional redirect URI in the same Spotify
developer app before connecting at that address. The setup screen displays the
actual redirect URI. Changing host, port, or browser profile uses different local
browser storage; it does not move an existing preview cache or cooldown record.
Do not change origin to try to bypass Spotify cooldowns.

## Using track mode

Choose **Tracks**, then paste either full Spotify links, Spotify URIs, or bare 22-character IDs.

```text
Source:      https://open.spotify.com/track/OLD_TRACK_ID
Destination: spotify:track:NEW_TRACK_ID
```

Yes: for a simple track swap, you can paste the two bare track IDs. **Source** is the old/shadow track that should disappear. **Destination** is the release you want to keep.

## Using album mode

Choose **Albums**, then paste the old and preferred album links/URIs/IDs:

```text
Source:      https://open.spotify.com/album/OLD_ALBUM_ID
Destination: https://open.spotify.com/album/PREFERRED_ALBUM_ID
```

The albums must have matching disc/track positions and the same track count. The preview lists every mapping, for example:

```text
1.1 · Old release track 1 → Preferred release track 1
1.2 · Old release track 2 → Preferred release track 2
```

If a deluxe edition has extra tracks or the sequencing differs, the tool refuses to guess and makes no changes. Use track mode for the exceptional tracks.

**Old-album navigation update (October 6, 2026):** the user reports that **View
album** on an old/shadow track now opens the old album, without an Android app
update. That restores access in the observed cases; it does not prove old/new
IDs or memberships were merged. Keeping the old release is valid; migrate only
when you want a different instance. See the [dated observation](CROSS_CLIENT_RECONCILIATION.md#october-6-2026-old-album-navigation).

## Important limitations

- Spotify only exposes playlist items for playlists you own or collaborate on.
  Any unreadable playlist leaves coverage unknown and blocks confirmation.
  Rate limits and other read failures stop the scan; they are never treated as empty.
- Album matching uses disc number + track number, not title similarity.
- Local files and podcast episodes are not supported replacement targets. This app does not inventory the desktop Local Files collection, inspect audio folders, verify phone downloads, or reconcile device Liked Songs totals. Local rows in a scanned playlist are not proof of complete local coverage.

## Counts, local files, and ordinary release duplicates

Liked Songs support checks saved membership for the selected source/destination URIs; it is not a full saved-library audit. Desktop, phone, web, Spotifast, and API counts must retain their source, capture time, filters, and coverage. No count is a universal source of truth, and the Local Files total cannot simply be added to or subtracted from Liked Songs. Count disagreement cannot authorize migration or deduplication.

A single and later album may use different Spotify IDs for the same candidate recording without any shadow release or API relink. That case is in scope for an explicitly reviewed track mapping, but automatic recording-equivalence detection is not implemented. Album-position matching does not prove identical recordings; use track mode for single/album pairs. Keep remixes, live versions, edits, remasters, and clean/explicit variants distinct unless deliberately substituting versions.

Migration preserves source occurrence counts plus pre-existing destination occurrences. It is not deduplication: two source placements and one existing destination must produce three destination placements. Liked Songs tracks saved membership per URI instead of playlist multiplicity. See [reconciliation and taxonomy](CROSS_CLIENT_RECONCILIATION.md) for the shared plan and local-file coverage gap.

For the request-pacing design, the 429 incident that led to it, and the
remaining Spotify quota limits, see [Spotify preview rate-limit incident](RATE_LIMIT_INCIDENT.md).

The incident report describes the initial fix; the behavior below supersedes its retry policy.

## Rate-limit recovery

Track previews use two sequential `GET /tracks/{id}` requests. Spotify removed
batch `GET /tracks?ids=...` for development-mode apps; see the
[February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
The former batch call was a compatibility defect, but its removal alone does not
prove the cause of a particular 429. Rate-limit messages now identify the HTTP
status, endpoint template (without IDs/query values), attempt, and whether a
usable Spotify `Retry-After` was visible. No tokens or account data are logged.

Spotify reads now pass through a restricted same-origin route on the existing
localhost server. This makes the real `Retry-After` readable even when Spotify
omits `Access-Control-Expose-Headers`. The relay accepts only allowlisted GET
endpoints, rejects foreign origins/hosts and redirects, uses bounded timeouts,
and never stores credentials or account responses on disk. PKCE/token refresh
stay in the browser; confirmed writes still go directly to Spotify. Restart
`npm start` after updating so the running server includes the relay.

The server must have network access to Spotify. A server started inside a
restricted agent sandbox may receive `EACCES` before contacting Spotify; this is
a local connection failure, not a quota response. The relay reports that failure
without exposing credentials or raw network errors. Current-user playlist
pagination can return `/users/{id}/playlists` next links; the relay maps that alias
to `/me/playlists`, retaining the page query and keeping reads scoped to the
authenticated user. The sibling catalog already accepts Spotify pagination links;
no companion change is required.

The relay serializes reads across tabs and preserves a detected cooldown in
memory. The browser persists cooldowns in local storage per Client ID. Long
cooldowns stop promptly without replaying requests. If no usable retry header
exists, the browser blocks further requests with an unknown deadline rather
than guessing when Spotify will recover. **Check Spotify availability** permits
one deliberate read of the playlist-list endpoint while the deadline is unknown.
It never retries automatically and cannot bypass a known future deadline. A fresh
unknown 429 enforces a 30-second local minimum between checks; this is not a Spotify
recovery estimate. Success unlocks preview, but migration still requires a new
complete preview. Failed checks retain the pause. Use **Record a cooldown from Spotify** to enter a
verified local retry date/time from a prior response; this cannot shorten a
known later deadline. Missing browser storage weakens persistence across reloads,
but in-memory checks still apply while the page/server remains open.

Transient HTTP 500/502/503/504 reads have at most two retries, after two and four
seconds. Network failures, redirects, authentication errors, and writes are not
replayed by the relay. Spotify's quota cannot be reset by reloading or restarting.

Preview pages now commit to this browser's **IndexedDB**, scoped to Client ID,
account, and playlist. The cache contains ordered item URIs and page/version
progress; a separate local draft remembers the selected links and mode. It stores
no credentials. Closing and reopening the tab can resume saved work at the same
browser profile and exact origin (host and port). Browser site-data deletion,
private browsing, or browser eviction can still remove it; it is not a backup.

**Resume preview** rechecks the selected releases, freshly discovers playlists and
Liked Songs membership, then checks a fresh snapshot for every playlist, including
previously negative results. Unchanged completed playlists need one version read;
partial playlists continue at their next saved page. Changed playlists are read
again. Totals, repeated pages, and snapshots are validated before completion.
Old same-tab checkpoints are promoted to IndexedDB when loaded. The progress row
shows checked, remaining, reused, resumed, changed, fetched-page, and unresolved counts.

**Stop scan** stops before another read is dispatched, after the current read and
any resulting checkpoint save. A timeout or quota pause also retains successful
pages. Storage failures visibly fall back to session storage, then memory; those
fallbacks have weaker recovery guarantees. Disconnect removes preview data for
this Client ID and clears this tab's tokens; an erase failure is reported.

Account identity must be checked before checkpoint access, including when a saved
cooldown prevented the startup profile read. Missing identity blocks preview.
The immutable `account_id` is preferred, with an `id` fallback for older responses;
checkpoints under the same verified profile's legacy ID are promoted on load.
This follows Spotify's [current profile identity guidance](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile).
Partial, unreadable, or persistently changing playlists still block confirmation.
Confirmed migration always uses fresh reads and never trusts cached preview
contents for its final safety checks. A completed personal-library database is
**not required** for this recovery feature.

### Why the library scanner appeared more resilient

The comparison with commit `18b8dcc5445305907ea7f5581c9d37584cee69d9` showed the
same playlist-list endpoint in the old app. That commit sent parallel metadata
reads, capped retry waits at ten seconds, and continued through unreadable
playlists. Reverting would not undo a server-side quota rejection and would
restore those failure modes.

The sibling catalog's Python client can read all HTTP response headers, records
cooldowns, checkpoints pages in SQLite, and revalidates snapshots on resume.
This app now adopts those principles without sharing credentials, files, or
runtime code. The browser's persistent preview cache is recovery data, not a
historical catalog or durable catalog backup. A larger total number of API reads does not establish a larger quota:
client identity, timing, endpoint limits, and retained progress matter. The
original quota trigger remains unproven; no live quota probe was used to test
these changes. The sibling code/tests were inspected; no companion edit is needed.

## Related catalog project

The [shared integration roadmap](https://github.com/mrdc1790/personal-music-library/blob/main/docs/CATALOG_MIGRATOR_ROADMAP.md) is authoritative for cross-project
ownership, ordered steps, and acceptance criteria: documentation, manual trial,
a versioned proposal file, read-only browser import, then outcome history.
The catalog owns discovery, history, and evidence; this browser is the preferred
future reviewed execution interface. No bridge is implemented. The catalog's
existing Python migration commands retain their own restrictions; retirement
requires a proven replacement workflow and recovery comparison.

The [October 2 performance/design note](UPDATED_PLAN.md) retains benchmark and
quota corrections; its implementation sequence is superseded by the shared roadmap.

[Personal Music Library](https://github.com/mrdc1790/personal-music-library) is the separate, evidence-preserving local catalog for read-only Spotify captures, historical snapshots, duplicate/overlap analysis, local-track references, and reconciliation research. This app is the narrower reviewed migration surface.

The projects share these rules: preserve duplicate occurrences; classify unreadable playlists as unknown coverage; treat phone/desktop disagreement as evidence rather than a deletion signal; and keep preview read-only. They do not share code, runtime storage, OAuth credentials, or a Git upstream. A migration journal belongs with the catalog evidence, but neither app automatically reads or writes the other repository.

## Test

```powershell
npm test
```

`npm test` includes the supplied Tape B IDs and a synthetic 581-playlist
interruption/reload case, preserving duplicate occurrences and discovering a
changed formerly negative playlist. These fixtures do not establish live account
membership, metadata equivalence, quota availability, or a successful migration.

For a real-browser IndexedDB recovery smoke test, run `npm run test:browser` and
open its printed localhost URL. It is visibly labeled synthetic, blocks external
requests and writes, and uses no Spotify credentials. Build preview to trigger an
intentional interrupted read, close and reopen the same URL, then Resume preview.
Expect one reused playlist, one resumed playlist, one fetched page, and enabled
confirmation after complete coverage. Do not use this fixture as a live migration
tool. Use `npm start` on the configured OAuth origin for the real application.

Authentication uses Authorization Code with PKCE and no Client Secret. Tokens are retained by the browser; each read transiently passes its access token through the local relay to Spotify. The relay never logs or saves tokens.

### Saved waits and request volume

A saved cooldown disables Build preview and shows its deadline and countdown.
Expiry unlocks the button without sending a request. Starting a new local server
or reloading the page does not erase the saved wait. Until a profile read succeeds,
the account row says that the account has not been checked.

The per-page counter reports upstream read attempts returned by the local relay
(including its bounded retries), and direct write attempts. A relay-blocked request
counts as zero upstream attempts. This is not an app-wide Spotify quota meter.

Commit `629a958a26e9ded45a660d21f543ac5a8a29c080` also fetched two track
records before listing playlists. Its lack of pacing and continuation after failed
playlist reads are not safe recovery strategies. The added Liked Songs and snapshot
reads happen after playlist discovery, so they cannot explain an initial rejection
of that list request. The original quota trigger has not been established.

The scanner checks a fresh version immediately before each playlist read, because
a version listed during discovery may be stale by the time a long scan reaches it.
New reads also verify the version after pagination; unchanged completed pages need
only one fresh version check. If a version changes during reading, old pages are
discarded and that playlist is reread once. If it changes again, it is listed as
unresolved and the scanner continues with other playlists. Rebuilding preview
rechecks the saved versions and retries unresolved playlists. Incomplete coverage
still blocks migration. There is no background polling or automatic migration.
Confirmed migration never uses preview checkpoints for its final safety checks.

### Development quota shared with other projects

Spotify's [July 23, 2026 announcement](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
and [quota documentation](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
state that Development Mode apps owned by one developer share quota, including
across different Client IDs. Endpoints are grouped into shared quota buckets;
Spotify does not publish their exact groupings or limits. `QUOTA_EXCEEDED`
identifies quota exhaustion, distinct from the short rolling-window rate limit.
If the music-library app belongs to the same developer, its traffic can consume
quota used by this migrator. The captured response establishes exhaustion but
does not establish which project consumed it or what today's response would be.
The sibling's cooldown code was checked; no companion runtime edit is needed.
