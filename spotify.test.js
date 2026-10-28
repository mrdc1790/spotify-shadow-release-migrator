import http from 'http';
import { createSpotifyReadRelay, spotifyReadTarget } from './spotify-relay.js';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import * as spotify from './spotify.js';
import { createPreviewStore } from './preview-store.js';
import { rejects } from 'assert/strict';
import {
    buildAuthorizationUrl,
    buildAlbumReplacements,
    findLibraryTarget,
    finishLibraryMigration,
    parseSpotifyInput,
    prepareLibraryMigration,
    retryAfterMilliseconds,
    runSafeMigration,
} from './spotify.js';
const tests = [],
    test = (n, f) => tests.push([n, f]),
    equal = (a, b) => {
        if (JSON.stringify(a) !== JSON.stringify(b))
            throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    };
test('parses track and album inputs', () => {
    equal(parseSpotifyInput('spotify:album:4aawyAB9vmqN3uQ7FjRGTy'), {
        type: 'album',
        id: '4aawyAB9vmqN3uQ7FjRGTy',
    });
    equal(parseSpotifyInput('https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6?si=x'), {
        type: 'track',
        id: '6rqhFgbbKwnb9MLmUQDhG6',
    });
});

test('honors Spotify Retry-After without truncating a long cooldown', () => {
    equal(retryAfterMilliseconds('24000'), 24000000);
    equal(retryAfterMilliseconds(null), 30000);
    equal(retryAfterMilliseconds('0'), 30000);
    equal(retryAfterMilliseconds('bad'), 30000);
});

test('builds a PKCE authorization URL with every requested scope', () => {
    const scopes = 'playlist-read-private user-library-read user-library-modify';
    const url = buildAuthorizationUrl({
        clientId: '0123456789abcdef0123456789abcdef',
        redirectUri: 'http://127.0.0.1:5173/',
        scopes,
        challenge: 'challenge-value',
        state: 'state-value',
    });

    equal(url.origin, 'https://accounts.spotify.com');
    equal(url.pathname, '/authorize');
    equal(url.searchParams.get('scope'), scopes);
    equal(url.searchParams.get('code_challenge_method'), 'S256');
    equal(url.searchParams.get('state'), 'state-value');
});
test('pairs albums by disc and track number', () => {
    const r = buildAlbumReplacements(
        [{ disc_number: 1, track_number: 1, name: 'Old', uri: 'old' }],
        [{ disc_number: 1, track_number: 1, name: 'New', uri: 'new' }],
    );
    equal(r[0].destinationUri, 'new');
});
test('rejects albums with different track counts', () => {
    let threw = false;
    try {
        buildAlbumReplacements([{ disc_number: 1, track_number: 1 }], []);
    } catch {
        threw = true;
    }
    equal(threw, true);
});
test('never removes anything when an add fails', async () => {
    const calls = [],
        api = async (p, o) => {
            calls.push(o.method);
            if (o.method === 'POST' && p.includes('two')) throw new Error('denied');
        };
    const targets = [
        {
            id: 'one',
            name: 'One',
            occurrences: 1,
            sourceUris: ['a'],
            sourceCounts: { a: 1 },
            destinationCounts: {},
        },
        {
            id: 'two',
            name: 'Two',
            occurrences: 1,
            sourceUris: ['a'],
            sourceCounts: { a: 1 },
            destinationCounts: {},
        },
    ];
    const inspect = async (id) => ({
        rows: [{ item: { uri: 'a' } }],
        snapshotId: `snap-${id}`,
    });
    const out = await runSafeMigration(
        targets,
        [{ sourceUri: 'a', destinationUri: 'b' }],
        api,
        inspect,
    );
    equal(out.phase, 'add-failed');
    equal(calls.includes('DELETE'), false);
});
test('preserves duplicate source occurrences and verifies before removal', async () => {
    const calls = [],
        rows = [
            { item: { uri: 'a' } },
            { item: { uri: 'a' } },
            { item: { uri: 'b' } },
            { item: { uri: 'c' } },
        ],
        api = async (_p, o) => {
            calls.push(o.method);
            if (o.method === 'POST')
                for (const uri of JSON.parse(o.body).uris) rows.push({ item: { uri } });
            if (o.method === 'DELETE') {
                const uris = new Set(JSON.parse(o.body).items.map((item) => item.uri));
                for (let i = rows.length - 1; i >= 0; i--)
                    if (uris.has(rows[i].item.uri)) rows.splice(i, 1);
            }
        };
    const target = {
        id: 'one',
        name: 'One',
        occurrences: 3,
        sourceUris: ['a', 'c'],
        sourceCounts: { a: 2, c: 1 },
        destinationCounts: { b: 1 },
    };
    const inspect = async () => ({ rows: [...rows], snapshotId: 'snap' });
    const out = await runSafeMigration(
        [target],
        [
            { sourceUri: 'a', destinationUri: 'b' },
            { sourceUri: 'c', destinationUri: 'd' },
        ],
        api,
        inspect,
    );
    equal(out.phase, 'complete');
    equal(calls, ['POST', 'DELETE']);
    equal(
        rows.map((row) => row.item.uri),
        ['b', 'b', 'b', 'd'],
    );
});
test('stops if the playlist changed after preview', async () => {
    const calls = [],
        target = {
            id: 'one',
            name: 'One',
            occurrences: 1,
            sourceUris: ['a'],
            sourceCounts: { a: 1 },
            destinationCounts: {},
        };
    const out = await runSafeMigration(
        [target],
        [{ sourceUri: 'a', destinationUri: 'b' }],
        async (_p, o) => calls.push(o.method),
        async () => ({ rows: [], snapshotId: 'snap' }),
    );
    equal(out.phase, 'preflight-failed');
    equal(calls, []);
});
test('includes Liked Songs in the migration target', () => {
    const target = findLibraryTarget(
        [
            { sourceUri: 'a', destinationUri: 'b' },
            { sourceUri: 'c', destinationUri: 'd' },
        ],
        { a: true, b: false, c: false, d: true },
    );
    equal(target.affected, true);
    equal(target.sourceUris, ['a']);
    equal(target.destinationUrisPresent, ['d']);
});
test('adds and verifies a replacement before removing the old like', async () => {
    const saved = { a: true, b: false },
        calls = [],
        inspect = async (uris) => Object.fromEntries(uris.map((uri) => [uri, Boolean(saved[uri])])),
        api = async (_path, options) => {
            const uris = JSON.parse(options.body).uris;
            calls.push(options.method);
            for (const uri of uris) saved[uri] = options.method === 'PUT';
        };
    const target = findLibraryTarget([{ sourceUri: 'a', destinationUri: 'b' }], saved),
        prepared = await prepareLibraryMigration(
            target,
            [{ sourceUri: 'a', destinationUri: 'b' }],
            api,
            inspect,
        );
    equal(prepared.phase, 'prepared');
    equal(saved, { a: true, b: true });
    const finished = await finishLibraryMigration(prepared, api, inspect);
    equal(finished.phase, 'complete');
    equal(saved, { a: false, b: true });
    equal(calls, ['PUT', 'DELETE']);
});
test('does not remove a like when replacement verification fails', async () => {
    const saved = { a: true, b: false },
        calls = [],
        inspect = async (uris) => Object.fromEntries(uris.map((uri) => [uri, Boolean(saved[uri])])),
        api = async (_path, options) => calls.push(options.method),
        target = findLibraryTarget([{ sourceUri: 'a', destinationUri: 'b' }], saved),
        prepared = await prepareLibraryMigration(
            target,
            [{ sourceUri: 'a', destinationUri: 'b' }],
            api,
            inspect,
        );
    equal(prepared.phase, 'prepare-failed');
    equal(calls, ['PUT']);
    equal(saved.a, true);
});

