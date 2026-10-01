import { describe, expect, it } from 'vitest';
import { createLocalMirror } from '../mirror.js';
import { captureLocal, createStore } from '../model.js';

const songs = Array.from({ length: 5 }, (_, i) => ({ path: `/t${i}.flac`, trackKey: `meta:a|b||${i}|t${i}` }));
const ops = (over = {}) => ({ favorites: { add: [], remove: [] }, playlists: { upsert: [], remove: [] }, plays: [], keyed: new Set(songs.map(s => s.path)), ...over });

describe('local mirror (fix 2)', () => {
    it('keeps the state an exchange produced until React commits it, then follows the props', () => {
        const mirror = createLocalMirror();
        const A = { songs, favorites: ['/t0.flac'], playlists: [], stats: { playHistory: [] } };
        mirror.observe(A);
        expect(mirror.get().favorites).toBe(A.favorites);

        // exchange 1 adds a favorite and a play; React has not re-rendered yet
        const o1 = ops({ favorites: { add: ['/t1.flac'], remove: [] }, plays: [{ path: '/t2.flac', timestamp: 5, trackKey: 'meta:a|b||2|t2' }] });
        mirror.commit(o1);
        expect(mirror.get().favorites).toEqual(['/t0.flac', '/t1.flac']);
        expect(mirror.get().stats.playHistory).toHaveLength(1);

        // a stale render (same prop identities as before) must not roll the mirror back
        mirror.observe(A);
        expect(mirror.get().favorites).toEqual(['/t0.flac', '/t1.flac']);

        // exchange 2 captures from the mirror: nothing looks removed
        const store1 = captureLocal(createStore('p'), A, 1).store;
        const captured = captureLocal(store1, mirror.get(), 2);
        expect(captured.store.state.favorites['meta:a|b||1|t1']).toMatchObject({ on: true });
        expect(Object.values(captured.store.state.favorites).every(f => f.on)).toBe(true);

        // React commits exchange 1's update (new identity) -> the mirror adopts it
        const committed = { ...A, favorites: ['/t0.flac', '/t1.flac'] };
        mirror.observe(committed);
        expect(mirror.get().favorites).toBe(committed.favorites);

        // the user edits (another new identity): adopted too
        const edited = { ...committed, favorites: ['/t1.flac'] };
        mirror.observe(edited);
        expect(mirror.get().favorites).toBe(edited.favorites);
        // songs/playlists/stats follow the same rule
        const stats = { playHistory: [{ path: '/t9.flac', timestamp: 1 }] };
        mirror.observe({ ...edited, stats });
        expect(mirror.get().stats).toBe(stats);
    });

    it('applies playlist ops the same way the app will', () => {
        const mirror = createLocalMirror();
        mirror.observe({ songs, favorites: [], playlists: [{ id: 'a', name: 'A', songs: ['/t0.flac', '/unkeyed.flac'] }], stats: {} });
        mirror.commit(ops({ playlists: { upsert: [{ id: 'a', name: 'A2', songs: ['/t3.flac'] }, { id: 'b', name: 'B', songs: [] }], remove: [] } }));
        expect(mirror.get().playlists).toEqual([{ id: 'a', name: 'A2', songs: ['/t3.flac', '/unkeyed.flac'] }, { id: 'b', name: 'B', songs: [] }]);
        mirror.commit(ops({ playlists: { upsert: [], remove: ['a'] } }));
        expect(mirror.get().playlists).toEqual([{ id: 'b', name: 'B', songs: [] }]);
        mirror.commit(null);
        expect(mirror.get().playlists).toEqual([{ id: 'b', name: 'B', songs: [] }]);
    });
});
