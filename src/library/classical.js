// Classical music helpers: work / movement / conductor / performer extraction from tags,
// grouping of tracks into works, recordings and composers. Pure (no DOM, no platform).
import { firstTag, firstTagOf, tagValues, parseNumberPair } from './tags.js';
import { normalizeText } from './trackKey.js';
import { compareDiscTrack } from '../utils/list.js';

export const UNKNOWN_COMPOSER = 'Unknown Composer';

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
/** 'IV' -> 4, 'xii' -> 12, anything else -> null. */
export const parseRoman = (text) => {
    const s = String(text || '').trim().toUpperCase();
    if (!/^[IVXLC]+$/.test(s)) return null;
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const v = ROMAN[s[i]];
        total += v < (ROMAN[s[i + 1]] || 0) ? -v : v;
    }
    return total > 0 ? total : null;
};

const parseMovement = (value) => {
    const pair = parseNumberPair(value);
    if (pair.number !== null) return pair;
    const n = parseRoman(String(value || '').replace(/[.)]$/, ''));
    return { number: n, total: null };
};

/** 'Martha Argerich (piano)' -> { name, role }. */
export const parsePerformer = (value) => {
    const text = String(value || '').trim();
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(text);
    return m && m[1] ? { name: m[1].trim(), role: m[2].trim() } : { name: text, role: '' };
};

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * Structured classical metadata of one song, from its tags only.
 * `hasWork` is true when a WORK tag exists; `hasClassical` when any classical tag does.
 */
export const classicalInfo = (song) => {
    const tags = song?.tags || {};
    const composer = (song?.composer || firstTag(tags, 'COMPOSER') || '').trim();
    const work = (firstTag(tags, 'WORK') || '').trim();
    const movementName = (firstTag(tags, 'MOVEMENTNAME') || '').trim();
    const mv = parseMovement(firstTag(tags, 'MOVEMENT'));
    const total = parseNumberPair(firstTag(tags, 'MOVEMENTTOTAL')).number ?? mv.total;
    const conductor = uniq(tagValues(tags, 'CONDUCTOR').map(s => s.trim())).join(', ');
    const ensemble = (firstTagOf(tags, ['ENSEMBLE', 'ORCHESTRA']) || '').trim();
    const performers = tagValues(tags, 'PERFORMER').map(parsePerformer).filter(p => p.name);
    return {
        composer, work, movementName,
        movementNumber: mv.number, movementTotal: total,
        conductor, ensemble, performers,
        hasWork: work !== '',
        hasClassical: !!(composer || work || movementName || conductor || ensemble || performers.length)
    };
};

const CLASSICAL_GENRE = /classical|opera|baroque|chamber/i;

/**
 * Tag-level "is classical" test: a WORK or MOVEMENTNAME tag, or a classical-ish GENRE.
 * A bare COMPOSER credit is not enough (pop songwriters are tagged too).
 */
export const isClassicalTagged = (song) => {
    const tags = song?.tags || {};
    if ((firstTag(tags, 'WORK') || '').trim() || (firstTag(tags, 'MOVEMENTNAME') || '').trim()) return true;
    const genres = [song?.genre, ...tagValues(tags, 'GENRE')];
    return genres.some(g => CLASSICAL_GENRE.test(String(g || '')));
};

/** True when the library holds any classical songs: gates the Composers nav entry. */
export const hasClassicalMusic = (songs) => buildClassicalIndex(songs).length > 0;

/** Title for track rows: 'Work — Movement' when both are tagged, else the plain title. */
export const trackDisplayTitle = (song) => {
    const info = classicalInfo(song);
    if (info.work && info.movementName) return `${info.work} — ${info.movementName}`;
    return song?.title || '';
};

/** 'Claudio Abbado · Berliner Philharmoniker · Martha Argerich (piano)'; '' when nothing tagged. */
export const performersLine = (song) => {
    const info = classicalInfo(song);
    const people = info.performers.map(p => (p.role ? `${p.name} (${p.role})` : p.name));
    return uniq([info.conductor, info.ensemble, ...people]).join(' · ');
};

const compareDiscTrackTitle = (a, b) =>
    compareDiscTrack(a, b) ||
    String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true });

/**
 * Movement order: by MOVEMENT number when every track has one, otherwise by disc / track
 * number (mixing the two criteria in one comparator would not be a consistent ordering).
 */
export const sortMovements = (songs, infoOf = classicalInfo) => {
    const list = [...songs];
    const numbers = list.map(s => infoOf(s).movementNumber);
    if (list.length > 1 && numbers.every(n => n !== null)) {
        const n = new Map(list.map((s, i) => [s, numbers[i]]));
        return list.sort((a, b) => (n.get(a) - n.get(b)) || compareDiscTrackTitle(a, b));
    }
    return list.sort(compareDiscTrackTitle);
};