function queueFixture(overrides = {}) {
    let clock = 100000;
    let stored = 0;
    const sleeps = [];
    const options = {
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
        readCooldown: () => stored,
        saveCooldown: (value) => {
            stored = value;
        },
        ...overrides,
    };
    return {
        queue: spotify.createSpotifyQueue(options),
        reload: () => spotify.createSpotifyQueue(options),
        advance: (ms) => {
            clock += ms;
        },
        sleeps,
    };
}

const limited = (header) => ({ status: 429, headers: { get: () => header } });

test('queue serializes concurrent callers and paces dispatch', async () => {
    const f = queueFixture();
    const calls = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
        [1, 2, 3].map((id) =>
            f.queue(async () => {
                active++;
                peak = Math.max(peak, active);
                await Promise.resolve();
                calls.push(id);
                active--;
                return { status: 200 };
            }),
        ),
    );
    equal(calls, [1, 2, 3]);
    equal(peak, 1);
    equal(f.sleeps, [350, 350]);
});

test('long cooldown rejects queued work and survives a reloaded queue', async () => {
    const f = queueFixture();
    let calls = 0;
    const request = async () => {
        calls++;
        return limited('24000');
    };
    const results = await Promise.allSettled([f.queue(request), f.queue(request)]);
    equal(
        results.map((r) => r.reason.status),
        [429, 429],
    );
    equal(calls, 1);
    equal(f.sleeps, []);
    await rejects(f.reload()(request), { status: 429 });
    equal(calls, 1);
    f.advance(24000000);
    await f.reload()(async () => ({ status: 200 }));
});

test('short cooldown holds the queue and increases subsequent pacing', async () => {
    const f = queueFixture();
    let calls = 0;
    await Promise.all([
        f.queue(async () => (++calls === 1 ? limited('2') : { status: 200 })),
        f.queue(async () => ({ status: 200 })),
    ]);
    equal(calls, 2);
    equal(f.sleeps, [2000, 700]);
});

test('missing retry header blocks indefinitely without inventing a cooldown', async () => {
    const f = queueFixture();
    let calls = 0;
    await rejects(
        f.queue(async () => {
            calls++;
            return limited(null);
        }),
        { status: 429 },
    );
    equal(calls, 1);
    equal(f.sleeps, []);
    await rejects(
        f.queue(async () => ({ status: 200 })),
        /duration is unknown/,
    );
});

test('exhausted retries open a circuit for queued requests', async () => {
    const f = queueFixture({ maxRetries: 1 });
    let calls = 0;
    const request = async () => {
        calls++;
        return limited('1');
    };
    const outcomes = await Promise.allSettled([f.queue(request), f.queue(request)]);
    equal(
        outcomes.map((r) => r.reason.status),
        [429, 429],
    );
    equal(calls, 2);
});

test('network failures are never retried, and do not poison the queue', async () => {
    const f = queueFixture();
    let calls = 0;
    await rejects(
        f.queue(async () => {
            calls++;
            throw new Error('network');
        }),
        /network/,
    );
    await f.queue(async () => ({ status: 200 }));
    equal(calls, 1);
    equal(f.sleeps, [350]);
});

function appFixture(playlistStatus = 200, membership = [true, false], savedUntil = 0, overrides = {}) {
    let clock = Date.now();
    let timer;
    const storage = new Map([
        ['spotify_cooldown:synthetic-client', JSON.stringify(savedUntil)],
        ['spotify_client_id', 'synthetic-client'],
        ['spotify_scope_version', 'library-v1'],
    ]);
    class Clock extends Date {
        static now() {
            return clock;
        }
    }
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id))
            elements.set(id, {
                value: '',
                disabled: false,
                hidden: false,
                textContent: '',
                addEventListener(type, handler) {
                    this['on' + type] = handler;
                },
                replaceChildren() {},
                append() {},
                prepend() {},
            });
        return elements.get(id);
    };
    element('input[name=kind]:checked').value = 'track';
    element('#source').value = 'a'.repeat(22);
    element('#destination').value = 'b'.repeat(22);
    const calls = [];
    const context = {
        spotify,
        createPreviewStore: overrides.createPreviewStore || createPreviewStore,
        Date: Clock,
        setTimeout: (callback) => {
            timer = callback;
            return 1;
        },
        clearTimeout: () => {
            timer = null;
        },
        URL,
        URLSearchParams,
        location: { origin: 'http://localhost' },
        localStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        sessionStorage: { getItem: () => String(Date.now() + 3600000) },
        document: { querySelector: element, createElement: () => element('new') },
        fetch: async (url, options) => {
            calls.push([url, options.method || 'GET']);
            let data;
            let status = 200;
            if (url.endsWith('/v1/me')) data = { id: 'synthetic-account' };
            else if (/\/v1\/tracks\/[^/]+$/.test(url))
                data = { name: url.endsWith('a'.repeat(22)) ? 'a' : 'b', artists: [] };
            else if (url.includes('/tracks?'))
                throw new Error('Removed development-mode batch endpoint requested');
            else if (url.includes('/me/playlists'))
                data = {
                    items: [
                        { id: 'p1', name: 'One' },
                        { id: 'p2', name: 'Two' },
                    ],
                    next: null,
                };
            else if (url.includes('/contains')) data = membership;
            else {
                status = playlistStatus;
                data = {
                    total: 1,
                    items: [{ item: { uri: 'spotify:track:' + 'a'.repeat(22) } }],
                    next: null,
                };
            }
            if (url.includes('fields=snapshot_id')) data = { snapshot_id: 'v1' };
            return {
                status,
                ok: status === 200,
                headers: { get: (name) => (name === 'Retry-After' ? '24000' : '1') },
                json: async () => data,
            };
        },
    };
    // Run the real controller against a minimal DOM and mocked HTTP; no Spotify access.
    const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
        .replace(/^import \{([\s\S]*?)\} from '.\/spotify.js';/, 'const {$1} = spotify;')
        .replace("import { createPreviewStore } from './preview-store.js';", '')
        .replace(/init\(\);\s*$/, '')
        .replace(
            'createSpotifyQueue({',
            'createSpotifyQueue({ minimumInterval: 0, now: () => Date.now(),',
        );
    runInNewContext(
        source +
            '\nstate.token = "test"; globalThis.controller = { scan, execute, api, init, refreshPauseUI };',
        context,
    );
    return {
        ...context.controller,
        advance: (ms) => {
            clock += ms;
            timer?.();
        },
        element,
        calls,
        originalFetch: context.fetch,
        setFetch: (fetch) => {
            context.fetch = fetch;
        },
    };
}

