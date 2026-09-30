// Pure-JS FLAC decoder for the quality analyser (#28).
//
// Why our own decoder: the analysis needs exact integer samples at the file's native rate
// from a handful of short windows scattered across the track, on Android (WebView), on
// Electron (production CSP: script-src 'self', no wasm-unsafe-eval) and in Node for the
// tests. FLAC's frame format is small enough that a straightforward decoder (~400 lines)
// beats shipping a WASM build plus a CSP relaxation. It decodes any FLAC subset stream
// (fixed/LPC/verbatim/constant subframes, Rice/Rice2 residuals, wasted bits, left/right/
// mid-side stereo, 8..32 bit) and returns Int32Array per channel, so 24-bit low-byte
// analysis sees the file's bits verbatim.
//
// Seeking works without decoding from the start: after a byte-range read the decoder
// searches for a frame sync code, validates the header CRC-8 against STREAMINFO and only
// accepts a frame whose CRC-16 matches, so a false sync cannot leak garbage samples.

const SYNC_CODE = 0x3FFE; // 14 bits: 11111111111110

const BLOCK_STREAMINFO = 0;
const BLOCK_SEEKTABLE = 3;
const STREAMINFO_LENGTH = 34;
const MAX_METADATA_BLOCKS = 128;

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
(() => {
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
        CRC8_TABLE[i] = c;
        let d = i << 8;
        for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xFFFF : (d << 1) & 0xFFFF;
        CRC16_TABLE[i] = d;
    }
})();

export function crc8(bytes, start, end) {
    let c = 0;
    for (let i = start; i < end; i++) c = CRC8_TABLE[c ^ bytes[i]];
    return c;
}

export function crc16(bytes, start, end) {
    let c = 0;
    for (let i = start; i < end; i++) c = CRC16_TABLE[((c >> 8) ^ bytes[i]) & 0xFF] ^ ((c << 8) & 0xFFFF);
    return c;
}

export class FlacError extends Error {
    constructor(message, code = 'invalid') {
        super(message);
        this.name = 'FlacError';
        this.code = code; // 'invalid' | 'eof' | 'unsupported'
    }
}

const eof = () => new FlacError('unexpected end of data', 'eof');

// ---- Bit reader -------------------------------------------------------------------------

class BitReader {
    constructor(bytes, bytePos, byteEnd) {
        this.b = bytes;
        this.pos = bytePos;     // next byte to load into the cache
        this.end = byteEnd;
        this.cache = 0;         // up to 8 bits, right-aligned
        this.cacheBits = 0;
    }

    /** Unsigned n-bit value, n in 1..32. */
    readBits(n) {
        let result = 0;
        while (n > 0) {
            if (this.cacheBits === 0) {
                if (this.pos >= this.end) throw eof();
                this.cache = this.b[this.pos++];
                this.cacheBits = 8;
            }
            const take = n < this.cacheBits ? n : this.cacheBits;
            const bits = (this.cache >> (this.cacheBits - take)) & ((1 << take) - 1);
            result = result * (1 << take) + bits; // multiplication keeps 32-bit reads exact
            this.cacheBits -= take;
            n -= take;
        }
        return result;
    }

    /** Signed two's-complement n-bit value, n in 1..33 (33 for a 32-bit side channel). */
    readSigned(n) {
        const v = this.readBits(n);
        return v >= 2 ** (n - 1) ? v - 2 ** n : v;
    }

    /** Count of zero bits before the next one bit (the one is consumed). */
    readUnary() {
        let count = 0;
        for (;;) {
            if (this.cacheBits === 0) {
                if (this.pos >= this.end) throw eof();
                this.cache = this.b[this.pos++];
                this.cacheBits = 8;
                if (this.cache === 0) { count += 8; this.cacheBits = 0; continue; }
            }
            const mask = (1 << this.cacheBits) - 1;
            const v = this.cache & mask;
            if (v === 0) { count += this.cacheBits; this.cacheBits = 0; continue; }
            // Position of the highest set bit within the remaining cacheBits.
            const lead = this.cacheBits - 1 - (31 - Math.clz32(v));
            count += lead;
            this.cacheBits -= lead + 1;
            return count;
        }
    }

