// App-side state for the quality analyser (#28): the persistent result cache, the
// background queue with its Web Worker, the details panel selection, and a tiny
// subscription API for React (see components/quality/QualityProvider.jsx). Module-level so
// it survives view changes and the mini player.
//
// Two subscription channels keep re-renders cheap: `subscribe` fires when results, the
// library, the panel or the queue's job list change (a few times per track at most);
// `subscribeProgress` fires on every per-window progress tick and is only used by the
// progress toast and the panel's "Passage n of m" line.
//
// Results persist one blob per entry in IndexedDB (services/blobStore.js, key 'qa:' + path)
// so a new result writes ~0.5 KB, not the whole cache. Reads (getResult / summary) never
// mutate anything: MD5 adoption and pruning run when the library is set, and pending writes
// are flushed on a timer, when the queue goes idle and when the page is hidden.

import Platform from '../services/PlatformService';
import { getAllBlobs, setBlobs, deleteBlobs } from '../services/blobStore';
import {
    CACHE_KEY, BLOB_PREFIX, createCache, lookup, adopt, put, prune, importEntries, legacyEntries,
    takeDirty, restoreDirty, hasPending
} from './cache.js';
import { createAnalysisQueue } from './queue.js';
import { createFetchByteSource } from './byteSource.js';
import { isSuspicious } from './verdict.js';

const SAVE_DELAY_MS = 3000;
const DETAILS_LIMIT = 40; // full results (with per-window evidence) kept in memory this session
const SUPPORTED_FORMATS = new Set(['FLAC', 'WAV', 'AIFF', 'AIF']);

/** 'ok' | 'lossy' | 'provisional' | 'codec' — whether a song can be analysed. */
export function eligibility(song) {
    if (!song || !song.path) return 'codec';
    if (song.provisional) return 'provisional';
    if (song.lossless === false) return 'lossy';
    const format = String(song.format || '').toUpperCase();
    const codec = String(song.codec || '').toUpperCase();
    if (SUPPORTED_FORMATS.has(format) || codec.includes('FLAC') || codec.includes('PCM')) return 'ok';
    return 'codec';
}

/** The prefix every path under a filesystem music root shares; '' for sentinels ('mediastore'). */
export function rootPrefix(root) {
    if (typeof root !== 'string' || root.length === 0) return '';
    if (!(root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\'))) return '';
    return /[\\/]$/.test(root) ? root : root + (root.includes('\\') && !root.includes('/') ? '\\' : '/');
}

const listeners = new Set();
const progressListeners = new Set();
let version = 0;
let progressVersion = 0;
const emit = () => { version++; for (const fn of listeners) fn(); };
const emitProgress = () => { progressVersion++; for (const fn of progressListeners) fn(); };

let cache = createCache();
let cacheLoaded = false;
let loadPromise = null;
const details = new Map();   // path -> { size, mtime, result } full results from this session
let queue = null;
let queueState = { active: false, paused: false, current: null, pending: 0, done: 0, total: 0, label: null, progress: null };
let progress = null;
let playing = false;
let panelPath = null;
let librarySongs = [];
let libraryByPath = new Map();
let libraryRoot = null;
let librarySummary = { analysable: 0, analysed: 0, suspicious: 0 };
let saveTimer = null;
let flushing = null;
let lifecycleBound = false;

// ---- Persistence ---------------------------------------------------------------------------

function ensureLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            const stored = await getAllBlobs(BLOB_PREFIX);
            const pairs = Array.from(stored, ([key, entry]) => [key.slice(BLOB_PREFIX.length), entry]);
            const { stale } = importEntries(cache, pairs);
            if (stale.length > 0) await deleteBlobs(stale.map((p) => BLOB_PREFIX + p)).catch(() => {});
        } catch (e) {
            console.error('Quality analysis cache could not be read; results will not be saved this session', e);
            cacheLoaded = false;
            emit();
            return;
        }
        cacheLoaded = true;
        await migrateLegacy();
        reconcileLibrary();
        emit();
    })();
    return loadPromise;
}

/** One-time move of the old single-document cache (settings store) into per-entry blobs. */
async function migrateLegacy() {
    let stored;
    try {
        stored = await Platform.getStore(CACHE_KEY);
    } catch (e) {
        return;
    }
    const pairs = legacyEntries(stored);
    if (pairs.length > 0) {
        const { imported } = importEntries(cache, pairs);
        for (const [path] of pairs) if (cache.entries.has(path)) cache.dirty.add(path);
        if (imported > 0) await flush();
    }
    if (stored !== null && stored !== undefined) {
        try { await Platform.setStore(CACHE_KEY, null); } catch (e) { /* the key is simply left behind */ }
    }
}

