// End-to-end analysis of synthetic signals through the full decode + measure + verdict path
// (WAV in memory, the same code the worker runs). The point of this suite: zero false
// 'lossy-transcode' / 'upsampled' / 'padded' calls on genuine material, correct calls on the
// classic fakes, and the neutral 'band-limited' verdict wherever a brickwall could be either.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTrack, planWindows, sniffContainer, sniffSource, defaultWindowCount, MAX_WINDOW_READ_BYTES } from '../analyzeTrack.js';
import { ANALYZER_VERSION } from '../verdict.js';
import { readFlacHeader } from '../flacDecoder.js';
import {
    seededRandom, musicLike, whiteNoise, pinkNoise, firLowpass, gentleLowpass, upsample, quantize,
    padTo24, padTo24Dithered, scale, encodeWav
} from './signals.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SECONDS = 9;
const OPTIONS = { windows: 2, windowSeconds: 3 };

const memorySource = (bytes, { size, log } = {}) => ({
    size: size === undefined ? bytes.length : size,
    read: async (offset, length) => {
        if (log) log.push({ offset, length });
        if (!(offset >= 0) || !Number.isFinite(offset)) throw new Error(`bad offset ${offset}`);
        return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    }
});

const bases = new Map();
function base(rate, seed = 1) {
    const key = `${rate}:${seed}`;
    if (!bases.has(key)) bases.set(key, musicLike(rate * SECONDS, rate, seededRandom(seed)));
    return bases.get(key);
}

async function analyzeInts(channels, rate, bits, meta = {}, options = OPTIONS) {
    return analyzeTrack(memorySource(encodeWav(channels, rate, bits)), meta, options);
}

const rng = () => seededRandom(99);
const analyzeFloat = (signal, rate, { bits = 16, dither = true } = {}) =>
    analyzeInts([quantize(signal, bits, { dither, rng: rng() })], rate, bits);

const expectNotSuspicious = (r) => {
    expect(r.flags).toEqual([]);
    expect(['genuine', 'inconclusive', 'band-limited']).toContain(r.verdict);
};

describe('planWindows', () => {
    it('spreads windows over the middle 90 % of the track', () => {
        const plan = planWindows(44100 * 300, 44100, { count: 8 });
        expect(plan.length).toBe(8);
        expect(plan[0].start).toBeGreaterThanOrEqual(44100 * 15);
        expect(plan[7].start + plan[7].length).toBeLessThanOrEqual(44100 * 285);
        for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBeGreaterThan(plan[i - 1].start + plan[i - 1].length);
        expect(plan[0].length).toBe(44100 * 4);
    });
    it('defaults to 5 windows at CD rates and 8 at hi-res rates', () => {
        expect(defaultWindowCount(44100)).toBe(5);
        expect(defaultWindowCount(48000)).toBe(5);
        expect(defaultWindowCount(88200)).toBe(8);
        expect(planWindows(44100 * 300, 44100).length).toBe(5);
        expect(planWindows(96000 * 300, 96000).length).toBe(8);
    });
    it('uses shorter windows at hi-res rates and fewer windows on short tracks', () => {
        expect(planWindows(96000 * 300, 96000)[0].length).toBe(96000 * 3);
        expect(planWindows(44100 * 20, 44100).length).toBeLessThan(5);
        expect(planWindows(44100 * 2, 44100)).toEqual([{ start: 0, length: 44100 * 2 }]);
        expect(planWindows(0, 44100).length).toBe(1);
    });
});

describe('sniffContainer', () => {
    it('recognises FLAC, WAV and AIFF', () => {
        const s = (str) => new TextEncoder().encode(str);
        expect(sniffContainer(s('fLaC\0\0\0"'))).toBe('FLAC');
        expect(sniffContainer(s('RIFF\0\0\0\0WAVEfmt '))).toBe('WAV');
        expect(sniffContainer(s('FORM\0\0\0\0AIFFCOMM'))).toBe('AIFF');
        expect(sniffContainer(s('FORM\0\0\0\0AIFCCOMM'))).toBe('AIFF');
        expect(sniffContainer(s('ID3\x03\0\0\0\0\0\0fLaC'))).toBe('FLAC');
        expect(sniffContainer(s('\xff\xfb\x90\x00'))).toBeNull();
    });
});

