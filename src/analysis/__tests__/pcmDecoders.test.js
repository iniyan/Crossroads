import { describe, it, expect } from 'vitest';
import { readWavHeader, readAiffHeader, readPcmWindow, splitPcm, readExtended } from '../pcmDecoders.js';
import { createFetchByteSource } from '../byteSource.js';
import { encodeWav, seededRandom } from './signals.js';

const memorySource = (bytes) => ({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length))
});

const rng = seededRandom(4);
const ints = (n, bits) => Int32Array.from({ length: n }, () => Math.round((rng() - 0.5) * 2 ** bits * 0.9));

describe('WAV', () => {
    it('parses the header and reads windows of 16-bit and 24-bit PCM exactly', async () => {
        for (const bits of [16, 24]) {
            const l = ints(5000, bits); const r = ints(5000, bits);
            const bytes = encodeWav([l, r], 48000, bits);
            const fmt = await readWavHeader(memorySource(bytes));
            expect(fmt).toMatchObject({ kind: 'WAV', sampleRate: 48000, channels: 2, containerBits: bits, validBits: bits, isFloat: false, totalSamples: 5000, dataOffset: 44 });
            const win = await readPcmWindow(memorySource(bytes), fmt, 1000, 500);
            expect(win.samples).toBe(500);
            expect(Array.from(win.channels[0])).toEqual(Array.from(l.subarray(1000, 1500)));
            expect(Array.from(win.channels[1])).toEqual(Array.from(r.subarray(1000, 1500)));
            const tail = await readPcmWindow(memorySource(bytes), fmt, 4800, 500);
            expect(tail.samples).toBe(200);
            expect((await readPcmWindow(memorySource(bytes), fmt, 6000, 10)).samples).toBe(0);
        }
    });

    it('handles WAVE_FORMAT_EXTENSIBLE, extra chunks before data, and float', async () => {
        const build = ({ tag, bits, valid = bits, listChunk = true }) => {
            const frames = 100;
            const ch = 1;
            const fmtLen = tag === 0xFFFE ? 40 : 16;
            const list = listChunk ? 8 + 26 : 0;
            const dataLen = frames * ch * bits / 8;
            const buf = new Uint8Array(12 + 8 + fmtLen + list + 8 + dataLen);
            const dv = new DataView(buf.buffer);
            const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
            str(0, 'RIFF'); dv.setUint32(4, buf.length - 8, true); str(8, 'WAVE');
            let o = 12;
            str(o, 'fmt '); dv.setUint32(o + 4, fmtLen, true);
            dv.setUint16(o + 8, tag, true); dv.setUint16(o + 10, ch, true); dv.setUint32(o + 12, 96000, true);
            dv.setUint32(o + 16, 96000 * ch * bits / 8, true); dv.setUint16(o + 20, ch * bits / 8, true); dv.setUint16(o + 22, bits, true);
            if (tag === 0xFFFE) {
                dv.setUint16(o + 24, 22, true); dv.setUint16(o + 26, valid, true); dv.setUint32(o + 28, 4, true);
                dv.setUint16(o + 32, bits === 32 && valid === 32 ? 3 : 1, true); // sub-format PCM or float
            }
            o += 8 + fmtLen;
            if (listChunk) { str(o, 'LIST'); dv.setUint32(o + 4, 26, true); str(o + 8, 'INFOISFT'); o += list; }
            str(o, 'data'); dv.setUint32(o + 4, dataLen, true);
            o += 8;
            for (let i = 0; i < frames; i++) {
                if (bits === 32 && valid === 32 && tag === 0xFFFE) dv.setFloat32(o + i * 4, i / 100, true);
                else if (bits === 32) dv.setInt32(o + i * 4, i * 65536, true);
                else if (bits === 24) { buf[o + i * 3] = 0; buf[o + i * 3 + 1] = i & 0xFF; buf[o + i * 3 + 2] = i >= 50 ? 0xFF : 0; }
                else buf[o + i * 2] = i;
            }
            return { buf, dataOffset: o };
        };

        const ext = build({ tag: 0xFFFE, bits: 24, valid: 20 });
        const fmt = await readWavHeader(memorySource(ext.buf));
        expect(fmt).toMatchObject({ containerBits: 24, validBits: 20, isFloat: false, dataOffset: ext.dataOffset, totalSamples: 100 });
        const win = await readPcmWindow(memorySource(ext.buf), fmt, 0, 100);
        expect(win.channels[0][3]).toBe(3 * 256);
        expect(win.channels[0][60]).toBe(((0xFF << 16) | (60 << 8)) << 8 >> 8); // sign-extended negative

        const flt = build({ tag: 0xFFFE, bits: 32, valid: 32 });
        const ffmt = await readWavHeader(memorySource(flt.buf));
        expect(ffmt.isFloat).toBe(true);
        const fwin = await readPcmWindow(memorySource(flt.buf), ffmt, 0, 100);
        expect(fwin.channels[0]).toBeInstanceOf(Float32Array);
        expect(fwin.channels[0][50]).toBeCloseTo(0.5, 5);

        const i32 = build({ tag: 1, bits: 32, listChunk: false });
        const iwin = await readPcmWindow(memorySource(i32.buf), await readWavHeader(memorySource(i32.buf)), 0, 100);
        expect(iwin.channels[0][7]).toBe(7 * 65536);

        expect(await readWavHeader(memorySource(new Uint8Array(20)))).toBeNull();
    });
});

