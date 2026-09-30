// The Song model shared by every platform (Android MediaStore scan, Electron folder scan)
// and every view. Platform scanners produce a *raw* song (a subset of these fields, tags
// included); `normalizeSong()` in ./normalize.js fills in the derived fields so the rest
// of the app can rely on the full shape.
//
// Conventions
//   - `tags` holds EVERY tag found in the file, keyed by the UPPERCASE Vorbis-comment
//     style name (ID3 frames and MP4 atoms are mapped onto the same names by the desktop
//     scanner, e.g. TPE2 -> ALBUMARTIST, ©wrk -> WORK, TXXX:MusicBrainz Album Id ->
//     MUSICBRAINZ_ALBUMID). Every value is an array of strings, even single ones.
//   - Numbers are plain JS numbers; anything unknown is `null`, never `undefined`,
//     so the shape survives JSON round-trips through the platform bridges and caches.
//   - `path` is the per-device file identity; `trackKey` is the cross-device identity.

/**
 * @typedef {'hires'|'cd'|'lossy'|'unknown'} QualityTier
 */

/**
 * @typedef {Object} Quality
 * @property {QualityTier} tier   'hires' (lossless and >=24-bit or >=88.2 kHz), 'cd' (other
 *                                lossless with known properties), 'lossy', or 'unknown'.
 * @property {string} label       Human badge, e.g. 'FLAC 24/96', 'ALAC 16/44.1', 'WAV 24/192',
 *                                'MP3 320', 'AAC 256'. Falls back to the bare format name.
 */

/**
 * @typedef {Object} Song
 *
 * Identity / location
 * @property {string} path              Absolute file path (Android: MediaStore DATA column).
 * @property {string} folder            Parent directory of `path`.
 * @property {string} trackKey          Stable cross-device identity, see ./trackKey.js.
 * @property {number|null} fileSize     Bytes.
 * @property {number|null} mtime        Last-modified time, ms since epoch.
 *
 * Common tags (always strings; '' when absent so existing UI code keeps working)
 * @property {string} title
 * @property {string} artist            'Unknown Artist' when the file has no artist tag.
 * @property {string} album             Falls back to the parent folder name.
 * @property {string} albumArtist       Only the explicit tag ('' otherwise): views group by it.
 * @property {string} composer
 * @property {string|null} genre
 * @property {number|null} year         Four-digit year taken from DATE / YEAR / ORIGINALDATE.
 * @property {number|null} trackNumber
 * @property {number|null} trackTotal
 * @property {number|null} discNumber
 * @property {number|null} discTotal
 * @property {Object.<string, string[]>} tags   All tags, UPPERCASE name -> values.
 * @property {boolean} hasEmbeddedLyrics        LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS present.
 *
 * Audio properties
 * @property {number|null} duration     Seconds.
 * @property {string} format            Container / codec shorthand shown in badges:
 *                                      FLAC, WAV, AIFF, ALAC, AAC, M4A, MP3, OGG, OPUS, ...
 * @property {string|null} codec        Codec as reported by the parser ('FLAC', 'PCM', 'MPEG 1 Layer 3',
 *                                      'ALAC', 'AAC', 'Vorbis', 'Opus'), null when unknown.
 * @property {boolean|null} lossless    null when the container alone cannot tell (bare M4A).
 * @property {number|null} bitrate      Bits per second.
 * @property {number|null} sampleRate   Hz.
 * @property {number|null} bitsPerSample
 * @property {number|null} channels
 * @property {number|null} totalSamples Total PCM frames (FLAC STREAMINFO, WAV data/blockAlign, ...).
 * @property {string|null} md5          FLAC STREAMINFO MD5 of the decoded audio, lowercase hex;
 *                                      null when absent or all zero. Used by #20 (verify after
 *                                      tag write) and #28 (result caching).
 * @property {Quality} quality
 *
 * Artwork
 * @property {string|null} picture      Something the <img> tag can load: a content:// URI on
 *                                      Android, crossroads-media://art/<path> on desktop.
 * @property {string|null} rawPicture   The original content:// URI on Android (the OS media
 *                                      session needs it, the WebView does not); null elsewhere.
 *
 * Indexing state
 * @property {boolean} provisional      true while the platform has not probed the file yet
 *                                      (Android returns MediaStore rows immediately and probes
 *                                      in the background): tags, audio properties and quality
 *                                      are incomplete and `trackKey` may still change. The
 *                                      library is re-read when indexing completes.
 *
 * Lyrics text is not part of the bulk library payload: `tags` omits LYRICS / UNSYNCEDLYRICS /
 * SYNCEDLYRICS values (hasEmbeddedLyrics says whether they exist) and
 * PlatformService.getTrackDetails(path) returns the full tags for one song on demand.
 */

export const QUALITY_TIERS = Object.freeze(['hires', 'cd', 'lossy', 'unknown']);

/** Tag names that carry lyrics text (Vorbis style; ID3 USLT / MP4 ©lyr map onto these). */
export const LYRICS_TAGS = Object.freeze(['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS']);

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';

/**
 * Bumps whenever the raw platform model or the derivation rules change in a way that
 * requires re-parsing cached files. PlatformService passes it to the platform scanners
 * (Electron `app:scanFolder`, Android `getTracks`), whose caches store it and drop every
 * entry written under another version.
 */
export const LIBRARY_MODEL_VERSION = 1;

/** Tag names whose values are stripped from the bulk library payload (see hasEmbeddedLyrics). */
export const isLyricsTagName = (name) => /^(?:LYRICS|UNSYNCEDLYRICS|SYNCEDLYRICS)(?:[:\-_].*)?$/.test(String(name).toUpperCase());
