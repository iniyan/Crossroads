// Desktop library scan: walks the music folder, parses every audio file with music-metadata
// (plus a direct STREAMINFO read for FLAC) and produces raw songs in the shape documented in
// src/library/song.js. The renderer runs normalizeSong() on them.
//
// Artwork is not embedded in the result: a song with an embedded picture gets
// picture = 'crossroads-media://art/<encoded path>?v=<size>-<mtime>' and main.js serves the
// bytes on demand (see artwork.js). That keeps the IPC payload and the on-disk index small
// for large libraries (10k tracks x ~200 KB of base64 would be 2 GB) and images load lazily;
// the query string changes with the file so the renderer's image cache never shows a stale
// cover.
//
// Lyrics text is likewise left out of the bulk result (`hasEmbeddedLyrics` says it exists);
// readTrackDetails() returns the full tags of one file on request.

const path = require('path');
const fsp = require('fs/promises');
const { readFlacStreamInfo } = require('./flacHeader');
const { flattenNativeTags } = require('./tagMapper');

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.aiff', '.aif', '.ape', '.wv']);

// How many directory entries (subfolders / symlinks) a single folder scans in parallel.
const SCAN_CONCURRENCY = 8;
// How many files are parsed concurrently; parsing is I/O bound.
const PARSE_CONCURRENCY = 4;

const ART_SCHEME = 'crossroads-media';
const ART_HOST = 'art';

// Error codes of failures that say nothing about the file itself: the parse is retried on
// the next scan instead of being cached.
const TRANSIENT_ERROR_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'ECANCELED']);

// Mirrors isLyricsTagName in src/library/song.js (ESM, not requirable from the main process).
const LYRICS_TAG_RE = /^(?:LYRICS|UNSYNCEDLYRICS|SYNCEDLYRICS)(?:[:\-_].*)?$/;

function isLyricsTag(name) {
    return LYRICS_TAG_RE.test(String(name).toUpperCase());
}

function hasLyrics(tags) {
    return Object.keys(tags || {}).some(name => isLyricsTag(name) && Array.isArray(tags[name]) && tags[name].length > 0);
}

/** The song as the bulk scan result carries it: no lyrics text, hasEmbeddedLyrics set. */
function forBulkPayload(song) {
    const tags = {};
    for (const name of Object.keys(song.tags || {})) {
        if (!isLyricsTag(name)) tags[name] = song.tags[name];
    }
    return { ...song, tags, hasEmbeddedLyrics: song.hasEmbeddedLyrics === true || hasLyrics(song.tags) };
}

function artUrl(file, size, mtime) {
    const version = Number.isFinite(size) && Number.isFinite(mtime) ? `?v=${size}-${mtime}` : '';
    return `${ART_SCHEME}://${ART_HOST}/${encodeURIComponent(file)}${version}`;
}

function isTransientError(e) {
    if (!e) return false;
    if (e.code && TRANSIENT_ERROR_CODES.has(e.code)) return true;
    return e.name === 'AbortError' || e.name === 'TimeoutError';
}

// Returns true when `candidate` (already resolved) sits inside `root` (already resolved).
function isInside(root, candidate) {
    if (!root || !candidate) return false;
    const rel = path.relative(root, candidate);
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            await fn(items[next++]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function getFilesRecursively(dir, realRoot, out = []) {
    let dirents;
    try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        console.warn('Skipping unreadable directory', dir, e.message);
        return out;
    }

    const subdirs = [];
    const symlinks = [];
    for (const dirent of dirents) {
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) subdirs.push(res);
        else if (dirent.isFile()) out.push(res);
        else if (dirent.isSymbolicLink()) symlinks.push(res);
    }

    // Never follow symlinked directories (loop protection). Symlinked files are fine
    // as long as they resolve to somewhere inside the music root.
    await mapLimit(symlinks, SCAN_CONCURRENCY, async (res) => {
        try {
            const real = await fsp.realpath(res);
            const st = await fsp.stat(real);
            if (st.isFile() && isInside(realRoot, real)) out.push(res);
        } catch {
            // Broken symlink or unreadable target; ignore.
        }
    });
    await mapLimit(subdirs, SCAN_CONCURRENCY, (sub) => getFilesRecursively(sub, realRoot, out));
    return out;
}

