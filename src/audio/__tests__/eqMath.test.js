import { describe, expect, it } from 'vitest';
import { biquadCoefficients, biquadMagnitudeDb, responseDb, autoPreampDb, peakBoostDb, effectivePreampDb, curvePoints, logFrequencies, MIN_PREAMP } from '../eqMath.js';
import { normalizeDspState, dspWantsProcessing, effectiveBands, DEFAULT_DSP_STATE, bandsFrom } from '../dspState.js';
import { DspEngine } from '../dsp.js';

const at = (bands, f) => responseDb(bands, [f])[0];

describe('biquad responses (Web Audio cookbook formulas)', () => {
    it('a peaking filter hits its gain at the centre and is flat far away', () => {
        const band = { type: 'peaking', frequency: 1000, gain: 6, q: 1.4 };
        expect(at([band], 1000)).toBeCloseTo(6, 2);
        expect(Math.abs(at([band], 20))).toBeLessThan(0.05);
        expect(Math.abs(at([band], 20000))).toBeLessThan(0.1);
        const cut = { ...band, gain: -6 };
        expect(at([cut], 1000)).toBeCloseTo(-6, 2);
    });

    it('shelves reach their gain on the shelf side and unity on the other', () => {
        const low = { type: 'lowshelf', frequency: 105, gain: 6.4, q: 0.7 };
        expect(at([low], 10)).toBeCloseTo(6.4, 1);
        expect(Math.abs(at([low], 10000))).toBeLessThan(0.05);
        const high = { type: 'highshelf', frequency: 10000, gain: -2.1, q: 0.7 };
        expect(at([high], 20000)).toBeCloseTo(-2.1, 1);
        expect(Math.abs(at([high], 100))).toBeLessThan(0.05);
        // the shelf is half way (in dB) at its corner
        expect(at([low], 105)).toBeCloseTo(3.2, 1);
    });

    it('ignores disabled and unknown bands and sums enabled ones', () => {
        const a = { type: 'peaking', frequency: 1000, gain: 3, q: 1 };
        const b = { type: 'peaking', frequency: 1000, gain: 3, q: 1 };
        expect(at([a, b], 1000)).toBeCloseTo(6, 2);
        expect(at([a, { ...b, enabled: false }], 1000)).toBeCloseTo(3, 2);
        expect(at([{ type: 'notch', frequency: 1000, gain: 3, q: 1 }], 1000)).toBe(0);
        expect(biquadMagnitudeDb(biquadCoefficients('bogus', 1000, 3, 1), 1000)).toBe(0);
    });

    it('clamps a frequency above Nyquist instead of producing NaN', () => {
        const band = { type: 'peaking', frequency: 30000, gain: 6, q: 1 };
        const values = responseDb([band], logFrequencies(32));
        values.forEach(v => expect(Number.isFinite(v)).toBe(true));
    });

    it('lowpass follows the Web Audio convention (Q in dB, gain ignored)', () => {
        const butterworth = biquadCoefficients('lowpass', 1000, 12, -3.0103);   // Q = 1/sqrt2
        expect(biquadMagnitudeDb(butterworth, 1000)).toBeCloseTo(-3, 1);
        expect(biquadMagnitudeDb(butterworth, 20)).toBeCloseTo(0, 2);
        expect(biquadMagnitudeDb(butterworth, 4000)).toBeCloseTo(-24, 0);       // 12 dB/octave
        const damped = biquadCoefficients('lowpass', 1000, 0, -6.0206);         // Q = 0.5: |H| = 1/(1 + (f/fc)^2)
        expect(biquadMagnitudeDb(damped, 1000)).toBeCloseTo(-6, 1);
    });
});

