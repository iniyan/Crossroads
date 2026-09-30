// Local time matters for every boundary here; pin a zone with DST so the tests are
// deterministic on any machine (Node re-reads TZ when it changes).
process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import { periodOf, shiftPeriod, availablePeriods, computeWrapped, isoWeek, longestStreak, dayKey, formatHours, weekdayIndex } from '../wrapped.js';

const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const song = (overrides) => ({
    path: '/m/a.flac', trackKey: 'mb:a', title: 'A', artist: 'Artist A', album: 'Album A', albumArtist: '', composer: '',
    format: 'FLAC', duration: 300, quality: { tier: 'cd', label: 'FLAC 16/44.1' }, picture: null, ...overrides
});

describe('periods', () => {
    it('week is ISO Monday..Sunday in local time', () => {
        // Wednesday 2026-09-30
        const week = periodOf('week', local(2026, 9, 30));
        expect(week.start.toString()).toContain('Mon Sep 28 2026 00:00:00');
        expect(week.end.toString()).toContain('Mon Oct 05 2026 00:00:00');
        expect(week.key).toBe('2026-W40');
        expect(week.label).toBe('Week 40, 2026');
        // Sunday belongs to the week that began the previous Monday; Monday 00:00 starts a new one
        expect(periodOf('week', local(2026, 10, 4, 23, 59)).key).toBe('2026-W40');
        expect(periodOf('week', new Date(2026, 9, 5, 0, 0)).key).toBe('2026-W41');
    });

    it('handles ISO week-year edges', () => {
        expect(isoWeek(new Date(2021, 0, 1))).toEqual({ year: 2020, week: 53 });   // Fri 1 Jan 2021 -> W53 of 2020
        expect(isoWeek(new Date(2024, 11, 30))).toEqual({ year: 2025, week: 1 });  // Mon 30 Dec 2024 -> W01 of 2025
        expect(periodOf('week', local(2024, 12, 31)).key).toBe('2025-W01');
    });

    it('week and month boundaries stay on local midnight across a DST change', () => {
        // Europe/Berlin springs forward on Sun 29 Mar 2026 (02:00 -> 03:00): the week is 167 h long
        const week = periodOf('week', local(2026, 3, 25));
        expect(week.start.getHours()).toBe(0);
        expect(week.end.getHours()).toBe(0);
        expect((week.end - week.start) / 3600000).toBe(167);
        const march = periodOf('month', local(2026, 3, 25));
        expect(march.end.toString()).toContain('Wed Apr 01 2026 00:00:00');
        // and the fall-back week (Sun 25 Oct 2026) is 169 h
        const autumn = periodOf('week', local(2026, 10, 21));
        expect((autumn.end - autumn.start) / 3600000).toBe(169);
    });

    it('month and year periods', () => {
        const month = periodOf('month', local(2026, 2, 10));
        expect(month.key).toBe('2026-02');
        expect(month.label).toBe('February 2026');
        expect(month.end.toString()).toContain('Sun Mar 01 2026');
        const year = periodOf('year', local(2026, 6, 1));
        expect(year.key).toBe('2026');
        expect(year.end.getFullYear()).toBe(2027);
    });

    it('shiftPeriod walks backwards and forwards, including across year ends', () => {
        expect(shiftPeriod(periodOf('month', local(2026, 1, 15)), -1).key).toBe('2025-12');
        expect(shiftPeriod(periodOf('week', local(2026, 1, 1)), -1).key).toBe('2025-W52');
        expect(shiftPeriod(periodOf('year', local(2026, 1, 1)), 1).key).toBe('2027');
        expect(shiftPeriod(periodOf('week', local(2026, 3, 25)), 1).start.getHours()).toBe(0);
    });

    it('availablePeriods lists from now back to the oldest play, current period always present', () => {
        const now = local(2026, 9, 30);
        expect(availablePeriods([], 'week', { now }).map(p => p.key)).toEqual(['2026-W40']);
        const history = [{ path: '/x', timestamp: local(2026, 7, 3) }];
        const months = availablePeriods(history, 'month', { now });
        expect(months.map(p => p.key)).toEqual(['2026-09', '2026-08', '2026-07']);
        expect(availablePeriods(history, 'week', { now, limit: 3 })).toHaveLength(3);
    });
});

