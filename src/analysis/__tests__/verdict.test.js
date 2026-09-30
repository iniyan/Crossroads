import { describe, it, expect } from 'vitest';
import {
    classifySpectrum, classifyBitDepth, combineVerdict, isShelfValid, pickShelf, shelfConfidence,
    shelfSearchMaxHz, bandLimitedMinHz, isSuspicious, THRESHOLDS, ANALYZER_VERSION, VERDICTS
} from '../verdict.js';

const shelf = (cutoffHz, stepDb = 45, extra = {}) => ({
    cutoffHz, stepDb, belowDb: -60, aboveDb: -60 - stepDb, aboveMeanDb: -60 - stepDb + 2,
    recoveryDb: 3, transitionHz: 250, ...extra
});
const windows = (s, n = 4) => Array.from({ length: n }, () => s);
const classify = (sampleRate, cutoffHz, stepDb = 50, n = 4, extra = {}) => classifySpectrum({
    sampleRate, informativeWindows: n, bandwidthHz: cutoffHz,
    aggregateShelf: shelf(cutoffHz, stepDb, extra), windowShelves: windows(shelf(cutoffHz, stepDb, extra), n)
});

describe('isShelfValid / pickShelf', () => {
    it('accepts a deep shelf that stays down, rejects small steps, notches and rising tails', () => {
        expect(isShelfValid(shelf(16000))).toBe(true);
        expect(isShelfValid(shelf(16000, 20))).toBe(false);
        expect(isShelfValid(shelf(16000, 40, { recoveryDb: 38 }))).toBe(false);   // notch
        expect(isShelfValid(shelf(16000, 40, { recoveryDb: 25 }))).toBe(true);    // partial bump tolerated
        expect(isShelfValid(shelf(16000, 40, { aboveMeanDb: -70 }))).toBe(false); // tail not really down
        expect(isShelfValid(null)).toBe(false);
    });
    it('picks the valid candidate with the biggest step, else the first candidate', () => {
        const a = shelf(16000, 30); const b = shelf(22000, 50);
        expect(pickShelf([a, b])).toBe(b);
        expect(pickShelf([shelf(16000, 10), null])).toEqual(shelf(16000, 10));
        expect(pickShelf([null, null])).toBeNull();
    });
});

