# Spotify Preview Rate-Limit Incident

> Historical report: the batch-track remediation described below was incorrect
> for development-mode apps. Spotify's February 2026 migration guide removes
> `GET /tracks`; the current implementation uses two paced `GET /tracks/{id}`
> requests. Missing/invalid/zero retry headers now stop immediately with a
> labeled local backoff instead of automatically retrying. See README.md for
> current behavior. The compatibility defect is confirmed; the cause of the
> user's live 429 has not been established from a captured response.

## Summary

While using **Build preview** for a single track replacement, Spotify returned
`429 Too Many Requests`. The initial app message said Spotify was rate limiting
the request and would retry in one second; after retrying, the UI surfaced
`Too many requests`.

The preview remains read-only throughout this incident. It does not add,
remove, save, or unsave tracks.

## What Spotify says

Spotify applies Web API limits to an app over a rolling 30-second window. The
limit varies by quota mode. A `429` response normally includes `Retry-After` in
seconds, and Spotify recommends waiting that full time before making another
request. A development-mode app can also be constrained by its lower quota.

Spotify recommends reducing request volume with batch endpoints, using
`snapshot_id` to avoid unnecessary playlist downloads, studying request
patterns, and lazy-loading nonessential work.

Resources:

- [Spotify Web API rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
- [Spotify Web API calls and response codes](https://developer.spotify.com/documentation/web-api/concepts/api-calls)
- [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)

## Why one preview can still involve many API calls

“One request” in the UI means one preview job, not one HTTP request. A complete,
safe preview has to establish the exact source and destination, inspect Liked
Songs, enumerate editable playlists, and read every playlist’s items before it
can truthfully say where the source occurs.

For a track replacement, the request flow is now:

1. Fetch both track records with one `GET /tracks?ids=...` batch request.
2. Enumerate the user’s playlists, paging at 50 playlists per request.
3. Check Liked Songs membership for the source and destination tracks.
4. Read every editable playlist, paging its items at 50 per request.

An album preview also retrieves both releases and their track lists. Large
accounts therefore need many read requests even though the user pressed the
button once. This scan is necessary for the tool’s promise to search every
editable playlist; unreadable or rate-limited playlists are never treated as
empty.

## Original client problems

The original client made the issue worse in three ways:

1. It started some independent reads concurrently with `Promise.all`.
2. It truncated Spotify’s `Retry-After` instruction to ten seconds, then
   retried early.
3. It allowed another **Build preview** click while a scan was already running,
   which could start a second full scan.

Early retry does not clear a rolling-window quota and can produce another 429.
It also obscured Spotify’s actual cooldown by ultimately displaying only the
generic API error.

## Remediation implemented

`app.js` now sends all Spotify Web API calls through one FIFO promise queue.
The queue permits one in-flight request and enforces a 350 ms minimum interval
before dispatching the next request. This makes concurrent callers wait rather
than burst requests at Spotify.

On a `429`, the active queue waits for the complete `Retry-After` value before
retrying. The cooldown applies to the requests behind it as well. The client
retries a request up to five times and displays the stated wait while it is
paused.

Track mode now uses Spotify’s multiple-tracks endpoint to load source and
destination metadata in one request. The scan control is disabled until the
preview completes or fails, preventing overlapping scans.

The conversion of `Retry-After` to milliseconds lives in `spotify.js` and has a
focused test that confirms a long cooldown is not truncated. The default for a
missing, malformed, or zero header is one second; Spotify has historically
returned zero in some 429 responses, so a short nonzero fallback avoids an
immediate retry loop.

## What this cannot solve

Client-side pacing prevents this page from creating avoidable bursts. It cannot
override a quota already consumed by other activity using the same Spotify
Client ID, nor can it increase a development-mode app’s quota. If a freshly
reloaded page continues to get a 429 after the queued cooldown, inspect the
Client ID’s request activity and quota mode in the Spotify Developer Dashboard,
then wait for the reported cooldown before retrying.

The app intentionally does not bypass limits, hide read failures as empty
playlists, or proceed to migration with partial/unverifiable coverage.

## Comparison: Spotify Dedup

[Spotify Dedup](https://github.com/JMPerez/spotify-dedup) documents a promise
queue/throttle as the way it traverses a library without incurring rate limits.
That is the model adopted here: regulate dispatch before requests are sent,
then honor server-directed cooldowns. Its deployed app may nevertheless have a
different Spotify quota mode or Client ID, so it is not evidence that this
client’s quota is unlimited.

The “older relinker” repository was not identified by URL during this incident,
so no claim is made about its exact implementation. Provide its GitHub URL to
compare its queue interval, batching, retry behavior, and quota assumptions
directly.

## Verification performed

- `npm test` passes, including the long-`Retry-After` regression test.
- `node --check app.js` passes.
- The existing local server responded successfully at `http://127.0.0.1:5173/`.

No live Spotify preview was executed as part of verification, because that
would require an authenticated user session and consume API quota. No companion
change was needed in `personal-music-library`: its scanner already preserves
rate-limited work as incomplete evidence rather than treating it as empty.
