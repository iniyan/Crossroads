// Sync data model (#25): pure functions, no I/O. See ./README.md for the overview.
//
// Identity: tracks are identified by trackKey (src/library/trackKey.js); paths differ per
// device and never leave it. Everything the app keeps by path (favorites, playlists, play
// history) is projected onto keys when captured and mapped back to local paths when applied.
// Items whose key has no song in the local library stay in the synced state ("unmatched")
// and are applied once the library gains the track.
//
// Synced state (the CRDT; the same shape travels in deltas without the `_` fields):
//   favorites: { [trackKey]: { on: bool, t: HLC } }               last writer wins per track
//   playlists: { [id]: { name, tracks: [trackKey], t: HLC, deleted?: true } }
//                                                                 last writer wins per playlist
//   history:   { [`${trackKey}@${ts}`]: { l?: listened } }        union; `l` merges by max
//              (the key carries track and timestamp; nothing is repeated in the value)
// Whole-playlist LWW: an edit is the complete track list, so two devices editing the same
// playlist concurrently keep the later edit only (the losing edit is not merged in). This
// matches the issue ("last-writer-wins per item with tombstones") and avoids the ordering
// ambiguities of per-track merges; playlists are small and rarely edited on two devices at
// once. Deleting a playlist writes a tombstone { deleted: true, t }; tombstones are kept.
//
// Every map indexed by a peer-supplied key (favorites, playlists, history, snapshot maps) is a
// null-prototype object, and keys like "__proto__" are rejected outright, so a hostile delta
// cannot reach Object.prototype.
//
// Local bookkeeping (never sent):
//   _r  per item: this device's revision counter when the item last changed here, so a peer
//       that has seen revision N only receives items with _r > N.
//   _a  history entries already applied to the local play history (entries are applied at
//       most once; a play trimmed from the local history must not come back).
//   snapshot: what the local app state looked like after the last capture/apply, projected
//       onto keys. Capturing diffs the current app state against it, so the rest of the app
//       never has to stamp timestamps: new/changed items get a fresh HLC, removed ones get a
//       tombstone. `snapshot.keys` remembers the key of every favorite/playlist path seen, so a
//       file that disappears from the library keeps its key instead of looking like a removal.
//
// Applying is expressed as operations (`ops`) relative to the local state the apply was
// computed against, so the app can apply them with functional state updates and an edit made
// while a sync request was in flight survives; the snapshot records what the sync applied, and
// the next capture picks up the concurrent edit as a change.
//
// Play counts: `stats.archivedCounts` (the residue of trimming the local play history) is
// deliberately NOT synced. Every play reaches a device's history exactly once (`_a`), so each
// device's lifetime counts are "every play this device has seen"; syncing the per-device trim
// residue on top would count the same play twice. The synced history is capped at
// MAX_PLAY_HISTORY entries (the newest by timestamp); plays older than that horizon are not
// exchanged any more (`store.horizon`).
//
// Limits (LIMITS): a paired peer is trusted with our data, not with our memory. Per-exchange
// item and content-byte caps, per-playlist / per-store caps; a delta over any of them is
// refused as a whole with SyncLimitError (the sender gets a clear error, nothing is merged).
//
// Merge is commutative, associative and idempotent given the total order on HLCs.

import { MAX_PLAY_HISTORY } from '../library/playHistory.js';
import { compareHlc, createClock, isHlc, receive, tick } from './hlc.js';

export const STATE_VERSION = 2;
export const MAX_SYNC_HISTORY = MAX_PLAY_HISTORY;

export const LIMITS = Object.freeze({
    keyLength: 512,             // trackKey / playlist id
    nameLength: 512,
    playlistTracks: 10_000,     // per playlist
    playlists: 2_000,           // per store, tombstones included
    favorites: 20_000,          // per store, tombstones included
    playlistTrackRefs: 50_000,  // sum of track entries over live playlists, per store
    deltaItems: 40_000,         // per exchange
    deltaBytes: 16 * 1024 * 1024 // per exchange, counted as key/name/track characters
});

