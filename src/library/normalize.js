// Turns whatever a platform scanner returned into the full Song shape (see song.js):
// coerces types, fills common fields from `tags` when the platform left them empty, and
// derives folder, track/disc numbers, year, genre, lyrics presence, quality and trackKey.

import { UNKNOWN_ALBUM, UNKNOWN_ARTIST, isLyricsTagName } from './song.js';
import { canonicalTags, firstTag, firstTagOf, hasTag, parseNumberPair, parseYear } from './tags.js';
import { deriveQuality, resolveFormat, resolveLossless } from './quality.js';
import { computeTrackKey } from './trackKey.js';

const numberOrNull = (value, { integer = false } = {}) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return integer ? Math.round(n) : n;
};

const stringOrEmpty = (value) => (value === null || value === undefined ? '' : String(value).trim());

const boolOrNull = (value) => (value === true || value === false ? value : null);

/** Parent directory of a path, tolerant of both separators. '' when there is none. */
export const parentFolder = (filePath) => {
    const p = String(filePath || '');
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (idx < 0) return '';
    if (idx === 0) return p.slice(0, 1);
    return p.slice(0, idx);
};

const fileName = (filePath) => {
    const p = String(filePath || '');
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx < 0 ? p : p.slice(idx + 1);
};

const stripExtension = (name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * True when any lyrics-carrying tag (LYRICS, UNSYNCEDLYRICS, SYNCEDLYRICS, plus the
 * language-suffixed variants some taggers write: LYRICS:ENG, UNSYNCEDLYRICS-XXX) has a value.
 */
export const hasLyricsTag = (tags) =>
    Object.keys(tags || {}).some(name => isLyricsTagName(name) && hasTag(tags, name));

/** The tags map without lyrics values (what the bulk library payload carries). */
export const withoutLyricsTags = (tags) => {
    const out = {};
    for (const name of Object.keys(tags || {})) {
        if (!isLyricsTagName(name)) out[name] = tags[name];
    }
    return out;
};

const md5OrNull = (value) => {
    if (typeof value !== 'string') return null;
    const hex = value.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex) || /^0{32}$/.test(hex)) return null;
    return hex;
};

/**
 * Track / disc numbers: the platform's explicit field wins (a number, or a '7/12' style
 * string as MediaStore reports disc numbers), else the tag; TRACKTOTAL / DISCTOTAL /
 * TOTALTRACKS / TOTALDISCS and the '/12' part fill the totals.
 */
const resolveNumbering = (raw, tags, numberField, numberTags, totalField, totalTags) => {
    const fromField = parseNumberPair(raw[numberField]);
    const fromTag = parseNumberPair(firstTagOf(tags, numberTags));
    const number = fromField.number ?? fromTag.number;
    const total = numberOrNull(raw[totalField], { integer: true })
        ?? fromField.total
        ?? numberOrNull(firstTagOf(tags, totalTags), { integer: true })
        ?? fromTag.total;
    return { number: number && number > 0 ? number : null, total: total && total > 0 ? total : null };
};

/**
 * @param {Object} raw  A platform result (see song.js for the fields scanners provide).
 * @returns {import('./song').Song}
 */
export const normalizeSong = (raw) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const path = stringOrEmpty(source.path);
    const tags = canonicalTags(source.tags);
    const folder = stringOrEmpty(source.folder) || parentFolder(path);

    const codec = stringOrEmpty(source.codec) || null;
    const format = resolveFormat(source.format, codec);
    const lossless = resolveLossless(boolOrNull(source.lossless), format, codec);

    const title = stringOrEmpty(source.title) || firstTag(tags, 'TITLE') || stripExtension(fileName(path));
    const artist = stringOrEmpty(source.artist) || firstTag(tags, 'ARTIST') || UNKNOWN_ARTIST;
    const albumArtist = stringOrEmpty(source.albumArtist) || firstTagOf(tags, ['ALBUMARTIST', 'ALBUM ARTIST']) || '';
    const album = stringOrEmpty(source.album) || firstTag(tags, 'ALBUM') || fileName(folder) || UNKNOWN_ALBUM;
    const composer = stringOrEmpty(source.composer) || firstTag(tags, 'COMPOSER') || '';
    const genre = stringOrEmpty(source.genre) || firstTag(tags, 'GENRE') || null;
    const year = numberOrNull(source.year, { integer: true })
        || parseYear(firstTagOf(tags, ['DATE', 'YEAR', 'ORIGINALDATE', 'ORIGINALYEAR']));

    const track = resolveNumbering(source, tags, 'trackNumber', ['TRACKNUMBER', 'TRACK'], 'trackTotal', ['TRACKTOTAL', 'TOTALTRACKS']);
    const disc = resolveNumbering(source, tags, 'discNumber', ['DISCNUMBER', 'DISC'], 'discTotal', ['DISCTOTAL', 'TOTALDISCS']);

    const hasEmbeddedLyrics = source.hasEmbeddedLyrics === true || hasLyricsTag(tags);

    const song = {
        path,
        folder,
        trackKey: '',
        fileSize: numberOrNull(source.fileSize, { integer: true }),
        mtime: numberOrNull(source.mtime, { integer: true }),

        title,
        artist,
        album,
        albumArtist,
        composer,
        genre,
        year: year || null,
        trackNumber: track.number,
        trackTotal: track.total,
        discNumber: disc.number,
        discTotal: disc.total,
        tags,
        hasEmbeddedLyrics,

        duration: numberOrNull(source.duration),
        format,
        codec,
        lossless,
        bitrate: numberOrNull(source.bitrate, { integer: true }),
        sampleRate: numberOrNull(source.sampleRate, { integer: true }),
        bitsPerSample: numberOrNull(source.bitsPerSample, { integer: true }),
        channels: numberOrNull(source.channels, { integer: true }),
        totalSamples: numberOrNull(source.totalSamples, { integer: true }),
        md5: md5OrNull(source.md5),
        quality: { tier: 'unknown', label: format },

        picture: typeof source.picture === 'string' && source.picture ? source.picture : null,
        // Platform passthroughs (see song.js): the un-converted picture URI the Android media
        // session needs, and whether the row is still waiting for its probe.
        rawPicture: typeof source.rawPicture === 'string' && source.rawPicture ? source.rawPicture : null,
        provisional: source.provisional === true
    };

    song.quality = deriveQuality(song);
    song.trackKey = stringOrEmpty(source.trackKey) || computeTrackKey(song);
    return song;
};

/** Normalises a whole scan result, dropping entries without a path. */
export const normalizeSongs = (list) =>
    (Array.isArray(list) ? list : [])
        .filter(item => item && typeof item === 'object' && item.path)
        .map(normalizeSong);
