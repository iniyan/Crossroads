// The app-side store with the platform mocked: cache load/merge, adoption before pruning,
// root-scoped pruning guards, pure reads, incremental summary, per-entry persistence and the
// legacy migration. The worker is a stand-in that answers every job with a canned result.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const platform = { store: new Map(), native: false };
vi.mock('../../services/PlatformService', () => ({
    default: {
        isElectron: () => false,
        isNative: () => platform.native,
        convertFileSrc: (p) => `mock://${p}`,
        getStore: async (key) => (platform.store.has(key) ? platform.store.get(key) : null),
        setStore: async (key, value) => { platform.store.set(key, value); }
    }
}));

// A minimal page for the lifecycle hooks (visibilitychange / pagehide); node has no DOM.
if (typeof globalThis.document === 'undefined') {
    const doc = new EventTarget();
    Object.defineProperty(doc, 'hidden', { value: false, configurable: true, writable: true });
    globalThis.document = doc;
    globalThis.window = new EventTarget();
}

const blobStore = await import('../../services/blobStore.js');
const { qualityStore, rootPrefix } = await import('../qualityStore.js');
const { ANALYZER_VERSION } = await import('../verdict.js');
const { compactEntry, BLOB_PREFIX, CACHE_KEY } = await import('../cache.js');

const song = (path, over = {}) => ({ path, format: 'FLAC', lossless: true, fileSize: 1000, mtime: 1, md5: null, ...over });
const result = (over = {}) => ({
    version: ANALYZER_VERSION, analyzedAt: 1, verdict: 'genuine', confidence: 0.9, flags: [], reason: 'no-shelf',
    sampleRate: 44100, channels: 2, bitsPerSample: 16, md5: null, effectiveBitDepth: 16, effectiveBandwidthHz: 20000,
    cutoffHz: null, cutoffStepDb: null, cutoffConsistency: null, windowsAnalyzed: 5, windowsInformative: 5, evidence: null, ...over
});

/** Worker stand-in: answers 'analyze' with the result registered for the job's URL. */
const canned = new Map();
class FakeWorker {
    postMessage(msg) {
        if (msg.type !== 'analyze') return;
        const r = canned.get(msg.meta.fileSize) || result();
        setTimeout(() => this.onmessage({ data: { type: 'progress', id: msg.id, done: 1, total: 2 } }), 0);
        setTimeout(() => this.onmessage({ data: { type: 'result', id: msg.id, result: r } }), 1);
    }
    terminate() {}
}

const settle = async (ms = 10) => { await vi.advanceTimersByTimeAsync(ms); };

