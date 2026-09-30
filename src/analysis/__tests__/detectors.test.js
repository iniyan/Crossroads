import { describe, it, expect } from 'vitest';
import { findShelf, effectiveBandwidth, smoothDb, bitDepthStats, mergeBitDepthStats, summarizeBitDepth, bandLevelDb } from '../detectors.js';
import { windowSpectrum, powerToDb, downsampleToDb } from '../spectrum.js';
import { createFFT } from '../fft.js';
import { seededRandom } from './signals.js';

const BIN_HZ = 44100 / 8192;
const BINS = 4097;

/** A dB spectrum with a flat level, optionally a step down at `cutoffHz` (linear ramp of `widthHz`). */
function syntheticDb({ level = -60, floor = -130, cutoffHz = null, widthHz = 200, notchHz = null, notchWidthHz = 500, binHz = BIN_HZ }) {
    const db = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) {
        const hz = i * binHz;
        let v = level - hz / 4000; // gentle tilt of -5.5 dB over the band
        if (cutoffHz !== null) {
            if (hz >= cutoffHz + widthHz / 2) v = floor;
            else if (hz > cutoffHz - widthHz / 2) v = level + (floor - level) * (hz - (cutoffHz - widthHz / 2)) / widthHz;
        }
        if (notchHz !== null && Math.abs(hz - notchHz) < notchWidthHz / 2) v = floor;
        db[i] = v;
    }
    return db;
}

describe('findShelf', () => {
    it('locates a brickwall step and measures its depth', () => {
        const s = findShelf(syntheticDb({ cutoffHz: 16000 }), BIN_HZ, { minHz: 8000, maxHz: 21000 });
        expect(Math.abs(s.cutoffHz - 16000)).toBeLessThan(150);
        expect(s.stepDb).toBeGreaterThan(55);
        expect(s.recoveryDb).toBeLessThan(3);
        expect(s.transitionHz).toBeLessThan(600);
        expect(s.belowDb - s.aboveMeanDb).toBeGreaterThan(55);
    });

    it('reports only a small step on a flat or gently tilted spectrum', () => {
        const s = findShelf(syntheticDb({}), BIN_HZ, { minHz: 8000, maxHz: 21000 });
        expect(s.stepDb).toBeLessThan(2);
    });

    it('a notch recovers after the drop (recoveryDb ~ stepDb)', () => {
        const s = findShelf(syntheticDb({ notchHz: 15000 }), BIN_HZ, { minHz: 8000, maxHz: 21000 });
        expect(s.recoveryDb).toBeGreaterThan(s.stepDb * 0.9);
    });

    it('a wide transition is small for a 400 Hz step but large for a 2 kHz step', () => {
        const db = syntheticDb({ cutoffHz: 22000, widthHz: 5000, level: -60, floor: -140, binHz: 96000 / 8192 });
        const sharp = findShelf(db, 96000 / 8192, { minHz: 8000, maxHz: 40000, stepWidthHz: 400 });
        const wide = findShelf(db, 96000 / 8192, { minHz: 8000, maxHz: 40000, stepWidthHz: 2000, smoothHz: 300 });
        expect(sharp.stepDb).toBeLessThan(12);
        expect(wide.stepDb).toBeGreaterThan(25);
    });

    it('returns null when the search range is empty', () => {
        expect(findShelf(syntheticDb({}), BIN_HZ, { minHz: 21000, maxHz: 20000 })).toBeNull();
    });
});

describe('effectiveBandwidth / smoothing / band level', () => {
    it('finds where content ends relative to the peak', () => {
        const { bandwidthHz } = effectiveBandwidth(syntheticDb({ cutoffHz: 16000 }), BIN_HZ);
        expect(Math.abs(bandwidthHz - 16000)).toBeLessThan(400);
        expect(effectiveBandwidth(syntheticDb({}), BIN_HZ).bandwidthHz).toBeGreaterThan(21500);
    });
    it('smoothDb averages over the requested width', () => {
        const db = new Float32Array(100).fill(0);
        db[50] = 100;
        const s = smoothDb(db, 10, 100); // +-5 bins
        expect(s[50]).toBeCloseTo(100 / 11, 5);
        expect(s[56]).toBe(0);
    });
    it('bandLevelDb averages the requested band', () => {
        const db = new Float32Array(100);
        for (let i = 0; i < 100; i++) db[i] = i;
        expect(bandLevelDb(db, 10, 100, 200)).toBeCloseTo(14.5, 5);
        expect(Number.isNaN(bandLevelDb(db, 10, 200, 100))).toBe(true);
    });
});

