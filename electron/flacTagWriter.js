// FLAC tag writer (#20): replaces the VORBIS_COMMENT block of a FLAC file without ever
// touching the audio frames.
//
// The pure part (parseMetadata / planTagWrite / buildFile) works on Buffers and is mirrored
// byte-for-byte by android/.../FlacTagWriter.java; the two are held to identical output by
// the shared test vectors in android/app/src/test/resources/flac-vectors.json. The rules
// both implementations follow:
//
//   * Tags are edited as operations against the comments actually in the file (`set` replaces
//     every value of a key, `remove` drops a key), never as a full replacement, so tags the
//     library reader does not surface (METADATA_BLOCK_PICTURE, unknown keys) survive a write.
//   * Keys are grouped by their trimmed, upper-cased spelling (the same fold the renderer's
//     tags.js applies). A key already in the file keeps its spelling and its first-seen
//     position and can be replaced or removed even when its spelling is not a legal comment
//     name; only NEW keys are validated (printable ASCII, no '='). New keys are written
//     upper-cased, after the existing ones, in alphabetical order. Values keep the order given.
//   * "Blank" (a value that is dropped, the whitespace a key is trimmed of) is the exact set
//     String.prototype.trim() strips, spelled out in JS_SPACE and mirrored in Java.
//   * Entries without a "KEY=" part (no '=' or an empty key) cannot be edited but are kept
//     byte for byte, after the key=value entries, as libFLAC keeps them.
//   * The vendor string is preserved; a file without a VORBIS_COMMENT block gets one right
//     after STREAMINFO with vendor "Crossroads".
//   * Every other block (PICTURE, APPLICATION, SEEKTABLE, CUESHEET, ...) is copied verbatim in
//     its original order. All PADDING blocks are merged into a single trailing one. A file with
//     more than one VORBIS_COMMENT block (invalid per spec) is refused rather than edited.
//   * When the new blocks fit in the old metadata region (old blocks + padding) the leftover
//     becomes the trailing PADDING, so the audio offset does not move (plan.inPlace tells the
//     caller the region kept its size). Otherwise DEFAULT_PADDING of padding is appended.
//
// The file-system part (writeFlacTags) NEVER writes into the original: a partial in-place
// write that dies mid-way would leave a file with a broken header. Instead every change goes
//   temp file in the same directory (random suffix) -> write prefix + new metadata + audio
//   copied byte for byte -> fsync -> chmod (mode bits exactly, not subject to umask) and a
//   best-effort chown -> full verification (STREAMINFO bytes, SHA-256 of the audio region,
//   tags read back) -> re-stat the original and abort if its size/mtime changed since the
//   plan was made -> rename over the original -> fsync the directory (best effort) ->
//   header-level re-check.
// A file with hard links is refused (the rename would silently split them) and so is a
// read-only file (a rename would bypass its permission bits). On Windows the
// rename is retried with backoff while another program holds the file, then reported as
// "in use". On macOS the temp file is created as an APFS clone of the original so extended
// attributes / ACLs carry over (no native deps; other platforms do not preserve xattrs). The
// temp file is removed on any failure and the original is untouched; a no-op edit (nothing
// would change) returns before the audio is even hashed.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const BLOCK_STREAMINFO = 0;
const BLOCK_PADDING = 1;
const BLOCK_VORBIS_COMMENT = 4;
const STREAMINFO_LENGTH = 34;
const MAX_BLOCK_LENGTH = 0xFFFFFF;
const MAX_BLOCKS = 128;
const DEFAULT_PADDING = 8192;
const DEFAULT_VENDOR = 'Crossroads';
// Metadata regions bigger than this are refused (pictures of a few MB are normal; 64 MB is not).
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

const MARKER = Buffer.from('fLaC', 'latin1');

class FlacTagError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'FlacTagError';
        this.code = code || 'FLAC_TAG_ERROR';
    }
}

