import { describe, expect, it } from 'vitest';
import { MAX_PLAY_HISTORY } from '../../library/playHistory.js';
import {
    LIMITS, SyncLimitError, applyDelta, applyFavoriteOps, applyPlaylistOps, applyPlaysToStats, applyToLocal, buildDelta, captureLocal,
    clientReceive, clientRequest, countUnmatched, createStore, emptyState, exportState, mergeStates, parseHistoryKey, serverExchange
} from '../model.js';

// ---- helpers ---------------------------------------------------------------------------------

const song = (n, device = 'x', extra = {}) => ({ path: `/${device}/track${n}.flac`, trackKey: `meta:artist|album||${n}|track ${n}`, ...extra });
const library = (device, count = 10) => Array.from({ length: count }, (_, i) => song(i + 1, device));
const keyOf = (n) => `meta:artist|album||${n}|track ${n}`;
const pathOf = (device, n) => `/${device}/track${n}.flac`;

const emptyLocal = (device, count = 10) => ({ songs: library(device, count), favorites: [], playlists: [], stats: { totalTime: 0, playHistory: [] } });

// Seeded PRNG for the property-style tests (mulberry32).
const rng = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomState = (rand, deviceId) => {
    const state = emptyState();
    const n = Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) {
        state.favorites[keyOf(1 + Math.floor(rand() * 6))] = { on: rand() < 0.6, t: { w: 1000 + Math.floor(rand() * 5), c: Math.floor(rand() * 3), d: deviceId } };
    }
    const p = Math.floor(rand() * 4);
    for (let i = 0; i < p; i++) {
        const id = `pl-${1 + Math.floor(rand() * 3)}`;
        const tracks = Array.from({ length: Math.floor(rand() * 4) }, () => keyOf(1 + Math.floor(rand() * 6)));
        const item = { name: `name-${Math.floor(rand() * 3)}`, tracks: [...new Set(tracks)], t: { w: 1000 + Math.floor(rand() * 5), c: Math.floor(rand() * 3), d: deviceId } };
        if (rand() < 0.2) item.deleted = true;
        state.playlists[id] = item;
    }
    const h = Math.floor(rand() * 8);
    for (let i = 0; i < h; i++) {
        const k = keyOf(1 + Math.floor(rand() * 6));
        const ts = 1000 + Math.floor(rand() * 5);
        const item = {};
        if (rand() < 0.5) item.l = Math.floor(rand() * 100);
        state.history[`${k}@${ts}`] = item;
    }
    return state;
};

