// Play-history bookkeeping kept out of App.jsx.
//
// Entry shape: { path, timestamp, trackKey, listened }
//   - path/timestamp: as before (older saved entries only have these two). `path` is always
//     recorded; it is the per-device identity.
//   - trackKey: cross-device identity of the song (#25 sync, #27 recap). Only written once
//     the song is no longer provisional (Android rows are returned before the file has been
//     probed and their key can still change); `backfillTrackKeys` fills it in later.
//   - listened: seconds the track actually played (#27 "hours listened"), written when the
//     track pauses, ends or is replaced; undefined until then.

export const MAX_PLAY_HISTORY = 10000;

/** The key to persist for `song`, or null while the song is still provisional. */
const finalTrackKey = (song) => (song && song.trackKey && !song.provisional ? song.trackKey : null);

/**
 * Appends a play to `stats`. When the timestamped history outgrows MAX_PLAY_HISTORY the
 * oldest entries are folded into `archivedCounts` / `archivedCount`, so lifetime totals
 * survive the trim (only the time-windowed views lose those plays).
 * @returns {{ stats: Object, entry: Object }}
 */
export const appendPlay = (prev, song, timestamp = Date.now()) => {
    const entry = { path: song.path, timestamp };
    const trackKey = finalTrackKey(song);
    if (trackKey) entry.trackKey = trackKey;

    const playHistory = [...(prev.playHistory || []), entry];
    if (playHistory.length <= MAX_PLAY_HISTORY) return { stats: { ...prev, playHistory }, entry };

    const dropped = playHistory.splice(0, playHistory.length - MAX_PLAY_HISTORY);
    const archivedCounts = { ...(prev.archivedCounts || {}) };
    dropped.forEach(play => { archivedCounts[play.path] = (archivedCounts[play.path] || 0) + 1; });
    return {
        stats: {
            ...prev,
            playHistory,
            archivedCounts,
            archivedCount: (prev.archivedCount || 0) + dropped.length
        },
        entry
    };
};

/**
 * Stores `listened` seconds on the entry identified by (path, timestamp). Searches from the
 * end because the entry being finalised is almost always the last one. Returns `prev`
 * untouched when the entry is gone (trimmed) or the value did not change.
 */
export const setListened = (prev, entryRef, listenedSeconds) => {
    if (!entryRef) return prev;
    const history = prev.playHistory || [];
    const listened = Math.max(0, Math.round(listenedSeconds));
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry.timestamp !== entryRef.timestamp || entry.path !== entryRef.path) continue;
        if (entry.listened === listened) return prev;
        const playHistory = history.slice();
        playHistory[i] = { ...entry, listened };
        return { ...prev, playHistory };
    }
    return prev;
};

/**
 * Fills `trackKey` on history entries that lack one (plays of provisional songs, or entries
 * saved before keys existed) from the current library, matched by path. Only songs whose
 * details are final are used. Returns `prev` untouched when nothing changes.
 */
export const backfillTrackKeys = (prev, songs) => {
    const history = prev?.playHistory;
    if (!Array.isArray(history) || history.length === 0 || !Array.isArray(songs) || songs.length === 0) return prev;

    let keys = null;   // path -> trackKey, built lazily: most calls find nothing to fill
    let playHistory = null;
    for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (!entry || entry.trackKey || !entry.path) continue;
        if (keys === null) {
            keys = new Map();
            for (const song of songs) {
                const key = finalTrackKey(song);
                if (key && song.path) keys.set(song.path, key);
            }
            if (keys.size === 0) return prev;
        }
        const trackKey = keys.get(entry.path);
        if (!trackKey) continue;
        if (playHistory === null) playHistory = history.slice();
        playHistory[i] = { ...entry, trackKey };
    }
    return playHistory === null ? prev : { ...prev, playHistory };
};

/**
 * Accumulates wall-clock playing time for the current play. Cheap: two numbers, no timers.
 *   start() on 'play', stop() on 'pause' / 'ended', reset() when a new track begins,
 *   seconds() at any time for the value to store.
 */
export class ListenTimer {
    constructor(now = () => Date.now()) {
        this.now = now;
        this.accumulatedMs = 0;
        this.startedAt = null;
    }

    start() {
        if (this.startedAt === null) this.startedAt = this.now();
    }

    stop() {
        if (this.startedAt !== null) {
            this.accumulatedMs += Math.max(0, this.now() - this.startedAt);
            this.startedAt = null;
        }
    }

    reset() {
        this.accumulatedMs = 0;
        this.startedAt = null;
    }

    seconds() {
        const running = this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt);
        return (this.accumulatedMs + running) / 1000;
    }
}
