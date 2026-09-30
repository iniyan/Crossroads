// MusicBrainz lookup (#20): release search, release fetch, matching a local album against
// a release's track list and the tags to write for a match.
//
// ws/2 JSON. Requests go through one queue with at least `minIntervalMs` (1.1 s) between
// them, so the app stays under the 1 req/s limit; a 503 is retried with backoff. Browsers
// cannot set User-Agent, so the app identifies itself via the Electron main process (which
// sets the header for musicbrainz.org) and otherwise only with `fmt=json`.

import { normalizeText } from './trackKey.js';

export const MB_BASE = 'https://musicbrainz.org/ws/2';
export const APP_IDENTIFIER = 'Crossroads/1.0 (https://github.com/iniyan/Crossroads)';

const DEFAULT_MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [2000, 4000, 8000];

// Lucene special characters in a quoted phrase: only quotes and backslashes need escaping.
const escapePhrase = (value) => String(value).replace(/[\\"]/g, '\\$&');

/**
 * The search query for a release: album title, artist and, when known, track count.
 * Values are quoted phrases so punctuation in titles is harmless.
 */
export const buildReleaseQuery = ({ album, artist, trackCount }) => {
    const parts = [];
    if (album) parts.push(`release:"${escapePhrase(album)}"`);
    if (artist) parts.push(`artist:"${escapePhrase(artist)}"`);
    if (Number.isInteger(trackCount) && trackCount > 0) parts.push(`tracks:${trackCount}`);
    return parts.join(' AND ');
};

const artistCreditName = (credits) => (Array.isArray(credits) ? credits : [])
    .map(c => `${c.name || c.artist?.name || ''}${c.joinphrase || ''}`).join('').trim();

const artistCreditIds = (credits) => (Array.isArray(credits) ? credits : [])
    .map(c => c.artist?.id).filter(Boolean);

/** A search hit or full release, reduced to what the UI and the tag mapper need. */
export const mapRelease = (release) => {
    if (!release || typeof release !== 'object') return null;
    const media = (Array.isArray(release.media) ? release.media : []).map((medium, i) => ({
        position: Number.isInteger(medium.position) ? medium.position : i + 1,
        format: medium.format || null,
        title: medium.title || null,
        trackCount: Number.isInteger(medium['track-count']) ? medium['track-count'] : (Array.isArray(medium.tracks) ? medium.tracks.length : 0),
        tracks: (Array.isArray(medium.tracks) ? medium.tracks : []).map((track, j) => ({
            id: track.id || null,
            recordingId: track.recording?.id || null,
            position: Number.isInteger(track.position) ? track.position : j + 1,
            number: track.number || String(j + 1),
            title: track.title || track.recording?.title || '',
            length: Number.isFinite(track.length) ? track.length / 1000 : (Number.isFinite(track.recording?.length) ? track.recording.length / 1000 : null),
            artist: artistCreditName(track['artist-credit'] || track.recording?.['artist-credit']) || null,
            artistIds: artistCreditIds(track['artist-credit'] || track.recording?.['artist-credit'])
        }))
    }));
    const trackCount = media.reduce((n, m) => n + (m.trackCount || 0), 0);
    return {
        id: release.id,
        title: release.title || '',
        artist: artistCreditName(release['artist-credit']),
        artistIds: artistCreditIds(release['artist-credit']),
        releaseGroupId: release['release-group']?.id || null,
        date: release.date || null,
        country: release.country || null,
        status: release.status || null,
        label: release['label-info']?.[0]?.label?.name || null,
        catalogNumber: release['label-info']?.[0]?.['catalog-number'] || null,
        barcode: release.barcode || null,
        disambiguation: release.disambiguation || null,
        score: Number.isFinite(release.score) ? release.score : null,
        trackCount,
        media
    };
};

/**
 * @param {Object} [opts]
 * @param {Function} [opts.fetch]          fetch implementation (default: globalThis.fetch)
 * @param {number} [opts.minIntervalMs]
 * @param {Function} [opts.sleep]          (ms) => Promise, injectable for tests
 * @param {string} [opts.base]
 */
export const createMusicBrainzClient = ({ fetch: fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = DEFAULT_MIN_INTERVAL_MS, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), base = MB_BASE } = {}) => {
    let chain = Promise.resolve();
    let lastRequestAt = null;

    const request = (url, signal) => {
        const run = async () => {
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                const wait = lastRequestAt === null ? 0 : lastRequestAt + minIntervalMs - now();
                if (wait > 0) await sleep(wait);
                lastRequestAt = now();
                const response = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
                if (response.status === 503 || response.status === 429) {
                    if (attempt === MAX_ATTEMPTS - 1) throw new Error('MusicBrainz is rate limiting requests; try again in a moment');
                    const retryAfter = Number(response.headers?.get?.('retry-after'));
                    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
                    continue;
                }
                if (response.status === 404) return null;
                if (!response.ok) throw new Error(`MusicBrainz request failed (${response.status})`);
                return response.json();
            }
            return null;
        };
        const result = chain.then(run, run);
        chain = result.catch(() => {});
        return result;
    };

    return {
        /** Releases matching album / artist / track count, best score first. */
        searchReleases: async ({ album, artist, trackCount, limit = 10 } = {}, { signal } = {}) => {
            const query = buildReleaseQuery({ album, artist, trackCount });
            if (!query) return [];
            const url = `${base}/release/?query=${encodeURIComponent(query)}&limit=${limit}&fmt=json`;
            const data = await request(url, signal);
            return (data?.releases || []).map(mapRelease).filter(Boolean);
        },
        /** The full release with its media, tracks, recordings and artist credits. */
        getRelease: async (id, { signal } = {}) => {
            if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Invalid MusicBrainz release id');
            const url = `${base}/release/${id}?inc=recordings+artist-credits+release-groups+labels&fmt=json`;
            const data = await request(url, signal);
            return data ? mapRelease(data) : null;
        }
    };
};

