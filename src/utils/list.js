// Small shared list helpers.

/** Fisher-Yates shuffle; returns a new array. */
export const shuffled = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/** plural(3, 'track') -> '3 tracks'. */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Disc number, then track number; 0 when equal (callers add their own tie-break). */
export const compareDiscTrack = (a, b) =>
    ((a.discNumber || 0) - (b.discNumber || 0)) || ((a.trackNumber || 0) - (b.trackNumber || 0));
