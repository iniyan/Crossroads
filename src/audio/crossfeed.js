// Headphone crossfeed after Bauer's bs2b, built from Web Audio biquads; pure maths only.
//
// Each output channel = direct(own channel) + cross(other channel), where
//   cross  = lowpass(other) x r,  r = 10^(-feed/20)          (feed dB below the direct at LF)
//   direct = lowshelf(own): 1/(1+r) at low frequencies, unity above the crossfeed region
// so centred (L = R) content sums to 1/(1+r) + r/(1+r) = 1 in the bass and 1 + 0 = 1 in the
// treble. bs2b does the same with first-order filters ("highboost" on the direct path); here
// the lowpass is a critically damped 2nd-order biquad (Q = -6 dB, |H| = 1/(1+(f/fc)^2)),
// whose corner is placed so that -3 dB lands on the user's `fcut` like bs2b's first-order
// filter, and the shelf corner is tied to it (SHELF_RATIO) so the mid-band, where the
// lowpass has phase lag, stays flat. There is no delay: the lowpass's phase lag provides
// the inter-aural timing cue, and a delay on the cross path would comb-filter the mono sum.
//
// The compensation is verified numerically (crossfeedResponse / __tests__): for every preset
// and the whole custom range, centred content is within +-0.6 dB from 20 Hz to 20 kHz and a
// hard-panned channel keeps its treble at unity (its bass drops by 20log10(1+r), the
// energy having moved to the other ear). Steady-state worst case |direct| + |cross| exceeds
// unity slightly around fcut; crossfeedHeadroomDb() is the preamp needed to cover that.

import { biquadCoefficients, biquadResponse, logFrequencies, linearToDb, DEFAULT_SAMPLE_RATE } from './eqMath.js';

export const CROSSFEED_PRESETS = Object.freeze([
    { id: 'default', name: 'Default (700 Hz, 4.5 dB)', fcut: 700, feed: 4.5 },
    { id: 'chumoy', name: 'Chu Moy (700 Hz, 6 dB)', fcut: 700, feed: 6 },
    { id: 'meier', name: 'Jan Meier (650 Hz, 9.5 dB)', fcut: 650, feed: 9.5 },
    { id: 'custom', name: 'Custom', fcut: null, feed: null }
]);

export const MIN_FCUT = 300;
export const MAX_FCUT = 2000;
export const MIN_FEED = 1;
export const MAX_FEED = 15;

/** Lowpass resonance in dB (Web Audio lowpass Q): -6 dB = critically damped, two real poles. */
export const LOWPASS_Q_DB = -6;
/** A Q = 0.5 biquad is -3 dB at 0.644 x its corner; scale the corner so -3 dB sits on fcut. */
export const LOWPASS_CORNER_RATIO = 1 / Math.sqrt(Math.SQRT2 - 1);
/** Shelf corner / lowpass corner, fitted so the mono sum stays flat (depends mildly on feed). */
export const shelfRatio = (feedDb) => 0.33 + 0.0055 * feedDb;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Resolves a crossfeed state ({ preset, fcut, feed }) to concrete numbers. */
export const resolveCrossfeed = (state) => {
    const preset = CROSSFEED_PRESETS.find(p => p.id === state?.preset) || CROSSFEED_PRESETS[0];
    const fcut = preset.fcut ?? Number(state?.fcut);
    const feed = preset.feed ?? Number(state?.feed);
    return {
        fcut: clamp(Number.isFinite(fcut) ? fcut : 700, MIN_FCUT, MAX_FCUT),
        feed: clamp(Number.isFinite(feed) ? feed : 4.5, MIN_FEED, MAX_FEED)
    };
};

/**
 * Node parameters for a crossfeed network from (fcut Hz, feed dB).
 * @returns {{ fcut, feed, crossGain, lowpassFrequency, lowpassQ, shelfFrequency, shelfGainDb }}
 */
export const designCrossfeed = (fcut, feed) => {
    const f = clamp(Number(fcut) || 700, MIN_FCUT, MAX_FCUT);
    const level = clamp(Number(feed) || 4.5, MIN_FEED, MAX_FEED);
    const r = 10 ** (-level / 20);
    const lowpassFrequency = f * LOWPASS_CORNER_RATIO;
    return {
        fcut: f,
        feed: level,
        crossGain: r / (1 + r),
        lowpassFrequency,
        lowpassQ: LOWPASS_Q_DB,
        shelfFrequency: lowpassFrequency * shelfRatio(level),
        shelfGainDb: linearToDb(1 / (1 + r))
    };
};

/**
 * Frequency response of a design at each frequency, from the same biquad maths as the EQ:
 *   monoDb    level of centred (L = R) content
 *   directDb  a hard-panned channel in its own ear (|direct|)
 *   crossDb   the same channel in the other ear (|cross|)
 *   sum       |direct| + |cross|, the worst-case gain for any L/R mix (headroom)
 */
export const crossfeedResponse = (design, frequencies, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const lowpass = biquadCoefficients('lowpass', design.lowpassFrequency, 0, design.lowpassQ, sampleRate);
    const shelf = biquadCoefficients('lowshelf', design.shelfFrequency, design.shelfGainDb, 0.7, sampleRate);
    return frequencies.map(frequency => {
        const direct = biquadResponse(shelf, frequency, sampleRate);
        const lp = biquadResponse(lowpass, frequency, sampleRate);
        const cross = { re: lp.re * design.crossGain, im: lp.im * design.crossGain };
        const directMag = Math.hypot(direct.re, direct.im);
        const crossMag = Math.hypot(cross.re, cross.im);
        return {
            frequency,
            monoDb: linearToDb(Math.hypot(direct.re + cross.re, direct.im + cross.im)),
            directDb: linearToDb(directMag),
            crossDb: linearToDb(crossMag),
            sum: directMag + crossMag
        };
    });
};

/** Preamp (dB, <= 0) that keeps any input below unity through the network. Rounded to 0.1 dB. */
export const crossfeedHeadroomDb = (design, sampleRate = DEFAULT_SAMPLE_RATE) => {
    const frequencies = logFrequencies(128, 20, Math.min(20000, sampleRate / 2 * 0.99));
    const peak = Math.max(1, ...crossfeedResponse(design, frequencies, sampleRate).map(p => p.sum));
    return -Math.ceil(linearToDb(peak) * 10) / 10;
};
