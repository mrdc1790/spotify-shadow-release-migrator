// Local synthetic browser test. No request is ever forwarded to Spotify.
import http from 'http';
import { readFile } from 'fs/promises';

const source = '5DdmY05GZLzvkvbAHrUVYv';
const destination = '3xm40MKtw5Xu7FeBmruQWZ';
const playlistIds = ['1'.repeat(22), '2'.repeat(22)];
const reads = [];
let interrupted = false;
let writes = 0;
const assets = new Map([
    ['/app.js', 'app.js'],
    ['/spotify.js', 'spotify.js'],
    ['/preview-store.js', 'preview-store.js'],
    ['/styles.css', 'styles.css'],
]);

const setup = `
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options = {}) => {
    const target = new URL(input, location.origin);
    if (target.origin !== location.origin || (options.method || 'GET') !== 'GET')
        throw new Error('Synthetic test: external requests and writes are disabled.');
    return originalFetch(input, options);
};
localStorage.setItem('spotify_client_id', 'synthetic-browser-test');
localStorage.setItem('spotify_scope_version', 'library-v1');
sessionStorage.setItem('access_token', 'synthetic-test-token');
sessionStorage.setItem('expires_at', String(Date.now() + 3600000));
if (!localStorage.getItem('synthetic_initialized')) {
    document.querySelector('#source').value = 'https://open.spotify.com/track/${source}?si=test';
    document.querySelector('#destination').value = 'https://open.spotify.com/track/${destination}?si=test';
    localStorage.setItem('synthetic_initialized', 'true');
}
`;

function json(response, data, status = 200) {
    response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Spotify-Upstream-Requests': '0',
        'X-Spotify-Relay-Response': '1',
    });
    response.end(JSON.stringify(data));
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method !== 'GET') {
            writes++;
            return json(response, { error: { message: 'Synthetic test refuses writes.' } }, 405);
        }
        if (url.pathname === '/smoke-status') return json(response, { interrupted, reads, writes });
        if (url.pathname.startsWith('/spotify-read/')) {
            reads.push(url.pathname + url.search);
            if (url.pathname === '/spotify-read/v1/me')
                return json(response, { id: 'synthetic-account', display_name: 'SYNTHETIC TEST ACCOUNT' });
            if (url.pathname.startsWith('/spotify-read/v1/tracks/'))
                return json(response, { name: 'When I Saw You Again (synthetic metadata)', artists: [{ name: 'Tape B' }] });
            if (url.pathname === '/spotify-read/v1/me/library/contains')
                return json(response, [true, false]);
            if (url.pathname === '/spotify-read/v1/me/playlists')
                return json(response, {
                    items: playlistIds.map((id, index) => ({ id, name: `Synthetic playlist ${index + 1}` })),
                    total: 2,
                    next: null,
                });
            const playlist = playlistIds.find((id) => url.pathname.includes(id));
            if (!playlist) return json(response, {}, 404);
            if (url.searchParams.has('fields')) return json(response, { snapshot_id: 'synthetic-v1' });
            if (playlist === playlistIds[1] && url.searchParams.has('offset') && !interrupted) {
                interrupted = true;
                return json(response, { error: { message: 'Synthetic interrupted read. Close this tab, reopen the same URL, and Resume preview.' } }, 502);
            }
            const uris = playlist === playlistIds[0]
                ? [source, source, destination]
                : url.searchParams.has('offset') ? [destination] : [source, source];
            return json(response, {
                items: uris.map((id) => ({ item: { uri: `spotify:track:${id}` } })),
                total: 3,
                next: playlist === playlistIds[1] && !url.searchParams.has('offset')
                    ? `https://api.spotify.com/v1/playlists/${playlist}/items?limit=50&offset=2`
                    : null,
            });
        }
        let content;
        let type = 'application/javascript';
        if (url.pathname === '/') {
            type = 'text/html';
            content = (await readFile(new URL('./index.html', import.meta.url), 'utf8'))
                .replace('<main>', '<main><p class="warning">SYNTHETIC BROWSER TEST — no Spotify connection or account writes. Build preview, close/reopen this URL, then Resume preview.</p>');
        } else if (url.pathname === '/smoke-setup.js') content = setup;
        else if (assets.has(url.pathname)) {
            content = await readFile(new URL(assets.get(url.pathname), import.meta.url), 'utf8');
            if (url.pathname === '/app.js') content = `import './smoke-setup.js';\n${content}`;
            if (url.pathname === '/styles.css') type = 'text/css';
        } else return json(response, {}, 404);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(content);
    } catch {
        json(response, { error: { message: 'Synthetic fixture failed.' } }, 500);
    }
});

server.listen(0, '127.0.0.1', () => {
    console.log(`Synthetic test only: http://127.0.0.1:${server.address().port}/`);
    console.log('No Spotify connection. Build preview, close/reopen the tab, then Resume preview.');
});