const sortKeys = (obj) => JSON.parse(JSON.stringify(obj, (key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value));

// ---- capture -----------------------------------------------------------------------------------

describe('captureLocal', () => {
    it('stamps new favorites, playlists and plays with HLC and revisions', () => {
        const local = {
            ...emptyLocal('d'),
            favorites: [pathOf('d', 1), pathOf('d', 2)],
            playlists: [{ id: 'pl-1', name: 'Mix', songs: [pathOf('d', 2), pathOf('d', 3)] }],
            stats: { playHistory: [{ path: pathOf('d', 1), timestamp: 500, trackKey: keyOf(1), listened: 12 }, { path: pathOf('d', 4), timestamp: 600 }] }
        };
        const { store, changed } = captureLocal(createStore('d'), local, 10_000);
        expect(changed).toBe(5);
        expect(store.state.favorites[keyOf(1)]).toMatchObject({ on: true, t: { w: 10_000, c: 0, d: 'd' }, _r: 1 });
        expect(store.state.favorites[keyOf(2)]).toMatchObject({ on: true, t: { w: 10_000, c: 1, d: 'd' }, _r: 2 });
        expect(store.state.playlists['pl-1']).toMatchObject({ name: 'Mix', tracks: [keyOf(2), keyOf(3)], _r: 3 });
        expect(store.state.history[`${keyOf(1)}@500`]).toEqual({ l: 12, _r: 4, _a: 1 });
        // the entry without trackKey syncs because its path maps to a key in the library; the
        // key carries track and timestamp, the value repeats neither
        expect(store.state.history[`${keyOf(4)}@600`]).toEqual({ _r: 5, _a: 1 });
        expect(parseHistoryKey(`${keyOf(4)}@600`)).toEqual({ k: keyOf(4), ts: 600 });
        expect(store.rev).toBe(5);
        expect(store.snapshot.favorites).toEqual([keyOf(1), keyOf(2)]);
        expect(store.snapshot.keys[pathOf('d', 3)]).toBe(keyOf(3));
        // a second capture of the same state changes nothing
        const again = captureLocal(store, local, 10_001);
        expect(again.changed).toBe(0);
        expect(again.store.rev).toBe(5);
    });

    it('turns removals into tombstones only for tracks the library still has', () => {
        const local = { ...emptyLocal('d'), favorites: [pathOf('d', 1), pathOf('d', 2)] };
        let { store } = captureLocal(createStore('d'), local, 1000);
        // track 1 unfavorited, track 2's file is gone from the library
        const later = { ...local, favorites: [], songs: local.songs.filter(s => s.path !== pathOf('d', 2)) };
        ({ store } = captureLocal(store, later, 2000));
        expect(store.state.favorites[keyOf(1)]).toMatchObject({ on: false, t: { w: 2000 } });
        expect(store.state.favorites[keyOf(2)]).toMatchObject({ on: true });
    });

    it('does not emit anything while the library is empty or provisional', () => {
        const provisional = library('d').map(s => ({ ...s, provisional: true }));
        const local = { songs: provisional, favorites: [pathOf('d', 1)], playlists: [{ id: 'pl-1', name: 'A', songs: [pathOf('d', 1)] }], stats: { playHistory: [{ path: pathOf('d', 1), timestamp: 5 }] } };
        const { store, changed } = captureLocal(createStore('d'), local, 1000);
        // the playlist itself is new (name), but carries no tracks; nothing else is keyed
        expect(changed).toBe(1);
        expect(store.state.playlists['pl-1'].tracks).toEqual([]);
        expect(Object.keys(store.state.favorites)).toEqual([]);
        expect(Object.keys(store.state.history)).toEqual([]);
    });

    it('remembers keys so a deleted file does not look like a playlist edit', () => {
        const local = { ...emptyLocal('d'), playlists: [{ id: 'pl-1', name: 'A', songs: [pathOf('d', 1), pathOf('d', 2)] }] };
        let { store } = captureLocal(createStore('d'), local, 1000);
        const shrunk = { ...local, songs: local.songs.filter(s => s.path !== pathOf('d', 2)) };
        const second = captureLocal(store, shrunk, 2000);
        expect(second.changed).toBe(0);
    });

    it('tombstones a deleted playlist and records renames / reorders', () => {
        const local = { ...emptyLocal('d'), playlists: [{ id: 'pl-1', name: 'A', songs: [pathOf('d', 1), pathOf('d', 2)] }, { id: 'pl-2', name: 'B', songs: [] }] };
        let { store } = captureLocal(createStore('d'), local, 1000);
        const edited = { ...local, playlists: [{ id: 'pl-1', name: 'A2', songs: [pathOf('d', 2), pathOf('d', 1)] }] };
        ({ store } = captureLocal(store, edited, 2000));
        expect(store.state.playlists['pl-1']).toMatchObject({ name: 'A2', tracks: [keyOf(2), keyOf(1)] });
        expect(store.state.playlists['pl-2']).toMatchObject({ deleted: true, name: 'B', tracks: [] });
        expect(store.snapshot.playlists['pl-2']).toBeUndefined();
    });

    it('keeps unmatched tracks in place when the playlist is edited locally', () => {
        // Synced playlist has tracks 1, 9(unmatched), 2, 8(unmatched); library only has 1..5.
        const remote = createStore('r');
        const delta = { playlists: { 'pl-1': { name: 'P', tracks: [keyOf(1), keyOf(9), keyOf(2), keyOf(8)], t: { w: 500, c: 0, d: 'r' } } } };
        let store = applyDelta(createStore('d'), delta, 600).store;
        const local = emptyLocal('d', 5);
        const applied = applyToLocal(store, local);
        expect(applied.playlists[0].songs).toEqual([pathOf('d', 1), pathOf('d', 2)]);
        expect(applied.report.unmatched).toBe(2);
        store = applied.store;
        // no change locally -> no capture
        expect(captureLocal(store, { ...local, playlists: applied.playlists }, 700).changed).toBe(0);
        // add track 3 between 1 and 2 locally
        const edited = { ...local, playlists: [{ ...applied.playlists[0], songs: [pathOf('d', 1), pathOf('d', 3), pathOf('d', 2)] }] };
        const captured = captureLocal(store, edited, 800);
        expect(captured.changed).toBe(1);
        expect(captured.store.state.playlists['pl-1'].tracks).toEqual([keyOf(1), keyOf(9), keyOf(3), keyOf(2), keyOf(8)]);
        expect(remote.rev).toBe(0);
    });

    it('records listened seconds added later as a change', () => {
        const local = { ...emptyLocal('d'), stats: { playHistory: [{ path: pathOf('d', 1), timestamp: 5, trackKey: keyOf(1) }] } };
        let { store } = captureLocal(createStore('d'), local, 1000);
        const withListened = { ...local, stats: { playHistory: [{ path: pathOf('d', 1), timestamp: 5, trackKey: keyOf(1), listened: 30 }] } };
        const second = captureLocal(store, withListened, 1001);
        expect(second.changed).toBe(1);
        expect(second.store.state.history[`${keyOf(1)}@5`]).toMatchObject({ l: 30, _r: 2 });
        // a lower value later does not override
        expect(captureLocal(second.store, local, 1002).changed).toBe(0);
    });
});

// ---- merge properties -------------------------------------------------------------------------

describe('mergeStates', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

    it('is commutative, associative and idempotent', () => {
        for (const seed of seeds) {
            const rand = rng(seed);
            const a = randomState(rand, 'a');
            const b = randomState(rand, 'b');
            const c = randomState(rand, 'c');
            expect(sortKeys(mergeStates(a, b))).toEqual(sortKeys(mergeStates(b, a)));
            expect(sortKeys(mergeStates(a, a))).toEqual(sortKeys(a));
            expect(sortKeys(mergeStates(mergeStates(a, b), c))).toEqual(sortKeys(mergeStates(a, mergeStates(b, c))));
        }
    });

    it('applyDelta agrees with the pure merge and marks echoes', () => {
        for (const seed of seeds) {
            const rand = rng(seed);
            const a = randomState(rand, 'a');
            const b = randomState(rand, 'b');
            const storeA = applyDelta(createStore('a'), a, 1).store;
            const { store, echo } = applyDelta(storeA, b, 2);
            expect(sortKeys(exportState(store))).toEqual(sortKeys(mergeStates(a, b)));
            for (const k of Object.keys(b.favorites)) {
                const merged = store.state.favorites[k];
                expect(echo.favorites.has(k)).toBe(merged.on === b.favorites[k].on && merged.t.w === b.favorites[k].t.w && merged.t.c === b.favorites[k].t.c && merged.t.d === b.favorites[k].t.d);
            }
        }
    });

    it('three devices converge through pairwise exchanges in any order', () => {
        for (const seed of seeds.slice(0, 60)) {
            const rand = rng(seed);
            let a = applyDelta(createStore('a'), randomState(rand, 'a'), 1).store;
            let b = applyDelta(createStore('b'), randomState(rand, 'b'), 1).store;
            let c = applyDelta(createStore('c'), randomState(rand, 'c'), 1).store;
            const exchange = (x, y) => {
                const dx = buildDelta(x, 0);
                const dy = buildDelta(y, 0);
                return [applyDelta(x, dy, 5).store, applyDelta(y, dx, 5).store];
            };
            [a, b] = exchange(a, b);
            [b, c] = exchange(b, c);
            [a, c] = exchange(a, c);
            [a, b] = exchange(a, b);
            expect(sortKeys(exportState(a))).toEqual(sortKeys(exportState(b)));
            expect(sortKeys(exportState(b))).toEqual(sortKeys(exportState(c)));
        }
    });

    it('resolves delete vs concurrent edit by timestamp on both sides', () => {
        const edit = { playlists: { 'pl-1': { name: 'Edited', tracks: [keyOf(1)], t: { w: 200, c: 0, d: 'a' } } } };
        const del = { playlists: { 'pl-1': { name: 'Old', tracks: [], deleted: true, t: { w: 100, c: 5, d: 'b' } } } };
        expect(mergeStates(edit, del).playlists['pl-1'].deleted).toBeUndefined();
        expect(mergeStates(del, edit).playlists['pl-1'].name).toBe('Edited');
        const laterDelete = { playlists: { 'pl-1': { name: 'Old', tracks: [], deleted: true, t: { w: 200, c: 1, d: 'b' } } } };
        expect(mergeStates(edit, laterDelete).playlists['pl-1'].deleted).toBe(true);
    });

    it('rejects malformed items without touching valid ones', () => {
        const delta = {
            favorites: { [keyOf(1)]: { on: true, t: { w: 1, c: 0, d: 'z' } }, bad: { on: 'yes', t: { w: 1, c: 0, d: 'z' } }, worse: { on: true, t: null } },
            playlists: { ok: { name: 'x', tracks: [keyOf(2)], t: { w: 1, c: 0, d: 'z' } }, bad: { name: 3, tracks: [], t: { w: 1, c: 0, d: 'z' } }, bad2: { name: 'x', tracks: [4], t: { w: 1, c: 0, d: 'z' } } },
            history: { [`${keyOf(3)}@7`]: {}, 'no-timestamp': {}, [`${keyOf(3)}@8`]: { l: -1 } }
        };
        const { store, rejected } = applyDelta(createStore('d'), delta, 5);
        expect(rejected).toBe(6);
        expect(Object.keys(store.state.favorites)).toEqual([keyOf(1)]);
        expect(Object.keys(store.state.playlists)).toEqual(['ok']);
        expect(Object.keys(store.state.history)).toEqual([`${keyOf(3)}@7`]);
        expect(() => applyDelta(createStore('d'), { favorites: [] }, 5)).toThrow();
        expect(() => applyDelta(createStore('d'), null, 5)).toThrow();
    });

    it('lets a device with a skewed clock win concurrent edits, then catches the other up', () => {
        // Phone is 1 day ahead. Both favorite/unfavorite track 1 "at the same time".
        const DAY = 86_400_000;
        const desktop = captureLocal(createStore('desk'), { ...emptyLocal('d'), favorites: [pathOf('d', 1)] }, 1000).store;
        const phone = captureLocal(createStore('phone'), { ...emptyLocal('p'), favorites: [pathOf('p', 1)] }, 1000 + DAY).store;
        // desktop unfavorites at wall 2000; phone's earlier "on" still wins because its wall is ahead
        const desktop2 = captureLocal(desktop, emptyLocal('d'), 2000).store;
        const merged = applyDelta(desktop2, buildDelta(phone, 0), 2000).store;
        expect(merged.state.favorites[keyOf(1)].on).toBe(true);
        // after receiving, the desktop clock jumped ahead, so its next edit wins
        expect(merged.clock.w).toBe(1000 + DAY);
        const applied = applyToLocal(merged, emptyLocal('d'));
        expect(applied.favorites).toEqual([pathOf('d', 1)]);
        const desktop3 = captureLocal(applied.store, emptyLocal('d'), 3000).store;
        expect(desktop3.state.favorites[keyOf(1)]).toMatchObject({ on: false, t: { w: 1000 + DAY, c: 2, d: 'desk' } });
        const phoneMerged = applyDelta(phone, buildDelta(desktop3, 0), 3000).store;
        expect(phoneMerged.state.favorites[keyOf(1)].on).toBe(false);
    });

    it('bumps the revision of a winning local item so the sender learns it', () => {
        const local = applyDelta(createStore('d'), { favorites: { [keyOf(1)]: { on: false, t: { w: 500, c: 0, d: 'd' } } } }, 1).store;
        const stale = { favorites: { [keyOf(1)]: { on: true, t: { w: 100, c: 0, d: 'p' } } } };
        const since = local.rev;
        const { store, echo } = applyDelta(local, stale, 2);
        expect(echo.favorites.has(keyOf(1))).toBe(false);
        expect(buildDelta(store, since, echo).favorites[keyOf(1)]).toEqual({ on: false, t: { w: 500, c: 0, d: 'd' } });
    });
});

