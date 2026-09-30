import { describe, expect, it, vi } from 'vitest';
import { buildReleaseQuery, createMusicBrainzClient, mapRelease, matchTracks, tagsForTrack, selectRowsToApply, OPT_IN_STATUSES } from '../musicbrainz.js';

const jsonResponse = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body
});

const RELEASE = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'OK Computer',
    date: '1997-05-21',
    country: 'GB',
    status: 'Official',
    barcode: '724385522925',
    'release-group': { id: 'rg-1' },
    'artist-credit': [{ name: 'Radiohead', artist: { id: 'art-1', name: 'Radiohead' } }],
    'label-info': [{ label: { name: 'Parlophone' }, 'catalog-number': 'NODATA 02' }],
    media: [{
        position: 1, format: 'CD', 'track-count': 3,
        tracks: [
            { id: 't1', position: 1, number: '1', title: 'Airbag', length: 284000, recording: { id: 'r1' } },
            { id: 't2', position: 2, number: '2', title: 'Paranoid Android', length: 383000, recording: { id: 'r2' } },
            { id: 't3', position: 3, number: '3', title: 'Subterranean Homesick Alien', length: 267000, recording: { id: 'r3' },
              'artist-credit': [{ name: 'Radiohead', artist: { id: 'art-1' } }, { name: 'Guest', joinphrase: '', artist: { id: 'art-2' } }] }
        ]
    }]
};

describe('buildReleaseQuery', () => {
    it('quotes and escapes values and adds the track count', () => {
        expect(buildReleaseQuery({ album: 'OK "Computer"', artist: 'Radio\\head', trackCount: 12 }))
            .toBe('release:"OK \\"Computer\\"" AND artist:"Radio\\\\head" AND tracks:12');
        expect(buildReleaseQuery({ album: 'X' })).toBe('release:"X"');
        expect(buildReleaseQuery({})).toBe('');
    });
});

describe('createMusicBrainzClient', () => {
    it('spaces requests at least minIntervalMs apart and asks for JSON', async () => {
        let t = 0;
        const sleeps = [];
        const fetch = vi.fn(async () => jsonResponse({ releases: [RELEASE] }));
        const client = createMusicBrainzClient({ fetch, minIntervalMs: 1000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
        const [a, b] = await Promise.all([
            client.searchReleases({ album: 'OK Computer', artist: 'Radiohead', trackCount: 12 }),
            client.searchReleases({ album: 'Kid A' })
        ]);
        expect(a[0].id).toBe(RELEASE.id);
        expect(b).toHaveLength(1);
        expect(sleeps).toEqual([1000]);
        const url = fetch.mock.calls[0][0];
        expect(url).toContain('/ws/2/release/?query=');
        expect(url).toContain('fmt=json');
        expect(decodeURIComponent(url)).toContain('release:"OK Computer" AND artist:"Radiohead" AND tracks:12');
        expect(fetch.mock.calls[0][1].headers.Accept).toBe('application/json');
    });

    it('retries 503 with backoff, honouring Retry-After, then gives up', async () => {
        const sleeps = [];
        const fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse({}, 503, { 'retry-after': '3' }))
            .mockResolvedValueOnce(jsonResponse(RELEASE));
        const client = createMusicBrainzClient({ fetch, minIntervalMs: 0, sleep: async (ms) => { sleeps.push(ms); } });
        const release = await client.getRelease(RELEASE.id);
        expect(release.title).toBe('OK Computer');
        expect(sleeps).toEqual([2000, 3000]);

        const always503 = createMusicBrainzClient({ fetch: async () => jsonResponse({}, 503), minIntervalMs: 0, sleep: async () => {} });
        await expect(always503.getRelease(RELEASE.id)).rejects.toThrow(/rate limiting/);
    });

    it('returns null for 404, throws for other errors and rejects bad ids', async () => {
        const client = createMusicBrainzClient({ fetch: async () => jsonResponse({}, 404), minIntervalMs: 0 });
        expect(await client.getRelease(RELEASE.id)).toBeNull();
        const failing = createMusicBrainzClient({ fetch: async () => jsonResponse({}, 500), minIntervalMs: 0 });
        await expect(failing.searchReleases({ album: 'x' })).rejects.toThrow(/500/);
        await expect(client.getRelease('nope')).rejects.toThrow(/Invalid/);
    });

    it('keeps the queue alive after a failure', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({}, 500)).mockResolvedValueOnce(jsonResponse({ releases: [] }));
        const client = createMusicBrainzClient({ fetch, minIntervalMs: 0 });
        await expect(client.searchReleases({ album: 'a' })).rejects.toThrow();
        expect(await client.searchReleases({ album: 'b' })).toEqual([]);
    });
});

