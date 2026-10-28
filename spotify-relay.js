import https from 'https';

const allowedPath =
    /^\/v1\/(?:me(?:\/playlists|\/library\/contains)?|tracks\/[A-Za-z0-9]{22}|albums\/[A-Za-z0-9]{22}(?:\/tracks)?|playlists\/[A-Za-z0-9]{22}(?:\/items)?)$/;

export function spotifyReadTarget(rawPath) {
    const url = new URL(rawPath, 'https://api.spotify.com');
    const userPlaylistPage = /^\/v1\/users\/[^/]+\/playlists$/.test(url.pathname);
    if (
        url.origin !== 'https://api.spotify.com' ||
        url.username ||
        url.password ||
        url.hash ||
        (!allowedPath.test(url.pathname) && !userPlaylistPage)
    ) {
        throw new Error('Unsupported Spotify read endpoint.');
    }
    // Spotify returns this alias in current-user pagination. Keep reads scoped
    // to the authenticated user instead of allowing arbitrary user lookup.
    if (userPlaylistPage) url.pathname = '/v1/me/playlists';
    for (const [key, value] of url.searchParams) {
        if (
            !['limit', 'offset', 'market', 'fields', 'uris', 'additional_types'].includes(key) ||
            url.searchParams.getAll(key).length !== 1
        ) {
            const name = [
                'locale',
                'ids',
                'limit',
                'offset',
                'market',
                'fields',
                'uris',
                'additional_types',
            ].includes(key)
                ? key
                : 'unrecognized parameter';
            throw new Error(`Unsupported Spotify query (${name}).`);
        }
        if (key === 'fields' && value !== 'snapshot_id') throw new Error('Unsupported fields.');
        if (['limit', 'offset'].includes(key) && !/^\d{1,8}$/.test(value)) {
            throw new Error('Invalid pagination.');
        }
        if (
            key === 'uris' &&
            (value.split(',').length > 40 ||
                value.split(',').some((uri) => !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)))
        ) {
            throw new Error('Invalid membership query.');
        }
    }
    return url;
}

// No redirects, retries, credential persistence, or upstream error-body logging.
export function spotifyRead(url, authorization) {
    return new Promise((resolve, reject) => {
        const request = https.request(
            url,
            {
                method: 'GET',
                headers: { Authorization: authorization, Accept: 'application/json' },
            },
            (response) => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > 8 * 1024 * 1024) {
                        response.destroy(new Error('Spotify response exceeds read limit.'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('error', reject);
                response.on('end', () =>
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        const timer = setTimeout(
            () => request.destroy(new Error('Spotify read timed out.')),
            45000,
        );
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
        request.end();
    });
}

export function createSpotifyReadRelay({
    read = spotifyRead,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    let tail = Promise.resolve();
    let retryAt = 0;
    let nextRead = 0;

    function send(res, status, body, headers = {}) {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Spotify-Relay-Response': '1',
            'X-Spotify-Upstream-Requests': '0',
            ...headers,
        });
        res.end(body);
    }

    return async function relay(req, res) {
        const origin = `http://127.0.0.1:${req.socket.localPort}`;
        if (
            req.headers.host !== new URL(origin).host ||
            (req.headers.origin && req.headers.origin !== origin) ||
            (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
            req.headers['x-spotify-relay'] !== '1'
        ) {
            send(res, 403, JSON.stringify({ error: { message: 'Same-origin read required.' } }));
            return;
        }
        if (req.method !== 'GET') {
            send(res, 405, JSON.stringify({ error: { message: 'The relay is read-only.' } }), {
                Allow: 'GET',
            });
            return;
        }
        const authorization = req.headers.authorization || '';
        if (!/^Bearer [A-Za-z0-9._~+\/-]+=*$/.test(authorization) || authorization.length > 8192) {
            send(res, 401, JSON.stringify({ error: { message: 'Spotify login required.' } }));
            return;
        }
        let target;
        try {
            target = spotifyReadTarget(req.url.slice('/spotify-read'.length));
        } catch (error) {
            const safeMessage =
                /^Unsupported Spotify (read endpoint|query \((locale|ids|limit|offset|market|fields|uris|additional_types|unrecognized parameter)\))\.$|^Unsupported fields\.$|^Invalid (pagination|membership query)\.$/.test(
                    error.message,
                )
                    ? error.message
                    : 'Unsupported Spotify read.';
            send(res, 400, JSON.stringify({ error: { message: safeMessage } }));
            return;
        }
        const queued = tail.then(async () => {
            // One upstream read at a time across every tab using this server.
            if (retryAt > now()) {
                send(
                    res,
                    429,
                    JSON.stringify({
                        error: {
                            status: 429,
                            reason: 'QUOTA_EXCEEDED',
                            message: 'Spotify cooldown remains active; no upstream request made.',
                        },
                    }),
                    { 'Retry-After': String(Math.ceil((retryAt - now()) / 1000)) },
                );
                return;
            }
            if (nextRead > now()) await sleep(nextRead - now());
            let attempts = 0;
            try {
                let response;
                for (let attempt = 0; ; attempt++) {
                    attempts++;
                    response = await read(target, authorization);
                    if (
                        req.headers['x-spotify-read-probe'] === '1' ||
                        ![500, 502, 503, 504].includes(response.status) ||
                        attempt >= 2
                    )
                        break;
                    await sleep(2000 * 2 ** attempt);
                }
                const headers = { 'X-Spotify-Upstream-Requests': String(attempts) };
                if (response.headers['content-encoding']) {
                    headers['Content-Encoding'] = response.headers['content-encoding'];
                }
                const seconds = Number(response.headers['retry-after']);
                if (response.headers['retry-after'] !== undefined) {
                    headers['Retry-After'] = response.headers['retry-after'];
                }
                if (response.status === 429 && Number.isFinite(seconds) && seconds > 0) {
                    retryAt = Math.max(retryAt, now() + Math.ceil(seconds * 1000));
                }
                if (response.status >= 300 && response.status < 400) {
                    send(
                        res,
                        502,
                        JSON.stringify({
                            error: { message: 'Unexpected Spotify redirect refused.' },
                        }),
                        headers,
                    );
                    return;
                }
                send(res, response.status, response.body, headers);
            } catch (error) {
                const code = [
                    'EACCES',
                    'EPERM',
                    'ENOTFOUND',
                    'EAI_AGAIN',
                    'ECONNREFUSED',
                    'ECONNRESET',
                    'ETIMEDOUT',
                    'CERT_HAS_EXPIRED',
                    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                    'DEPTH_ZERO_SELF_SIGNED_CERT',
                ].includes(error.code)
                    ? error.code
                    : 'UNKNOWN';
                send(
                    res,
                    502,
                    JSON.stringify({
                        error: {
                            message:
                                code === 'EACCES' || code === 'EPERM'
                                    ? 'The local server is blocked from connecting to Spotify. Restart it in a terminal with network access. No write was attempted.'
                                    : `Spotify connection failed (${code}). No write was attempted.`,
                        },
                    }),
                    { 'X-Spotify-Upstream-Requests': String(attempts) },
                );
            } finally {
                nextRead = now() + 350;
            }
        });
        tail = queued.catch(() => {});
        await queued;
    };
}
