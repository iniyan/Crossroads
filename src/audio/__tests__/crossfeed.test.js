import { describe, expect, it } from 'vitest';
import {
    CROSSFEED_PRESETS, MIN_FCUT, MAX_FCUT, MIN_FEED, MAX_FEED,
    designCrossfeed, crossfeedResponse, crossfeedHeadroomDb, resolveCrossfeed
} from '../crossfeed.js';
import { biquadCoefficients, biquadMagnitudeDb, logFrequencies } from '../eqMath.js';

const grid = logFrequencies(240, 20, 20000);
const presets = CROSSFEED_PRESETS.filter(p => p.fcut !== null);

const extremes = (values) => ({ max: Math.max(...values), min: Math.min(...values) });

describe('crossfeed design', () => {
    it('places the lowpass -3 dB point on fcut and the cross path `feed` dB below the direct one', () => {
        for (const sampleRate of [44100, 48000, 96000]) {
            for (const preset of presets) {
                const design = designCrossfeed(preset.fcut, preset.feed);
                const lp = biquadCoefficients('lowpass', design.lowpassFrequency, 0, design.lowpassQ, sampleRate);
                expect(biquadMagnitudeDb(lp, preset.fcut, sampleRate)).toBeCloseTo(-3, 0);
                const [low] = crossfeedResponse(design, [20], sampleRate);
                expect(low.directDb - low.crossDb).toBeCloseTo(preset.feed, 1);
            }
        }
    });

    it('keeps centred (L = R) content flat within +-1 dB from 20 Hz to 20 kHz for every preset', () => {
        for (const sampleRate of [44100, 48000, 96000]) {
            for (const preset of presets) {
                const design = designCrossfeed(preset.fcut, preset.feed);
                const { max, min } = extremes(crossfeedResponse(design, grid, sampleRate).map(p => p.monoDb));
                expect(max, `${preset.id} @ ${sampleRate}`).toBeLessThan(1);
                expect(min, `${preset.id} @ ${sampleRate}`).toBeGreaterThan(-1);
            }
        }
    });

    it('holds the same tolerance over the whole custom range', () => {
        for (let fcut = MIN_FCUT; fcut <= MAX_FCUT; fcut += 100) {
            for (let feed = MIN_FEED; feed <= MAX_FEED; feed += 1) {
                const design = designCrossfeed(fcut, feed);
                const { max, min } = extremes(crossfeedResponse(design, grid).map(p => p.monoDb));
                expect(max, `${fcut} Hz / ${feed} dB`).toBeLessThan(1);
                expect(min, `${fcut} Hz / ${feed} dB`).toBeGreaterThan(-1);
            }
        }
    });

    it('keeps a hard-panned channel at unity in the treble and gives the other ear only lows', () => {
        for (const preset of presets) {
            const design = designCrossfeed(preset.fcut, preset.feed);
            const treble = crossfeedResponse(design, grid.filter(f => f >= 2000), 48000);
            treble.forEach(p => {
                expect(Math.abs(p.directDb), `${preset.id} direct @ ${p.frequency.toFixed(0)} Hz`).toBeLessThan(1.5);
                expect(p.crossDb, `${preset.id} cross @ ${p.frequency.toFixed(0)} Hz`).toBeLessThan(-20);
            });
            // The bass of a hard-panned channel drops by 20log10(1+r): the energy moved to the other ear.
            const [bass] = crossfeedResponse(design, [30], 48000);
            const r = 10 ** (-preset.feed / 20);
            expect(bass.directDb).toBeCloseTo(-20 * Math.log10(1 + r), 1);
        }
    });

    it('needs only a little headroom, taken in the preamp', () => {
        for (const preset of presets) {
            const headroom = crossfeedHeadroomDb(designCrossfeed(preset.fcut, preset.feed));
            expect(headroom).toBeLessThanOrEqual(0);
            expect(headroom).toBeGreaterThan(-3);
            // ... and it really bounds |direct| + |cross|
            const peak = Math.max(...crossfeedResponse(designCrossfeed(preset.fcut, preset.feed), grid).map(p => p.sum));
            expect(20 * Math.log10(peak) + headroom).toBeLessThanOrEqual(0.05);
        }
    });

    it('resolves presets and clamps custom values', () => {
        expect(resolveCrossfeed({ preset: 'meier' })).toEqual({ fcut: 650, feed: 9.5 });
        expect(resolveCrossfeed({ preset: 'custom', fcut: 100000, feed: -3 })).toEqual({ fcut: 2000, feed: 1 });
        expect(resolveCrossfeed({ preset: 'nope' })).toEqual({ fcut: CROSSFEED_PRESETS[0].fcut, feed: CROSSFEED_PRESETS[0].feed });
        expect(designCrossfeed('x', 'y').fcut).toBe(700);
    });
});