/** Byte length of an ID3v2 tag at the start of `buf`, or 0. */
function id3v2Length(buf) {
    if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
    const size = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
    const footer = (buf[5] & 0x10) ? 10 : 0;
    return 10 + size + footer;
}

/**
 * Walks the metadata blocks at the start of `buf` (which must hold at least the whole
 * metadata region). Returns { prefixLength, metaStart, audioOffset, blocks } where each
 * block is { type, isLast, offset (of the body), length }.
 */
function parseMetadata(buf) {
    const prefixLength = id3v2Length(buf);
    if (buf.length < prefixLength + 4 || buf.compare(MARKER, 0, 4, prefixLength, prefixLength + 4) !== 0) {
        throw new FlacTagError('Not a FLAC file', 'NOT_FLAC');
    }
    const metaStart = prefixLength + 4;
    const blocks = [];
    let pos = metaStart;
    for (;;) {
        if (blocks.length >= MAX_BLOCKS) throw new FlacTagError('Too many metadata blocks', 'CORRUPT');
        if (pos + 4 > buf.length) throw new FlacTagError('Truncated metadata block header', 'TRUNCATED');
        const isLast = (buf[pos] & 0x80) !== 0;
        const type = buf[pos] & 0x7F;
        const length = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
        if (type === 127) throw new FlacTagError('Invalid metadata block type', 'CORRUPT');
        if (pos + 4 + length > buf.length) throw new FlacTagError('Truncated metadata block', 'TRUNCATED');
        blocks.push({ type, isLast, offset: pos + 4, length });
        pos += 4 + length;
        if (isLast) break;
    }
    if (blocks[0].type !== BLOCK_STREAMINFO || blocks[0].length !== STREAMINFO_LENGTH) {
        throw new FlacTagError('First metadata block is not STREAMINFO', 'CORRUPT');
    }
    return { prefixLength, metaStart, audioOffset: pos, blocks };
}

/**
 * Decodes a VORBIS_COMMENT body into { vendor, comments: [[key, value], ...], raw: Buffer[] }
 * (keys as written; `raw` holds the entries with no "KEY=" part, verbatim).
 */
function parseVorbisComment(body) {
    if (body.length < 8) throw new FlacTagError('Corrupt VORBIS_COMMENT block', 'CORRUPT');
    let pos = 0;
    const vendorLength = body.readUInt32LE(pos); pos += 4;
    if (pos + vendorLength > body.length) throw new FlacTagError('Corrupt VORBIS_COMMENT vendor', 'CORRUPT');
    const vendor = body.toString('utf8', pos, pos + vendorLength); pos += vendorLength;
    if (pos + 4 > body.length) throw new FlacTagError('Corrupt VORBIS_COMMENT count', 'CORRUPT');
    const count = body.readUInt32LE(pos); pos += 4;
    const comments = [];
    const raw = [];
    for (let i = 0; i < count; i++) {
        if (pos + 4 > body.length) throw new FlacTagError('Corrupt VORBIS_COMMENT entry', 'CORRUPT');
        const length = body.readUInt32LE(pos); pos += 4;
        if (pos + length > body.length) throw new FlacTagError('Corrupt VORBIS_COMMENT entry', 'CORRUPT');
        const bytes = body.subarray(pos, pos + length); pos += length;
        const eq = bytes.indexOf(0x3D);
        if (eq <= 0) { raw.push(Buffer.from(bytes)); continue; } // no key: kept verbatim, never edited
        comments.push([bytes.toString('utf8', 0, eq), bytes.toString('utf8', eq + 1)]);
    }
    return { vendor, comments, raw };
}

// The characters String.prototype.trim() strips (ECMAScript WhiteSpace + LineTerminator),
// spelled out so JS and Java agree on what "blank" means (FlacTagWriter.java mirrors it).
const JS_SPACE = new Set([
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF
]);

const isSpace = (code) => JS_SPACE.has(code);

/** String.prototype.trim() over the explicit JS_SPACE set. */
function jsTrim(s) {
    let start = 0;
    let end = s.length;
    while (start < end && isSpace(s.charCodeAt(start))) start++;
    while (end > start && isSpace(s.charCodeAt(end - 1))) end--;
    return s.slice(start, end);
}

