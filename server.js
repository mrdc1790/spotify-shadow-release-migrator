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
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
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
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
                "default-src 'self'; connect-src 'self' https://api.spotify.com https://accounts.spotify.com; img-src 'self' https://i.scdn.co data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(data);
    });
});
server.on('error', (error) => {
    console.error(
        error.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. If the migrator is already running, stop that server with Ctrl+C before restarting it.`
            : `Local server failed (${error.code || 'unknown error'}).`,
    );
    process.exitCode = 1;
});
server.listen(port, host, () => {
    console.log(`Spotify Playlist Migrator: http://${host}:${port}`);
    console.log(`Redirect URI: http://${host}:${port}/`);
});
