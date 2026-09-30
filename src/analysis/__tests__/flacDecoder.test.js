import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFlacHeader, decodeFrames, decodeFrame, parseFrameHeader, estimateByteOffset, canSeek, crc8, crc16, parseStreamInfo } from '../flacDecoder.js';
import { createFileByteSource } from './nodeSource.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.flac')).sort();

const memorySource = (bytes) => ({
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length))
});

// MD5 of the interleaved little-endian PCM, as libFLAC defines the STREAMINFO signature.
function pcmMd5(channels, samples, bitsPerSample) {
    const nch = channels.length;
    const bytesPer = Math.ceil(bitsPerSample / 8);
    const pcm = Buffer.alloc(samples * nch * bytesPer);
    let o = 0;
    for (let i = 0; i < samples; i++) {
        for (let c = 0; c < nch; c++) {
            const v = channels[c][i];
            for (let b = 0; b < bytesPer; b++) pcm[o++] = (v >> (8 * b)) & 0xFF;
        }
    }
    return crypto.createHash('md5').update(pcm).digest('hex');
}

describe('crc', () => {
    const msg = new TextEncoder().encode('123456789');
    it('crc8 (poly 0x07) check value', () => expect(crc8(msg, 0, msg.length)).toBe(0xF4));
    it('crc16 (poly 0x8005, init 0) check value', () => expect(crc16(msg, 0, msg.length)).toBe(0xFEE8));
});