// ---- apply -------------------------------------------------------------------------------------

describe('applyToLocal', () => {
    it('maps synced items to local paths and reports unmatched tracks', () => {
        const delta = {
            favorites: { [keyOf(1)]: { on: true, t: { w: 1, c: 0, d: 'r' } }, [keyOf(99)]: { on: true, t: { w: 1, c: 1, d: 'r' } } },
            playlists: { 'pl-r': { name: 'Remote', tracks: [keyOf(2), keyOf(98)], t: { w: 1, c: 2, d: 'r' } } },
            history: { [`${keyOf(3)}@40`]: { l: 9 }, [`${keyOf(97)}@41`]: {} }
        };
        const store = applyDelta(createStore('d'), delta, 5).store;
        const local = { ...emptyLocal('d'), stats: { totalTime: 1, playHistory: [{ path: pathOf('d', 5), timestamp: 50, trackKey: keyOf(5) }] } };
        const out = applyToLocal(store, local);
        expect(out.favorites).toEqual([pathOf('d', 1)]);
        expect(out.playlists).toEqual([{ id: 'pl-r', name: 'Remote', songs: [pathOf('d', 2)] }]);
        expect(out.stats.playHistory).toEqual([
            { path: pathOf('d', 3), timestamp: 40, trackKey: keyOf(3), listened: 9 },
            { path: pathOf('d', 5), timestamp: 50, trackKey: keyOf(5) }
        ]);
        expect(out.stats.totalTime).toBe(1);
        expect(out.report).toMatchObject({ favoritesAdded: 1, playlistsCreated: 1, playsAdded: 1, unmatched: 3 });
        expect(countUnmatched(out.store, local.songs)).toBe(3);
        // applied flags: the play is not applied twice
        const again = applyToLocal(out.store, { ...local, favorites: out.favorites, playlists: out.playlists, stats: out.stats });
        expect(again.report.playsAdded).toBe(0);
        expect(again.favorites).toBe(out.favorites);
        expect(again.playlists).toBe(out.playlists);
    });

    it('applies plays later once the library gains the track', () => {
        const delta = { history: { [`${keyOf(97)}@41`]: {} } };
        const store = applyDelta(createStore('d'), delta, 5).store;
        const first = applyToLocal(store, emptyLocal('d'));
        expect(first.report.playsAdded).toBe(0);
        const grown = { ...emptyLocal('d'), songs: [...library('d'), song(97, 'd')] };
        const second = applyToLocal(first.store, grown);
        expect(second.report.playsAdded).toBe(1);
        expect(second.stats.playHistory[0].path).toBe(pathOf('d', 97));
    });

    it('removes favorites and deletes playlists on tombstones, preserving unkeyed local paths', () => {
        const local = {
            ...emptyLocal('d'),
            favorites: [pathOf('d', 1), '/d/unknown.flac'],
            playlists: [{ id: 'pl-1', name: 'A', songs: [pathOf('d', 1), '/d/unknown.flac'] }, { id: 'pl-2', name: 'B', songs: [] }]
        };
        let store = captureLocal(createStore('d'), local, 1000).store;
        const remote = {
            favorites: { [keyOf(1)]: { on: false, t: { w: 2000, c: 0, d: 'r' } } },
            playlists: { 'pl-1': { name: 'A!', tracks: [keyOf(2)], t: { w: 2000, c: 1, d: 'r' } }, 'pl-2': { name: 'B', tracks: [], deleted: true, t: { w: 2000, c: 2, d: 'r' } } }
        };
        store = applyDelta(store, remote, 2000).store;
        const out = applyToLocal(store, local);
        expect(out.favorites).toEqual(['/d/unknown.flac']);
        expect(out.playlists).toEqual([{ id: 'pl-1', name: 'A!', songs: [pathOf('d', 2), '/d/unknown.flac'] }]);
        expect(out.report).toMatchObject({ favoritesRemoved: 1, playlistsUpdated: 1, playlistsDeleted: 1 });
        // and the app state now matches the snapshot: no spurious capture
        expect(captureLocal(out.store, { ...local, favorites: out.favorites, playlists: out.playlists }, 3000).changed).toBe(0);
    });

    it('trims the play history to MAX_PLAY_HISTORY with archiving', () => {
        const playHistory = Array.from({ length: MAX_PLAY_HISTORY }, (_, i) => ({ path: '/d/x.flac', timestamp: i + 10 }));
        const stats = applyPlaysToStats({ playHistory }, [{ path: '/d/old.flac', timestamp: 1, trackKey: 'k' }]);
        expect(stats.playHistory).toHaveLength(MAX_PLAY_HISTORY);
        expect(stats.playHistory[0].timestamp).toBe(10);
        expect(stats.archivedCounts).toEqual({ '/d/old.flac': 1 });
        expect(stats.archivedCount).toBe(1);
        expect(applyPlaysToStats(stats, [])).toBe(stats);
    });
});

