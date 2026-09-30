import { describe, expect, it } from 'vitest';
import { canonicalDescription, flattenNativeTags, lrcTimestamp, syncedLyricsLines, valueStrings } from '../tagMapper.js';

describe('canonicalDescription', () => {
    it('maps MusicBrainz / Picard descriptions to Vorbis names', () => {
        expect(canonicalDescription('MusicBrainz Album Id')).toBe('MUSICBRAINZ_ALBUMID');
        expect(canonicalDescription('MusicBrainz Release Track Id')).toBe('MUSICBRAINZ_RELEASETRACKID');
        expect(canonicalDescription('Acoustid Id')).toBe('ACOUSTID_ID');
        expect(canonicalDescription('replaygain_track_gain')).toBe('REPLAYGAIN_TRACK_GAIN');
        expect(canonicalDescription('Album Artist')).toBe('ALBUMARTIST');
    });

    it('uppercases everything else with underscores for spaces', () => {
        expect(canonicalDescription('My Custom Tag')).toBe('MY_CUSTOM_TAG');
        expect(canonicalDescription('')).toBeNull();
    });
});

describe('valueStrings', () => {
    it('flattens scalars, arrays, text objects and people lists', () => {
        expect(valueStrings('a')).toEqual(['a']);
        expect(valueStrings(3)).toEqual(['3']);
        expect(valueStrings(['a', ['b', 'c']])).toEqual(['a', 'b', 'c']);
        expect(valueStrings({ language: 'eng', description: '', text: 'lyrics' })).toEqual(['lyrics']);
        expect(valueStrings({ producer: ['P One', 'P Two'], engineer: ['E'] })).toEqual(['producer: P One', 'producer: P Two', 'engineer: E']);
        expect(valueStrings(Buffer.from('x'))).toEqual([]);
        expect(valueStrings(null)).toEqual([]);
    });
});