describe('bitDepthStats', () => {
    const rng = seededRandom(3);
    const genuine24 = Int32Array.from({ length: 20000 }, () => Math.round((rng() - 0.5) * 2 ** 23));
    it('genuine 24-bit: ~50 % odd samples, effective 24', () => {
        const s = summarizeBitDepth(bitDepthStats([genuine24], 24));
        expect(s.effectiveBits).toBe(24);
        expect(s.lowByteZeroFraction).toBeLessThan(0.02);
    });
    it('padded 16-in-24: effective 16, low byte always zero, histogram starts at 8', () => {
        const padded = genuine24.map((v) => (v >> 8) << 8);
        const stats = bitDepthStats([padded], 24);
        const s = summarizeBitDepth(stats);
        expect(s.effectiveBits).toBe(16);
        expect(s.lowByteZeroFraction).toBe(1);
        expect(stats.histogram.slice(0, 8).every((v) => v === 0)).toBe(true);
        expect(stats.histogram[8]).toBeGreaterThan(stats.histogram[9]);
    });
    it('20-bit content and merged stats', () => {
        const a = bitDepthStats([genuine24.map((v) => (v >> 4) << 4)], 24);
        const b = bitDepthStats([genuine24.subarray(0, 100)], 24);
        expect(summarizeBitDepth(a).effectiveBits).toBe(20);
        expect(summarizeBitDepth(mergeBitDepthStats(a, b)).effectiveBits).toBe(24);
        expect(mergeBitDepthStats(a, b).nonZero).toBe(a.nonZero + b.nonZero);
        expect(mergeBitDepthStats(null, a)).toBe(a);
    });
    it('silence yields no effective depth', () => {
        expect(summarizeBitDepth(bitDepthStats([new Int32Array(1000)], 24)).effectiveBits).toBeNull();
    });
    it('negative samples are handled (two\'s complement trailing zeros)', () => {
        const s = summarizeBitDepth(bitDepthStats([Int32Array.from([-256, -512, 256 * 3])], 24));
        expect(s.effectiveBits).toBe(16);
    });
});

describe('spectrum', () => {
    it('FFT of an impulse is flat and a full-scale sine peaks at 0 dB in its bin', () => {
        const fft = createFFT(16);
        const re = new Float64Array(16); const im = new Float64Array(16);
        re[0] = 1;
        fft.forward(re, im);
        for (let i = 0; i < 16; i++) { expect(re[i]).toBeCloseTo(1, 10); expect(im[i]).toBeCloseTo(0, 10); }

        const n = 8192 * 4;
        const rate = 44100;
        const bin = 300;
        const hz = bin * rate / 8192;
        const x = new Float64Array(n);
        for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * hz * i / rate);
        const { power, binHz, frames, rms } = windowSpectrum([x], { scale: 1, sampleRate: rate });
        expect(binHz).toBeCloseTo(rate / 8192, 6);
        expect(frames).toBe(7);
        expect(rms).toBeCloseTo(Math.SQRT1_2, 2);
        const db = powerToDb(power);
        expect(db[bin]).toBeGreaterThan(-0.5);
        expect(db[bin]).toBeLessThan(0.5);
        expect(db[bin + 40]).toBeLessThan(-100);
    });

    it('stereo pairs are separated correctly (each channel contributes its own tone)', () => {
        const n = 8192 * 2;
        const rate = 48000;
        const l = new Float64Array(n); const r = new Float64Array(n);
        for (let i = 0; i < n; i++) { l[i] = Math.sin(2 * Math.PI * 1000 * i / rate); r[i] = 0.5 * Math.sin(2 * Math.PI * 5000 * i / rate); }
        const pair = powerToDb(windowSpectrum([l, r], { scale: 1, sampleRate: rate }).power);
        const lo = powerToDb(windowSpectrum([l], { scale: 1, sampleRate: rate }).power);
        const ro = powerToDb(windowSpectrum([r], { scale: 1, sampleRate: rate }).power);
        const b1 = Math.round(1000 / (rate / 8192)); const b5 = Math.round(5000 / (rate / 8192));
        // The pair averages channel power: each tone shows 3 dB below its mono level.
        expect(pair[b1]).toBeCloseTo(lo[b1] - 3.01, 0);
        expect(pair[b5]).toBeCloseTo(ro[b5] - 3.01, 0);
        expect(lo[b5]).toBeLessThan(-100);
    });

    it('downsampleToDb averages power into buckets', () => {
        const power = new Float64Array(8);
        power[0] = 1; power[1] = 1; power[2] = 0; power[3] = 0;
        const out = downsampleToDb(power, 2);
        expect(out[0]).toBeCloseTo(10 * Math.log10(0.5), 6);
        expect(out[1]).toBe(-200);
    });
});