async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!cacheLoaded || !hasPending(cache)) return flushing;
    if (flushing) { await flushing; }
    const work = takeDirty(cache);
    flushing = (async () => {
        try {
            if (work.writes.length > 0) await setBlobs(work.writes);
            if (work.deletes.length > 0) await deleteBlobs(work.deletes);
        } catch (e) {
            restoreDirty(cache, work);
            console.error('Failed to save quality analysis results', e);
        } finally {
            flushing = null;
        }
    })();
    return flushing;
}

function scheduleFlush() {
    if (!cacheLoaded || saveTimer) return;
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function bindLifecycle() {
    if (lifecycleBound || typeof document === 'undefined') return;
    lifecycleBound = true;
    const onHidden = () => { flush(); };
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) onHidden();
        // Battery: a phone in the pocket does not decode audio. Desktop keeps working minimised.
        if (queue && Platform.isNative()) queue.setPaused(document.hidden);
    });
    window.addEventListener('pagehide', onHidden);
}

// ---- Library bookkeeping -------------------------------------------------------------------

function rememberDetails(path, song, result) {
    details.set(path, { size: song.fileSize ?? null, mtime: song.mtime ?? null, result });
    while (details.size > DETAILS_LIMIT) details.delete(details.keys().next().value);
}

function resultFor(song) {
    const d = details.get(song.path);
    if (d && d.size === (song.fileSize ?? null) && d.mtime === (song.mtime ?? null)) return d.result;
    return lookup(cache, song);
}

function recountLibrary() {
    let analysable = 0;
    let analysed = 0;
    let suspicious = 0;
    for (const song of librarySongs) {
        if (eligibility(song) !== 'ok') continue;
        analysable++;
        const r = resultFor(song);
        if (!r) continue;
        analysed++;
        if (isSuspicious(r.verdict)) suspicious++;
    }
    librarySummary = { analysable, analysed, suspicious };
}

/** Keeps the library summary exact when one song's result changes. */
function accountChange(song, before, after) {
    if (!libraryByPath.has(song.path) || eligibility(song) !== 'ok') return;
    const s = librarySummary;
    librarySummary = {
        analysable: s.analysable,
        analysed: s.analysed - (before ? 1 : 0) + (after ? 1 : 0),
        suspicious: s.suspicious - (before && isSuspicious(before.verdict) ? 1 : 0) + (after && isSuspicious(after.verdict) ? 1 : 0)
    };
}

/**
 * Adopts MD5 matches for the current library (moved / re-tagged files keep their result),
 * then prunes entries under the current root whose file is gone. Pruning waits until the
 * library is complete: never while it is empty or still holds provisional rows (Android's
 * first pass), and never for other roots' results.
 */
function reconcileLibrary() {
    if (!cacheLoaded) return;
    let changed = false;
    for (const song of librarySongs) {
        if (song.md5 && adopt(cache, song)) changed = true;
    }
    const complete = librarySongs.length > 0 && !librarySongs.some((s) => s.provisional);
    if (complete && prune(cache, new Set(libraryByPath.keys()), { prefix: rootPrefix(libraryRoot) }) > 0) changed = true;
    if (changed) scheduleFlush();
    recountLibrary();
}

// ---- Queue ---------------------------------------------------------------------------------

function ensureQueue() {
    if (queue) return queue;
    queue = createAnalysisQueue({
        createWorker: () => new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' }),
        read: (job, offset, length) => {
            if (!job.source) job.source = createFetchByteSource(job.url, { size: job.size });
            return job.source.read(offset, length);
        },
        sizeOf: (job) => (job.source ? job.source.size : job.size),
        onCancel: (job) => { if (job.source) job.source.abort(); },
        onResult: (job, result) => {
            const song = libraryByPath.get(job.key) || job.song;
            const before = resultFor(song);
            put(cache, song, result);
            rememberDetails(job.key, song, result);
            accountChange(song, before, result);
            scheduleFlush();
        },
        onError: (job, error) => {
            // Not cached: the next "Analyze" retries it.
            console.warn('Quality analysis failed for', job.key, error);
        },
        onChange: (state) => {
            queueState = state;
            if (!state.active) flush();
            emit();
        },
        onProgress: (p) => {
            progress = p;
            emitProgress();
        }
    });
    queue.setPlaybackActive(playing);
    if (typeof document !== 'undefined' && Platform.isNative()) queue.setPaused(document.hidden);
    return queue;
}