export class SyncLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SyncLimitError';
        this.code = 'limit';
    }
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= LIMITS.keyLength && !RESERVED.has(k);
const finalKey = (song) => (song && !song.provisional && isKey(song.trackKey) ? song.trackKey : null);
const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dict = () => Object.create(null);
const copy = (src) => Object.assign(dict(), src);

export const historyKey = (k, ts) => `${k}@${ts}`;
/** { k, ts } from a history key, or null when it is not well-formed. */
export const parseHistoryKey = (hk) => {
    if (typeof hk !== 'string' || hk.length > LIMITS.keyLength + 20) return null;
    const at = hk.lastIndexOf('@');
    if (at <= 0) return null;
    const k = hk.slice(0, at);
    const tsText = hk.slice(at + 1);
    if (!isKey(k) || !/^\d{1,15}$/.test(tsText)) return null;
    const ts = Number(tsText);
    return Number.isSafeInteger(ts) ? { k, ts } : null;
};

// ---- store -----------------------------------------------------------------------------------

export const emptyState = () => ({ favorites: dict(), playlists: dict(), history: dict() });

const emptySnapshot = () => ({ favorites: [], playlists: dict(), keys: dict() });

/** A fresh store, or a saved one validated and given defaults. */
export const createStore = (deviceId, saved = null) => {
    const s = isPlainObject(saved) && saved.version === STATE_VERSION ? saved : null;
    const state = s && isPlainObject(s.state) ? s.state : emptyState();
    const snapshot = s && isPlainObject(s.snapshot) ? s.snapshot : emptySnapshot();
    return {
        version: STATE_VERSION,
        deviceId,
        clock: createClock(deviceId, s?.clock),
        rev: Number.isInteger(s?.rev) && s.rev >= 0 ? s.rev : 0,
        horizon: Number.isFinite(s?.horizon) ? s.horizon : 0,
        state: {
            favorites: isPlainObject(state.favorites) ? copy(state.favorites) : dict(),
            playlists: isPlainObject(state.playlists) ? copy(state.playlists) : dict(),
            history: isPlainObject(state.history) ? copy(state.history) : dict()
        },
        snapshot: {
            favorites: Array.isArray(snapshot.favorites) ? snapshot.favorites.slice() : [],
            playlists: isPlainObject(snapshot.playlists) ? copy(snapshot.playlists) : dict(),
            keys: isPlainObject(snapshot.keys) ? copy(snapshot.keys) : dict()
        }
    };
};

/**
 * path -> key (library first, then remembered keys for paths no longer in the library) and
 * key -> path (first non-provisional song). Provisional songs have no final key yet.
 */
export const libraryIndex = (songs, memory = {}) => {
    const pathToKey = new Map();
    const keyToPath = new Map();
    for (const song of songs || []) {
        const key = finalKey(song);
        if (!key || !song.path) continue;
        pathToKey.set(song.path, key);
        if (!keyToPath.has(key)) keyToPath.set(key, song.path);
    }
    for (const [path, key] of Object.entries(memory)) {
        if (!pathToKey.has(path) && isKey(key)) pathToKey.set(path, key);
    }
    return { pathToKey, keyToPath };
};

// ---- capture: app state -> synced state ------------------------------------------------------

// Unmatched tracks of a playlist keep their place: each is anchored to the matched track that
// preceded it in the synced list (or to the start) and is emitted right after that anchor.
const weaveUnmatched = (localKeys, syncedTracks, appliedSet) => {
    const START = Symbol('start');
    const anchors = new Map();
    let anchor = START;
    for (const key of syncedTracks) {
        if (appliedSet.has(key)) { anchor = key; continue; }
        if (!anchors.has(anchor)) anchors.set(anchor, []);
        anchors.get(anchor).push(key);
    }
    const result = [];
    const emitted = new Set();
    const emit = (key) => { if (!emitted.has(key)) { emitted.add(key); result.push(key); } };
    (anchors.get(START) || []).forEach(emit);
    anchors.delete(START);
    for (const key of localKeys) {
        emit(key);
        (anchors.get(key) || []).forEach(emit);
        anchors.delete(key);
    }
    for (const rest of anchors.values()) rest.forEach(emit);
    return result;
};

