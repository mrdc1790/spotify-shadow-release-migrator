## Project Context: Spotify Shadow Releases, Relinking, Playlist Migration, and Local Music Database

I am a heavy Spotify power user with a very large library, thousands of local songs, hundreds of playlists, and roughly 45,000+ Liked Songs. I am building toward a larger personal Spotify/music-library database and potentially a Spotify wrapper/media-hub application. This particular subproject concerns one of Spotify's most frustrating data-model quirks: **silent re-releases / shadow releases / alternate Spotify track IDs for what is effectively the same recording.**

This problem should eventually integrate with my broader local music database rather than become an isolated throwaway script.

### The core Spotify problem

Spotify frequently has multiple database objects representing what appears to the user to be the same recording.

An artist/label can re-upload or re-release an album, single, deluxe edition, compilation, etc. Sometimes there may be meaningful differences, but sometimes the change appears to be extremely minor—metadata, label/distributor information, copyright information, release packaging, album association, availability, or some other backend difference.

The result can be:

**Old Spotify track ID**
→ remains in my Liked Songs and existing playlists

while

**New Spotify track ID**
→ is the version Spotify currently exposes from the artist/album page.

This creates extremely confusing UI behavior.

For example, I can:

1. Go to an artist.
2. View my Liked Songs by that artist.
3. See a song as liked and know it exists in several playlists.
4. Click the song's album hyperlink.
5. Spotify takes me to what appears to be the same album/song.
6. On that album page, the song suddenly appears **unliked and in none of my playlists**.

The explanation is often that Spotify has taken me to a different Spotify track object/ID representing effectively the same recording.

Therefore:

> **Spotify track ID must not automatically be treated as equivalent to canonical recording identity.**

A Spotify track ID is better thought of as a particular Spotify representation/release occurrence of a recording.

This distinction should influence the architecture of the larger music database.

---

## Concrete example: K.A.A.N. — "2 Busy"

One known example is:

Old/saved Spotify track ID:

`623tFk37Yd1PBpo926WiLu`

This is the version represented throughout my existing Spotify library/playlists.

New/currently surfaced version:

`6Q0c6AP55HK2tGqYFSPTxq`

Current album:

`2i2SHHNBXjCUMGsIeXOUyu`

When navigating Spotify through my old saved copy, Spotify can lead me into the newer release context even though my library relationships belong to the old track ID.

This is exactly the kind of pair I want the system to detect and migrate.

Another example I've observed is Pretty Lights' 2013 album/bonus-tracks edition, where old library objects and the currently surfaced album version do not line up cleanly.

Do not assume these examples prove that every apparent duplicate is literally identical audio. The eventual tool should inspect available metadata and identifiers before declaring two objects equivalent.

---

# Desired operation: "Lift and Shift"

I want a command/tool/UI operation conceptually like:

`migrate OLD_TRACK_ID -> NEW_TRACK_ID`

But this must mean much more than simply replacing one URI in one playlist.

The program should determine **every place in my Spotify library where the old track occurs**.

Example:

`old_track_id`

might occur in:

- Liked Songs
- Playlist A at position 183
- Playlist B at position 44
- Playlist C at position 991
- Playlist C again at position 1,430
- Playlist D
- etc.

The migration should reproduce those relationships for the replacement track.

Conceptually:

`OLD_TRACK -> all library relationships`

becomes:

`NEW_TRACK -> same library relationships`

After successful verification, the old version can be removed.

For playlists, I want to preserve as much as Spotify allows:

- playlist membership
- playlist ordering/position
- duplicate occurrences
- occurrence count
- which playlists contained the song

For Liked Songs:

- save/like the new track
- verify that it was successfully saved
- only then remove/unlike the old track

The migration should be **add-first, verify, remove-second** rather than destructive replacement.

---

# Important Spotify limitation

"Exactly identical migration" is impossible because adding the replacement creates a genuinely new playlist/library entry.

We should be able to preserve:

- playlist membership
- relative playlist position
- duplicate occurrences
- number of occurrences
- Liked Songs membership

