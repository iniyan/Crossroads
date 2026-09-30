import { describe, expect, it } from 'vitest';
import { hasLyricsTag, normalizeSong, normalizeSongs, parentFolder, withoutLyricsTags } from '../normalize.js';
import { deriveQuality, formatSampleRateKHz, qualityLabel, qualityTier, resolveFormat, resolveLossless } from '../quality.js';
import { canonicalTags, parseNumberPair, parseYear } from '../tags.js';

describe('quality tiers and labels', () => {
    it('classifies hi-res by bit depth or sample rate', () => {
        expect(qualityTier({ lossless: true, bitsPerSample: 24, sampleRate: 44100 })).toBe('hires');
        expect(qualityTier({ lossless: true, bitsPerSample: 16, sampleRate: 88200 })).toBe('hires');
        expect(qualityTier({ lossless: true, bitsPerSample: 24, sampleRate: 192000 })).toBe('hires');
    });

    it('classifies 16-bit up to 48 kHz lossless as CD', () => {
        expect(qualityTier({ lossless: true, bitsPerSample: 16, sampleRate: 44100 })).toBe('cd');
        expect(qualityTier({ lossless: true, bitsPerSample: 16, sampleRate: 48000 })).toBe('cd');
        expect(qualityTier({ lossless: true, bitsPerSample: null, sampleRate: 44100 })).toBe('cd');
    });

    it('classifies lossy and unknown', () => {
        expect(qualityTier({ lossless: false, bitsPerSample: null, sampleRate: 44100 })).toBe('lossy');
        expect(qualityTier({ lossless: null, bitsPerSample: 16, sampleRate: 44100 })).toBe('unknown');
        expect(qualityTier({ lossless: true, bitsPerSample: null, sampleRate: null })).toBe('unknown');
    });

    it('formats sample rates', () => {
        expect(formatSampleRateKHz(44100)).toBe('44.1');
        expect(formatSampleRateKHz(48000)).toBe('48');
        expect(formatSampleRateKHz(96000)).toBe('96');
        expect(formatSampleRateKHz(176400)).toBe('176.4');
        expect(formatSampleRateKHz(null)).toBeNull();
        expect(formatSampleRateKHz(0)).toBeNull();
    });

    it('builds badge labels', () => {
        expect(qualityLabel({ format: 'FLAC', lossless: true, bitsPerSample: 24, sampleRate: 96000 })).toBe('FLAC 24/96');
        expect(qualityLabel({ format: 'ALAC', lossless: true, bitsPerSample: 16, sampleRate: 44100 })).toBe('ALAC 16/44.1');
        expect(qualityLabel({ format: 'WAV', lossless: true, bitsPerSample: 24, sampleRate: 192000 })).toBe('WAV 24/192');
        expect(qualityLabel({ format: 'MP3', lossless: false, bitrate: 320000 })).toBe('MP3 320');
        expect(qualityLabel({ format: 'AAC', lossless: false, bitrate: 256123 })).toBe('AAC 256');
        expect(qualityLabel({ format: 'MP3', lossless: false, bitrate: null })).toBe('MP3');
        expect(qualityLabel({ format: 'FLAC', lossless: true, bitsPerSample: null, sampleRate: 44100 })).toBe('FLAC 44.1');
        expect(qualityLabel({ format: 'M4A', lossless: null })).toBe('M4A');
    });

    it('resolves M4A and OGG formats from the codec', () => {
        expect(resolveFormat('M4A', 'ALAC')).toBe('ALAC');
        expect(resolveFormat('M4A', 'MPEG-4/AAC')).toBe('AAC');
        expect(resolveFormat('M4A', null)).toBe('M4A');
        expect(resolveFormat('OGG', 'Opus')).toBe('OPUS');
        expect(resolveFormat('OGG', 'Vorbis I')).toBe('OGG');
        expect(resolveFormat('flac', 'FLAC')).toBe('FLAC');
        expect(resolveFormat('', 'MPEG 1 Layer 3')).toBe('MP3');
    });

    it('resolves lossless from the platform, the codec, then the format', () => {
        expect(resolveLossless(true, 'MP3', null)).toBe(true);
        expect(resolveLossless(null, 'M4A', 'ALAC')).toBe(true);
        expect(resolveLossless(null, 'M4A', 'MPEG-4/AAC')).toBe(false);
        expect(resolveLossless(null, 'M4A', null)).toBeNull();
        expect(resolveLossless(null, 'FLAC', null)).toBe(true);
        expect(resolveLossless(undefined, 'OPUS', null)).toBe(false);
    });

    it('deriveQuality returns tier and label together', () => {
        expect(deriveQuality({ format: 'FLAC', lossless: true, bitsPerSample: 24, sampleRate: 96000 }))
            .toEqual({ tier: 'hires', label: 'FLAC 24/96' });
    });
});