/**
 * Records every local change since the last capture/apply into the synced state, stamping a
 * fresh HLC and revision on each. Must run before `applyDelta` so local edits keep their
 * (earlier) timestamps and before `applyToLocal` so the snapshot matches the app state.
 * @returns {{ store, changed: number }}
 */
export const captureLocal = (store, local, now = Date.now()) => {
    const { songs = [], favorites = [], playlists = [], stats = {} } = local;
    const { pathToKey, keyToPath } = libraryIndex(songs, store.snapshot.keys);
    let clock = store.clock;
    let rev = store.rev;
    let changed = 0;
    const stamp = () => { clock = tick(clock, now); rev += 1; return { t: clock, _r: rev }; };

    const favState = copy(store.state.favorites);
    const plState = copy(store.state.playlists);
    const histState = copy(store.state.history);
    const keys = copy(store.snapshot.keys);
    const remember = (path) => { const k = pathToKey.get(path); if (k) keys[path] = k; };

    // Favorites
    const localFavKeys = new Set();
    for (const path of favorites) {
        const k = pathToKey.get(path);
        if (!k) continue;
        remember(path);
        localFavKeys.add(k);
        const item = favState[k];
        if (!item || !item.on) { favState[k] = { on: true, ...stamp() }; changed++; }
    }
    for (const k of store.snapshot.favorites) {
        if (localFavKeys.has(k) || !keyToPath.has(k)) continue;
        const item = favState[k];
        if (item && item.on) { favState[k] = { on: false, ...stamp() }; changed++; }
    }

    // Playlists
    const snapPlaylists = copy(store.snapshot.playlists);
    const seenIds = new Set();
    for (const pl of playlists) {
        if (!pl || !isKey(pl.id) || seenIds.has(pl.id)) continue;
        seenIds.add(pl.id);
        const name = typeof pl.name === 'string' ? pl.name.slice(0, LIMITS.nameLength) : '';
        const localKeys = [];
        const localSet = new Set();
        for (const path of pl.songs || []) {
            const k = pathToKey.get(path);
            if (!k || localSet.has(k)) continue;
            remember(path);
            localSet.add(k);
            localKeys.push(k);
        }
        const snap = snapPlaylists[pl.id];
        if (snap && snap.name === name && arrEq(localKeys, snap.applied)) continue;
        const tracks = snap ? weaveUnmatched(localKeys, snap.tracks, new Set(snap.applied)) : localKeys;
        plState[pl.id] = { name, tracks, ...stamp() };
        snapPlaylists[pl.id] = { name, tracks, applied: localKeys };
        changed++;
    }
    for (const id of Object.keys(snapPlaylists)) {
        if (seenIds.has(id)) continue;
        const item = plState[id];
        plState[id] = { name: item ? item.name : snapPlaylists[id].name, tracks: [], deleted: true, ...stamp() };
        delete snapPlaylists[id];
        changed++;
    }

    // Play history: entries with a key (or whose path maps to one) that are new or gained
    // `listened` seconds. Local entries are applied by definition.
    for (const entry of stats.playHistory || []) {
        if (!entry || !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0) continue;
        const k = isKey(entry.trackKey) ? entry.trackKey : pathToKey.get(entry.path);
        if (!k || entry.timestamp < store.horizon) continue;
        const hk = historyKey(k, entry.timestamp);
        const l = Number.isFinite(entry.listened) && entry.listened >= 0 ? entry.listened : undefined;
        const existing = histState[hk];
        if (!existing) {
            rev += 1;
            histState[hk] = { ...(l !== undefined ? { l } : {}), _r: rev, _a: 1 };
            changed++;
        } else if (l !== undefined && (existing.l === undefined || l > existing.l)) {
            rev += 1;
            histState[hk] = { ...existing, l, _r: rev, _a: 1 };
            changed++;
        }
    }

    const next = {
        ...store,
        clock,
        rev,
        state: { favorites: favState, playlists: plState, history: histState },
        snapshot: { favorites: [...localFavKeys], playlists: snapPlaylists, keys }
    };
    return { store: trimHistory(next), changed };
};

