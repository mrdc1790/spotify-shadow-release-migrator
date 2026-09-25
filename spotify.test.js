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

test('missing retry header stops immediately with an explicit local backoff', async () => {
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
        /local safety backoff/,
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

function appFixture(playlistStatus = 200, membership = [true, false]) {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id))
            elements.set(id, {
                value: '',
                disabled: false,
                hidden: false,
                textContent: '',
                addEventListener() {},
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
        URL,
        URLSearchParams,
        location: { origin: 'http://localhost' },
        localStorage: { getItem: () => null, setItem() {} },
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
                    items: [{ item: { uri: 'spotify:track:' + 'a'.repeat(22) } }],
                    next: null,
                };
            }
            return {
                status,
                ok: status === 200,
                headers: { get: () => '24000' },
                json: async () => data,
            };
        },
    };
    // Run the real controller against a minimal DOM and mocked HTTP; no Spotify access.
    const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
        .replace(/^import \{([\s\S]*?)\} from '.\/spotify.js';/, 'const {$1} = spotify;')
        .replace(/init\(\);\s*$/, '')
        .replace('createSpotifyQueue({', 'createSpotifyQueue({ minimumInterval: 0,');
    runInNewContext(
        source + '\nstate.token = "test"; globalThis.controller = { scan, execute };',
        context,
    );
    return {
        ...context.controller,
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
    equal(app.element('#scan').disabled, false);
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
    equal(app.element('#scan').disabled, false);
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
        app.calls.slice(0, 2).map(([url]) => new URL(url).pathname),
        ['/v1/tracks/' + 'a'.repeat(22), '/v1/tracks/' + 'b'.repeat(22)],
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
    equal(message.includes('local safety backoff'), true);
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
