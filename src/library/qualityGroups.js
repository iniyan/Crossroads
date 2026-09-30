// Pure helpers for browsing by quality tier (Hi-Res / CD / Lossy): album-level aggregation,
// tier counts and the Library filter model. Songs whose quality is 'unknown' (Android rows
// that are still `provisional`) never count towards a tier; they are reported separately.

export const TIER_NAMES = Object.freeze({ hires: 'Hi-Res', cd: 'CD', lossy: 'Lossy', unknown: '' });

// Higher is better. 'unknown' is deliberately absent.
const RANK = { lossy: 0, cd: 1, hires: 2 };

export const FILTER_TIERS = Object.freeze(['all', 'hires', 'cd', 'lossy']);
export const DEFAULT_FILTERS = Object.freeze({ tier: 'all', losslessOnly: false });

export const songTier = (song) => {
    const tier = song?.quality?.tier;
    return tier in RANK ? tier : 'unknown';
};

/** { hires, cd, lossy, unknown } track counts. */
export const tierCounts = (songs) => {
    const counts = { hires: 0, cd: 0, lossy: 0, unknown: 0 };
    for (const song of songs || []) counts[songTier(song)] += 1;
    return counts;
};

/** "12 Hi-Res · 3 CD" (known tiers only, best first); '' when nothing is known. */
export const describeTierCounts = (counts) =>
    ['hires', 'cd', 'lossy']
        .filter(t => counts[t] > 0)
        .map(t => `${counts[t]} ${TIER_NAMES[t]}`)
        .join(' · ');

/**
 * Album-level quality: the LOWEST tier among the tracks that have a known tier.
 * `label` is the shared badge label when every track of that tier has the same one
 * (e.g. 'FLAC 24/96'), otherwise the tier name. `mixed` is true when known tiers differ.
 * Returns tier 'unknown' (empty label) when no track has a known tier yet.
 * @returns {{ tier: string, label: string, mixed: boolean, tiers: string[], unknown: number, breakdown: string }}
 */
export const albumQuality = (songs) => {
    const known = (songs || []).filter(s => songTier(s) !== 'unknown');
    const unknown = (songs || []).length - known.length;
    if (known.length === 0) return { tier: 'unknown', label: '', mixed: false, tiers: [], unknown };
    const tiers = [...new Set(known.map(songTier))].sort((a, b) => RANK[b] - RANK[a]);
    const lowest = tiers[tiers.length - 1];
    const labels = new Set(known.filter(s => songTier(s) === lowest).map(s => s.quality?.label || ''));
    const single = labels.size === 1 ? [...labels][0] : '';
    return {
        tier: lowest,
        label: single || TIER_NAMES[lowest],
        mixed: tiers.length > 1,
        tiers,
        unknown,
        breakdown: describeTierCounts(tierCounts(known))
    };
};

export const normalizeFilters = (raw) => ({
    tier: FILTER_TIERS.includes(raw?.tier) ? raw.tier : 'all',
    losslessOnly: raw?.losslessOnly === true
});

/** Whether one song passes the filters. Songs with unknown quality only pass the defaults. */
export const matchesQualityFilter = (song, filters) => {
    const { tier, losslessOnly } = normalizeFilters(filters);
    if (tier !== 'all' && songTier(song) !== tier) return false;
    if (losslessOnly && song?.lossless !== true) return false;
    return true;
};

/**
 * Album-level filter, consistent with the album badge: a tier chip matches when the album's
 * own tier (lowest known tier among its tracks) equals the chip; "Lossless only" needs at
 * least one known track and every known track lossless. Pass a precomputed albumQuality()
 * result as `quality` to avoid recomputing it.
 */
export const albumMatchesFilter = (songs, filters, quality = albumQuality(songs)) => {
    const f = normalizeFilters(filters);
    if (f.tier === 'all' && !f.losslessOnly) return true;
    if (f.tier !== 'all' && quality.tier !== f.tier) return false;
    if (f.losslessOnly) {
        const known = (songs || []).filter(s => songTier(s) !== 'unknown');
        if (known.length === 0 || !known.every(s => s.lossless === true)) return false;
    }
    return true;
};