// --- matching ---------------------------------------------------------------------------------

const DURATION_WARN_S = 5;

const flatTracks = (release) => {
    const out = [];
    for (const medium of release?.media || []) {
        for (const track of medium.tracks) out.push({ ...track, disc: medium.position, discTrackCount: medium.tracks.length || medium.trackCount });
    }
    return out;
};

/**
 * Pairs local songs with the release's tracks: by disc + track number when the local files
 * carry numbers, else by normalised title. Songs left over stay 'unmatched' (and the
 * release's spare tracks 'extra') unless `pairLeftoversByOrder` is set, in which case the
 * leftovers are paired in order (an explicit opt-in: order is a guess). Every pairing carries
 * a status so the UI can show a diff.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.pairLeftoversByOrder=false]
 * @returns {{ rows: {song:Object|null, track:Object|null, status:'match'|'title'|'duration'|'unmatched'|'extra', durationDelta:number|null}[],
 *             matched:number, total:number, discCount:number }}
 */
export const matchTracks = (songs, release, { pairLeftoversByOrder = false } = {}) => {
    const remote = flatTracks(release);
    const discCount = (release?.media || []).length;
    const used = new Set();
    const rows = [];
    const list = (Array.isArray(songs) ? songs : []).slice().sort((a, b) =>
        ((a.discNumber || 1) - (b.discNumber || 1)) || ((a.trackNumber || 0) - (b.trackNumber || 0)) || String(a.path).localeCompare(String(b.path)));

    const take = (track) => { used.add(track); return track; };
    for (const song of list) {
        let track = null;
        if (song.trackNumber) {
            const disc = song.discNumber || 1;
            track = remote.find(t => !used.has(t) && t.disc === disc && t.position === song.trackNumber) || null;
            // A single-disc library of a multi-disc release: allow position-only when disc numbers are absent.
            if (!track && !song.discNumber && discCount > 1) track = remote.find(t => !used.has(t) && t.position === song.trackNumber) || null;
        }
        if (!track && song.title) {
            const wanted = normalizeText(song.title);
            track = remote.find(t => !used.has(t) && normalizeText(t.title) === wanted) || null;
        }
        if (track) take(track);
        rows.push({ song, track });
    }
    // Leftovers by order, only when asked to.
    if (pairLeftoversByOrder) {
        const free = remote.filter(t => !used.has(t));
        for (const row of rows) {
            if (!row.track && free.length) row.track = take(free.shift());
        }
    }
    let matched = 0;
    const result = rows.map(({ song, track }) => {
        if (!track) return { song, track: null, status: 'unmatched', durationDelta: null };
        const durationDelta = Number.isFinite(song.duration) && Number.isFinite(track.length) ? Math.round(song.duration - track.length) : null;
        let status = 'match';
        if (song.title && normalizeText(song.title) !== normalizeText(track.title)) status = 'title';
        else if (durationDelta !== null && Math.abs(durationDelta) > DURATION_WARN_S) status = 'duration';
        if (status === 'match') matched++;
        return { song, track, status, durationDelta };
    });
    for (const track of remote) if (!used.has(track)) result.push({ song: null, track, status: 'extra', durationDelta: null });
    return { rows: result, matched, total: list.length, discCount };
};

