// In-memory index of analysis results with per-entry persistence bookkeeping. Entries are
// keyed by path and validated by file size, mtime and ANALYZER_VERSION; a FLAC whose
// STREAMINFO MD5 matches an entry can adopt it (adopt()), so re-tagging (new mtime/size,
// same audio) or moving a file keeps its result.
//
// Persistence is the caller's job (qualityStore.js writes one blob per entry, key
// BLOB_PREFIX + path): put/adopt/remove/prune only record what changed, takeDirty() hands
// the pending writes and deletes over. Nothing here allocates on a lookup: expanded results
// are memoised per entry object, so React can call lookup() on every render.
//
// Each entry is ~350 bytes (a 128-point spectrum packed as base64 uint8 dB values); the
// index is capped at MAX_ENTRIES with least-recently-written eviction.

import { ANALYZER_VERSION, VERDICTS } from './verdict.js';

export const CACHE_KEY = 'qualityAnalysis';   // legacy settings-store key, migrated once then cleared
export const BLOB_PREFIX = 'qa:';
export const CACHE_FORMAT = 1;                 // of the legacy document ({ f, e: { path: entry } })
export const CACHED_SPECTRUM_POINTS = 128;
export const MAX_ENTRIES = 50000;
const DB_OFFSET = 200; // stored value = round(dB + 200), clamped to 0..255

const REASONS = ['', 'too-quiet', 'no-hf-content', 'inconsistent-cutoff', 'weak-shelf', 'cut-near-nyquist', 'hf-cut',
    'shelf', 'no-shelf', 'cut-at-nyquist', 'lossy', 'format', 'codec', 'provisional'];

const b64encode = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
};
const b64decode = (str) => {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};

/** Packs a dB spectrum into `points` buckets of one byte each. */
export function packSpectrum(db, points = CACHED_SPECTRUM_POINTS) {
    if (!db || db.length === 0) return null;
    const out = new Uint8Array(points);
    for (let b = 0; b < points; b++) {
        const from = Math.floor(b * db.length / points);
        const to = Math.max(from + 1, Math.floor((b + 1) * db.length / points));
        let sum = 0;
        for (let i = from; i < to; i++) sum += db[i];
        out[b] = Math.max(0, Math.min(255, Math.round(sum / (to - from) + DB_OFFSET)));
    }
    return b64encode(out);
}

