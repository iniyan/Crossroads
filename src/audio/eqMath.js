// Biquad maths for the parametric EQ, kept pure so the curve, the auto preamp and the tests
// work without an AudioContext.
//
// The coefficients are the Web Audio specification's (Audio EQ Cookbook) for peaking,
// lowshelf, highshelf and lowpass, so the drawn curve is what
// BiquadFilterNode.getFrequencyResponse() would report (lowpass is not an EQ band type; the
// crossfeed network uses it). One consequence worth knowing: Web Audio's shelving filters
// ignore Q (the spec fixes the shelf slope at S = 1, i.e. Q ~ 0.71); AutoEq writes shelves
// with Q 0.70, so nothing is lost in practice, but a shelf's Q field is shown greyed out in
// the UI.

export const BAND_TYPES = Object.freeze(['peaking', 'lowshelf', 'highshelf']);

export const DEFAULT_SAMPLE_RATE = 48000;
export const MIN_FREQUENCY = 10;
export const MAX_FREQUENCY = 24000;
export const MIN_GAIN = -24;
export const MAX_GAIN = 24;
export const MIN_Q = 0.05;
export const MAX_Q = 30;
/** Preamp range: deep enough to compensate several stacked boosts (10 bands x 24 dB is unrealistic, but 40+ dB is not). */
export const MIN_PREAMP = -60;
export const MAX_PREAMP = 24;
/** Above this much combined boost the UI warns: the preamp still prevents clipping but the curve is extreme. */
export const BOOST_WARNING_DB = 24;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export const dbToLinear = (db) => 10 ** (db / 20);
export const linearToDb = (linear) => 20 * Math.log10(Math.max(linear, 1e-12));

/**
 * Normalised biquad coefficients { b0, b1, b2, a1, a2 } (a0 = 1). Unknown types and
 * frequencies at or above Nyquist fall back to a transparent filter. For 'lowpass' the
 * Web Audio convention applies: `gain` is ignored and `q` is a resonance in dB (0 dB = Q 1,
 * -3 dB ~ Butterworth, -6 dB = critically damped).
 */