describe('mapRelease', () => {
    it('reduces a release to the fields the UI needs', () => {
        const r = mapRelease(RELEASE);
        expect(r).toMatchObject({
            id: RELEASE.id, title: 'OK Computer', artist: 'Radiohead', artistIds: ['art-1'], releaseGroupId: 'rg-1',
            date: '1997-05-21', country: 'GB', status: 'Official', label: 'Parlophone', catalogNumber: 'NODATA 02', trackCount: 3
        });
        expect(r.media[0].tracks[0]).toEqual({ id: 't1', recordingId: 'r1', position: 1, number: '1', title: 'Airbag', length: 284, artist: null, artistIds: [] });
        expect(r.media[0].tracks[2].artist).toBe('RadioheadGuest');
        expect(r.media[0].tracks[2].artistIds).toEqual(['art-1', 'art-2']);
        expect(mapRelease(null)).toBeNull();
    });
});

describe('matchTracks', () => {
    const release = mapRelease(RELEASE);

    it('pairs by track number and reports title / duration differences', () => {
        const songs = [
            { path: '/a/1.flac', trackNumber: 1, title: 'Airbag', duration: 284 },
            { path: '/a/2.flac', trackNumber: 2, title: 'Paranoid Android (live)', duration: 383 },
            { path: '/a/3.flac', trackNumber: 3, title: 'Subterranean Homesick Alien', duration: 300 }
        ];
        const m = matchTracks(songs, release);
        expect(m.rows.map(r => [r.track?.id, r.status, r.durationDelta])).toEqual([
            ['t1', 'match', 0], ['t2', 'title', 0], ['t3', 'duration', 33]
        ]);
        expect(m.matched).toBe(1);
        expect(m.total).toBe(3);
    });

    it('falls back to titles; leftovers stay unmatched and the release\'s spare tracks are extra', () => {
        const songs = [
            { path: '/a/x.flac', title: 'Paranoid Android', duration: 383 },
            { path: '/a/y.flac', title: 'Unknown', duration: 100 }
        ];
        const m = matchTracks(songs, release);
        expect(m.rows.map(r => [r.song?.path ?? null, r.track?.id ?? null, r.status])).toEqual([
            ['/a/x.flac', 't2', 'match'],
            ['/a/y.flac', null, 'unmatched'],
            [null, 't1', 'extra'],
            [null, 't3', 'extra']
        ]);
        expect(m.matched).toBe(1);
    });

    it('pairs leftovers by order only when asked to', () => {
        const songs = [
            { path: '/a/x.flac', title: 'Paranoid Android', duration: 383 },
            { path: '/a/y.flac', title: 'Unknown', duration: 100 }
        ];
        const m = matchTracks(songs, release, { pairLeftoversByOrder: true });
        expect(m.rows.map(r => [r.song?.path ?? null, r.track?.id, r.status])).toEqual([
            ['/a/x.flac', 't2', 'match'],
            ['/a/y.flac', 't1', 'title'],
            [null, 't3', 'extra']
        ]);
        // A bonus track without a number never steals a release track by order unless asked.
        const bonus = [
            { path: '/a/1.flac', trackNumber: 1, title: 'Airbag', duration: 284 },
            { path: '/a/bonus.flac', trackNumber: null, title: 'Bonus Live Track', duration: 300 }
        ];
        expect(matchTracks(bonus, release).rows.find(r => r.song?.path === '/a/bonus.flac')).toMatchObject({ track: null, status: 'unmatched' });
        expect(matchTracks(bonus, release, { pairLeftoversByOrder: true }).rows.find(r => r.song?.path === '/a/bonus.flac')).toMatchObject({ status: 'title' });
    });

    it('marks songs unmatched when the release has fewer tracks', () => {
        const songs = [1, 2, 3, 4].map(n => ({ path: `/a/${n}.flac`, trackNumber: n, title: `Song ${n}`, duration: 10 }));
        const m = matchTracks(songs, release);
        expect(m.rows[3]).toMatchObject({ track: null, status: 'unmatched' });
    });
});