test('preview stops at rate-limited playlist, blocks confirmation, and makes no writes', async () => {
    const app = appFixture(429);
    await Promise.all([app.scan(), app.scan()]);
    await app.execute();
    equal(app.calls.length, 6);
    equal(
        app.calls.every(([, method]) => method === 'GET'),
        true,
    );
    equal(app.element('#execute').disabled, true);
    equal(app.element('#scan').disabled, true);
    equal(app.element('#preview').hidden, true);
    equal(app.element('#status').textContent.includes('24000 seconds'), true);
});

test('unreadable playlist keeps migration unavailable', async () => {
    const app = appFixture(403);
    await app.scan();
    await app.execute();
    equal(app.element('#execute').disabled, true);
    equal(
        app.calls.every(([, method]) => method === 'GET'),
        true,
    );
});

test('complete read-only preview enables confirmation', async () => {
    const app = appFixture();
    await app.scan();
    equal(app.element('#execute').disabled, false);
    equal(app.element('#preview').hidden, false);
    equal(
        app.calls.every(([, method]) => method === 'GET'),
        true,
    );
});

test('incomplete membership and malformed pages fail closed', async () => {
    const app = appFixture(200, [true]);
    await app.scan();
    equal(app.element('#execute').disabled, true);
    equal(app.calls.length, 5);
    await rejects(
        spotify.collectPages('/page', async () => ({ next: null })),
        /incomplete/,
    );
});

test('rate limit during migration preflight releases controls without writing', async () => {
    const app = appFixture();
    await app.scan();
    const methods = [];
    app.setFetch(async (_url, options) => {
        methods.push(options.method || 'GET');
        return limited('24000');
    });
    await app.execute();
    equal(methods, ['GET']);
    equal(app.element('#execute').disabled, true);
    equal(app.element('#scan').disabled, true);
    equal(app.element('#status').textContent.includes('rate limit'), true);
});

test('a failed rebuild invalidates a previously successful preview', async () => {
    const app = appFixture();
    await app.scan();
    equal(app.element('#execute').disabled, false);
    let requests = 0;
    app.setFetch(async () => {
        requests++;
        throw new Error('offline');
    });
    await app.scan();
    await app.execute();
    equal(requests, 1);
    equal(app.element('#execute').disabled, true);
    equal(app.element('#preview').hidden, true);
});

test('track preview uses individual development-mode endpoints, never the removed batch endpoint', async () => {
    const app = appFixture();
    await app.scan();
    equal(
        app.calls.filter(([url]) => /\/tracks\//.test(url)).map(([url]) => new URL(url, 'http://localhost').pathname),
        ['/spotify-read/v1/tracks/' + 'a'.repeat(22), '/spotify-read/v1/tracks/' + 'b'.repeat(22)],
    );
    equal(
        app.calls.some(([url]) => url.includes('/tracks?')),
        false,
    );
    equal(app.element('#execute').disabled, false);
});

test('429 diagnostics identify the operation without IDs or query parameters', async () => {
    const app = appFixture();
    let calls = 0;
    app.setFetch(async (url, options) => {
        if (url.endsWith('/v1/me')) return app.originalFetch(url, options);
        calls++;
        return limited(null);
    });
    await app.scan();
    const message = app.element('#status').textContent;
    equal(calls, 1);
    equal(message.includes('HTTP 429 on GET /v1/tracks/{id} (attempt 1)'), true);
    equal(message.includes('unavailable to this page'), true);
    equal(message.includes('duration is unknown'), true);
    equal(message.includes('a'.repeat(22)), false);
    equal(app.element('#execute').disabled, true);
});

test('valid server Retry-After is distinguished from fallback', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited('120'), 'GET /v1/tracks/{id}'),
        (error) => {
            equal(error.status, 429);
            equal(error.message.includes('Spotify Retry-After: 120 seconds'), true);
            equal(error.message.includes('local safety backoff'), false);
            return true;
        },
    );
});

test('unknown cooldown survives reload and cannot be bypassed by waiting 30 seconds', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited(null)),
        /duration is unknown/,
    );
    f.advance(3600000);
    let called = false;
    const reloaded = f.reload();
    await rejects(
        reloaded(async () => {
            called = true;
        }),
        /duration is unknown/,
    );
    equal(called, false);
    reloaded.recordCooldown(3701000);
    await rejects(
        reloaded(async () => {
            called = true;
        }),
        { status: 429 },
    );
    f.advance(1000);
    await reloaded(async () => ({ status: 200 }));
});

test('actual incident cooldown lasts the full 32923 seconds', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited('32923')),
        { status: 429 },
    );
    f.advance(32922000);
    await rejects(
        f.reload()(async () => ({ status: 200 })),
        { status: 429 },
    );
    f.advance(1000);
    await f.reload()(async () => ({ status: 200 }));
});

