// IndexedDB-backed key/value store for LARGE, rebuildable data (offline caches, indexes),
// as opposed to the small settings that live in the platform store (electron-store on
// desktop, Capacitor Preferences on Android). Values are stored by structured clone, so
// plain objects, arrays, typed arrays and Blobs all work.
//
// Self-contained and dependency-free on purpose: this file is shared verbatim between
// branches. It works wherever IndexedDB does (Android WebView on https://localhost, Electron
// on a standard+secure custom scheme, ordinary browsers). When IndexedDB is unavailable (or
// cannot be opened: private mode, blocked storage) it degrades to an in-memory Map for the
// session and logs that once; nothing stored here may be the only copy of anything.

const DB_NAME = 'crossroads-blobs';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

let dbPromise = null;
let memory = null;   // the fallback store, once IndexedDB has failed to open

const clone = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
};

const useMemory = (reason) => {
    if (!memory) {
        memory = new Map();
        console.warn('blobStore: IndexedDB is unavailable, keeping blobs in memory for this session', reason && reason.message ? reason.message : reason);
    }
    return memory;
};

const openDatabase = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        let indexedDb = null;
        try { indexedDb = globalThis.indexedDB || null; } catch (e) { reject(e); return; }
        if (!indexedDb) { reject(new Error('indexedDB is not defined')); return; }
        let request;
        try {
            request = indexedDb.open(DB_NAME, DB_VERSION);
        } catch (e) {
            reject(e);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
            const db = request.result;
            // Another tab/window upgrading the schema: let go of this connection and reopen lazily.
            db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } if (dbPromise === promise) dbPromise = null; };
            db.onclose = () => { if (dbPromise === promise) dbPromise = null; };
            resolve(db);
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    const promise = dbPromise;
    promise.catch(() => { if (dbPromise === promise) dbPromise = null; });
    return promise;
};

/**
 * Runs `operation(objectStore)` inside a transaction of `mode` and resolves with the
 * request's result. Falls back to the in-memory Map when IndexedDB cannot be opened.
 */
const run = async (mode, operation, memoryOperation) => {
    if (!memory) {
        let db;
        try {
            db = await openDatabase();
        } catch (e) {
            useMemory(e);
        }
        if (db) {
            return new Promise((resolve, reject) => {
                let request;
                try {
                    const tx = db.transaction(STORE_NAME, mode);
                    request = operation(tx.objectStore(STORE_NAME));
                    tx.oncomplete = () => resolve(request ? request.result : undefined);
                    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
                    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
                } catch (e) {
                    reject(e);
                }
            });
        }
    }
    return memoryOperation(memory);
};

/** The stored value for `key`, or undefined. */
export const getBlob = (key) => run('readonly',
    store => store.get(key),
    map => clone(map.get(key)));

/** Stores `value` (structured clone) under `key`. Resolves when the write is durable. */
export const setBlob = (key, value) => run('readwrite',
    store => store.put(value, key),
    map => { map.set(key, clone(value)); }).then(() => undefined);

/** Removes `key`; resolves whether or not it existed. */
export const deleteBlob = (key) => run('readwrite',
    store => store.delete(key),
    map => { map.delete(key); }).then(() => undefined);

/** True while the in-memory fallback is in use (diagnostics / tests). */
export const isBlobStoreInMemory = () => memory !== null;