// ---- full exchanges ---------------------------------------------------------------------------

describe('exchange', () => {
    const run = (client, server, clientLocal, serverLocal, now) => {
        const req = clientRequest({ store: client.store, local: clientLocal, peer: client.peer, now });
        const srv = serverExchange({ store: server.store, local: serverLocal, request: req.request, now });
        const res = clientReceive({ store: req.store, local: clientLocal, peer: client.peer, response: srv.response, now });
        return {
            client: { store: res.store, peer: res.peer, local: { ...clientLocal, favorites: res.favorites, playlists: res.playlists, stats: res.stats }, report: res.report, sent: req.request },
            server: { store: srv.store, local: { ...serverLocal, favorites: srv.favorites, playlists: srv.playlists, stats: srv.stats }, report: srv.report, response: srv.response }
        };
    };

    it('converges two devices over two rounds with conflicting edits and sends only deltas', () => {
        let client = { store: createStore('phone'), peer: { seenRev: 0, pushedRev: 0 } };
        let server = { store: createStore('desk') };
        const clientLocal = { ...emptyLocal('p'), favorites: [pathOf('p', 1)], playlists: [{ id: 'pl-p', name: 'Phone', songs: [pathOf('p', 2)] }], stats: { playHistory: [{ path: pathOf('p', 1), timestamp: 100, trackKey: keyOf(1) }] } };
        const serverLocal = { ...emptyLocal('d'), favorites: [pathOf('d', 3)], playlists: [{ id: 'pl-d', name: 'Desk', songs: [pathOf('d', 4)] }], stats: { playHistory: [{ path: pathOf('d', 3), timestamp: 200, trackKey: keyOf(3) }] } };

        let r = run(client, server, clientLocal, serverLocal, 1000);
        expect(r.client.local.favorites).toEqual([pathOf('p', 1), pathOf('p', 3)]);
        expect(r.server.local.favorites).toEqual([pathOf('d', 3), pathOf('d', 1)]);
        expect(r.client.local.playlists.map(p => p.id).sort()).toEqual(['pl-d', 'pl-p']);
        expect(r.server.local.playlists.map(p => p.id).sort()).toEqual(['pl-d', 'pl-p']);
        expect(r.client.local.stats.playHistory.map(e => e.timestamp)).toEqual([100, 200]);
        expect(r.server.local.stats.playHistory.map(e => e.timestamp)).toEqual([100, 200]);
        expect(sortKeys(exportState(r.client.store))).toEqual(sortKeys(exportState(r.server.store)));
        // the response did not echo what the phone sent
        expect(Object.keys(r.server.response.delta.favorites)).toEqual([keyOf(3)]);
        expect(r.client.report.received).toBe(3);

        // Round 2: both rename the same playlist; desktop later. Phone unfavorites 3, desktop plays 5.
        const clientLocal2 = { ...r.client.local, favorites: [pathOf('p', 1)], playlists: r.client.local.playlists.map(p => p.id === 'pl-d' ? { ...p, name: 'Phone rename' } : p) };
        const serverLocal2 = { ...r.server.local, playlists: r.server.local.playlists.map(p => p.id === 'pl-d' ? { ...p, name: 'Desk rename' } : p), stats: { playHistory: [...r.server.local.stats.playHistory, { path: pathOf('d', 5), timestamp: 300, trackKey: keyOf(5) }] } };
        // capture the phone's edit first (earlier wall clock), then the desktop's during the exchange
        const req = clientRequest({ store: r.client.store, local: clientLocal2, peer: r.client.peer, now: 2000 });
        const srv = serverExchange({ store: r.server.store, local: serverLocal2, request: req.request, now: 3000 });
        const res = clientReceive({ store: req.store, local: clientLocal2, peer: r.client.peer, response: srv.response, now: 3000 });
        expect(res.playlists.find(p => p.id === 'pl-d').name).toBe('Desk rename');
        expect(srv.playlists.find(p => p.id === 'pl-d').name).toBe('Desk rename');
        expect(srv.favorites).toEqual([pathOf('d', 1)]);
        expect(res.stats.playHistory.map(e => e.timestamp)).toEqual([100, 200, 300]);
        expect(sortKeys(exportState(res.store))).toEqual(sortKeys(exportState(srv.store)));
        // deltas were incremental: only the round-2 changes travelled
        expect(Object.keys(req.request.delta.history)).toEqual([]);
        expect(Object.keys(req.request.delta.favorites)).toEqual([keyOf(3)]);
        expect(Object.keys(srv.response.delta.history)).toEqual([`${keyOf(5)}@300`]);
        expect(req.request.since).toBe(r.client.peer.seenRev);

        // Round 3: nothing changed -> empty deltas both ways
        const r3 = run({ store: res.store, peer: res.peer }, { store: srv.store }, { ...clientLocal2, favorites: res.favorites, playlists: res.playlists, stats: res.stats }, { ...serverLocal2, favorites: srv.favorites, playlists: srv.playlists, stats: srv.stats }, 4000);
        expect(r3.client.sent.delta).toEqual({ favorites: {}, playlists: {}, history: {} });
        expect(r3.server.response.delta).toEqual({ favorites: {}, playlists: {}, history: {} });
    });

    it('resends everything when the server no longer knows the client watermark', () => {
        const client = { store: createStore('phone'), peer: { seenRev: 999, pushedRev: 0 } };
        const server = { store: createStore('desk') };
        const serverLocal = { ...emptyLocal('d'), favorites: [pathOf('d', 3)] };
        const r = run(client, server, emptyLocal('p'), serverLocal, 1000);
        expect(r.client.local.favorites).toEqual([pathOf('p', 3)]);
        expect(r.client.peer.seenRev).toBe(r.server.store.rev);
    });

    it('rejects malformed requests and responses', () => {
        expect(() => serverExchange({ store: createStore('d'), local: emptyLocal('d'), request: { since: 0, delta: [] } })).toThrow();
        expect(() => clientReceive({ store: createStore('d'), local: emptyLocal('d'), peer: {}, response: { rev: -1, delta: {} } })).toThrow();
        expect(() => clientReceive({ store: createStore('d'), local: emptyLocal('d'), peer: {}, response: { rev: 1, delta: { history: 5 } } })).toThrow();
    });

    it('survives a JSON round trip of the store', () => {
        const local = { ...emptyLocal('d'), favorites: [pathOf('d', 1)] };
        const { store } = captureLocal(createStore('d'), local, 1000);
        const restored = createStore('d', JSON.parse(JSON.stringify(store)));
        expect(restored).toEqual(store);
        expect(createStore('d', { version: 99 }).rev).toBe(0);
        expect(createStore('d', 'garbage').state).toEqual(emptyState());
    });
});

