import { describe, expect, it } from 'vitest';
import { wrapText, ellipsize, drawSlide, SLIDE_WIDTH, SLIDE_HEIGHT } from '../slideImage.js';

// 10 px per character, whatever the font. fillText calls record the alignment in force and
// the measured width, so a test can compute each text's horizontal extent.
const fakeCtx = () => {
    const calls = [];
    const record = (name) => (...args) => { calls.push([name, ...args]); };
    const ctx = {
        calls,
        texts: [],
        measureText: (text) => ({ width: String(text).length * 10 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect: record('fillRect'), beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill: record('fill'),
        textBaseline: '', textAlign: 'left', fillStyle: '', font: ''
    };
    ctx.fillText = (text, x, y) => {
        calls.push(['fillText', text, x, y]);
        const width = ctx.measureText(text).width;
        const left = ctx.textAlign === 'right' ? x - width : x;
        ctx.texts.push({ text, x, y, left, right: left + width, align: ctx.textAlign });
    };
    return ctx;
};

describe('wrapText', () => {
    it('wraps on word boundaries within the width', () => {
        expect(wrapText(fakeCtx(), 'one two three four', 90)).toEqual(['one two', 'three', 'four']);
        expect(wrapText(fakeCtx(), 'short', 200)).toEqual(['short']);
        expect(wrapText(fakeCtx(), '', 200)).toEqual([]);
    });

    it('keeps an overlong word on its own line and ellipsizes past maxLines', () => {
        expect(wrapText(fakeCtx(), 'supercalifragilistic word', 100)).toEqual(['supercalifragilistic', 'word']);
        const lines = wrapText(fakeCtx(), 'a b c d e f g h', 30, 2);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('a b');
        expect(lines[1].endsWith('…')).toBe(true);
        expect(lines[1].length * 10).toBeLessThanOrEqual(30);
    });

    it('ellipsize cuts to the width and leaves short text alone', () => {
        expect(ellipsize(fakeCtx(), 'short', 100)).toBe('short');
        const cut = ellipsize(fakeCtx(), 'x'.repeat(60), 100);
        expect(cut).toBe('xxxxxxxxx…');
        expect(ellipsize(fakeCtx(), null, 100)).toBe('');
    });
});

describe('drawSlide', () => {
    it('draws title, rows, bars and the brand line without throwing', () => {
        const ctx = fakeCtx();
        drawSlide(ctx, {
            kicker: 'Top tracks', title: 'A very long title that will need wrapping onto several lines', subtitle: 'sub',
            big: 12, bigUnit: 'hours',
            rows: [{ rank: 1, label: 'Song', sub: 'Artist', value: '3 plays' }],
            bars: [{ label: 'Hi-Res', value: 10, valueLabel: '10 h' }, { label: 'CD', value: 5, valueLabel: '5 h' }],
            footer: 'note', gradient: ['#000', '#111']
        }, { periodLabel: 'Week 40, 2026' });
        const texts = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
        expect(texts).toContain('TOP TRACKS');
        expect(texts).toContain('Week 40, 2026');
        expect(texts).toContain('12');
        expect(texts).toContain('Song');
        expect(texts).toContain('Hi-Res');
        expect(texts).toContain('Crossroads Wrapped');
        expect(ctx.calls[0]).toEqual(['fillRect', 0, 0, SLIDE_WIDTH, SLIDE_HEIGHT]);
    });

    it('keeps 60-character values, labels and kickers inside the canvas and out of each other', () => {
        const long = (prefix) => `${prefix} ${'abcdefghij'.repeat(6)}`.slice(0, 60);   // 60 chars = 600 px in the fake font
        const ctx = fakeCtx();
        const slide = {
            kicker: long('KICKER'), title: long('Title'), subtitle: long('Subtitle'),
            big: '12', bigUnit: long('unit'),
            rows: [
                { rank: 1, label: long('Label'), sub: long('Artist'), value: long('Value') },
                { rank: '', label: 'Top track', value: long('Track name') },
                { rank: 2, label: long('Only label'), value: '' }
            ],
            bars: [{ label: long('Bar'), value: 10, valueLabel: long('10 hours') }],
            footer: long('Footer'), gradient: ['#000', '#111']
        };
        drawSlide(ctx, slide, { periodLabel: long('Period') });

        const margin = 96;
        ctx.texts.forEach(t => {
            expect(t.left, `"${t.text}" starts inside the margin`).toBeGreaterThanOrEqual(margin);
            expect(t.right, `"${t.text}" ends inside the margin`).toBeLessThanOrEqual(SLIDE_WIDTH - margin);
        });
        // The strings that had no room (kicker, period, row label/sub/value x2, bar label and
        // value) were cut with an ellipsis; the footer and unit fit and are drawn in full.
        const cut = ctx.texts.filter(t => t.text.endsWith('…'));
        expect(cut.length).toBe(8);
        expect(ctx.texts.find(t => t.text.startsWith('Footer')).text).toHaveLength(60);

        // Row values (right-aligned) never overlap their labels (left-aligned) on the same line.
        const rows = ctx.texts.filter(t => t.text.startsWith('Label') || t.text.startsWith('Value') || t.text.startsWith('Top track') || t.text.startsWith('Track name') || t.text.startsWith('Artist'));
        const byY = new Map();
        rows.forEach(t => { const key = Math.round(t.y / 20); byY.set(key, [...(byY.get(key) || []), t]); });
        let pairs = 0;
        rows.filter(t => t.align === 'right').forEach(value => {
            rows.filter(t => t.align === 'left' && Math.abs(t.y - value.y) < 60).forEach(label => {
                pairs++;
                expect(label.right, `"${label.text}" runs into "${value.text}"`).toBeLessThanOrEqual(value.left);
            });
        });
        expect(pairs).toBeGreaterThanOrEqual(2);

        // Kicker and period label share a line and do not touch.
        const kicker = ctx.texts.find(t => t.text.startsWith('KICKER'));
        const period = ctx.texts.find(t => t.text.startsWith('Period'));
        expect(kicker.right).toBeLessThan(period.left);
        // Bar label, bar and value: the value stays in its 120 px column.
        const barValue = ctx.texts.find(t => t.text.startsWith('10 hours'));
        expect(barValue.right - barValue.left).toBeLessThanOrEqual(120);
    });
});