But generally cannot preserve metadata such as:

- original `added_at`
- original `added_by`
- original Liked Songs save timestamp/order

Therefore the local database should preserve those historical values even when Spotify itself cannot.

The database becomes the historical source of truth.

---

# Local database architecture

I want a local SQLite database to become the canonical snapshot/index of my Spotify library.

At minimum, store enough information to reconstruct and analyze library relationships.

For each playlist occurrence, useful fields include:

- playlist ID
- playlist name
- playlist owner
- playlist snapshot ID
- zero-based track position
- stored Spotify track ID
- currently returned/relinked Spotify track ID if different
- `linked_from` information when Spotify provides it
- Spotify URI
- track title
- artist names
- artist IDs
- album name
- album ID
- ISRC
- duration
- explicit status
- disc number
- track number
- availability/playability information
- `added_at`
- `added_by`
- whether this is a local track
- potentially audio/file metadata for my local-song collection later

Liked Songs should also be snapshotted.

A particularly useful derived structure is a **reverse index**:

`spotify_track_id -> every occurrence throughout my library`

That lets the program instantly answer:

> "Where does this particular Spotify object exist?"

instead of repeatedly scanning hundreds of playlists.

---

# Canonical recording identity

Longer term, the schema should probably distinguish:

### Spotify track object

A specific Spotify track ID.

from

### Recording/work identity

Our best representation of "this is effectively the same recording."

Potential conceptual model:

`canonical_recording`
→ has many `spotify_track_versions`

For example:

`canonical_recording_123`

could contain:

- Spotify track A from original album
- Spotify track B from re-uploaded album
- Spotify track C from compilation
- Spotify track D from deluxe edition

But **do not collapse tracks merely because their titles match**.

Some apparently identical tracks can legitimately differ:

- explicit vs clean
- remaster vs original
- radio edit
- extended mix
- live version
- remix
- rerecording
- different featured artists
- different mastering
- substantially different duration
- alternate mix
- region-specific version

Therefore canonicalization needs evidence and confidence.

---

# Replacement/matching confidence model

Potential evidence hierarchy:

### Very high confidence

Spotify explicitly exposes a relinking relationship such as:

`linked_from.old_id -> returned/current_id`

This is strong evidence that Spotify itself considers one track a substitute for the other in the relevant market/context.

### High confidence

Matching combination such as:

- same ISRC
- same artist identity
- essentially identical duration
- same explicit/clean status

Potentially safe to propose automatically.

### Medium confidence

Something like:

- same normalized title
- same artist(s)
- duration within approximately 1–2 seconds
- plausible corresponding album/release

Require human approval.

### Low confidence

Title-only search or first Spotify search result.

Never automatically migrate.

### Conflict

Differences such as:

- materially different duration
- explicit vs clean mismatch
- different primary artist
- remix/edit/live/remaster indicators
- suspicious ISRC mismatch

Require manual investigation.

The system should show **why** it thinks two tracks match rather than merely outputting a similarity score.

---

# Greyed-out / unavailable songs

This system should also solve a related problem:

A track can become unavailable and appear greyed out while still existing in my playlists.

I want to ask:

> "Find every playlist containing this dead Spotify object and determine whether another playable Spotify version of the same recording exists."

This is one reason periodic local snapshots are valuable.

Spotify may eventually return degraded/incomplete metadata for an unavailable object. A historical snapshot may still contain:

- original title
- artists
- album
- ISRC
- duration
- Spotify ID
- playlist memberships
- position
- added date

That information can later be used to locate a replacement.

Therefore the database isn't just a convenience—it protects against Spotify metadata disappearing or changing over time.

---

# Desired command/workflow architecture

Think in terms of separate safe stages rather than one destructive script.

### `scan`

Fetch Spotify state and update the local database.

Discover:

- playlists
- playlist occurrences
- Liked Songs
- unavailable tracks
- relinked tracks
- potential shadow releases
- duplicate/alternate track objects

