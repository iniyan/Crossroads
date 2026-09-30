// Persisted DSP settings (store key 'dsp') and their validation.
//
// {
//   version: 1,
//   bypass: boolean,                      one-tap bypass: graph is disconnected, element -> destination
//   eq: {
//     enabled, preampAuto, preamp (dB, used when preampAuto is false),
//     bands: [{ id, type: 'peaking'|'lowshelf'|'highshelf', frequency, gain, q, enabled }],
//     profile: string|null               label of the loaded AutoEq profile / preset, for display
//   },
//   crossfeed: { enabled, preset: 'default'|'chumoy'|'meier'|'custom', fcut, feed },
//   presets: [{ id, name, bands, preamp, preampAuto }]     user presets
// }

import { BAND_TYPES, MIN_FREQUENCY, MAX_FREQUENCY, MIN_GAIN, MAX_GAIN, MIN_Q, MAX_Q, MIN_PREAMP, MAX_PREAMP } from './eqMath.js';
import { CROSSFEED_PRESETS, MIN_FCUT, MAX_FCUT, MIN_FEED, MAX_FEED } from './crossfeed.js';
import { MAX_BANDS } from './autoeq.js';

export const DSP_STORE_KEY = 'dsp';
export const DSP_STATE_VERSION = 1;
export const MAX_USER_PRESETS = 50;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const num = (value, fallback, lo, hi) => {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
};

let bandCounter = 0;
export const newBandId = () => `b${Date.now().toString(36)}${(bandCounter++).toString(36)}`;

export const newBand = (overrides = {}) => ({
    id: newBandId(),
    type: 'peaking',
    frequency: 1000,
    gain: 0,
    q: 1,
    enabled: true,
    ...overrides
});

/** A starting point of a few built-in curves (bands get fresh ids on use). */
export const BUILTIN_PRESETS = Object.freeze([
    { id: 'flat', name: 'Flat', bands: [] },
    {
        id: 'bass', name: 'Bass boost',
        bands: [{ type: 'lowshelf', frequency: 105, gain: 4, q: 0.7 }, { type: 'peaking', frequency: 60, gain: 1.5, q: 1 }]
    },
    {
        id: 'warm', name: 'Warm',
        bands: [{ type: 'lowshelf', frequency: 200, gain: 2, q: 0.7 }, { type: 'highshelf', frequency: 6000, gain: -2.5, q: 0.7 }]
    },
    {
        id: 'bright', name: 'Bright',
        bands: [{ type: 'peaking', frequency: 3000, gain: 2, q: 1.2 }, { type: 'highshelf', frequency: 8000, gain: 3, q: 0.7 }]
    }
]);

export const DEFAULT_DSP_STATE = Object.freeze({
    version: DSP_STATE_VERSION,
    bypass: false,
    eq: { enabled: false, preampAuto: true, preamp: 0, bands: [], profile: null },
    crossfeed: { enabled: false, preset: 'default', fcut: 700, feed: 4.5 },
    presets: []
});

export const normalizeBand = (band) => ({
    id: typeof band?.id === 'string' && band.id ? band.id : newBandId(),
    type: BAND_TYPES.includes(band?.type) ? band.type : 'peaking',
    frequency: num(band?.frequency, 1000, MIN_FREQUENCY, MAX_FREQUENCY),
    gain: num(band?.gain, 0, MIN_GAIN, MAX_GAIN),
    q: num(band?.q, 1, MIN_Q, MAX_Q),
    enabled: band?.enabled !== false
});

export const normalizeBands = (bands) => (Array.isArray(bands) ? bands : []).slice(0, MAX_BANDS).map(normalizeBand);

const normalizePreset = (preset, index) => {
    if (!preset || typeof preset !== 'object') return null;
    const name = String(preset.name || '').trim();
    if (!name) return null;
    return {
        id: typeof preset.id === 'string' && preset.id ? preset.id : `p${Date.now().toString(36)}${index}`,
        name: name.slice(0, 60),
        bands: normalizeBands(preset.bands),
        preampAuto: preset.preampAuto !== false,
        preamp: num(preset.preamp, 0, MIN_PREAMP, MAX_PREAMP)
    };
};

/** Fills in defaults and clamps every number, so a corrupted store never breaks the graph. */
export const normalizeDspState = (saved) => {
    const src = saved && typeof saved === 'object' ? saved : {};
    const eq = src.eq && typeof src.eq === 'object' ? src.eq : {};
    const cf = src.crossfeed && typeof src.crossfeed === 'object' ? src.crossfeed : {};
    const preset = CROSSFEED_PRESETS.some(p => p.id === cf.preset) ? cf.preset : 'default';
    return {
        version: DSP_STATE_VERSION,
        bypass: src.bypass === true,
        eq: {
            enabled: eq.enabled === true,
            preampAuto: eq.preampAuto !== false,
            preamp: num(eq.preamp, 0, MIN_PREAMP, MAX_PREAMP),
            bands: normalizeBands(eq.bands),
            profile: typeof eq.profile === 'string' && eq.profile ? eq.profile.slice(0, 120) : null
        },
        crossfeed: {
            enabled: cf.enabled === true,
            preset,
            fcut: num(cf.fcut, 700, MIN_FCUT, MAX_FCUT),
            feed: num(cf.feed, 4.5, MIN_FEED, MAX_FEED)
        },
        presets: (Array.isArray(src.presets) ? src.presets : [])
            .map(normalizePreset)
            .filter(Boolean)
            .slice(0, MAX_USER_PRESETS)
    };
};

/** Bands that change the signal: enabled with a non-zero gain (a 0 dB band is unity). */
export const effectiveBands = (eq) => (eq?.bands || []).filter(band => band && band.enabled !== false && Number(band.gain) !== 0);

/**
 * True when the graph must run: the EQ is enabled with at least one effective band, or the
 * crossfeed is enabled, and bypass is off. An EQ whose bands are all disabled or at 0 dB
 * does not route the element through Web Audio.
 */
export const dspWantsProcessing = (state) =>
    !!state && !state.bypass && ((state.eq?.enabled === true && effectiveBands(state.eq).length > 0) || state.crossfeed?.enabled === true);

/** Bands from a preset/profile with fresh ids. */
export const bandsFrom = (bands) => normalizeBands(bands).map(band => ({ ...band, id: newBandId() }));
