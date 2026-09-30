import { describe, expect, it } from 'vitest';
import {
    basename, dirname, isAbsolutePath, isInsidePath, joinPath, normalizePath, relativePath,
    parseM3u, serializeM3u, playlistPathFor, playlistFileName, resolveM3uEntries
} from '../m3u.js';

describe('path helpers', () => {
    it('normalise separators and dot segments', () => {
        expect(normalizePath('/a/b/../c/./d.flac')).toBe('/a/c/d.flac');
        expect(normalizePath('C:\\Music\\Album\\..\\x.flac')).toBe('C:/Music/x.flac');
        expect(normalizePath('../up/x.flac')).toBe('../up/x.flac');
        expect(normalizePath('sub//x.flac')).toBe('sub/x.flac');
    });

    it('recognise absolute paths on both platforms', () => {
        expect(isAbsolutePath('/x')).toBe(true);
        expect(isAbsolutePath('D:\\x')).toBe(true);
        expect(isAbsolutePath('D:/x')).toBe(true);
        expect(isAbsolutePath('\\\\server\\share')).toBe(true);
        expect(isAbsolutePath('x/y')).toBe(false);
    });

    it('dirname / basename / join', () => {
        expect(dirname('/music/a/b.flac')).toBe('/music/a');
        expect(dirname('/b.flac')).toBe('/');
        expect(dirname('C:/b.flac')).toBe('C:/');
        expect(basename('/music/a/b.flac')).toBe('b.flac');
        expect(joinPath('/music/pl', '../Album/x.flac')).toBe('/music/Album/x.flac');
    });

    it('isInsidePath and relativePath', () => {
        expect(isInsidePath('/music', '/music/a/b.flac')).toBe(true);
        expect(isInsidePath('/music', '/musical/b.flac')).toBe(false);
        expect(isInsidePath('/music', '/music')).toBe(true);
        expect(relativePath('/music/playlists', '/music/Album/x.flac')).toBe('../Album/x.flac');
        expect(relativePath('/music', '/music/Album/x.flac')).toBe('Album/x.flac');
        expect(relativePath('C:/music', 'D:/x.flac')).toBeNull();
    });
});

describe('parseM3u', () => {
    it('parses extended playlists with EXTINF and Crossroads keys', () => {
        const text = '\uFEFF#EXTM3U\r\n#EXTINF:215,Radiohead - Airbag\r\n#CROSSROADS-KEY:mb:1234\r\nOK Computer/01 Airbag.flac\r\n\r\n#EXTINF:-1,No Artist Title\n/abs/x.mp3\n#comment\nplain.flac\n';
        const pl = parseM3u(text);
        expect(pl.extended).toBe(true);
        expect(pl.entries).toEqual([
            { path: 'OK Computer/01 Airbag.flac', duration: 215, title: 'Airbag', artist: 'Radiohead', trackKey: 'mb:1234', line: 4 },
            { path: '/abs/x.mp3', duration: null, title: 'No Artist Title', artist: null, trackKey: null, line: 7 },
            { path: 'plain.flac', duration: null, title: null, artist: null, trackKey: null, line: 9 }
        ]);
    });

    it('handles EXTINF attributes, fractional durations and titles containing dashes', () => {
        const pl = parseM3u('#EXTM3U\n#EXTINF:123.6 tvg-id="x",A - B - C\nx.flac');
        expect(pl.entries[0]).toMatchObject({ duration: 123.6, artist: 'A', title: 'B - C' });
    });

    it('parses simple playlists and ignores garbage', () => {
        expect(parseM3u('a.flac\nb.flac').entries.map(e => e.path)).toEqual(['a.flac', 'b.flac']);
        expect(parseM3u(null).entries).toEqual([]);
    });
});