/** True when every character of `s` is in JS_SPACE (the empty string is blank). */
function isBlank(s) {
    for (let i = 0; i < s.length; i++) if (!isSpace(s.charCodeAt(i))) return false;
    return true;
}

/** The grouping key of a comment name: trimmed and upper-cased, as the renderer folds it. */
const foldKey = (key) => jsTrim(String(key === undefined || key === null ? '' : key)).toUpperCase();

/**
 * Groups comments by their folded key (trimmed, upper-cased), preserving first-seen key order
 * and value order: Map<UPPER, { key: spelling of the first occurrence, values }>.
 */
function groupComments(comments) {
    const map = new Map();
    for (const [key, value] of comments) {
        const upper = foldKey(key);
        if (!map.has(upper)) map.set(upper, { key, values: [] });
        map.get(upper).values.push(value);
    }
    return map;
}

/** { UPPER: values } view of a grouped map. */
function tagsObject(grouped) {
    const out = {};
    for (const [upper, entry] of grouped) out[upper] = entry.values.slice();
    return out;
}

// A comment key: printable ASCII 0x20..0x7D except '='. Only keys that are NEW to the file
// have to satisfy it; whatever spelling a file already carries can be edited.
const KEY_RE = /^[\x20-\x3C\x3E-\x7D]+$/;

/** The folded key of an operation, or a FlacTagError when it is empty. */
function normalizeKey(key) {
    const upper = foldKey(key);
    if (!upper) throw new FlacTagError('Empty tag name', 'INVALID_TAG');
    return upper;
}

function normalizeValues(key, raw) {
    const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
    const values = [];
    for (const item of list) {
        if (item === undefined || item === null) continue;
        if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
            throw new FlacTagError(`Invalid value for ${key}`, 'INVALID_TAG');
        }
        const text = String(item);
        if (isBlank(text)) continue;
        if (text.includes('\0')) throw new FlacTagError(`Invalid value for ${key}`, 'INVALID_TAG');
        values.push(text);
    }
    return values;
}

/**
 * Applies { set, remove } to the grouped comments. `set` maps key -> value | value[] (an empty
 * list removes the key); `remove` lists keys. Keys are matched by their folded spelling; a key
 * that is not in the file yet must be a legal comment name. Returns a new Map in the final
 * key order.
 */
function applyTagOperations(existing, ops) {
    const { set = {}, remove = [] } = ops || {};
    const result = new Map(Array.from(existing, ([k, v]) => [k, { key: v.key, values: v.values.slice() }]));
    for (const key of remove) result.delete(normalizeKey(key));
    const added = [];
    for (const rawKey of Object.keys(set)) {
        const key = normalizeKey(rawKey);
        const values = normalizeValues(key, set[rawKey]);
        if (values.length === 0) {
            result.delete(key);
        } else if (result.has(key)) {
            result.set(key, { key: result.get(key).key, values });
        } else {
            if (!KEY_RE.test(key)) throw new FlacTagError(`Invalid tag name: ${rawKey}`, 'INVALID_TAG');
            added.push([key, values]);
        }
    }
    added.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [key, values] of added) result.set(key, { key, values });
    return result;
}

/**
 * Encodes the vendor, a grouped map (see groupComments) and the raw entries (kept verbatim
 * after the key=value ones) as a VORBIS_COMMENT body.
 */