// Keeps the newest MAX_SYNC_HISTORY plays; the rest fall below the horizon.
const trimHistory = (store) => {
    const entries = Object.entries(store.state.history);
    if (entries.length <= MAX_SYNC_HISTORY) return store;
    const stamped = entries.map(([hk, item]) => [hk, item, parseHistoryKey(hk)?.ts ?? 0]);
    stamped.sort((a, b) => a[2] - b[2] || (a[0] < b[0] ? -1 : 1));
    const drop = stamped.length - MAX_SYNC_HISTORY;
    const kept = stamped.slice(drop);
    const horizon = Math.max(store.horizon, kept[0][2]);
    const history = dict();
    for (const [hk, item] of kept) history[hk] = item;
    return { ...store, horizon, state: { ...store.state, history } };
};

// ---- merge -------------------------------------------------------------------------------------

const stripMeta = (item) => {
    const out = {};
    for (const [k, v] of Object.entries(item)) if (!k.startsWith('_')) out[k] = v;
    return out;
};

export const isValidFavorite = (item) => isPlainObject(item) && typeof item.on === 'boolean' && isHlc(item.t);
export const isValidPlaylist = (item) => isPlainObject(item) && typeof item.name === 'string' && item.name.length <= LIMITS.nameLength &&
    Array.isArray(item.tracks) && item.tracks.every(isKey) &&
    (item.deleted === undefined || item.deleted === true) && isHlc(item.t);
export const isValidPlay = (item) => isPlainObject(item) && (item.l === undefined || (Number.isFinite(item.l) && item.l >= 0));

const sameFavorite = (a, b) => a.on === b.on && compareHlc(a.t, b.t) === 0;
const samePlaylist = (a, b) => a.name === b.name && !!a.deleted === !!b.deleted && arrEq(a.tracks, b.tracks) && compareHlc(a.t, b.t) === 0;
const samePlay = (a, b) => a.l === b.l;

/** Last writer wins; on equal timestamps `a` is kept (values are then equal anyway). */
const lww = (a, b) => (!a ? b : !b ? a : compareHlc(b.t, a.t) > 0 ? b : a);
// Always the canonical { l? } shape, so merging with a missing side strips stray fields too.
const unionPlay = (a, b) => {
    const la = a && Number.isFinite(a.l) ? a.l : undefined;
    const lb = b && Number.isFinite(b.l) ? b.l : undefined;
    const l = la === undefined ? lb : lb === undefined ? la : Math.max(la, lb);
    return l === undefined ? {} : { l };
};

/** Pure merge of two synced states (metadata-free). Commutative, associative, idempotent. */
export const mergeStates = (a, b) => {
    const out = emptyState();
    const af = a.favorites || {}, bf = b.favorites || {};
    const ap = a.playlists || {}, bp = b.playlists || {};
    const ah = a.history || {}, bh = b.history || {};
    for (const k of new Set([...Object.keys(af), ...Object.keys(bf)])) out.favorites[k] = stripMeta(lww(af[k], bf[k]));
    for (const id of new Set([...Object.keys(ap), ...Object.keys(bp)])) out.playlists[id] = stripMeta(lww(ap[id], bp[id]));
    for (const hk of new Set([...Object.keys(ah), ...Object.keys(bh)])) out.history[hk] = stripMeta(unionPlay(ah[hk], bh[hk]));
    return out;
};

export const isDeltaShaped = (delta) =>
    isPlainObject(delta) &&
    (delta.favorites === undefined || isPlainObject(delta.favorites)) &&
    (delta.playlists === undefined || isPlainObject(delta.playlists)) &&
    (delta.history === undefined || isPlainObject(delta.history));

