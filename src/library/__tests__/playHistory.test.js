import { describe, expect, it } from 'vitest';
import { ListenTimer, MAX_PLAY_HISTORY, appendPlay, backfillTrackKeys, setListened } from '../playHistory.js';

describe('appendPlay', () => {
    it('appends an entry with path, timestamp and trackKey', () => {
        const { stats, entry } = appendPlay({ totalTime: 5, playHistory: [] }, { path: '/a.flac', trackKey: 'mb:x' }, 1000);
        expect(entry).toEqual({ path: '/a.flac', timestamp: 1000, trackKey: 'mb:x' });
        expect(stats.playHistory).toEqual([entry]);
        expect(stats.totalTime).toBe(5);
    });

    it('tolerates songs without a trackKey and stats without history', () => {
        const { stats, entry } = appendPlay({}, { path: '/a.flac' }, 1);
        expect(entry).toEqual({ path: '/a.flac', timestamp: 1 });
        expect(stats.playHistory).toHaveLength(1);
    });

    it('records the path but not the trackKey of a provisional song', () => {
        const { entry } = appendPlay({}, { path: '/a.flac', trackKey: 'meta:a|b|1|1|t', provisional: true }, 1);
        expect(entry).toEqual({ path: '/a.flac', timestamp: 1 });
        expect(appendPlay({}, { path: '/a.flac', trackKey: 'mb:x', provisional: false }, 1).entry.trackKey).toBe('mb:x');
    });

    it('folds the oldest entries into archivedCounts when the history is full', () => {
        const playHistory = Array.from({ length: MAX_PLAY_HISTORY }, (_, i) => ({ path: i === 0 ? '/old.flac' : '/x.flac', timestamp: i }));
        const { stats } = appendPlay({ playHistory }, { path: '/new.flac' }, 999999);
        expect(stats.playHistory).toHaveLength(MAX_PLAY_HISTORY);
        expect(stats.playHistory[stats.playHistory.length - 1].path).toBe('/new.flac');
        expect(stats.archivedCounts).toEqual({ '/old.flac': 1 });
        expect(stats.archivedCount).toBe(1);
    });
});

describe('setListened', () => {
    const stats = { playHistory: [{ path: '/a.flac', timestamp: 1 }, { path: '/b.flac', timestamp: 2 }] };

    it('writes rounded seconds on the matching entry only', () => {
        const next = setListened(stats, { path: '/a.flac', timestamp: 1 }, 12.6);
        expect(next.playHistory[0]).toEqual({ path: '/a.flac', timestamp: 1, listened: 13 });
        expect(next.playHistory[1]).toBe(stats.playHistory[1]);
        expect(stats.playHistory[0].listened).toBeUndefined();
    });

    it('returns the same object when nothing changes or the entry is gone', () => {
        expect(setListened(stats, null, 5)).toBe(stats);
        expect(setListened(stats, { path: '/gone.flac', timestamp: 9 }, 5)).toBe(stats);
        const once = setListened(stats, { path: '/b.flac', timestamp: 2 }, 3);
        expect(setListened(once, { path: '/b.flac', timestamp: 2 }, 3.2)).toBe(once);
    });

    it('never stores negative values', () => {
        expect(setListened(stats, { path: '/b.flac', timestamp: 2 }, -4).playHistory[1].listened).toBe(0);
    });
});

describe('backfillTrackKeys', () => {
    const stats = {
        totalTime: 3,
        playHistory: [
            { path: '/a.flac', timestamp: 1 },
            { path: '/b.flac', timestamp: 2, trackKey: 'mb:old' },
            { path: '/c.flac', timestamp: 3 },
            { path: '/a.flac', timestamp: 4, listened: 10 }
        ]
    };

    it('fills missing keys by path from songs that are no longer provisional', () => {
        const songs = [
            { path: '/a.flac', trackKey: 'mb:a', provisional: false },
            { path: '/b.flac', trackKey: 'mb:b', provisional: false },
            { path: '/c.flac', trackKey: 'meta:c', provisional: true }
        ];
        const next = backfillTrackKeys(stats, songs);
        expect(next).not.toBe(stats);
        expect(next.totalTime).toBe(3);
        expect(next.playHistory).toEqual([
            { path: '/a.flac', timestamp: 1, trackKey: 'mb:a' },
            { path: '/b.flac', timestamp: 2, trackKey: 'mb:old' },
            { path: '/c.flac', timestamp: 3 },
            { path: '/a.flac', timestamp: 4, listened: 10, trackKey: 'mb:a' }
        ]);
        expect(stats.playHistory[0].trackKey).toBeUndefined();
    });

    it('returns the same object when there is nothing to fill', () => {
        expect(backfillTrackKeys(stats, [])).toBe(stats);
        expect(backfillTrackKeys(stats, [{ path: '/zzz.flac', trackKey: 'mb:z' }])).toBe(stats);
        expect(backfillTrackKeys(stats, [{ path: '/a.flac', trackKey: 'mb:a', provisional: true }])).toBe(stats);
        const full = { playHistory: [{ path: '/a.flac', timestamp: 1, trackKey: 'mb:a' }] };
        expect(backfillTrackKeys(full, [{ path: '/a.flac', trackKey: 'mb:new' }])).toBe(full);
        expect(backfillTrackKeys({}, [{ path: '/a.flac', trackKey: 'mb:a' }])).toEqual({});
        expect(backfillTrackKeys(null, [])).toBeNull();
    });
});

describe('ListenTimer', () => {
    it('accumulates only while started', () => {
        let now = 0;
        const timer = new ListenTimer(() => now);
        timer.start(); now = 1500;
        expect(timer.seconds()).toBe(1.5);
        timer.stop(); now = 5000;
        expect(timer.seconds()).toBe(1.5);
        timer.start(); now = 5500; timer.stop();
        expect(timer.seconds()).toBe(2);
        timer.reset();
        expect(timer.seconds()).toBe(0);
    });

    it('ignores repeated start / stop calls', () => {
        let now = 0;
        const timer = new ListenTimer(() => now);
        timer.start(); timer.start(); now = 1000;
        timer.stop(); timer.stop();
        expect(timer.seconds()).toBe(1);
    });
});