describe('FLAC decoder against ffmpeg-encoded fixtures', () => {
    it.each(files)('%s decodes bit-exactly (MD5 matches STREAMINFO)', async (name) => {
        const file = path.join(FIXTURES, name);
        const source = await createFileByteSource(file);
        const header = await readFlacHeader(source);
        await source.close();
        expect(header).not.toBeNull();
        const { streamInfo } = header;
        expect(streamInfo.md5).toMatch(/^[0-9a-f]{32}$/);

        const bytes = new Uint8Array(fs.readFileSync(file));
        const res = decodeFrames(bytes, header.audioOffset, streamInfo);
        expect(res.channels.length).toBe(streamInfo.channels);
        expect(res.samples).toBe(streamInfo.totalSamples);
        expect(res.truncated).toBe(false);
        expect(res.firstSample).toBe(0);
        expect(pcmMd5(res.channels, res.samples, streamInfo.bitsPerSample)).toBe(streamInfo.md5);
    });

    it('padded fixture restores the wasted low bits as zeros (24-bit container, 16-bit content)', async () => {
        const file = path.join(FIXTURES, 'padded-16-in-24-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        expect(header.streamInfo.bitsPerSample).toBe(24);
        const res = decodeFrames(bytes, header.audioOffset, header.streamInfo);
        let orAcc = 0;
        for (const ch of res.channels) for (let i = 0; i < ch.length; i++) orAcc |= ch[i];
        expect(orAcc & 0xFF).toBe(0);
        expect(orAcc & 0xFF00).not.toBe(0);
    });

    it('decodes from an arbitrary byte offset by resyncing on a valid frame', async () => {
        const file = path.join(FIXTURES, 'stereo-16-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        const full = decodeFrames(bytes, header.audioOffset, header.streamInfo);
        const mid = estimateByteOffset(header, bytes.length, Math.floor(header.streamInfo.totalSamples / 2)) + 7; // deliberately mid-frame
        const part = decodeFrames(bytes, mid, header.streamInfo, { maxSamples: 3000 });
        expect(part.samples).toBeGreaterThanOrEqual(3000);
        expect(part.firstSample).toBeGreaterThan(0);
        expect(part.firstSample).toBeLessThan(header.streamInfo.totalSamples);
        for (let c = 0; c < 2; c++) {
            for (let i = 0; i < part.samples; i++) {
                if (part.channels[c][i] !== full.channels[c][part.firstSample + i]) {
                    throw new Error(`sample mismatch at ${i} (channel ${c})`);
                }
            }
        }
        expect(part.nextOffset).toBeGreaterThan(mid);
    });

    it('reports truncation when the buffer ends inside a frame', async () => {
        const file = path.join(FIXTURES, 'mono-16-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
        const res = decodeFrames(cut, header.audioOffset, header.streamInfo);
        expect(res.truncated).toBe(true);
        expect(res.samples).toBeGreaterThan(0);
        expect(res.samples).toBeLessThan(header.streamInfo.totalSamples);
        // Continuing from nextOffset in the full buffer picks up exactly where it stopped.
        const rest = decodeFrames(bytes, res.nextOffset, header.streamInfo);
        expect(rest.firstSample).toBe(res.samples);
        expect(res.samples + rest.samples).toBe(header.streamInfo.totalSamples);
    });

    it('rejects garbage as a frame header and survives corrupted data', async () => {
        const file = path.join(FIXTURES, 'mono-16-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        expect(parseFrameHeader(bytes, header.audioOffset, bytes.length, header.streamInfo)).not.toBeNull();
        expect(parseFrameHeader(new Uint8Array(64), 0, 64, header.streamInfo)).toBeNull();
        const damaged = bytes.slice();
        for (let i = header.audioOffset + 40; i < header.audioOffset + 400; i += 3) damaged[i] ^= 0x5A;
        const res = decodeFrames(damaged, header.audioOffset, header.streamInfo);
        // The first frame fails its CRC and is skipped; later frames still decode.
        expect(res.samples).toBeGreaterThan(0);
        expect(res.samples).toBeLessThan(header.streamInfo.totalSamples);
    });

    it.each([300, 1024 * 1024])('skips a %d-byte ID3v2 tag in front of the stream', async (tagBody) => {
        const file = path.join(FIXTURES, 'mono-16-44100.flac');
        const flac = new Uint8Array(fs.readFileSync(file));
        const id3 = new Uint8Array(10 + tagBody);
        id3.set([0x49, 0x44, 0x33, 4, 0, 0, (tagBody >> 21) & 0x7F, (tagBody >> 14) & 0x7F, (tagBody >> 7) & 0x7F, tagBody & 0x7F]);
        const bytes = new Uint8Array(id3.length + flac.length);
        bytes.set(id3, 0);
        bytes.set(flac, id3.length);
        const reads = [];
        const source = memorySource(bytes);
        const logged = { size: source.size, read: (o, l) => { reads.push(o); return source.read(o, l); } };
        const header = await readFlacHeader(logged);
        const plain = await readFlacHeader(memorySource(flac));
        expect(header.streamInfo).toEqual(plain.streamInfo);
        expect(header.audioOffset).toBe(plain.audioOffset + id3.length);
        expect(reads.length).toBeLessThanOrEqual(2); // the head is re-read once from where the tag ends
    });

    it('32-bit stereo from libFLAC: the 33-bit side channel decodes and left/right come back bit-exact', async () => {
        const file = path.join(FIXTURES, 'stereo-32-midside-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        expect(header.streamInfo).toMatchObject({ bitsPerSample: 32, channels: 2 });
        const assignments = new Set();
        let pos = header.audioOffset;
        while (pos < bytes.length - 2) {
            const fh = parseFrameHeader(bytes, pos, bytes.length, header.streamInfo);
            if (!fh) { pos++; continue; }
            assignments.add(fh.assignment);
            pos = decodeFrame(bytes, bytes.length, fh, header.streamInfo).nextOffset;
        }
        expect(Array.from(assignments)).toEqual(['mid-side']);
        const res = decodeFrames(bytes, header.audioOffset, header.streamInfo);
        expect(res.samples).toBe(header.streamInfo.totalSamples);
        expect(res.channels.every((c) => c instanceof Int32Array)).toBe(true);
        expect(pcmMd5(res.channels, res.samples, 32)).toBe(header.streamInfo.md5);
        // The fixture was built so that side = L - R needs 33 bits.
        let maxSide = 0;
        for (let i = 0; i < res.samples; i++) maxSide = Math.max(maxSide, Math.abs(res.channels[0][i] - res.channels[1][i]));
        expect(maxSide).toBeGreaterThan(2 ** 31);
    });

    it('estimateByteOffset copes with an unknown file size', async () => {
        const file = path.join(FIXTURES, 'mono-16-44100.flac');
        const bytes = new Uint8Array(fs.readFileSync(file));
        const header = await readFlacHeader(memorySource(bytes));
        expect(header.seekTable.length).toBe(0);
        expect(canSeek(header, null)).toBe(false);
        expect(canSeek(header, bytes.length)).toBe(true);
        expect(estimateByteOffset(header, Infinity, 20000)).toBe(header.audioOffset);
        expect(estimateByteOffset(header, null, 20000)).toBe(header.audioOffset);
        expect(Number.isFinite(estimateByteOffset(header, bytes.length, 20000))).toBe(true);
    });
});

describe('metadata parsing', () => {
    function streamInfoBlock({ minBlock = 4096, maxBlock = 4096, rate = 44100, channels = 2, bps = 16, total = 100000 }) {
        const b = new Uint8Array(34);
        b[0] = minBlock >> 8; b[1] = minBlock & 0xFF; b[2] = maxBlock >> 8; b[3] = maxBlock & 0xFF;
        // bytes 4..9: min/max frame size (0)
        const packed = (rate << 12) | ((channels - 1) << 9) | ((bps - 1) << 4) | 0; // + top 4 bits of total (0)
        b[10] = (packed >>> 24) & 0xFF; b[11] = (packed >>> 16) & 0xFF; b[12] = (packed >>> 8) & 0xFF; b[13] = packed & 0xFF;
        b[14] = (total >>> 24) & 0xFF; b[15] = (total >>> 16) & 0xFF; b[16] = (total >>> 8) & 0xFF; b[17] = total & 0xFF;
        for (let i = 0; i < 16; i++) b[18 + i] = i + 1;
        return b;
    }

    it('parseStreamInfo unpacks the bit fields', () => {
        const info = parseStreamInfo(streamInfoBlock({ rate: 96000, channels: 2, bps: 24, total: 123456 }));
        expect(info).toMatchObject({ minBlockSize: 4096, maxBlockSize: 4096, sampleRate: 96000, channels: 2, bitsPerSample: 24, totalSamples: 123456 });
        expect(info.md5).toBe('0102030405060708090a0b0c0d0e0f10');
    });

    it('readFlacHeader reads STREAMINFO and SEEKTABLE and estimateByteOffset uses the seek points', async () => {
        const si = streamInfoBlock({ total: 100000 });
        const seek = new Uint8Array(18 * 2);
        const dv = new DataView(seek.buffer);
        dv.setUint32(4, 0, false); dv.setUint32(12, 0, false); dv.setUint16(16, 4096, false);           // sample 0 -> byte 0
        dv.setUint32(18 + 4, 40960, false); dv.setUint32(18 + 12, 50000, false); dv.setUint16(18 + 16, 4096, false); // sample 40960 -> byte 50000
        const bytes = new Uint8Array(4 + 4 + 34 + 4 + seek.length + 100);
        bytes.set([0x66, 0x4C, 0x61, 0x43], 0);
        bytes.set([0x00, 0, 0, 34], 4); bytes.set(si, 8);
        bytes.set([0x80 | 3, 0, 0, seek.length], 42); bytes.set(seek, 46);
        const header = await readFlacHeader(memorySource(bytes));
        expect(header.streamInfo.totalSamples).toBe(100000);
        expect(header.seekTable).toEqual([
            { sampleNumber: 0, byteOffset: 0, frameSamples: 4096 },
            { sampleNumber: 40960, byteOffset: 50000, frameSamples: 4096 }
        ]);
        expect(header.audioOffset).toBe(46 + seek.length);
        expect(estimateByteOffset(header, 200000, 50000)).toBe(header.audioOffset + 50000);
        expect(estimateByteOffset(header, 200000, 1000)).toBe(header.audioOffset);
        // Without a seek table the offset is proportional to the sample position.
        const noSeek = { ...header, seekTable: [] };
        const audioBytes = 200000 - header.audioOffset;
        expect(estimateByteOffset(noSeek, 200000, 50000)).toBe(Math.floor(header.audioOffset + audioBytes / 2));
    });

    it('returns null for a non-FLAC source', async () => {
        expect(await readFlacHeader(memorySource(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])))).toBeNull();
        expect(await readFlacHeader(memorySource(new Uint8Array(2)))).toBeNull();
    });
});
