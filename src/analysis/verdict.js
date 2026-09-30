// Turns detector measurements into a verdict. Everything here is a heuristic: the copy the
// UI shows (describe.js) says "Likely ..." and the thresholds below are chosen so that a
// genuine recording is reported as 'genuine', 'band-limited' or 'inconclusive', never as a
// transcode: a false accusation is the worst failure. Bump ANALYZER_VERSION whenever a
// change here or in the detectors should invalidate cached results.
//
// Policy for a sharp cut ("brickwall") at frequency c:
//   44.1 / 48 kHz   c >= 19.5 / 20 kHz  -> 'band-limited' (neutral: a mastering filter or a
//                                           high-bitrate lossy source look the same)
//                   c above 21 kHz      -> 'genuine' (an SRC / ADC filter; no codec cuts there)
//                   lower               -> 'lossy-transcode', confidence capped at 0.85 (a
//                                           deliberate lo-fi / sound-design low-pass looks the same)
//   >= 88.2 kHz     c <= 22.5 kHz       -> 'upsampled' (or 'lossy-transcode' below 19 kHz), cap 0.85
//                   22.5 < c <= 27 kHz  -> 'band-limited' (DSD conversions and mastering filters
//                                           commonly cut there, so do soft resamplers)
//                   c > 27 kHz          -> 'inconclusive' (reported, not judged)
//   gentle roll-offs are never a cut: 'genuine'.

export const ANALYZER_VERSION = 2;

export const VERDICTS = Object.freeze(['genuine', 'upsampled', 'padded', 'lossy-transcode', 'inconclusive', 'unsupported', 'band-limited']);
export const SUSPICIOUS_VERDICTS = new Set(['upsampled', 'padded', 'lossy-transcode']);
export const isSuspicious = (verdict) => SUSPICIOUS_VERDICTS.has(verdict);

