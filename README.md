# Spotify Playlist Migrator

Safely replace a Spotify track—or an entire shadow re-release of an album—across every playlist you own or collaborate on.

## What it does

- **Track mode:** replace one specific track with another.
- **Album mode:** pair two album releases by disc number + track number, then replace every source-album track found in your playlists.
- Shows the exact track mapping, Liked Songs state, and affected playlists before changing anything.
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

## Important limitations

- Spotify only exposes playlist items for playlists you own or collaborate on.
  A `403` is reported as “not owned/collaborative”; timeouts, rate limits, and
  other failures are counted separately. “Unreadable” is not treated as empty.
- Album matching uses disc number + track number, not title similarity.
- Local files and podcast episodes are ignored.

## Related catalog project

[Personal Music Library](https://github.com/mrdc1790/personal-music-library) is the separate, evidence-preserving local catalog for read-only Spotify captures, historical snapshots, duplicate/overlap analysis, local-track references, and reconciliation research. This app is the narrower reviewed migration surface.

The projects share these rules: preserve duplicate occurrences; classify unreadable playlists as unknown coverage; treat phone/desktop disagreement as evidence rather than a deletion signal; and keep preview read-only. They do not share code, runtime storage, OAuth credentials, or a Git upstream. A migration journal belongs with the catalog evidence, but neither app automatically reads or writes the other repository.

## Test

```powershell
npm test
```

Authentication uses Spotify's recommended Authorization Code with PKCE flow. Tokens remain in your browser's local storage; there is no backend and no Client Secret.
