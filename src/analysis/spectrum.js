// Averaged magnitude spectrum of a decoded window (Welch: Hann window, 50 % overlap,
// power averaged over frames and channels). Stereo pairs are transformed with one complex
// FFT (left in the real part, right in the imaginary part) and separated afterwards.

import { createFFT, hannWindow } from './fft.js';

export const DEFAULT_FFT_SIZE = 8192;
export const MIN_DB = -200;

const fftCache = new Map();
const windowCache = new Map();
const getFFT = (n) => { if (!fftCache.has(n)) fftCache.set(n, createFFT(n)); return fftCache.get(n); };
const getWindow = (n) => { if (!windowCache.has(n)) windowCache.set(n, hannWindow(n)); return windowCache.get(n); };

/**
 * @param {ArrayLike<number>[]} channels  one array per channel (ints or floats)
 * @param {object} options
 * @param {number} options.scale      multiply samples by this to get [-1, 1) (1 / 2^(bits-1) for ints)
 * @param {number} [options.fftSize]
 * @returns {{ power: Float64Array, binHz: number, frames: number, rms: number }}
 *   power: fftSize/2+1 bins, normalised so a full-scale sine peaks at 1.0 (0 dBFS);
 *   rms: of all samples in [-1, 1) units.
 */
export function windowSpectrum(channels, { scale, sampleRate, fftSize = DEFAULT_FFT_SIZE }) {
    const nch = channels.length;
    const len = channels[0].length;
    const bins = fftSize / 2 + 1;
    const power = new Float64Array(bins);
    const fft = getFFT(fftSize);
    const win = getWindow(fftSize);
    let winSum = 0;
    for (let i = 0; i < fftSize; i++) winSum += win[i];
    const norm = 1 / ((winSum / 2) * (winSum / 2));

    let sumSq = 0;
    for (let c = 0; c < nch; c++) {
        const x = channels[c];
        for (let i = 0; i < len; i++) { const v = x[i] * scale; sumSq += v * v; }
    }
    const rms = nch * len > 0 ? Math.sqrt(sumSq / (nch * len)) : 0;

    const hop = fftSize >> 1;
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    let frames = 0;
    let transforms = 0;
    if (len < fftSize) return { power, binHz: sampleRate / fftSize, frames: 0, rms };

    for (let c = 0; c < nch; c += 2) {
        const a = channels[c];
        const b = c + 1 < nch ? channels[c + 1] : null;
        for (let start = 0; start + fftSize <= len; start += hop) {
            for (let i = 0; i < fftSize; i++) {
                re[i] = a[start + i] * scale * win[i];
                im[i] = b ? b[start + i] * scale * win[i] : 0;
            }
            fft.forward(re, im);
            // Separate the two real spectra: A[k] = (X[k] + conj(X[N-k])) / 2,
            // B[k] = (X[k] - conj(X[N-k])) / (2i).
            for (let k = 0; k < bins; k++) {
                const k2 = k === 0 ? 0 : fftSize - k;
                const xr = re[k], xi = im[k], yr = re[k2], yi = im[k2];
                const ar = (xr + yr) / 2, ai = (xi - yi) / 2;
                power[k] += (ar * ar + ai * ai) * norm;
                if (b) {
                    const br = (xi + yi) / 2, bi = (yr - xr) / 2;
                    power[k] += (br * br + bi * bi) * norm;
                }
            }
            frames++;
            transforms += b ? 2 : 1;
        }
    }
    if (transforms > 0) for (let k = 0; k < bins; k++) power[k] /= transforms;
    return { power, binHz: sampleRate / fftSize, frames, rms };
}

/** Power -> dB, clamped at MIN_DB. */
export function powerToDb(power) {
    const out = new Float32Array(power.length);
    for (let i = 0; i < power.length; i++) out[i] = power[i] > 0 ? Math.max(MIN_DB, 10 * Math.log10(power[i])) : MIN_DB;
    return out;
}

/** Mean of `spectra` (power arrays of equal length). */
export function meanPower(spectra) {
    const out = new Float64Array(spectra[0].length);
    for (const s of spectra) for (let i = 0; i < out.length; i++) out[i] += s[i];
    for (let i = 0; i < out.length; i++) out[i] /= spectra.length;
    return out;
}

/** Reduces a power spectrum to `buckets` equal-width frequency buckets (mean power), in dB. */
export function downsampleToDb(power, buckets) {
    const out = new Array(buckets);
    const n = power.length;
    for (let b = 0; b < buckets; b++) {
        const from = Math.floor(b * n / buckets);
        const to = Math.max(from + 1, Math.floor((b + 1) * n / buckets));
        let sum = 0;
        for (let i = from; i < to; i++) sum += power[i];
        const mean = sum / (to - from);
        out[b] = mean > 0 ? Math.max(MIN_DB, 10 * Math.log10(mean)) : MIN_DB;
    }
    return out;
}

export const rmsToDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : MIN_DB);