function serializeVorbisComment(vendor, tags, raw = []) {
    const parts = [];
    const vendorBytes = Buffer.from(vendor, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(vendorBytes.length, 0);
    parts.push(head, vendorBytes);
    let count = 0;
    const entries = [];
    for (const { key, values } of tags.values()) {
        for (const value of values) {
            const entry = Buffer.from(`${key}=${value}`, 'utf8');
            const len = Buffer.alloc(4);
            len.writeUInt32LE(entry.length, 0);
            entries.push(len, entry);
            count++;
        }
    }
    for (const bytes of raw) {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(bytes.length, 0);
        entries.push(len, bytes);
        count++;
    }
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(count, 0);
    parts.push(countBuf, ...entries);
    const body = Buffer.concat(parts);
    if (body.length > MAX_BLOCK_LENGTH) throw new FlacTagError('Tags too large for one metadata block', 'TOO_LARGE');
    return body;
}

function blockHeader(type, length, isLast) {
    return Buffer.from([(isLast ? 0x80 : 0) | type, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF]);
}

/** The tags of a parsed head buffer as { vendor, tags: {KEY: [values]} } (null vendor when there is no block). */
function readTags(head, parsed = parseMetadata(head)) {
    const vc = parsed.blocks.find(b => b.type === BLOCK_VORBIS_COMMENT);
    if (!vc) return { vendor: null, tags: {} };
    const { vendor, comments } = parseVorbisComment(head.subarray(vc.offset, vc.offset + vc.length));
    return { vendor, tags: tagsObject(groupComments(comments)) };
}

/**
 * Plans the write for `head` (the bytes from the start of the file to the audio offset, at
 * least) and the operations. Returns
 *   { inPlace, metadata, metaStart, audioOffset, prefix, streamInfo, tags, vendor, oldLength }
 * where `metadata` is the complete new metadata region (all block headers and bodies).
 */
function planTagWrite(head, ops, { padding = DEFAULT_PADDING } = {}) {
    const parsed = parseMetadata(head);
    const { metaStart, audioOffset, blocks } = parsed;
    const oldLength = audioOffset - metaStart;

    const vcBlocks = blocks.filter(b => b.type === BLOCK_VORBIS_COMMENT);
    if (vcBlocks.length > 1) {
        throw new FlacTagError('File has multiple comment blocks; not supported', 'MULTIPLE_COMMENT_BLOCKS');
    }
    const firstVc = vcBlocks[0] || null;
    let vendor = DEFAULT_VENDOR;
    let existing = new Map();
    let raw = [];
    if (firstVc) {
        const decoded = parseVorbisComment(head.subarray(firstVc.offset, firstVc.offset + firstVc.length));
        vendor = decoded.vendor;
        existing = groupComments(decoded.comments);
        raw = decoded.raw;
    }
    const tags = applyTagOperations(existing, ops);
    const vcBody = serializeVorbisComment(vendor, tags, raw);

    // New block list: same order, PADDING dropped, the VORBIS_COMMENT replaced (or a new one
    // inserted after STREAMINFO).
    const out = [];
    let replaced = false;
    for (const block of blocks) {
        if (block.type === BLOCK_PADDING) continue;
        if (block.type === BLOCK_VORBIS_COMMENT) {
            out.push({ type: BLOCK_VORBIS_COMMENT, body: vcBody });
            replaced = true;
            continue;
        }
        out.push({ type: block.type, body: head.subarray(block.offset, block.offset + block.length) });
        if (block.type === BLOCK_STREAMINFO && !firstVc && !replaced) {
            out.push({ type: BLOCK_VORBIS_COMMENT, body: vcBody });
            replaced = true;
        }
    }

    let newLength = 0;
    for (const block of out) newLength += 4 + block.body.length;
    const leftover = oldLength - newLength;
    let inPlace;
    let paddingLength;
    if (leftover === 0) {
        inPlace = true;
        paddingLength = -1;                     // no PADDING block at all
    } else if (leftover >= 4) {
        inPlace = true;
        paddingLength = leftover - 4;
    } else {
        inPlace = false;
        paddingLength = Math.max(0, Math.floor(padding));
    }
    if (paddingLength > MAX_BLOCK_LENGTH) {
        // Absurd amount of old padding: keep one maximal block and rewrite so nothing is lost.
        inPlace = false;
        paddingLength = Math.max(0, Math.floor(padding));
    }
    if (paddingLength >= 0) out.push({ type: BLOCK_PADDING, body: Buffer.alloc(paddingLength, 0) });

    const parts = [];
    out.forEach((block, i) => {
        parts.push(blockHeader(block.type, block.body.length, i === out.length - 1), block.body);
    });
    const metadata = Buffer.concat(parts);
    if (inPlace && metadata.length !== oldLength) throw new FlacTagError('Internal error: in-place size mismatch', 'INTERNAL');

    return {
        inPlace,
        metadata,
        metaStart,
        audioOffset,
        prefix: head.subarray(0, metaStart),
        streamInfo: Buffer.from(head.subarray(blocks[0].offset, blocks[0].offset + STREAMINFO_LENGTH)),
        tags: tagsObject(tags),
        vendor,
        oldLength
    };
}

/** Whole-buffer variant (tests, vectors): the complete new file for `original` and `ops`. */
function buildFile(original, ops, options) {
    const parsed = parseMetadata(original);
    const plan = planTagWrite(original.subarray(0, parsed.audioOffset), ops, options);
    return { file: Buffer.concat([plan.prefix, plan.metadata, original.subarray(parsed.audioOffset)]), plan };
}

// --- File system ------------------------------------------------------------------------------

async function readExact(handle, length, position) {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const { bytesRead } = await handle.read(buf, done, length - done, position + done);
        if (bytesRead === 0) break;
        done += bytesRead;
    }
    return done === length ? buf : buf.subarray(0, done);
}