// ---- review fixes ------------------------------------------------------------------------------

describe('unmatched items (fix 3)', () => {
    it('applies a playlist track once the library gains it, even when the synced playlist did not change', () => {
        const remote = { playlists: { 'pl-1': { name: 'Mix', tracks: [keyOf(1), keyOf(8)], t: { w: 500, c: 0, d: 'r' } } } };
        const store = applyDelta(createStore('d'), remote, 600).store;
        const small = emptyLocal('d', 6);               // library lacks track 8
        const first = applyToLocal(store, small);
        expect(first.playlists[0].songs).toEqual([pathOf('d', 1)]);
        expect(first.report.unmatched).toBe(1);
        expect(countUnmatched(first.store, small.songs)).toBe(1);
        // nothing changes while the track is still missing
        const same = applyToLocal(first.store, { ...small, playlists: first.playlists });
        expect(same.playlists).toBe(first.playlists);
        expect(same.report.playlistsUpdated).toBe(0);
        // the library gains track 8: the playlist is completed in place, unmatched drops to 0
        const grown = { ...small, songs: library('d', 10), playlists: first.playlists };
        const second = applyToLocal(first.store, grown);
        expect(second.playlists[0].songs).toEqual([pathOf('d', 1), pathOf('d', 8)]);
        expect(second.report).toMatchObject({ playlistsUpdated: 1, unmatched: 0 });
        expect(countUnmatched(second.store, grown.songs)).toBe(0);
        // and the snapshot matches: no spurious capture afterwards
        expect(captureLocal(second.store, { ...grown, playlists: second.playlists }, 700).changed).toBe(0);
    });
});

