import { describe, expect, it } from 'vitest';
import { albumMatchesFilter, albumQuality, describeTierCounts, matchesQualityFilter, normalizeFilters, tierCounts } from '../qualityGroups.js';

const q = (tier, label, lossless = tier !== 'lossy') => ({ quality: { tier, label }, lossless });

describe('albumQuality', () => {
    it('uses the lowest tier and flags mixed', () => {
        const r = albumQuality([q('hires', 'FLAC 24/96'), q('cd', 'FLAC 16/44.1')]);
        expect(r).toMatchObject({ tier: 'cd', mixed: true, label: 'FLAC 16/44.1', breakdown: '1 Hi-Res \u00B7 1 CD' });
    });
    it('keeps a shared label, else the tier name', () => {
        expect(albumQuality([q('hires', 'FLAC 24/96'), q('hires', 'FLAC 24/96')])).toMatchObject({ label: 'FLAC 24/96', mixed: false });
        expect(albumQuality([q('hires', 'FLAC 24/96'), q('hires', 'FLAC 24/192')]).label).toBe('Hi-Res');
    });
    it('ignores unknown tracks and handles all-unknown', () => {
        expect(albumQuality([q('unknown', ''), q('cd', 'FLAC 16/44.1')])).toMatchObject({ tier: 'cd', mixed: false, unknown: 1 });
        expect(albumQuality([q('unknown', '')])).toMatchObject({ tier: 'unknown', label: '' });
        expect(albumQuality([])).toMatchObject({ tier: 'unknown' });
    });
});

describe('filters', () => {
    it('matches tier and lossless-only', () => {
        expect(matchesQualityFilter(q('cd', 'x'), { tier: 'hires' })).toBe(false);
        expect(matchesQualityFilter(q('lossy', 'x'), { tier: 'all', losslessOnly: true })).toBe(false);
        expect(matchesQualityFilter(q('cd', 'x'), { tier: 'cd', losslessOnly: true })).toBe(true);
        expect(matchesQualityFilter({}, { tier: 'all' })).toBe(true);
        expect(matchesQualityFilter({}, { tier: 'cd' })).toBe(false);
    });
    it('matches albums by their album tier (lowest known), like the badge', () => {
        const mixed = [q('cd', 'x'), q('hires', 'y')];
        expect(albumMatchesFilter(mixed, { tier: 'hires' })).toBe(false);
        expect(albumMatchesFilter(mixed, { tier: 'cd' })).toBe(true);
        expect(albumMatchesFilter([q('hires', 'y'), q('unknown', '')], { tier: 'hires' })).toBe(true);
        expect(albumMatchesFilter([q('unknown', '')], { tier: 'hires' })).toBe(false);
        expect(albumMatchesFilter([q('unknown', '')], { tier: 'all' })).toBe(true);
    });
    it('lossless only needs every known track lossless', () => {
        const lf = { tier: 'all', losslessOnly: true };
        expect(albumMatchesFilter([q('cd', 'x'), q('lossy', 'y')], lf)).toBe(false);
        expect(albumMatchesFilter([q('cd', 'x'), q('hires', 'y'), q('unknown', '')], lf)).toBe(true);
        expect(albumMatchesFilter([q('unknown', '')], lf)).toBe(false);
    });
    it('sanitizes persisted values', () => {
        expect(normalizeFilters({ tier: 'bogus', losslessOnly: 'yes' })).toEqual({ tier: 'all', losslessOnly: false });
        expect(normalizeFilters(null)).toEqual({ tier: 'all', losslessOnly: false });
    });
});

describe('counts', () => {
    it('counts and describes tiers', () => {
        const c = tierCounts([q('hires', ''), q('hires', ''), q('cd', ''), {}]);
        expect(c).toEqual({ hires: 2, cd: 1, lossy: 0, unknown: 1 });
        expect(describeTierCounts(c)).toBe('2 Hi-Res \u00B7 1 CD');
    });
});