describe('classifySpectrum at CD rates', () => {
    const base = { sampleRate: 44100, informativeWindows: 4, bandwidthHz: 20000 };
    it('16 kHz brickwall -> lossy transcode, confidence capped at 0.85', () => {
        const r = classifySpectrum({ ...base, aggregateShelf: shelf(16000, 48), windowShelves: windows(shelf(16000, 48)) });
        expect(r.kind).toBe('lossy-transcode');
        expect(r.confidence).toBe(THRESHOLDS.accusationMaxConfidence);
        expect(r.consistency).toBe(1);
        expect(r.cutoffHz).toBe(16000);
        expect(classify(44100, 16000, 30).confidence).toBeLessThan(0.85); // a weaker shelf keeps its own confidence
    });
    it('no shelf -> genuine; fewer windows -> lower confidence', () => {
        expect(classifySpectrum({ ...base, aggregateShelf: shelf(16000, 5), windowShelves: windows(null) })).toMatchObject({ kind: 'genuine', confidence: 0.9 });
        expect(classifySpectrum({ ...base, informativeWindows: 2, aggregateShelf: null, windowShelves: [] })).toMatchObject({ kind: 'genuine', confidence: 0.7 });
    });
    it('fewer than two informative windows -> inconclusive (too quiet)', () => {
        expect(classifySpectrum({ ...base, informativeWindows: 1, aggregateShelf: shelf(16000), windowShelves: [shelf(16000)] })).toMatchObject({ kind: 'inconclusive', reason: 'too-quiet' });
    });
    it('inconsistent per-window cutoffs -> inconclusive', () => {
        const r = classifySpectrum({ ...base, aggregateShelf: shelf(16000), windowShelves: [shelf(16000), shelf(19000), null, null] });
        expect(r).toMatchObject({ kind: 'inconclusive', reason: 'inconsistent-cutoff' });
        expect(r.consistency).toBe(0.25);
    });
    it('a shallow shelf gives a confidence below the verdict threshold -> inconclusive', () => {
        const r = classifySpectrum({ ...base, aggregateShelf: shelf(16000, 25), windowShelves: [shelf(16000, 25), shelf(16000, 25), shelf(16000, 25), null] });
        expect(r.kind).toBe('inconclusive');
        expect(r.reason).toBe('weak-shelf');
        expect(r.confidence).toBeLessThan(0.5);
        expect(classifySpectrum({ ...base, aggregateShelf: shelf(16000, 32), windowShelves: windows(shelf(16000, 32)) }).kind).toBe('lossy-transcode');
        // ... also in the band-limited zone: a weak shelf is never called band-limited
        expect(classify(44100, 20000, 25).reason).toBe('weak-shelf');
    });
    it('44.1 kHz: a sharp cut at or above 19.5 kHz is band-limited (neutral, confidence <= 0.6), below it a transcode', () => {
        expect(bandLimitedMinHz(44100)).toBe(19500);
        expect(classify(44100, 19500)).toMatchObject({ kind: 'band-limited', reason: 'shelf', cutoffHz: 19500 });
        expect(classify(44100, 19500).confidence).toBeLessThanOrEqual(0.6);
        expect(classify(44100, 20000, 64).confidence).toBe(THRESHOLDS.bandLimitedMaxConfidence);
        expect(classify(44100, 20700, 50, 4, { transitionHz: 900 }).kind).toBe('band-limited'); // soft or sharp alike
        expect(classify(44100, 19400).kind).toBe('lossy-transcode');
        expect(classify(44100, 19400).confidence).toBe(0.85);
    });
    it('48 kHz: the band-limited zone starts at 20 kHz', () => {
        expect(bandLimitedMinHz(48000)).toBe(20000);
        expect(classify(48000, 20000).kind).toBe('band-limited');
        expect(classify(48000, 19900).kind).toBe('lossy-transcode');
    });
    it('lower rates keep the same distance to Nyquist', () => {
        expect(bandLimitedMinHz(32000)).toBe(16000 - 2550);
        expect(bandLimitedMinHz(22050)).toBe(11025 - 2550);
    });
    it('a cut above 21 kHz (SRC/ADC filter) is genuine', () => {
        expect(classifySpectrum({ ...base, sampleRate: 48000, aggregateShelf: shelf(22400, 50), windowShelves: windows(shelf(22400, 50)) }))
            .toMatchObject({ kind: 'genuine', reason: 'cut-at-nyquist' });
        expect(classify(44100, 21001)).toMatchObject({ kind: 'genuine', reason: 'cut-at-nyquist' });
        expect(classify(44100, 21000).kind).toBe('band-limited');
    });
    it('a shelf beyond the search range is ignored', () => {
        expect(shelfSearchMaxHz(44100)).toBe(21050);
        expect(classifySpectrum({ ...base, aggregateShelf: shelf(21500, 50), windowShelves: windows(shelf(21500, 50)) }).kind).toBe('genuine');
    });
});

describe('classifySpectrum at hi-res rates', () => {
    const base = { sampleRate: 96000, informativeWindows: 6, bandwidthHz: 22000 };
    it('a cut at or below 22.5 kHz -> upsampled, confidence capped at 0.85', () => {
        const r = classifySpectrum({ ...base, aggregateShelf: shelf(21500, 60), windowShelves: windows(shelf(21500, 60), 6) });
        expect(r.kind).toBe('upsampled');
        expect(r.confidence).toBe(0.85);
        expect(classify(96000, 22500, 60, 6).kind).toBe('upsampled');
        expect(classify(96000, 20000, 60, 6).kind).toBe('upsampled');
        expect(classify(176400, 22000, 60, 6).kind).toBe('upsampled');
    });
    it('a cut below 19 kHz -> lossy transcode', () => {
        expect(classifySpectrum({ ...base, aggregateShelf: shelf(16000, 60), windowShelves: windows(shelf(16000, 60), 6) })).toMatchObject({ kind: 'lossy-transcode', confidence: 0.85 });
    });
    it('a cut between 22.5 and 27 kHz -> band-limited (DSD conversions, mastering filters, soft resamplers)', () => {
        expect(classify(96000, 22600, 60, 6)).toMatchObject({ kind: 'band-limited', confidence: 0.6 });
        expect(classify(96000, 24000, 106, 6).kind).toBe('band-limited');
        expect(classify(96000, 27000, 60, 6).kind).toBe('band-limited');
        expect(classify(176400, 24000, 60, 6).kind).toBe('band-limited');
        expect(classify(88200, 25500, 60, 6).kind).toBe('band-limited');
    });
    it('a cut above 27 kHz is reported but not judged', () => {
        expect(classifySpectrum({ ...base, aggregateShelf: shelf(30000, 60), windowShelves: windows(shelf(30000, 60), 6) })).toMatchObject({ kind: 'inconclusive', reason: 'hf-cut' });
        expect(classify(96000, 27100, 60, 6)).toMatchObject({ kind: 'inconclusive', reason: 'hf-cut' });
    });
    it('no cut and no content above 27 kHz -> inconclusive; content above -> genuine', () => {
        expect(classifySpectrum({ ...base, aggregateShelf: null, windowShelves: windows(null, 6) })).toMatchObject({ kind: 'inconclusive', reason: 'no-hf-content' });
        expect(classifySpectrum({ ...base, bandwidthHz: 40000, aggregateShelf: null, windowShelves: windows(null, 6) }).kind).toBe('genuine');
    });
    it('search range stops at 85 % of Nyquist', () => {
        expect(shelfSearchMaxHz(96000)).toBe(40800);
    });
});

