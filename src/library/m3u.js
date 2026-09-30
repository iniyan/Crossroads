// M3U / M3U8 playlists (#23): parse, serialize and resolve entries against the library.
//
// Export writes UTF-8 with an #EXTM3U header, one "#EXTINF:<seconds>,<Artist> - <Title>"
// per track and, as a comment other players ignore, "#CROSSROADS-KEY:<trackKey>" so an
// import on another device can match tracks even when paths differ. Paths are relative
// to the playlist file when both the playlist and the track live inside the music root,
// absolute otherwise (forward slashes in relative paths).
//
// Import resolves each entry, in order: exact path, path relative to the playlist file,
// path relative to the music root, the CROSSROADS-KEY, then metadata ("Artist - Title" from
// EXTINF via trackKey.normalizeText, duration as a tie-breaker), and finally a unique file
// name. Unmatched entries are reported.

import { normalizeText } from './trackKey.js';

const DURATION_TOLERANCE_S = 3;

// --- paths (no Node `path`: the renderer runs this) --------------------------------------------

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/** Forward slashes, "." / ".." resolved where possible. Keeps a leading "/" or drive. */
export const normalizePath = (p) => {
    let text = String(p || '').replace(/\\/g, '/');
    const unc = text.startsWith('//');
    let drive = '';
    const driveMatch = /^([a-zA-Z]:)\//.exec(text);
    if (driveMatch) { drive = driveMatch[1]; text = text.slice(2); }
    const absolute = text.startsWith('/');
    const out = [];
    for (const seg of text.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!absolute) out.push('..');
            continue;
        }
        out.push(seg);
    }
    const body = out.join('/');
    if (unc) return '//' + body;
    return drive + (absolute ? '/' : '') + body;
};

export const isAbsolutePath = (p) => {
    const text = String(p || '');
    return text.startsWith('/') || text.startsWith('\\\\') || WIN_DRIVE_RE.test(text);
};

export const dirname = (p) => {
    const text = normalizePath(p);
    const idx = text.lastIndexOf('/');
    if (idx < 0) return '';
    if (idx === 0) return '/';
    if (/^[a-zA-Z]:$/.test(text.slice(0, idx))) return text.slice(0, idx + 1);
    return text.slice(0, idx);
};

export const basename = (p) => {
    const text = normalizePath(p);
    return text.slice(text.lastIndexOf('/') + 1);
};

export const joinPath = (dir, rel) => normalizePath(`${normalizePath(dir)}/${String(rel || '').replace(/\\/g, '/')}`);

/** True when `candidate` is `root` or lies under it (both normalised). */
export const isInsidePath = (root, candidate) => {
    const r = normalizePath(root);
    const c = normalizePath(candidate);
    if (!r || !c) return false;
    if (r === c) return true;
    const prefix = r.endsWith('/') ? r : r + '/';
    return c.startsWith(prefix);
};

/** `to` relative to directory `from` (both absolute, normalised); null when they share no root. */
export const relativePath = (from, to) => {
    const a = normalizePath(from).split('/').filter(Boolean);
    const b = normalizePath(to).split('/').filter(Boolean);
    const fromAbs = isAbsolutePath(from);
    const toAbs = isAbsolutePath(to);
    if (fromAbs !== toAbs) return null;
    if (fromAbs && a[0] !== b[0] && (/^[a-zA-Z]:$/.test(a[0] || '') || /^[a-zA-Z]:$/.test(b[0] || ''))) return null;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const up = a.slice(i).map(() => '..');
    return [...up, ...b.slice(i)].join('/');
};

// --- parsing -------------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {{ extended: boolean, entries: {path:string, duration:number|null, title:string|null, artist:string|null, trackKey:string|null, line:number}[] }}
 */