/** `flac` bytes behind an ID3v2 tag with a `tagBody`-byte body. */
function withId3(flac, tagBody) {
    const id3 = new Uint8Array(10 + tagBody);
    id3.set([0x49, 0x44, 0x33, 4, 0, 0, (tagBody >> 21) & 0x7F, (tagBody >> 14) & 0x7F, (tagBody >> 7) & 0x7F, tagBody & 0x7F]);
    const bytes = new Uint8Array(id3.length + flac.length);
    bytes.set(id3, 0);
    bytes.set(flac, id3.length);
    return bytes;
}

describe('FLAC through the analyser', () => {
    const flac = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'stereo-16-44100.flac')));

    it.each([200, 1024 * 1024])('a FLAC behind a %d-byte ID3v2 tag analyses like the plain file', async (tagBody) => {
        const plain = await analyzeTrack(memorySource(flac), {}, OPTIONS);
        const tagged = await analyzeTrack(memorySource(withId3(flac, tagBody)), {}, OPTIONS);
        expect(await sniffSource(memorySource(withId3(flac, tagBody)))).toBe('FLAC');
        expect(tagged.container).toBe('FLAC');
        expect(tagged.verdict).toBe(plain.verdict);
        expect(tagged.md5).toBe(plain.md5);
        expect(tagged.effectiveBandwidthHz).toBe(plain.effectiveBandwidthHz);
        expect(tagged.evidence.windows.map((w) => w.startSec)).toEqual(plain.evidence.windows.map((w) => w.startSec));
    });

    it('reports where each passage really starts (the nearest frame), not where it was planned', async () => {
        const header = await readFlacHeader(memorySource(flac));
        const secs = header.streamInfo.totalSamples / 44100 / 6; // three windows fit whatever the fixture length
        const r = await analyzeTrack(memorySource(flac), {}, { windows: 3, windowSeconds: secs });
        const plan = planWindows(header.streamInfo.totalSamples, 44100, { count: 3, seconds: secs });
        expect(r.evidence.windows.length).toBe(3);
        expect(plan[1].start % 4096).not.toBe(0); // the plan itself is not frame-aligned
        for (let i = 0; i < 3; i++) {
            const startSec = r.evidence.windows[i].startSec;
            // Near the plan (the seek is an estimate) and on a frame boundary (4096-sample blocks,
            // to within the 0.01 s rounding of the evidence).
            expect(Math.abs(startSec - plan[i].start / 44100)).toBeLessThan(0.6);
            const rem = Math.round(startSec * 44100) % 4096;
            expect(Math.min(rem, 4096 - rem)).toBeLessThan(300);
        }
        expect(r.evidence.windows[1].startSec).toBeGreaterThan(r.evidence.windows[0].startSec);
        expect(r.evidence.windows[2].startSec).toBeGreaterThan(r.evidence.windows[1].startSec);
    });

    it('a source whose size is unknown and that has no seek table is an error, not a verdict', async () => {
        await expect(analyzeTrack(memorySource(flac, { size: null }), {}, OPTIONS)).rejects.toThrow(/file size unknown/);
        // ... but a size learned by the first read (Content-Range) is enough.
        const source = memorySource(flac, { size: null });
        const read = source.read;
        source.read = async (offset, length) => { const out = await read(offset, length); source.size = flac.length; return out; };
        expect((await analyzeTrack(source, {}, OPTIONS)).container).toBe('FLAC');
    });

    it('a hostile STREAMINFO (totalSamples = 1) cannot inflate the per-window read', async () => {
        const header = await readFlacHeader(memorySource(flac));
        const bytes = flac.slice();
        // STREAMINFO body starts 8 bytes in: total samples occupy the low 36 bits of bytes 13..17.
        const o = 8 + 13;
        bytes[o] &= 0xF0; bytes[o + 1] = 0; bytes[o + 2] = 0; bytes[o + 3] = 0; bytes[o + 4] = 1;
        expect((await readFlacHeader(memorySource(bytes))).streamInfo.totalSamples).toBe(1);
        const log = [];
        const r = await analyzeTrack(memorySource(bytes, { log }), { duration: header.streamInfo.totalSamples / 44100 }, OPTIONS);
        expect(r.verdict).toBeDefined();
        for (const { length } of log) expect(length).toBeLessThanOrEqual(MAX_WINDOW_READ_BYTES);
        expect(Math.max(...log.map((l) => l.length))).toBeLessThan(2 * 1024 * 1024);
    });

    it('a stream whose frames cannot be decoded is an error (never cached), not "too quiet"', async () => {
        const header = await readFlacHeader(memorySource(flac));
        const bytes = flac.slice();
        for (let i = header.audioOffset; i < bytes.length; i += 2) bytes[i] ^= 0xFF; // wreck every frame
        await expect(analyzeTrack(memorySource(bytes), {}, OPTIONS)).rejects.toThrow(/no audio could be decoded/);
    });
});