describe('tag helpers', () => {
    it('canonicalTags uppercases keys and turns everything into string arrays', () => {
        expect(canonicalTags({ title: 'A', Artist: ['B', 'C'], Year: 2001, empty: '', nul: null, list: ['', ' '] }))
            .toEqual({ TITLE: ['A'], ARTIST: ['B', 'C'], YEAR: ['2001'] });
        expect(canonicalTags({ artist: ['a'], ARTIST: ['b'] })).toEqual({ ARTIST: ['a', 'b'] });
        expect(canonicalTags(null)).toEqual({});
    });

    it('parseNumberPair understands n, n/total and n of total', () => {
        expect(parseNumberPair('7')).toEqual({ number: 7, total: null });
        expect(parseNumberPair('07/12')).toEqual({ number: 7, total: 12 });
        expect(parseNumberPair('3 of 10')).toEqual({ number: 3, total: 10 });
        expect(parseNumberPair(4)).toEqual({ number: 4, total: null });
        expect(parseNumberPair('0/0')).toEqual({ number: null, total: null });
        expect(parseNumberPair('x')).toEqual({ number: null, total: null });
        expect(parseNumberPair(null)).toEqual({ number: null, total: null });
    });

    it('parseYear extracts four-digit years', () => {
        expect(parseYear('2019')).toBe(2019);
        expect(parseYear('2019-04-01')).toBe(2019);
        expect(parseYear('01/04/1987')).toBe(1987);
        expect(parseYear(1999)).toBe(1999);
        expect(parseYear('12345')).toBeNull();
        expect(parseYear('')).toBeNull();
    });
});