describe('ops (fix 1)', () => {
    it('applies ops against a state edited while the exchange was in flight', () => {
        const remote = {
            favorites: { [keyOf(1)]: { on: true, t: { w: 5, c: 0, d: 'r' } }, [keyOf(2)]: { on: false, t: { w: 5, c: 1, d: 'r' } } },
            playlists: { 'pl-r': { name: 'Remote', tracks: [keyOf(3)], t: { w: 5, c: 2, d: 'r' } }, 'pl-gone': { name: 'x', tracks: [], deleted: true, t: { w: 5, c: 3, d: 'r' } } }
        };
        const local = { ...emptyLocal('d'), favorites: [pathOf('d', 2), pathOf('d', 9)], playlists: [{ id: 'pl-gone', name: 'x', songs: [] }, { id: 'pl-r', name: 'Old', songs: [pathOf('d', 4), '/d/unkeyed.flac'] }] };
        const captured = captureLocal(createStore('d'), local, 1).store;
        const out = applyToLocal(applyDelta(captured, remote, 6).store, local);
        expect(out.ops.favorites).toEqual({ add: [pathOf('d', 1)], remove: [pathOf('d', 2)] });
        expect(out.ops.playlists.remove).toEqual(['pl-gone']);
        expect(out.ops.playlists.upsert).toEqual([{ id: 'pl-r', name: 'Remote', songs: [pathOf('d', 3)] }]);
        // computed against `local`
        expect(out.favorites).toEqual([pathOf('d', 9), pathOf('d', 1)]);
        expect(out.playlists).toEqual([{ id: 'pl-r', name: 'Remote', songs: [pathOf('d', 3), '/d/unkeyed.flac'] }]);
        // the user favorited track 5 and created a playlist while the request was in flight:
        // the functional application keeps both
        const edited = { favorites: [pathOf('d', 2), pathOf('d', 9), pathOf('d', 5)], playlists: [...local.playlists, { id: 'pl-new', name: 'Mine', songs: [pathOf('d', 6)] }] };
        expect(applyFavoriteOps(edited.favorites, out.ops)).toEqual([pathOf('d', 9), pathOf('d', 5), pathOf('d', 1)]);
        expect(applyPlaylistOps(edited.playlists, out.ops)).toEqual([
            { id: 'pl-r', name: 'Remote', songs: [pathOf('d', 3), '/d/unkeyed.flac'] },
            { id: 'pl-new', name: 'Mine', songs: [pathOf('d', 6)] }
        ]);
        // and the concurrent edit is captured next time as a change of its own
        const next = captureLocal(out.store, { ...local, favorites: applyFavoriteOps(edited.favorites, out.ops), playlists: applyPlaylistOps(edited.playlists, out.ops) }, 10);
        expect(next.changed).toBe(2);
        expect(next.store.state.favorites[keyOf(5)]).toMatchObject({ on: true });
        expect(next.store.state.playlists['pl-new']).toMatchObject({ name: 'Mine', tracks: [keyOf(6)] });
        // identity is preserved when nothing applies
        const none = { favorites: { add: [], remove: [] }, playlists: { upsert: [], remove: [] }, plays: [], keyed: new Set() };
        expect(applyFavoriteOps(edited.favorites, none)).toBe(edited.favorites);
        expect(applyPlaylistOps(edited.playlists, none)).toBe(edited.playlists);
    });
});