    alignToByte() { this.cacheBits = 0; }

    /** Byte offset of the next unread byte (only meaningful when byte-aligned). */
    bytePosition() { return this.pos; }
}

// ---- Metadata ---------------------------------------------------------------------------

/** Byte length of an ID3v2 tag at the start of `bytes` (some FLACs carry one), or 0. */
export function id3v2Length(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
    const size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) | ((bytes[8] & 0x7F) << 7) | (bytes[9] & 0x7F);
    const footer = (bytes[5] & 0x10) ? 10 : 0;
    return 10 + size + footer;
}

export function parseStreamInfo(buf, offset = 0) {
    const u32 = (i) => ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    const o = offset;
    const minBlockSize = (buf[o] << 8) | buf[o + 1];
    const maxBlockSize = (buf[o + 2] << 8) | buf[o + 3];
    const sampleRate = (u32(o + 10) >>> 12) & 0xFFFFF;
    const channels = ((buf[o + 12] >> 1) & 0x07) + 1;
    const bitsPerSample = (((buf[o + 12] & 0x01) << 4) | (buf[o + 13] >> 4)) + 1;
    const totalSamples = (buf[o + 13] & 0x0F) * 2 ** 32 + u32(o + 14);
    let md5 = '';
    let allZero = true;
    for (let i = 0; i < 16; i++) {
        const b = buf[o + 18 + i];
        if (b !== 0) allZero = false;
        md5 += b.toString(16).padStart(2, '0');
    }
    return { minBlockSize, maxBlockSize, sampleRate, channels, bitsPerSample, totalSamples, md5: allZero ? null : md5 };
}

function parseSeekTable(buf, offset, length) {
    const points = [];
    const count = Math.floor(length / 18);
    for (let i = 0; i < count; i++) {
        const o = offset + i * 18;
        const hi = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
        const lo = ((buf[o + 4] << 24) | (buf[o + 5] << 16) | (buf[o + 6] << 8) | buf[o + 7]) >>> 0;
        if (hi === 0xFFFFFFFF && lo === 0xFFFFFFFF) continue; // placeholder point
        const sampleNumber = hi * 4294967296 + lo;
        const ohi = ((buf[o + 8] << 24) | (buf[o + 9] << 16) | (buf[o + 10] << 8) | buf[o + 11]) >>> 0;
        const olo = ((buf[o + 12] << 24) | (buf[o + 13] << 16) | (buf[o + 14] << 8) | buf[o + 15]) >>> 0;
        const byteOffset = ohi * 4294967296 + olo;
        const frameSamples = (buf[o + 16] << 8) | buf[o + 17];
        points.push({ sampleNumber, byteOffset, frameSamples });
    }
    points.sort((a, b) => a.sampleNumber - b.sampleNumber);
    return points;
}

/**
 * Walks the metadata blocks of a FLAC stream through a byte source
 * ({ read(offset, length) -> Promise<Uint8Array> }). Only STREAMINFO and SEEKTABLE bodies are
 * read; pictures and tags are skipped by offset.
 *
 * @returns {Promise<{streamInfo, seekTable: Array, audioOffset: number} | null>} null when the
 *          source is not a FLAC stream.
 */
