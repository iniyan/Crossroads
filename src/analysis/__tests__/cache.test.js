import { describe, it, expect } from 'vitest';
import {
    createCache, lookup, adopt, put, remove, prune, importEntries, legacyEntries, takeDirty, restoreDirty, hasPending,
    packSpectrum, unpackSpectrum, compactEntry, expandEntry, CACHE_FORMAT, CACHE_KEY, BLOB_PREFIX, MAX_ENTRIES
} from '../cache.js';
import { ANALYZER_VERSION } from '../verdict.js';

const song = (over = {}) => ({ path: '/m/a.flac', fileSize: 1000, mtime: 5000, md5: 'abc123', ...over });
const result = (over = {}) => ({
    version: ANALYZER_VERSION, analyzedAt: 1700000000000, verdict: 'lossy-transcode', confidence: 0.85, flags: ['lossy-transcode', 'padded'],
    reason: 'shelf', container: 'FLAC', sampleRate: 44100, channels: 2, bitsPerSample: 24, md5: 'abc123', effectiveBitDepth: 16,
    effectiveBandwidthHz: 16900, cutoffHz: 16796, cutoffStepDb: 47.8, cutoffConsistency: 1, windowsAnalyzed: 8, windowsInformative: 7,
    evidence: {
        spectrum: { db: Array.from({ length: 256 }, (_, i) => -20 - i * 0.5), nyquistHz: 22050 },
        shelf: { cutoffHz: 16796 }, windows: [{ startSec: 1 }],
        bitDepth: { containerBits: 24, effectiveBits: 16, lowByteZeroFraction: 1, trailingZeroHistogram: [0, 0] }
    },
    ...over
});

describe('spectrum packing', () => {
    it('round-trips to within 1 dB and clamps to the byte range', () => {
        const db = Array.from({ length: 256 }, (_, i) => -i * 0.7 - 3.3);
        const back = unpackSpectrum(packSpectrum(db));
        expect(back.length).toBe(128);
        for (let i = 0; i < 128; i++) expect(Math.abs(back[i] - (db[2 * i] + db[2 * i + 1]) / 2)).toBeLessThanOrEqual(0.5);
        expect(unpackSpectrum(packSpectrum([-500, 100]))[0]).toBe(-200);
        expect(packSpectrum([])).toBeNull();
        expect(unpackSpectrum(null)).toBeNull();
    });
});

describe('entries', () => {
    it('compact entries are small and expand to a usable result', () => {
        const entry = compactEntry(song(), result());
        expect(JSON.stringify(entry).length).toBeLessThan(400);
        expect(entry).toMatchObject({ ver: ANALYZER_VERSION, sz: 1000, mt: 5000, md5: 'abc123', v: 3, c: 85, fl: [3, 2], eb: 16, k: 16796, z: 1000 });
        expect(entry.ct).toBeUndefined();
        const back = expandEntry(entry);
        expect(back).toMatchObject({
            verdict: 'lossy-transcode', confidence: 0.85, flags: ['lossy-transcode', 'padded'], reason: 'shelf',
            sampleRate: 44100, bitsPerSample: 24, effectiveBitDepth: 16, cutoffHz: 16796, cutoffStepDb: 47.8, cutoffConsistency: 1,
            windowsAnalyzed: 8, windowsInformative: 7, fromCache: true
        });
        expect(back.evidence.spectrum.db.length).toBe(128);
        expect(back.evidence.spectrum.nyquistHz).toBe(22050);
        expect(back.evidence.bitDepth).toEqual({ containerBits: 24, effectiveBits: 16, lowByteZeroFraction: 1, trailingZeroHistogram: null });
        expect(back.evidence.windows).toBeNull();
    });
    it('expansion is memoised per entry object (no allocation on repeated lookups)', () => {
        const entry = compactEntry(song(), result());
        expect(expandEntry(entry)).toBe(expandEntry(entry));
        expect(expandEntry({ ...entry })).not.toBe(expandEntry(entry));
    });
    it('tolerates missing fields and the band-limited verdict', () => {
        const back = expandEntry(compactEntry({ path: '/x' }, { verdict: 'unsupported', reason: 'codec' }));
        expect(back).toMatchObject({ verdict: 'unsupported', reason: 'codec', confidence: 0, flags: [], effectiveBitDepth: null });
        expect(back.evidence.spectrum).toBeNull();
        expect(back.evidence.bitDepth).toBeNull();
        expect(expandEntry(compactEntry(song(), result({ verdict: 'band-limited', flags: [] }))).verdict).toBe('band-limited');
    });
});

