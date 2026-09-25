import {
    buildAuthorizationUrl,
    buildAlbumReplacements,
    findLibraryTarget,
    finishLibraryMigration,
    parseSpotifyInput,
    prepareLibraryMigration,
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
