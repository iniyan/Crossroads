// Crossroads Wrapped (#27): listening recap for a week / month / year, aggregated from the
// local play history. Pure: no I/O, no React, local time throughout.
//
// Entries are keyed by `trackKey` when present, else `path`, and resolved against the
// current library by either; songs that are no longer in the library still count (title
// from the file name, quality 'unknown'). Listening time comes from each entry's `listened`
// seconds; entries recorded before that field existed fall back to the song's duration and
// the result is flagged `estimated`.
//
// Periods
//   week   ISO week, Monday 00:00 local to next Monday 00:00 local
//   month  1st 00:00 local to 1st of next month
//   year   Jan 1 to Jan 1
// All boundaries are built with new Date(y, m, d) so DST changes never shift them.

export const PERIOD_KINDS = Object.freeze(['week', 'month', 'year']);
export const WEEKDAY_LABELS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TOP_N = 10;

/** Monday-based weekday index (Mon = 0 ... Sun = 6). */
export const weekdayIndex = (date) => (date.getDay() + 6) % 7;

const startOfWeek = (date) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - weekdayIndex(d));
};

/** ISO-8601 week number and week-year of a local date. */
export const isoWeek = (date) => {
    // Thursday of the same ISO week decides the year.
    const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - weekdayIndex(date) + 3);
    const year = thursday.getFullYear();
    const firstThursday = new Date(year, 0, 4);
    const firstWeekStart = startOfWeek(firstThursday);
    const week = 1 + Math.round((startOfWeek(thursday) - firstWeekStart) / (7 * 24 * 3600 * 1000));
    return { year, week };
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day key 'YYYY-MM-DD'. */
export const dayKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const shortDate = (date) => `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;

/**
 * The period of `kind` containing `anchor` (a Date or ms timestamp).
 * @returns {{ kind, start: Date, end: Date, key: string, label: string, sublabel: string }}  end is exclusive
 */
export const periodOf = (kind, anchor = Date.now()) => {
    const date = anchor instanceof Date ? anchor : new Date(anchor);
    if (kind === 'week') {
        const start = startOfWeek(date);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
        const { year, week } = isoWeek(start);
        const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
        return {
            kind, start, end,
            key: `${year}-W${pad2(week)}`,
            label: `Week ${week}, ${year}`,
            sublabel: `${shortDate(start)} – ${shortDate(last)}${start.getFullYear() !== last.getFullYear() ? ` ${last.getFullYear()}` : ''}`
        };
    }
    if (kind === 'month') {
        const start = new Date(date.getFullYear(), date.getMonth(), 1);
        const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
        return {
            kind, start, end,
            key: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`,
            label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}`,
            sublabel: `${shortDate(start)} – ${shortDate(new Date(end - 1))}`
        };
    }
    const start = new Date(date.getFullYear(), 0, 1);
    const end = new Date(date.getFullYear() + 1, 0, 1);
    return { kind: 'year', start, end, key: String(start.getFullYear()), label: String(start.getFullYear()), sublabel: 'The whole year' };
};

/** The period `delta` steps after (`+`) or before (`-`) `period`. */
export const shiftPeriod = (period, delta) => {
    const { start, kind } = period;
    if (kind === 'week') return periodOf(kind, new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * delta));
    if (kind === 'month') return periodOf(kind, new Date(start.getFullYear(), start.getMonth() + delta, 1));
    return periodOf(kind, new Date(start.getFullYear() + delta, 0, 1));
};

/**
 * Selectable periods of `kind`, newest first: from the current one back to the one holding
 * the oldest play (capped at `limit`). The current period is always included.
 */
export const availablePeriods = (history, kind, { now = Date.now(), limit = 60 } = {}) => {
    const periods = [];
    let period = periodOf(kind, now);
    let oldest = Infinity;
    (history || []).forEach(entry => { if (entry && Number.isFinite(entry.timestamp) && entry.timestamp < oldest) oldest = entry.timestamp; });
    for (let i = 0; i < limit; i++) {
        periods.push(period);
        if (!Number.isFinite(oldest) || period.start.getTime() <= oldest) break;
        period = shiftPeriod(period, -1);
    }
    return periods;
};

const basename = (path) => {
    const name = String(path || '').split(/[\\/]/).pop() || '';
    return name.replace(/\.[^.]+$/, '') || 'Unknown track';
};

const extension = (path) => {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
    return match ? match[1].toUpperCase() : null;
};

const entryKey = (entry) => entry.trackKey || entry.path;

/** Track-level facts for an entry, from the library when the song still exists. */
const describe = (entry, song) => {
    if (song) {
        return {
            key: entryKey(entry),
            song,
            title: song.title || basename(song.path),
            artist: song.artist || 'Unknown Artist',
            album: song.album || 'Unknown Album',
            albumArtist: song.albumArtist || song.artist || 'Unknown Artist',
            composer: song.composer || '',
            format: song.format || extension(song.path) || 'Unknown',
            tier: song.quality?.tier || 'unknown',
            duration: Number.isFinite(song.duration) && song.duration > 0 ? song.duration : null,
            picture: song.picture || null,
            missing: false
        };
    }
    return {
        key: entryKey(entry),
        song: null,
        title: basename(entry.path),
        artist: 'Unknown Artist',
        album: 'Unknown Album',
        albumArtist: 'Unknown Artist',
        composer: '',
        format: extension(entry.path) || 'Unknown',
        tier: 'unknown',
        duration: null,
        picture: null,
        missing: true
    };
};

const bump = (map, key, make, seconds, estimated) => {
    let item = map.get(key);
    if (!item) { item = { ...make(), plays: 0, seconds: 0, estimated: false }; map.set(key, item); }
    item.plays += 1;
    item.seconds += seconds;
    if (estimated) item.estimated = true;
    return item;
};

const top = (map, by) => Array.from(map.values())
    .sort((a, b) => (b[by] - a[by]) || (b.plays - a.plays) || (b.seconds - a.seconds) || a.name.localeCompare(b.name))
    .slice(0, TOP_N);

/** Longest run of consecutive local days in a set of 'YYYY-MM-DD' keys. */
export const longestStreak = (dayKeys) => {
    const days = Array.from(dayKeys).sort();
    if (days.length === 0) return { days: 0, start: null, end: null };
    let best = { days: 1, start: days[0], end: days[0] };
    let runStart = days[0];
    let runLength = 1;
    for (let i = 1; i < days.length; i++) {
        const [y, m, d] = days[i - 1].split('-').map(Number);
        const next = dayKey(new Date(y, m - 1, d + 1));
        if (days[i] === next) runLength += 1;
        else { runStart = days[i]; runLength = 1; }
        if (runLength > best.days) best = { days: runLength, start: runStart, end: days[i] };
    }
    return best;
};

/**
 * @param {{ stats: Object, songs: Array, period: Object, sortBy?: 'plays'|'seconds' }} input
 * @returns the recap (see the fields below); `plays` is 0 for an empty period
 */
export const computeWrapped = ({ stats, songs, period }) => {
    const history = Array.isArray(stats?.playHistory) ? stats.playHistory : [];
    const startMs = period.start.getTime();
    const endMs = period.end.getTime();

    const byKey = new Map();
    const byPath = new Map();
    (songs || []).forEach(song => {
        if (!song) return;
        if (song.trackKey && !byKey.has(song.trackKey)) byKey.set(song.trackKey, song);
        if (song.path) byPath.set(song.path, song);
    });
    const resolve = (entry) => (entry.trackKey && byKey.get(entry.trackKey)) || byPath.get(entry.path) || null;

    // Keys (and paths) played before the period, for "new discoveries". Archived plays are
    // older than everything in the history, so an archived path was heard before too.
    const seenBefore = new Set(Object.keys(stats?.archivedCounts || {}));

    const tracks = new Map();
    const albums = new Map();
    const artists = new Map();
    const composers = new Map();
    const formats = new Map();
    const byTier = { hires: 0, cd: 0, lossy: 0, unknown: 0 };
    const byHour = new Array(24).fill(0);
    const byWeekday = new Array(7).fill(0);
    const days = new Set();
    const firstPlayInPeriod = new Map();   // key -> track (candidate discoveries, in play order)
    let plays = 0;
    let totalSeconds = 0;
    let estimatedSeconds = 0;
    let estimatedPlays = 0;

    for (const entry of history) {
        if (!entry || !Number.isFinite(entry.timestamp)) continue;
        const key = entryKey(entry);
        if (!key) continue;
        if (entry.timestamp < startMs) {
            seenBefore.add(key);
            if (entry.path) seenBefore.add(entry.path);
            continue;
        }
        if (entry.timestamp >= endMs) continue;

        const song = resolve(entry);
        const track = describe(entry, song);
        let seconds;
        let estimated = false;
        if (Number.isFinite(entry.listened) && entry.listened >= 0) {
            seconds = entry.listened;
        } else {
            seconds = track.duration || 0;
            estimated = true;
            estimatedPlays += 1;
            estimatedSeconds += seconds;
        }

        plays += 1;
        totalSeconds += seconds;
        byTier[byTier[track.tier] === undefined ? 'unknown' : track.tier] += seconds;
        const when = new Date(entry.timestamp);
        byHour[when.getHours()] += seconds;
        byWeekday[weekdayIndex(when)] += seconds;
        days.add(dayKey(when));

        const item = bump(tracks, key, () => ({ name: track.title, ...track }), seconds, estimated);
        item.lastPlayed = entry.timestamp;
        bump(albums, `${track.albumArtist}\u0000${track.album}`, () => ({ name: track.album, artist: track.albumArtist, picture: track.picture, tracks: new Set() }), seconds, estimated).tracks.add(key);
        bump(artists, track.artist, () => ({ name: track.artist, picture: track.picture, tracks: new Set() }), seconds, estimated).tracks.add(key);
        if (track.composer) bump(composers, track.composer, () => ({ name: track.composer }), seconds, estimated);
        bump(formats, track.format, () => ({ name: track.format }), seconds, estimated);

        if (!firstPlayInPeriod.has(key)) firstPlayInPeriod.set(key, { ...track, firstPlayed: entry.timestamp });
    }

    const discoveries = [];
    firstPlayInPeriod.forEach((track, key) => {
        if (seenBefore.has(key) || (track.song && track.song.path && seenBefore.has(track.song.path))) return;
        discoveries.push({ ...track, plays: tracks.get(key).plays, seconds: tracks.get(key).seconds });
    });
    discoveries.sort((a, b) => a.firstPlayed - b.firstPlayed);

    const finish = (list) => list.map(item => ({ ...item, tracks: item.tracks ? item.tracks.size : undefined }));
    const formatList = top(formats, 'seconds');

    return {
        period,
        plays,
        totalSeconds,
        estimated: estimatedPlays > 0,
        estimatedSeconds,
        estimatedPlays,
        byTier,
        byHour,
        byWeekday,
        activeDays: days.size,
        uniqueTracks: tracks.size,
        uniqueAlbums: albums.size,
        uniqueArtists: artists.size,
        topTracks: { byPlays: top(tracks, 'plays'), byTime: top(tracks, 'seconds') },
        topAlbums: { byPlays: finish(top(albums, 'plays')), byTime: finish(top(albums, 'seconds')) },
        topArtists: { byPlays: finish(top(artists, 'plays')), byTime: finish(top(artists, 'seconds')) },
        topComposers: { byPlays: top(composers, 'plays'), byTime: top(composers, 'seconds') },
        discoveries: discoveries.slice(0, TOP_N),
        discoveryCount: discoveries.length,
        longestStreak: longestStreak(days),
        topFormat: formatList[0] || null,
        formats: formatList,
        peakHour: byHour.reduce((best, seconds, hour) => (seconds > byHour[best] ? hour : best), 0),
        peakWeekday: byWeekday.reduce((best, seconds, day) => (seconds > byWeekday[best] ? day : best), 0)
    };
};

/** "12.5 h", "48 min", "35 s" */
export const formatHours = (seconds) => {
    const s = Number(seconds) || 0;
    if (s >= 3600) return `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)} h`;
    if (s >= 60) return `${Math.round(s / 60)} min`;
    return `${Math.round(s)} s`;
};