test('playlist checkpoint resumes only after snapshot revalidation and retains duplicates', async () => {
    let stored = null;
    let version = 'one';
    let fail = true;
    const calls = [];
    const first = `${spotify.API_BASE}/playlists/p/items?limit=50`;
    const second = `${spotify.API_BASE}/playlists/p/items?limit=50&offset=2`;
    const request = async (url) => {
        calls.push(url);
        if (url.includes('fields=')) return { snapshot_id: version };
        if (url === first)
            return {
                items: [{ item: { uri: 'a' } }, { item: { uri: 'a' } }],
                next: second,
                total: 3,
            };
        if (fail) throw Object.assign(new Error('quota'), { status: 429 });
        return { items: [{ item: { uri: 'b' } }], next: null, total: 3 };
    };
    const options = {
        load: () => stored,
        save: (_id, value) => {
            stored = JSON.parse(JSON.stringify(value));
        },
    };
    await rejects(spotify.createPlaylistCheckpoints(options)('p', request), /quota/);
    equal(stored.rows.length, 2);
    fail = false;
    calls.length = 0;
    const resumed = await spotify.createPlaylistCheckpoints(options)('p', request);
    equal(resumed.map(spotify.itemUri), ['a', 'a', 'b']);
    equal(calls.includes(first), false);
    equal(calls.filter((url) => url.includes('fields=')).length, 2);
    calls.length = 0;
    await spotify.createPlaylistCheckpoints(options)('p', request);
    equal(calls.length, 1);
    version = 'two';
    calls.length = 0;
    await spotify.createPlaylistCheckpoints(options)('p', request);
    equal(calls.includes(first), true);
});

test('checkpoint rejects truncated totals and changing snapshots', async () => {
    const collect = spotify.createPlaylistCheckpoints();
    await rejects(
        collect('p', async (url) =>
            url.includes('fields=') ? { snapshot_id: 'v' } : { items: [], next: null, total: 3 },
        ),
        /pagination/,
    );
    let metadata = 0;
    await rejects(
        spotify.createPlaylistCheckpoints()('p', async (url) =>
            url.includes('fields=')
                ? { snapshot_id: String(++metadata) }
                : { items: [], next: null, total: 0 },
        ),
        /changed/,
    );
});

test('malformed saved checkpoint is recaptured instead of declared complete', async () => {
    for (const corrupt of [
        { rows: [], total: null, next: null },
        { rows: [], total: 2, next: null },
        { rows: [null], total: 1, next: null },
    ]) {
        let pages = 0;
        const inspect = spotify.createPlaylistCheckpoints({
            load: () => ({ snapshot: 'v', seen: [], complete: false, ...corrupt }),
        });
        const rows = await inspect('p', async (url) => {
            if (url.includes('fields=')) return { snapshot_id: 'v' };
            pages++;
            return { items: [{ item: { uri: 'fresh' } }], total: 1, next: null };
        });
        equal(pages, 1);
        equal(rows.map(spotify.itemUri), ['fresh']);
    }
});

async function withRelay(read, testBody) {
    let clock = 100000;
    const sleeps = [];
    const handler = createSpotifyReadRelay({
        read,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
            sleeps.push(ms);
        },
    });
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const request = (
        path = '/spotify-read/v1/me/playlists?limit=50',
        method = 'GET',
        headers = {},
    ) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    method,
                    headers: {
                        Authorization: 'Bearer synthetic-test-token',
                        'X-Spotify-Relay': '1',
                        Connection: 'close',
                        ...headers,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            body: Buffer.concat(chunks).toString(),
                        }),
                    );
                },
            );
            req.on('error', reject);
            req.end();
        });
    try {
        await testBody(request, sleeps);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('local relay exposes the real long Retry-After and blocks later upstream reads', async () => {
    let calls = 0;
    await withRelay(
        async (url, token) => {
            calls++;
            equal(url.origin, 'https://api.spotify.com');
            equal(token, 'Bearer synthetic-test-token');
            return {
                status: 429,
                headers: { 'retry-after': '32923' },
                body: JSON.stringify({ error: { status: 429, reason: 'QUOTA_EXCEEDED' } }),
            };
        },
        async (request) => {
            const results = await Promise.all([request(), request()]);
            equal(
                results.map((r) => r.status),
                [429, 429],
            );
            equal(
                results.map((r) => r.headers['retry-after']),
                ['32923', '32923'],
            );
            equal(calls, 1);
            equal(
                results.map((r) => r.headers['x-spotify-upstream-requests']),
                ['1', '0'],
            );
            equal(results[0].headers['cache-control'], 'no-store');
            equal(results[0].body.includes('synthetic-test-token'), false);
        },
    );
});

test('relay refuses writes, foreign origins, unexpected hosts, targets, and unauthenticated reads', async () => {
    let calls = 0;
    await withRelay(
        async () => {
            calls++;
        },
        async (request) => {
            equal((await request(undefined, 'POST')).status, 405);
            equal((await request(undefined, 'DELETE')).status, 405);
            equal(
                (await request(undefined, 'GET', { Origin: 'https://untrusted.example' })).status,
                403,
            );
            equal((await request(undefined, 'GET', { Host: 'untrusted.example' })).status, 403);
            equal((await request(undefined, 'GET', { 'X-Spotify-Relay': '' })).status, 403);
            equal((await request(undefined, 'GET', { Authorization: '' })).status, 401);
            equal((await request('/spotify-read//untrusted.example/v1/me')).status, 400);
            equal((await request('/spotify-read/v1/not-allowed')).status, 400);
            equal(
                (await request('/spotify-read/v1/me?redirect=https://untrusted.example')).status,
                400,
            );
            equal(calls, 0);
        },
    );
});

test('relay retries transient read failures with bounded backoff but never follows redirects', async () => {
    let calls = 0;
    await withRelay(
        async () => ({ status: ++calls <= 2 ? 503 : 200, headers: {}, body: '{}' }),
        async (request, sleeps) => {
            equal((await request()).status, 200);
            equal(calls, 3);
            equal(sleeps, [2000, 4000]);
        },
    );
    await withRelay(
        async () => ({ status: 302, headers: { location: 'https://untrusted.example' }, body: '' }),
        async (request) => {
            equal((await request()).status, 502);
        },
    );
});

test('relay network failures produce sanitized errors', async () => {
    await withRelay(
        async () => {
            throw new Error('synthetic-test-token');
        },
        async (request) => {
            const response = await request();
            equal(response.status, 502);
            equal(response.body.includes('synthetic-test-token'), false);
        },
    );
});

test('browser writes remain direct and foreign pagination cannot receive credentials', async () => {
    const app = appFixture();
    await app.api('/me/library', { method: 'PUT', body: JSON.stringify({ uris: [] }) });
    equal(app.calls[0], ['https://api.spotify.com/v1/me/library', 'PUT']);
    await rejects(app.api('https://untrusted.example/v1/me'), /destination refused/);
    equal(app.calls.length, 1);
});

test('relay stops after bounded retries on persistent server errors', async () => {
    let calls = 0;
    await withRelay(
        async () => {
            calls++;
            return { status: 503, headers: {}, body: '{}' };
        },
        async (request) => {
            equal((await request()).status, 503);
            equal(calls, 3);
        },
    );
});

test('quota reason is preserved without exposing arbitrary response data', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => ({
            ...limited('32923'),
            clone: () => ({ json: async () => ({ error: { reason: 'QUOTA_EXCEEDED' } }) }),
        })),
        /QUOTA_EXCEEDED/,
    );
});

