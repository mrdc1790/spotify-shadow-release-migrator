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
    createSpotifyQueue,
    createPlaylistCheckpoints,
    runSafeMigration,
    trackUri,
} from './spotify.js';
import { createPreviewStore } from './preview-store.js';
const scopes =
    'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-library-modify';

const scopeVersion = 'library-v1';

const redirectUri = `${location.origin}/`;

const state = {
    token: null,
    accountId: null,
    legacyAccountId: null,
    targets: [],
    libraryTarget: null,
    replacements: [],
    skipped: [],
};

let previewReady = false;
let scanning = false;
let executing = false;
let pauseTimer;
let readAttempts = 0;
let writeAttempts = 0;
let pauseAfterRequest = false;
let checkingAvailability = false;
let resumeAvailable = false;
let stopRequested = false;
let progress;
let previewInspector;
let previewScope;

function refreshPauseUI() {
    const wait = queueSpotifyRequest.cooldownState();
    const label = $('#cooldownStatus');
    label.hidden = !wait.paused;
    const activity = pauseAfterRequest ? 'no further request sent' : 'no request sent';
    label.textContent = wait.unknown
        ? `Paused: the saved retry time is unknown; ${activity}. Use Check Spotify availability for one read, or record a verified retry time below.`
        : wait.paused
          ? `Paused until ${new Date(wait.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; ${activity}. ${Math.ceil((wait.retryAt - Date.now()) / 1000)} seconds remaining. This is a saved deadline, not a new Spotify rejection.`
          : '';
    $('#scan').disabled = wait.paused || scanning || executing || checkingAvailability;
    $('#scan').textContent = wait.paused
        ? 'Paused'
        : resumeAvailable ? 'Resume preview' : 'Build preview';
    $('#stopScan').hidden = !scanning;
    $('#stopScan').disabled = stopRequested;
    $('#disconnect').disabled = scanning || executing || checkingAvailability;
    for (const selector of [
        '#source',
        '#destination',
        'input[name=kind][value="track"]',
        'input[name=kind][value="album"]',
    ]) {
        $(selector).disabled = scanning || executing;
    }
    if (wait.paused) $('#execute').disabled = true;
    $('#checkAvailability').hidden = !wait.unknown;
    $('#checkAvailability').disabled =
        !state.token || checkingAvailability || scanning || executing || wait.probeAt > Date.now();
    $('#checkAvailability').textContent = checkingAvailability
        ? 'Checking…'
        : wait.probeAt > Date.now()
          ? `Check available in ${Math.ceil((wait.probeAt - Date.now()) / 1000)} seconds`
          : 'Check Spotify availability';
    if (pauseTimer) globalThis.clearTimeout?.(pauseTimer);
    pauseTimer = wait.paused ? globalThis.setTimeout?.(refreshPauseUI, 1000) : null;
}

// Store only a cooldown timestamp, scoped to the configured app, never credentials.
function cooldownKey() {
    return `spotify_cooldown:${localStorage.getItem('spotify_client_id') || ''}`;
}

const queueSpotifyRequest = createSpotifyQueue({
    readCooldown: () => {
        try {
            return JSON.parse(localStorage.getItem(cooldownKey()) || '0');
        } catch {
            return 0;
        }
    },
    saveCooldown: (deadline) => {
        try {
            localStorage.setItem(cooldownKey(), JSON.stringify(deadline));
        } catch {}
        refreshPauseUI();
    },
    onWait: (delay, diagnostic) =>
        message(`${diagnostic} Paused for ${Math.ceil(delay / 1000)} seconds before retrying…`),
});

function checkpointKey(id) {
    if (!state.accountId) return null;
    return `spotify_preview:${localStorage.getItem('spotify_client_id')}:${state.accountId}:${id}`;
}

async function loadCheckpoint(id) {
    const key = checkpointKey(id);
    let value = await previewStore.load(key);
    if (value === null && state.legacyAccountId && state.legacyAccountId !== state.accountId) {
        const oldKey = `spotify_preview:${localStorage.getItem('spotify_client_id')}:${state.legacyAccountId}:${id}`;
        value = await previewStore.load(oldKey);
        if (value !== null) await previewStore.save(key, value);
    }
    return value;
}