export const parseM3u = (text) => {
    const result = { extended: false, entries: [] };
    if (typeof text !== 'string') return result;
    const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
    let pending = { duration: null, title: null, artist: null, trackKey: null };
    lines.forEach((raw, index) => {
        const line = raw.trim();
        if (!line) return;
        if (line.startsWith('#')) {
            if (/^#EXTM3U/i.test(line)) { result.extended = true; return; }
            const extinf = /^#EXTINF:\s*(-?[\d.]+)?[^,]*,(.*)$/i.exec(line);
            if (extinf) {
                const duration = extinf[1] !== undefined ? Number(extinf[1]) : NaN;
                pending.duration = Number.isFinite(duration) && duration >= 0 ? duration : null;
                const label = extinf[2].trim();
                const sep = label.indexOf(' - ');
                if (sep > 0) {
                    pending.artist = label.slice(0, sep).trim() || null;
                    pending.title = label.slice(sep + 3).trim() || null;
                } else {
                    pending.title = label || null;
                }
                return;
            }
            const key = /^#CROSSROADS-KEY:(.+)$/i.exec(line);
            if (key) { pending.trackKey = key[1].trim() || null; return; }
            return; // other comments / directives
        }
        result.entries.push({ path: line, ...pending, line: index + 1 });
        pending = { duration: null, title: null, artist: null, trackKey: null };
    });
    return result;
};

// --- serialising ---------------------------------------------------------------------------

/**
 * The path to write for `songPath`: relative to `playlistDir` when both are inside
 * `musicRoot`, absolute otherwise.
 */
export const playlistPathFor = (songPath, { playlistDir = null, musicRoot = null } = {}) => {
    if (playlistDir && musicRoot && isInsidePath(musicRoot, playlistDir) && isInsidePath(musicRoot, songPath)) {
        const rel = relativePath(playlistDir, songPath);
        if (rel !== null) return rel;
    }
    return String(songPath);
};

const extinfLabel = (song) => {
    const title = song.title || basename(song.path || '');
    return song.artist ? `${song.artist} - ${title}` : title;
};

/**
 * @param {Object[]} songs        Songs (path, title, artist, duration, trackKey).
 * @param {Object} [opts]
 * @param {string} [opts.playlistDir]
 * @param {string} [opts.musicRoot]
 * @param {boolean} [opts.keys=true]   write the #CROSSROADS-KEY comments
 * @returns {string}
 */
export const serializeM3u = (songs, { playlistDir = null, musicRoot = null, keys = true } = {}) => {
    const out = ['#EXTM3U'];
    for (const song of songs || []) {
        if (!song || !song.path) continue;
        const duration = Number.isFinite(song.duration) && song.duration > 0 ? Math.round(song.duration) : -1;
        out.push(`#EXTINF:${duration},${extinfLabel(song).replace(/[\r\n]+/g, ' ')}`);
        if (keys && song.trackKey) out.push(`#CROSSROADS-KEY:${song.trackKey}`);
        out.push(playlistPathFor(song.path, { playlistDir, musicRoot }));
    }
    return out.join('\n') + '\n';
};

/** A file name for the playlist: "<name>.m3u8" with characters no file system accepts removed. */
export const playlistFileName = (name) => {
    const clean = String(name || 'Playlist').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${clean || 'Playlist'}.m3u8`;
};

// --- resolving -----------------------------------------------------------------------------

const byNormalizedPath = (songs) => {
    const map = new Map();
    const lower = new Map();
    for (const song of songs) {
        const n = normalizePath(song.path);
        if (!map.has(n)) map.set(n, song);
        const l = n.toLowerCase();
        if (!lower.has(l)) lower.set(l, song);
    }
    return { exact: map, lower };
};

const lookupPath = (index, candidate) => {
    const n = normalizePath(candidate);
    return index.exact.get(n) || index.lower.get(n.toLowerCase()) || null;
};

const closestByDuration = (candidates, duration) => {
    if (candidates.length === 0) return null;
    if (!Number.isFinite(duration) || duration === null) return candidates[0];
    let best = null;
    let bestDelta = Infinity;
    for (const song of candidates) {
        const delta = Number.isFinite(song.duration) ? Math.abs(song.duration - duration) : DURATION_TOLERANCE_S;
        if (delta < bestDelta) { best = song; bestDelta = delta; }
    }
    return bestDelta <= DURATION_TOLERANCE_S ? best : null;
};

/**
 * Resolves parsed entries against the library.
 * @param {Object[]} entries      from parseM3u().entries
 * @param {Object[]} songs        the library
 * @param {Object} [opts]
 * @param {string} [opts.playlistDir]   directory of the playlist file (for relative entries)
 * @param {string} [opts.musicRoot]
 * @returns {{ matched: Object[], unmatched: Object[], results: {entry:Object, song:Object|null, method:string|null}[] }}
 */
export const resolveM3uEntries = (entries, songs, { playlistDir = null, musicRoot = null } = {}) => {
    const library = Array.isArray(songs) ? songs.filter(s => s && s.path) : [];
    const paths = byNormalizedPath(library);
    const byKey = new Map();
    const byMeta = new Map();
    const byName = new Map();
    for (const song of library) {
        if (song.trackKey && !byKey.has(song.trackKey)) byKey.set(song.trackKey, song);
        const meta = `${normalizeText(song.artist)}|${normalizeText(song.title)}`;
        if (!byMeta.has(meta)) byMeta.set(meta, []);
        byMeta.get(meta).push(song);
        const titleOnly = `|${normalizeText(song.title)}`;
        if (!byMeta.has(titleOnly)) byMeta.set(titleOnly, []);
        byMeta.get(titleOnly).push(song);
        const name = basename(song.path).toLowerCase();
        byName.set(name, byName.has(name) ? null : song); // null = ambiguous
    }

    const results = [];
    for (const entry of entries || []) {
        let song = null;
        let method = null;
        const p = entry.path;
        if (isAbsolutePath(p)) {
            song = lookupPath(paths, p);
            if (song) method = 'path';
        }
        if (!song && !isAbsolutePath(p) && playlistDir) {
            song = lookupPath(paths, joinPath(playlistDir, p));
            if (song) method = 'relative-to-playlist';
        }
        if (!song && !isAbsolutePath(p) && musicRoot) {
            song = lookupPath(paths, joinPath(musicRoot, p));
            if (song) method = 'relative-to-root';
        }
        if (!song && entry.trackKey && byKey.has(entry.trackKey)) {
            song = byKey.get(entry.trackKey);
            method = 'trackKey';
        }
        if (!song && entry.title) {
            const key = `${normalizeText(entry.artist)}|${normalizeText(entry.title)}`;
            song = closestByDuration(byMeta.get(key) || [], entry.duration);
            if (song) method = 'metadata';
        }
        if (!song) {
            const name = basename(p).toLowerCase();
            const unique = byName.get(name);
            if (unique) { song = unique; method = 'filename'; }
        }
        results.push({ entry, song, method });
    }
    return {
        results,
        matched: results.filter(r => r.song).map(r => r.song),
        unmatched: results.filter(r => !r.song).map(r => r.entry)
    };
};