export const THRESHOLDS = Object.freeze({
    // Spectral shelf ("brickwall") detection
    shelfMinStepDb: 25,          // a lossy low-pass drops 30-60 dB within shelfStepWidthHz
    shelfStepWidthHz: 400,       // sharp step: lossy encoders, steep resamplers
    wideStepWidthHz: 2000,       // wide step (>= 88.2 kHz only): soft resampler transitions,
                                 // still > 200 dB/octave, far steeper than any analogue roll-off
    shelfMinHz: 8000,
    shelfMinTailDropDb: 20,      // everything above the cut must stay this far below the level before it
    shelfMaxRecoveryFraction: 0.75, // a notch recovers (almost) the whole step; a shelf does not
    shelfMaxRecoveryDb: 15,      // ... but small bumps (resampler images) are always tolerated
    nyquistMarginHz: 1000,       // a cut closer to Nyquist than this is the ADC/SRC filter, not lossy
    hiresSearchFraction: 0.85,   // at >= 88.2 kHz only search up to 0.85 * Nyquist (ADC decimation filter)
    hiresUpsampleMaxCutoffHz: 22500, // hi-res: a cut at or below a 44.1/48 kHz Nyquist means a lower-rate source
    hiresBandLimitedMaxHz: 27000,    // hi-res: a cut up to here is band-limited material; higher cuts are not judged
    lossyMaxCutoffAtHiresHz: 19000,  // below this a hi-res file's cut means lossy, above it "upsampled"
    lossyMaxCutoffHz: 21000,     // no lossy encoder low-passes above this: a higher cut is an SRC/ADC filter
    bandLimitedMinHz44: 19500,   // 44.1 kHz (and below): a cut from here up is band-limited, not a transcode
    bandLimitedMinHz48: 20000,   // 48 kHz
    accusationMaxConfidence: 0.85, // a suspicious verdict from a cut alone never exceeds this
    bandLimitedMaxConfidence: 0.6,
    consistencyMin: 0.6,         // share of informative windows that must agree on the cutoff
    consistencyToleranceHz: 800,
    // Windows
    silentRmsDb: -70,
    informativeMinDb: -100,      // mean level of 8-14 kHz needed for a cut to be visible at all
    hiresNoContentHz: 27000,     // hi-res file with nothing above this and no cut: inconclusive
    // Bit depth
    paddedMaxEffectiveBits: 16,
    minBitDepthSamples: 50000,
    verdictMinConfidence: 0.5
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Confidence in a shelf-based verdict from the step size and window agreement:
 * 25 dB / 60 % agreement -> 0.41 (below the verdict threshold), 30 dB / all agree -> 0.58,
 * 40 dB -> 0.77, 50 dB -> 0.95 (before the per-verdict caps).
 */
export function shelfConfidence(stepDb, consistency) {
    const base = clamp01((stepDb - 20) / 30);
    return Math.min(0.98, 0.2 + 0.55 * base + 0.2 * clamp01(consistency));
}

/** Upper bound of the shelf search for this sample rate. */
export function shelfSearchMaxHz(sampleRate) {
    const nyq = sampleRate / 2;
    if (sampleRate >= 88200) return nyq * THRESHOLDS.hiresSearchFraction;
    return nyq - THRESHOLDS.nyquistMarginHz;
}

/** Lowest cutoff that is called 'band-limited' rather than 'lossy-transcode' at CD-class rates. */
export function bandLimitedMinHz(sampleRate) {
    if (sampleRate >= 48000) return THRESHOLDS.bandLimitedMinHz48;
    // 44.1 kHz: 19.5 kHz; lower rates keep the same distance to Nyquist (22050 - 19500).
    return Math.min(THRESHOLDS.bandLimitedMinHz44, sampleRate / 2 - 2550);
}

/** A findShelf() result that looks like a real cut (big, and staying down above it). */
export const isShelfValid = (shelf) => {
    if (!shelf) return false;
    const T = THRESHOLDS;
    if (shelf.stepDb < T.shelfMinStepDb) return false;
    if (shelf.belowDb - shelf.aboveMeanDb < T.shelfMinTailDropDb) return false;
    return shelf.recoveryDb <= Math.max(T.shelfMaxRecoveryDb, T.shelfMaxRecoveryFraction * shelf.stepDb);
};

/** Of several findShelf() candidates (sharp / wide), the valid one with the biggest step, else the first. */
export function pickShelf(candidates) {
    let best = null;
    for (const c of candidates) {
        if (!isShelfValid(c)) continue;
        if (!best || c.stepDb > best.stepDb) best = c;
    }
    return best || candidates.find((c) => c) || null;
}

/**
 * Spectral classification.
 * @param {object} input
 * @param {number} input.sampleRate
 * @param {object|null} input.aggregateShelf  pickShelf() on the averaged spectrum
 * @param {Array<object|null>} input.windowShelves  pickShelf() per informative window
 * @param {number} input.informativeWindows
 * @param {number} input.bandwidthHz
 * @returns {{ kind: 'genuine'|'lossy-transcode'|'upsampled'|'band-limited'|'inconclusive', confidence, reason,
 *             cutoffHz, stepDb, consistency }}
 */
export function classifySpectrum({ sampleRate, aggregateShelf, windowShelves, informativeWindows, bandwidthHz }) {
    const T = THRESHOLDS;
    const hires = sampleRate >= 88200;
    const none = { cutoffHz: null, stepDb: null, consistency: null };
    if (informativeWindows < 2) {
        return { kind: 'inconclusive', confidence: 0, reason: 'too-quiet', ...none };
    }
    const shelf = isShelfValid(aggregateShelf) && aggregateShelf.cutoffHz <= shelfSearchMaxHz(sampleRate) ? aggregateShelf : null;
    if (shelf) {
        const agreeing = windowShelves.filter((w) => isShelfValid(w) &&
            Math.abs(w.cutoffHz - shelf.cutoffHz) <= T.consistencyToleranceHz).length;
        const consistency = agreeing / informativeWindows;
        const facts = { cutoffHz: shelf.cutoffHz, stepDb: shelf.stepDb, consistency };
        if (consistency < T.consistencyMin) {
            return { kind: 'inconclusive', confidence: 0.3, reason: 'inconsistent-cutoff', ...facts };
        }
        let confidence = shelfConfidence(shelf.stepDb, consistency);
        let kind;
        const c = shelf.cutoffHz;
        if (hires) {
            if (c > T.hiresBandLimitedMaxHz) {
                return { kind: 'inconclusive', confidence: 0.4, reason: 'hf-cut', ...facts };
            }
            if (c > T.hiresUpsampleMaxCutoffHz) kind = 'band-limited';
            else kind = c < T.lossyMaxCutoffAtHiresHz ? 'lossy-transcode' : 'upsampled';
        } else if (c > T.lossyMaxCutoffHz) {
            // e.g. a 44.1 kHz source resampled to 48 kHz: not what any lossy codec leaves behind.
            return { kind: 'genuine', confidence: informativeWindows >= 4 ? 0.85 : 0.7, reason: 'cut-at-nyquist', ...facts };
        } else if (c >= bandLimitedMinHz(sampleRate)) {
            kind = 'band-limited';
        } else {
            kind = 'lossy-transcode';
        }
        if (confidence < T.verdictMinConfidence) {
            return { kind: 'inconclusive', confidence, reason: 'weak-shelf', ...facts };
        }
        if (kind === 'band-limited') confidence = Math.min(confidence, T.bandLimitedMaxConfidence);
        else confidence = Math.min(confidence, T.accusationMaxConfidence);
        return { kind, confidence, reason: 'shelf', ...facts };
    }
    if (hires && bandwidthHz <= T.hiresNoContentHz) {
        return { kind: 'inconclusive', confidence: 0.3, reason: 'no-hf-content', ...none };
    }
    return { kind: 'genuine', confidence: informativeWindows >= 4 ? 0.9 : 0.7, reason: 'no-shelf', ...none };
}

/**
 * Bit-depth classification for integer containers.
 * @param {{ effectiveBits, nonZero }} summary  from summarizeBitDepth()
 * @param {number|null} containerBits
 * @param {number} windows  non-silent windows the samples came from
 */
export function classifyBitDepth(summary, containerBits, windows) {
    if (!containerBits || containerBits < 24 || !summary || summary.effectiveBits === null) {
        return { kind: 'n/a', confidence: 0, effectiveBits: summary ? summary.effectiveBits : null };
    }
    const enough = summary.nonZero >= THRESHOLDS.minBitDepthSamples && windows >= 2;
    if (summary.effectiveBits <= THRESHOLDS.paddedMaxEffectiveBits) {
        return { kind: 'padded', confidence: enough ? 0.95 : 0.7, effectiveBits: summary.effectiveBits };
    }
    return { kind: 'genuine', confidence: enough ? 0.9 : 0.6, effectiveBits: summary.effectiveBits };
}

const PRIORITY = ['lossy-transcode', 'upsampled', 'padded', 'band-limited', 'inconclusive', 'genuine'];

/**
 * Combines the spectral and bit-depth classifications into one verdict. `flags` lists every
 * suspicious finding, the verdict is the most serious one ('band-limited' is neutral: it
 * outranks 'genuine' and 'inconclusive' but is never a flag).
 */
export function combineVerdict(spectral, bitDepth) {
    const findings = [];
    if (spectral.kind !== 'n/a') findings.push({ kind: spectral.kind, confidence: spectral.confidence });
    if (bitDepth.kind !== 'n/a') findings.push({ kind: bitDepth.kind, confidence: bitDepth.confidence });
    const flags = findings.filter((f) => isSuspicious(f.kind)).map((f) => f.kind);
    let primary = null;
    for (const kind of PRIORITY) {
        primary = findings.find((f) => f.kind === kind);
        if (primary) break;
    }
    if (!primary) return { verdict: 'inconclusive', confidence: 0, flags };
    let confidence = primary.confidence;
    if (primary.kind === 'genuine') confidence = Math.min(...findings.map((f) => f.confidence));
    return { verdict: primary.kind, confidence: Math.round(confidence * 100) / 100, flags };
}