export async function readFlacHeader(source) {
    const FIRST = 65536;
    let buf = await source.read(0, FIRST);
    if (buf.length < 4) return null;
    let bufStart = 0;
    let position = id3v2Length(buf);
    if (position > 0 && position + 4 > buf.length) {
        // A large ID3v2 tag (cover art) sits in front of the stream: re-read the head from
        // where the FLAC metadata actually starts so it comes from one buffer, not many reads.
        buf = await source.read(position, FIRST);
        bufStart = position;
    }
    const magic = async (at) => {
        const m = await bytesAt(at, 4);
        return m.length === 4 && m[0] === 0x66 && m[1] === 0x4C && m[2] === 0x61 && m[3] === 0x43; // fLaC
    };
    // Returns `length` bytes at `at`, from the initial buffer when possible.
    const bytesAt = async (at, length) => {
        if (at >= bufStart && at + length <= bufStart + buf.length) return buf.subarray(at - bufStart, at - bufStart + length);
        const extra = await source.read(at, length);
        return extra;
    };
    if (!(await magic(position))) return null;
    position += 4;

    let streamInfo = null;
    let seekTable = [];
    for (let n = 0; n < MAX_METADATA_BLOCKS; n++) {
        const header = await bytesAt(position, 4);
        if (header.length < 4) break;
        position += 4;
        const isLast = (header[0] & 0x80) !== 0;
        const type = header[0] & 0x7F;
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        if (type === BLOCK_STREAMINFO && length === STREAMINFO_LENGTH && !streamInfo) {
            const body = await bytesAt(position, STREAMINFO_LENGTH);
            if (body.length < STREAMINFO_LENGTH) break;
            streamInfo = parseStreamInfo(body, 0);
        } else if (type === BLOCK_SEEKTABLE && length > 0 && length <= 18 * 100000) {
            const body = await bytesAt(position, length);
            if (body.length === length) seekTable = parseSeekTable(body, 0, length);
        }
        position += length;
        if (isLast) break;
    }
    if (!streamInfo) return null;
    return { streamInfo, seekTable, audioOffset: position };
}

// ---- Frames -----------------------------------------------------------------------------

const BLOCK_SIZE_CODES = [0, 192, 576, 1152, 2304, 4608, -8, -16, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_RATE_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, -8, -16, -160, -1];
const SAMPLE_SIZE_CODES = [0, 8, 12, -1, 16, 20, 24, 32];

function readUtf8Number(r) {
    const b0 = r.readBits(8);
    if (b0 < 0x80) return b0;
    let extra;
    let value;
    if ((b0 & 0xE0) === 0xC0) { extra = 1; value = b0 & 0x1F; }
    else if ((b0 & 0xF0) === 0xE0) { extra = 2; value = b0 & 0x0F; }
    else if ((b0 & 0xF8) === 0xF0) { extra = 3; value = b0 & 0x07; }
    else if ((b0 & 0xFC) === 0xF8) { extra = 4; value = b0 & 0x03; }
    else if ((b0 & 0xFE) === 0xFC) { extra = 5; value = b0 & 0x01; }
    else if (b0 === 0xFE) { extra = 6; value = 0; }
    else throw new FlacError('bad utf8 number');
    for (let i = 0; i < extra; i++) {
        const b = r.readBits(8);
        if ((b & 0xC0) !== 0x80) throw new FlacError('bad utf8 continuation');
        value = value * 64 + (b & 0x3F);
    }
    return value;
}

/**
 * Parses and validates a frame header starting at byte `pos`. Returns null when the bytes
 * there are not a frame header consistent with `streamInfo` (sync, reserved bits, CRC-8).
 */