describe('cache', () => {
    it('put / lookup validates size, mtime and analyzer version, and lookup is pure', () => {
        const cache = createCache();
        expect(lookup(cache, song())).toBeNull();
        put(cache, song(), result());
        expect(cache.dirty.has('/m/a.flac')).toBe(true);
        const hit = lookup(cache, song());
        expect(hit.verdict).toBe('lossy-transcode');
        expect(lookup(cache, song())).toBe(hit);
        expect(lookup(cache, song({ fileSize: 1001, md5: null }))).toBeNull();
        expect(lookup(cache, song({ mtime: 1, md5: null }))).toBeNull();
        // A different path with the same MD5 is not a lookup hit: adoption is explicit.
        expect(lookup(cache, song({ path: '/m/b.flac' }))).toBeNull();
        expect(cache.dirty.size).toBe(1);
        cache.entries.get('/m/a.flac').ver = ANALYZER_VERSION + 1;
        expect(lookup(cache, song())).toBeNull();
    });

    it('adopt copies an entry with the same FLAC MD5 after a re-tag or move', () => {
        const cache = createCache();
        put(cache, song(), result());
        takeDirty(cache);
        const moved = song({ path: '/m/b.flac', fileSize: 1200, mtime: 9000 });
        expect(adopt(cache, moved)).toBe(true);
        expect(lookup(cache, moved).verdict).toBe('lossy-transcode');
        expect(cache.entries.get('/m/b.flac')).toMatchObject({ sz: 1200, mt: 9000, md5: 'abc123' });
        expect(Array.from(cache.dirty)).toEqual(['/m/b.flac']);
        expect(adopt(cache, moved)).toBe(false);                             // already valid
        expect(adopt(cache, song({ path: '/m/c.flac', md5: 'other' }))).toBe(false);
        expect(adopt(cache, song({ path: '/m/c.flac', md5: null }))).toBe(false);
        expect(lookup(cache, song({ md5: 'other' }))).not.toBeNull();        // path still matches by size/mtime
    });

    it('importEntries merges without replacing, skips other analyzer versions and reports them', () => {
        const cache = createCache();
        put(cache, song(), result({ verdict: 'genuine', flags: [] }));
        const stored = compactEntry(song(), result());
        const stale = { ...stored, ver: ANALYZER_VERSION - 1 };
        const r = importEntries(cache, [['/m/a.flac', stored], ['/m/old.flac', stale], ['/m/z.wav', compactEntry(song({ path: '/m/z.wav', md5: null }), result({ md5: null }))], ['', stored], ['/bad', null]]);
        expect(r).toEqual({ imported: 1, stale: ['/m/old.flac'] });
        expect(lookup(cache, song()).verdict).toBe('genuine');     // the in-memory result won
        expect(lookup(cache, song({ path: '/m/z.wav', md5: null })).verdict).toBe('lossy-transcode');
        expect(cache.dirty.has('/m/z.wav')).toBe(false);           // imported entries are not re-written
    });

    it('legacyEntries reads the old single-document format only', () => {
        const stored = { f: CACHE_FORMAT, e: { '/m/a.flac': compactEntry(song(), result()) } };
        expect(legacyEntries(stored).length).toBe(1);
        expect(legacyEntries({ f: CACHE_FORMAT + 1, e: stored.e })).toEqual([]);
        expect(legacyEntries('garbage')).toEqual([]);
        expect(legacyEntries(null)).toEqual([]);
        expect(CACHE_KEY).toBe('qualityAnalysis');
    });

    it('takeDirty hands over per-entry writes and deletes, restoreDirty puts them back', () => {
        const cache = createCache();
        put(cache, song(), result());
        put(cache, song({ path: '/m/b.flac', md5: 'def' }), result({ md5: 'def' }));
        remove(cache, '/m/b.flac');
        expect(hasPending(cache)).toBe(true);
        const work = takeDirty(cache);
        expect(work.writes.map(([k]) => k)).toEqual([BLOB_PREFIX + '/m/a.flac']);
        expect(work.deletes).toEqual([BLOB_PREFIX + '/m/b.flac']);
        expect(hasPending(cache)).toBe(false);
        restoreDirty(cache, work);
        expect(Array.from(cache.dirty)).toEqual(['/m/a.flac']);
        expect(Array.from(cache.deleted)).toEqual(['/m/b.flac']);
        // Re-putting a deleted path cancels the delete.
        put(cache, song({ path: '/m/b.flac', md5: 'def' }), result({ md5: 'def' }));
        expect(cache.deleted.has('/m/b.flac')).toBe(false);
    });

    it('remove and prune (scoped to the current root, never on an empty live set)', () => {
        const cache = createCache();
        put(cache, song(), result());
        put(cache, song({ path: '/m/b.flac', md5: 'def' }), result({ md5: 'def' }));
        put(cache, song({ path: '/other/c.flac', md5: null }), result({ md5: null }));
        expect(prune(cache, new Set())).toBe(0); // an empty live set must not wipe the cache
        expect(prune(cache, new Set(['/m/a.flac']), { prefix: '/m/' })).toBe(1);
        expect(cache.entries.has('/other/c.flac')).toBe(true);   // another root's results survive
        expect(cache.byMd5.has('def')).toBe(false);
        expect(cache.deleted.has('/m/b.flac')).toBe(true);
        expect(prune(cache, new Set(['/m/a.flac']))).toBe(1);    // no prefix: everything not live goes
        expect(remove(cache, '/m/a.flac')).toBe(true);
        expect(cache.entries.size).toBe(0);
        expect(cache.byMd5.size).toBe(0);
        expect(remove(cache, '/nope')).toBe(false);
    });

    it('evicts the least recently written entries beyond MAX_ENTRIES', () => {
        const cache = createCache();
        for (let i = 0; i < MAX_ENTRIES + 5; i++) {
            put(cache, song({ path: `/m/${i}.flac`, md5: null }), result({ md5: null, evidence: null }));
        }
        expect(cache.entries.size).toBe(MAX_ENTRIES);
        expect(cache.entries.has('/m/0.flac')).toBe(false);
        expect(cache.entries.has('/m/4.flac')).toBe(false);
        expect(cache.entries.has('/m/5.flac')).toBe(true);
        expect(cache.deleted.has('/m/0.flac')).toBe(true);
        expect(cache.dirty.has('/m/0.flac')).toBe(false);
        // Re-writing an old entry moves it to the back of the eviction order.
        put(cache, song({ path: '/m/5.flac', md5: null }), result({ md5: null, evidence: null }));
        put(cache, song({ path: '/m/new.flac', md5: null }), result({ md5: null, evidence: null }));
        expect(cache.entries.has('/m/5.flac')).toBe(true);
        expect(cache.entries.has('/m/6.flac')).toBe(false);
    });
});
