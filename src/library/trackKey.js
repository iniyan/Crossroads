// Stable cross-device identity for a track (#25 sync, #23 playlist import, play history).
//
//   mb:<uuid>                                    when the file carries a MusicBrainz track / release-track id
//   meta:<artist>|<album>|<disc>|<track>|<title>  otherwise
//
// The metadata form is built from normalised text so that the same album ripped on two
// machines (different paths, slightly different tag casing / punctuation) lands on the same
// key. It deliberately contains no audio property (duration, bitrate, ...): those differ
// between encoders and between a MediaStore row and the probed file, and would make the key
// flip once the file is probed.
//
// A song whose details have not been probed yet (`song.provisional`) may still be missing
// ALBUMARTIST / MUSICBRAINZ tags, so its key can change after probing; callers that persist
// keys (play history) wait for the final one, see playHistory.js.

import { firstTag, firstTagOf, parseNumberPair } from './tags.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Song (feat. X)", "Song feat. X", "Song ft X", "Song [featuring X]", "Song - feat. X" -> "Song".
// "feat" / "ft" / "featuring" must be a separate word: preceded by whitespace or an opening
// bracket (optionally with dashes) and followed by whitespace, so "Daft Punk", "Left Behind"
// and "Kraftwerk" are untouched.
const FEAT_RE = /[\s([][\s\-–—([]*(?:feat|ft|featuring)\.?\s+[^()[\]]*[)\]]?\s*$/i;

/**
 * NFKD, lowercase, no diacritics, no punctuation, no "feat." suffix, single spaces.
 * Exported for the views that need fuzzy matching (e.g. playlist import).
 */
export const normalizeText = (value) => {
    if (value === null || value === undefined) return '';
    let text = String(value).normalize('NFKD');
    text = text.replace(/\p{M}+/gu, '');          // combining marks left over from NFKD
    text = text.toLowerCase();
    text = text.replace(FEAT_RE, '');
    text = text.replace(/[^\p{L}\p{N}\s]+/gu, '');  // punctuation and symbols
    text = text.replace(/\s+/g, ' ').trim();
    return text;
};

const positiveInt = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : parseNumberPair(value).number;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * Picks the MusicBrainz id when present. Recording id (MUSICBRAINZ_TRACKID) first, then the
 * release-track id; both are UUIDs.
 */
export const musicBrainzTrackId = (tags) => {
    const id = firstTagOf(tags, ['MUSICBRAINZ_TRACKID', 'MUSICBRAINZ_RELEASETRACKID']);
    if (!id) return null;
    const trimmed = id.trim();
    return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
};

/**
 * @param {Object} song  Needs tags, albumArtist/artist, album, discNumber, trackNumber, title.
 *                       Falls back to the tag values when the derived fields are missing.
 * @returns {string}
 */
export const computeTrackKey = (song) => {
    const tags = song?.tags || {};
    const mbid = musicBrainzTrackId(tags);
    if (mbid) return `mb:${mbid}`;

    const artist = song.albumArtist || firstTag(tags, 'ALBUMARTIST') || song.artist || firstTag(tags, 'ARTIST') || '';
    const album = song.album || firstTag(tags, 'ALBUM') || '';
    const disc = positiveInt(song.discNumber) ?? positiveInt(firstTag(tags, 'DISCNUMBER'));
    const track = positiveInt(song.trackNumber) ?? positiveInt(firstTag(tags, 'TRACKNUMBER'));
    const title = song.title || firstTag(tags, 'TITLE') || '';

    return [
        'meta:' + normalizeText(artist),
        normalizeText(album),
        disc === null ? '' : String(disc),
        track === null ? '' : String(track),
        normalizeText(title)
    ].join('|');
};
