// Synthetic test signals for the quality analyser: deterministic (seeded) noise, music-like
// material, band-limiting filters, upsampling and integer quantisation. Shared by the unit
// tests and by the fixture generator that feeds ffmpeg.

import { createFFT } from '../fft.js';

export function seededRandom(seed = 1) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const gaussian = (rng) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export function whiteNoise(n, rng, amp = 0.1) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = gaussian(rng) * amp;
    return out;
}

/** Pink (1/f) noise, Paul Kellet's filter. */
export function pinkNoise(n, rng, amp = 0.1) {
    const out = new Float64Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
        const w = gaussian(rng);
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * amp;
        b6 = w * 0.115926;
    }
    return out;
}

/**
 * Music-like wideband material: chords of harmonic tones that change every ~0.4 s, a
 * pink-noise bed and bright noise bursts (hi-hat / snare like) that carry energy up to
 * Nyquist with a natural (gentle) roll-off. Values stay within +-0.9.
 */
export function musicLike(n, sampleRate, rng, { noiseAmp = 0.03, burstAmp = 0.25, toneAmp = 0.12 } = {}) {
    const out = pinkNoise(n, rng, noiseAmp);
    const noteLen = Math.round(sampleRate * 0.4);
    let phase = [];
    let freqs = [];
    for (let start = 0; start < n; start += noteLen) {
        const root = 55 * 2 ** (Math.floor(rng() * 36) / 12);
        freqs = [root, root * 1.5, root * 2.52, root * 4];
        phase = freqs.map(() => rng() * 2 * Math.PI);
        const end = Math.min(n, start + noteLen);
        for (let i = start; i < end; i++) {
            const t = (i - start) / sampleRate;
            const env = Math.exp(-t * 3) * (1 - Math.exp(-t * 400));
            let s = 0;
            for (let f = 0; f < freqs.length; f++) {
                for (let h = 1; h <= 12; h++) {
                    const fh = freqs[f] * h;
                    if (fh >= sampleRate / 2) break;
                    s += Math.sin(2 * Math.PI * fh * t + phase[f] * h) / (h * h);
                }
            }
            out[i] += s * toneAmp * env / freqs.length;
        }
        // Bright bursts: white noise with a fast decay, twice per note.
        for (let b = 0; b < 2; b++) {
            const bStart = start + Math.floor(b * noteLen / 2);
            const bLen = Math.min(n - bStart, Math.round(sampleRate * 0.05));
            for (let i = 0; i < bLen; i++) {
                const env = Math.exp(-i / (sampleRate * 0.012));
                out[bStart + i] += gaussian(rng) * burstAmp * env;
            }
        }
    }
    for (let i = 0; i < n; i++) out[i] = Math.max(-0.9, Math.min(0.9, out[i]));
    return out;
}

/** Linear convolution by FFT overlap-add, centred (output aligned with the input). */
export function fftConvolve(signal, kernel) {
    const K = kernel.length;
    const block = 8192;
    let size = 1;
    while (size < block + K - 1) size <<= 1;
    const fft = createFFT(size);
    const kr = new Float64Array(size);
    const ki = new Float64Array(size);
    kr.set(kernel);
    fft.forward(kr, ki);
    const n = signal.length;
    const outLen = n + K - 1;
    const acc = new Float64Array(outLen);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let start = 0; start < n; start += block) {
        re.fill(0); im.fill(0);
        const len = Math.min(block, n - start);
        for (let i = 0; i < len; i++) re[i] = signal[start + i];
        fft.forward(re, im);
        // Multiply by the kernel spectrum, then inverse FFT via conjugation.
        for (let i = 0; i < size; i++) {
            const a = re[i], b = im[i], c = kr[i], d = ki[i];
            re[i] = a * c - b * d;
            im[i] = -(a * d + b * c);
        }
        fft.forward(re, im);
        const limit = Math.min(size, outLen - start);
        for (let i = 0; i < limit; i++) acc[start + i] += re[i] / size;
    }
    const half = (K - 1) >> 1;
    return acc.subarray(half, half + n);
}

/** Windowed-sinc FIR low-pass (Blackman window). More taps = steeper transition. */
export function firLowpass(signal, cutoffHz, sampleRate, taps = 511) {
    const M = taps - 1;
    const fc = cutoffHz / sampleRate;
    const h = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const x = i - M / 2;
        const sinc = x === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * x) / x;
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / M) + 0.08 * Math.cos(4 * Math.PI * i / M);
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    return Float64Array.from(fftConvolve(signal, h));
}

/** Gentle IIR low-pass: `stages` cascaded 2-pole Butterworth sections (12 dB/oct each). */
export function gentleLowpass(signal, cutoffHz, sampleRate, stages = 1) {
    let x = signal;
    for (let s = 0; s < stages; s++) {
        const w0 = 2 * Math.PI * cutoffHz / sampleRate;
        const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
        const cosw = Math.cos(w0);
        const b0 = (1 - cosw) / 2, b1 = 1 - cosw, b2 = (1 - cosw) / 2;
        const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
        const out = new Float64Array(x.length);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < x.length; i++) {
            const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
            x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
            out[i] = y;
        }
        x = out;
    }
    return x;
}

/** Zero-stuff by `factor` and low-pass at `cutoffHz` (of the new rate) with a steep FIR. */
export function upsample(signal, factor, cutoffHz, newRate, taps = 1023) {
    const out = new Float64Array(signal.length * factor);
    for (let i = 0; i < signal.length; i++) out[i * factor] = signal[i] * factor;
    return firLowpass(out, cutoffHz, newRate, taps);
}

/** Quantise [-1, 1) floats to `bits`-bit integers, optional TPDF dither of 1 LSB. */
export function quantize(signal, bits, { dither = false, rng = null } = {}) {
    const scale = 2 ** (bits - 1);
    const max = scale - 1;
    const out = new Int32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
        let v = signal[i] * scale;
        if (dither && rng) v += rng() - rng();
        v = Math.round(v);
        out[i] = v > max ? max : v < -scale ? -scale : v;
    }
    return out;
}

/** 16-bit integers stored in a 24-bit container (low byte zero). */
export const padTo24 = (int16) => int16.map((v) => v * 256);

/** 16-bit content in a 24-bit container plus low-level noise in the low bits. */
export function padTo24Dithered(int16, rng, lsbAmp = 40) {
    const out = new Int32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] * 256 + Math.round((rng() - 0.5) * 2 * lsbAmp);
    return out;
}

export const silence = (n) => new Float64Array(n);

export function scale(signal, factor) {
    const out = new Float64Array(signal.length);
    for (let i = 0; i < signal.length; i++) out[i] = signal[i] * factor;
    return out;
}

/** RIFF/WAVE PCM bytes (little-endian ints of 16 or 24 bits) from Int32Array channels. */
export function encodeWav(channels, sampleRate, bits) {
    const nch = channels.length;
    const frames = channels[0].length;
    const bytesPer = bits / 8;
    const dataLen = frames * nch * bytesPer;
    const buf = new Uint8Array(44 + dataLen);
    const dv = new DataView(buf.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nch * bytesPer, true);
    dv.setUint16(32, nch * bytesPer, true); dv.setUint16(34, bits, true);
    str(36, 'data'); dv.setUint32(40, dataLen, true);
    let o = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < nch; c++) {
            const v = channels[c][i];
            buf[o++] = v & 0xFF;
            buf[o++] = (v >> 8) & 0xFF;
            if (bits === 24) buf[o++] = (v >> 16) & 0xFF;
        }
    }
    return buf;
}
