# Cross-client catalog and membership disagreement

## Incident

For `spotify:track:04z06240Vjb63T2eow1TX8`, desktop reported the expected
playlist memberships while phone reported neither playlist nor Liked Songs
membership after playback from a known playlist. The earlier long **Build
preview** run was read-only discovery, not a migration: it did not add, remove,
like, or unlike any item.

This must not be interpreted as a removal or as proof that either client is
authoritative. A client can display stale/incomplete membership metadata or a
different effective catalog instance. Playback proves playability only.

The broader evidence model and dated count/recovery observations live in the
[Personal Music Library](https://github.com/mrdc1790/personal-music-library)
repository. This app retains the same rule locally because it is the explicit
account-write surface: UI disagreement alone can never authorize a migration.

## Evidence model for the broader library project

Retain the stored playlist occurrence URI and position, requested/effective URI
when known, time, client platform/version, market, UI surface, result
(`present`, `absent`, `unknown`), and raw evidence. A client-side absence is
conflicting evidence, never a deletion signal. Fresh API reads establish only
the membership exposed by those endpoints at that time; they cannot establish
device-wide local-file absence or a removal from a count difference alone.

## Current app behavior

The review screen is non-mutating; the Confirm button is the account-write
boundary. Preview discovery therefore cannot explain a missing replacement: it
has not attempted to add one yet.

The app now includes Liked Songs. It checks the selected old/new URIs using the
library membership endpoint, displays whether the source is liked, saves and
verifies the replacement before playlist removal begins, and keeps the old like
unless all playlist work completes. It then removes and verifies the old like.

For playlists, the app distinguishes a `403` (the listed playlist is not owned
by or collaborative with the user) from other read failures. It re-fetches each
affected playlist, verifies replacement counts, and only then removes sources.
Any unverifiable state stops safely.

## Recurring count and local-file discrepancies

The user's API/script and Spotifast observations agree while desktop, web, and phone Liked Songs totals disagree with them and with one another. Earlier work/home/old-phone/replacement-phone observations show the same recurring requirement. Preserve old observations as history, not current expected totals. Exact personal counts belong in private evidence, not public repository documentation.

The user's report that desktop likes include local songs and belief that the phone holds the complete local collection remain observations requiring item-level verification. The home computer is the preferred reference for intended state, not an infallible measurement. Cache/sync, timing, filters, unavailable catalog objects, identity differences, and incomplete API coverage are hypotheses rather than established explanations.

The local collection is explicitly in scope for the broader project. Spotify-returned playlist local references are only one part of it: include files never placed in a playlist, repeated references, copied/retagged/transcoded files, local/cloud candidates, and per-device discovery/presence/playback. Neither repository currently supplies the complete filesystem/phone reconciliation workflow. Local Files is not automatically a normal Web API playlist. This migrator does not transfer, delete, tag, or replace local audio.

## Shared duplicate and identity taxonomy

| Category | Meaning and intended handling |
|---|---|
| URL alias | Different share parameters for the same track ID; normalize the ID, not a distinct track |
| Exact occurrence duplicate | Repeated same URI within one playlist; preserve count/order during migration |
| Cross-source overlap | Same identity in several playlists or Liked Songs; usually intentional |
| Ordinary release duplicate | Different single/album/deluxe/compilation IDs for a candidate same recording; not necessarily shadowing |
| Shadow/re-upload | Older/newer catalog instances; retain provenance and reviewed mappings |
| Market relink | Requested/stored and effective returned objects differ; preserve both where exposed |
| Different version | Remix, live, acoustic, edit, remaster, rerecording, or clean/explicit variant; keep distinct by default |
| Local/cloud candidate | Owned file/local reference versus Spotify instance; separate entities and uncertain matching |
| Local duplicates | Repeated local URI versus duplicate file bytes versus similar audio; different tests and counts |
| Unavailable/missing | Null item, hidden identity, or unreadable source; retain unknown coverage |
| Client disagreement | Count, membership, download, or playback disagreement; reconciliation, not a duplicate class to remove |

The taxonomy applies to playlists and Liked Songs. Same title/artist/duration/ISRC is candidate evidence, not automatic equivalence or permission. Ordinary single/album pairs do not need `linked_from` to be candidates. Current selected-URI matching does not implement automatic taxonomy classification or recording-level grouping.

## Planned reconciliation and review requirements

1. Retain account, endpoint/client, market, app/version, capture time, filters, API capability, and pagination/coverage for every observation. Agreement between API-based tools is not automatically independent evidence.
2. Separate endpoint totals, fetched/exported/imported rows, distinct IDs, playlist occurrences, local occurrences/URIs, missing objects, physical files, and reviewed recording groups. Do not subtract Local Files from Liked Songs without proving the overlap.
3. Produce A-only/B-only/shared/unknown item comparisons. Equal counts can hide different membership. Count-only clients stay unresolved rather than yielding invented missing-item lists.
4. Inventory selected local roots read-only; retain path, size, metadata, duration, errors, optional hashes, and later optional fingerprints. Track each device separately and report incomplete roots and unknown phone coverage.
5. Keep preferred-instance migration, duplicate-occurrence removal, recording grouping, and filesystem cleanup separate review actions. Existing destination occurrences do not cancel source occurrences.
6. Before implementation, add synthetic cases for single/album pairs without relink evidence in playlists and likes, genuine-version false matches, local-only files, repeated local URIs, missing pages, and equal totals with different members. Do not use real user snapshots in tests.

Both repositories were checked for this documentation update. The catalog owns historical capture and the planned file/recording model; this browser app owns explicitly confirmed selected-ID migration. There is no new shared runtime dependency or account-write behavior.

## Reference projects checked

The [Spotify Dedup site](https://spotify-dedup.com/) describes ID and metadata-similarity matching for playlists and likes. Its [inspected matcher](https://github.com/JMPerez/spotify-dedup/blob/master/dedup/deduplicator.ts) also matches different IDs by title, first artist, and duration proximity, while skipping null IDs. It can therefore flag ordinary single/album candidates, but is not a complete local inventory or a preferred-ID migration preserving every occurrence.

The [specific relinker source](https://github.com/AfterForever667/spotify_songs_relink/blob/main/spotify_songs_relink.py) processes likes or one owned playlist, skips missing IDs, collapses repeated IDs per page, and handles relink/unavailable candidates. Playable single/album pairs without a relink need not be found. Its append-then-remove-all playlist behavior and absence of add readback do not meet this project's migration guarantees. Neither tool establishes why client totals differ. These are source-review findings, not live compatibility results; deployed Dedup behavior can differ from the inspected branch.