describe('normalizeSong', () => {
    const flac = {
        path: '/music/Radiohead/OK Computer/01 Airbag.flac',
        title: 'Airbag',
        artist: 'Radiohead',
        album: 'OK Computer',
        albumArtist: 'Radiohead',
        composer: '',
        duration: 284.5,
        format: 'FLAC',
        codec: 'FLAC',
        lossless: true,
        bitrate: 1050000,
        sampleRate: 96000,
        bitsPerSample: 24,
        channels: 2,
        totalSamples: 27312000,
        md5: 'AABBCCDDEEFF00112233445566778899',
        fileSize: 40000000,
        mtime: 1700000000000,
        tags: {
            TITLE: ['Airbag'],
            ARTIST: ['Radiohead'],
            ALBUM: ['OK Computer'],
            TRACKNUMBER: ['1'],
            TRACKTOTAL: ['12'],
            DISCNUMBER: ['1/1'],
            DATE: ['1997-05-21'],
            GENRE: ['Alternative Rock'],
            UNSYNCEDLYRICS: ['In the next world war...']
        },
        picture: 'crossroads-media://art/x'
    };

    it('keeps the platform fields and derives the rest', () => {
        const song = normalizeSong(flac);
        expect(song.path).toBe(flac.path);
        expect(song.folder).toBe('/music/Radiohead/OK Computer');
        expect(song.title).toBe('Airbag');
        expect(song.albumArtist).toBe('Radiohead');
        expect(song.trackNumber).toBe(1);
        expect(song.trackTotal).toBe(12);
        expect(song.discNumber).toBe(1);
        expect(song.discTotal).toBe(1);
        expect(song.year).toBe(1997);
        expect(song.genre).toBe('Alternative Rock');
        expect(song.hasEmbeddedLyrics).toBe(true);
        expect(song.md5).toBe('aabbccddeeff00112233445566778899');
        expect(song.channels).toBe(2);
        expect(song.totalSamples).toBe(27312000);
        expect(song.quality).toEqual({ tier: 'hires', label: 'FLAC 24/96' });
        expect(song.trackKey).toBe('meta:radiohead|ok computer|1|1|airbag');
        expect(song.picture).toBe('crossroads-media://art/x');
        expect(song.fileSize).toBe(40000000);
        expect(song.mtime).toBe(1700000000000);
    });

    it('fills common fields from the tags when the platform left them empty', () => {
        const song = normalizeSong({
            path: '/m/x.mp3',
            format: 'MP3',
            lossless: false,
            bitrate: 320000,
            tags: { TITLE: ['From Tag'], ARTIST: ['Tag Artist'], ALBUMARTIST: ['AA'], COMPOSER: ['Comp'], TRACKNUMBER: ['3/9'] }
        });
        expect(song.title).toBe('From Tag');
        expect(song.artist).toBe('Tag Artist');
        expect(song.albumArtist).toBe('AA');
        expect(song.composer).toBe('Comp');
        expect(song.trackNumber).toBe(3);
        expect(song.trackTotal).toBe(9);
        expect(song.quality).toEqual({ tier: 'lossy', label: 'MP3 320' });
    });

    it('accepts n/total strings in the platform number fields (MediaStore disc numbers)', () => {
        const song = normalizeSong({ path: '/a.flac', discNumber: '2/3', trackNumber: 7, trackTotal: '12' });
        expect(song.discNumber).toBe(2);
        expect(song.discTotal).toBe(3);
        expect(song.trackNumber).toBe(7);
        expect(song.trackTotal).toBe(12);
        expect(normalizeSong({ path: '/a.flac', trackNumber: 0 }).trackNumber).toBeNull();
    });

    it('falls back to the file and folder names', () => {
        const song = normalizeSong({ path: '/music/Some Album/07 - Track.wav' });
        expect(song.title).toBe('07 - Track');
        expect(song.artist).toBe('Unknown Artist');
        expect(song.album).toBe('Some Album');
        expect(song.format).toBe('UNKNOWN');
        expect(song.lossless).toBeNull();
        expect(song.quality.tier).toBe('unknown');
    });

    it('turns an M4A with ALAC into a lossless ALAC song', () => {
        const song = normalizeSong({ path: '/m/a.m4a', format: 'M4A', codec: 'ALAC', sampleRate: 44100, bitsPerSample: 16 });
        expect(song.format).toBe('ALAC');
        expect(song.lossless).toBe(true);
        expect(song.quality).toEqual({ tier: 'cd', label: 'ALAC 16/44.1' });
    });

    it('drops zero or malformed MD5 values', () => {
        expect(normalizeSong({ path: '/a.flac', md5: '0'.repeat(32) }).md5).toBeNull();
        expect(normalizeSong({ path: '/a.flac', md5: 'zz' }).md5).toBeNull();
        expect(normalizeSong({ path: '/a.flac' }).md5).toBeNull();
    });

    it('never emits undefined for known fields', () => {
        const song = normalizeSong({ path: '/a.flac' });
        for (const [key, value] of Object.entries(song)) {
            expect(value, key).not.toBeUndefined();
        }
        expect(song.tags).toEqual({});
        expect(song.hasEmbeddedLyrics).toBe(false);
    });

    it('detects lyrics under the usual and language-suffixed tag names', () => {
        expect(normalizeSong({ path: '/a.flac', tags: { LYRICS: ['x'] } }).hasEmbeddedLyrics).toBe(true);
        expect(normalizeSong({ path: '/a.flac', tags: { 'LYRICS:ENG': ['x'] } }).hasEmbeddedLyrics).toBe(true);
        expect(normalizeSong({ path: '/a.mp3', tags: { 'UNSYNCEDLYRICS-ENG': ['x'] } }).hasEmbeddedLyrics).toBe(true);
        expect(normalizeSong({ path: '/a.flac', tags: { LYRICIST: ['x'] } }).hasEmbeddedLyrics).toBe(false);
        expect(normalizeSong({ path: '/a.flac', hasEmbeddedLyrics: true }).hasEmbeddedLyrics).toBe(true);
    });

    it('preserves a platform-provided trackKey', () => {
        expect(normalizeSong({ path: '/a.flac', trackKey: 'mb:abc' }).trackKey).toBe('mb:abc');
    });

    it('keeps the platform passthrough fields the Android media session needs', () => {
        const song = normalizeSong({
            path: '/storage/emulated/0/Music/a.mp3',
            picture: 'http://localhost/_capacitor_content_/media/external/audio/albumart/7',
            rawPicture: 'content://media/external/audio/albumart/7'
        });
        expect(song.picture).toBe('http://localhost/_capacitor_content_/media/external/audio/albumart/7');
        expect(song.rawPicture).toBe('content://media/external/audio/albumart/7');
        expect(normalizeSong({ path: '/a.flac' }).rawPicture).toBeNull();
        expect(normalizeSong({ path: '/a.flac', rawPicture: '' }).rawPicture).toBeNull();
    });

    it('marks rows the platform has not probed yet as provisional', () => {
        expect(normalizeSong({ path: '/a.flac', provisional: true }).provisional).toBe(true);
        expect(normalizeSong({ path: '/a.flac', provisional: false }).provisional).toBe(false);
        expect(normalizeSong({ path: '/a.flac' }).provisional).toBe(false);
        expect(normalizeSong({ path: '/a.flac', provisional: 'yes' }).provisional).toBe(false);
    });

    it('keeps hasEmbeddedLyrics when the bulk payload carries the flag without the lyrics text', () => {
        const song = normalizeSong({ path: '/a.mp3', hasEmbeddedLyrics: true, tags: { TITLE: ['T'] } });
        expect(song.hasEmbeddedLyrics).toBe(true);
        expect(song.tags).toEqual({ TITLE: ['T'] });
    });

    it('handles Windows paths', () => {
        const song = normalizeSong({ path: 'C:\\Music\\Album\\song.flac' });
        expect(song.folder).toBe('C:\\Music\\Album');
        expect(song.album).toBe('Album');
        expect(song.title).toBe('song');
    });
});

