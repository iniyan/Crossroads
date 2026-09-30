// AutoEq index + profile fetching with an offline cache in the blob store (IndexedDB).
//
//   'autoeqIndex'    { fetchedAt, entries: [[name, path, source, rig], ...] }   (~4000 rows, compact tuples)
//   'autoeqProfiles' { [path]: { name, text, fetchedAt } }                      (raw ParametricEQ.txt)
//
// The index is only fetched on demand (first search or explicit refresh) and re-used for
// INDEX_MAX_AGE_MS; profiles never expire (AutoEq results rarely change, and a cached profile
// keeps working offline). Electron's CSP connect-src allows AUTOEQ_HOST for this.
//
// Both blobs are large and rebuildable, which is what src/services/blobStore.js is for; the
// small `dsp` settings stay in the platform store. An earlier build kept the two blobs in
// the platform store under the same keys: they are moved over once (migrateLegacyCache) and
// the platform keys are cleared, so the store never carries them again.

import Platform from '../services/PlatformService';
import { getBlob, setBlob } from '../services/blobStore';
import { AUTOEQ_INDEX_URL, parseAutoEqIndex, parseParametricEq, profileUrl, formOf } from './autoeq.js';

export const INDEX_STORE_KEY = 'autoeqIndex';
export const PROFILES_STORE_KEY = 'autoeqProfiles';
export const INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_PROFILES = 200;

const inflate = (rows) => (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string')
    .map(([name, path, source, rig]) => ({ name, path, source: source || '', rig: rig || null, form: formOf(path) }));

const deflate = (entries) => entries.map(e => [e.name, e.path, e.source, e.rig]);

let migration = null;

/**
 * One-time move of the cache from the platform store to the blob store. Each legacy key is
 * read once; a value found there is copied (unless the blob store already has one) and the
 * platform key is overwritten with null. Failures only log: the cache is rebuildable.
 */
export const migrateLegacyCache = ({ platform = Platform, blobs = { getBlob, setBlob } } = {}) => {
    if (!migration) {
        migration = (async () => {
            for (const key of [INDEX_STORE_KEY, PROFILES_STORE_KEY]) {
                let legacy = null;
                try { legacy = await platform.getStore(key); } catch (e) { console.warn(`AutoEq cache: could not read legacy ${key}`, e); continue; }
                if (legacy === null || legacy === undefined) continue;
                try {
                    if (legacy && typeof legacy === 'object' && (await blobs.getBlob(key)) === undefined) await blobs.setBlob(key, legacy);
                    await platform.setStore(key, null);
                } catch (e) {
                    console.warn(`AutoEq cache: could not migrate ${key}`, e);
                }
            }
        })();
    }
    return migration;
};

/** Test hook: forget that the migration ran (module state). */
export const resetAutoEqStoreForTests = () => { migration = null; indexPromise = null; };

const readBlob = async (key) => {
    await migrateLegacyCache();
    try { return (await getBlob(key)) ?? null; } catch (e) { console.warn(`Failed to read ${key}`, e); return null; }
};
const writeBlob = (key, value) =>
    Promise.resolve(setBlob(key, value)).catch(e => console.warn(`Failed to save ${key}`, e));

let indexPromise = null;

/**
 * The parsed index: from the cache when fresh (or when offline), else fetched.
 * @returns {Promise<{ entries: Array, fetchedAt: number, fromCache: boolean }>}
 */
export const loadAutoEqIndex = async ({ force = false, fetchImpl = fetch } = {}) => {
    if (!force && indexPromise) return indexPromise;
    indexPromise = (async () => {
        const cached = await readBlob(INDEX_STORE_KEY);
        const cachedEntries = cached ? inflate(cached.entries) : [];
        const fresh = cached && Number.isFinite(cached.fetchedAt) && Date.now() - cached.fetchedAt < INDEX_MAX_AGE_MS;
        if (!force && cachedEntries.length > 0 && fresh) return { entries: cachedEntries, fetchedAt: cached.fetchedAt, fromCache: true };
        try {
            const response = await fetchImpl(AUTOEQ_INDEX_URL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const entries = parseAutoEqIndex(await response.text());
            if (entries.length === 0) throw new Error('Index format not recognised');
            const fetchedAt = Date.now();
            await writeBlob(INDEX_STORE_KEY, { fetchedAt, entries: deflate(entries) });
            return { entries, fetchedAt, fromCache: false };
        } catch (e) {
            if (cachedEntries.length > 0) {
                console.warn('AutoEq index refresh failed; using cached copy', e);
                return { entries: cachedEntries, fetchedAt: cached.fetchedAt || 0, fromCache: true, error: e };
            }
            throw e;
        }
    })();
    indexPromise.catch(() => { indexPromise = null; });
    return indexPromise;
};

/**
 * The parsed ParametricEQ profile for an index entry, cached by path.
 * @returns {Promise<{ entry, preamp, filters, fromCache: boolean }>}
 */
export const loadAutoEqProfile = async (entry, { fetchImpl = fetch } = {}) => {
    const profiles = (await readBlob(PROFILES_STORE_KEY)) || {};
    const cached = profiles && typeof profiles === 'object' ? profiles[entry.path] : null;
    if (cached && typeof cached.text === 'string') {
        return { entry, ...parseParametricEq(cached.text), fromCache: true };
    }
    const response = await fetchImpl(profileUrl(entry));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parsed = parseParametricEq(text);
    if (parsed.filters.length === 0) throw new Error('No filters in profile');

    const next = { ...(profiles && typeof profiles === 'object' ? profiles : {}) };
    next[entry.path] = { name: entry.name, text, fetchedAt: Date.now() };
    const keys = Object.keys(next);
    if (keys.length > MAX_CACHED_PROFILES) {
        keys.sort((a, b) => (next[a].fetchedAt || 0) - (next[b].fetchedAt || 0));
        keys.slice(0, keys.length - MAX_CACHED_PROFILES).forEach(key => { delete next[key]; });
    }
    await writeBlob(PROFILES_STORE_KEY, next);
    return { entry, ...parsed, fromCache: false };
};

/** Paths of the profiles available offline. */
export const cachedProfilePaths = async () => {
    const profiles = await readBlob(PROFILES_STORE_KEY);
    return profiles && typeof profiles === 'object' ? Object.keys(profiles) : [];
};