export function parseFrameHeader(bytes, pos, end, streamInfo) {
    if (pos + 5 > end) return null;
    if (bytes[pos] !== 0xFF || (bytes[pos + 1] & 0xFC) !== 0xF8) return null;
    const r = new BitReader(bytes, pos, end);
    try {
        if (r.readBits(14) !== SYNC_CODE) return null;
        if (r.readBits(1) !== 0) return null;
        const variableBlockSize = r.readBits(1) === 1;
        const bsCode = r.readBits(4);
        const srCode = r.readBits(4);
        const chCode = r.readBits(4);
        const ssCode = r.readBits(3);
        if (r.readBits(1) !== 0) return null;
        if (bsCode === 0 || srCode === 15 || chCode > 10 || ssCode === 3) return null;

        const number = readUtf8Number(r);

        let blockSize = BLOCK_SIZE_CODES[bsCode];
        if (blockSize === -8) blockSize = r.readBits(8) + 1;
        else if (blockSize === -16) blockSize = r.readBits(16) + 1;

        let sampleRate = SAMPLE_RATE_CODES[srCode];
        if (sampleRate === 0) sampleRate = streamInfo.sampleRate;
        else if (sampleRate === -8) sampleRate = r.readBits(8) * 1000;
        else if (sampleRate === -16) sampleRate = r.readBits(16);
        else if (sampleRate === -160) sampleRate = r.readBits(16) * 10;

        let channels;
        let assignment = 'independent';
        if (chCode < 8) channels = chCode + 1;
        else { channels = 2; assignment = chCode === 8 ? 'left-side' : chCode === 9 ? 'right-side' : 'mid-side'; }

        let bitsPerSample = SAMPLE_SIZE_CODES[ssCode];
        if (bitsPerSample === 0) bitsPerSample = streamInfo.bitsPerSample;

        r.alignToByte();
        const crcPos = r.bytePosition();
        if (crcPos >= end) return null;
        if (crc8(bytes, pos, crcPos) !== bytes[crcPos]) return null;

        if (sampleRate !== streamInfo.sampleRate || channels !== streamInfo.channels ||
            bitsPerSample !== streamInfo.bitsPerSample) return null;
        if (blockSize > streamInfo.maxBlockSize && streamInfo.maxBlockSize > 0) return null;

        const firstSample = variableBlockSize ? number : number * streamInfo.minBlockSize;
        return {
            offset: pos, headerEnd: crcPos + 1, blockSize, sampleRate, channels, assignment,
            bitsPerSample, variableBlockSize, number, firstSample
        };
    } catch (e) {
        if (e instanceof FlacError) return null;
        throw e;
    }
}

function readResidual(r, out, blockSize, predOrder) {
    const method = r.readBits(2);
    if (method > 1) throw new FlacError('reserved residual coding method');
    const paramBits = method === 0 ? 4 : 5;
    const escape = method === 0 ? 15 : 31;
    const partitionOrder = r.readBits(4);
    const partitions = 1 << partitionOrder;
    const partitionSamples = blockSize >> partitionOrder;
    if (partitionOrder > 0 && partitionSamples < predOrder) throw new FlacError('bad partition order');
    let i = predOrder;
    for (let p = 0; p < partitions; p++) {
        const count = (p === 0 ? (partitionOrder === 0 ? blockSize : partitionSamples) - predOrder : partitionSamples);
        const param = r.readBits(paramBits);
        if (param === escape) {
            const bits = r.readBits(5);
            if (bits === 0) { for (let k = 0; k < count; k++) out[i++] = 0; }
            else for (let k = 0; k < count; k++) out[i++] = r.readSigned(bits);
        } else if (param === 0) {
            for (let k = 0; k < count; k++) {
                const q = r.readUnary();
                out[i++] = (q & 1) ? -((q + 1) >> 1) : (q >> 1);
            }
        } else {
            for (let k = 0; k < count; k++) {
                const q = r.readUnary();
                const v = q * (1 << param) + r.readBits(param);
                out[i++] = (v & 1) ? -((v + 1) / 2) : (v / 2);
            }
        }
    }
}

function restoreFixed(out, n, order) {
    switch (order) {
        case 0: return;
        case 1: for (let i = 1; i < n; i++) out[i] += out[i - 1]; return;
        case 2: for (let i = 2; i < n; i++) out[i] += 2 * out[i - 1] - out[i - 2]; return;
        case 3: for (let i = 3; i < n; i++) out[i] += 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]; return;
        case 4: for (let i = 4; i < n; i++) out[i] += 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4]; return;
        default: throw new FlacError('bad fixed order');
    }
}

function restoreLpc(out, n, order, coefs, shift) {
    // Products are at most 2^15 * 2^33 * 32 = 2^53: exact in doubles, and dividing by a power
    // of two is exact too, so Math.floor reproduces the spec's arithmetic right shift. `out`
    // is a Float64Array for a 33-bit side channel and an Int32Array otherwise; in the latter
    // case a residual or prediction that momentarily overflows 32 bits wraps, and since the
    // final sample fits in 32 bits by definition the wrapped sum is still exact.
    const scale = 2 ** -shift;
    for (let i = order; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < order; j++) sum += coefs[j] * out[i - 1 - j];
        out[i] += Math.floor(sum * scale);
    }
}