const toJob = (song) => ({
    key: song.path,
    url: Platform.convertFileSrc(song.path),
    size: Number.isFinite(song.fileSize) && song.fileSize > 0 ? song.fileSize : null,
    meta: {
        lossless: song.lossless, sampleRate: song.sampleRate, bitsPerSample: song.bitsPerSample,
        channels: song.channels, duration: song.duration, fileSize: song.fileSize
    },
    song
});

// ---- Public API ----------------------------------------------------------------------------

export const qualityStore = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getVersion: () => version,
    subscribeProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); },
    getProgressVersion: () => progressVersion,
    getProgress: () => progress,

    /** Loads the cache; safe to call repeatedly. */
    init() { bindLifecycle(); ensureLoaded(); },

    /**
     * The current library (so results can be adopted / pruned and the panel can find songs by
     * path) and the root it came from (a folder, or a sentinel such as 'mediastore').
     */
    setLibrary(songs, root = null) {
        librarySongs = songs || [];
        libraryByPath = new Map(librarySongs.map((s) => [s.path, s]));
        libraryRoot = root;
        if (cacheLoaded) reconcileLibrary();
        else recountLibrary();
        emit();
    },

    setPlaybackActive(active) {
        playing = !!active;
        if (queue) queue.setPlaybackActive(playing);
    },

    eligibility,

    /** Cached (or this session's) result for a song, validated against the file; null when none. Pure. */
    getResult(song) {
        if (!song || !song.path) return null;
        return resultFor(song);
    },

    isSuspicious(song) {
        const result = this.getResult(song);
        return !!result && isSuspicious(result.verdict);
    },

    isQueued: (song) => !!(queue && song && queue.has(song.path)),
    isAnalyzing: (song) => !!(queue && song && queue.isRunning(song.path)),
    getQueueState: () => queueState,

    /**
     * Queues the analysable songs that have no valid result yet (all of them with `force`).
     * @returns {number} songs queued
     */
    analyze(songs, { label = null, force = false, front = false } = {}) {
        ensureLoaded();
        const jobs = [];
        let adopted = false;
        for (const song of songs || []) {
            if (eligibility(song) !== 'ok') continue;
            if (!force) {
                if (this.getResult(song)) continue;
                if (song.md5 && adopt(cache, song)) {
                    accountChange(song, null, lookup(cache, song));
                    adopted = true;
                    continue;
                }
            } else {
                details.delete(song.path);
            }
            jobs.push(toJob(song));
        }
        if (adopted) { scheduleFlush(); emit(); }
        if (jobs.length === 0) return 0;
        return ensureQueue().add(jobs, { label, front });
    },

    cancelAll() { if (queue) queue.cancelAll(); },

    /**
     * Counts for a set of songs: { analysable, analysed, suspicious }. The library itself
     * (the array passed to setLibrary) is answered from a maintained tally without a pass.
     */
    summary(songs) {
        if (songs === librarySongs) return librarySummary;
        let analysable = 0;
        let analysed = 0;
        let suspicious = 0;
        for (const song of songs || []) {
            if (eligibility(song) !== 'ok') continue;
            analysable++;
            const r = this.getResult(song);
            if (!r) continue;
            analysed++;
            if (isSuspicious(r.verdict)) suspicious++;
        }
        return { analysable, analysed, suspicious };
    },

    openPanel(song) { panelPath = song ? song.path : null; emit(); },
    closePanel() { if (panelPath === null) return; panelPath = null; emit(); },
    getPanelSong: () => (panelPath === null ? null : (libraryByPath.get(panelPath) || null)),

    flush,

    /** Test hook. */
    _reset() {
        cache = createCache();
        cacheLoaded = false;
        loadPromise = null;
        clearTimeout(saveTimer);
        saveTimer = null;
        flushing = null;
        details.clear();
        if (queue) queue.destroy();
        queue = null;
        librarySongs = [];
        libraryByPath = new Map();
        libraryRoot = null;
        librarySummary = { analysable: 0, analysed: 0, suspicious: 0 };
        panelPath = null;
    }
};

export default qualityStore;