test('recording a verified cooldown invalidates an existing preview', async () => {
    const app = appFixture();
    await app.scan();
    const reads = app.calls.length;
    app.element('#retryTime').value = '2099-01-01T12:00';
    app.element('#recordCooldown').onclick();
    await app.execute();
    await app.scan();
    equal(app.calls.length, reads);
    equal(app.element('#execute').disabled, true);
    equal(app.element('#preview').hidden, true);
});

test('saved cooldown prevents startup reads and expires without automatic traffic', async () => {
    const app = appFixture(200, [true, false], Date.now() + 60000);
    await app.init();
    await app.scan();
    equal(app.calls.length, 0);
    equal(app.element('#scan').disabled, true);
    equal(app.element('#cooldownStatus').textContent.includes('no request sent'), true);
    equal(app.element('#account').textContent, '');
    equal(app.element('#account').hidden, true);
    equal(app.element('#accountLabel').textContent.includes('account not checked'), true);
    app.advance(61000);
    equal(app.element('#scan').disabled, false);
    equal(app.element('#cooldownStatus').hidden, true);
    equal(app.calls.length, 0);
});

test('fresh playlist version precedes pages and unchanged contents need only one check', async () => {
    const calls = [];
    const inspect = spotify.createPlaylistCheckpoints();
    const request = async (url) => {
        calls.push(url);
        return url.includes('/items?')
            ? { items: [{ item: { uri: 'a' } }], total: 1, next: null }
            : { snapshot_id: 'v1' };
    };
    await inspect('one', request);
    equal(calls.length, 3);
    equal(calls[0].includes('snapshot_id'), true);
    equal(calls[1].includes('/items?'), true);
    equal(calls[2].includes('snapshot_id'), true);
    await inspect('one', request);
    equal(calls.length, 4);
    equal(calls[3].includes('snapshot_id'), true);
});

test('availability relay probe makes one upstream attempt even for a server error', async () => {
    let calls = 0;
    await withRelay(
        async () => {
            calls++;
            return { status: 503, headers: {}, body: '{}' };
        },
        async (request) => {
            const result = await request(undefined, 'GET', { 'X-Spotify-Read-Probe': '1' });
            equal(result.status, 503);
            equal(result.headers['x-spotify-upstream-requests'], '1');
            equal(calls, 1);
        },
    );
});

test('deliberate unknown-cooldown check recovers only after a successful read', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited(null)),
        { status: 429 },
    );
    let calls = 0;
    const check = async () => {
        calls++;
        return { status: 200, ok: true };
    };
    await rejects(f.queue.probeUnknown(check), { status: 429 });
    equal(calls, 0);
    f.advance(30000);
    await f.queue.probeUnknown(async () => ({ status: 401, ok: false }));
    equal(f.queue.cooldownState().unknown, true);
    await f.queue.probeUnknown(check);
    equal(calls, 1);
    equal(f.reload().cooldownState().paused, false);
});

test('availability check never retries a 429 or bypasses a known future deadline', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited(null)),
        { status: 429 },
    );
    f.advance(30000);
    let calls = 0;
    const check = async () => {
        calls++;
        return limited('2');
    };
    await rejects(f.queue.probeUnknown(check), { status: 429 });
    equal(calls, 1);
    equal(f.queue.cooldownState().unknown, false);
    await rejects(f.queue(check), { status: 429 });
    equal(calls, 1);
    equal(f.sleeps, []);
});

test('failed availability transport leaves unknown cooldown intact', async () => {
    const f = queueFixture();
    await rejects(
        f.queue(async () => limited(null)),
        { status: 429 },
    );
    f.advance(30000);
    await rejects(
        f.queue.probeUnknown(async () => {
            throw new Error('offline');
        }),
        /offline/,
    );
    equal(f.reload().cooldownState().unknown, true);
});

test('unknown saved wait has one read-only recovery and still requires a complete preview', async () => {
    const app = appFixture(200, [true, false], { unknown: true, until: 0 });
    app.refreshPauseUI();
    equal(app.element('#checkAvailability').hidden, false);
    await Promise.all([
        app.element('#checkAvailability').onclick(),
        app.element('#checkAvailability').onclick(),
    ]);
    equal(app.calls, [['/spotify-read/v1/me/playlists?limit=1', 'GET']]);
    equal(app.element('#scan').disabled, false);
    equal(app.element('#execute').disabled, true);
    await app.execute();
    equal(app.calls.length, 1);
    await rejects(app.api('/me/library', { method: 'PUT' }, true), /read-only/);
});

test('Spotify user-playlist next links stay scoped to the authenticated playlist list', async () => {
    await withRelay(
        async (url) => {
            equal(url.pathname, '/v1/me/playlists');
            equal(url.searchParams.get('offset'), '50');
            equal(url.searchParams.get('limit'), '50');
            return { status: 200, headers: {}, body: '{"items":[],"next":null}' };
        },
        async (request) => {
            const response = await request(
                '/spotify-read/v1/users/synthetic-user/playlists?offset=50&limit=50',
            );
            equal(response.status, 200);
        },
    );
    await rejects(
        async () => spotifyReadTarget('https://foreign.example/v1/users/synthetic/playlists'),
        /Unsupported/,
    );
    await rejects(async () => spotifyReadTarget('/v1/users/synthetic'), /Unsupported/);
});

