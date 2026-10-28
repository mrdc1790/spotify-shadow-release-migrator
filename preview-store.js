// Recoverable preview data only. Credentials and confirmed writes never enter this store.
function browserStorage(name) {
    try {
        return globalThis[name];
    } catch {
        return undefined;
    }
}

export function createPreviewStore({
    indexedDB = browserStorage('indexedDB'),
    sessionStorage = browserStorage('sessionStorage'),
    onStatus = () => {},
    timeout = 5000,
} = {}) {
    let connection;
    let unavailable = false;

    function open() {
        if (unavailable || !indexedDB) return Promise.reject(new Error('Storage unavailable'));
        if (!connection) {
            connection = new Promise((resolve, reject) => {
                const request = indexedDB.open('spotify-migrator-preview', 1);
                const timer = setTimeout(() => reject(new Error('Storage busy')), timeout);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore('checkpoints');
                };
                request.onerror = () => {
                    clearTimeout(timer);
                    reject(new Error('Storage unavailable'));
                };
                request.onblocked = () => {
                    clearTimeout(timer);
                    reject(new Error('Storage busy'));
                };
                request.onsuccess = () => {
                    clearTimeout(timer);
                    const db = request.result;
                    if (unavailable) {
                        db.close();
                        return;
                    }
                    db.onversionchange = () => {
                        db.close();
                        unavailable = true;
                    };
                    resolve(db);
                };
            }).catch((error) => {
                unavailable = true;
                throw error;
            });
        }
        return connection;
    }

    async function transaction(mode, operation) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('checkpoints', mode);
            let value;
            const timer = setTimeout(() => {
                try {
                    tx.abort();
                } catch {}
                reject(new Error('Storage busy'));
            }, timeout);
            tx.oncomplete = () => {
                clearTimeout(timer);
                resolve(value);
            };
            tx.onabort = tx.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Storage write failed'));
            };
            try {
                operation(tx.objectStore('checkpoints'), (result) => {
                    value = result;
                });
            } catch (error) {
                clearTimeout(timer);
                tx.abort();
                reject(error);
            }
        });
    }

    function fallbackStatus(mode) {
        onStatus(
            mode === 'session'
                ? 'Session storage only: saved progress may be lost when this tab closes.'
                : 'Memory only: saving preview progress failed. Keep this tab open to resume.',
        );
    }

    const store = {
        async load(key) {
            // A fallback write can be newer than the last successful database write.
            try {
                const saved = sessionStorage.getItem(key);
                if (saved && saved !== 'null') {
                    const value = JSON.parse(saved);
                    await store.save(key, value);
                    return value;
                }
            } catch {}
            try {
                const value = await transaction('readonly', (store, result) => {
                    const request = store.get(key);
                    request.onsuccess = () => result(request.result ?? null);
                });
                onStatus('Preview progress is saved on this browser, including after tab close.');
                if (value !== null) return value;
            } catch {
                fallbackStatus('session');
            }
            try {
                return JSON.parse(sessionStorage.getItem(key) || 'null');
            } catch {
                fallbackStatus('memory');
                return null;
            }
        },
        async save(key, value) {
            try {
                await transaction('readwrite', (store) => {
                    if (value === null) store.delete(key);
                    else store.put(value, key);
                });
                try {
                    sessionStorage.removeItem(key);
                } catch {}
                onStatus('Preview progress is saved on this browser, including after tab close.');
                return;
            } catch {
                // Do not keep retrying a failed database once for every Spotify page.
                unavailable = true;
            }
            try {
                if (value === null) sessionStorage.removeItem(key);
                else sessionStorage.setItem(key, JSON.stringify(value));
                fallbackStatus('session');
            } catch {
                fallbackStatus('memory');
            }
        },
        async clear(prefix) {
            // A failed erase must be reported, not mistaken for a successful disconnect.
            if (!indexedDB) return;
            await transaction('readwrite', (store) => {
                const request = store.openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (String(cursor.key).startsWith(prefix)) cursor.delete();
                    cursor.continue();
                };
            });
        },
    };
    return store;
}
