// The hook's authoritative copy of the app state that sync reads from (#25).
//
// Problem: after an exchange the hook queues functional state updates, but React may not have
// re-rendered before the next exchange starts (auto-sync right after a manual one, or two
// phones hitting the desktop back to back). Reading the props of the last render then returns
// the state from BEFORE the previous exchange, and the capture diff would see everything that
// exchange added as "removed since the snapshot" and tombstone it.
//
// Fix: keep one copy here. `observe(props)` runs on every render and replaces a field only when
// its identity changed since the last render (a user edit or a commit of our own update);
// `commit(ops)` applies an exchange's operations to the copy synchronously with the same pure
// functions React will apply later, so the next capture sees the state React is about to show.
// A render with props that are merely stale (not yet re-rendered) changes nothing.

import { applyFavoriteOps, applyPlaylistOps, applyPlaysToStats } from './model.js';

const FIELDS = ['songs', 'favorites', 'playlists', 'stats'];

export const createLocalMirror = () => {
    const seen = {};
    const current = { songs: [], favorites: [], playlists: [], stats: {} };
    return {
        /** Called on every render with the current props. */
        observe(props) {
            for (const field of FIELDS) {
                if (props[field] !== seen[field]) {
                    seen[field] = props[field];
                    current[field] = props[field];
                }
            }
        },
        /** The state an exchange should capture from. */
        get() {
            return { songs: current.songs, favorites: current.favorites, playlists: current.playlists, stats: current.stats };
        },
        /** Applies an exchange's ops exactly like the app's functional updates will. */
        commit(ops) {
            if (!ops) return;
            current.favorites = applyFavoriteOps(current.favorites, ops);
            current.playlists = applyPlaylistOps(current.playlists, ops);
            current.stats = applyPlaysToStats(current.stats, ops.plays);
        }
    };
};
