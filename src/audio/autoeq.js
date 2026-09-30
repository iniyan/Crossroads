// AutoEq (github.com/jaakkopasanen/AutoEq) result files, parsed without any I/O.
//
// Repository layout (master):
//   results/INDEX.md                                   one "- [Name](./Source/Rig form/Name) by Source on Rig" line per result
//   results/<Source>/<rig form>/<Name>/<Name> ParametricEQ.txt
//
// ParametricEQ.txt:
//   Preamp: -6.1 dB
//   Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
//   Filter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42
//   Filter 6: ON HSC Fc 10000 Hz Gain -2.1 dB Q 0.70

export const AUTOEQ_RAW_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
export const AUTOEQ_INDEX_URL = `${AUTOEQ_RAW_BASE}INDEX.md`;
/** Host the Electron CSP connect-src has to allow. */
export const AUTOEQ_HOST = 'https://raw.githubusercontent.com';

export const MAX_BANDS = 10;

const FILTER_TYPES = {
    PK: 'peaking',
    PEQ: 'peaking',
    LSC: 'lowshelf',
    LS: 'lowshelf',
    LSQ: 'lowshelf',
    HSC: 'highshelf',
    HS: 'highshelf',
    HSQ: 'highshelf'
};

const PREAMP_RE = /^\s*Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/im;
const FILTER_RE = /^\s*Filter\s*\d+\s*:\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+(-?\d+(?:\.\d+)?)\s*Hz\s+Gain\s+(-?\d+(?:\.\d+)?)\s*dB(?:\s+Q\s+(-?\d+(?:\.\d+)?))?/i;

const round = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

/**
 * Parses a ParametricEQ.txt. Filters that are OFF or of an unsupported type (LP/HP/notch,
 * which AutoEq does not emit) are skipped; at most MAX_BANDS filters are returned. Shelf
 * filters keep their Q, though Web Audio's shelves run at a fixed slope (see eqMath.js).
 * @returns {{ preamp: number, filters: Array<{type: string, frequency: number, gain: number, q: number}> }}
 */
export const parseParametricEq = (text) => {
    const source = String(text || '');
    const preampMatch = PREAMP_RE.exec(source);
    const preamp = preampMatch ? round(Number(preampMatch[1]), 2) : 0;
    const filters = [];
    for (const line of source.split(/\r?\n/)) {
        const match = FILTER_RE.exec(line);
        if (!match) continue;
        const [, state, code, fc, gain, q] = match;
        if (state.toUpperCase() !== 'ON') continue;
        const type = FILTER_TYPES[code.toUpperCase()];
        if (!type) continue;
        const frequency = Number(fc);
        const gainDb = Number(gain);
        if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(gainDb)) continue;
        const qValue = q === undefined ? 0.7071 : Number(q);
        filters.push({
            type,
            frequency: round(frequency, 2),
            gain: round(gainDb, 2),
            q: Number.isFinite(qValue) && qValue > 0 ? round(qValue, 4) : 0.7071
        });
        if (filters.length >= MAX_BANDS) break;
    }
    return { preamp, filters };
};

const INDEX_LINE_RE = /^\s*-\s*\[(.+?)\]\(\.\/(.+?)\)\s+by\s+(.+?)(?:\s+on\s+(.+?))?\s*$/;

const safeDecode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
};

/** Headphone form ('in-ear' | 'earbud' | 'over-ear' | null) from a results path. */
export const formOf = (path) => {
    const lower = String(path || '').toLowerCase();
    if (lower.includes('in-ear')) return 'in-ear';
    if (lower.includes('earbud')) return 'earbud';
    if (lower.includes('over-ear')) return 'over-ear';
    return null;
};

/**
 * Parses results/INDEX.md into compact entries.
 * @returns {Array<{ name: string, path: string, source: string, rig: string|null, form: string|null }>}
 *   `path` is the decoded folder path relative to results/ (e.g. "oratory1990/over-ear/Sennheiser HD 650").
 */
export const parseAutoEqIndex = (markdown) => {
    const entries = [];
    for (const line of String(markdown || '').split(/\r?\n/)) {
        const match = INDEX_LINE_RE.exec(line);
        if (!match) continue;
        const [, name, rawPath, source, rig] = match;
        const path = safeDecode(rawPath).replace(/\/+$/, '');
        if (!path.includes('/')) continue;
        entries.push({ name: name.trim(), path, source: source.trim(), rig: rig ? rig.trim() : null, form: formOf(path) });
    }
    return entries;
};

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Raw URL of the ParametricEQ.txt for an index entry. */
export const profileUrl = (entry) => {
    const segments = String(entry.path).split('/');
    const folder = segments[segments.length - 1];
    return `${AUTOEQ_RAW_BASE}${encodePath(entry.path)}/${encodeURIComponent(`${folder} ParametricEQ.txt`)}`;
};

/** Human label distinguishing the same model measured by several sources. */
export const entryLabel = (entry) => {
    const parts = [entry.source];
    if (entry.rig) parts.push(entry.rig);
    if (entry.form) parts.push(entry.form);
    return parts.join(' · ');
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Every whitespace-separated token of `query` must occur in the entry's name or source.
 * Name prefix matches rank first, then name matches, then source-only matches; ties by name.
 */
export const searchAutoEqIndex = (entries, query, limit = 40) => {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (tokens.length === 0) return [];
    const scored = [];
    for (const entry of entries) {
        const name = normalize(entry.name);
        const haystack = `${name} ${normalize(entry.source)} ${normalize(entry.rig)}`;
        if (!tokens.every(token => haystack.includes(token))) continue;
        let score = 0;
        if (name.startsWith(tokens.join(' '))) score = 3;
        else if (tokens.every(token => name.includes(token))) score = 2;
        else score = 1;
        if (entry.source === 'oratory1990') score += 0.5;   // best-regarded measurements first among equals
        scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, limit).map(item => item.entry);
};