### `detect`

Find suspicious relationships such as:

`OLD_ID -> probable NEW_ID`

using Spotify relinking, ISRCs, metadata, duration, artist identity, album relationships, etc.

### `plan`

Generate a migration plan without touching Spotify.

Example:

`623t... -> 6Q0c...`

Evidence:

- same title
- same artists
- same duration
- same ISRC / relinking evidence where available

Affected locations:

- Liked Songs
- Playlist A, position X
- Playlist B, position Y
- Playlist C, positions Z1 and Z2

### `approve`

I explicitly approve mappings individually or potentially album-by-album/batch.

### `apply`

For each approved mapping:

1. Record current playlist snapshot/state.
2. Insert replacement at intended location.
3. Verify replacement exists.
4. Remove old occurrence.
5. Handle duplicates correctly.
6. Repeat safely for all affected playlists.
7. Save new track to Liked Songs.
8. Verify save.
9. Remove old Liked Songs entry.

Ordering/position logic needs particular care because inserting/removing playlist entries shifts subsequent indexes.

### `verify`

Re-fetch Spotify after modification.

Compare actual playlist sequences against the expected result.

The operation should not be considered successful merely because Spotify returned HTTP 200.

### `rollback`

Keep enough pre-migration state to reverse changes where Spotify's API allows it.

At minimum, retain a detailed audit trail.

---

# Safety requirements

This library is valuable to me. A bug that corrupts hundreds of playlists would be much worse than having to manually approve replacements.

Therefore:

**Never start by running destructive operations against the entire library.**

Development progression should be something like:

1. read-only export
2. detection/report only
3. dry-run migration plan
4. migration against a disposable test playlist
5. one real song
6. one real album
7. larger batches

Before mutations, preserve snapshots/exports.

Mutations should ideally be:

**idempotent or at least safely resumable.**

If execution crashes halfway through, rerunning it should not blindly duplicate every replacement.

Every migration should have an audit record such as:

- migration ID
- timestamp
- old ID
- new ID
- evidence/confidence
- affected playlist
- original position
- action attempted
- result
- verification result
- pre/post playlist snapshot IDs

---

# Existing projects/services investigated

### spotify-dedup

Website:

`spotify-dedup.com`

GitHub:

`JMPerez/spotify-dedup`

It solves a related but narrower duplicate problem.

My understanding from prior investigation is that it primarily handles repeated Spotify objects/URIs and therefore does **not inherently solve**:

`OLD_TRACK_ID != NEW_TRACK_ID`

when the two IDs represent effectively the same recording.

Still worth studying for:

- authentication patterns
- playlist scanning
- duplicate UX
- safe user-facing workflows

but don't assume its duplicate definition matches this problem.

### AfterForever667/spotify_songs_relink

This project was identified as much closer to my actual problem because it works with relinking/unavailable tracks.

However, prior review found concerns/limitations including:

- processing one source at a time rather than building a library-wide reverse index
- replacement playlist items being appended rather than preserving original position
- poor behavior around multiple occurrences of the old track
- potentially adding one replacement while removing multiple old occurrences
- weak unavailable-song matching
- reliance on title/search behavior that could pick the wrong recording
- API compatibility concerns because Spotify's API/Development Mode behavior has changed

Do not blindly run this against my account.

It may still contain useful logic worth adapting.

### Other related utilities previously encountered

Projects such as:

- SpotifyPlaylistFixer
- spotify-user-utils
- UnavailableSpotifyTracks

may contain useful ideas for local-track replacement, duplicate detection, or unavailable-track detection, but none has yet been established as a complete library-wide "replace this recording everywhere while preserving playlist topology" solution.

Services like Soundiiz/TuneMyMusic are useful for migration/export scenarios, but we have not established that they solve this exact same-account ID-replacement problem.

When revisiting any of these claims, check the current repositories/documentation rather than assuming the previous assessment remains current.

---

# Spotify API concept: track relinking

Spotify has/had an official concept generally called **track relinking**.

