import { describe, expect, it, vi } from 'vitest';
import { embeddedLyricsTexts, lrclibUrl, resolveLyrics, sidecarPathFor } from '../lyricsResolver.js';

const SYNCED = '[00:01.00]Hello\n[00:02.00]World';
const song = { path: '/music/Album/01 Song.flac', title: 'Song', artist: 'Band', album: 'Album', duration: 200.4, tags: {} };
const ok = (body) => ({ ok: true, json: async () => body });

describe('helpers', () => {
    it('sidecarPathFor swaps the extension', () => {
        expect(sidecarPathFor('/music/a/b.flac')).toBe('/music/a/b.lrc');
        expect(sidecarPathFor('C:\\m\\x.y.mp3')).toBe('C:\\m\\x.y.lrc');
        expect(sidecarPathFor('/music/noext')).toBe('/music/noext.lrc');
        expect(sidecarPathFor('/music/.hidden/track')).toBe('/music/.hidden/track.lrc');
    });

    it('embeddedLyricsTexts orders synced tags first and includes suffixed variants', () => {
        expect(embeddedLyricsTexts({ UNSYNCEDLYRICS: ['plain'], 'LYRICS:ENG': ['eng'], SYNCEDLYRICS: ['sync'], LYRICS: ['', 'main'], TITLE: ['x'] }))
            .toEqual(['sync', 'main', 'eng', 'plain']);
    });

    it('lrclibUrl', () => {
        expect(lrclibUrl(song)).toBe('https://lrclib.net/api/get?track_name=Song&artist_name=Band&album_name=Album&duration=200');
        expect(lrclibUrl({ title: '' })).toBeNull();
    });
});

describe('resolveLyrics order', () => {
    it('1. embedded synced lyrics win, without hitting the sidecar or the network', async () => {
        const readSidecar = vi.fn(async () => SYNCED);
        const fetch = vi.fn();
        const r = await resolveLyrics({ song: { ...song, tags: { LYRICS: [SYNCED] } }, readSidecar, fetch });
        expect(r.source).toBe('embedded-synced');
        expect(r.synced).toBe(true);
        expect(r.lines).toHaveLength(2);
        expect(readSidecar).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('asks for track details when the bulk song has no lyrics text', async () => {
        const getDetails = vi.fn(async () => ({ tags: { SYNCEDLYRICS: [SYNCED] } }));
        const r = await resolveLyrics({ song: { ...song, hasEmbeddedLyrics: true }, getDetails });
        expect(getDetails).toHaveBeenCalledWith(song.path);
        expect(r.source).toBe('embedded-synced');
    });

    it('2. the sidecar beats embedded unsynced lyrics', async () => {
        const readSidecar = vi.fn(async (p) => (p === '/music/Album/01 Song.lrc' ? SYNCED : null));
        const r = await resolveLyrics({ song: { ...song, tags: { UNSYNCEDLYRICS: ['plain words'] } }, readSidecar, fetch: vi.fn() });
        expect(r.source).toBe('sidecar');
        expect(r.synced).toBe(true);
        expect(r.lrcText).toBe(SYNCED);
    });

    it('a plain-text sidecar is still a sidecar result', async () => {
        const r = await resolveLyrics({ song, readSidecar: async () => 'just\nwords', fetch: vi.fn() });
        expect(r).toMatchObject({ source: 'sidecar', synced: false, plain: 'just\nwords' });
    });

    it('3. embedded unsynced lyrics before the network', async () => {
        const fetch = vi.fn();
        const r = await resolveLyrics({ song: { ...song, tags: { UNSYNCEDLYRICS: ['plain words'] } }, readSidecar: async () => null, fetch });
        expect(r).toMatchObject({ source: 'embedded-unsynced', synced: false, plain: 'plain words' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('4. LRCLIB last, synced when available', async () => {
        const fetch = vi.fn(async () => ok({ syncedLyrics: SYNCED, plainLyrics: 'Hello\nWorld' }));
        const r = await resolveLyrics({ song: { ...song, hasEmbeddedLyrics: false }, readSidecar: async () => null, fetch });
        expect(fetch.mock.calls[0][0]).toBe(lrclibUrl(song));
        expect(r).toMatchObject({ source: 'lrclib', synced: true, plain: 'Hello\nWorld', lrcText: SYNCED });
        const plainOnly = await resolveLyrics({ song, readSidecar: async () => null, fetch: async () => ok({ plainLyrics: '[Chorus]\n\nP  ' }) });
        expect(plainOnly).toMatchObject({ source: 'lrclib', synced: false, plain: '[Chorus]\n\nP  ' });
        expect(await resolveLyrics({ song, readSidecar: async () => null, fetch: async () => ok({ plainLyrics: '  ' }) })).toBeNull();
    });

    it('never goes online when disabled, and returns null when nothing is found', async () => {
        const fetch = vi.fn();
        expect(await resolveLyrics({ song, readSidecar: async () => null, fetch, online: false })).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(await resolveLyrics({ song, readSidecar: async () => null, fetch: async () => ({ ok: false }) })).toBeNull();
    });

    it('tolerates failing providers and respects abort', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await resolveLyrics({
            song: { ...song, hasEmbeddedLyrics: true },
            getDetails: async () => { throw new Error('boom'); },
            readSidecar: async () => { throw new Error('boom'); },
            fetch: async () => ok({ plainLyrics: 'P' })
        });
        expect(r.source).toBe('lrclib');
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
        const controller = new AbortController();
        controller.abort();
        expect(await resolveLyrics({ song, readSidecar: async () => SYNCED, signal: controller.signal })).toBeNull();
    });
});
