import {
  API_BASE,
  buildAuthorizationUrl,
  buildAlbumReplacements,
  collectPages,
  findLibraryTarget,
  findTargets,
  finishLibraryMigration,
  parseSpotifyInput,
  prepareLibraryMigration,
  runSafeMigration,
  trackUri,
} from './spotify.js';
const scopes =
    'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-library-modify';

const scopeVersion = 'library-v1';

const redirectUri = `${location.origin}/`;

const state = {
    token: null,
    targets: [],
    libraryTarget: null,
    replacements: [],
    skipped: [],
};

const $ = (s) => document.querySelector(s);
const status = $('#status');
const authStatus = $('#authStatus');

function message(text, kind = '') {
    status.textContent = text;
    status.className = `status ${kind}`;
}

function randomString(n = 64) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function b64(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

async function login() {
    const clientId = $('#clientId').value.trim();

    if (!clientId) {
        authStatus.textContent = 'Enter the Client ID from your Spotify app.';
        authStatus.className = 'status error';
        return;
    }

    try {
        authStatus.textContent = 'Opening Spotify authorization…';
        authStatus.className = 'status';
        localStorage.setItem('spotify_client_id', clientId);

        const verifier = randomString();
        const oauthState = randomString(24);
        const challenge = b64(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
        );

        sessionStorage.setItem('pkce_verifier', verifier);
        sessionStorage.setItem('oauth_state', oauthState);

        const url = buildAuthorizationUrl({
            clientId,
            redirectUri,
            scopes,
            challenge,
            state: oauthState,
        });
        location.assign(url);
    } catch (error) {
        authStatus.textContent = `Could not start Spotify login: ${error.message}`;
        authStatus.className = 'status error';
    }
}

async function tokenRequest(body) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!response.ok) throw new Error('Spotify login failed. Check the Client ID and redirect URI.');
  const token = await response.json();
  sessionStorage.setItem('access_token', token.access_token);
  sessionStorage.setItem('expires_at', String(Date.now() + token.expires_in * 1000));
  if (token.refresh_token) localStorage.setItem('refresh_token', token.refresh_token);
  return token.access_token;
}
async function finish(code, returned) {
  const verifier = sessionStorage.getItem('pkce_verifier'),
    expected = sessionStorage.getItem('oauth_state'),
    client_id = localStorage.getItem('spotify_client_id');
  if (!verifier || returned !== expected) throw new Error('Invalid login state. Connect again.');
  const token = await tokenRequest({
    client_id,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  localStorage.setItem('spotify_scope_version', scopeVersion);
  history.replaceState({}, '', '/');
  return token;
}
async function refresh() {
  const refresh_token = localStorage.getItem('refresh_token'),
    client_id = localStorage.getItem('spotify_client_id');
  if (!refresh_token || !client_id) return null;
  try {
    return await tokenRequest({
      client_id,
      grant_type: 'refresh_token',
      refresh_token,
    });
  } catch {
    return null;
  }
}
async function api(path, options = {}) {
  if (!state.token || Date.now() >= Number(sessionStorage.getItem('expires_at') || 0) - 30000)
    state.token = await refresh();
  if (!state.token) throw new Error('Spotify session expired. Reconnect.');
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  let response;
  for (let i = 0; i < 3; i++) {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (response.status !== 429) break;
    await new Promise((r) =>
      setTimeout(r, Math.min(Number(response.headers.get('Retry-After') || 1), 10) * 1000),
    );
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json()).error?.message || '';
    } catch {}
    const error = new Error(detail || `Spotify request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
async function resolveInputs() {
  const chosen = document.querySelector('input[name=kind]:checked').value,
    source = parseSpotifyInput($('#source').value),
    destination = parseSpotifyInput($('#destination').value);
  const sourceType = source.type || chosen,
    destinationType = destination.type || chosen;
  if (sourceType !== destinationType)
    throw new Error('Use two tracks or two albums—not one of each.');
  if (source.id === destination.id) throw new Error('Source and destination must differ.');
  if (sourceType === 'track') {
    const [a, b] = await Promise.all([
      api(`/tracks/${source.id}`),
      api(`/tracks/${destination.id}`),
    ]);
    return {
      sourceLabel: `${a.name} — ${a.artists.map((x) => x.name).join(', ')}`,
      destinationLabel: `${b.name} — ${b.artists.map((x) => x.name).join(', ')}`,
      replacements: [
        {
          sourceUri: trackUri(source.id),
          destinationUri: trackUri(destination.id),
          sourceName: a.name,
          destinationName: b.name,
        },
      ],
    };
  }
  const [a, b, aTracks, bTracks] = await Promise.all([
    api(`/albums/${source.id}`),
    api(`/albums/${destination.id}`),
    collectPages(`${API_BASE}/albums/${source.id}/tracks?limit=50`, api),
    collectPages(`${API_BASE}/albums/${destination.id}/tracks?limit=50`, api),
  ]);
  return {
    sourceLabel: `${a.name} — ${a.artists.map((x) => x.name).join(', ')}`,
    destinationLabel: `${b.name} — ${b.artists.map((x) => x.name).join(', ')}`,
    replacements: buildAlbumReplacements(aTracks, bTracks),
  };
}
async function inspectLibrary(uris) {
  const result = {};
  for (let i = 0; i < uris.length; i += 40) {
    const batch = uris.slice(i, i + 40),
      saved = await api(`/me/library/contains?uris=${encodeURIComponent(batch.join(','))}`);
    batch.forEach((uri, index) => (result[uri] = Boolean(saved[index])));
  }
  return result;
}
async function scan() {
  try {
    $('#execute').disabled = true;
    $('#preview').hidden = true;
    message('Validating releases and Liked Songs…');
    const resolved = await resolveInputs();
    state.replacements = resolved.replacements;
    $('#sourceName').textContent = resolved.sourceLabel;
    $('#destinationName').textContent = resolved.destinationLabel;
    const allUris = [
        ...new Set(resolved.replacements.flatMap((r) => [r.sourceUri, r.destinationUri])),
      ],
      [playlists, membership] = await Promise.all([
        collectPages(`${API_BASE}/me/playlists?limit=50`, api),
        inspectLibrary(allUris),
      ]),
      contents = new Map();
    state.libraryTarget = findLibraryTarget(resolved.replacements, membership);
    state.skipped = [];
    for (let i = 0; i < playlists.length; i++) {
      message(`Scanning playlist ${i + 1} of ${playlists.length}: ${playlists[i].name}`);
      try {
        contents.set(
          playlists[i].id,
          await collectPages(`${API_BASE}/playlists/${playlists[i].id}/items?limit=50`, api),
        );
      } catch (error) {
        state.skipped.push({
          name: playlists[i].name,
          status: error.status || null,
          reason: error.message,
          category: error.status === 403 ? 'not owner/collaborator' : 'read failed',
        });
      }
    }
    state.targets = findTargets(playlists, contents, state.replacements);
    render(resolved.replacements);
  } catch (error) {
    message(error.message, 'error');
  }
}
async function inspectPlaylist(id) {
  const [rows, playlist] = await Promise.all([
    collectPages(`${API_BASE}/playlists/${id}/items?limit=50`, api),
    api(`/playlists/${id}?fields=snapshot_id`),
  ]);
  if (!playlist.snapshot_id)
    throw new Error('Spotify did not return a playlist snapshot; source tracks were kept.');
  return { rows, snapshotId: playlist.snapshot_id };
}
function render(replacements) {
  const mappings = $('#mappingList');
  mappings.replaceChildren();
  for (const r of replacements) {
    const li = document.createElement('li');
    li.textContent = `${r.position ? `${r.position} · ` : ''}${r.sourceName} → ${r.destinationName}`;
    mappings.append(li);
  }
  $('#mappingBox').hidden = replacements.length === 1;
  $('#mappingCount').textContent = replacements.length;
  const list = $('#playlistList');
  list.replaceChildren();
  if (state.libraryTarget.affected) {
    const li = document.createElement('li');
    li.textContent = `Liked Songs — ${state.libraryTarget.occurrences} saved source track${state.libraryTarget.occurrences === 1 ? '' : 's'} to migrate`;
    list.append(li);
  }
  for (const p of state.targets) {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.occurrences} source occurrence${p.occurrences === 1 ? '' : 's'}, ${p.sourceUris.length} distinct track${p.sourceUris.length === 1 ? '' : 's'} to migrate`;
    list.append(li);
  }
  const forbidden = state.skipped.filter((x) => x.status === 403).length,
    failed = state.skipped.length - forbidden;
  $('#targetCount').textContent = state.targets.length;
  $('#skippedCount').textContent = state.skipped.length;
  $('#skippedDetail').textContent = state.skipped.length
    ? ` (${forbidden} not owned/collaborative; ${failed} other read failures)`
    : '';
  $('#likedStatus').textContent = state.libraryTarget.affected
    ? `${state.libraryTarget.occurrences} source track${state.libraryTarget.occurrences === 1 ? ' is' : 's are'} in Liked Songs`
    : 'source not found in Liked Songs';
  $('#preview').hidden = false;
  const affected = state.targets.length + Number(state.libraryTarget.affected);
  $('#execute').disabled = !affected;
  message(
    affected
      ? 'Review the exact mapping, Liked Songs state, and affected playlists.'
      : 'No source tracks were found in Liked Songs or readable editable playlists.',
    affected ? 'success' : '',
  );
}
async function execute() {
  if (!state.targets.length && !state.libraryTarget?.affected) return;
  $('#execute').disabled = true;
  $('#scan').disabled = true;
  message('Re-checking Liked Songs and target playlists before migration…');
  const library = await prepareLibraryMigration(
    state.libraryTarget,
    state.replacements,
    api,
    inspectLibrary,
  );
  if (!['prepared', 'not-affected'].includes(library.phase)) {
    message(`Stopped safely: ${library.error || 'Liked Songs could not be verified.'}`, 'error');
    $('#scan').disabled = false;
    return;
  }
  const outcome = await runSafeMigration(state.targets, state.replacements, api, inspectPlaylist),
    list = $('#playlistList');
  list.replaceChildren();
  for (const r of outcome.results) {
    const li = document.createElement('li');
    li.className = r.removed ? 'done' : 'warning';
    li.textContent = `${r.name} — ${r.removed ? 'migrated' : r.verified ? 'verified; source removal failed' : r.added ? 'replacement added but verification failed; source kept' : r.error || 'migration stopped safely'}`;
    list.append(li);
  }
  if (outcome.phase !== 'complete') {
    const li = document.createElement('li');
    li.className = 'warning';
    li.textContent =
      'Liked Songs — replacement secured if needed; old like kept because playlist migration did not complete';
    list.prepend(li);
    message(
      'Stopped safely: old Liked Songs membership was kept. Review the playlist result.',
      'error',
    );
    $('#scan').disabled = false;
    return;
  }
  const liked = await finishLibraryMigration(library, api, inspectLibrary),
    likedRow = document.createElement('li');
  likedRow.className =
    liked.phase === 'complete' || liked.phase === 'not-affected' ? 'done' : 'warning';
  likedRow.textContent = `Liked Songs — ${liked.phase === 'complete' ? 'migrated and verified' : liked.phase === 'not-affected' ? 'source was not liked' : liked.error}`;
  list.prepend(likedRow);
  message(
    liked.phase === 'complete' || liked.phase === 'not-affected'
      ? 'Migration complete. Playlists and Liked Songs were verified before and after mutation.'
      : 'Playlists migrated, but final Liked Songs removal could not be verified.',
    'error',
  );
  if (liked.phase === 'complete' || liked.phase === 'not-affected')
    status.className = 'status success';
  $('#scan').disabled = false;
}
async function init() {
  $('#clientId').value = localStorage.getItem('spotify_client_id') || '';
  const params = new URLSearchParams(location.search);
  if (!params.get('code') && localStorage.getItem('spotify_scope_version') !== scopeVersion) {
    sessionStorage.removeItem('access_token');
    sessionStorage.removeItem('expires_at');
    localStorage.removeItem('refresh_token');
  }
  try {
    if (params.get('error')) throw new Error(`Login cancelled: ${params.get('error')}`);
    state.token = params.get('code')
      ? await finish(params.get('code'), params.get('state'))
      : sessionStorage.getItem('access_token');
    if (!state.token || Date.now() >= Number(sessionStorage.getItem('expires_at') || 0) - 30000)
      state.token = await refresh();
  } catch (error) {
    message(error.message, 'error');
  }
  $('#setup').hidden = Boolean(state.token);
  $('#swapper').hidden = !state.token;
  if (state.token) {
    try {
      const me = await api('/me');
      $('#account').textContent = me.display_name || me.id;
      message('Connected. Choose track or album mode.', 'success');
    } catch (error) {
      $('#setup').hidden = false;
      $('#swapper').hidden = true;
      message(error.message, 'error');
    }
  }
}
$('#connect').addEventListener('click', login);
$('#scan').addEventListener('click', scan);
$('#execute').addEventListener('click', execute);
$('#disconnect').addEventListener('click', () => {
  sessionStorage.clear();
  localStorage.removeItem('refresh_token');
  location.reload();
});
init();