describe('selectRowsToApply', () => {
    const t = (id) => ({ id });
    const rows = [
        { song: { path: '/m' }, track: t('a'), status: 'match' },
        { song: { path: '/t' }, track: t('b'), status: 'title' },
        { song: { path: '/d' }, track: t('c'), status: 'duration' },
        { song: { path: '/u' }, track: null, status: 'unmatched' },
        { song: null, track: t('e'), status: 'extra' }
    ];

    it('applies exact matches only by default', () => {
        expect(selectRowsToApply(rows).map(r => r.song.path)).toEqual(['/m']);
        expect(OPT_IN_STATUSES).toEqual(['title', 'duration']);
    });

    it('adds opted-in title / length mismatches, never unmatched or extra rows', () => {
        expect(selectRowsToApply(rows, new Set(['/t', '/u', '/x'])).map(r => r.song.path)).toEqual(['/m', '/t']);
        expect(selectRowsToApply(rows, ['/d', '/t']).map(r => r.song.path)).toEqual(['/m', '/t', '/d']);
        expect(selectRowsToApply(rows, ['/u']).some(r => r.status === 'unmatched')).toBe(false);
        expect(selectRowsToApply(null)).toEqual([]);
    });
});

describe('tagsForTrack', () => {
    const release = mapRelease(RELEASE);
    const track = { ...release.media[0].tracks[2], disc: 1 };

    it('writes the MusicBrainz ids, numbering and album/track fields', () => {
        const { set, remove } = tagsForTrack(release, track);
        expect(remove).toEqual([]);
        expect(set).toEqual({
            MUSICBRAINZ_ALBUMID: [RELEASE.id],
            MUSICBRAINZ_RELEASETRACKID: ['t3'],
            MUSICBRAINZ_TRACKID: ['r3'],
            MUSICBRAINZ_ARTISTID: ['art-1', 'art-2'],
            MUSICBRAINZ_ALBUMARTISTID: ['art-1'],
            MUSICBRAINZ_RELEASEGROUPID: ['rg-1'],
            TRACKNUMBER: ['3'], TRACKTOTAL: ['3'], DISCNUMBER: ['1'], DISCTOTAL: ['1'],
            ALBUM: ['OK Computer'], ALBUMARTIST: ['Radiohead'], DATE: ['1997-05-21'], LABEL: ['Parlophone'],
            CATALOGNUMBER: ['NODATA 02'], RELEASECOUNTRY: ['GB'], RELEASESTATUS: ['official'], BARCODE: ['724385522925'],
            TITLE: ['Subterranean Homesick Alien'], ARTIST: ['RadioheadGuest']
        });
    });

    it('can leave titles and album fields alone', () => {
        const { set } = tagsForTrack(release, { ...release.media[0].tracks[0], disc: 1 }, { titles: false, album: false });
        expect(Object.keys(set).sort()).toEqual(['DISCNUMBER', 'DISCTOTAL', 'MUSICBRAINZ_ALBUMARTISTID', 'MUSICBRAINZ_ALBUMID',
            'MUSICBRAINZ_ARTISTID', 'MUSICBRAINZ_RELEASEGROUPID', 'MUSICBRAINZ_RELEASETRACKID', 'MUSICBRAINZ_TRACKID', 'TRACKNUMBER', 'TRACKTOTAL']);
        expect(set.MUSICBRAINZ_ARTISTID).toEqual(['art-1']); // falls back to the release artist
    });
});