/** Throws SyncLimitError when a delta is too big to even look at. */
export const checkDeltaLimits = (delta) => {
    const favorites = Object.entries(delta.favorites || {});
    const playlists = Object.entries(delta.playlists || {});
    const history = Object.entries(delta.history || {});
    const items = favorites.length + playlists.length + history.length;
    if (items > LIMITS.deltaItems) throw new SyncLimitError(`Delta has ${items} items (limit ${LIMITS.deltaItems})`);
    let bytes = 0;
    for (const [k] of favorites) bytes += k.length;
    for (const [hk] of history) bytes += hk.length;
    for (const [id, item] of playlists) {
        bytes += id.length;
        if (!isPlainObject(item)) continue;
        if (typeof item.name === 'string') bytes += item.name.length;
        if (Array.isArray(item.tracks)) {
            if (item.tracks.length > LIMITS.playlistTracks) throw new SyncLimitError(`Playlist ${id.slice(0, 32)} has ${item.tracks.length} tracks (limit ${LIMITS.playlistTracks})`);
            for (const t of item.tracks) bytes += typeof t === 'string' ? t.length : 0;
        }
    }
    if (bytes > LIMITS.deltaBytes) throw new SyncLimitError(`Delta carries ${bytes} bytes of content (limit ${LIMITS.deltaBytes})`);
};

const checkStoreLimits = (state) => {
    const favorites = Object.keys(state.favorites).length;
    if (favorites > LIMITS.favorites) throw new SyncLimitError(`${favorites} favorites (limit ${LIMITS.favorites})`);
    const playlists = Object.keys(state.playlists).length;
    if (playlists > LIMITS.playlists) throw new SyncLimitError(`${playlists} playlists (limit ${LIMITS.playlists})`);
    let refs = 0;
    for (const item of Object.values(state.playlists)) if (!item.deleted) refs += item.tracks.length;
    if (refs > LIMITS.playlistTrackRefs) throw new SyncLimitError(`${refs} playlist entries (limit ${LIMITS.playlistTrackRefs})`);
};

/**
 * Merges a delta received from a peer into the store. Items that change locally get a new
 * revision (so other peers learn them); items where the peer's version lost also get a new
 * revision so the peer learns the winner in the response. `echo` lists the keys whose merged
 * value equals what the peer sent (the peer already has them and need not get them back).
 * Invalid items are skipped and counted in `rejected`; a delta over LIMITS throws
 * SyncLimitError and merges nothing.
 * @returns {{ store, echo: { favorites: Set, playlists: Set, history: Set }, rejected: number }}
 */
export const applyDelta = (store, delta, now = Date.now()) => {
    if (!isDeltaShaped(delta)) throw new Error('Malformed delta');
    checkDeltaLimits(delta);
    let clock = store.clock;
    let rev = store.rev;
    let rejected = 0;
    const echo = { favorites: new Set(), playlists: new Set(), history: new Set() };
    const favState = copy(store.state.favorites);
    const plState = copy(store.state.playlists);
    const histState = copy(store.state.history);

    const mergeLww = (map, key, incoming, same, echoSet) => {
        clock = receive(clock, incoming.t, now);
        const local = map[key];
        const winner = lww(local, incoming);
        if (winner === incoming) {
            echoSet.add(key);
            if (!local || !same(local, incoming)) { rev += 1; map[key] = { ...incoming, _r: rev }; }
        } else if (same(local, incoming)) {
            echoSet.add(key);
        } else {
            rev += 1;
            map[key] = { ...local, _r: rev };
        }
    };

    for (const [k, item] of Object.entries(delta.favorites || {})) {
        if (!isKey(k) || !isValidFavorite(item)) { rejected++; continue; }
        mergeLww(favState, k, { on: item.on, t: { w: item.t.w, c: item.t.c, d: item.t.d } }, sameFavorite, echo.favorites);
    }
    for (const [id, item] of Object.entries(delta.playlists || {})) {
        if (!isKey(id) || !isValidPlaylist(item)) { rejected++; continue; }
        const clean = { name: item.name, tracks: item.tracks.slice(), t: { w: item.t.w, c: item.t.c, d: item.t.d }, ...(item.deleted ? { deleted: true } : {}) };
        mergeLww(plState, id, clean, samePlaylist, echo.playlists);
    }
    for (const [hk, item] of Object.entries(delta.history || {})) {
        const parsed = parseHistoryKey(hk);
        if (!parsed || !isValidPlay(item)) { rejected++; continue; }
        if (parsed.ts < store.horizon) { echo.history.add(hk); continue; }
        const clean = item.l === undefined ? {} : { l: item.l };
        const local = histState[hk];
        const merged = unionPlay(local, clean);
        if (samePlay(merged, clean)) echo.history.add(hk);
        if (!local) { rev += 1; histState[hk] = { ...merged, _r: rev }; }
        else if (!samePlay(merged, local)) { rev += 1; histState[hk] = { ...local, ...merged, _r: rev }; }
    }

    const state = { favorites: favState, playlists: plState, history: histState };
    checkStoreLimits(state);
    const next = trimHistory({ ...store, clock, rev, state });
    return { store: next, echo, rejected };
};

