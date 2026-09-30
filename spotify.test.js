import http from 'http';
import { createSpotifyReadRelay, spotifyReadTarget } from './spotify-relay.js';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import * as spotify from './spotify.js';
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

function appFixture(playlistStatus = 200, membership = [true, false], savedUntil = 0) {
    let clock = Date.now();
    let timer;
    const storage = new Map([
        ['spotify_cooldown:', JSON.stringify(savedUntil)],
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
            if (/\/v1\/tracks\/[^/]+$/.test(url))
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
        setFetch: (fetch) => {
            context.fetch = fetch;
        },
    };
}

test('preview stops at rate-limited playlist, blocks confirmation, and makes no writes', async () => {
    const app = appFixture(429);
    await Promise.all([app.scan(), app.scan()]);
    await app.execute();
    equal(app.calls.length, 5);
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
    equal(app.calls.length, 4);
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
        app.calls.slice(0, 2).map(([url]) => new URL(url, 'http://localhost').pathname),
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
    app.setFetch(async () => {
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

test('playlist discovery snapshot saves a read while final verification remains', async () => {
    const calls = [];
    const inspect = spotify.createPlaylistCheckpoints();
    const request = async (url) => {
        calls.push(url);
        return url.includes('/items?')
            ? { items: [{ item: { uri: 'a' } }], total: 1, next: null }
            : { snapshot_id: 'v1' };
    };
    await inspect('one', request, 'v1');
    equal(calls.length, 2);
    equal(calls[0].includes('/items?'), true);
    await inspect('one', request, 'v1');
    equal(calls.length, 3);
    equal(calls[2].includes('snapshot_id'), true);
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
