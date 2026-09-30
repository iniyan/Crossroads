// Small key/value store on IndexedDB for data that is too big or too frequently written for
// the settings store (Platform.getStore/setStore rewrite the whole JSON document on every
// key write: electron-store on desktop, SharedPreferences on Android). One IndexedDB write
// touches one record.
//
// DB 'crossroads-blobs', object store 'blobs', string keys, structured-clonable values.
// Falls back to an in-memory Map when IndexedDB is unavailable (Node tests, a WebView that
// refuses storage), so callers never have to special-case it.

export const DB_NAME = 'crossroads-blobs';
export const STORE_NAME = 'blobs';
const DB_VERSION = 1;

let dbPromise = null;
let memory = null;   // Map fallback
let warned = false;

const idb = () => (typeof indexedDB !== 'undefined' ? indexedDB : null);

// The memory fallback mimics IndexedDB's structured clone so callers cannot mutate a stored
// value through the reference they wrote or read.
const clone = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
};

function useMemory(reason) {
    if (!memory) {
        memory = new Map();
        if (!warned) {
            warned = true;
            console.warn('blobStore: IndexedDB is unavailable, keeping blobs in memory for this session', reason && reason.message ? reason.message : reason);
        }
    }
    return memory;
}

/** True while the in-memory fallback is in use (diagnostics / tests). */
export const isBlobStoreInMemory = () => memory !== null;

function openDb() {
    if (dbPromise) return dbPromise;
    const factory = idb();
    if (!factory) { useMemory(null); dbPromise = Promise.resolve(null); return dbPromise; }
    dbPromise = new Promise((resolve) => {
        let request;
        try {
            request = factory.open(DB_NAME, DB_VERSION);
        } catch (e) {
            useMemory(e);
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        request.onerror = () => { useMemory(request.error); resolve(null); };
        request.onblocked = () => { useMemory(new Error('blocked')); resolve(null); };
    });
    return dbPromise;
}

/** Runs `fn(store)` in one transaction; resolves with fn's request result (or the array of results). */
async function withStore(mode, fn) {
    const db = await openDb();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = db.transaction(STORE_NAME, mode);
        } catch (e) {
            reject(e);
            return;
        }
        let out;
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error || new Error('blob store transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('blob store transaction aborted'));
        out = fn(tx.objectStore(STORE_NAME));
    });
}

const requestValue = (req, sink) => { req.onsuccess = () => sink(req.result); };
const keyRange = (prefix) => (prefix ? IDBKeyRange.bound(prefix, prefix + '￿', false, false) : null);

/** @returns {Promise<any|undefined>} */
export async function getBlob(key) {
    let value;
    await withStore('readonly', (store) => {
        if (!store) { value = clone(memory.get(key)); return; }
        requestValue(store.get(key), (v) => { value = v; });
    });
    return value;
}

export async function setBlob(key, value) {
    await withStore('readwrite', (store) => {
        if (!store) { memory.set(key, clone(value)); return; }
        store.put(value, key);
    });
}

export async function deleteBlob(key) {
    await withStore('readwrite', (store) => {
        if (!store) { memory.delete(key); return; }
        store.delete(key);
    });
}

// ---- Extras (bulk and prefixed access) ----------------------------------------------------

/** All keys, or those starting with `prefix`. */
export async function getAllKeys(prefix = '') {
    let keys = [];
    await withStore('readonly', (store) => {
        if (!store) { keys = Array.from(memory.keys()).filter((k) => k.startsWith(prefix)); return; }
        requestValue(store.getAllKeys(keyRange(prefix)), (v) => { keys = v; });
    });
    return keys;
}

/** Map of key -> value for every key starting with `prefix` (one transaction). */
export async function getAllBlobs(prefix = '') {
    const out = new Map();
    await withStore('readonly', (store) => {
        if (!store) {
            for (const [k, v] of memory) if (k.startsWith(prefix)) out.set(k, clone(v));
            return;
        }
        let keys = null;
        let values = null;
        const done = () => {
            if (!keys || !values) return;
            for (let i = 0; i < keys.length; i++) out.set(keys[i], values[i]);
        };
        requestValue(store.getAllKeys(keyRange(prefix)), (v) => { keys = v; done(); });
        requestValue(store.getAll(keyRange(prefix)), (v) => { values = v; done(); });
    });
    return out;
}

/** Writes every [key, value] pair in one transaction. */
export async function setBlobs(entries) {
    const list = Array.from(entries);
    if (list.length === 0) return;
    await withStore('readwrite', (store) => {
        for (const [key, value] of list) {
            if (!store) memory.set(key, clone(value));
            else store.put(value, key);
        }
    });
}

/** Deletes every key in one transaction. */
export async function deleteBlobs(keys) {
    const list = Array.from(keys);
    if (list.length === 0) return;
    await withStore('readwrite', (store) => {
        for (const key of list) {
            if (!store) memory.delete(key);
            else store.delete(key);
        }
    });
}

/** Test hook: forget the open connection / memory map. */
export function _resetBlobStoreForTests() {
    dbPromise = null;
    memory = null;
    warned = false;
}