export const biquadCoefficients = (type, frequency, gain, q, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const nyquist = sampleRate / 2;
    const f = clamp(Number(frequency), 1, nyquist * 0.999);
    const g = clamp(Number(gain) || 0, MIN_GAIN, MAX_GAIN);
    const A = 10 ** (g / 40);
    const w0 = 2 * Math.PI * f / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;

    if (type === 'lowpass') {
        const Q = 10 ** ((Number.isFinite(Number(q)) ? Number(q) : 0) / 20);
        const alpha = sin / (2 * Q);
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
    } else if (type === 'peaking') {
        const Q = clamp(Number(q) || 1, MIN_Q, MAX_Q);
        const alpha = sin / (2 * Q);
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
    } else if (type === 'lowshelf' || type === 'highshelf') {
        // S = 1 (Web Audio ignores Q for shelves)
        const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
        const beta = 2 * Math.sqrt(A) * alpha;
        if (type === 'lowshelf') {
            b0 = A * ((A + 1) - (A - 1) * cos + beta);
            b1 = 2 * A * ((A - 1) - (A + 1) * cos);
            b2 = A * ((A + 1) - (A - 1) * cos - beta);
            a0 = (A + 1) + (A - 1) * cos + beta;
            a1 = -2 * ((A - 1) + (A + 1) * cos);
            a2 = (A + 1) + (A - 1) * cos - beta;
        } else {
            b0 = A * ((A + 1) + (A - 1) * cos + beta);
            b1 = -2 * A * ((A - 1) + (A + 1) * cos);
            b2 = A * ((A + 1) + (A - 1) * cos - beta);
            a0 = (A + 1) - (A - 1) * cos + beta;
            a1 = 2 * ((A - 1) - (A + 1) * cos);
            a2 = (A + 1) - (A - 1) * cos - beta;
        }
    } else {
        return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
};

/** Complex response H(e^jw) = { re, im } of one biquad at `frequency`. */
export const biquadResponse = (coefficients, frequency, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const { b0, b1, b2, a1, a2 } = coefficients;
    const w = 2 * Math.PI * frequency / sampleRate;
    const cos1 = Math.cos(w), sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
    // numerator / denominator as complex numbers evaluated at e^{-jw}
    const numRe = b0 + b1 * cos1 + b2 * cos2;
    const numIm = -(b1 * sin1 + b2 * sin2);
    const denRe = 1 + a1 * cos1 + a2 * cos2;
    const denIm = -(a1 * sin1 + a2 * sin2);
    const den = Math.max(denRe * denRe + denIm * denIm, 1e-24);
    return { re: (numRe * denRe + numIm * denIm) / den, im: (numIm * denRe - numRe * denIm) / den };
};

/** |H(e^jw)| in dB of one biquad at `frequency`. */
export const biquadMagnitudeDb = (coefficients, frequency, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const { re, im } = biquadResponse(coefficients, frequency, sampleRate);
    return linearToDb(Math.sqrt(re * re + im * im));
};

/** `count` log-spaced frequencies between `from` and `to` (inclusive). */
export const logFrequencies = (count = 256, from = 20, to = 20000) => {
    const out = new Array(count);
    const ratio = Math.log(to / from);
    for (let i = 0; i < count; i++) out[i] = from * Math.exp(ratio * i / (count - 1));
    return out;
};

const activeBands = (bands) => (bands || []).filter(band => band && band.enabled !== false && BAND_TYPES.includes(band.type));

/**
 * Combined response in dB (without preamp) of the enabled bands at each frequency.
 * @returns {number[]}
 */
export const responseDb = (bands, frequencies, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const coefficients = activeBands(bands).map(band => biquadCoefficients(band.type, band.frequency, band.gain, band.q, sampleRate));
    return frequencies.map(frequency => coefficients.reduce((sum, c) => sum + biquadMagnitudeDb(c, frequency, sampleRate), 0));
};

/**
 * The largest positive gain (dB) of the combined response, evaluated on a log grid plus every
 * band's centre frequency (where peaks sit). 0 when the curve never goes above unity. Rounded
 * to 0.1 dB.
 */
export const peakBoostDb = (bands, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const active = activeBands(bands);
    if (active.length === 0) return 0;
    const frequencies = logFrequencies(256, MIN_FREQUENCY, Math.min(MAX_FREQUENCY, sampleRate / 2 * 0.99));
    active.forEach(band => {
        const f = Number(band.frequency);
        if (Number.isFinite(f) && f > 0 && f < sampleRate / 2) frequencies.push(f);
    });
    return Math.round(Math.max(0, ...responseDb(active, frequencies, sampleRate)) * 10) / 10;
};

/**
 * Clipping protection: the negative of the peak boost, so the EQ can never push a full-scale
 * signal above unity. Floored at MIN_PREAMP (-60 dB), far below any real curve.
 */
export const autoPreampDb = (bands, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const peak = peakBoostDb(bands, sampleRate);
    return peak === 0 ? 0 : Math.max(MIN_PREAMP, -peak);
};

/** Effective preamp for an EQ state: the automatic value or the manual one. */
export const effectivePreampDb = (eq, sampleRate = DEFAULT_SAMPLE_RATE) => {
    if (!eq) return 0;
    if (eq.preampAuto !== false) return autoPreampDb(eq.bands, sampleRate);
    const manual = Number(eq.preamp);
    return Number.isFinite(manual) ? clamp(manual, MIN_PREAMP, MAX_PREAMP) : 0;
};

/** Points for drawing: [{ frequency, db }] including the preamp offset. */
export const curvePoints = (eq, { count = 160, sampleRate = DEFAULT_SAMPLE_RATE } = {}) => {
    const frequencies = logFrequencies(count, 20, 20000);
    const preamp = effectivePreampDb(eq, sampleRate);
    const response = responseDb(eq?.bands, frequencies, sampleRate);
    return frequencies.map((frequency, i) => ({ frequency, db: response[i] + preamp }));
};
