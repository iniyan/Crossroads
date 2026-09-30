import { describe, expect, it } from 'vitest';
import {
    buildClassicalIndex, classicalInfo, hasClassicalMusic, isClassicalTagged, parsePerformer, parseRoman,
    parseWorkTitle, performersLine, sortMovements, trackDisplayTitle
} from '../classical.js';

const song = (over = {}) => ({ path: `/m/${Math.random()}.flac`, title: 'T', album: 'A', artist: 'X', composer: '', tags: {}, ...over });

describe('parsers', () => {
    it('parses roman numerals', () => {
        expect(parseRoman('IV')).toBe(4);
        expect(parseRoman('xiv')).toBe(14);
        expect(parseRoman('Allegro')).toBeNull();
    });
    it('parses performers with roles', () => {
        expect(parsePerformer('Martha Argerich (piano)')).toEqual({ name: 'Martha Argerich', role: 'piano' });
        expect(parsePerformer('Solo Person')).toEqual({ name: 'Solo Person', role: '' });
    });
    it('parses work titles conservatively', () => {
        expect(parseWorkTitle('Symphony No. 5: I. Allegro con brio')).toEqual({ work: 'Symphony No. 5', movementName: 'Allegro con brio', movementNumber: 1 });
        expect(parseWorkTitle('Piano Sonata No. 14 - II. Adagio')).toEqual({ work: 'Piano Sonata No. 14', movementName: 'Adagio', movementNumber: 2 });
        expect(parseWorkTitle('Hello - World')).toBeNull();
        expect(parseWorkTitle('Plain title')).toBeNull();
    });
});

describe('classicalInfo', () => {
    it('reads tags', () => {
        const info = classicalInfo(song({ composer: 'Beethoven', tags: {
            WORK: ['Symphony 5'], MOVEMENTNAME: ['Allegro'], MOVEMENT: ['2/4'], CONDUCTOR: ['Kleiber'],
            ORCHESTRA: ['Wiener Philharmoniker'], PERFORMER: ['A B (violin)']
        } }));
        expect(info).toMatchObject({ work: 'Symphony 5', movementNumber: 2, movementTotal: 4, conductor: 'Kleiber', ensemble: 'Wiener Philharmoniker', hasWork: true });
        expect(info.performers).toEqual([{ name: 'A B', role: 'violin' }]);
    });
    it('reads roman MOVEMENT and MOVEMENTTOTAL', () => {
        const info = classicalInfo(song({ tags: { MOVEMENT: ['III'], MOVEMENTTOTAL: ['4'] } }));
        expect(info.movementNumber).toBe(3);
        expect(info.movementTotal).toBe(4);
    });
    it('is empty for plain songs', () => {
        expect(classicalInfo(song()).hasClassical).toBe(false);
        expect(classicalInfo(null).hasClassical).toBe(false);
    });
});

describe('display helpers', () => {
    it('builds Work — Movement only when both exist', () => {
        expect(trackDisplayTitle(song({ title: 'raw', tags: { WORK: ['W'], MOVEMENTNAME: ['M'] } }))).toBe('W \u2014 M');
        expect(trackDisplayTitle(song({ title: 'raw', tags: { WORK: ['W'] } }))).toBe('raw');
    });
    it('builds the performers line', () => {
        const s = song({ tags: { CONDUCTOR: ['C'], ENSEMBLE: ['E'], PERFORMER: ['P (oboe)', 'P (oboe)'] } });
        expect(performersLine(s)).toBe('C \u00B7 E \u00B7 P (oboe)');
        expect(performersLine(song())).toBe('');
    });
    it('detects classical songs, not plain composer credits', () => {
        expect(isClassicalTagged(song({ composer: 'Writer' }))).toBe(false);
        expect(isClassicalTagged(song({ tags: { WORK: ['W'] } }))).toBe(true);
        expect(isClassicalTagged(song({ tags: { MOVEMENTNAME: ['M'] } }))).toBe(true);
        expect(isClassicalTagged(song({ genre: 'Baroque Era' }))).toBe(true);
        expect(isClassicalTagged(song({ tags: { GENRE: ['Opera'] } }))).toBe(true);
        expect(isClassicalTagged(song({ genre: 'Pop' }))).toBe(false);
        const pop = song({ composer: 'Songwriter', genre: 'Pop' });
        expect(hasClassicalMusic([song(), pop])).toBe(false);
        expect(hasClassicalMusic([pop, song({ composer: 'Bach', genre: 'Classical' })])).toBe(true);
    });
});