describe('autoPreampDb', () => {
    it('is the negative of the largest boost of the combined curve', () => {
        expect(autoPreampDb([{ type: 'peaking', frequency: 1000, gain: 6, q: 1.4 }])).toBeCloseTo(-6, 1);
        expect(autoPreampDb([
            { type: 'peaking', frequency: 1000, gain: 3, q: 1 },
            { type: 'peaking', frequency: 1000, gain: 3, q: 1 }
        ])).toBeCloseTo(-6, 1);
    });

    it('is 0 for cuts only, for no bands, and for disabled bands', () => {
        expect(autoPreampDb([{ type: 'peaking', frequency: 1000, gain: -6, q: 1 }])).toBe(0);
        expect(autoPreampDb([])).toBe(0);
        expect(autoPreampDb([{ type: 'peaking', frequency: 1000, gain: 6, q: 1, enabled: false }])).toBe(0);
    });

    it('lands close to the AutoEq preamp for a real profile', () => {
        const hd650 = [
            { type: 'lowshelf', frequency: 105, gain: 6.4, q: 0.7 }, { type: 'peaking', frequency: 8800, gain: 5.1, q: 1.42 },
            { type: 'peaking', frequency: 118, gain: -3.1, q: 0.5 }, { type: 'peaking', frequency: 37, gain: 0.7, q: 3.96 },
            { type: 'peaking', frequency: 3169, gain: -1.7, q: 3.89 }, { type: 'highshelf', frequency: 10000, gain: -2.1, q: 0.7 },
            { type: 'peaking', frequency: 1227, gain: -1.2, q: 2.53 }, { type: 'peaking', frequency: 2055, gain: 1.2, q: 3.23 },
            { type: 'peaking', frequency: 587, gain: 0.4, q: 1.19 }, { type: 'peaking', frequency: 5332, gain: -1.1, q: 5.75 }
        ];
        const preamp = autoPreampDb(hd650);
        expect(preamp).toBeLessThan(-4);
        expect(preamp).toBeGreaterThan(-8);
    });

    it('effectivePreampDb switches between automatic and manual', () => {
        const bands = [{ type: 'peaking', frequency: 1000, gain: 6, q: 1 }];
        expect(effectivePreampDb({ preampAuto: true, preamp: -2, bands })).toBeCloseTo(-6, 1);
        expect(effectivePreampDb({ preampAuto: false, preamp: -2, bands })).toBe(-2);
        expect(effectivePreampDb({ preampAuto: false, preamp: 'x', bands })).toBe(0);
        expect(effectivePreampDb({ preampAuto: false, preamp: -80, bands })).toBe(MIN_PREAMP);
    });

    it('follows stacked boosts past -24 dB, down to the -60 dB floor, and reports the boost for the warning', () => {
        const stack = (count, gain) => Array.from({ length: count }, () => ({ type: 'peaking', frequency: 1000, gain, q: 1 }));
        expect(peakBoostDb(stack(2, 24))).toBeCloseTo(48, 0);
        expect(autoPreampDb(stack(2, 24))).toBeCloseTo(-48, 0);
        expect(autoPreampDb(stack(3, 24))).toBe(MIN_PREAMP);
        expect(effectivePreampDb({ preampAuto: true, bands: stack(2, 24) })).toBeCloseTo(-48, 0);
        // the normalised state keeps such a preamp
        expect(normalizeDspState({ eq: { preamp: -48 } }).eq.preamp).toBe(-48);
    });

    it('curvePoints includes the preamp offset', () => {
        const points = curvePoints({ preampAuto: true, bands: [{ type: 'peaking', frequency: 1000, gain: 6, q: 1 }] }, { count: 50 });
        expect(points).toHaveLength(50);
        expect(Math.max(...points.map(p => p.db))).toBeLessThanOrEqual(0.05);
        expect(points[0].frequency).toBe(20);
        expect(points[49].frequency).toBeCloseTo(20000, 6);
    });
});

