import { describe, expect, it } from 'vitest';
import { parseParametricEq, parseAutoEqIndex, profileUrl, searchAutoEqIndex, entryLabel, MAX_BANDS } from '../autoeq.js';

const HD650 = `Preamp: -6.1 dB
Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
Filter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42
Filter 3: ON PK Fc 118 Hz Gain -3.1 dB Q 0.50
Filter 4: ON PK Fc 37 Hz Gain 0.7 dB Q 3.96
Filter 5: ON PK Fc 3169 Hz Gain -1.7 dB Q 3.89
Filter 6: ON HSC Fc 10000 Hz Gain -2.1 dB Q 0.70
Filter 7: ON PK Fc 1227 Hz Gain -1.2 dB Q 2.53
Filter 8: ON PK Fc 2055 Hz Gain 1.2 dB Q 3.23
Filter 9: ON PK Fc 587 Hz Gain 0.4 dB Q 1.19
Filter 10: ON PK Fc 5332 Hz Gain -1.1 dB Q 5.75
`;

describe('parseParametricEq', () => {
    it('parses preamp and every ON filter with its type', () => {
        const { preamp, filters } = parseParametricEq(HD650);
        expect(preamp).toBe(-6.1);
        expect(filters).toHaveLength(10);
        expect(filters[0]).toEqual({ type: 'lowshelf', frequency: 105, gain: 6.4, q: 0.7 });
        expect(filters[1]).toEqual({ type: 'peaking', frequency: 8800, gain: 5.1, q: 1.42 });
        expect(filters[5]).toEqual({ type: 'highshelf', frequency: 10000, gain: -2.1, q: 0.7 });
        expect(filters[2].gain).toBe(-3.1);
    });

    it('skips OFF filters, unknown types and junk lines; tolerates CRLF and missing Q', () => {
        const text = 'Preamp: -3 dB\r\nFilter 1: OFF PK Fc 100 Hz Gain 3 dB Q 1\r\nFilter 2: ON LP Fc 100 Hz Gain 0 dB Q 1\r\nhello\r\nFilter 3: ON PK Fc 250 Hz Gain -2 dB\r\n';
        const { preamp, filters } = parseParametricEq(text);
        expect(preamp).toBe(-3);
        expect(filters).toEqual([{ type: 'peaking', frequency: 250, gain: -2, q: 0.7071 }]);
    });

    it('returns an empty profile for empty / null input and caps the band count', () => {
        expect(parseParametricEq('')).toEqual({ preamp: 0, filters: [] });
        expect(parseParametricEq(null)).toEqual({ preamp: 0, filters: [] });
        const many = Array.from({ length: 15 }, (_, i) => `Filter ${i + 1}: ON PK Fc ${100 + i} Hz Gain 1 dB Q 1`).join('\n');
        expect(parseParametricEq(many).filters).toHaveLength(MAX_BANDS);
    });
});

const INDEX = `# Index
This is a list of all equalization profiles.

- [1Custom SA02](./crinacle/711%20in-ear/1Custom%20SA02) by crinacle on 711
- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990
- [Sennheiser HD 650](./Innerfidelity/over-ear/Sennheiser%20HD%20650) by Innerfidelity
- [Sony WH-1000XM4 (ANC on)](./Rtings/over-ear/Sony%20WH-1000XM4%20(ANC%20on)) by Rtings
- [Apple AirPods Pro](./oratory1990/in-ear/Apple%20AirPods%20Pro) by oratory1990
- not an entry
`;

describe('parseAutoEqIndex', () => {
    it('parses name, decoded path, source, rig and form', () => {
        const entries = parseAutoEqIndex(INDEX);
        expect(entries).toHaveLength(5);
        expect(entries[0]).toEqual({ name: '1Custom SA02', path: 'crinacle/711 in-ear/1Custom SA02', source: 'crinacle', rig: '711', form: 'in-ear' });
        expect(entries[1]).toEqual({ name: 'Sennheiser HD 650', path: 'oratory1990/over-ear/Sennheiser HD 650', source: 'oratory1990', rig: null, form: 'over-ear' });
        expect(entries[3].path).toBe('Rtings/over-ear/Sony WH-1000XM4 (ANC on)');
    });

    it('builds the raw ParametricEQ.txt URL with encoded segments', () => {
        const [, hd650, , sony] = parseAutoEqIndex(INDEX);
        expect(profileUrl(hd650)).toBe('https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sennheiser%20HD%20650/Sennheiser%20HD%20650%20ParametricEQ.txt');
        expect(profileUrl(sony)).toContain('/Rtings/over-ear/Sony%20WH-1000XM4%20(ANC%20on)/Sony%20WH-1000XM4%20(ANC%20on)%20ParametricEQ.txt');
        expect(entryLabel(hd650)).toBe('oratory1990 · over-ear');
        expect(entryLabel(parseAutoEqIndex(INDEX)[0])).toBe('crinacle · 711 · in-ear');
    });
});

describe('searchAutoEqIndex', () => {
    const entries = parseAutoEqIndex(INDEX);

    it('matches every token case-insensitively and ranks name prefixes first', () => {
        const hits = searchAutoEqIndex(entries, 'hd 650');
        expect(hits.map(e => e.source)).toEqual(['oratory1990', 'Innerfidelity']);
        expect(searchAutoEqIndex(entries, 'SENNHEISER')[0].name).toBe('Sennheiser HD 650');
        expect(searchAutoEqIndex(entries, 'xm4 anc')).toHaveLength(1);
    });

    it('returns nothing for an empty query and respects the limit', () => {
        expect(searchAutoEqIndex(entries, '   ')).toEqual([]);
        expect(searchAutoEqIndex(entries, 'a', 2)).toHaveLength(2);
    });
});