describe('lyrics tag helpers', () => {
    it('withoutLyricsTags drops every lyrics-carrying tag and keeps the rest', () => {
        const tags = { TITLE: ['T'], LYRICS: ['a'], UNSYNCEDLYRICS: ['b'], SYNCEDLYRICS: ['[00:01.00]c'], 'LYRICS:ENG': ['d'], LYRICIST: ['L'] };
        expect(withoutLyricsTags(tags)).toEqual({ TITLE: ['T'], LYRICIST: ['L'] });
        expect(hasLyricsTag(tags)).toBe(true);
        expect(hasLyricsTag(withoutLyricsTags(tags))).toBe(false);
        expect(withoutLyricsTags(null)).toEqual({});
    });
});

describe('normalizeSongs', () => {
    it('skips junk entries', () => {
        const songs = normalizeSongs([null, {}, { path: '/a.flac' }, 'x']);
        expect(songs).toHaveLength(1);
        expect(songs[0].path).toBe('/a.flac');
        expect(normalizeSongs(undefined)).toEqual([]);
    });
});

describe('parentFolder', () => {
    it('handles roots and bare names', () => {
        expect(parentFolder('/a.flac')).toBe('/');
        expect(parentFolder('a.flac')).toBe('');
        expect(parentFolder('/x/y/z.flac')).toBe('/x/y');
    });
});