/** Reads the whole metadata region (start of file .. audio offset) through `handle`. */
async function readHead(handle, size) {
    const probe = await readExact(handle, Math.min(size, 10), 0);
    const prefix = id3v2Length(probe);
    let pos = prefix + 4;
    const marker = await readExact(handle, 4, prefix);
    if (marker.length < 4 || marker.compare(MARKER) !== 0) throw new FlacTagError('Not a FLAC file', 'NOT_FLAC');
    for (let n = 0; ; n++) {
        if (n >= MAX_BLOCKS) throw new FlacTagError('Too many metadata blocks', 'CORRUPT');
        const header = await readExact(handle, 4, pos);
        if (header.length < 4) throw new FlacTagError('Truncated metadata block header', 'TRUNCATED');
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        pos += 4 + length;
        if (pos > size) throw new FlacTagError('Truncated metadata block', 'TRUNCATED');
        if (pos > MAX_METADATA_BYTES) throw new FlacTagError('Metadata region too large', 'TOO_LARGE');
        if (header[0] & 0x80) break;
    }
    const head = await readExact(handle, pos, 0);
    if (head.length < pos) throw new FlacTagError('Truncated metadata', 'TRUNCATED');
    return head;
}

function hashStream(stream) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** SHA-256 (hex) of the bytes of `file` from `start` to the end. */
function hashAudio(file, start) {
    return hashStream(fs.createReadStream(file, { start }));
}

function tagsEqual(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return false;
        const va = a[ka[i]];
        const vb = b[kb[i]];
        if (va.length !== vb.length || va.some((v, j) => v !== vb[j])) return false;
    }
    return true;
}

/**
 * Re-reads `file` and checks it against the plan: STREAMINFO bytes, audio hash, tags.
 * Returns null when everything matches, else a description of the mismatch.
 */
async function verifyFile(file, plan, expectedAudioHash, { fullHash = true } = {}) {
    const handle = await fsp.open(file, 'r');
    let head;
    try {
        const { size } = await handle.stat();
        head = await readHead(handle, size);
    } finally {
        await handle.close();
    }
    let parsed;
    try {
        parsed = parseMetadata(head);
    } catch (e) {
        return `metadata unreadable after write: ${e.message}`;
    }
    const streamInfo = head.subarray(parsed.blocks[0].offset, parsed.blocks[0].offset + STREAMINFO_LENGTH);
    if (streamInfo.compare(plan.streamInfo) !== 0) return 'STREAMINFO changed';
    const written = readTags(head, parsed);
    if (!tagsEqual(written.tags, plan.tags)) return 'tags read back differ from the tags written';
    if (fullHash) {
        const actual = await hashAudio(file, parsed.audioOffset);
        if (actual !== expectedAudioHash) return 'audio data changed';
    }
    return null;
}