function detectFormat(file, metadata) {
    const ext = path.extname(file).slice(1).toUpperCase();
    const codec = String(metadata?.format?.codec || '').toUpperCase();
    const container = String(metadata?.format?.container || '').toUpperCase();
    if (ext === 'OGG' && codec.includes('OPUS')) return 'OPUS';
    if ((ext === 'M4A' || ext === 'MP4') && codec.includes('ALAC')) return 'ALAC';
    if ((ext === 'M4A' || ext === 'MP4') && (codec.includes('AAC') || codec.includes('MP4A'))) return 'AAC';
    if (container.includes('FLAC') || codec.includes('FLAC')) return 'FLAC';
    if (ext === 'AIF') return 'AIFF';
    return ext || 'UNKNOWN';
}

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * Parses one file into a raw song. Never throws for metadata problems: a file that
 * music-metadata cannot read still yields a song built from its name, with `status`
 *   'ok'        parsed (possibly without tags)
 *   'failed'    the parser rejected the file: cached, retried after RETRY_FAILED_MS
 *   'transient' an I/O error unrelated to the file's content: not cached, retried next scan
 * @returns {Promise<{song:Object, status:'ok'|'failed'|'transient'}>}
 */
async function parseTrackWithStatus(mm, file, stat) {
    const parentDir = path.dirname(file);
    const song = {
        path: file,
        folder: parentDir,
        fileSize: stat.size,
        mtime: Math.round(stat.mtimeMs),
        title: '',
        artist: '',
        albumArtist: '',
        album: '',
        composer: '',
        genre: null,
        year: null,
        trackNumber: null,
        trackTotal: null,
        discNumber: null,
        discTotal: null,
        tags: {},
        hasEmbeddedLyrics: false,
        duration: null,
        format: path.extname(file).slice(1).toUpperCase() || 'UNKNOWN',
        codec: null,
        lossless: null,
        bitrate: null,
        sampleRate: null,
        bitsPerSample: null,
        channels: null,
        totalSamples: null,
        md5: null,
        picture: null
    };

    let status = 'ok';
    let metadata = null;
    try {
        // MP3 without a Xing/VBRI header only gets a duration from a full frame scan;
        // everything else has it in the headers. The result is cached, so pay once.
        metadata = await mm.parseFile(file, { duration: path.extname(file).toLowerCase() === '.mp3' });
    } catch (e) {
        status = isTransientError(e) ? 'transient' : 'failed';
        console.warn(`Metadata unreadable (${status})`, file, e.message);
    }

    if (metadata) {
        const { common, format } = metadata;
        song.title = common.title || '';
        song.artist = common.artist || '';
        song.albumArtist = common.albumartist || '';
        song.album = common.album || '';
        song.composer = common.composer?.[0] || common.composers?.[0] || '';
        song.genre = common.genre?.[0] || null;
        song.year = numberOrNull(common.year);
        song.trackNumber = numberOrNull(common.track?.no);
        song.trackTotal = numberOrNull(common.track?.of);
        song.discNumber = numberOrNull(common.disk?.no);
        song.discTotal = numberOrNull(common.disk?.of);
        song.tags = flattenNativeTags(metadata.native);
        song.format = detectFormat(file, metadata);
        song.codec = format.codec || null;
        // music-metadata reports WAVE_FORMAT_EXTENSIBLE as 'non-PCM (65534)'; it is PCM.
        if (song.codec && /65534|EXTENSIBLE/i.test(song.codec) && (song.format === 'WAV' || song.format === 'AIFF')) song.codec = 'PCM';
        song.lossless = typeof format.lossless === 'boolean' ? format.lossless : null;
        song.duration = numberOrNull(format.duration);
        song.bitrate = numberOrNull(format.bitrate) ? Math.round(format.bitrate) : null;
        song.sampleRate = numberOrNull(format.sampleRate);
        song.bitsPerSample = numberOrNull(format.bitsPerSample);
        song.channels = numberOrNull(format.numberOfChannels);
        song.totalSamples = numberOrNull(format.numberOfSamples) ? Math.round(format.numberOfSamples) : null;
        if (typeof format.audioMD5 === 'string') song.md5 = format.audioMD5;
        else if (Buffer.isBuffer(format.audioMD5) || format.audioMD5 instanceof Uint8Array) song.md5 = Buffer.from(format.audioMD5).toString('hex');
        if (Array.isArray(common.picture) && common.picture.length > 0) song.picture = artUrl(file, song.fileSize, song.mtime);
    }

    if (song.format === 'FLAC' || path.extname(file).toLowerCase() === '.flac') {
        try {
            const info = await readFlacStreamInfo(file);
            if (info) {
                song.format = 'FLAC';
                song.codec = song.codec || 'FLAC';
                song.lossless = true;
                song.sampleRate = info.sampleRate || song.sampleRate;
                song.bitsPerSample = info.bitsPerSample || song.bitsPerSample;
                song.channels = info.channels || song.channels;
                song.totalSamples = info.totalSamples || song.totalSamples;
                song.md5 = info.md5;
                if (!song.duration && info.totalSamples && info.sampleRate) song.duration = info.totalSamples / info.sampleRate;
                if (info.hasPicture) song.picture = artUrl(file, song.fileSize, song.mtime);
                if (status === 'failed') status = 'ok'; // the STREAMINFO read is enough to describe the file
            }
        } catch (e) {
            if (isTransientError(e)) status = 'transient';
            console.warn('FLAC header unreadable', file, e.message);
        }
    }

    song.hasEmbeddedLyrics = hasLyrics(song.tags);
    return { song, status };
}