describe('classifyBitDepth', () => {
    it('is n/a for 16-bit containers and floats', () => {
        expect(classifyBitDepth({ effectiveBits: 16, nonZero: 100000 }, 16, 4).kind).toBe('n/a');
        expect(classifyBitDepth(null, null, 4).kind).toBe('n/a');
    });
    it('effective <= 16 in a 24-bit container -> padded (confidence depends on sample count)', () => {
        expect(classifyBitDepth({ effectiveBits: 16, nonZero: 100000 }, 24, 4)).toMatchObject({ kind: 'padded', confidence: 0.95 });
        expect(classifyBitDepth({ effectiveBits: 14, nonZero: 1000 }, 24, 1)).toMatchObject({ kind: 'padded', confidence: 0.7 });
    });
    it('20 or 24 effective bits -> genuine', () => {
        expect(classifyBitDepth({ effectiveBits: 20, nonZero: 100000 }, 24, 4).kind).toBe('genuine');
        expect(classifyBitDepth({ effectiveBits: 24, nonZero: 100000 }, 32, 4).kind).toBe('genuine');
    });
});

describe('combineVerdict', () => {
    it('picks the most serious finding and lists all suspicious ones as flags', () => {
        const r = combineVerdict({ kind: 'lossy-transcode', confidence: 0.85 }, { kind: 'padded', confidence: 0.95 });
        expect(r).toEqual({ verdict: 'lossy-transcode', confidence: 0.85, flags: ['lossy-transcode', 'padded'] });
        expect(combineVerdict({ kind: 'genuine', confidence: 0.9 }, { kind: 'padded', confidence: 0.95 }).verdict).toBe('padded');
        expect(combineVerdict({ kind: 'inconclusive', confidence: 0.3 }, { kind: 'genuine', confidence: 0.9 }).verdict).toBe('inconclusive');
    });
    it('band-limited is neutral: it beats genuine/inconclusive, loses to any accusation and is never a flag', () => {
        expect(combineVerdict({ kind: 'band-limited', confidence: 0.6 }, { kind: 'genuine', confidence: 0.9 })).toEqual({ verdict: 'band-limited', confidence: 0.6, flags: [] });
        expect(combineVerdict({ kind: 'band-limited', confidence: 0.6 }, { kind: 'n/a', confidence: 0 }).verdict).toBe('band-limited');
        expect(combineVerdict({ kind: 'band-limited', confidence: 0.6 }, { kind: 'padded', confidence: 0.95 })).toEqual({ verdict: 'padded', confidence: 0.95, flags: ['padded'] });
        expect(isSuspicious('band-limited')).toBe(false);
    });
    it('genuine takes the weakest confidence of its parts', () => {
        expect(combineVerdict({ kind: 'genuine', confidence: 0.9 }, { kind: 'genuine', confidence: 0.6 })).toEqual({ verdict: 'genuine', confidence: 0.6, flags: [] });
        expect(combineVerdict({ kind: 'genuine', confidence: 0.7 }, { kind: 'n/a', confidence: 0 }).confidence).toBe(0.7);
    });
    it('helpers', () => {
        expect(isSuspicious('padded')).toBe(true);
        expect(isSuspicious('genuine')).toBe(false);
        expect(shelfConfidence(50, 1)).toBeCloseTo(0.95, 5);
        expect(shelfConfidence(25, 0.6)).toBeCloseTo(0.2 + 0.55 * (5 / 30) + 0.12, 5);
        expect(shelfConfidence(80, 1)).toBeCloseTo(0.95, 5); // saturates at 50 dB
        expect(THRESHOLDS.shelfMinStepDb).toBe(25);
        expect(ANALYZER_VERSION).toBe(2);
        expect(VERDICTS).toContain('band-limited');
    });
});