function tempNameFor(file) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const rand = crypto.randomBytes(6).toString('hex');
    return path.join(dir, `.${base}.crossroads-${process.pid}-${rand}.tmp`);
}

async function unlinkQuietly(file) {
    try { await fsp.unlink(file); } catch { /* ignore */ }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_BACKOFF_MS = [50, 100, 200, 400, 800];

/**
 * fsp.rename with, on Windows only, a few retries while another program holds the target
 * (antivirus scanners, players with the file open). After the retries the error is reported
 * as FILE_IN_USE. Injectable for tests.
 */
async function renameWithRetry(from, to, {
    platform = process.platform,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    attempts = RENAME_BACKOFF_MS.length + 1,
    rename = (a, b) => fsp.rename(a, b)
} = {}) {
    const retry = platform === 'win32';
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(from, to);
            return attempt;
        } catch (e) {
            if (!retry || !RENAME_RETRY_CODES.has(e && e.code) || attempt >= attempts - 1) {
                if (retry && RENAME_RETRY_CODES.has(e && e.code)) {
                    throw new FlacTagError('File is in use by another program', 'FILE_IN_USE');
                }
                throw e;
            }
            await sleep(RENAME_BACKOFF_MS[Math.min(attempt, RENAME_BACKOFF_MS.length - 1)]);
        }
    }
}

