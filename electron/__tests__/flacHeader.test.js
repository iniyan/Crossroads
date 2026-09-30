import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { id3v2Length, parseStreamInfo, readFlacStreamInfo } from '../flacHeader.js';

// Builds a STREAMINFO block body for the given properties.
function streamInfo({ sampleRate, channels, bitsPerSample, totalSamples, md5 = Buffer.alloc(16, 0xAB) }) {
    const buf = Buffer.alloc(34);
    buf.writeUInt16BE(4096, 0);      // min block
    buf.writeUInt16BE(4096, 2);      // max block
    // bytes 4..9: min/max frame size (unused)
    const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bitsPerSample - 1) << 36n) | BigInt(totalSamples);
    buf.writeBigUInt64BE(packed, 10);
    md5.copy(buf, 18);
    return buf;
}

function block(type, body, last = false) {
    const header = Buffer.from([(last ? 0x80 : 0) | type, (body.length >> 16) & 0xFF, (body.length >> 8) & 0xFF, body.length & 0xFF]);
    return Buffer.concat([header, body]);
}

function flacFile(blocks, { id3 = false } = {}) {
    const parts = [];
    if (id3) {
        const payload = Buffer.alloc(200, 1);
        const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, (200 >> 7) & 0x7F, 200 & 0x7F]);
        parts.push(header, payload);
    }
    parts.push(Buffer.from('fLaC', 'latin1'), ...blocks, Buffer.from('audio frames follow'));
    return Buffer.concat(parts);
}

describe('parseStreamInfo', () => {
    it('decodes the packed fields', () => {
        const info = parseStreamInfo(streamInfo({ sampleRate: 96000, channels: 2, bitsPerSample: 24, totalSamples: 27312000 }));
        expect(info).toEqual({ sampleRate: 96000, channels: 2, bitsPerSample: 24, totalSamples: 27312000, md5: 'ab'.repeat(16) });
    });

    it('handles 8 channels, 32-bit and huge sample counts', () => {
        const info = parseStreamInfo(streamInfo({ sampleRate: 192000, channels: 8, bitsPerSample: 32, totalSamples: 2 ** 35 + 5 }));
        expect(info.channels).toBe(8);
        expect(info.bitsPerSample).toBe(32);
        expect(info.totalSamples).toBe(2 ** 35 + 5);
    });

    it('reports a zero MD5 as null', () => {
        expect(parseStreamInfo(streamInfo({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 1, md5: Buffer.alloc(16) })).md5).toBeNull();
    });
});

describe('id3v2Length', () => {
    it('returns 0 without a tag and the syncsafe size with one', () => {
        expect(id3v2Length(Buffer.from('fLaC'))).toBe(0);
        expect(id3v2Length(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x01, 0x7F]))).toBe(10 + 255);
        expect(id3v2Length(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 5]))).toBe(10 + 5 + 10);
    });
});

describe('readFlacStreamInfo', () => {
    let dir;
    beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flac-')); });
    afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    const write = async (name, data) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, data);
        return file;
    };

    it('reads STREAMINFO, skips other blocks and notices pictures', async () => {
        const file = await write('a.flac', flacFile([
            block(0, streamInfo({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 1000 })),
            block(4, Buffer.alloc(50, 0)),
            block(6, Buffer.alloc(5000, 7)),
            block(1, Buffer.alloc(10), true)
        ]));
        const info = await readFlacStreamInfo(file);
        expect(info).toMatchObject({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 1000, hasPicture: true, blocks: 4 });
    });

    it('skips a leading ID3v2 tag', async () => {
        const file = await write('id3.flac', flacFile([
            block(0, streamInfo({ sampleRate: 48000, channels: 1, bitsPerSample: 24, totalSamples: 7 }), true)
        ], { id3: true }));
        const info = await readFlacStreamInfo(file);
        expect(info).toMatchObject({ sampleRate: 48000, channels: 1, bitsPerSample: 24, totalSamples: 7, hasPicture: false });
    });

    it('returns null for non-FLAC data and truncated files', async () => {
        expect(await readFlacStreamInfo(await write('x.flac', Buffer.from('RIFF....WAVE')))).toBeNull();
        expect(await readFlacStreamInfo(await write('short.flac', Buffer.from('fL')))).toBeNull();
        expect(await readFlacStreamInfo(await write('trunc.flac', Buffer.from('fLaC\x00\x00\x00\x22abc')))).toBeNull();
    });
});