describe('genuine material is never flagged', () => {
    it('wideband music-like signal (16/44.1)', async () => {
        const r = await analyzeFloat(base(44100), 44100);
        expect(r.verdict).toBe('genuine');
        expect(r.flags).toEqual([]);
        expect(r.effectiveBitDepth).toBe(16);
        expect(r.windowsInformative).toBe(2);
    });

    it('white noise and pink noise', async () => {
        expectNotSuspicious(await analyzeFloat(whiteNoise(44100 * SECONDS, seededRandom(5), 0.1), 44100));
        expectNotSuspicious(await analyzeFloat(pinkNoise(44100 * SECONDS, seededRandom(6), 0.3), 44100));
    });

    it('gentle roll-off (12 dB/oct from 14 kHz) reads as genuine', async () => {
        const r = await analyzeFloat(gentleLowpass(base(44100), 14000, 44100, 1), 44100);
        expect(r.verdict).toBe('genuine');
        expect(r.flags).toEqual([]);
    });

    it('steep-ish analogue-style roll-off (36 dB/oct from 16 kHz) reads as genuine', async () => {
        const r = await analyzeFloat(gentleLowpass(base(44100), 16000, 44100, 3), 44100);
        expect(r.verdict).toBe('genuine');
        expect(r.flags).toEqual([]);
    });

    it('lo-fi material with nothing above 10 kHz is not called a transcode', async () => {
        const r = await analyzeFloat(gentleLowpass(base(44100), 10000, 44100, 2), 44100);
        expectNotSuspicious(r);
    });

    it('a brickwall right below Nyquist (SRC / ADC filter at 21.5 kHz) reads as genuine', async () => {
        const r = await analyzeFloat(firLowpass(base(44100), 21500, 44100, 1023), 44100);
        expect(r.verdict).toBe('genuine');
    });

    it('a 44.1 kHz source resampled into a 48 kHz container is not a transcode', async () => {
        const r = await analyzeFloat(firLowpass(base(48000), 22050, 48000, 1023), 48000);
        expect(r.verdict).toBe('genuine');
        expect(r.reason).toBe('cut-at-nyquist');
    });

    it('genuine 24/96 content', async () => {
        const r = await analyzeFloat(base(96000, 3), 96000, { bits: 24 });
        expect(r.verdict).toBe('genuine');
        expect(r.effectiveBitDepth).toBe(24);
        expect(r.effectiveBandwidthHz).toBeGreaterThan(30000);
    });

    it('96 kHz recording of band-limited material with a gentle roll-off is not called upsampled', async () => {
        const r = await analyzeFloat(gentleLowpass(base(96000, 3), 18000, 96000, 1), 96000, { bits: 24 });
        expect(r.flags).toEqual([]);
        expect(r.verdict).not.toBe('upsampled');
    });

    it('dithered 16-bit content in a 24-bit container is genuine 24-bit', async () => {
        const ints = padTo24Dithered(quantize(base(44100), 16, { dither: true, rng: rng() }), seededRandom(8));
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('genuine');
        expect(r.effectiveBitDepth).toBe(24);
        expect(r.evidence.bitDepth.lowByteZeroFraction).toBeLessThan(0.05);
    });

    it('20-bit content in a 24-bit container is reported but not flagged', async () => {
        const ints = quantize(base(44100), 20, { dither: true, rng: rng() }).map((v) => v * 16);
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('genuine');
        expect(r.effectiveBitDepth).toBe(20);
    });

    it('quiet but audible material (-30 dB) still gets a genuine verdict', async () => {
        const r = await analyzeFloat(scale(base(44100), 0.03), 44100);
        expect(r.verdict).toBe('genuine');
    });

    it('stereo with different channels', async () => {
        const l = quantize(base(44100), 16, { dither: true, rng: rng() });
        const rch = quantize(base(44100, 2), 16, { dither: true, rng: rng() });
        const r = await analyzeInts([l, rch], 44100, 16);
        expect(r.verdict).toBe('genuine');
        expect(r.channels).toBe(2);
    });
});