// "Work: Movement" / "Work - I. Movement" / "Work: I. Movement"
const COLON = /^(.{3,}?):\s+(\S.*)$/;
const DASH_NUMBERED = /^(.{3,}?)\s+[-–—]\s+((?:[IVXLC]+|\d{1,2})[.)]\s*\S.*)$/i;

/** Conservative title split; null when the title does not look like 'Work <sep> Movement'. */
export const parseWorkTitle = (title) => {
    const t = String(title || '').trim();
    const m = DASH_NUMBERED.exec(t) || COLON.exec(t);
    if (!m) return null;
    const movementRaw = m[2].trim();
    const num = /^([IVXLC]+|\d{1,2})[.)]\s*(\S.*)$/i.exec(movementRaw);
    return {
        work: m[1].trim(),
        movementName: num ? num[2].trim() : movementRaw,
        movementNumber: num ? (parseRoman(num[1]) ?? parseInt(num[1], 10)) : null
    };
};

const key = (text) => normalizeText(text);

/**
 * Groups classical songs (with a composer) into composer -> works -> recordings.
 * Only songs that are classical count: WORK / MOVEMENTNAME tag, a classical GENRE, or a
 * corroborated title pattern (below). Plain songwriter credits in pop are ignored.
 *
 * A song belongs to a work by its WORK tag. Without one, the title is parsed
 * ('Work: Movement') but only trusted when at least two tracks of the same composer and
 * album parse to the same work, so ordinary titles containing a colon stay untouched.
 * Remaining tracks become single-track works titled by their own title.
 * A recording is the tracks of one work sharing album + conductor + ensemble.
 */
export const buildClassicalIndex = (songs) => {
    let items = [];
    for (const song of songs || []) {
        const info = classicalInfo(song);
        if (!info.composer) continue;
        items.push({ song, info, work: info.work, movementNumber: info.movementNumber, movementName: info.movementName, derived: false });
    }

    // Title-derived works, accepted only when corroborated.
    const candidates = new Map();
    for (const it of items) {
        if (it.work) continue;
        const parsed = parseWorkTitle(it.song.title);
        if (!parsed) continue;
        it.parsed = parsed;
        const k = `${key(it.info.composer)}\u0000${key(it.song.album)}\u0000${key(parsed.work)}`;
        candidates.set(k, (candidates.get(k) || 0) + 1);
        it.parsedKey = k;
    }
    for (const it of items) {
        if (it.work || !it.parsed || candidates.get(it.parsedKey) < 2) continue;
        it.work = it.parsed.work;
        it.movementName = it.parsed.movementName;
        it.movementNumber = it.parsed.movementNumber;
        it.derived = true;
    }
    items = items.filter(it => it.derived || isClassicalTagged(it.song));

    const composers = new Map();
    for (const it of items) {
        const ck = key(it.info.composer);
        if (!composers.has(ck)) composers.set(ck, { key: ck, name: it.info.composer, works: new Map(), trackCount: 0 });
        const composer = composers.get(ck);
        composer.trackCount += 1;
        const title = it.work || it.song.title || 'Untitled';
        const wk = it.work ? key(it.work) : `\u0001${it.song.path}`;
        if (!composer.works.has(wk)) composer.works.set(wk, { key: wk, title, composer: composer.name, recordings: new Map(), trackCount: 0 });
        const work = composer.works.get(wk);
        work.trackCount += 1;
        const rk = `${key(it.song.album)}\u0000${key(it.info.conductor)}\u0000${key(it.info.ensemble)}`;
        if (!work.recordings.has(rk)) {
            work.recordings.set(rk, {
                key: rk, album: it.song.album || '', conductor: it.info.conductor, ensemble: it.info.ensemble,
                performers: [], year: it.song.year || null, cover: null, tracks: []
            });
        }
        const rec = work.recordings.get(rk);
        rec.tracks.push({ ...it });
        if (!rec.cover && it.song.picture) rec.cover = it.song.picture;
        for (const p of it.info.performers) {
            const label = p.role ? `${p.name} (${p.role})` : p.name;
            if (!rec.performers.includes(label)) rec.performers.push(label);
        }
    }

    const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return [...composers.values()]
        .map(c => ({
            key: c.key,
            name: c.name,
            trackCount: c.trackCount,
            works: [...c.works.values()].map(w => ({
                key: w.key,
                title: w.title,
                composer: w.composer,
                trackCount: w.trackCount,
                recordings: [...w.recordings.values()].map(({ tracks, ...r }) => {
                    const meta = new Map(tracks.map(t => [t.song, t]));
                    const ordered = sortMovements(tracks.map(t => t.song), (s) => meta.get(s));
                    return {
                        ...r,
                        songs: ordered,
                        movements: ordered.map(s => ({
                            song: s,
                            name: meta.get(s).movementName || s.title || '',
                            number: meta.get(s).movementNumber
                        }))
                    };
                }).sort((a, b) => ((a.year || 9999) - (b.year || 9999)) || byName(a.album, b.album))
            })).sort((a, b) => byName(a.title, b.title))
        }))
        .sort((a, b) => byName(a.name, b.name));
};