describe('normalizeDspState', () => {
    it('fills defaults from nothing and from garbage', () => {
        expect(normalizeDspState(null)).toEqual({ ...DEFAULT_DSP_STATE, eq: { ...DEFAULT_DSP_STATE.eq, bands: [] }, presets: [] });
        const state = normalizeDspState({ bypass: 'yes', eq: { enabled: true, bands: [{ type: 'weird', frequency: -5, gain: 99, q: 0 }, null] }, presets: [{ name: '' }, { name: 'Mine', bands: [] }] });
        expect(state.bypass).toBe(false);
        expect(state.eq.enabled).toBe(true);
        expect(state.eq.bands).toHaveLength(2);
        expect(state.eq.bands[0]).toMatchObject({ type: 'peaking', frequency: 10, gain: 24, q: 0.05, enabled: true });
        expect(state.presets).toHaveLength(1);
        expect(state.presets[0].name).toBe('Mine');
    });

    it('dspWantsProcessing needs something enabled and no bypass', () => {
        const bands = [{ type: 'peaking', frequency: 1000, gain: 3, q: 1 }];
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands } }))).toBe(true);
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: [] } }))).toBe(false);
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: false, bands } }))).toBe(false);
        expect(dspWantsProcessing(normalizeDspState({ crossfeed: { enabled: true } }))).toBe(true);
        expect(dspWantsProcessing(normalizeDspState({ bypass: true, crossfeed: { enabled: true } }))).toBe(false);
        expect(bandsFrom(bands)[0].id).toBeTruthy();
    });

    it('dspWantsProcessing only counts enabled bands with a non-zero gain', () => {
        const off = [{ type: 'peaking', frequency: 1000, gain: 3, q: 1, enabled: false }, { type: 'lowshelf', frequency: 100, gain: -6, q: 0.7, enabled: false }];
        const flat = [{ type: 'peaking', frequency: 1000, gain: 0, q: 1 }, { type: 'highshelf', frequency: 8000, gain: 0, q: 0.7 }];
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: off } }))).toBe(false);
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: flat } }))).toBe(false);
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: [...off, ...flat] } }))).toBe(false);
        const mixed = [...off, ...flat, { type: 'peaking', frequency: 2000, gain: 0.5, q: 1 }];
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: mixed } }))).toBe(true);
        expect(effectiveBands(normalizeDspState({ eq: { bands: mixed } }).eq)).toHaveLength(1);
        // crossfeed still counts on its own
        expect(dspWantsProcessing(normalizeDspState({ eq: { enabled: true, bands: off }, crossfeed: { enabled: true } }))).toBe(true);
    });
});