/** Items changed after revision `since`, without local metadata; `echo` keys are left out. */
export const buildDelta = (store, since = 0, echo = null) => {
    const pick = (map, echoSet) => {
        const out = {};
        for (const [k, item] of Object.entries(map)) {
            if (item._r > since && !(echoSet && echoSet.has(k))) out[k] = stripMeta(item);
        }
        return out;
    };
    return {
        favorites: pick(store.state.favorites, echo?.favorites),
        playlists: pick(store.state.playlists, echo?.playlists),
        history: pick(store.state.history, echo?.history)
    };
};

export const deltaSize = (delta) =>
    Object.keys(delta.favorites || {}).length + Object.keys(delta.playlists || {}).length + Object.keys(delta.history || {}).length;

// ---- apply: synced state -> app state ---------------------------------------------------------

/**
 * Inserts synced plays into a stats object (chronological order, MAX_PLAY_HISTORY trim with
 * archiving as in playHistory.js). Returns `prev` untouched when there is nothing to add.
 */
export const applyPlaysToStats = (prev, entries) => {
    if (!entries || entries.length === 0) return prev;
    const history = prev?.playHistory || [];
    const present = new Set(history.map(e => `${e.trackKey || e.path}@${e.timestamp}`));
    const fresh = entries.filter(e => !present.has(`${e.trackKey}@${e.timestamp}`));
    if (fresh.length === 0) return prev;
    const playHistory = [...history, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
    const stats = { ...prev, playHistory };
    if (playHistory.length > MAX_PLAY_HISTORY) {
        const dropped = playHistory.splice(0, playHistory.length - MAX_PLAY_HISTORY);
        const archivedCounts = { ...(prev.archivedCounts || {}) };
        dropped.forEach(play => { archivedCounts[play.path] = (archivedCounts[play.path] || 0) + 1; });
        stats.archivedCounts = archivedCounts;
        stats.archivedCount = (prev.archivedCount || 0) + dropped.length;
    }
    return stats;
};

export const emptyOps = () => ({ favorites: { add: [], remove: [] }, playlists: { upsert: [], remove: [] }, plays: [], keyed: new Set() });

/** Applies favorite ops to a favorites list; returns `prev` when nothing changes. */
export const applyFavoriteOps = (prev, ops) => {
    const { add, remove } = ops.favorites;
    if (add.length === 0 && remove.length === 0) return prev;
    const removeSet = new Set(remove);
    const next = prev.filter(p => !removeSet.has(p));
    const have = new Set(next);
    for (const p of add) if (!have.has(p)) { have.add(p); next.push(p); }
    return arrEq(next, prev) ? prev : next;
};

/**
 * Applies playlist ops: deletes, updates in place (keeping local paths that have no key and
 * were therefore never part of the synced list) and appends new playlists. Returns `prev`
 * when nothing changes.
 */
export const applyPlaylistOps = (prev, ops) => {
    const { upsert, remove } = ops.playlists;
    if (upsert.length === 0 && remove.length === 0) return prev;
    const removeSet = new Set(remove);
    const pending = new Map(upsert.map(u => [u.id, u]));
    let changed = false;
    const next = [];
    for (const pl of prev) {
        if (pl && removeSet.has(pl.id)) { changed = true; continue; }
        const u = pl ? pending.get(pl.id) : null;
        if (!u) { next.push(pl); continue; }
        pending.delete(pl.id);
        const songSet = new Set(u.songs);
        const unkeyed = (pl.songs || []).filter(p => !ops.keyed.has(p) && !songSet.has(p));
        next.push({ ...pl, name: u.name, songs: [...u.songs, ...unkeyed] });
        changed = true;
    }
    for (const u of pending.values()) { next.push({ id: u.id, name: u.name, songs: u.songs.slice() }); changed = true; }
    return changed ? next : prev;
};

/**
 * Writes the synced state back into the app's shape. `captureLocal` must have run on the
 * same `local` first. Returns the ops, the new favorites/playlists computed against `local`
 * (same references when unchanged), a `statsUpdater(prev)` for the play history, the updated
 * store (snapshot, `_a` flags) and a report with counts.
 */
export const applyToLocal = (store, local) => {
    const { songs = [], favorites = [], playlists = [], stats = {} } = local;
    const { pathToKey, keyToPath } = libraryIndex(songs, store.snapshot.keys);
    const unmatched = new Set();
    const report = { favoritesAdded: 0, favoritesRemoved: 0, playlistsCreated: 0, playlistsUpdated: 0, playlistsDeleted: 0, playsAdded: 0, unmatched: 0 };
    const keys = copy(store.snapshot.keys);
    const ops = emptyOps();
    ops.keyed = new Set(pathToKey.keys());

    // Favorites
    const favKeys = new Set(favorites.map(p => pathToKey.get(p)).filter(Boolean));
    for (const [k, item] of Object.entries(store.state.favorites)) {
        const path = keyToPath.get(k);
        if (!path) { if (item.on) unmatched.add(k); continue; }
        if (item.on && !favKeys.has(k)) {
            ops.favorites.add.push(path); favKeys.add(k); keys[path] = k; report.favoritesAdded++;
        } else if (!item.on && favKeys.has(k)) {
            for (const p of favorites) if (pathToKey.get(p) === k) ops.favorites.remove.push(p);
            favKeys.delete(k); report.favoritesRemoved++;
        }
    }
    const nextFavorites = applyFavoriteOps(favorites, ops);

    // Playlists
    const snapPlaylists = copy(store.snapshot.playlists);
    const localIds = new Set(playlists.filter(Boolean).map(p => p.id));
    for (const [id, item] of Object.entries(store.state.playlists)) {
        const exists = localIds.has(id);
        const snap = snapPlaylists[id];
        if (item.deleted) {
            if (exists) { ops.playlists.remove.push(id); report.playlistsDeleted++; }
            delete snapPlaylists[id];
            continue;
        }
        const mapped = [];
        const applied = [];
        const seenPaths = new Set();
        for (const k of item.tracks) {
            const path = keyToPath.get(k);
            if (!path) { unmatched.add(k); continue; }
            if (seenPaths.has(path)) continue;
            seenPaths.add(path); mapped.push(path); applied.push(k);
        }
        // Unchanged since the last apply/capture, and every track that can be applied already
        // was: nothing to do. (A track the library gained since shows up as a longer `applied`.)
        if (exists && snap && snap.name === item.name && arrEq(snap.tracks, item.tracks) && arrEq(snap.applied, applied)) continue;
        for (let i = 0; i < mapped.length; i++) keys[mapped[i]] = applied[i];
        ops.playlists.upsert.push({ id, name: item.name, songs: mapped });
        if (exists) report.playlistsUpdated++; else report.playlistsCreated++;
        snapPlaylists[id] = { name: item.name, tracks: item.tracks.slice(), applied };
    }
    const nextPlaylists = applyPlaylistOps(playlists, ops);

    // Play history
    const histState = copy(store.state.history);
    for (const [hk, item] of Object.entries(histState)) {
        if (item._a) continue;
        const parsed = parseHistoryKey(hk);
        if (!parsed) continue;
        const path = keyToPath.get(parsed.k);
        if (!path) { unmatched.add(parsed.k); continue; }
        const entry = { path, timestamp: parsed.ts, trackKey: parsed.k };
        if (item.l !== undefined) entry.listened = item.l;
        ops.plays.push(entry);
        histState[hk] = { ...item, _a: 1 };
    }
    report.playsAdded = ops.plays.length;
    report.unmatched = unmatched.size;

    const snapshotFavorites = [];
    const snapSeen = new Set();
    for (const p of nextFavorites) { const k = pathToKey.get(p) || keys[p]; if (k && !snapSeen.has(k)) { snapSeen.add(k); snapshotFavorites.push(k); } }

    return {
        store: { ...store, state: { ...store.state, history: histState }, snapshot: { favorites: snapshotFavorites, playlists: snapPlaylists, keys } },
        ops,
        favorites: nextFavorites,
        playlists: nextPlaylists,
        statsUpdater: (prev) => applyPlaysToStats(prev, ops.plays),
        stats: applyPlaysToStats(stats, ops.plays),
        report
    };
};

// ---- exchange --------------------------------------------------------------------------------

/**
 * Client side, step 1: capture local changes and build the request for `peer`
 * ({ seenRev: the peer's revision we last received, pushedRev: our revision it last got }).
 */
export const clientRequest = ({ store, local, peer, now = Date.now() }) => {
    const captured = captureLocal(store, local, now);
    const delta = buildDelta(captured.store, peer?.pushedRev || 0);
    return { store: captured.store, request: { since: peer?.seenRev || 0, delta } };
};

/** Client side, step 2: merge the response, apply it, and advance the peer's watermarks. */
export const clientReceive = ({ store, local, peer, response, now = Date.now() }) => {
    if (!isPlainObject(response) || !Number.isInteger(response.rev) || response.rev < 0 || !isDeltaShaped(response.delta)) {
        throw new Error('Malformed sync response');
    }
    const merged = applyDelta(store, response.delta, now);
    const applied = applyToLocal(merged.store, local);
    return {
        store: applied.store,
        peer: { ...(peer || {}), seenRev: response.rev, pushedRev: applied.store.rev },
        ops: applied.ops,
        favorites: applied.favorites,
        playlists: applied.playlists,
        statsUpdater: applied.statsUpdater,
        stats: applied.stats,
        report: { ...applied.report, received: deltaSize(response.delta), rejected: merged.rejected }
    };
};

/** Server side: one complete exchange. */
export const serverExchange = ({ store, local, request, now = Date.now() }) => {
    if (!isPlainObject(request) || !isDeltaShaped(request.delta)) throw new Error('Malformed sync request');
    const captured = captureLocal(store, local, now);
    const since = Number.isInteger(request.since) && request.since >= 0 && request.since <= captured.store.rev ? request.since : 0;
    const merged = applyDelta(captured.store, request.delta, now);
    const applied = applyToLocal(merged.store, local);
    return {
        store: applied.store,
        response: { rev: applied.store.rev, delta: buildDelta(applied.store, since, merged.echo) },
        ops: applied.ops,
        favorites: applied.favorites,
        playlists: applied.playlists,
        statsUpdater: applied.statsUpdater,
        stats: applied.stats,
        report: { ...applied.report, received: deltaSize(request.delta), rejected: merged.rejected }
    };
};

/** The synced state without local metadata (tests, diagnostics). */
export const exportState = (store) => mergeStates(store.state, emptyState());

/** Counts for the UI: how many synced items have no track in this library. */
export const countUnmatched = (store, songs) => {
    const { keyToPath } = libraryIndex(songs, store.snapshot.keys);
    const keys = new Set();
    for (const [k, item] of Object.entries(store.state.favorites)) if (item.on && !keyToPath.has(k)) keys.add(k);
    for (const item of Object.values(store.state.playlists)) if (!item.deleted) for (const k of item.tracks) if (!keyToPath.has(k)) keys.add(k);
    for (const [hk, item] of Object.entries(store.state.history)) {
        if (item._a) continue;
        const parsed = parseHistoryKey(hk);
        if (parsed && !keyToPath.has(parsed.k)) keys.add(parsed.k);
    }
    return keys.size;
};
