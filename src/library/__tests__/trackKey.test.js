import { describe, expect, it } from 'vitest';
import { computeTrackKey, musicBrainzTrackId, normalizeText } from '../trackKey.js';

describe('normalizeText', () => {
    it('lowercases, strips diacritics and punctuation, collapses spaces', () => {
        expect(normalizeText('  Édith   Piaf: "La Vie en Rose"! ')).toBe('edith piaf la vie en rose');
        expect(normalizeText('Björk – Jóga')).toBe('bjork joga');
        expect(normalizeText('AC/DC')).toBe('acdc');
    });

    it('applies NFKD compatibility folding', () => {
        expect(normalizeText('ﬁne ①')).toBe('fine 1');
        expect(normalizeText('Ｔｏｋｙｏ')).toBe('tokyo');
    });

    it('drops feat. suffixes in their common spellings', () => {
        expect(normalizeText('Song Title (feat. Someone)')).toBe('song title');
        expect(normalizeText('Song Title feat. Someone & Other')).toBe('song title');
        expect(normalizeText('Song Title [ft. Someone]')).toBe('song title');
        expect(normalizeText('Song Title - featuring Someone')).toBe('song title');
        expect(normalizeText('Song Title -feat. Someone')).toBe('song title');
        expect(normalizeText('Featuring')).toBe('featuring');
    });

    it('only strips feat / ft / featuring when they are separate words', () => {
        expect(normalizeText('Daft Punk')).toBe('daft punk');
        expect(normalizeText('Left Behind')).toBe('left behind');
        expect(normalizeText('Kraftwerk')).toBe('kraftwerk');
        expect(normalizeText('Soft Cell')).toBe('soft cell');
        expect(normalizeText('Feat. Someone')).toBe('feat someone');
        expect(normalizeText('Featuring Someone')).toBe('featuring someone');
        expect(normalizeText('The Draft')).toBe('the draft');
    });

    it('handles empty input', () => {
        expect(normalizeText(null)).toBe('');
        expect(normalizeText(undefined)).toBe('');
        expect(normalizeText('')).toBe('');
    });
});

describe('musicBrainzTrackId', () => {
    it('prefers MUSICBRAINZ_TRACKID over the release-track id and lowercases it', () => {
        const tags = {
            MUSICBRAINZ_TRACKID: ['A1B2C3D4-E5F6-7890-ABCD-EF1234567890'],
            MUSICBRAINZ_RELEASETRACKID: ['11111111-2222-3333-4444-555555555555']
        };
        expect(musicBrainzTrackId(tags)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('falls back to MUSICBRAINZ_RELEASETRACKID', () => {
        expect(musicBrainzTrackId({ MUSICBRAINZ_RELEASETRACKID: ['11111111-2222-3333-4444-555555555555'] }))
            .toBe('11111111-2222-3333-4444-555555555555');
    });

    it('ignores values that are not UUIDs', () => {
        expect(musicBrainzTrackId({ MUSICBRAINZ_TRACKID: ['not-a-uuid'] })).toBeNull();
        expect(musicBrainzTrackId({})).toBeNull();
        expect(musicBrainzTrackId(undefined)).toBeNull();
    });
});

describe('computeTrackKey', () => {
    const base = {
        path: '/music/Artist/Album/01 - Title.flac',
        title: 'Title',
        artist: 'Artist',
        albumArtist: '',
        album: 'Album',
        discNumber: 1,
        trackNumber: 1,
        duration: 181.4,
        tags: {}
    };

    it('uses the MusicBrainz id when present', () => {
        const key = computeTrackKey({ ...base, tags: { MUSICBRAINZ_TRACKID: ['A1B2C3D4-E5F6-7890-ABCD-EF1234567890'] } });
        expect(key).toBe('mb:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('builds a normalised metadata key otherwise', () => {
        expect(computeTrackKey(base)).toBe('meta:artist|album|1|1|title');
    });

    it('prefers the album artist over the track artist', () => {
        expect(computeTrackKey({ ...base, albumArtist: 'Various Artists' })).toBe('meta:various artists|album|1|1|title');
    });

    it('does not depend on the duration (encoder padding, MediaStore vs probed values)', () => {
        expect(computeTrackKey({ ...base, duration: 200.99 })).toBe(computeTrackKey({ ...base, duration: 201.0 }));
        expect(computeTrackKey({ ...base, duration: null })).toBe(computeTrackKey({ ...base, duration: 999 }));
        expect(computeTrackKey({ ...base, duration: undefined })).toBe(computeTrackKey(base));
    });

    it('is the same for the same track on two devices with cosmetic differences', () => {
        const a = computeTrackKey({ ...base, path: 'C:\\Music\\a.flac', title: 'Title (feat. Guest)', artist: 'ARTIST', duration: 181.9 });
        const b = computeTrackKey({ ...base, path: '/storage/emulated/0/Music/b.flac', title: 'title', artist: 'Artist', duration: 181.1 });
        expect(a).toBe(b);
    });

    it('differs when the track number or title differs', () => {
        expect(computeTrackKey({ ...base, trackNumber: 2 })).not.toBe(computeTrackKey(base));
        expect(computeTrackKey({ ...base, title: 'Other' })).not.toBe(computeTrackKey(base));
    });

    it('falls back to tags when the derived fields are missing', () => {
        const key = computeTrackKey({
            path: '/x.flac',
            duration: 100,
            tags: { ALBUMARTIST: ['Band'], ALBUM: ['LP'], DISCNUMBER: ['2/3'], TRACKNUMBER: ['07/12'], TITLE: ['Song'] }
        });
        expect(key).toBe('meta:band|lp|2|7|song');
    });

    it('leaves unknown parts empty instead of failing', () => {
        expect(computeTrackKey({ path: '/x.flac' })).toBe('meta:||||');
        expect(computeTrackKey({ path: '/x.flac', duration: null, tags: null })).toBe('meta:||||');
    });
});