test('relay distinguishes network permissions from quota without revealing raw errors', async () => {
    await withRelay(
        async () => {
            throw Object.assign(new Error('synthetic-test-token private details'), {
                code: 'EACCES',
            });
        },
        async (request) => {
            const response = await request();
            equal(response.status, 502);
            equal(response.body.includes('blocked from connecting'), true);
            equal(response.body.includes('synthetic-test-token'), false);
            equal(response.body.includes('private details'), false);
        },
    );
});

test('changed playlist retries once with fresh pages and preserves duplicate occurrences', async () => {
    let metadata = 0;
    let pages = 0;
    let changes = 0;
    const stored = new Map();
    const inspect = spotify.createPlaylistCheckpoints({
        load: (id) => stored.get(id),
        save: (id, value) => stored.set(id, structuredClone(value)),
    });
    const request = async (url) => {
        if (url.includes('fields=')) return { snapshot_id: ++metadata === 1 ? 'old' : 'new' };
        pages++;
        return {
            items:
                pages === 1
                    ? [{ item: { uri: 'old' } }]
                    : [{ item: { uri: 'new' } }, { item: { uri: 'new' } }],
            total: pages === 1 ? 1 : 2,
            next: null,
        };
    };
    const rows = await inspect('p', request, () => changes++);
    equal(rows.map(spotify.itemUri), ['new', 'new']);
    equal(pages, 2);
    equal(changes, 1);
    equal(stored.get('p').snapshot, 'new');
    const resumed = await spotify.createPlaylistCheckpoints({ load: (id) => stored.get(id) })(
        'p',
        request,
    );
    equal(resumed.map(spotify.itemUri), ['new', 'new']);
    equal(pages, 2);
});

test('changing page total restarts only after a verified version change', async () => {
    let metadata = 0;
    let pages = 0;
    const rows = await spotify.createPlaylistCheckpoints()('p', async (url) => {
        if (url.includes('fields=')) return { snapshot_id: ++metadata === 1 ? 'old' : 'new' };
        pages++;
        if (pages === 1) return {
            items: [{ item: { uri: 'old' } }],
            total: 2,
            next: `${spotify.API_BASE}/playlists/p/items?limit=50&offset=1`,
        };
        return { items: [{ item: { uri: 'new' } }], total: 1, next: null };
    });
    equal(rows.map(spotify.itemUri), ['new']);
    equal(pages, 3);
});

test('persistently changing playlist stays unresolved while other playlists finish', async () => {
    const app = appFixture();
    let snapshots = 0;
    app.setFetch(async (url, options) => {
        if (url.includes('/playlists/p1?fields='))
            return {
                status: 200,
                ok: true,
                headers: { get: () => null },
                json: async () => ({ snapshot_id: String(++snapshots) }),
            };
        return app.originalFetch(url, options);
    });
    await app.scan();
    equal(snapshots, 4);
    equal(
        app.calls.some(([url]) => url.includes('/playlists/p2/items')),
        true,
    );
    equal(app.element('#preview').hidden, false);
    equal(app.element('#execute').disabled, true);
    equal(app.element('#status').textContent.includes('unresolved'), true);
    await app.execute();
    equal(
        app.calls.every(([, method]) => method === 'GET'),
        true,
    );
});

function indexedDBFixture({ failCommit = false, failOpen = false, holdCommit = false } = {}) {
    let records = new Map();
    const pending = [];
    const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const database = {
        close() {},
        createObjectStore() {},
        transaction() {
            const staged = new Map(records);
            let aborted = false;
            const tx = {
                abort() {
                    aborted = true;
                    queueMicrotask(() => tx.onabort?.());
                },
                objectStore: () => ({
                    get(key) {
                        const request = {};
                        queueMicrotask(() => {
                            request.result = copy(records.get(key));
                            request.onsuccess?.();
                        });
                        return request;
                    },
                    put: (value, key) => staged.set(key, copy(value)),
                    delete: (key) => staged.delete(key),
                    openCursor() {
                        const request = {};
                        const keys = [...staged.keys()];
                        function next() {
                            queueMicrotask(() => {
                                const key = keys.shift();
                                request.result = key === undefined ? null : {
                                    key,
                                    delete: () => staged.delete(key),
                                    continue: next,
                                };
                                request.onsuccess?.();
                            });
                        }
                        next();
                        return request;
                    },
                }),
            };
            const commit = () => {
                if (aborted) return;
                if (failCommit) tx.onabort?.();
                else {
                    records = staged;
                    tx.oncomplete?.();
                }
            };
            if (holdCommit) pending.push(commit);
            else setImmediate(commit);
            return tx;
        },
    };
    return {
        indexedDB: {
            open() {
                const request = {};
                queueMicrotask(() => {
                    if (failOpen) request.onerror?.();
                    else {
                        request.result = database;
                        request.onsuccess?.();
                    }
                });
                return request;
            },
        },
        commit: () => pending.splice(0).forEach((commit) => commit()),
    };
}

function sessionFixture() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    };
}

test('durable checkpoint waits for commit and survives a new store and empty session', async () => {
    const fixture = indexedDBFixture({ holdCommit: true });
    const store = createPreviewStore(fixture);
    let settled = false;
    const save = store.save('app:account:p', { rows: ['a', 'a', 'b'] }).then(() => {
        settled = true;
    });
    await new Promise(setImmediate);
    equal(settled, false);
    fixture.commit();
    await save;
    const reloaded = createPreviewStore({ ...fixture, sessionStorage: sessionFixture() });
    const loaded = reloaded.load('app:account:p');
    await new Promise(setImmediate);
    fixture.commit();
    equal(await loaded, { rows: ['a', 'a', 'b'] });
});

test('database abort falls back visibly to session storage without claiming durability', async () => {
    const fixture = indexedDBFixture({ failCommit: true });
    const sessionStorage = sessionFixture();
    const status = [];
    const store = createPreviewStore({ ...fixture, sessionStorage, onStatus: (text) => status.push(text) });
    await store.save('key', { complete: false, rows: ['a', 'a'] });
    equal(status[status.length - 1].startsWith('Session storage only'), true);
    equal(await store.load('key'), { complete: false, rows: ['a', 'a'] });
    equal(status.some((text) => text.includes('including after tab close')), false);
});