function decodeSubframe(r, out, blockSize, bps) {
    if (r.readBits(1) !== 0) throw new FlacError('subframe padding bit set');
    const type = r.readBits(6);
    let wasted = 0;
    if (r.readBits(1) === 1) wasted = r.readUnary() + 1;
    const sbps = bps - wasted;
    // 33 bits: the side channel of a 32-bit stereo stream (libFLAC >= 1.4 writes those).
    if (sbps <= 0 || sbps > 33) throw new FlacError('bad subframe sample size');

    if (type === 0) {
        const v = r.readSigned(sbps);
        for (let i = 0; i < blockSize; i++) out[i] = v;
    } else if (type === 1) {
        for (let i = 0; i < blockSize; i++) out[i] = r.readSigned(sbps);
    } else if ((type & 0x38) === 0x08) {
        const order = type & 0x07;
        if (order > 4) throw new FlacError('reserved fixed order');
        if (order > blockSize) throw new FlacError('order exceeds block size');
        for (let i = 0; i < order; i++) out[i] = r.readSigned(sbps);
        readResidual(r, out, blockSize, order);
        restoreFixed(out, blockSize, order);
    } else if ((type & 0x20) === 0x20) {
        const order = (type & 0x1F) + 1;
        if (order > blockSize) throw new FlacError('order exceeds block size');
        for (let i = 0; i < order; i++) out[i] = r.readSigned(sbps);
        const precision = r.readBits(4) + 1;
        if (precision === 16) throw new FlacError('invalid lpc precision');
        const shift = r.readSigned(5);
        if (shift < 0) throw new FlacError('negative lpc shift');
        const coefs = new Array(order);
        for (let i = 0; i < order; i++) coefs[i] = r.readSigned(precision);
        readResidual(r, out, blockSize, order);
        restoreLpc(out, blockSize, order, coefs, shift);
    } else {
        throw new FlacError('reserved subframe type');
    }

    if (wasted > 0) {
        const m = 2 ** wasted;
        for (let i = 0; i < blockSize; i++) out[i] *= m;
    }
}

/**
 * Decodes the frame whose header was parsed at `header`. Returns { channels: Int32Array[],
 * blockSize, nextOffset } or throws FlacError (code 'eof' when the frame is cut off).
 */
export function decodeFrame(bytes, end, header, streamInfo) {
    const { blockSize, channels: nch, assignment, bitsPerSample: bps } = header;
    const r = new BitReader(bytes, header.headerEnd, end);
    const out = [];
    for (let c = 0; c < nch; c++) {
        let cbps = bps;
        if ((assignment === 'left-side' && c === 1) || (assignment === 'right-side' && c === 0) ||
            (assignment === 'mid-side' && c === 1)) cbps += 1;
        // A 33-bit side channel does not fit an Int32Array: decode it in doubles (exact up to
        // 2^53) and convert once left/right are reconstructed, which are 32-bit again.
        const buf = cbps > 32 ? new Float64Array(blockSize) : new Int32Array(blockSize);
        decodeSubframe(r, buf, blockSize, cbps);
        out.push(buf);
    }
    r.alignToByte();
    const crcPos = r.bytePosition();
    if (crcPos + 2 > end) throw eof();
    const stored = (bytes[crcPos] << 8) | bytes[crcPos + 1];
    if (crc16(bytes, header.offset, crcPos) !== stored) throw new FlacError('frame crc mismatch', 'crc');

    if (assignment === 'left-side') {
        const [l, s] = out;
        for (let i = 0; i < blockSize; i++) s[i] = l[i] - s[i];
    } else if (assignment === 'right-side') {
        const [s, rr] = out;
        for (let i = 0; i < blockSize; i++) s[i] = rr[i] + s[i];
    } else if (assignment === 'mid-side') {
        const [m, s] = out;
        for (let i = 0; i < blockSize; i++) {
            const side = s[i];
            let mid = m[i] * 2;
            if (side % 2 !== 0) mid += 1; // `% 2` rather than `& 1`: side may exceed 32 bits
            m[i] = (mid + side) / 2;
            s[i] = (mid - side) / 2;
        }
    }
    for (let c = 0; c < nch; c++) {
        if (!(out[c] instanceof Int32Array)) out[c] = Int32Array.from(out[c]);
    }
    return { channels: out, blockSize, nextOffset: crcPos + 2 };
}