describe('serializeM3u', () => {
    const songs = [
        { path: '/music/Album/01.flac', title: 'One', artist: 'Band', duration: 61.4, trackKey: 'meta:band|album|1|1|one' },
        { path: '/music/Other/02.flac', title: 'Two', artist: '', duration: null, trackKey: null },
        { path: '/elsewhere/03.flac', title: '', artist: 'X', duration: 10 }
    ];

    it('writes relative paths inside the music root and absolute ones outside', () => {
        const text = serializeM3u(songs, { playlistDir: '/music/Playlists', musicRoot: '/music' });
        expect(text).toBe([
            '#EXTM3U',
            '#EXTINF:61,Band - One',
            '#CROSSROADS-KEY:meta:band|album|1|1|one',
            '../Album/01.flac',
            '#EXTINF:-1,Two',
            '../Other/02.flac',
            '#EXTINF:10,X - 03.flac',
            '/elsewhere/03.flac',
            ''
        ].join('\n'));
    });

    it('writes absolute paths when the playlist is outside the root or there is no root', () => {
        expect(serializeM3u(songs.slice(0, 1), { playlistDir: '/desktop', musicRoot: '/music', keys: false }))
            .toBe('#EXTM3U\n#EXTINF:61,Band - One\n/music/Album/01.flac\n');
        expect(playlistPathFor('/music/a.flac', {})).toBe('/music/a.flac');
    });

    it('round-trips through parseM3u', () => {
        const pl = parseM3u(serializeM3u(songs, { playlistDir: '/music', musicRoot: '/music' }));
        expect(pl.entries.map(e => e.path)).toEqual(['Album/01.flac', 'Other/02.flac', '/elsewhere/03.flac']);
        expect(pl.entries[0]).toMatchObject({ artist: 'Band', title: 'One', duration: 61, trackKey: 'meta:band|album|1|1|one' });
    });

    it('playlistFileName strips characters file systems reject', () => {
        expect(playlistFileName('Road: Trip / 2024?')).toBe('Road Trip 2024.m3u8');
        expect(playlistFileName('')).toBe('Playlist.m3u8');
    });
});

describe('resolveM3uEntries', () => {
    const songs = [
        { path: '/music/Album/01 One.flac', title: 'One', artist: 'Band', duration: 200, trackKey: 'mb:aaaa' },
        { path: '/music/Album/02 Two.flac', title: 'Two (feat. Guest)', artist: 'Band', duration: 180, trackKey: 'meta:band|album|1|2|two' },
        { path: '/music/Live/Two.flac', title: 'Two', artist: 'Band', duration: 400, trackKey: 'meta:band|live||1|two' },
        { path: '/music/Other/Same.flac', title: 'Same', artist: 'Z', duration: 10, trackKey: 'k1' },
        { path: '/music/Other2/Same.flac', title: 'Same', artist: 'Z', duration: 10, trackKey: 'k2' },
        { path: '/music/Unique/rare.flac', title: 'Rare', artist: 'Q', duration: 5, trackKey: 'k3' }
    ];
    const resolve = (text, opts) => resolveM3uEntries(parseM3u(text).entries, songs, opts);

    it('matches absolute paths (case-insensitively as a fallback)', () => {
        const r = resolve('/music/Album/01 One.flac\n/MUSIC/album/02 two.flac');
        expect(r.results.map(x => [x.song?.path, x.method])).toEqual([
            ['/music/Album/01 One.flac', 'path'],
            ['/music/Album/02 Two.flac', 'path']
        ]);
    });

    it('resolves relative to the playlist file, then to the music root', () => {
        const r = resolve('../Album/01 One.flac\nAlbum/02 Two.flac', { playlistDir: '/music/Playlists', musicRoot: '/music' });
        expect(r.results.map(x => x.method)).toEqual(['relative-to-playlist', 'relative-to-root']);
        expect(r.matched).toHaveLength(2);
    });

    it('falls back to the Crossroads key, then metadata with duration tie-break, then a unique file name', () => {
        const text = [
            '#EXTM3U',
            '#EXTINF:200,Band - One', '#CROSSROADS-KEY:mb:aaaa', 'D:/moved/01 One.flac',
            '#EXTINF:398,Band - Two', 'D:/moved/live-two.flac',
            '#EXTINF:181,Band - Two', 'D:/moved/two.flac',
            'D:/moved/rare.flac',
            '#EXTINF:10,Z - Same', 'D:/moved/Same.flac',
            '#EXTINF:3,Nobody - Nothing', 'D:/moved/nothing.flac'
        ].join('\n');
        const r = resolve(text, { musicRoot: '/music' });
        expect(r.results.map(x => [x.song?.path ?? null, x.method])).toEqual([
            ['/music/Album/01 One.flac', 'trackKey'],
            ['/music/Live/Two.flac', 'metadata'],
            ['/music/Album/02 Two.flac', 'metadata'],
            ['/music/Unique/rare.flac', 'filename'],
            ['/music/Other/Same.flac', 'metadata'],
            [null, null]
        ]);
        expect(r.unmatched).toHaveLength(1);
        expect(r.unmatched[0]).toMatchObject({ path: 'D:/moved/nothing.flac', line: 13 });
    });

    it('does not guess when the file name is ambiguous and metadata is missing', () => {
        const r = resolve('D:/x/Same.flac');
        expect(r.matched).toHaveLength(0);
    });

    it('tolerates an empty library', () => {
        expect(resolveM3uEntries(parseM3u('a.flac').entries, []).unmatched).toHaveLength(1);
    });
});