test('unavailable stores report memory fallback and do not lose same-tab checkpoint reuse', async () => {
    const status = [];
    const storageError = () => {
        throw new Error('private storage detail');
    };
    const store = createPreviewStore({
        indexedDB: undefined,
        sessionStorage: { getItem: storageError, setItem: storageError },
        onStatus: (text) => status.push(text),
    });
    const inspect = spotify.createPlaylistCheckpoints({ load: store.load, save: store.save });
    let pages = 0;
    const request = async (url) => {
        if (url.includes('fields=')) return { snapshot_id: 'v' };
        pages++;
        return { items: [{ item: { uri: 'a' } }], total: 1, next: null };
    };
    await inspect('p', request);
    await inspect('p', request);
    equal(pages, 1);
    equal(status[status.length - 1].startsWith('Memory only'), true);
    equal(status.some((text) => text.includes('private storage detail')), false);
});

test('session checkpoints are promoted and persistent data remains account and app scoped', async () => {
    const fixture = indexedDBFixture();
    const sessionStorage = sessionFixture();
    sessionStorage.setItem('app1:account1:p', JSON.stringify({ rows: ['old', 'old'] }));
    const store = createPreviewStore({ ...fixture, sessionStorage });
    equal(await store.load('app1:account1:p'), { rows: ['old', 'old'] });
    equal(sessionStorage.getItem('app1:account1:p'), null);
    equal(await store.load('app1:account2:p'), null);
    equal(await store.load('app2:account1:p'), null);
    await store.save('app2:account1:p', { rows: ['other'] });
    await store.clear('app1:');
    equal(await store.load('app1:account1:p'), null);
    equal(await store.load('app2:account1:p'), { rows: ['other'] });
});

test('blocked database opening is bounded and falls back without waiting on Spotify', async () => {
    const status = [];
    const store = createPreviewStore({
        indexedDB: { open: () => ({}) },
        sessionStorage: sessionFixture(),
        timeout: 5,
        onStatus: (text) => status.push(text),
    });
    await store.save('key', { rows: [] });
    equal(status[status.length - 1].startsWith('Session storage only'), true);
});

test('supplied Tape B links produce a read-only preview and expose resume progress', async () => {
    const sourceId = '5DdmY05GZLzvkvbAHrUVYv';
    const destinationId = '3xm40MKtw5Xu7FeBmruQWZ';
    const app = appFixture();
    app.element('#source').value = `https://open.spotify.com/track/${sourceId}?si=05870a053443435e`;
    app.element('#destination').value = `https://open.spotify.com/track/${destinationId}?si=b1368c5afb8e44a0`;
    app.setFetch(async (url, options) => {
        const result = await app.originalFetch(url, options);
        if (url.includes('/items?')) result.json = async () => ({
            items: [sourceId, sourceId, destinationId].map((id) => ({ item: { uri: spotify.trackUri(id) } })),
            total: 3,
            next: null,
        });
        return result;
    });
    await app.scan();
    equal(app.element('#execute').disabled, false);
    equal(app.element('#targetCount').textContent, 2);
    equal(app.element('#sourceName').textContent.includes(sourceId), true);
    equal(app.element('#destinationName').textContent.includes(destinationId), true);
    equal(app.element('#scanProgress').textContent.includes('2 pages fetched'), true);
    await app.scan();
    equal(app.element('#scanProgress').textContent.includes('2 reused'), true);
    equal(app.element('#scanProgress').textContent.includes('0 pages fetched'), true);
    equal(app.calls.some(([url]) => url.endsWith(`/tracks/${sourceId}`)), true);
    equal(app.calls.some(([url]) => url.endsWith(`/tracks/${destinationId}`)), true);
    equal(app.calls.every(([, method]) => method === 'GET'), true);
});

test('scan after cooldown checks account identity before caching and fails closed if absent', async () => {
    const app = appFixture(200, [true, false], Date.now() + 60000);
    await app.init();
    app.advance(61000);
    app.setFetch(async (url, options) => {
        const result = await app.originalFetch(url, options);
        if (url.endsWith('/v1/me')) result.json = async () => ({});
        return result;
    });
    await app.scan();
    equal(app.calls.length, 1);
    equal(app.calls[0][0].endsWith('/v1/me'), true);
    equal(app.element('#execute').disabled, true);
    equal(app.element('#status').textContent.includes('account identity'), true);
});

test('stop keeps the current successful page and resume revalidates before continuing', async () => {
    const app = appFixture();
    let stopped = false;
    app.setFetch(async (url, options) => {
        const result = await app.originalFetch(url, options);
        if (url.includes('/playlists/p1/items?') && !stopped) {
            stopped = true;
            app.element('#stopScan').onclick();
        }
        return result;
    });
    await app.scan();
    equal(app.element('#execute').disabled, true);
    equal(app.calls.some(([url]) => url.includes('/playlists/p2/')), false);
    const pageReads = app.calls.filter(([url]) => url.includes('/playlists/p1/items?')).length;
    await app.scan();
    equal(app.element('#execute').disabled, false);
    equal(app.calls.filter(([url]) => url.includes('/playlists/p1/items?')).length, pageReads);
    equal(app.element('#scanProgress').textContent.includes('1 resumed'), true);
    equal(app.calls.every(([, method]) => method === 'GET'), true);
});