describe('brickwall policy (reviewer adversarial set): a sharp cut is only an accusation where no master cuts', () => {
    const brick = (signal, hz, rate, taps = 4095) => firLowpass(signal, hz, rate, taps);

    it('CD master brickwalls at 20 and 20.5 kHz are band-limited, not transcodes', async () => {
        for (const hz of [20000, 20500]) {
            const r = await analyzeFloat(brick(base(44100), hz, 44100), 44100);
            expect(r.verdict).toBe('band-limited');
            expect(r.flags).toEqual([]);
            expect(r.confidence).toBeLessThanOrEqual(0.6);
            expect(Math.abs(r.cutoffHz - hz)).toBeLessThan(350);
        }
    });

    it('a 19 kHz brickwall at 44.1 kHz is still called a transcode, at capped confidence', async () => {
        const r = await analyzeFloat(brick(base(44100), 19000, 44100), 44100);
        expect(r.verdict).toBe('lossy-transcode');
        expect(r.confidence).toBeLessThanOrEqual(0.85);
        expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('a 48 kHz broadcast master with a 20 kHz brickwall is band-limited, a 22 kHz one genuine', async () => {
        expect((await analyzeFloat(brick(base(48000), 20000, 48000), 48000, { bits: 24 })).verdict).toBe('band-limited');
        expect((await analyzeFloat(brick(base(48000), 22000, 48000), 48000, { bits: 24 })).verdict).toBe('genuine');
    });

    it('24/96 masters with brickwalls at 20 / 22 kHz read as upsampled (capped), at 24 kHz as band-limited', async () => {
        const src = base(96000, 3);
        for (const hz of [20000, 22000]) {
            const r = await analyzeFloat(brick(src, hz, 96000), 96000, { bits: 24 });
            expect(r.verdict).toBe('upsampled');
            expect(r.confidence).toBeLessThanOrEqual(0.85);
            expect(Math.abs(r.cutoffHz - hz)).toBeLessThan(400);
        }
        const r24 = await analyzeFloat(brick(src, 24000, 96000), 96000, { bits: 24 });
        expect(r24.verdict).toBe('band-limited');
        expect(r24.flags).toEqual([]);
        expect(Math.abs(r24.cutoffHz - 24000)).toBeLessThan(400);
    });

    it('a 176.4 kHz DSD-style conversion with a 24 kHz FIR is band-limited', async () => {
        const r = await analyzeFloat(brick(base(176400, 4), 24000, 176400), 176400, { bits: 24 });
        expect(r.verdict).toBe('band-limited');
        expect(r.flags).toEqual([]);
        expect(Math.abs(r.cutoffHz - 24000)).toBeLessThan(600);
    });

    it('a sound-design brickwall at 16 kHz is a transcode call with capped confidence (documented trade-off)', async () => {
        const r = await analyzeFloat(brick(base(44100), 16000, 44100), 44100);
        expect(r.verdict).toBe('lossy-transcode');
        expect(r.confidence).toBeLessThanOrEqual(0.85);
    });
});

describe('lossy transcodes', () => {
    it.each([16000, 18000, 19000])('steep low-pass at %d Hz (MP3/AAC style) is called', async (cutoff) => {
        const r = await analyzeFloat(firLowpass(base(44100), cutoff, 44100, 1023), 44100);
        expect(r.verdict).toBe('lossy-transcode');
        expect(r.flags).toEqual(['lossy-transcode']);
        expect(Math.abs(r.cutoffHz - cutoff)).toBeLessThan(350);
        expect(r.confidence).toBeGreaterThanOrEqual(0.7);
        expect(r.confidence).toBeLessThanOrEqual(0.85);
        expect(r.cutoffConsistency).toBe(1);
        expect(r.cutoffStepDb).toBeGreaterThan(30);
    });

    it('a cut in the 320 kbps / mastering zone (20.7 kHz) is band-limited: never genuine, never an accusation', async () => {
        const r = await analyzeFloat(firLowpass(base(44100), 20700, 44100, 1023), 44100);
        expect(r.verdict).toBe('band-limited');
        expect(r.flags).toEqual([]);
    });

    it('a low-passed transcode padded to 24 bits carries both flags', async () => {
        const ints = padTo24(quantize(firLowpass(base(44100), 16000, 44100, 1023), 16, { dither: true, rng: rng() }));
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('lossy-transcode');
        expect(r.flags).toEqual(['lossy-transcode', 'padded']);
        expect(r.effectiveBitDepth).toBe(16);
    });

    it('a transcode upsampled to 96 kHz is called (cut far below the CD limit)', async () => {
        const src = firLowpass(base(48000), 16000, 48000, 1023);
        const r = await analyzeFloat(upsample(src, 2, 23000, 96000, 2047), 96000, { bits: 24 });
        expect(r.verdict).toBe('lossy-transcode');
        expect(Math.abs(r.cutoffHz - 16000)).toBeLessThan(400);
    });

    it('the spectrum evidence marks the cutoff and reaches Nyquist', async () => {
        const r = await analyzeFloat(firLowpass(base(44100), 16000, 44100, 1023), 44100);
        const { db, nyquistHz } = r.evidence.spectrum;
        expect(db.length).toBe(256);
        expect(nyquistHz).toBe(22050);
        const at = (hz) => db[Math.round(hz / nyquistHz * 255)];
        expect(at(12000) - at(19000)).toBeGreaterThan(40);
        expect(r.evidence.shelf.cutoffHz).toBe(r.cutoffHz);
        expect(r.evidence.windows.length).toBe(2);
        expect(r.evidence.windows.every((w) => w.informative)).toBe(true);
    });
});

describe('upsampled hi-res', () => {
    it('48 kHz content zero-stuffed to 96 kHz with a steep image filter at 22 kHz', async () => {
        const r = await analyzeFloat(upsample(base(48000), 2, 22000, 96000, 2047), 96000, { bits: 24 });
        expect(r.verdict).toBe('upsampled');
        expect(r.flags).toEqual(['upsampled']);
        expect(r.cutoffHz).toBeGreaterThan(21000);
        expect(r.cutoffHz).toBeLessThan(22600);
        expect(r.confidence).toBeGreaterThanOrEqual(0.7);
        expect(r.confidence).toBeLessThanOrEqual(0.85);
    });

    it('44.1 kHz content upsampled to 88.2 kHz', async () => {
        const r = await analyzeFloat(upsample(base(44100), 2, 21000, 88200, 2047), 88200, { bits: 24 });
        expect(r.verdict).toBe('upsampled');
        expect(r.cutoffHz).toBeLessThan(22600);
    });

    it('44.1 kHz content upsampled to 176.4 kHz', async () => {
        const r = await analyzeFloat(upsample(base(44100), 4, 22000, 176400, 4095), 176400, { bits: 24 });
        expect(r.verdict).toBe('upsampled');
        expect(r.effectiveBandwidthHz).toBeLessThan(27000);
    });

    it('a 48 kHz source upsampled with an image filter at 23 kHz lands in the band-limited zone (neutral, by policy)', async () => {
        const r = await analyzeFloat(upsample(base(48000), 2, 23000, 96000, 2047), 96000, { bits: 24 });
        expect(r.verdict).toBe('band-limited');
        expect(r.flags).toEqual([]);
        expect(r.cutoffHz).toBeGreaterThan(22500);
        expect(r.cutoffHz).toBeLessThan(25000);
    });

    it('a soft resampler transition (spread over a few kHz) is still detected at hi-res rates', async () => {
        const r = await analyzeFloat(upsample(base(48000), 2, 22500, 96000, 63), 96000, { bits: 24 });
        expect(['upsampled', 'band-limited']).toContain(r.verdict);
        expect(r.cutoffHz).not.toBeNull();
    });

    it('a 16-bit upsample is upsampled, not padded', async () => {
        const r = await analyzeFloat(upsample(base(44100), 2, 22000, 88200, 2047), 88200, { bits: 16 });
        expect(r.verdict).toBe('upsampled');
        expect(r.effectiveBitDepth).toBe(16);
        expect(r.flags).toEqual(['upsampled']);
    });
});

describe('padded bit depth', () => {
    it('16-bit samples in a 24-bit container', async () => {
        const ints = padTo24(quantize(base(44100), 16, { dither: true, rng: rng() }));
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('padded');
        expect(r.flags).toEqual(['padded']);
        expect(r.effectiveBitDepth).toBe(16);
        expect(r.evidence.bitDepth.lowByteZeroFraction).toBe(1);
        expect(r.confidence).toBeGreaterThanOrEqual(0.9);
        const hist = r.evidence.bitDepth.trailingZeroHistogram;
        expect(hist.slice(0, 8).every((v) => v === 0)).toBe(true);
    });

    it('padding is judged even when the spectrum is too quiet to judge', async () => {
        const ints = padTo24(quantize(scale(base(44100), 0.0005), 16, { dither: true, rng: rng() }));
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('padded');
        expect(r.reason).toBe('too-quiet');
    });

    it('padding outranks band-limited', async () => {
        const ints = padTo24(quantize(firLowpass(base(44100), 20500, 44100, 2047), 16, { dither: true, rng: rng() }));
        const r = await analyzeInts([ints], 44100, 24);
        expect(r.verdict).toBe('padded');
        expect(r.flags).toEqual(['padded']);
    });
});

describe('edge cases', () => {
    it('digital silence is inconclusive, not an accusation', async () => {
        const r = await analyzeInts([new Int32Array(44100 * SECONDS)], 44100, 16);
        expect(r.verdict).toBe('inconclusive');
        expect(r.flags).toEqual([]);
        expect(r.evidence.windows.every((w) => w.silent)).toBe(true);
    });

    it('very quiet passages (-80 dB) are inconclusive', async () => {
        const r = await analyzeFloat(scale(base(44100), 0.0001), 44100);
        expect(r.verdict).toBe('inconclusive');
        expect(r.reason).toBe('too-quiet');
    });

    it('a very short track still analyses without throwing', async () => {
        const r = await analyzeFloat(base(44100).subarray(0, 44100 * 1.5), 44100);
        expect(r.windowsAnalyzed).toBe(1);
        expect(r.verdict).toBeDefined();
    });

    it('lossy files, unknown containers, empty and absurd headers are unsupported', async () => {
        expect((await analyzeTrack(memorySource(new Uint8Array(100)), { lossless: false })).verdict).toBe('unsupported');
        expect((await analyzeTrack(memorySource(new Uint8Array(100)), { lossless: false })).reason).toBe('lossy');
        const junk = await analyzeTrack(memorySource(new Uint8Array(4096).fill(0xAB)), {});
        expect(junk.verdict).toBe('unsupported');
        expect(junk.reason).toBe('format');
        const empty = await analyzeTrack(memorySource(encodeWav([new Int32Array(0)], 44100, 16)), {});
        expect(empty).toMatchObject({ verdict: 'unsupported', reason: 'format' });
        const absurd = encodeWav([new Int32Array(1000)], 44100, 16);
        new DataView(absurd.buffer).setUint32(24, 4000000000, true); // sample rate field
        expect((await analyzeTrack(memorySource(absurd), {})).reason).toBe('format');
    });

    it('PCM window reads are bounded even for huge frames', async () => {
        const log = [];
        const bytes = encodeWav([quantize(base(44100), 16, { dither: true, rng: rng() })], 44100, 16);
        await analyzeTrack(memorySource(bytes, { log }), {}, { windows: 1, windowSeconds: 3600 });
        for (const { length } of log) expect(length).toBeLessThanOrEqual(MAX_WINDOW_READ_BYTES);
    });

    it('reports progress and honours cancellation between windows', async () => {
        const bytes = encodeWav([quantize(base(44100), 16, { dither: true, rng: rng() })], 44100, 16);
        const progress = [];
        const r = await analyzeTrack(memorySource(bytes), {}, { ...OPTIONS, onProgress: (p) => progress.push(p) });
        expect(progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }]);
        expect(r.verdict).toBe('genuine');
        let calls = 0;
        await expect(analyzeTrack(memorySource(bytes), {}, { ...OPTIONS, shouldCancel: () => calls++ > 0 }))
            .rejects.toThrow('analysis cancelled');
    });

    it('result carries the fields the cache and UI rely on', async () => {
        const r = await analyzeFloat(base(44100), 44100);
        expect(r).toMatchObject({ version: ANALYZER_VERSION, container: 'WAV', sampleRate: 44100, channels: 1, bitsPerSample: 16, isFloat: false });
        expect(typeof r.analyzedAt).toBe('number');
        expect(r.evidence.spectrum.db.length).toBe(256);
        expect(r.evidence.bitDepth.containerBits).toBe(16);
        expect(r.evidence.windows[0].startSec).toBeGreaterThan(0); // the planned (and, for PCM, exact) start
    });
});
