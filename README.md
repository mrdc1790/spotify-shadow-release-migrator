# Spotify Playlist Migrator

Safely replace a Spotify track—or an entire shadow re-release of an album—across every playlist you own or collaborate on.

## What it does

- **Track mode:** replace one specific track with another.
- **Album mode:** pair two album releases by disc number + track number, then replace every source-album track found in your playlists.
- Shows the exact track mapping and affected playlists before changing anything.
- Adds every needed destination track first. If **any add fails, no source track is removed anywhere**.
- Avoids adding a replacement that is already present in that playlist.
- Removes all occurrences of each source track after the add phase succeeds.

Spotify has no multi-playlist transaction. A rare failure during the final removal phase can leave both releases in a playlist; the results identify that playlist. This intentionally fails in the safer direction.

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

- Spotify exposes playlist contents only for playlists you own or collaborate on. Followed playlists you cannot edit are skipped.
- This changes playlists, not Liked Songs / Your Library.
- Album matching uses disc number + track number, not title similarity.
- Local files and podcast episodes are ignored.

## Test

```powershell
npm test
```

Authentication uses Spotify's recommended Authorization Code with PKCE flow. Tokens remain in your browser's local storage; there is no backend and no Client Secret.