export function unpackSpectrum(packed) {
    if (!packed) return null;
    const bytes = b64decode(packed);
    return Array.from(bytes, (v) => v - DB_OFFSET);
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** Result -> compact entry (the path is the key, so it is not repeated inside). */
export function compactEntry(song, result) {
    const ev = result.evidence || {};
    return {
        ver: result.version || ANALYZER_VERSION,
        sz: num(song.fileSize),
        mt: num(song.mtime),
        md5: result.md5 || song.md5 || null,
        at: result.analyzedAt || Date.now(),
        v: Math.max(0, VERDICTS.indexOf(result.verdict)),
        c: Math.round((result.confidence || 0) * 100),
        fl: (result.flags || []).map((f) => VERDICTS.indexOf(f)).filter((i) => i >= 0),
        r: Math.max(0, REASONS.indexOf(result.reason || '')),
        sr: num(result.sampleRate),
        b: num(result.bitsPerSample),
        eb: num(result.effectiveBitDepth),
        bw: num(result.effectiveBandwidthHz),
        k: num(result.cutoffHz),
        ks: num(result.cutoffStepDb),
        kc: num(result.cutoffConsistency),
        w: [result.windowsAnalyzed || 0, result.windowsInformative || 0],
        z: ev.bitDepth && Number.isFinite(ev.bitDepth.lowByteZeroFraction) ? Math.round(ev.bitDepth.lowByteZeroFraction * 1000) : null,
        sp: ev.spectrum ? packSpectrum(ev.spectrum.db) : null
    };
}

const expandedCache = new WeakMap(); // entry object -> expanded result

/** Compact entry -> result (evidence limited to what was cached). Memoised per entry object. */
export function expandEntry(entry) {
    const hit = expandedCache.get(entry);
    if (hit) return hit;
    const spectrum = entry.sp ? { db: unpackSpectrum(entry.sp), nyquistHz: (entry.sr || 0) / 2 } : null;
    const result = {
        version: entry.ver,
        analyzedAt: entry.at,
        verdict: VERDICTS[entry.v] || 'inconclusive',
        confidence: (entry.c || 0) / 100,
        flags: (entry.fl || []).map((i) => VERDICTS[i]).filter(Boolean),
        reason: REASONS[entry.r] || null,
        sampleRate: entry.sr,
        bitsPerSample: entry.b,
        md5: entry.md5 || null,
        effectiveBitDepth: entry.eb,
        effectiveBandwidthHz: entry.bw,
        cutoffHz: entry.k,
        cutoffStepDb: entry.ks,
        cutoffConsistency: entry.kc,
        windowsAnalyzed: entry.w ? entry.w[0] : 0,
        windowsInformative: entry.w ? entry.w[1] : 0,
        evidence: {
            spectrum,
            shelf: null,
            windows: null,
            bitDepth: entry.b ? {
                containerBits: entry.b, effectiveBits: entry.eb,
                lowByteZeroFraction: entry.z === null || entry.z === undefined ? null : entry.z / 1000,
                trailingZeroHistogram: null
            } : null
        },
        fromCache: true
    };
    expandedCache.set(entry, result);
    return result;
}

export function createCache() {
    return {
        entries: new Map(),   // path -> entry, in write order (oldest first) for eviction
        byMd5: new Map(),     // md5 -> path
        dirty: new Set(),     // paths whose entry must be written
        deleted: new Set()    // paths whose blob must be deleted
    };
}

export const isCurrent = (entry) => !!entry && entry.ver === ANALYZER_VERSION;
const matchesFile = (entry, song) => entry.sz === num(song.fileSize) && entry.mt === num(song.mtime);

function index(cache, path, entry) {
    cache.entries.delete(path); // re-insert so the Map order reflects last write
    cache.entries.set(path, entry);
    if (entry.md5) cache.byMd5.set(entry.md5, path);
}

/**
 * Adds stored entries. Existing entries win (results produced before an async load resolves
 * are never replaced). Entries from another analyzer version are not imported; their paths
 * are returned as `stale` so the caller can delete their blobs.
 * @param {Iterable<[string, object]>} pairs
 * @returns {{ imported: number, stale: string[] }}
 */
export function importEntries(cache, pairs) {
    let imported = 0;
    const stale = [];
    for (const [path, entry] of pairs) {
        if (!path || !entry || typeof entry !== 'object') continue;
        if (!isCurrent(entry)) { stale.push(path); continue; }
        if (cache.entries.has(path)) continue;
        index(cache, path, entry);
        imported++;
    }
    evict(cache);
    return { imported, stale };
}

/** [path, entry] pairs from the legacy single-document format ({ f: 1, e: { path: entry } }). */
export function legacyEntries(stored) {
    if (!stored || typeof stored !== 'object' || stored.f !== CACHE_FORMAT || !stored.e || typeof stored.e !== 'object') return [];
    return Object.entries(stored.e);
}

/**
 * The cached result for `song` under its own path, validated by size + mtime + analyzer
 * version; null on a miss. Pure: safe to call during render.
 */
export function lookup(cache, song) {
    if (!song || !song.path) return null;
    const entry = cache.entries.get(song.path);
    return isCurrent(entry) && matchesFile(entry, song) ? expandEntry(entry) : null;
}

/**
 * When `song` has no valid entry of its own but its FLAC MD5 matches another entry (same
 * audio under a new path, or after a tag edit), copies that entry to the song's path.
 * @returns {boolean} whether an entry was adopted
 */
export function adopt(cache, song) {
    if (!song || !song.path || !song.md5 || lookup(cache, song)) return false;
    const otherPath = cache.byMd5.get(song.md5);
    const other = otherPath === undefined ? undefined : cache.entries.get(otherPath);
    if (!isCurrent(other) || other.md5 !== song.md5) return false;
    index(cache, song.path, { ...other, sz: num(song.fileSize), mt: num(song.mtime) });
    cache.dirty.add(song.path);
    cache.deleted.delete(song.path);
    evict(cache);
    return true;
}

export function put(cache, song, result) {
    if (!song || !song.path || !result) return;
    index(cache, song.path, compactEntry(song, result));
    cache.dirty.add(song.path);
    cache.deleted.delete(song.path);
    evict(cache);
}

export function remove(cache, path) {
    const entry = cache.entries.get(path);
    if (!entry) return false;
    cache.entries.delete(path);
    if (entry.md5 && cache.byMd5.get(entry.md5) === path) cache.byMd5.delete(entry.md5);
    cache.dirty.delete(path);
    cache.deleted.add(path);
    return true;
}

/** Least-recently-written eviction down to MAX_ENTRIES. */
function evict(cache) {
    while (cache.entries.size > MAX_ENTRIES) remove(cache, cache.entries.keys().next().value);
}

/**
 * Drops entries whose file is no longer in the library. Only entries whose path starts with
 * `prefix` (the current music root) are candidates, so results for other folders survive a
 * root switch. The caller decides when the library is complete enough to prune.
 * @returns {number} entries removed
 */
export function prune(cache, livePaths, { prefix = '' } = {}) {
    if (!livePaths || livePaths.size === 0) return 0;
    let removed = 0;
    for (const path of Array.from(cache.entries.keys())) {
        if (prefix && !path.startsWith(prefix)) continue;
        if (!livePaths.has(path)) { remove(cache, path); removed++; }
    }
    return removed;
}

/** Pending persistence work, cleared on return: { writes: [[key, entry]], deletes: [key] }. */
export function takeDirty(cache) {
    const writes = [];
    for (const path of cache.dirty) {
        const entry = cache.entries.get(path);
        if (entry) writes.push([BLOB_PREFIX + path, entry]);
    }
    const deletes = Array.from(cache.deleted, (path) => BLOB_PREFIX + path);
    cache.dirty.clear();
    cache.deleted.clear();
    return { writes, deletes };
}

/** Marks everything dirty again (a flush failed). */
export function restoreDirty(cache, { writes, deletes }) {
    for (const [key] of writes) {
        const path = key.slice(BLOB_PREFIX.length);
        if (cache.entries.has(path)) cache.dirty.add(path);
    }
    for (const key of deletes) cache.deleted.add(key.slice(BLOB_PREFIX.length));
}

export const hasPending = (cache) => cache.dirty.size > 0 || cache.deleted.size > 0;