describe('limits (fix 17)', () => {
    const hlc = (c) => ({ w: 1, c, d: 'evil' });

    it('refuses deltas with too many items, oversized playlists or too much content, merging nothing', () => {
        const store = captureLocal(createStore('d'), { ...emptyLocal('d'), favorites: [pathOf('d', 1)] }, 1).store;
        const many = { favorites: {} };
        for (let i = 0; i < LIMITS.deltaItems + 1; i++) many.favorites[`k${i}`] = { on: true, t: hlc(i) };
        expect(() => applyDelta(store, many, 2)).toThrow(SyncLimitError);
        const fat = { playlists: { p: { name: 'a', tracks: Array.from({ length: LIMITS.playlistTracks + 1 }, (_, j) => `t${j}`), t: hlc(0) } } };
        expect(() => applyDelta(store, fat, 2)).toThrow(SyncLimitError);
        const longKey = { favorites: { ['x'.repeat(LIMITS.keyLength + 1)]: { on: true, t: hlc(0) } } };
        expect(applyDelta(store, longKey, 2).rejected).toBe(1);   // a single bad key is skipped, not fatal
        // content bytes: 4 playlists x 10k tracks x 512-char keys (the reviewer's amplification case)
        const amplify = { playlists: {} };
        for (let i = 0; i < 4; i++) amplify.playlists[`p${i}`] = { name: 'a', tracks: Array.from({ length: 10000 }, (_, j) => 'x'.repeat(488) + String(j).padStart(24, '0')), t: hlc(i) };
        expect(() => serverExchange({ store, local: emptyLocal('d'), request: { since: 0, delta: amplify } })).toThrow(SyncLimitError);
        // the store is untouched by a refused delta
        expect(Object.keys(store.state.playlists)).toEqual([]);
    });

    it('caps what a store may grow to across exchanges', () => {
        let store = createStore('d');
        const batch = (from, count) => { const d = { playlists: {} }; for (let i = from; i < from + count; i++) d.playlists[`p${i}`] = { name: 'a', tracks: Array.from({ length: 100 }, (_, j) => `t${j}`), t: hlc(i) }; return d; };
        // 500 playlists x 100 tracks = 50k refs: exactly the limit, fine
        store = applyDelta(store, batch(0, 250), 2).store;
        store = applyDelta(store, batch(250, 250), 3).store;
        expect(Object.keys(store.state.playlists)).toHaveLength(500);
        // one more live playlist tips the total refs over the limit
        expect(() => applyDelta(store, batch(500, 1), 4)).toThrow(/playlist entries/);
        // tombstoning frees room
        const del = { playlists: { p0: { name: 'a', tracks: [], deleted: true, t: hlc(999) } } };
        store = applyDelta(store, del, 5).store;
        expect(() => applyDelta(store, batch(500, 1), 6)).not.toThrow();
        // and the playlist count itself is capped
        let crowded = createStore('d');
        const tiny = (from, count) => { const d = { playlists: {} }; for (let i = from; i < from + count; i++) d.playlists[`q${i}`] = { name: 'a', tracks: [], t: hlc(i) }; return d; };
        crowded = applyDelta(crowded, tiny(0, LIMITS.playlists), 2).store;
        expect(() => applyDelta(crowded, tiny(LIMITS.playlists, 1), 3)).toThrow(/playlists/);
        const favs = { favorites: {} };
        for (let i = 0; i < LIMITS.favorites + 1; i++) favs.favorites[`f${i}`] = { on: true, t: hlc(i) };
        expect(() => applyDelta(createStore('d'), favs, 2)).toThrow(/favorites/);
    });
});