// A minimal fake of the Web Audio objects the engine touches, recording connections.
const fakeContext = () => {
    const connections = [];
    const param = (value) => ({ value, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } });
    const node = (name) => ({
        name,
        connect(target, out = 0, inp = 0) { connections.push([this.name, target.name, out, inp]); return target; },
        disconnect() { for (let i = connections.length - 1; i >= 0; i--) if (connections[i][0] === this.name) connections.splice(i, 1); }
    });
    let sources = 0;
    let resumes = 0;
    let gains = 0, biquads = 0;
    const ctx = {
        sampleRate: 48000, currentTime: 0, state: 'suspended', connections,
        get sources() { return sources; },
        get resumes() { return resumes; },
        suspends: 0,
        destination: node('destination'),
        resume() { resumes += 1; ctx.state = 'running'; return Promise.resolve(); },
        suspend() { ctx.suspends += 1; ctx.state = 'suspended'; return Promise.resolve(); },
        createMediaElementSource() { sources += 1; return node('source'); },
        createGain() { return { ...node(`gain${gains++}`), gain: param(1), channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' }; },
        createBiquadFilter() { return { ...node(`biquad${biquads++}`), type: 'peaking', frequency: param(1000), gain: param(0), Q: param(1) }; },
        createChannelSplitter() { return node('splitter'); },
        createChannelMerger() { return node('merger'); },
        createDelay() { throw new Error('the crossfeed must not use a DelayNode'); },
        createAnalyser() { return { ...node('analyser'), fftSize: 2048, getFloatTimeDomainData(arr) { arr.fill(0.25); } }; }
    };
    return ctx;
};

const fakeAudio = () => ({ paused: false, ended: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {} });

describe('DspEngine routing', () => {
    it('stays native until processing is wanted, then creates one source and never another', () => {
        const ctx = fakeContext();
        const audio = fakeAudio();
        const engine = new DspEngine(audio, { createContext: () => ctx });
        engine.apply(normalizeDspState(null));
        expect(engine.routed).toBe(false);
        expect(ctx.sources).toBe(0);

        const bands = [{ type: 'peaking', frequency: 1000, gain: 3, q: 1 }];
        engine.apply({ eq: { enabled: true, bands } });
        expect(engine.routed).toBe(true);
        expect(engine.active).toBe(true);
        expect(ctx.sources).toBe(1);
        expect(ctx.connections.some(([from, to]) => from === 'source' && to.startsWith('gain'))).toBe(true);
        expect(ctx.connections.some(([from, to]) => from === 'source' && to === 'destination')).toBe(false);
        expect(ctx.resumes).toBe(1);

        engine.apply({ bypass: true, eq: { enabled: true, bands } });
        expect(engine.routed).toBe(true);
        expect(engine.active).toBe(false);
        expect(ctx.sources).toBe(1);
        expect(ctx.connections.filter(([from]) => from === 'source')).toEqual([['source', 'destination', 0, 0]]);
        expect(engine.measure().wiring).toBe('bypass');

        engine.apply({ eq: { enabled: true, bands }, crossfeed: { enabled: true, preset: 'chumoy' } });
        expect(engine.wiring).toBe('eq+crossfeed');
        expect(ctx.connections.some(([from, to]) => from === 'merger' && to === 'analyser')).toBe(true);
        expect(engine.measure().peak).toBeCloseTo(0.25, 5);
        expect(engine.describe()).toContain('crossfeed');
    });

    it('does not route an EQ whose bands are all disabled or flat', () => {
        const ctx = fakeContext();
        const engine = new DspEngine(fakeAudio(), { createContext: () => ctx });
        engine.apply({ eq: { enabled: true, bands: [{ type: 'peaking', frequency: 1000, gain: 6, q: 1, enabled: false }, { type: 'peaking', frequency: 500, gain: 0, q: 1 }] } });
        expect(engine.routed).toBe(false);
        expect(ctx.sources).toBe(0);
        expect(engine.describe()).toContain('Native output');
    });

    it('up-mixes mono to stereo before the crossfeed splitter', () => {
        const ctx = fakeContext();
        const engine = new DspEngine(fakeAudio(), { createContext: () => ctx });
        engine.apply({ crossfeed: { enabled: true } });
        const { upmix, splitter, filters, shelfL, lowpassL, crossL } = engine.nodes;
        expect(upmix.channelCount).toBe(2);
        expect(upmix.channelCountMode).toBe('explicit');
        expect(upmix.channelInterpretation).toBe('speakers');
        const last = filters[filters.length - 1];
        expect(ctx.connections).toContainEqual([last.name, upmix.name, 0, 0]);
        expect(ctx.connections).toContainEqual([upmix.name, splitter.name, 0, 0]);
        // direct path: lowshelf to its own channel; cross path: lowpass -> gain to the other
        expect(ctx.connections).toContainEqual(['splitter', shelfL.name, 0, 0]);
        expect(ctx.connections).toContainEqual([shelfL.name, 'merger', 0, 0]);
        expect(ctx.connections).toContainEqual([lowpassL.name, crossL.name, 0, 0]);
        expect(ctx.connections).toContainEqual([crossL.name, 'merger', 0, 1]);
        expect(shelfL.type).toBe('lowshelf');
        expect(lowpassL.type).toBe('lowpass');
        expect(lowpassL.Q.value).toBe(-6);
        expect(shelfL.gain.value).toBeLessThan(0);
        // headroom for the crossfeed is taken in the preamp
        expect(engine.nodes.preamp.gain.value).toBeLessThan(1);
        expect(engine.preampDb()).toBeLessThan(0);
        expect(engine.preampDb()).toBeGreaterThan(-3);
    });

    it('resumes a suspended context on play and suspends it on pause / end of queue', async () => {
        const ctx = fakeContext();
        const audio = fakeAudio();
        const engine = new DspEngine(audio, { createContext: () => ctx });
        engine.apply({ crossfeed: { enabled: true } });
        ctx.state = 'suspended';
        audio.listeners.play();
        expect(ctx.state).toBe('running');

        audio.paused = true;
        audio.listeners.pause();
        expect(ctx.state).toBe('suspended');
        expect(ctx.suspends).toBe(1);

        // settings changes while paused leave it suspended; play resumes it
        engine.apply({ crossfeed: { enabled: true, preset: 'meier' } });
        expect(ctx.state).toBe('suspended');
        audio.paused = false;
        audio.listeners.play();
        expect(ctx.state).toBe('running');

        // end of track with another one following: 'pause' with ended=true is ignored,
        // the next track's play() has already un-paused the element by the time ended settles
        audio.ended = true; audio.paused = true;
        audio.listeners.pause();
        expect(ctx.state).toBe('running');
        audio.listeners.ended();
        audio.paused = false; audio.ended = false;             // playNext() -> play()
        await new Promise(r => setTimeout(r, 5));
        expect(ctx.state).toBe('running');

        // end of the queue: nothing follows, so the context idles
        audio.ended = true; audio.paused = true;
        audio.listeners.pause();
        audio.listeners.ended();
        await new Promise(r => setTimeout(r, 5));
        expect(ctx.state).toBe('suspended');
    });
});