describe('sortMovements', () => {
    it('orders by movement number across mixed track numbering', () => {
        const a = song({ title: 'a', trackNumber: 9, tags: { MOVEMENT: ['1'] } });
        const b = song({ title: 'b', trackNumber: 1, tags: { MOVEMENT: ['3'] } });
        const c = song({ title: 'c', trackNumber: 5, tags: { MOVEMENT: ['2'] } });
        expect(sortMovements([b, a, c]).map(s => s.title)).toEqual(['a', 'c', 'b']);
    });
    it('falls back to disc/track when a movement number is missing', () => {
        const a = song({ title: 'a', discNumber: 2, trackNumber: 1, tags: { MOVEMENT: ['1'] } });
        const b = song({ title: 'b', discNumber: 1, trackNumber: 2 });
        const c = song({ title: 'c', discNumber: 1, trackNumber: 1, tags: { MOVEMENT: ['9'] } });
        expect(sortMovements([a, b, c]).map(s => s.title)).toEqual(['c', 'b', 'a']);
    });
});

describe('buildClassicalIndex', () => {
    const mk = (title, n, extra = {}) => song({
        title, album: 'Sym 5', composer: 'Beethoven', trackNumber: n,
        tags: { WORK: ['Symphony No. 5'], MOVEMENTNAME: [title], MOVEMENT: [String(n)], CONDUCTOR: ['Kleiber'], ...(extra.tags || {}) }, ...extra, ...(extra.tags ? { tags: { WORK: ['Symphony No. 5'], MOVEMENTNAME: [title], MOVEMENT: [String(n)], ...extra.tags } } : {})
    });

    it('groups composer -> work -> recording in movement order', () => {
        const idx = buildClassicalIndex([mk('Andante', 2), mk('Allegro', 1), song({ title: 'Pop', composer: '' })]);
        expect(idx).toHaveLength(1);
        expect(idx[0].name).toBe('Beethoven');
        const work = idx[0].works[0];
        expect(work.title).toBe('Symphony No. 5');
        expect(work.recordings).toHaveLength(1);
        expect(work.recordings[0].movements.map(m => m.name)).toEqual(['Allegro', 'Andante']);
        expect(work.recordings[0].conductor).toBe('Kleiber');
    });

    it('splits recordings by album and conductor', () => {
        const idx = buildClassicalIndex([
            mk('Allegro', 1),
            mk('Allegro', 1, { album: 'Other', tags: { CONDUCTOR: ['Bernstein'] } })
        ]);
        expect(idx[0].works[0].recordings).toHaveLength(2);
    });

    it('merges composer/work spellings and ignores diacritics and case', () => {
        const idx = buildClassicalIndex([
            mk('Allegro', 1, { composer: 'Dvořák', tags: { WORK: ['Symphony No. 9'] } }),
            mk('Largo', 2, { composer: 'Dvorak', tags: { WORK: ['symphony no 9'] } })
        ]);
        expect(idx).toHaveLength(1);
        expect(idx[0].works).toHaveLength(1);
    });

    it('derives works from titles only when corroborated', () => {
        const t = (title, n) => song({ title, album: 'Sonatas', composer: 'Mozart', trackNumber: n });
        const idx = buildClassicalIndex([
            t('Piano Sonata No. 11: I. Andante', 1), t('Piano Sonata No. 11: III. Rondo', 2),
            { ...t('Lonely: Title', 3), genre: 'Classical' }
        ]);
        const titles = idx[0].works.map(w => w.title);
        expect(titles).toContain('Piano Sonata No. 11');
        expect(titles).toContain('Lonely: Title');
        const w = idx[0].works.find(x => x.title === 'Piano Sonata No. 11');
        expect(w.recordings[0].movements.map(m => m.name)).toEqual(['Andante', 'Rondo']);
    });

    it('skips pop songs with only a composer credit, keeps genre-classical ones', () => {
        const pop = song({ composer: 'Songwriter', genre: 'Pop', title: 'Hit' });
        const cl = song({ composer: 'Bach', genre: 'Classical', title: 'Air' });
        const idx = buildClassicalIndex([pop, cl]);
        expect(idx.map(c => c.name)).toEqual(['Bach']);
    });

    it('skips songs without a composer', () => {
        expect(buildClassicalIndex([song()])).toEqual([]);
    });
});