In certain availability/market situations, requesting one track may result in Spotify exposing another playable object while retaining information about the originally requested track, historically through fields such as `linked_from`.

This mechanism is highly relevant because it can provide stronger evidence than fuzzy matching.

However:

**Do not assume Spotify relinking exposes every "shadow release" I care about.**

There may be several phenomena mixed together:

1. official Spotify market relinking
2. distributor reuploads
3. album rereleases
4. duplicate catalog objects
5. replaced releases
6. unavailable tracks
7. metadata changes
8. manually reissued albums

The system should empirically determine which mechanisms Spotify exposes through its current API.

Spotify's Web API changed substantially around 2024–2026, especially Development Mode, so verify current endpoint behavior and authorization limitations before designing around older tutorials/repos.

---

# Larger Spotify project

This tool is ultimately one component of a much broader personal music-data project.

I want a local database reflecting:

- my Liked Songs
- playlists
- playlist structure
- track identities
- release/version relationships
- local music files
- historical Spotify state

This should eventually enable queries/features Spotify itself handles poorly.

Examples:

- Which playlists contain this song?
- Show the union of playlists A/B/C.
- Show their intersection.
- Find songs that appear in playlist A but not B.
- Find duplicate recordings represented by different Spotify IDs.
- Find shadow releases.
- Find unavailable songs with probable replacements.
- Migrate an old release to its current release.
- Track when Spotify IDs/releases disappear.
- Maintain historical playlist snapshots.
- Reconcile local files with Spotify catalog tracks.
- Potentially map the library to other music services.
- Support a future Spotify wrapper/media-hub application.
- Work around Spotify power-user limitations such as the 10,000-track playlist ceiling where possible.

I have hundreds of playlists, so algorithms and UX should assume a **large personal library**, not a user with 12 playlists.

---

# Related Spotify scale/performance problem

Spotify's desktop application is extremely slow for me.

Important environmental context:

- my library is unusually large
- approximately 45,000+ Liked Songs
- hundreds of playlists
- roughly 7,000–8,000 local songs
- Spotify's web application can behave substantially better
- behavior can differ between my computers
- raw hardware performance therefore probably isn't the entire explanation

One hypothesis is Spotify's desktop local database/cache/index and/or Local Files indexing.

A useful non-destructive diagnostic is:

- create a clean Spotify environment/profile
- disable Local Files
- compare performance
- avoid destroying the existing working local-song setup during testing

If the clean environment is dramatically faster, progressively add variables back to isolate whether the bottleneck is:

- cache/database
- Local Files
- playlist/library scale
- extensions/configuration
- installation state
- account-side behavior

Do not casually recommend wiping Spotify's local state because rebuilding thousands of local-file associations can be extremely time-consuming.

---

# Architectural principle

The most important conceptual rule for this entire project is:

> **Do not use Spotify Track ID as the sole identity of a song/recording.**

Instead think roughly:

`Recording`
→ `Release`
→ `Spotify track representation`
→ `Library occurrence`

Those layers are different.

A recording can occur on several releases.

A release can be reissued.

Spotify can have multiple track IDs for effectively the same recording.

My playlist can contain a particular Spotify representation at a particular position.

The database should preserve those distinctions instead of flattening everything into "song = Spotify ID."

---

# Immediate objective

The immediate goal is NOT to build the entire Spotify replacement application.

Start by producing a safe, inspectable solution to:

> Given an old Spotify track ID and a proposed replacement ID, find every occurrence of the old ID across my playlists and Liked Songs, show me exactly what would change, and then—with explicit approval—migrate those occurrences to the new ID while preserving playlist structure as closely as Spotify permits.

Once that works reliably, expand detection so the program can discover candidate old/new pairs itself.

After that, incorporate unavailable-track recovery, shadow-release auditing, canonical recording identities, historical snapshots, and the broader library database.

Treat **read-only indexing and trustworthy data modeling as the foundation**. The migration feature should be built on top of that foundation rather than writing a one-off Spotify mutation script.