/** Statuses that need the user's explicit opt-in before their tags are written. */
export const OPT_IN_STATUSES = Object.freeze(['title', 'duration']);

/**
 * The rows of matchTracks() whose tags may be written: exact matches always, 'title' /
 * 'duration' rows only when their song's path is in `optIn`, never unmatched or extra rows.
 * @param {Object[]} rows
 * @param {Set<string>|string[]} [optIn]   paths of the songs the user opted in
 */
export const selectRowsToApply = (rows, optIn = new Set()) => {
    const chosen = optIn instanceof Set ? optIn : new Set(optIn || []);
    return (Array.isArray(rows) ? rows : []).filter(r => r.song && r.track
        && (r.status === 'match' || (OPT_IN_STATUSES.includes(r.status) && chosen.has(r.song.path))));
};

/**
 * The tag operations for one matched track.
 * @param {Object} release  from mapRelease()
 * @param {Object} track    an entry of release.media[].tracks (with .disc from matchTracks)
 * @param {Object} [opts]
 * @param {boolean} [opts.titles=true]    also write TITLE / ARTIST from the release
 * @param {boolean} [opts.album=true]     also write ALBUM / ALBUMARTIST / DATE / label
 */
export const tagsForTrack = (release, track, { titles = true, album = true } = {}) => {
    const medium = (release.media || []).find(m => m.position === track.disc) || null;
    const set = {
        MUSICBRAINZ_ALBUMID: release.id,
        MUSICBRAINZ_RELEASETRACKID: track.id,
        MUSICBRAINZ_TRACKID: track.recordingId,
        MUSICBRAINZ_ARTISTID: track.artistIds?.length ? track.artistIds : release.artistIds,
        MUSICBRAINZ_ALBUMARTISTID: release.artistIds,
        MUSICBRAINZ_RELEASEGROUPID: release.releaseGroupId,
        TRACKNUMBER: String(track.position),
        TRACKTOTAL: String(medium?.tracks?.length || medium?.trackCount || ''),
        DISCNUMBER: String(track.disc || 1),
        DISCTOTAL: String((release.media || []).length || 1)
    };
    if (album) {
        Object.assign(set, {
            ALBUM: release.title,
            ALBUMARTIST: release.artist,
            DATE: release.date,
            LABEL: release.label,
            CATALOGNUMBER: release.catalogNumber,
            RELEASECOUNTRY: release.country,
            RELEASESTATUS: release.status ? release.status.toLowerCase() : null,
            BARCODE: release.barcode
        });
    }
    if (titles) {
        set.TITLE = track.title;
        set.ARTIST = track.artist || release.artist;
    }
    const clean = {};
    for (const [key, value] of Object.entries(set)) {
        const values = (Array.isArray(value) ? value : [value]).filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(String);
        if (values.length) clean[key] = values;
    }
    return { set: clean, remove: [] };
};
