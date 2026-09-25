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

## Evidence model for the broader library project

Retain the stored playlist occurrence URI and position, requested/effective URI
when known, time, client platform/version, market, UI surface, result
(`present`, `absent`, `unknown`), and raw evidence. A client-side absence is
conflicting evidence, never a deletion signal. Only a fresh authoritative
library/playlist read can establish a removal.

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
