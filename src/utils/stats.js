// Play counts per song path over the whole lifetime of the stats: the plays still in
// `playHistory` plus the ones that were trimmed from it and folded into `archivedCounts`.
export const lifetimePlayCounts = (stats) => {
    const counts = { ...(stats?.archivedCounts || {}) };
    (stats?.playHistory || []).forEach(play => {
        counts[play.path] = (counts[play.path] || 0) + 1;
    });
    return counts;
};
