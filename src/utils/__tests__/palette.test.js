import { describe, expect, it } from 'vitest';
import { extractPalette, rgbToHsl, hslToRgb, withLightness, luminance, rgbToCss } from '../palette.js';

// Synthetic RGBA image: `fill(x, y)` returns [r, g, b, a?]
const image = (width, height, fill) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a = 255] = fill(x, y);
            const o = (y * width + x) * 4;
            data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
        }
    }
    return { data, width, height };
};

describe('extractPalette', () => {
    it('returns null for empty input', () => {
        expect(extractPalette(null)).toBeNull();
        expect(extractPalette({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBeNull();
        expect(extractPalette(image(4, 4, () => [0, 0, 0, 0]))).toBeNull();   // fully transparent
    });

    it('finds the dominant colour of a mostly single-coloured image', () => {
        const palette = extractPalette(image(32, 32, (x) => (x < 28 ? [200, 30, 40] : [20, 20, 20])), { step: 1 });
        expect(palette.dominant).toEqual([200, 30, 40]);
        expect(palette.population).toBe(1024);
    });

    it('prefers a saturated mid-lightness colour as vibrant over a large dull area', () => {
        // 90% dark grey, 10% bright blue
        const palette = extractPalette(image(40, 40, (x, y) => (y < 4 ? [30, 90, 230] : [40, 40, 40])), { step: 1 });
        expect(palette.dominant).toEqual([40, 40, 40]);
        expect(palette.vibrant).toEqual([30, 90, 230]);
        expect(rgbToHsl(palette.dark).l).toBeLessThanOrEqual(0.2);
        expect(rgbToHsl(palette.light).l).toBeGreaterThanOrEqual(0.7);
    });

    it('ignores transparent pixels and samples with a step', () => {
        const palette = extractPalette(image(16, 16, (x) => (x % 2 ? [255, 255, 255, 0] : [10, 200, 10])));
        expect(palette.dominant).toEqual([10, 200, 10]);
        const stepped = extractPalette(image(64, 64, () => [120, 60, 200]), { step: 7 });
        expect(stepped.dominant).toEqual([120, 60, 200]);
        expect(stepped.population).toBe(Math.ceil(4096 / 7));
    });

    it('averages colours within a quantisation bin', () => {
        const palette = extractPalette(image(8, 8, (x) => [x % 2 ? 100 : 104, 50, 50]), { step: 1 });
        expect(palette.dominant).toEqual([102, 50, 50]);
    });
});

describe('colour helpers', () => {
    it('round-trips rgb <-> hsl', () => {
        for (const rgb of [[255, 0, 0], [0, 128, 255], [17, 17, 17], [250, 250, 250], [90, 200, 120]]) {
            expect(hslToRgb(rgbToHsl(rgb))).toEqual(rgb);
        }
        expect(rgbToHsl([0, 0, 0])).toEqual({ h: 0, s: 0, l: 0 });
    });

    it('withLightness clamps lightness and keeps hue; luminance is monotonic', () => {
        const dark = withLightness([200, 30, 40], 0.08, 0.2);
        expect(rgbToHsl(dark).l).toBeCloseTo(0.2, 2);
        expect(Math.round(rgbToHsl(dark).h)).toBe(Math.round(rgbToHsl([200, 30, 40]).h));
        expect(luminance([0, 0, 0])).toBe(0);
        expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
        expect(luminance([128, 128, 128])).toBeGreaterThan(luminance([64, 64, 64]));
        expect(rgbToCss([1, 2, 3])).toBe('rgb(1, 2, 3)');
    });
});