/**
 * Decodes consecutive frames from `bytes` starting at `startOffset` (which need not be a
 * frame boundary: the first valid frame after it is used) until `maxSamples` samples per
 * channel are collected or the data runs out.
 *
 * @returns {{ channels: Int32Array[], samples: number, firstSample: number|null,
 *             nextOffset: number, frames: number, truncated: boolean }}
 *   nextOffset: the byte after the last complete frame (where a continuation read should
 *   start). truncated: the buffer ended inside a frame (more data exists beyond it).
 */
export function decodeFrames(bytes, startOffset, streamInfo, { maxSamples = Infinity, end = bytes.length } = {}) {
    const nch = streamInfo.channels;
    const parts = [];
    let samples = 0;
    let frames = 0;
    let firstSample = null;
    let pos = startOffset;
    let nextOffset = startOffset;
    let truncated = false;
    let expectNext = -1; // firstSample the next frame should carry, once synced

    while (pos + 2 <= end && samples < maxSamples) {
        if (bytes[pos] !== 0xFF || (bytes[pos + 1] & 0xFC) !== 0xF8) { pos++; continue; }
        const header = parseFrameHeader(bytes, pos, end, streamInfo);
        if (!header) { pos++; continue; }
        let frame;
        try {
            frame = decodeFrame(bytes, end, header, streamInfo);
        } catch (e) {
            if (!(e instanceof FlacError)) throw e;
            if (e.code === 'eof') { truncated = true; break; }
            pos++; // false sync or damaged frame: keep scanning
            continue;
        }
        if (expectNext >= 0 && header.firstSample !== expectNext && !header.variableBlockSize) {
            // A frame that does not follow the previous one is most likely a false sync
            // inside the previous frame's data; but it passed CRC-16, so trust it and resync.
            expectNext = -1;
        }
        if (firstSample === null) firstSample = header.firstSample;
        expectNext = header.firstSample + header.blockSize;
        parts.push(frame.channels);
        samples += frame.blockSize;
        frames++;
        pos = frame.nextOffset;
        nextOffset = pos;
    }

    const channels = [];
    for (let c = 0; c < nch; c++) {
        const buf = new Int32Array(samples);
        let o = 0;
        for (const p of parts) { buf.set(p[c], o); o += p[c].length; }
        channels.push(buf);
    }
    return { channels, samples, firstSample, nextOffset, frames, truncated };
}

/**
 * Estimates the byte offset of `sample` using the SEEKTABLE when present, else the average
 * bytes-per-sample of the stream (which needs a finite `fileSize`; without one and without a
 * seek table the stream start is returned). Never past the end.
 */
export function estimateByteOffset(header, fileSize, sample) {
    const { streamInfo, seekTable, audioOffset } = header;
    const total = streamInfo.totalSamples || 0;
    const sized = Number.isFinite(fileSize) && fileSize > 0;
    if (seekTable && seekTable.length > 0) {
        let best = null;
        for (const p of seekTable) { if (p.sampleNumber <= sample) best = p; else break; }
        if (best) return sized ? Math.min(fileSize - 1, audioOffset + best.byteOffset) : audioOffset + best.byteOffset;
    }
    if (total > 0 && sized && fileSize > audioOffset) {
        const perSample = (fileSize - audioOffset) / total;
        return Math.min(fileSize - 1, Math.floor(audioOffset + sample * perSample));
    }
    return audioOffset;
}

/** Whether the stream can be positioned without decoding from the start. */
export const canSeek = (header, fileSize) =>
    (header.seekTable && header.seekTable.length > 0) || (Number.isFinite(fileSize) && fileSize > 0);