describe('qualityStore', () => {
    let events;
    let ticks;
    let unsubscribe;
    beforeEach(() => {
        vi.useFakeTimers();
        globalThis.Worker = FakeWorker;
        blobStore._resetBlobStoreForTests();
        platform.store.clear();
        platform.native = false;
        canned.clear();
        qualityStore._reset();
        events = 0;
        ticks = 0;
        const u1 = qualityStore.subscribe(() => { events++; });
        const u2 = qualityStore.subscribeProgress(() => { ticks++; });
        unsubscribe = () => { u1(); u2(); };
    });
    afterEach(() => { unsubscribe(); vi.useRealTimers(); delete globalThis.Worker; });

    it('rootPrefix only scopes filesystem roots', () => {
        expect(rootPrefix('/Users/me/Music')).toBe('/Users/me/Music/');
        expect(rootPrefix('/Users/me/Music/')).toBe('/Users/me/Music/');
        expect(rootPrefix('C:\\Music')).toBe('C:\\Music\\');
        expect(rootPrefix('mediastore')).toBe('');
        expect(rootPrefix(null)).toBe('');
    });

    it('loads stored entries, keeps results produced before the load, and drops other analyzer versions', async () => {
        await blobStore.setBlobs([
            [BLOB_PREFIX + '/m/a.flac', compactEntry(song('/m/a.flac'), result({ verdict: 'padded', flags: ['padded'] }))],
            [BLOB_PREFIX + '/m/old.flac', { ...compactEntry(song('/m/old.flac'), result()), ver: ANALYZER_VERSION - 1 }]
        ]);
        const a = song('/m/a.flac');
        const b = song('/m/b.flac', { fileSize: 2 });
        qualityStore.setLibrary([a, b], '/m');
        // Analyse 'a' while the (async) load is in flight: whichever lands first, the fresh
        // result wins (importEntries never replaces, put() always does).
        qualityStore.init();
        expect(qualityStore.analyze([a, b], { label: 'lib' })).toBe(2);
        await settle(400); // 'b' starts after the track gap
        expect(qualityStore.getResult(a).verdict).toBe('genuine');
        expect(qualityStore.getResult(a).fromCache).toBeUndefined();
        expect(qualityStore.getResult(b).verdict).toBe('genuine');
        expect(qualityStore.summary([a, b])).toEqual({ analysable: 2, analysed: 2, suspicious: 0 });
        await qualityStore.flush();
        const keys = await blobStore.getAllKeys(BLOB_PREFIX);
        expect(keys.sort()).toEqual([BLOB_PREFIX + '/m/a.flac', BLOB_PREFIX + '/m/b.flac']); // stale blob deleted, 'a' rewritten
        expect((await blobStore.getBlob(BLOB_PREFIX + '/m/a.flac')).v).toBe(0);
        expect(ticks).toBeGreaterThan(0);
    });

    it('getResult and summary are pure and allocation-free on repeated calls', async () => {
        await blobStore.setBlob(BLOB_PREFIX + '/m/a.flac', compactEntry(song('/m/a.flac'), result()));
        const a = song('/m/a.flac');
        qualityStore.init();
        await settle();
        qualityStore.setLibrary([a], '/m');
        const before = events;
        const r1 = qualityStore.getResult(a);
        const r2 = qualityStore.getResult(a);
        expect(r1).toBe(r2);
        expect(qualityStore.summary([a])).toEqual({ analysable: 1, analysed: 1, suspicious: 0 });
        const lib = [a];
        qualityStore.setLibrary(lib, '/m');
        expect(qualityStore.summary(lib)).toBe(qualityStore.summary(lib)); // the maintained tally, no pass
        expect(events - before).toBe(1); // only setLibrary emitted; reads never do
        await qualityStore.flush();
        expect(await blobStore.getAllKeys(BLOB_PREFIX)).toHaveLength(1); // reads scheduled no writes
    });

    it('adopts MD5 matches before pruning, prunes only under the current root and only a complete library', async () => {
        await blobStore.setBlobs([
            [BLOB_PREFIX + '/m/old-name.flac', compactEntry(song('/m/old-name.flac', { md5: 'aa' }), result({ md5: 'aa', verdict: 'padded', flags: ['padded'] }))],
            [BLOB_PREFIX + '/m/gone.flac', compactEntry(song('/m/gone.flac'), result())],
            [BLOB_PREFIX + '/elsewhere/keep.flac', compactEntry(song('/elsewhere/keep.flac'), result())]
        ]);
        qualityStore.init();
        await settle();
        const moved = song('/m/new-name.flac', { fileSize: 4242, mtime: 9, md5: 'aa' });
        // Provisional rows: nothing is pruned yet.
        qualityStore.setLibrary([moved, song('/m/p.flac', { provisional: true })], '/m');
        await qualityStore.flush();
        expect(await blobStore.getBlob(BLOB_PREFIX + '/m/gone.flac')).toBeDefined();
        expect(qualityStore.getResult(moved).verdict).toBe('padded'); // adopted already
        // Empty library: nothing is pruned.
        qualityStore.setLibrary([], '/m');
        await qualityStore.flush();
        expect(await blobStore.getBlob(BLOB_PREFIX + '/m/gone.flac')).toBeDefined();
        // Complete library: the vanished files under /m go (the adopted entry's old path too),
        // the other root's result stays.
        qualityStore.setLibrary([moved], '/m');
        expect(qualityStore.summary([moved])).toEqual({ analysable: 1, analysed: 1, suspicious: 1 });
        await qualityStore.flush();
        const keys = (await blobStore.getAllKeys(BLOB_PREFIX)).sort();
        expect(keys).toEqual([BLOB_PREFIX + '/elsewhere/keep.flac', BLOB_PREFIX + '/m/new-name.flac']);
        expect((await blobStore.getBlob(BLOB_PREFIX + '/m/new-name.flac')).sz).toBe(4242);
        // A sentinel root (Android MediaStore) prunes everything not in the library.
        qualityStore.setLibrary([moved], 'mediastore');
        await qualityStore.flush();
        expect((await blobStore.getAllKeys(BLOB_PREFIX)).sort()).toEqual([BLOB_PREFIX + '/m/new-name.flac']);
    });

    it('migrates the legacy single-document cache once and clears it', async () => {
        platform.store.set(CACHE_KEY, { f: 1, e: { '/m/a.flac': compactEntry(song('/m/a.flac'), result({ verdict: 'band-limited' })) } });
        qualityStore.init();
        await settle();
        expect(qualityStore.getResult(song('/m/a.flac')).verdict).toBe('band-limited');
        expect(platform.store.get(CACHE_KEY)).toBeNull();
        expect(await blobStore.getBlob(BLOB_PREFIX + '/m/a.flac')).toMatchObject({ v: 6 });
    });

    it('keeps the library summary exact as results arrive and writes one blob per result', async () => {
        const lib = [song('/m/a.flac', { fileSize: 11 }), song('/m/b.flac', { fileSize: 12 }), song('/m/lossy.mp3', { format: 'MP3', lossless: false })];
        canned.set(12, result({ verdict: 'lossy-transcode', flags: ['lossy-transcode'] }));
        qualityStore.init();
        await settle();
        qualityStore.setLibrary(lib, '/m');
        expect(qualityStore.summary(lib)).toEqual({ analysable: 2, analysed: 0, suspicious: 0 });
        expect(qualityStore.analyze(lib)).toBe(2);
        expect(qualityStore.isQueued(lib[1])).toBe(true);
        await settle(400);
        expect(qualityStore.summary(lib)).toEqual({ analysable: 2, analysed: 2, suspicious: 1 });
        expect(qualityStore.isSuspicious(lib[1])).toBe(true);
        expect(qualityStore.getQueueState().active).toBe(false);
        expect(qualityStore.analyze(lib)).toBe(0);                       // nothing left to do
        expect(qualityStore.analyze([lib[0]], { force: true })).toBe(1); // unless forced
        await settle(400);
        await qualityStore.flush();
        expect((await blobStore.getAllKeys(BLOB_PREFIX)).length).toBe(2);
    });

    it('pauses the queue while hidden only on the native shell', async () => {
        qualityStore.init();
        await settle();
        qualityStore.analyze([song('/m/a.flac')]);
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(qualityStore.getQueueState().paused).toBe(false);
        platform.native = true;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(qualityStore.getQueueState().paused).toBe(true);
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(qualityStore.getQueueState().paused).toBe(false);
    });
});
