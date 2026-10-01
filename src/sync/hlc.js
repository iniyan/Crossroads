// Hybrid logical clock (#25 sync). A timestamp is { w: wall ms, c: counter, d: deviceId };
// timestamps are totally ordered (w, then c, then d) so last-writer-wins is deterministic on
// every device regardless of the order in which changes arrive.
//
// Clock skew: a device whose wall clock runs ahead stamps larger `w`, so its concurrent
// edits win; once its timestamps are received, the other device's clock jumps forward
// (`receive`) and its later edits win again. Nothing is rejected: an offline phone with a
// wrong clock must still be able to sync.

export const compareHlc = (a, b) => {
    if (a.w !== b.w) return a.w < b.w ? -1 : 1;
    if (a.c !== b.c) return a.c < b.c ? -1 : 1;
    if (a.d === b.d) return 0;
    return a.d < b.d ? -1 : 1;
};

export const isHlc = (t) =>
    !!t && typeof t === 'object' &&
    Number.isInteger(t.w) && t.w >= 0 &&
    Number.isInteger(t.c) && t.c >= 0 &&
    typeof t.d === 'string' && t.d.length > 0 && t.d.length <= 128;

export const createClock = (deviceId, saved = null) => ({
    w: Number.isInteger(saved?.w) && saved.w >= 0 ? saved.w : 0,
    c: Number.isInteger(saved?.c) && saved.c >= 0 ? saved.c : 0,
    d: deviceId
});

/** Advances the clock for a local event. Returns the new clock, which is also the timestamp. */
export const tick = (clock, now) => {
    const wall = Math.max(0, Math.floor(now));
    if (wall > clock.w) return { w: wall, c: 0, d: clock.d };
    return { w: clock.w, c: clock.c + 1, d: clock.d };
};

/** Advances the clock past a timestamp received from another device. */
export const receive = (clock, remote, now) => {
    const wall = Math.max(0, Math.floor(now));
    const w = Math.max(clock.w, remote.w, wall);
    let c;
    if (w === clock.w && w === remote.w) c = Math.max(clock.c, remote.c) + 1;
    else if (w === clock.w) c = clock.c + 1;
    else if (w === remote.w) c = remote.c + 1;
    else c = 0;
    return { w, c, d: clock.d };
};