test('581-playlist fixture resumes after reload and discovers a changed formerly negative playlist', async () => {
    const stored = new Map();
    const source = 'spotify:track:5DdmY05GZLzvkvbAHrUVYv';
    const destination = 'spotify:track:3xm40MKtw5Xu7FeBmruQWZ';
    let retry = false;
    const calls = [];
    const events = [];
    const options = {
        load: async (id) => stored.get(id),
        save: async (id, value) => stored.set(id, JSON.parse(JSON.stringify(value))),
        onProgress: (event) => events.push(event),
    };
    const request = async (url) => {
        calls.push(url);
        const id = new URL(url).pathname.split('/')[3];
        if (url.includes('fields=')) return { snapshot_id: retry && id === 'p7' ? 'v2' : 'v1' };
        if (id === 'p400') {
            if (!url.includes('offset=')) return {
                items: [source, source].map((uri) => ({ item: { uri } })),
                total: 3,
                next: `${spotify.API_BASE}/playlists/p400/items?limit=50&offset=2`,
            };
            if (!retry) throw new Error('Synthetic timeout');
            return { items: [{ item: { uri: destination } }], total: 3, next: null };
        }
        const uris = id === 'p7' && !retry ? [destination] : [source, source, destination];
        return { items: uris.map((uri) => ({ item: { uri } })), total: uris.length, next: null };
    };
    const first = spotify.createPlaylistCheckpoints(options);
    await rejects((async () => {
        for (let i = 0; i < 581; i++) await first(`p${i}`, request);
    })(), /Synthetic timeout/);
    equal(stored.get('p400').rows.length, 2);
    equal(stored.get('p400').complete, false);
    retry = true;
    calls.length = 0;
    events.length = 0;
    const afterReload = spotify.createPlaylistCheckpoints(options);
    const contents = new Map();
    for (let i = 0; i < 581; i++) contents.set(`p${i}`, await afterReload(`p${i}`, request));
    equal(events.filter((event) => event.type === 'reused').length, 399);
    equal(events.filter((event) => event.type === 'resumed').length, 1);
    equal(events.filter((event) => event.type === 'changed').length, 1);
    equal(events.filter((event) => event.type === 'page').length, 182);
    equal(calls.length, 945);
    const targets = spotify.findTargets([{ id: 'p7' }, { id: 'p400' }], contents, [{ sourceUri: source, destinationUri: destination }]);
    equal(targets.map((target) => target.sourceCounts[source]), [2, 2]);
    equal(targets.map((target) => target.destinationCounts[destination]), [1, 1]);
});

function savedPreviewFixture(records) {
    return {
        createPreviewStore: () => ({
            load: async (key) => records.has(key) ? JSON.parse(JSON.stringify(records.get(key))) : null,
            save: async (key, value) => records.set(key, JSON.parse(JSON.stringify(value))),
        }),
    };
}

test('immutable account identity is used while legacy profile checkpoints are promoted', async () => {
    const saved = new Map([['spotify_preview:synthetic-client:legacy-profile:p1', {
        snapshot: 'v1',
        rows: [{ item: { uri: 'spotify:track:' + 'a'.repeat(22) } }],
        seen: [`${spotify.API_BASE}/playlists/p1/items?limit=50`],
        next: null,
        total: 1,
        complete: true,
    }]]);
    const app = appFixture(200, [true, false], 0, savedPreviewFixture(saved));
    app.setFetch(async (url, options) => {
        const result = await app.originalFetch(url, options);
        if (url.endsWith('/v1/me')) result.json = async () => ({ id: 'legacy-profile', account_id: 'stable-account' });
        return result;
    });
    await app.scan();
    equal(app.element('#execute').disabled, false);
    equal(saved.has('spotify_preview:synthetic-client:stable-account:p1'), true);
    equal(app.calls.some(([url]) => url.includes('/playlists/p1/items?')), false);
    equal(app.element('#scanProgress').textContent.includes('1 reused'), true);
});

test('saved draft restores inputs after reopen without restoring migration approval', async () => {
    const draft = {
        version: 1,
        kind: 'track',
        source: 'spotify:track:5DdmY05GZLzvkvbAHrUVYv',
        destination: 'spotify:track:3xm40MKtw5Xu7FeBmruQWZ',
    };
    const saved = new Map([['spotify_preview:synthetic-client:synthetic-account:draft', draft]]);
    const app = appFixture(200, [true, false], 0, savedPreviewFixture(saved));
    app.element('#source').value = '';
    app.element('#destination').value = '';
    await app.init();
    equal(app.element('#source').value, draft.source);
    equal(app.element('#destination').value, draft.destination);
    equal(app.element('#scan').textContent, 'Resume preview');
    equal(app.element('#preview').hidden, true);
    equal(app.element('#execute').disabled, true);
    equal(app.calls.length, 1);
    await app.execute();
    equal(app.calls.length, 1);
});

test('editing the selected mapping invalidates an earlier complete preview', async () => {
    const app = appFixture();
    await app.scan();
    const reads = app.calls.length;
    app.element('#destination').value = 'c'.repeat(22);
    app.element('#destination').oninput();
    equal(app.element('#execute').disabled, true);
    equal(app.element('#preview').hidden, true);
    await app.execute();
    equal(app.calls.length, reads);
});

test('saved draft survives a paused startup and resumes after the cooldown expires', async () => {
    const draft = {
        version: 1,
        kind: 'track',
        source: 'spotify:track:5DdmY05GZLzvkvbAHrUVYv',
        destination: 'spotify:track:3xm40MKtw5Xu7FeBmruQWZ',
    };
    const key = 'spotify_preview:synthetic-client:synthetic-account:draft';
    const saved = new Map([[key, draft]]);
    const app = appFixture(200, [true, false], Date.now() + 60000, savedPreviewFixture(saved));
    app.element('#source').value = '';
    app.element('#destination').value = '';
    await app.init();
    equal(app.calls.length, 0);
    app.advance(61000);
    await app.scan();
    equal(app.element('#execute').disabled, false);
    equal(app.element('#source').value, draft.source);
    equal(app.element('#destination').value, draft.destination);
    equal(saved.get(key).source, draft.source);
    equal(saved.get(key).destination, draft.destination);
    equal(saved.get(key).kind, draft.kind);
    equal(saved.get(key).version, draft.version);
    equal(app.calls.every(([, method]) => method === 'GET'), true);
});

test('cached and returned pagination cannot read a different playlist or foreign host', async () => {
    for (const next of [
        'https://foreign.invalid/v1/playlists/p/items?offset=1',
        `${spotify.API_BASE}/playlists/other/items?offset=1`,
    ]) {
        const calls = [];
        const saved = {
            snapshot: 'v',
            rows: [{ item: { uri: 'stale' } }],
            seen: [`${spotify.API_BASE}/playlists/p/items?limit=50`],
            total: 2,
            next,
            complete: false,
        };
        const inspect = spotify.createPlaylistCheckpoints({ load: async () => saved });
        await rejects(inspect('p', async (url) => {
            calls.push(url);
            return url.includes('fields=') ? { snapshot_id: 'v' } : {
                items: [{ item: { uri: 'fresh' } }], total: 2, next,
            };
        }), /pagination/);
        equal(calls.includes(next), false);
        equal(calls.length, 2);
    }
});

let failures = 0;
for (const [n, f] of tests) {
    try {
        await f();
        console.log(`PASS ${n}`);
    } catch (e) {
        failures++;
        console.error(`FAIL ${n}\n${e.stack || e}`);
    }
}
if (failures) process.exitCode = 1;
console.log(`${tests.length - failures}/${tests.length} tests passed.`);