/** fsync of a directory so a rename inside it is durable (best effort; not supported on Windows). */
async function syncDirectory(dir) {
    if (process.platform === 'win32') return;
    let handle = null;
    try {
        handle = await fsp.open(dir, 'r');
        await handle.sync();
    } catch { /* best effort */ } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

/** `/bin/cp -c` (clonefile(2)): an O(1) APFS clone carrying xattrs, ACLs and mode. No shell. */
function cloneFileDarwin(file, temp) {
    return new Promise((resolve, reject) => {
        execFile('/bin/cp', ['-c', '--', file, temp], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
}

/**
 * Creates the temp file. On macOS it is an APFS clone of the original (so extended
 * attributes, ACLs and mode come along; libuv's copyfile() drops xattrs, /bin/cp -c keeps
 * them) that is then truncated; elsewhere, or when cloning is unavailable, a fresh
 * exclusive file.
 */
async function createTemp(file, temp, mode) {
    if (process.platform === 'darwin') {
        try {
            await cloneFileDarwin(file, temp);
            const handle = await fsp.open(temp, 'r+');
            try {
                await handle.truncate(0);
            } catch (e) {
                await handle.close().catch(() => {});
                throw e;
            }
            return handle;
        } catch {
            await unlinkQuietly(temp);
            // Not APFS (or clone refused): plain file below.
        }
    }
    return fsp.open(temp, 'wx', mode);
}

async function writeAll(handle, buf) {
    let done = 0;
    while (done < buf.length) {
        const { bytesWritten } = await handle.write(buf, done, buf.length - done);
        if (!(bytesWritten > 0)) throw new FlacTagError('Short write', 'IO');
        done += bytesWritten;
    }
}

/**
 * Writes tag operations to a FLAC file.
 *
 * @param {string} file          Absolute path (symlinks are resolved; the real file is replaced).
 * @param {{set?:Object, remove?:string[]}} ops
 * @param {Object} [options]
 * @param {number} [options.padding]           PADDING written when the region grows (DEFAULT_PADDING).
 * @param {Function} [options.beforeReplace]   Test hook, awaited after the temp file is complete
 *                                             and verified but before it replaces the original.
 * @returns {Promise<{strategy:'rewrite', tags:Object, changed:boolean}>}
 */
async function writeFlacTags(file, ops, options = {}) {
    file = await fsp.realpath(file);
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new FlacTagError('Not a regular file', 'NOT_FILE');
    if (st.nlink > 1) throw new FlacTagError('File has hard links; editing it would break them', 'HARD_LINKS');
    // A rename would bypass the file's own permissions; honour a read-only file as other tools do.
    try {
        await fsp.access(file, fs.constants.W_OK);
    } catch {
        throw new FlacTagError('File is read-only', 'READ_ONLY');
    }

    // Plan from a read-only handle; hash the audio only once we know something changes.
    const handle = await fsp.open(file, 'r');
    let plan;
    let audioHash;
    try {
        const head = await readHead(handle, st.size);
        plan = planTagWrite(head, ops, options);
        if (head.subarray(plan.metaStart, plan.audioOffset).compare(plan.metadata) === 0) {
            return { strategy: 'rewrite', tags: plan.tags, changed: false };
        }
        audioHash = await hashStream(handle.createReadStream({ start: plan.audioOffset, autoClose: false }));
    } finally {
        await handle.close();
    }

    const mode = st.mode & 0o7777;
    let temp = tempNameFor(file);
    for (let i = 0; i < 3 && fs.existsSync(temp); i++) temp = tempNameFor(file);   // a stale temp of a dead process
    const out = await createTemp(file, temp, mode);
    try {
        try {
            await writeAll(out, plan.prefix);
            await writeAll(out, plan.metadata);
            const audio = fs.createReadStream(file, { start: plan.audioOffset });
            for await (const chunk of audio) await writeAll(out, chunk);
            await out.sync();
            await out.chmod(mode);                      // exact bits, whatever the umask
            try {
                await out.chown(st.uid, st.gid);
            } catch (e) {
                if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EINVAL'].includes(e && e.code)) throw e;
            }
        } finally {
            await out.close();
        }
        const problem = await verifyFile(temp, plan, audioHash);
        if (problem) throw new FlacTagError(`Verification failed (${problem}); the original file was not modified`, 'VERIFY_FAILED');

        if (typeof options.beforeReplace === 'function') await options.beforeReplace(temp);
        // Someone else edited the original while the copy was being made: their version wins.
        const now = await fsp.stat(file);
        if (now.size !== st.size || now.mtimeMs !== st.mtimeMs || now.ino !== st.ino) {
            throw new FlacTagError('File changed on disk while editing; nothing was written', 'CHANGED_UNDERNEATH');
        }
        await renameWithRetry(temp, file, options.rename || {});
    } catch (e) {
        await unlinkQuietly(temp);
        throw e;
    }
    await syncDirectory(path.dirname(file));
    // The renamed file is the verified temp; a header-level check confirms the rename landed.
    // From here on the write has happened: an I/O error re-reading is reported as such, never
    // as a failed write.
    let problem;
    try {
        problem = await verifyFile(file, plan, audioHash, { fullHash: false });
    } catch (e) {
        throw new FlacTagError(`Could not re-read the file after replacing it (${e.message}); the replacement was verified before it went in`, 'REREAD_FAILED');
    }
    if (problem) throw new FlacTagError(`Verification failed after replace (${problem})`, 'VERIFY_FAILED');
    return { strategy: 'rewrite', tags: plan.tags, changed: true };
}

/** Tags of a FLAC file as { vendor, tags }, read directly from the file. */
async function readFlacTags(file) {
    const handle = await fsp.open(file, 'r');
    try {
        const { size } = await handle.stat();
        return readTags(await readHead(handle, size));
    } finally {
        await handle.close();
    }
}

module.exports = {
    FlacTagError,
    DEFAULT_PADDING,
    DEFAULT_VENDOR,
    JS_SPACE,
    jsTrim,
    isBlank,
    foldKey,
    parseMetadata,
    parseVorbisComment,
    groupComments,
    tagsObject,
    applyTagOperations,
    serializeVorbisComment,
    planTagWrite,
    buildFile,
    readTags,
    readFlacTags,
    writeFlacTags,
    renameWithRetry,
    verifyFile,
    hashAudio
};