const previewStore = createPreviewStore({
    onStatus: (text) => {
        $('#cacheStatus').textContent = text;
    },
});

const $ = (s) => document.querySelector(s);
const status = $('#status');
const authStatus = $('#authStatus');

function message(text, kind = '') {
    status.textContent = text;
    status.className = `status ${kind}`;
}

function showProgress(event) {
    if (!progress) return;
    if (event?.type === 'page') progress.pages++;
    if (['reused', 'resumed', 'changed'].includes(event?.type))
        progress[event.type].add(event.id);
    $('#scanProgress').hidden = false;
    $('#scanProgress').textContent =
        `Checked ${progress.checked} of ${progress.total} playlists · ${progress.total - progress.checked} remaining · ${progress.reused.size} reused · ${progress.resumed.size} resumed · ${progress.changed.size} changed · ${progress.pages} pages fetched · ${progress.unresolved} unresolved.`;
}

async function ensureAccount(restoreDraft = false) {
    if (!state.accountId) {
        const me = await api('/me');
        const accountId = me?.account_id || me?.id;
        if (typeof accountId !== 'string' || !accountId)
            throw new Error(
                'Spotify account identity is unavailable; preview cannot be scoped safely.',
            );
        state.accountId = accountId;
        state.legacyAccountId = typeof me.id === 'string' ? me.id : null;
        const name = me.display_name || accountId;
        $('#accountLabel').textContent = 'Connected as';
        $('#account').textContent = name;
        $('#account').hidden = false;
    }
    if (restoreDraft) {
        const draft = await loadCheckpoint('draft');
        if (
            draft?.version === 1 &&
            ['track', 'album'].includes(draft.kind) &&
            typeof draft.source === 'string' &&
            typeof draft.destination === 'string' &&
            !$('#source').value &&
            !$('#destination').value
        ) {
            $('#source').value = draft.source;
            $('#destination').value = draft.destination;
            document.querySelector(`input[name=kind][value="${draft.kind}"]`).checked = true;
            resumeAvailable = true;
            refreshPauseUI();
            message('Saved preview found. Resume to recheck playlist versions and continue; nothing has been changed.');
        }
    }
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
    if (!response.ok)
        throw new Error('Spotify login failed. Check the Client ID and redirect URI.');
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

async function api(path, options = {}, recoveryProbe = false) {
    if (scanning && stopRequested)
        throw new Error('Preview stopped. Saved pages are kept; resume when ready.');
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const target = new URL(url);
    if (
        target.origin !== 'https://api.spotify.com' ||
        !target.pathname.startsWith('/v1/') ||
        target.username ||
        target.password ||
        target.hash
    ) {
        throw new Error('Unexpected Spotify request destination refused.');
    }
    const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
    if (recoveryProbe && (!readOnly || path !== '/me/playlists?limit=1'))
        throw new Error('Availability checks must use the read-only playlist endpoint.');
    const requestUrl = readOnly ? `/spotify-read${target.pathname}${target.search}` : url;
    const sendRequest = recoveryProbe ? queueSpotifyRequest.probeUnknown : queueSpotifyRequest;
    const response = await sendRequest(
        async () => {
            if (scanning && stopRequested)
                throw new Error('Preview stopped. Saved pages are kept; resume when ready.');
            if (
                !state.token ||
                Date.now() >= Number(sessionStorage.getItem('expires_at') || 0) - 30000
            ) {
                state.token = await refresh();
            }
            if (!state.token) throw new Error('Spotify session expired. Reconnect.');
            if (!readOnly) writeAttempts++;
            const result = await fetch(requestUrl, {
                ...options,
                headers: {
                    Authorization: `Bearer ${state.token}`,
                    'Content-Type': 'application/json',
                    ...(readOnly ? { 'X-Spotify-Relay': '1' } : {}),
                    ...(recoveryProbe ? { 'X-Spotify-Read-Probe': '1' } : {}),
                    ...options.headers,
                },
            });
            if (result.status === 429) pauseAfterRequest = true;
            const count = result.headers.get('X-Spotify-Upstream-Requests');
            if (readOnly && count !== null && /^\d+$/.test(count)) readAttempts += Number(count);
            $('#requestCount').textContent =
                `This page: ${readAttempts} reported Spotify read attempts; ${writeAttempts} write attempts.`;
            return result;
        },
        `${options.method || 'GET'} ${new URL(url).pathname.replace(
            /\/(tracks|albums|playlists|users)\/[^/]+/g,
            '/$1/{id}',
        )}`,
    );
    if (!response.ok) {
        let detail = '';
        try {
            detail = (await response.json()).error?.message || '';
        } catch {}
        if (
            readOnly &&
            response.status === 404 &&
            response.headers.get('X-Spotify-Relay-Response') !== '1'
        ) {
            detail =
                'The local read relay is unavailable. Stop the old server with Ctrl+C and run npm start again.';
        }
        const operation = `${options.method || 'GET'} ${target.pathname.replace(/\/(tracks|albums|playlists|users)\/[^/]+/g, '/$1/{id}')}`;
        const error = new Error(
            `${operation}: ${detail || `Spotify request failed (${response.status}).`}`,
        );
        error.status = response.status;
        throw error;
    }
    return response.status === 204 ? null : response.json();
}
function trackLabel(track, requestedId) {
    const release = [track.album?.name, track.album?.release_date].filter(Boolean).join(' · ');
    const returned = track.id && track.id !== requestedId ? ` · Spotify returned ${track.id}` : '';
    return `${track.name} — ${track.artists.map((artist) => artist.name).join(', ')}${release ? ` · ${release}` : ''} · ${requestedId}${returned}`;
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
        // The batch GET /tracks endpoint is unavailable in development mode.
        const a = await api(`/tracks/${source.id}`);
        const b = await api(`/tracks/${destination.id}`);
        if (!a || !b)
            throw new Error(
                'Spotify could not load both tracks. Check that they are available to this account.',
            );
        return {
            sourceLabel: trackLabel(a, source.id),
            destinationLabel: trackLabel(b, destination.id),
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
    const a = await api(`/albums/${source.id}`);
    const b = await api(`/albums/${destination.id}`);
    const aTracks = await collectPages(`${API_BASE}/albums/${source.id}/tracks?limit=50`, api);
    const bTracks = await collectPages(`${API_BASE}/albums/${destination.id}/tracks?limit=50`, api);
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
        if (
            !Array.isArray(saved) ||
            saved.length !== batch.length ||
            saved.some((value) => typeof value !== 'boolean')
        ) {
            throw new Error('Spotify returned incomplete Liked Songs membership.');
        }
        batch.forEach((uri, index) => (result[uri] = saved[index]));
    }
    return result;
}
async function scan() {
    if (scanning || executing || checkingAvailability) return;
    if (queueSpotifyRequest.cooldownState().paused) {
        refreshPauseUI();
        return;
    }
    scanning = true;
    stopRequested = false;
    refreshPauseUI();
    previewReady = false;
    state.targets = [];
    state.libraryTarget = null;
    try {
        $('#scan').disabled = true;
        $('#execute').disabled = true;
        $('#preview').hidden = true;
        progress = null;
        $('#scanProgress').hidden = true;
        queueSpotifyRequest.check();
        await ensureAccount(true);
        // Preserve the last usable draft when a newly entered link is malformed.
        parseSpotifyInput($('#source').value);
        parseSpotifyInput($('#destination').value);
        await previewStore.save(checkpointKey('draft'), {
            version: 1,
            source: $('#source').value.trim(),
            destination: $('#destination').value.trim(),
            kind: document.querySelector('input[name=kind]:checked').value,
        });
        resumeAvailable = true;
        // Retain memory fallback in this tab, but never share it across accounts/apps.
        const scope = checkpointKey('');
        if (previewScope !== scope) {
            previewScope = scope;
            previewInspector = createPlaylistCheckpoints({
                load: loadCheckpoint,
                save: (id, value) => previewStore.save(`${scope}${id}`, value),
                onProgress: showProgress,
            });
        }
        message('Validating releases and Liked Songs…');
        const resolved = await resolveInputs();
        state.replacements = resolved.replacements;
        $('#sourceName').textContent = resolved.sourceLabel;
        $('#destinationName').textContent = resolved.destinationLabel;
        const allUris = [
            ...new Set(resolved.replacements.flatMap((r) => [r.sourceUri, r.destinationUri])),
        ];
        const playlists = await collectPages(`${API_BASE}/me/playlists?limit=50`, api);
        const membership = await inspectLibrary(allUris);
        const contents = new Map();
        state.libraryTarget = findLibraryTarget(resolved.replacements, membership);
        state.skipped = [];
        progress = {
            total: playlists.length,
            checked: 0,
            pages: 0,
            unresolved: 0,
            reused: new Set(),
            resumed: new Set(),
            changed: new Set(),
        };
        showProgress();
        for (let i = 0; i < playlists.length; i++) {
            message(`Scanning playlist ${i + 1} of ${playlists.length}: ${playlists[i].name}`);
            try {
                contents.set(
                    playlists[i].id,
                    await previewInspector(playlists[i].id, api, () => {
                        message(
                            `Playlist changed; reading its new version once: ${playlists[i].name}`,
                        );
                    }),
                );
            } catch (error) {
                progress.unresolved++;
                if (error.status !== 403 && error.code !== 'PLAYLIST_CHANGED') throw error;
                state.skipped.push({
                    name: playlists[i].name,
                    status: error.status || null,
                    reason: error.message,
                    category: error.code === 'PLAYLIST_CHANGED' ? 'changing' : 'access denied',
                });
            } finally {
                progress.checked++;
                showProgress();
            }
        }
        if (stopRequested) throw new Error('Preview stopped. Saved pages are kept; resume when ready.');
        state.targets = findTargets(playlists, contents, state.replacements);
        previewReady = state.skipped.length === 0;
        render(resolved.replacements);
    } catch (error) {
        state.targets = [];
        state.libraryTarget = null;
        message(`Preview incomplete. ${error.message} Saved pages will be revalidated on resume.`, 'error');
    } finally {
        scanning = false;
        refreshPauseUI();
    }
}
async function checkAvailability() {
    if (checkingAvailability || scanning || executing || !state.token) return;
    if (!queueSpotifyRequest.cooldownState().unknown) return;
    checkingAvailability = true;
    previewReady = false;
    $('#execute').disabled = true;
    $('#preview').hidden = true;
    refreshPauseUI();
    try {
        await api('/me/playlists?limit=1', {}, true);
        message(
            'Spotify accepted the availability check. Build a complete preview to continue.',
            'success',
        );
    } catch (error) {
        message(`Availability check stopped: ${error.message}`, 'error');
    } finally {
        checkingAvailability = false;
        refreshPauseUI();
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
    const unresolved = $('#unresolvedList');
    unresolved.replaceChildren();
    for (const playlist of state.skipped) {
        const row = document.createElement('li');
        row.textContent = `${playlist.name} — ${playlist.reason}`;
        unresolved.append(row);
    }
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
        ? ` (${forbidden} access denied; ${failed} changing or otherwise unresolved)`
        : '';
    $('#likedStatus').textContent = state.libraryTarget.affected
        ? `${state.libraryTarget.occurrences} source track${state.libraryTarget.occurrences === 1 ? ' is' : 's are'} in Liked Songs`
        : 'source not found in Liked Songs';
    $('#preview').hidden = false;
    const affected = state.targets.length + Number(state.libraryTarget.affected);
    $('#execute').disabled = !affected || !previewReady;
    if (!previewReady) {
        message(
            'Preview incomplete: some playlists remain unresolved. Other playlists were scanned and retained. Rebuild preview to retry; migration is unavailable until coverage is complete.',
            'error',
        );
        return;
    }
    message(
        affected
            ? 'Review the exact mapping, Liked Songs state, and affected playlists.'
            : 'No source tracks were found in Liked Songs or readable editable playlists.',
        affected ? 'success' : '',
    );
}
async function execute() {
    if (!previewReady || scanning) return;
    if (!state.targets.length && !state.libraryTarget?.affected) return;
    previewReady = false;
    executing = true;
    refreshPauseUI();
    $('#execute').disabled = true;
    $('#scan').disabled = true;
    try {
        message('Re-checking Liked Songs and target playlists before migration…');
        const library = await prepareLibraryMigration(
            state.libraryTarget,
            state.replacements,
            api,
            inspectLibrary,
        );
        if (!['prepared', 'not-affected'].includes(library.phase)) {
            message(
                `Stopped safely: ${library.error || 'Liked Songs could not be verified.'}`,
                'error',
            );
            refreshPauseUI();
            return;
        }
        const outcome = await runSafeMigration(
                state.targets,
                state.replacements,
                api,
                inspectPlaylist,
            ),
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
            refreshPauseUI();
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
        refreshPauseUI();
    } catch (error) {
        message(`Migration stopped: ${error.message}`, 'error');
    } finally {
        executing = false;
        refreshPauseUI();
    }
}
async function init() {
    $('#redirectUri').textContent = redirectUri;
    $('#execute').disabled = true;
    $('#preview').hidden = true;
    $('#accountLabel').textContent = 'Spotify session saved; account not checked';
    $('#account').hidden = true;
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
    refreshPauseUI();
    if (state.token && !queueSpotifyRequest.cooldownState().paused) {
        try {
            await ensureAccount(true);
            if (!resumeAvailable) message('Connected. Choose track or album mode.', 'success');
        } catch (error) {
            message(error.message, 'error');
        }
    }
}
$('#recordCooldown').addEventListener('click', () => {
    try {
        queueSpotifyRequest.recordCooldown(new Date($('#retryTime').value).getTime());
        previewReady = false;
        $('#execute').disabled = true;
        $('#preview').hidden = true;
        message(
            'Cooldown recorded. Build preview after that time; saved playlist pages will be revalidated.',
        );
    } catch (error) {
        message(error.message, 'error');
    }
});
$('#checkAvailability').addEventListener('click', checkAvailability);
function invalidatePreview() {
    previewReady = false;
    $('#execute').disabled = true;
    $('#preview').hidden = true;
}

for (const selector of ['#source', '#destination'])
    $(selector).addEventListener('input', invalidatePreview);
for (const kind of ['track', 'album'])
    $(`input[name=kind][value="${kind}"]`).addEventListener('change', invalidatePreview);

globalThis.addEventListener?.('storage', refreshPauseUI);
$('#connect').addEventListener('click', login);
$('#scan').addEventListener('click', scan);
$('#stopScan').addEventListener('click', () => {
    stopRequested = true;
    refreshPauseUI();
    message('Stopping after the current read. Successfully saved pages will be kept.');
});
$('#execute').addEventListener('click', execute);
$('#disconnect').addEventListener('click', async () => {
    if (scanning || executing || checkingAvailability) return;
    let erased = true;
    try {
        await previewStore.clear(`spotify_preview:${localStorage.getItem('spotify_client_id')}:`);
    } catch {
        erased = false;
    }
    sessionStorage.clear();
    localStorage.removeItem('refresh_token');
    if (erased) location.reload();
    else {
        state.token = null;
        state.accountId = null;
        previewReady = false;
        $('#execute').disabled = true;
        $('#preview').hidden = true;
        $('#setup').hidden = false;
        $('#swapper').hidden = true;
        message('Disconnected, but saved preview data could not be erased. Clear this site’s browser data to remove it.', 'error');
    }
});
init();