describe('longestStreak', () => {
    it('finds consecutive local days, across month ends and DST', () => {
        expect(longestStreak(new Set())).toEqual({ days: 0, start: null, end: null });
        expect(longestStreak(new Set(['2026-03-28', '2026-03-29', '2026-03-30', '2026-04-02']))).toEqual({ days: 3, start: '2026-03-28', end: '2026-03-30' });
        expect(longestStreak(new Set(['2026-01-31', '2026-02-01', '2026-02-05', '2026-02-06', '2026-02-07']))).toEqual({ days: 3, start: '2026-02-05', end: '2026-02-07' });
        expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
        expect(weekdayIndex(new Date(2026, 8, 28))).toBe(0);   // Monday
        expect(weekdayIndex(new Date(2026, 9, 4))).toBe(6);    // Sunday
    });
});

describe('computeWrapped', () => {
    const songs = [
        song(),
        song({ path: '/m/b.flac', trackKey: 'mb:b', title: 'B', artist: 'Artist B', album: 'Album B', composer: 'Bach', format: 'FLAC', duration: 600, quality: { tier: 'hires', label: 'FLAC 24/96' } }),
        song({ path: '/m/c.mp3', trackKey: 'meta:c', title: 'C', artist: 'Artist A', album: 'Album A', format: 'MP3', duration: 200, quality: { tier: 'lossy', label: 'MP3 320' } })
    ];
    const period = periodOf('week', local(2026, 9, 30));   // Mon 28 Sep .. Sun 4 Oct 2026

    it('returns an empty recap for a period without plays', () => {
        const recap = computeWrapped({ stats: { playHistory: [] }, songs, period });
        expect(recap.plays).toBe(0);
        expect(recap.totalSeconds).toBe(0);
        expect(recap.topTracks.byPlays).toEqual([]);
        expect(recap.longestStreak.days).toBe(0);
        expect(recap.topFormat).toBeNull();
    });

    it('sums listened seconds, tiers, top lists, formats, hour/weekday and streaks inside the period only', () => {
        const history = [
            { path: '/m/a.flac', trackKey: 'mb:a', timestamp: local(2026, 9, 27, 23), listened: 999 },     // Sunday before: excluded
            { path: '/m/a.flac', trackKey: 'mb:a', timestamp: local(2026, 9, 28, 8), listened: 300 },      // Mon
            { path: '/m/a.flac', trackKey: 'mb:a', timestamp: local(2026, 9, 29, 8), listened: 250 },      // Tue
            { path: '/m/b.flac', trackKey: 'mb:b', timestamp: local(2026, 9, 29, 21), listened: 600 },     // Tue
            { path: '/m/c.mp3', trackKey: 'meta:c', timestamp: local(2026, 10, 2, 8), listened: 100 },     // Fri
            { path: '/m/b.flac', trackKey: 'mb:b', timestamp: local(2026, 10, 5, 0, 0), listened: 500 }    // next Monday 00:00: excluded
        ];
        const recap = computeWrapped({ stats: { playHistory: history }, songs, period });
        expect(recap.plays).toBe(4);
        expect(recap.totalSeconds).toBe(1250);
        expect(recap.estimated).toBe(false);
        expect(recap.byTier).toEqual({ hires: 600, cd: 550, lossy: 100, unknown: 0 });
        expect(recap.topTracks.byPlays[0]).toMatchObject({ title: 'A', plays: 2, seconds: 550 });
        expect(recap.topTracks.byTime[0]).toMatchObject({ title: 'B', plays: 1, seconds: 600 });
        expect(recap.topArtists.byPlays[0]).toMatchObject({ name: 'Artist A', plays: 3, tracks: 2 });
        expect(recap.topAlbums.byTime[0]).toMatchObject({ name: 'Album A', artist: 'Artist A', seconds: 650, tracks: 2 });
        expect(recap.topAlbums.byTime[1]).toMatchObject({ name: 'Album B', artist: 'Artist B', seconds: 600 });
        expect(recap.topComposers.byPlays).toEqual([expect.objectContaining({ name: 'Bach', plays: 1, seconds: 600 })]);
        expect(recap.topFormat).toMatchObject({ name: 'FLAC', plays: 3, seconds: 1150 });
        expect(recap.byHour[8]).toBe(650);
        expect(recap.byHour[21]).toBe(600);
        expect(recap.byWeekday).toEqual([300, 850, 0, 0, 100, 0, 0]);
        expect(recap.activeDays).toBe(3);
        expect(recap.longestStreak).toEqual({ days: 2, start: '2026-09-28', end: '2026-09-29' });
        expect(recap.peakHour).toBe(8);
        expect(recap.peakWeekday).toBe(1);
        expect(recap.uniqueTracks).toBe(3);
    });

    it('estimates legacy entries from the song duration and flags it', () => {
        const history = [
            { path: '/m/a.flac', timestamp: local(2026, 9, 28) },                  // no trackKey, no listened
            { path: '/m/gone.flac', timestamp: local(2026, 9, 28) },               // not in the library any more
            { path: '/m/b.flac', trackKey: 'mb:b', timestamp: local(2026, 9, 29), listened: 42 }
        ];
        const recap = computeWrapped({ stats: { playHistory: history }, songs, period });
        expect(recap.estimated).toBe(true);
        expect(recap.estimatedPlays).toBe(2);
        expect(recap.estimatedSeconds).toBe(300);
        expect(recap.totalSeconds).toBe(342);
        const gone = recap.topTracks.byPlays.find(t => t.missing);
        expect(gone).toMatchObject({ title: 'gone', artist: 'Unknown Artist', tier: 'unknown', format: 'FLAC', plays: 1, seconds: 0 });
        expect(recap.byTier.unknown).toBe(0);
        // the legacy path-only entry still resolved the song (by path) and counts towards its trackKey
        expect(recap.topTracks.byPlays.find(t => t.title === 'A')).toMatchObject({ estimated: true, seconds: 300 });
    });

    it('merges plays keyed by trackKey and by path for the same song', () => {
        const history = [
            { path: '/old/location/a.flac', trackKey: 'mb:a', timestamp: local(2026, 9, 28), listened: 10 },
            { path: '/m/a.flac', timestamp: local(2026, 9, 28), listened: 20 }
        ];
        const recap = computeWrapped({ stats: { playHistory: history }, songs, period });
        expect(recap.uniqueTracks).toBe(2);   // keys differ ('mb:a' vs '/m/a.flac'), both resolve to song A
        expect(recap.topTracks.byPlays.every(t => t.title === 'A')).toBe(true);
    });

    it('discoveries are first-ever plays inside the period (history and archive aware)', () => {
        const history = [
            { path: '/m/a.flac', trackKey: 'mb:a', timestamp: local(2026, 1, 1), listened: 1 },       // A known before
            { path: '/m/a.flac', trackKey: 'mb:a', timestamp: local(2026, 9, 28), listened: 1 },
            { path: '/m/b.flac', trackKey: 'mb:b', timestamp: local(2026, 9, 29), listened: 1 },      // B: new
            { path: '/m/b.flac', trackKey: 'mb:b', timestamp: local(2026, 9, 30), listened: 1 },
            { path: '/m/c.mp3', trackKey: 'meta:c', timestamp: local(2026, 10, 1), listened: 1 }      // C: archived before
        ];
        const recap = computeWrapped({ stats: { playHistory: history, archivedCounts: { '/m/c.mp3': 3 } }, songs, period });
        expect(recap.discoveries.map(d => d.title)).toEqual(['B']);
        expect(recap.discoveryCount).toBe(1);
        expect(recap.discoveries[0]).toMatchObject({ plays: 2, firstPlayed: local(2026, 9, 29) });
    });

    it('formatHours', () => {
        expect(formatHours(0)).toBe('0 s');
        expect(formatHours(90)).toBe('2 min');
        expect(formatHours(5400)).toBe('1.5 h');
        expect(formatHours(40000)).toBe('11 h');
    });
});
