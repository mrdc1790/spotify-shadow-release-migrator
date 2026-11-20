import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSpotifyReadRelay } from './spotify-relay.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 5173);
const files = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/app.js', 'app.js'],
    ['/spotify.js', 'spotify.js'],
    ['/preview-store.js', 'preview-store.js'],
    ['/styles.css', 'styles.css'],
]);
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};
const relaySpotifyRead = createSpotifyReadRelay();
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/spotify-read/')) {
        relaySpotifyRead(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
            res.end();
        });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
    }
    let pathname;
    try {
        pathname = new URL(req.url, 'http://' + host).pathname;
    } catch {
        res.writeHead(400);
        return res.end('Invalid request URL');
    }
    const file = files.get(pathname);
    if (!file) {
        res.writeHead(404);
        return res.end('Not found');
    }
    fs.readFile(path.join(root, file), (error, data) => {
        if (error) {
            res.writeHead(500);
            return res.end('Load error');
        }
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)],
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
                "default-src 'self'; connect-src 'self' https://api.spotify.com https://accounts.spotify.com; img-src 'self' https://i.scdn.co data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(req.method === 'HEAD' ? undefined : data);
    });
});
server.on('error', (error) => {
    console.error(
        error.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. If the migrator is already running, stop that server with Ctrl+C before restarting it.`
            : error.code === 'EACCES'
              ? `This computer refused localhost port ${port}. On Windows, check reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp. Choose an available PORT and register that exact localhost redirect URI in your Spotify app.`
            : `Local server failed (${error.code || 'unknown error'}).`,
    );
    process.exitCode = 1;
});
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be an integer from 0 to 65535.');
    process.exitCode = 1;
} else {
    server.listen(port, host, () => {
        const { port: listeningPort } = server.address();
        console.log(`Spotify Playlist Migrator: http://${host}:${listeningPort}`);
        console.log(`Redirect URI: http://${host}:${listeningPort}/`);
    });
}
