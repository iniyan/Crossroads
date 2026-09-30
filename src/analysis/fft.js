// Iterative radix-2 complex FFT with precomputed twiddles and bit-reversal table.

export function createFFT(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    const levels = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let x = i;
        let r = 0;
        for (let l = 0; l < levels; l++) { r = (r << 1) | (x & 1); x >>= 1; }
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos(2 * Math.PI * i / n);
        sin[i] = -Math.sin(2 * Math.PI * i / n);
    }

    /** In-place forward transform of (re, im), both Float64Array of length n. */
    function forward(re, im) {
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1;
            const step = n / size;
            for (let start = 0; start < n; start += size) {
                for (let k = 0, t = 0; k < half; k++, t += step) {
                    const a = start + k;
                    const b = a + half;
                    const wr = cos[t];
                    const wi = sin[t];
                    const xr = re[b] * wr - im[b] * wi;
                    const xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }

    return { n, forward };
}

/** Periodic Hann window of length n. */
export function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
}
