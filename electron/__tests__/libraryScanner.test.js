import { describe, expect, it } from 'vitest';
import { artUrl, forBulkPayload, isLyricsTag, isTransientError } from '../libraryScanner.js';
import { isLyricsTagName } from '../../src/library/song.js';
import { withoutLyricsTags } from '../../src/library/normalize.js';

describe('bulk payload', () => {
    const song = {
        path: '/m/a.flac',
        tags: { TITLE: ['T'], LYRICS: ['la'], UNSYNCEDLYRICS: ['la la'], SYNCEDLYRICS: ['[00:01.00]la'], 'LYRICS:ENG': ['x'], LYRICIST: ['L'] },
        hasEmbeddedLyrics: false
    };

    it('strips lyrics text and sets hasEmbeddedLyrics', () => {
        const bulk = forBulkPayload(song);
        expect(bulk.tags).toEqual({ TITLE: ['T'], LYRICIST: ['L'] });
        expect(bulk.hasEmbeddedLyrics).toBe(true);
        expect(song.tags.LYRICS).toEqual(['la']); // the cached song keeps the full tags
        expect(forBulkPayload({ path: '/m/b.flac', tags: { TITLE: ['T'] } }).hasEmbeddedLyrics).toBe(false);
    });

    it('agrees with the shared model about which tags carry lyrics', () => {
        const names = ['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS', 'LYRICS:ENG', 'UNSYNCEDLYRICS-XXX', 'SYNCEDLYRICS_ENG',
            'lyrics', 'LYRICIST', 'LYRICSX', 'TITLE', 'MYLYRICS'];
        for (const name of names) expect(isLyricsTag(name), name).toBe(isLyricsTagName(name));
        expect(forBulkPayload(song).tags).toEqual(withoutLyricsTags(song.tags));
    });
});

describe('artUrl', () => {
    it('encodes the path and adds size + mtime as a cache-buster', () => {
        expect(artUrl('/m/a b.flac', 1234, 1700000000000)).toBe('crossroads-media://art/%2Fm%2Fa%20b.flac?v=1234-1700000000000');
        expect(artUrl('/m/a.flac')).toBe('crossroads-media://art/%2Fm%2Fa.flac');
        expect(new URL(artUrl('/m/a.flac', 1, 2)).pathname).toBe('/%2Fm%2Fa.flac');
    });
});

describe('isTransientError', () => {
    it('classifies I/O hiccups as transient and parser errors as deterministic', () => {
        expect(isTransientError(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe(true);
        expect(isTransientError(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true);
        expect(isTransientError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
        expect(isTransientError(new RangeError('position out of range'))).toBe(false);
        expect(isTransientError(new Error('FourCC contains invalid characters'))).toBe(false);
        expect(isTransientError(null)).toBe(false);
    });
});
