export const API_BASE = "https://api.spotify.com/v1";
export function parseSpotifyInput(input) {
  const value = String(input || "").trim();
  let match = value.match(/^spotify:(track|album):([A-Za-z0-9]{22})$/);
  if (match) return { type: match[1], id: match[2] };
  try {
    const url = new URL(value);
    if (url.hostname === "open.spotify.com") {
      match = url.pathname.match(/^\/(track|album)\/([A-Za-z0-9]{22})(?:\/|$)/);
      if (match) return { type: match[1], id: match[2] };
    }
  } catch {}
  if (/^[A-Za-z0-9]{22}$/.test(value)) return { type: null, id: value };
  throw new Error(
    "Enter a Spotify track or album URL, URI, or 22-character ID.",
  );
}
export function parseTrackId(input) {
  const parsed = parseSpotifyInput(input);
  if (parsed.type === "album")
    throw new Error("Expected a track, but received an album.");
  return parsed.id;
}
export const trackUri = (id) => `spotify:track:${id}`;
export const itemUri = (row) => row?.item?.uri || row?.track?.uri || null;
export async function collectPages(firstUrl, request) {
  const items = [];
  let url = firstUrl;
  while (url) {
    const page = await request(url);
    items.push(...(page.items || []));
    url = page.next;
  }
  return items;
}
export function buildAlbumReplacements(sourceTracks, destinationTracks) {
  if (sourceTracks.length !== destinationTracks.length)
    throw new Error(
      `The albums have different track counts (${sourceTracks.length} vs ${destinationTracks.length}), so they cannot be safely paired.`,
    );
  const byPosition = new Map(
    destinationTracks.map((track) => [
      `${track.disc_number}:${track.track_number}`,
      track,
    ]),
  );
  const replacements = sourceTracks.map((source) => {
    const destination = byPosition.get(
      `${source.disc_number}:${source.track_number}`,
    );
    if (!destination)
      throw new Error(
        `No destination match for disc ${source.disc_number}, track ${source.track_number}: ${source.name}.`,
      );
    return {
      sourceUri: source.uri,
      destinationUri: destination.uri,
      sourceName: source.name,
      destinationName: destination.name,
      position: `${source.disc_number}.${source.track_number}`,
    };
  });
  if (
    new Set(replacements.map((item) => item.destinationUri)).size !==
    replacements.length
  )
    throw new Error("The album mapping is ambiguous. No changes were made.");
  return replacements;
}
export function findTargets(playlists, contents, replacements) {
  const sources = new Set(replacements.map((r) => r.sourceUri));
  const destinations = new Set(replacements.map((r) => r.destinationUri));
  return playlists.flatMap((playlist) => {
    const rows = contents.get(playlist.id);
    if (!rows) return [];
    const uris = rows.map(itemUri),
      count = (values) =>
        Object.fromEntries(
          [...values].map((uri) => [
            uri,
            uris.filter((value) => value === uri).length,
          ]),
        ),
      sourceUris = [...new Set(uris.filter((uri) => sources.has(uri)))],
      occurrences = sourceUris.reduce(
        (total, uri) => total + uris.filter((value) => value === uri).length,
        0,
      );
    if (!occurrences) return [];
    return [
      {
        ...playlist,
        occurrences,
        sourceUris,
        destinationUrisPresent: [
          ...new Set(uris.filter((uri) => destinations.has(uri))),
        ],
        sourceCounts: count(sourceUris),
        destinationCounts: count([
          ...new Set(uris.filter((uri) => destinations.has(uri))),
        ]),
      },
    ];
  });
}
export function findLibraryTarget(replacements, membership) {
  const sourceUris = replacements
      .map((r) => r.sourceUri)
      .filter((uri) => membership[uri] === true),
    destinationUrisPresent = [
      ...new Set(
        replacements
          .map((r) => r.destinationUri)
          .filter((uri) => membership[uri] === true),
      ),
    ];
  return {
    affected: sourceUris.length > 0,
    occurrences: sourceUris.length,
    sourceUris,
    destinationUrisPresent,
    expectedMembership: Object.fromEntries(
      replacements.flatMap((r) => [
        [r.sourceUri, membership[r.sourceUri] === true],
        [r.destinationUri, membership[r.destinationUri] === true],
      ]),
    ),
  };
}
async function chunks(items, size, action) {
  for (let i = 0; i < items.length; i += size)
    await action(items.slice(i, i + size));
}
function counts(rows) {
  return rows.reduce((result, row) => {
    const uri = itemUri(row);
    if (uri) result[uri] = (result[uri] || 0) + 1;
    return result;
  }, {});
}
function sameCounts(expected, actual) {
  return Object.entries(expected).every(
    ([uri, count]) => (actual[uri] || 0) === count,
  );
}
export async function runSafeMigration(
  targets,
  replacements,
  api,
  inspectPlaylist,
) {
  const bySource = new Map(
    replacements.map((r) => [r.sourceUri, r.destinationUri]),
  );
  const results = targets.map((t) => ({
    id: t.id,
    name: t.name,
    added: false,
    verified: false,
    removed: false,
    addCount: 0,
    removeCount: t.occurrences || t.sourceUris.length,
    error: null,
  }));
  if (!inspectPlaylist)
    return {
      phase: "verification-unavailable",
      results: results.map((result) => ({
        ...result,
        error: "Fresh playlist verification is required before migration.",
      })),
    };
  const inspections = [];
  for (let i = 0; i < results.length; i++) {
    try {
      const inspection = await inspectPlaylist(results[i].id),
        actual = counts(inspection.rows);
      if (
        !sameCounts(
          targets[i].sourceCounts ||
            Object.fromEntries(targets[i].sourceUris.map((uri) => [uri, 1])),
          actual,
        ) ||
        !sameCounts(targets[i].destinationCounts || {}, actual)
      )
        throw new Error(
          "Playlist changed since preview; rebuild the preview before migrating.",
        );
      inspections[i] = inspection;
    } catch (error) {
      results[i].error = error.message;
    }
  }
  if (results.some((result) => result.error))
    return { phase: "preflight-failed", results };
  for (let i = 0; i < results.length; i++) {
    const result = results[i],
      target = targets[i],
      needed = target.sourceUris
        .flatMap((uri) =>
          Array(target.sourceCounts?.[uri] || 1).fill(bySource.get(uri)),
        )
        .filter(Boolean);
    try {
      await chunks(needed, 100, (uris) =>
        api(`/playlists/${result.id}/items`, {
          method: "POST",
          body: JSON.stringify({ uris }),
        }),
      );
      result.addCount = needed.length;
      result.added = true;
    } catch (error) {
      result.error = error.message;
    }
  }
  if (results.some((result) => !result.added))
    return { phase: "add-failed", results };
  for (let i = 0; i < results.length; i++) {
    const result = results[i],
      target = targets[i];
    try {
      const inspection = await inspectPlaylist(result.id),
        actual = counts(inspection.rows),
        expectedDest = { ...target.destinationCounts };
      for (const [source, count] of Object.entries(
        target.sourceCounts ||
          Object.fromEntries(target.sourceUris.map((uri) => [uri, 1])),
      )) {
        const destination = bySource.get(source);
        expectedDest[destination] = (expectedDest[destination] || 0) + count;
      }
      if (
        !sameCounts(expectedDest, actual) ||
        !sameCounts(target.sourceCounts || {}, actual)
      )
        throw new Error(
          "Fresh verification did not find every replacement; source tracks were kept.",
        );
      inspections[i] = inspection;
      result.verified = true;
    } catch (error) {
      result.error = error.message;
    }
  }
  if (results.some((result) => !result.verified))
    return { phase: "verification-failed", results };
  for (let i = 0; i < results.length; i++) {
    const result = results[i],
      target = targets[i],
      inspection = inspections[i];
    try {
      const sourceItems = target.sourceUris.map((uri) => ({ uri }));
      await chunks(sourceItems, 100, (items) =>
        api(`/playlists/${result.id}/items`, {
          method: "DELETE",
          body: JSON.stringify({ items, snapshot_id: inspection.snapshotId }),
        }),
      );
      const afterDelete = counts((await inspectPlaylist(result.id)).rows);
      if (target.sourceUris.some((uri) => afterDelete[uri]))
        throw new Error("Spotify did not verify every source removal.");
      result.removed = true;
    } catch (error) {
      result.error = error.message;
    }
  }
  return {
    phase: results.every((result) => result.removed)
      ? "complete"
      : "remove-partial",
    results,
  };
}
export async function prepareLibraryMigration(
  target,
  replacements,
  api,
  inspectLibrary,
) {
  if (!target?.affected)
    return {
      phase: "not-affected",
      sourceUris: [],
      destinationUris: [],
      addedUris: [],
    };
  const current = await inspectLibrary(Object.keys(target.expectedMembership));
  if (
    Object.entries(target.expectedMembership).some(
      ([uri, saved]) => current[uri] !== saved,
    )
  )
    return {
      phase: "preflight-failed",
      error:
        "Liked Songs changed since preview; rebuild the preview before migrating.",
    };
  const bySource = new Map(
      replacements.map((r) => [r.sourceUri, r.destinationUri]),
    ),
    destinationUris = [
      ...new Set(
        target.sourceUris.map((uri) => bySource.get(uri)).filter(Boolean),
      ),
    ],
    addedUris = destinationUris.filter((uri) => !current[uri]);
  try {
    await chunks(addedUris, 40, (uris) =>
      api("/me/library", { method: "PUT", body: JSON.stringify({ uris }) }),
    );
    const verified = await inspectLibrary([
      ...target.sourceUris,
      ...destinationUris,
    ]);
    if (
      target.sourceUris.some((uri) => !verified[uri]) ||
      destinationUris.some((uri) => !verified[uri])
    )
      throw new Error(
        "Liked Songs replacement verification failed; old likes were kept.",
      );
    return {
      phase: "prepared",
      sourceUris: target.sourceUris,
      destinationUris,
      addedUris,
    };
  } catch (error) {
    return {
      phase: "prepare-failed",
      sourceUris: target.sourceUris,
      destinationUris,
      addedUris,
      error: error.message,
    };
  }
}
export async function finishLibraryMigration(prepared, api, inspectLibrary) {
  if (prepared.phase === "not-affected") return { phase: "not-affected" };
  if (prepared.phase !== "prepared") return prepared;
  try {
    await chunks(prepared.sourceUris, 40, (uris) =>
      api("/me/library", { method: "DELETE", body: JSON.stringify({ uris }) }),
    );
    const verified = await inspectLibrary([
      ...prepared.sourceUris,
      ...prepared.destinationUris,
    ]);
    if (
      prepared.sourceUris.some((uri) => verified[uri]) ||
      prepared.destinationUris.some((uri) => !verified[uri])
    )
      throw new Error("Spotify did not verify the final Liked Songs state.");
    return { phase: "complete" };
  } catch (error) {
    return { phase: "remove-failed", error: error.message };
  }
}
export async function runSafeSwap(targets, sourceUri, destinationUri, api) {
  return runSafeMigration(
    targets.map((t) => ({
      ...t,
      sourceUris: t.sourceUris || [sourceUri],
      destinationUrisPresent:
        t.destinationUrisPresent ||
        (t.destinationPresent ? [destinationUri] : []),
    })),
    [{ sourceUri, destinationUri }],
    api,
  );
}
