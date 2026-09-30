// On-demand embedded artwork for the desktop: parses the picture out of the audio file when
// the renderer requests crossroads-media://art/<path>, with a small in-memory LRU so an
// album grid that shows the same cover many times reads the file once.

const fsp = require('fs/promises');

const MAX_CACHED = 48;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;   // total picture bytes held in memory
const MAX_PICTURE_BYTES = 16 * 1024 * 1024;  // a single picture larger than this is ignored

// Only image types are served; anything else (or a missing type) is sent as JPEG, which is
// what a mislabelled cover almost always is.
const IMAGE_TYPE_RE = /^image\/[a-z0-9.+-]+$/i;
const DEFAULT_IMAGE_TYPE = 'image/jpeg';

const cache = new Map(); // key -> { format, data } | null
let cachedBytes = 0;

function entryBytes(value) {
    return value && value.data ? value.data.length : 0;
}

function remember(key, value) {
    if (cache.has(key)) {
        cachedBytes -= entryBytes(cache.get(key));
        cache.delete(key);
    }
    cache.set(key, value);
    cachedBytes += entryBytes(value);
    while (cache.size > 0 && (cache.size > MAX_CACHED || cachedBytes > MAX_CACHED_BYTES)) {
        const oldest = cache.keys().next().value;
        cachedBytes -= entryBytes(cache.get(oldest));
        cache.delete(oldest);
    }
}

function imageContentType(format) {
    const type = String(format || '').trim().toLowerCase();
    return IMAGE_TYPE_RE.test(type) ? type : DEFAULT_IMAGE_TYPE;
}

/**
 * @returns {Promise<{format:string, data:Buffer}|null>}  null when the file has no picture.
 */
async function readEmbeddedPicture(file, loadMusicMetadata = () => import('music-metadata')) {
    let stat;
    try {
        stat = await fsp.stat(file);
    } catch {
        return null;
    }
    const key = `${file}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
    if (cache.has(key)) {
        const hit = cache.get(key);
        remember(key, hit);
        return hit;
    }

    let picture = null;
    try {
        const mm = await loadMusicMetadata();
        const metadata = await mm.parseFile(file, { duration: false });
        const pictures = metadata?.common?.picture || [];
        const chosen = pictures.find(p => /front/i.test(String(p.type || ''))) || pictures[0];
        if (chosen && chosen.data && chosen.data.length > 0 && chosen.data.length <= MAX_PICTURE_BYTES) {
            picture = { format: imageContentType(chosen.format), data: Buffer.from(chosen.data) };
        }
    } catch (e) {
        console.warn('Artwork unreadable', file, e.message);
    }
    remember(key, picture);
    return picture;
}

function clearArtworkCache() {
    cache.clear();
    cachedBytes = 0;
}

/** For tests and diagnostics. */
function artworkCacheStats() {
    return { entries: cache.size, bytes: cachedBytes };
}

module.exports = { readEmbeddedPicture, clearArtworkCache, artworkCacheStats, imageContentType, MAX_CACHED, MAX_CACHED_BYTES };
