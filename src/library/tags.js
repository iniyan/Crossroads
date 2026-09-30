// Small helpers for the `song.tags` map (UPPERCASE name -> string[]).

const toStringValue = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
};

/**
 * Coerces whatever a platform scanner produced into the canonical shape:
 * UPPERCASE keys, arrays of non-empty strings, no empty entries.
 */
export const canonicalTags = (input) => {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const rawKey of Object.keys(input)) {
        const key = String(rawKey).trim().toUpperCase();
        if (!key) continue;
        const raw = input[rawKey];
        const values = (Array.isArray(raw) ? raw : [raw])
            .map(toStringValue)
            .filter(v => v !== null && v.trim() !== '');
        if (values.length === 0) continue;
        out[key] = out[key] ? out[key].concat(values) : values;
    }
    return out;
};

/** First value of `name` (already uppercase or not), or null. */
export const firstTag = (tags, name) => {
    if (!tags) return null;
    const values = tags[String(name).toUpperCase()];
    return Array.isArray(values) && values.length > 0 ? values[0] : null;
};

/** First value among several candidate names, in priority order. */
export const firstTagOf = (tags, names) => {
    for (const name of names) {
        const value = firstTag(tags, name);
        if (value !== null) return value;
    }
    return null;
};

/** All values of `name`, always an array. */
export const tagValues = (tags, name) => {
    if (!tags) return [];
    const values = tags[String(name).toUpperCase()];
    return Array.isArray(values) ? values : [];
};

export const hasTag = (tags, name) => tagValues(tags, name).length > 0;

/**
 * Parses a positive integer out of a tag value such as '7', '07', '7/12' or '7 of 12'.
 * Returns { number, total } with nulls where the value carries no usable digits.
 */
export const parseNumberPair = (value) => {
    const result = { number: null, total: null };
    if (value === null || value === undefined) return result;
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? { number: Math.floor(value), total: null } : result;
    }
    const text = String(value).trim();
    const match = /^(\d+)\s*(?:[/of]+\s*(\d+))?/i.exec(text);
    if (!match) return result;
    const number = parseInt(match[1], 10);
    const total = match[2] !== undefined ? parseInt(match[2], 10) : null;
    result.number = number > 0 ? number : null;
    result.total = total !== null && total > 0 ? total : null;
    return result;
};

/** Four-digit year from a DATE-like value ('2019', '2019-04-01', '01/04/2019'), or null. */
export const parseYear = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null;
    }
    const match = /(?:^|\D)(\d{4})(?:\D|$)/.exec(String(value));
    if (!match) return null;
    const year = parseInt(match[1], 10);
    return year >= 1000 && year <= 9999 ? year : null;
};