describe('AIFF', () => {
    function buildAiff({ form = 'AIFF', compression = 'NONE', bits = 24, frames = 64, rate = 44100 }) {
        const commLen = form === 'AIFC' ? 22 + 2 : 18;
        const dataLen = frames * bits / 8;
        const buf = new Uint8Array(12 + 8 + commLen + 8 + 8 + dataLen);
        const dv = new DataView(buf.buffer);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
        str(0, 'FORM'); dv.setUint32(4, buf.length - 8, false); str(8, form);
        let o = 12;
        str(o, 'COMM'); dv.setUint32(o + 4, commLen, false);
        dv.setUint16(o + 8, 1, false); dv.setUint32(o + 10, frames, false); dv.setUint16(o + 14, bits, false);
        // 80-bit extended sample rate
        const exp = Math.floor(Math.log2(rate));
        const mant = Math.round(rate * 2 ** (63 - exp));
        dv.setUint16(o + 16, 16383 + exp, false);
        dv.setUint32(o + 18, Math.floor(mant / 4294967296), false); dv.setUint32(o + 22, mant % 4294967296, false);
        if (form === 'AIFC') { str(o + 26, compression); buf[o + 30] = 0; buf[o + 31] = 0; }
        o += 8 + commLen;
        str(o, 'SSND'); dv.setUint32(o + 4, 8 + dataLen, false); dv.setUint32(o + 8, 0, false); dv.setUint32(o + 12, 0, false);
        const dataOffset = o + 16;
        for (let i = 0; i < frames; i++) {
            const v = (i - 32) * 1000;
            if (compression === 'sowt') { buf[dataOffset + i * 3] = v & 0xFF; buf[dataOffset + i * 3 + 1] = (v >> 8) & 0xFF; buf[dataOffset + i * 3 + 2] = (v >> 16) & 0xFF; }
            else { buf[dataOffset + i * 3] = (v >> 16) & 0xFF; buf[dataOffset + i * 3 + 1] = (v >> 8) & 0xFF; buf[dataOffset + i * 3 + 2] = v & 0xFF; }
        }
        return { buf, dataOffset };
    }

    it('reads big-endian AIFF and little-endian AIFF-C (sowt)', async () => {
        for (const variant of [{ form: 'AIFF' }, { form: 'AIFC', compression: 'sowt' }, { form: 'AIFC', compression: 'NONE' }]) {
            const { buf, dataOffset } = buildAiff(variant);
            const fmt = await readAiffHeader(memorySource(buf));
            expect(fmt).toMatchObject({ kind: 'AIFF', sampleRate: 44100, channels: 1, containerBits: 24, validBits: 24, dataOffset, totalSamples: 64, littleEndian: variant.compression === 'sowt' });
            const win = await readPcmWindow(memorySource(buf), fmt, 0, 64);
            expect(win.channels[0][0]).toBe(-32000);
            expect(win.channels[0][40]).toBe(8000);
        }
        expect(await readAiffHeader(memorySource(buildAiff({ form: 'AIFC', compression: 'ima4' }).buf))).toBeNull();
        expect(readExtended(new Uint8Array([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]), 0)).toBe(44100);
    });
});

describe('splitPcm', () => {
    it('handles 8-bit unsigned WAV and 8-bit signed AIFF', () => {
        const bytes = new Uint8Array([128, 0, 255]);
        expect(Array.from(splitPcm(bytes, { kind: 'WAV', channels: 1, containerBits: 8, isFloat: false, littleEndian: true }).channels[0])).toEqual([0, -128, 127]);
        expect(Array.from(splitPcm(bytes, { kind: 'AIFF', channels: 1, containerBits: 8, isFloat: false, littleEndian: false }).channels[0])).toEqual([-128, 0, -1]);
    });
});

describe('createFetchByteSource', () => {
    const file = new Uint8Array(1000).map((_, i) => i & 0xFF);
    const server = (opts = {}) => async (url, init) => {
        const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
        if (opts.ignoreRange) return { status: 200, headers: { get: () => null }, arrayBuffer: async () => file.slice().buffer };
        const start = Number(range[1]);
        if (start >= file.length) return { status: 416, headers: { get: () => `bytes */${file.length}` }, arrayBuffer: async () => new ArrayBuffer(0) };
        const end = Math.min(Number(range[2]), file.length - 1);
        return {
            status: 206,
            headers: { get: (h) => (h === 'content-range' ? `bytes ${start}-${end}/${file.length}` : null) },
            arrayBuffer: async () => file.slice(start, end + 1).buffer
        };
    };

    it('issues Range requests, learns the size and clamps at the end', async () => {
        const src = createFetchByteSource('x://f', { fetchImpl: server() });
        expect(Array.from(await src.read(10, 5))).toEqual([10, 11, 12, 13, 14]);
        expect(src.size).toBe(1000);
        expect((await src.read(995, 50)).length).toBe(5);
        expect((await src.read(1000, 50)).length).toBe(0);
        expect((await src.read(5, 0)).length).toBe(0);
    });

    it('falls back to the whole body when the server ignores Range', async () => {
        const src = createFetchByteSource('x://f', { fetchImpl: server({ ignoreRange: true }) });
        expect(Array.from(await src.read(3, 2))).toEqual([3, 4]);
        expect(src.size).toBe(1000);
        expect(Array.from(await src.read(998, 10))).toEqual([998 & 0xFF, 999 & 0xFF]);
    });

    it('rejects other statuses', async () => {
        const src = createFetchByteSource('x://f', { fetchImpl: async () => ({ status: 403, headers: { get: () => null } }) });
        await expect(src.read(0, 10)).rejects.toThrow('403');
    });
});
