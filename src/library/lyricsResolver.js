// Lyrics resolution (#22), in the order the issue specifies:
//   1. embedded synced lyrics (a lyrics tag whose text carries LRC timestamps)
//   2. a .lrc sidecar next to the track (same base name)
//   3. embedded unsynced lyrics
//   4. LRCLIB (online, only when enabled)
// Every provider is injected so the resolver is pure and testable; the UI passes
// PlatformService.getTrackDetails / readSidecar and fetch.

import { isLyricsTagName } from './song.js';
import { parseLrc, plainText } from './lrc.js';

export const LYRICS_SOURCES = Object.freeze({
    EMBEDDED_SYNCED: 'embedded-synced',
    SIDECAR: 'sidecar',
    EMBEDDED_UNSYNCED: 'embedded-unsynced',
    LRCLIB: 'lrclib'
});

export const SOURCE_LABELS = Object.freeze({
    'embedded-synced': 'Embedded',
    'sidecar': 'Sidecar .lrc',
    'embedded-unsynced': 'Embedded',
    'lrclib': 'LRCLIB'
});

/** "<track base name>.lrc" next to the file. */
export const sidecarPathFor = (trackPath) => {
    const p = String(trackPath || '');
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dot = p.lastIndexOf('.');
    return (dot > slash ? p.slice(0, dot) : p) + '.lrc';
};

/** Every lyrics text in the tags: SYNCEDLYRICS first, then LYRICS, then UNSYNCEDLYRICS (and suffixed variants). */
export const embeddedLyricsTexts = (tags) => {
    const out = [];
    const names = Object.keys(tags || {}).filter(isLyricsTagName);
    const rank = (name) => (/^SYNCEDLYRICS/i.test(name) ? 0 : /^LYRICS/i.test(name) ? 1 : 2);
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const name of names) {
        for (const value of tags[name] || []) {
            if (typeof value === 'string' && value.trim()) out.push(value);
        }
    }
    return out;
};

/** The LRCLIB /api/get URL for a song, or null when the song has no title. */
export const lrclibUrl = (song) => {
    if (!song?.title) return null;
    const params = new URLSearchParams({ track_name: song.title });
    if (song.artist) params.set('artist_name', song.artist);
    if (song.album) params.set('album_name', song.album);
    if (Number.isFinite(song.duration) && song.duration > 0) params.set('duration', String(Math.round(song.duration)));
    return `https://lrclib.net/api/get?${params.toString()}`;
};

const fromText = (text, source) => {
    const parsed = parseLrc(text);
    if (parsed.synced) return { source, synced: true, lines: parsed.lines, plain: parsed.plain, lrcText: text };
    // Unsynced: the text as written (blank lines, "[Chorus]" headers), only known LRC
    // metadata lines ([ti:], [ar:], ...) left out; the raw text when that leaves nothing.
    const plain = parsed.plain || plainText(text);
    return plain ? { source, synced: false, lines: null, plain, lrcText: null } : null;
};

/**
 * @param {Object} params
 * @param {Object} params.song                 the library song (title/artist/album/duration/path/tags)
 * @param {(path:string)=>Promise<Object|null>} [params.getDetails]   full song incl. lyrics tags
 * @param {(path:string)=>Promise<string|null>} [params.readSidecar]  text of the .lrc, or null
 * @param {(url:string, init:Object)=>Promise<Response>} [params.fetch]
 * @param {boolean} [params.online=true]       whether LRCLIB may be queried
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{source:string, synced:boolean, lines:Object[]|null, plain:string|null, lrcText:string|null}|null>}
 */
export const resolveLyrics = async ({ song, getDetails = null, readSidecar = null, fetch: fetchImpl = null, online = true, signal = null }) => {
    if (!song?.path) return null;
    const aborted = () => signal?.aborted;

    // Embedded tags: the bulk library payload strips lyrics text, so ask for the details
    // unless the song already carries them.
    let tags = song.tags || {};
    let texts = embeddedLyricsTexts(tags);
    if (texts.length === 0 && song.hasEmbeddedLyrics !== false && getDetails) {
        try {
            const details = await getDetails(song.path);
            if (details?.tags) { tags = details.tags; texts = embeddedLyricsTexts(tags); }
        } catch (e) {
            console.warn('Track details unavailable for lyrics', e);
        }
    }
    if (aborted()) return null;

    for (const text of texts) {
        const parsed = fromText(text, LYRICS_SOURCES.EMBEDDED_SYNCED);
        if (parsed?.synced) return parsed;
    }

    if (readSidecar) {
        try {
            const text = await readSidecar(sidecarPathFor(song.path));
            if (aborted()) return null;
            if (typeof text === 'string' && text.trim()) {
                const parsed = fromText(text, LYRICS_SOURCES.SIDECAR);
                if (parsed) return parsed;
            }
        } catch (e) {
            console.warn('Sidecar lyrics unreadable', e);
        }
    }

    for (const text of texts) {
        const parsed = fromText(text, LYRICS_SOURCES.EMBEDDED_UNSYNCED);
        if (parsed) return parsed;
    }

    if (!online) return null;
    const url = lrclibUrl(song);
    if (!url) return null;
    const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    const response = await doFetch(url, { signal });
    if (!response || !response.ok) return null;
    const data = await response.json();
    if (aborted()) return null;
    if (data?.syncedLyrics) {
        const parsed = fromText(data.syncedLyrics, LYRICS_SOURCES.LRCLIB);
        if (parsed?.synced) return { ...parsed, plain: data.plainLyrics || parsed.plain };
    }
    if (typeof data?.plainLyrics === 'string' && data.plainLyrics.trim()) {
        return { source: LYRICS_SOURCES.LRCLIB, synced: false, lines: null, plain: data.plainLyrics, lrcText: null };
    }
    return null;
};
