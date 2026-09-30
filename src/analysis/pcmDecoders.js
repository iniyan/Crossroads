// WAV (RIFF) and AIFF/AIFF-C PCM readers: header walk through a byte source, then windows
// are read straight from the data chunk (integer samples as Int32Array, floats as
// Float32Array).

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
const MAX_CHUNKS = 64;

/** 80-bit IEEE extended (AIFF sample rate) -> number. */
export function readExtended(b, o) {
    const sign = (b[o] & 0x80) ? -1 : 1;
    const exp = ((b[o] & 0x7F) << 8) | b[o + 1];
    const hi = u32be(b, o + 2);
    const lo = u32be(b, o + 6);
    if (exp === 0 && hi === 0 && lo === 0) return 0;
    const mantissa = hi * 4294967296 + lo;
    return sign * mantissa * 2 ** (exp - 16383 - 63);
}

/**
 * @returns {Promise<null | { kind:'WAV', sampleRate, channels, containerBits, validBits, isFloat,
 *           littleEndian: true, dataOffset, dataLength, totalSamples }>}
 */
export async function readWavHeader(source) {
    let buf = await source.read(0, 65536);
    if (buf.length < 12 || fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WAVE') return null;
    const bytesAt = async (at, len) => (at + len <= buf.length ? buf.subarray(at, at + len) : source.read(at, len));
    let pos = 12;
    let fmt = null;
    for (let n = 0; n < MAX_CHUNKS; n++) {
        const h = await bytesAt(pos, 8);
        if (h.length < 8) return null;
        const id = fourcc(h, 0);
        const size = u32le(h, 4);
        if (id === 'fmt ') {
            const body = await bytesAt(pos + 8, Math.min(size, 40));
            if (body.length < 16) return null;
            let tag = u16le(body, 0);
            const channels = u16le(body, 2);
            const sampleRate = u32le(body, 4);
            const blockAlign = u16le(body, 12);
            const containerBits = u16le(body, 14);
            let validBits = containerBits;
            if (tag === WAVE_FORMAT_EXTENSIBLE && body.length >= 26) {
                validBits = u16le(body, 18) || containerBits;
                tag = u16le(body, 24); // first two bytes of the SubFormat GUID
            }
            if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_IEEE_FLOAT) return null;
            fmt = { sampleRate, channels, containerBits, validBits, isFloat: tag === WAVE_FORMAT_IEEE_FLOAT, blockAlign };
        } else if (id === 'data') {
            if (!fmt) return null;
            const size64 = size === 0xFFFFFFFF ? source.size - (pos + 8) : size;
            const dataLength = Math.max(0, Math.min(size64, (source.size || Infinity) - (pos + 8)));
            const frameBytes = fmt.blockAlign || (fmt.channels * fmt.containerBits / 8);
            return {
                kind: 'WAV', ...fmt, littleEndian: true, dataOffset: pos + 8, dataLength,
                totalSamples: Math.floor(dataLength / frameBytes)
            };
        }
        pos += 8 + size + (size & 1);
    }
    return null;
}

/**
 * @returns {Promise<null | { kind:'AIFF', sampleRate, channels, containerBits, validBits, isFloat:false,
 *           littleEndian, dataOffset, dataLength, totalSamples }>}
 */
export async function readAiffHeader(source) {
    let buf = await source.read(0, 65536);
    if (buf.length < 12 || fourcc(buf, 0) !== 'FORM') return null;
    const form = fourcc(buf, 8);
    if (form !== 'AIFF' && form !== 'AIFC') return null;
    const bytesAt = async (at, len) => (at + len <= buf.length ? buf.subarray(at, at + len) : source.read(at, len));
    let pos = 12;
    let comm = null;
    for (let n = 0; n < MAX_CHUNKS; n++) {
        const h = await bytesAt(pos, 8);
        if (h.length < 8) return null;
        const id = fourcc(h, 0);
        const size = u32be(h, 4);
        if (id === 'COMM') {
            const body = await bytesAt(pos + 8, Math.min(size, 22));
            if (body.length < 18) return null;
            const channels = u16be(body, 0);
            const frames = u32be(body, 2);
            const validBits = u16be(body, 6);
            const sampleRate = Math.round(readExtended(body, 8));
            let littleEndian = false;
            if (form === 'AIFC') {
                if (body.length < 22) return null;
                const compression = fourcc(body, 18);
                if (compression === 'sowt') littleEndian = true;
                else if (compression !== 'NONE') return null;
            }
            const containerBits = Math.ceil(validBits / 8) * 8;
            comm = { channels, frames, validBits, containerBits, sampleRate, littleEndian };
        } else if (id === 'SSND') {
            if (!comm) return null;
            const body = await bytesAt(pos + 8, 8);
            if (body.length < 8) return null;
            const offset = u32be(body, 0);
            const dataOffset = pos + 16 + offset;
            const frameBytes = comm.channels * comm.containerBits / 8;
            const dataLength = Math.min(size - 8 - offset, comm.frames * frameBytes);
            return {
                kind: 'AIFF', sampleRate: comm.sampleRate, channels: comm.channels, containerBits: comm.containerBits,
                validBits: comm.validBits, isFloat: false, littleEndian: comm.littleEndian, dataOffset,
                dataLength, totalSamples: Math.floor(dataLength / frameBytes)
            };
        }
        pos += 8 + size + (size & 1);
    }
    return null;
}

/**
 * Splits interleaved PCM bytes into per-channel arrays.
 * @returns {{ channels: Int32Array[]|Float32Array[], samples: number }}
 */
export function splitPcm(bytes, fmt) {
    const { channels: nch, containerBits, isFloat, littleEndian } = fmt;
    const bytesPer = containerBits / 8;
    const frameBytes = nch * bytesPer;
    const samples = Math.floor(bytes.length / frameBytes);
    const out = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let c = 0; c < nch; c++) {
        const arr = isFloat ? new Float32Array(samples) : new Int32Array(samples);
        for (let i = 0; i < samples; i++) {
            const o = i * frameBytes + c * bytesPer;
            let v;
            if (isFloat) {
                v = containerBits === 64 ? dv.getFloat64(o, littleEndian) : dv.getFloat32(o, littleEndian);
            } else if (containerBits === 8) {
                v = fmt.kind === 'WAV' ? bytes[o] - 128 : (bytes[o] << 24) >> 24;
            } else if (containerBits === 16) {
                v = dv.getInt16(o, littleEndian);
            } else if (containerBits === 24) {
                v = littleEndian
                    ? ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8
                    : (((bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]) << 8) >> 8;
            } else if (containerBits === 32) {
                v = dv.getInt32(o, littleEndian);
            } else {
                v = 0;
            }
            arr[i] = v;
        }
        out.push(arr);
    }
    return { channels: out, samples };
}

/** Reads `count` frames starting at frame `start` from the data chunk. */
export async function readPcmWindow(source, fmt, start, count) {
    const frameBytes = fmt.channels * fmt.containerBits / 8;
    const first = Math.min(start, fmt.totalSamples);
    const n = Math.max(0, Math.min(count, fmt.totalSamples - first));
    if (n === 0) return { channels: [], samples: 0 };
    const bytes = await source.read(fmt.dataOffset + first * frameBytes, n * frameBytes);
    return splitPcm(bytes, fmt);
}