/** parseTrackWithStatus() without the status, for callers that only want the song. */
async function parseTrack(mm, file, stat) {
    return (await parseTrackWithStatus(mm, file, stat)).song;
}

/**
 * Looks `file` up in the index (when it still matches its size and mtime) or parses it,
 * caching the outcome per its status. Returns the full raw song (lyrics included).
 */
async function loadTrack(mm, index, file, stat, counters = null) {
    const size = stat.size;
    const mtime = Math.round(stat.mtimeMs);
    const cached = index ? index.get(file, size, mtime) : null;
    if (cached) {
        if (counters) counters.cached++;
        return cached;
    }
    const { song, status } = await parseTrackWithStatus(mm, file, stat);
    if (counters) counters.parsed++;
    if (index && status !== 'transient') {
        index.put(file, size, mtime, song, status === 'failed' ? { failedAt: Date.now() } : {});
    }
    return song;
}

/**
 * Scans `root` (already validated by the caller) and returns raw songs for the bulk payload
 * (lyrics text stripped), using and updating `index` (a LibraryIndex) so that only new or
 * changed files are parsed.
 *
 * @param {Object} opts
 * @param {string} opts.root                Resolved music folder.
 * @param {import('./libraryIndex').LibraryIndex} [opts.index]
 * @param {number} [opts.modelVersion]      The renderer's LIBRARY_MODEL_VERSION; entries cached
 *                                          under another version are dropped.
 * @param {(file:string)=>Promise<Object>} [opts.loadMusicMetadata]  Defaults to dynamic import.
 * @param {(progress:{done:number,total:number})=>void} [opts.onProgress]
 * @returns {Promise<{songs:Object[], parsed:number, cached:number, pruned:number}>}
 */
async function scanLibrary({ root, index = null, modelVersion = 0, loadMusicMetadata = () => import('music-metadata'), onProgress = null }) {
    let realRoot;
    try {
        realRoot = await fsp.realpath(root);
    } catch (e) {
        throw new Error(`Music folder is not accessible: ${e.message}`);
    }
    if (index) index.ensureModelVersion(modelVersion);

    const allFiles = await getFilesRecursively(root, realRoot);
    // The concurrent walk yields files in arrival order; sort for a stable library.
    const audioFiles = allFiles.filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase())).sort();

    const mm = await loadMusicMetadata();
    const results = new Array(audioFiles.length);
    const counters = { parsed: 0, cached: 0 };
    let done = 0;

    await mapLimit(audioFiles.map((file, i) => ({ file, i })), PARSE_CONCURRENCY, async ({ file, i }) => {
        try {
            const stat = await fsp.stat(file);
            results[i] = forBulkPayload(await loadTrack(mm, index, file, stat, counters));
        } catch (e) {
            console.error('Error scanning', file, e);
        } finally {
            done++;
            if (onProgress && (done % 50 === 0 || done === audioFiles.length)) onProgress({ done, total: audioFiles.length });
        }
    });

    const songs = results.filter(Boolean);
    let pruned = 0;
    if (index) {
        pruned = index.prune(root, new Set(audioFiles), isInside);
        try {
            await index.save();
        } catch (e) {
            console.warn('Could not save library index', e.message);
        }
    }
    return { songs, parsed: counters.parsed, cached: counters.cached, pruned };
}

/**
 * The full raw song (every tag, lyrics included) for one file, from the index when it is
 * current, else freshly parsed (and cached). The caller has already checked that `file`
 * lies inside the music root. Returns null when the file cannot be read.
 */
async function readTrackDetails({ file, index = null, modelVersion = 0, loadMusicMetadata = () => import('music-metadata') }) {
    let stat;
    try {
        stat = await fsp.stat(file);
    } catch {
        return null;
    }
    if (!stat.isFile()) return null;
    if (index) index.ensureModelVersion(modelVersion);
    const mm = await loadMusicMetadata();
    const song = await loadTrack(mm, index, file, stat);
    if (index) {
        try {
            await index.save();
        } catch (e) {
            console.warn('Could not save library index', e.message);
        }
    }
    return { ...song, hasEmbeddedLyrics: song.hasEmbeddedLyrics === true || hasLyrics(song.tags) };
}

module.exports = {
    scanLibrary,
    readTrackDetails,
    parseTrack,
    parseTrackWithStatus,
    forBulkPayload,
    isLyricsTag,
    isTransientError,
    detectFormat,
    getFilesRecursively,
    isInside,
    mapLimit,
    artUrl,
    AUDIO_EXTENSIONS,
    ART_HOST
};
