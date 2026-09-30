// Pure detector functions over dB spectra and integer samples. No thresholds that decide a
// verdict live here (see verdict.js); these only measure.

/** Moving average over `widthHz` (centred), returns a new Float64Array. */
export function smoothDb(db, binHz, widthHz) {
    const n = db.length;
    const half = Math.max(1, Math.round(widthHz / 2 / binHz));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + db[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - half);
        const b = Math.min(n, i + half + 1);
        out[i] = (prefix[b] - prefix[a]) / (b - a);
    }
    return out;
}

export function percentile(values, p) {
    if (values.length === 0) return NaN;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
}

/** 5th-percentile level of the bins at or above `fromHz`: a robust noise-floor estimate. */
export function noiseFloorDb(db, binHz, fromHz = 2000) {
    const from = Math.min(db.length - 1, Math.round(fromHz / binHz));
    return percentile(db.subarray ? db.subarray(from) : db.slice(from), 0.05);
}

/**
 * Finds the sharpest downward step ("shelf") in the spectrum between minHz and maxHz.
 * The step at frequency f is mean(dB over [f - W, f)) - mean(dB over [f, f + W)) with
 * W = stepWidthHz: a lossy encoder's low-pass drops 30-60 dB within a few hundred Hz,
 * whereas even a steep analogue/mastering roll-off changes by only a few dB over that span.
 *
 * @returns {null | { cutoffHz, stepDb, belowDb, aboveDb, recoveryDb, transitionHz, aboveMeanDb }}
 *   recoveryDb: how far the spectrum rises again above the cutoff (large = a notch, not a shelf).
 *   transitionHz: width of the -3 dB .. +3 dB crossing around the step.
 */
export function findShelf(db, binHz, { minHz, maxHz, stepWidthHz = 400, smoothHz = 100 } = {}) {
    const n = db.length;
    const s = smoothDb(db, binHz, smoothHz);
    const W = Math.max(2, Math.round(stepWidthHz / binHz));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + s[i];
    const iMin = Math.max(W, Math.round(minHz / binHz));
    const iMax = Math.min(n - W - 1, Math.round(maxHz / binHz));
    if (iMax <= iMin) return null;

    let best = -1;
    let bestStep = -Infinity;
    for (let i = iMin; i <= iMax; i++) {
        const below = (prefix[i] - prefix[i - W]) / W;
        const above = (prefix[i + W] - prefix[i]) / W;
        const step = below - above;
        if (step > bestStep) { bestStep = step; best = i; }
    }
    if (best < 0) return null;
    const belowDb = (prefix[best] - prefix[best - W]) / W;
    const aboveDb = (prefix[best + W] - prefix[best]) / W;

    let left = best;
    while (left > 0 && s[left] < belowDb - 3) left--;
    let right = best;
    while (right < n - 1 && s[right] > aboveDb + 3) right++;

    const tailStart = best + W;
    const tailEnd = Math.max(tailStart + 1, n - 2);
    let tailMax = -Infinity;
    let tailSum = 0;
    let tailCount = 0;
    for (let i = tailStart; i < tailEnd; i++) {
        if (s[i] > tailMax) tailMax = s[i];
        tailSum += s[i];
        tailCount++;
    }
    return {
        cutoffHz: best * binHz,
        stepDb: bestStep,
        belowDb,
        aboveDb,
        recoveryDb: tailCount > 0 ? tailMax - aboveDb : 0,
        transitionHz: Math.max(binHz, (right - left) * binHz),
        aboveMeanDb: tailCount > 0 ? tailSum / tailCount : aboveDb
    };
}

/**
 * Effective bandwidth: the highest frequency whose (smoothed) level is within `rangeDb` of
 * the loudest bin at or above `peakFromHz`. Descriptive only (a flat wideband spectrum has no
 * separate "noise floor" to measure against, so a relative rule is used).
 * @returns {{ bandwidthHz: number, peakDb: number }}
 */
export function effectiveBandwidth(db, binHz, { rangeDb = 60, peakFromHz = 2000, smoothHz = 200 } = {}) {
    const s = smoothDb(db, binHz, smoothHz);
    const from = Math.min(s.length - 1, Math.round(peakFromHz / binHz));
    let peakDb = -Infinity;
    for (let i = from; i < s.length; i++) if (s[i] > peakDb) peakDb = s[i];
    for (let i = s.length - 2; i >= 0; i--) {
        if (s[i] >= peakDb - rangeDb) return { bandwidthHz: i * binHz, peakDb };
    }
    return { bandwidthHz: 0, peakDb };
}

/**
 * Level (mean dB) of the band [fromHz, toHz).
 */
export function bandLevelDb(db, binHz, fromHz, toHz) {
    const a = Math.max(0, Math.round(fromHz / binHz));
    const b = Math.min(db.length, Math.round(toHz / binHz));
    if (b <= a) return NaN;
    let sum = 0;
    for (let i = a; i < b; i++) sum += db[i];
    return sum / (b - a);
}

/**
 * Low-bit statistics of integer samples: how many trailing zero bits every non-zero sample
 * shares (16-bit audio padded into 24-bit has 8), plus a histogram of trailing-zero counts.
 * Genuine 24-bit (or dithered) material has ~50 % odd samples.
 *
 * @param {Int32Array[]} channels
 * @param {number} bits  container bit depth
 * @returns {{ bits, nonZero, orAcc, histogram: number[] }}  histogram[k] = samples with k trailing zeros.
 */
export function bitDepthStats(channels, bits) {
    const histogram = new Array(bits + 1).fill(0);
    let orAcc = 0;
    let nonZero = 0;
    for (const x of channels) {
        for (let i = 0; i < x.length; i++) {
            const v = x[i];
            if (v === 0) continue;
            nonZero++;
            orAcc |= v;
            const tz = 31 - Math.clz32(v & -v);
            histogram[Math.min(bits, tz)]++;
        }
    }
    return { bits, nonZero, orAcc, histogram };
}

export function mergeBitDepthStats(a, b) {
    if (!a) return b;
    if (!b) return a;
    const histogram = a.histogram.map((v, i) => v + (b.histogram[i] || 0));
    return { bits: a.bits, nonZero: a.nonZero + b.nonZero, orAcc: a.orAcc | b.orAcc, histogram };
}

/** Effective bit depth and the share of samples whose low byte is zero. */
export function summarizeBitDepth(stats) {
    if (!stats || stats.nonZero === 0) return { effectiveBits: null, lowByteZeroFraction: null, nonZero: 0 };
    const tz = stats.orAcc === 0 ? stats.bits : 31 - Math.clz32(stats.orAcc & -stats.orAcc);
    let lowZero = 0;
    for (let k = 8; k < stats.histogram.length; k++) lowZero += stats.histogram[k];
    return {
        effectiveBits: Math.max(1, stats.bits - Math.min(tz, stats.bits)),
        lowByteZeroFraction: lowZero / stats.nonZero,
        nonZero: stats.nonZero
    };
}