describe('hostile keys (fix 8)', () => {
    it('ignores __proto__ / constructor keys and never pollutes Object.prototype', () => {
        const delta = JSON.parse('{"favorites":{"__proto__":{"on":true,"t":{"w":1,"c":0,"d":"e"}},"constructor":{"on":true,"t":{"w":1,"c":0,"d":"e"}}},"playlists":{"__proto__":{"name":"x","tracks":["prototype"],"t":{"w":1,"c":0,"d":"e"}}},"history":{"__proto__@5":{},"constructor@5":{}}}');
        const { store, rejected } = applyDelta(createStore('d'), delta, 1);
        expect(rejected).toBe(5);
        expect(Object.keys(store.state.favorites)).toEqual([]);
        expect(Object.keys(store.state.playlists)).toEqual([]);
        expect(Object.keys(store.state.history)).toEqual([]);
        expect(({}).on).toBeUndefined();
        expect(Object.getPrototypeOf(store.state.favorites)).toBeNull();
        // a saved store with such keys is loaded into null-prototype maps, not onto the prototype
        const saved = JSON.parse('{"version":2,"state":{"favorites":{"__proto__":{"on":true}}},"snapshot":{"keys":{"__proto__":"k"}}}');
        const restored = createStore('d', saved);
        expect(Object.getPrototypeOf(restored.state.favorites)).toBeNull();
        expect(({}).on).toBeUndefined();
        // a local playlist with a reserved id is never captured
        const local = { ...emptyLocal('d'), playlists: [{ id: '__proto__', name: 'x', songs: [] }] };
        expect(captureLocal(createStore('d'), local, 1).changed).toBe(0);
        expect(parseHistoryKey('__proto__@1')).toBeNull();
    });
});