describe('flattenNativeTags', () => {
    it('keeps vorbis comments as-is (uppercased), merging repeated keys', () => {
        const tags = flattenNativeTags({
            vorbis: [
                { id: 'TITLE', value: 'T' },
                { id: 'artist', value: 'A' },
                { id: 'PERFORMER', value: 'Violin: X' },
                { id: 'PERFORMER', value: 'Cello: Y' },
                { id: 'METADATA_BLOCK_PICTURE', value: { format: 'image/png', data: Buffer.alloc(4) } }
            ]
        });
        expect(tags).toEqual({ TITLE: ['T'], ARTIST: ['A'], PERFORMER: ['Violin: X', 'Cello: Y'] });
    });

    it('maps ID3v2.4 frames, TXXX, USLT, UFID and skips APIC', () => {
        const tags = flattenNativeTags({
            'ID3v2.4': [
                { id: 'TIT2', value: 'Song' },
                { id: 'TPE2', value: 'AA' },
                { id: 'TPE3', value: 'Cond' },
                { id: 'TRCK', value: '5/10' },
                { id: 'TDRC', value: '2001' },
                { id: 'TXXX:MusicBrainz Album Id', value: { description: 'MusicBrainz Album Id', text: ['1111'] } },
                { id: 'TXXX:WORK', value: { description: 'WORK', text: ['Symphony'] } },
                { id: 'USLT', value: [{ language: 'eng', description: '', text: 'la la' }] },
                { id: 'COMM', value: [{ language: 'eng', description: '', text: 'note' }] },
                { id: 'UFID', value: { owner_identifier: 'http://musicbrainz.org', identifier: Buffer.from('a1b2') } },
                { id: 'APIC', value: { format: 'image/png', data: Buffer.alloc(8) } },
                { id: 'TIPL', value: { producer: ['P'] } },
                { id: 'POPM', value: { email: 'x', rating: 196 } }
            ]
        });
        expect(tags).toEqual({
            TITLE: ['Song'], ALBUMARTIST: ['AA'], CONDUCTOR: ['Cond'], TRACKNUMBER: ['5/10'], DATE: ['2001'],
            MUSICBRAINZ_ALBUMID: ['1111'], WORK: ['Symphony'], UNSYNCEDLYRICS: ['la la'], COMMENT: ['note'],
            MUSICBRAINZ_TRACKID: ['a1b2'], INVOLVEDPEOPLE: ['producer: P'], RATING: ['196']
        });
    });

    it('maps iTunes atoms including freeform ---- entries', () => {
        const tags = flattenNativeTags({
            iTunes: [
                { id: '©nam', value: 'Song' },
                { id: 'aART', value: 'AA' },
                { id: 'trkn', value: '3/9' },
                { id: '©wrk', value: 'Work' },
                { id: '©mvn', value: 'Mvt' },
                { id: '©lyr', value: 'lyrics' },
                { id: '----:com.apple.iTunes:MusicBrainz Track Id', value: 'uuid' },
                { id: '----:com.apple.iTunes:CONDUCTOR', value: 'C' },
                { id: 'covr', value: { format: 'image/jpeg', data: Buffer.alloc(2) } }
            ]
        });
        expect(tags).toEqual({
            TITLE: ['Song'], ALBUMARTIST: ['AA'], TRACKNUMBER: ['3/9'], WORK: ['Work'], MOVEMENTNAME: ['Mvt'],
            UNSYNCEDLYRICS: ['lyrics'], MUSICBRAINZ_TRACKID: ['uuid'], CONDUCTOR: ['C']
        });
    });

    it('maps RIFF INFO chunks and APE keys', () => {
        expect(flattenNativeTags({ exif: [{ id: 'INAM', value: 'T' }, { id: 'IART', value: 'A' }, { id: 'ITRK', value: '3' }] }))
            .toEqual({ TITLE: ['T'], ARTIST: ['A'], TRACKNUMBER: ['3'] });
        expect(flattenNativeTags({ APEv2: [{ id: 'Title', value: 'T' }, { id: 'Track', value: '4' }, { id: 'Album Artist', value: 'AA' }] }))
            .toEqual({ TITLE: ['T'], TRACKNUMBER: ['4'], ALBUMARTIST: ['AA'] });
    });

    it('uses ID3v1 only when nothing else is present', () => {
        expect(flattenNativeTags({ ID3v1: [{ id: 'title', value: 'Old' }] })).toEqual({ TITLE: ['Old'] });
        expect(flattenNativeTags({ ID3v1: [{ id: 'title', value: 'Old' }], 'ID3v2.3': [{ id: 'TIT2', value: 'New' }] })).toEqual({ TITLE: ['New'] });
    });

    it('flattens SYLT into LRC lines like the Android reader', () => {
        const structured = { language: 'eng', timeStampFormat: 2, contentType: 1, syncText: [
            { text: 'First line', timeStamp: 1500 }, { text: '\nSecond', timeStamp: 61230 }
        ] };
        expect(flattenNativeTags({ 'ID3v2.4': [{ id: 'SYLT', value: structured }] }))
            .toEqual({ SYNCEDLYRICS: ['[00:01.50]First line\n[01:01.23]Second'] });
        // Nested in an array, as music-metadata lists repeated frames.
        expect(flattenNativeTags({ 'ID3v2.3': [{ id: 'SYLT', value: [structured] }] }))
            .toEqual({ SYNCEDLYRICS: ['[00:01.50]First line\n[01:01.23]Second'] });
        // MPEG-frame timestamps cannot be turned into times: text only.
        expect(syncedLyricsLines({ timeStampFormat: 1, syncText: [{ text: 'x', timeStamp: 40 }] })).toEqual(['x']);
        // Older music-metadata: a plain array of the text pieces.
        expect(flattenNativeTags({ 'ID3v2.4': [{ id: 'SYLT', value: ['a', 'b'] }] })).toEqual({ SYNCEDLYRICS: ['a\nb'] });
        expect(lrcTimestamp(0)).toBe('[00:00.00]');
        expect(lrcTimestamp(3_599_999)).toBe('[59:59.99]');
    });

    it('survives junk input', () => {
        expect(flattenNativeTags(null)).toEqual({});
        expect(flattenNativeTags({ vorbis: 'nope', 'ID3v2.3': [null, { id: 5 }, { id: 'TIT2' }] })).toEqual({});
    });
});
