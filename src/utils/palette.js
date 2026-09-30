// Dominant / vibrant colour extraction from raw RGBA pixels (vinyl mode backgrounds, #26).
//
// extractPalette() is pure and works on any { data, width, height } (an ImageData or a plain
// object in tests). It quantises to a 4-bit-per-channel histogram, drops near-transparent
// pixels, and picks: `dominant` (most populated bin, weighted a little towards saturated
// colours), `vibrant` (most saturated bin with a real population and mid lightness) and
// `dark` / `light` variants for backgrounds and text.
//
// paletteFromImage() is the browser helper: it draws the image on a small canvas and reads
// it back. Canvas pixel reads need a same-origin or CORS-enabled image; on a tainted canvas
// (or any error) it resolves null and callers fall back to theme colours.

const BITS = 4;
const SHIFT = 8 - BITS;
const SIZE = 1 << BITS;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** { h: 0..360, s: 0..1, l: 0..1 } */
export const rgbToHsl = ([r, g, b]) => {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0));
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    return { h: h * 60, s, l };
};

export const hslToRgb = ({ h, s, l }) => {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
        let x = t;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map(v => Math.round(clamp01(v) * 255));
};

export const rgbToCss = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

/** Same hue/saturation, lightness forced into [minL, maxL]. */
export const withLightness = (rgb, minL, maxL) => {
    const hsl = rgbToHsl(rgb);
    return hslToRgb({ ...hsl, l: Math.min(maxL, Math.max(minL, hsl.l)) });
};

/** Relative luminance (WCAG), 0..1. */
export const luminance = ([r, g, b]) => {
    const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/**
 * @param {{ data: ArrayLike<number>, width: number, height: number }} image  RGBA pixels
 * @param {{ step?: number }} [options]  sample every `step`-th pixel (default: enough for ~4096 samples)
 * @returns {{ dominant: number[], vibrant: number[], dark: number[], light: number[], population: number } | null}
 */
export const extractPalette = (image, options = {}) => {
    const data = image?.data;
    const pixels = data ? Math.floor(data.length / 4) : 0;
    if (!pixels) return null;
    const step = Math.max(1, options.step || Math.floor(pixels / 4096) || 1);

    const counts = new Map();   // bin index -> { n, r, g, b } sums for the average colour of the bin
    let population = 0;
    for (let i = 0; i < pixels; i += step) {
        const o = i * 4;
        const a = data[o + 3];
        if (a < 128) continue;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        const bin = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
        let entry = counts.get(bin);
        if (!entry) { entry = { n: 0, r: 0, g: 0, b: 0 }; counts.set(bin, entry); }
        entry.n += 1; entry.r += r; entry.g += g; entry.b += b;
        population += 1;
    }
    if (population === 0) return null;

    const bins = Array.from(counts.values()).map(({ n, r, g, b }) => {
        const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        const hsl = rgbToHsl(rgb);
        return { rgb, hsl, n, share: n / population };
    });

    // Dominant: population, nudged towards colourful bins so a thin bright band is not
    // always lost to a large near-black or near-white area.
    const dominantBin = bins.reduce((best, bin) => {
        const score = bin.n * (0.6 + 0.4 * bin.hsl.s) * (bin.hsl.l < 0.05 || bin.hsl.l > 0.97 ? 0.5 : 1);
        return score > best.score ? { score, bin } : best;
    }, { score: -1, bin: bins[0] }).bin;

    // Vibrant: saturated, mid lightness, and not negligible in the picture.
    const vibrantBin = bins.reduce((best, bin) => {
        const { s, l } = bin.hsl;
        if (bin.share < 0.002) return best;
        const lightnessFit = 1 - Math.min(1, Math.abs(l - 0.5) / 0.45);
        const score = s * s * lightnessFit * (0.5 + Math.min(0.5, bin.share * 10));
        return score > best.score ? { score, bin } : best;
    }, { score: -1, bin: null }).bin || dominantBin;

    const dominant = dominantBin.rgb;
    const vibrant = vibrantBin.rgb;
    return {
        dominant,
        vibrant,
        dark: withLightness(dominant, 0.08, 0.2),
        light: withLightness(vibrant, 0.72, 0.9),
        population
    };
};

const MAX_SAMPLE_SIZE = 96;

/**
 * Loads `src` with CORS and extracts its palette; null when the image cannot be read.
 * Resolves quickly on cached images; never rejects.
 */
export const paletteFromImage = (src, { crossOrigin = 'anonymous', timeoutMs = 8000 } = {}) => new Promise((resolve) => {
    if (!src || typeof document === 'undefined') { resolve(null); return; }
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => {
        try {
            const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
            const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
            const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, width, height);
            finish(extractPalette(ctx.getImageData(0, 0, width, height)));   // throws on a tainted canvas
        } catch (e) {
            console.warn('Album art palette unavailable', e && e.message);
            finish(null);
        }
    };
    img.onerror = () => finish(null);
    img.src = src;
});
