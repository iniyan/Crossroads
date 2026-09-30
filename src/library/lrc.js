// LRC lyrics: parser and serializer (#22).
//
//   [mm:ss.xx]text            one timestamp (centiseconds or milliseconds, or none)
//   [00:12.00][01:03.50]text  several timestamps per line: the line repeats
//   [offset:+500]             global shift in ms; positive moves the lyrics earlier
//   [ti:], [ar:], [al:], [by:], [offset:], [length:], [re:], [ve:], [au:]   metadata (known
//                             keys only, case-insensitive; "[Chorus: x]" or "[Verse 1]" is text)
//   <00:12.34>word            enhanced (word-level) tags are stripped from the text
//
// Times are seconds (floating point), ms precision kept. Lines are sorted by time. `plain`
// keeps the text as written (blank lines, section headers) minus metadata lines.

const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LINE_TIME_PREFIX_RE = /^(\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\])+/;
export const META_KEYS = Object.freeze(['ti', 'ar', 'al', 'by', 'offset', 'length', 're', 've', 'au']);
const META_RE = /^\s*\[([a-zA-Z]+):\s*(.*?)\s*\]\s*$/;
const isMetaKey = (key) => META_KEYS.includes(String(key).toLowerCase());
const WORD_TAG_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function fractionToSeconds(fraction) {
    if (fraction === undefined || fraction === '') return 0;
    // ".5" is 500 ms, ".50" is 500 ms, ".500" is 500 ms, ".05" is 50 ms.
    return Number(`0.${fraction.padEnd(3, '0').slice(0, 3)}`);
}

/**
 * @param {string} text
 * @param {Object} [opts]
 * @param {boolean} [opts.includeEmpty=false]  keep timestamped lines without text
 * @returns {{ synced: boolean, lines: {time:number, text:string}[], meta: Object.<string,string>, offset: number, plain: string }}
 *   `offset` in ms as written; `lines` already have it applied. `plain` is the text without
 *   timestamps and metadata lines (for unsynced display): blank lines and bracketed section
 *   headers are kept, only leading / trailing blank lines are dropped.
 */
export const parseLrc = (text, { includeEmpty = false } = {}) => {
    const result = { synced: false, lines: [], meta: {}, offset: 0, plain: '' };
    if (typeof text !== 'string' || !text) return result;
    const rawLines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const plain = [];
    const timed = [];
    for (const raw of rawLines) {
        const meta = META_RE.exec(raw);
        if (meta && isMetaKey(meta[1])) {
            const key = meta[1].toLowerCase();
            if (key === 'offset') {
                const n = parseInt(meta[2].replace(/\s+/g, ''), 10);
                if (Number.isFinite(n)) result.offset = n;
            } else {
                result.meta[key] = meta[2];
            }
            continue;
        }
        const prefix = LINE_TIME_PREFIX_RE.exec(raw);
        if (!prefix) {
            plain.push(raw.replace(/\s+$/, ''));
            continue;
        }
        const body = raw.slice(prefix[0].length).replace(WORD_TAG_RE, '').replace(/\s+/g, ' ').trim();
        TIME_RE.lastIndex = 0;
        let m;
        const times = [];
        while ((m = TIME_RE.exec(prefix[0])) !== null) {
            times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fractionToSeconds(m[3]));
        }
        if (body || includeEmpty) {
            for (const t of times) timed.push({ time: t, text: body });
        }
        if (body) plain.push(body);
    }
    const shift = result.offset / 1000;
    for (const line of timed) line.time = Math.max(0, Math.round((line.time - shift) * 1000) / 1000);
    timed.sort((a, b) => a.time - b.time);
    result.lines = timed;
    result.synced = timed.length > 0;
    result.plain = trimBlankLines(plain).join('\n');
    return result;
};

/** Drops leading and trailing blank lines (inner ones stay). */
const trimBlankLines = (lines) => {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start++;
    while (end > start && lines[end - 1].trim() === '') end--;
    return lines.slice(start, end);
};

/** Text of a plain (unsynced) lyrics document as written, minus outer blank lines and line-end whitespace. */
export const plainText = (text) => trimBlankLines(String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).map(l => l.replace(/\s+$/, ''))).join('\n');

/** True when the text carries at least one [mm:ss] timestamped line. */
export const isSyncedLrc = (text) => parseLrc(text).synced;

const pad = (n, width) => String(n).padStart(width, '0');

/** "[mm:ss.xx]" (or ".xxx" with precision 3). */
export const formatLrcTime = (seconds, precision = 2) => {
    const total = Math.max(0, Number(seconds) || 0);
    const scale = precision === 3 ? 1000 : 100;
    const units = Math.round(total * scale);
    const minutes = Math.floor(units / (60 * scale));
    const rest = units - minutes * 60 * scale;
    const secs = Math.floor(rest / scale);
    const frac = rest - secs * scale;
    return `[${pad(minutes, 2)}:${pad(secs, 2)}.${pad(frac, precision)}]`;
};

/**
 * @param {{ lines: {time:number, text:string}[], meta?: Object.<string,string> }} lrc
 * @param {Object} [opts]
 * @param {2|3} [opts.precision=2]   fractional digits; 3 when any time needs ms precision
 * @returns {string}
 */
export const serializeLrc = (lrc, { precision } = {}) => {
    const lines = Array.isArray(lrc?.lines) ? lrc.lines : [];
    const meta = lrc?.meta || {};
    const needMs = lines.some(l => Math.round(l.time * 1000) % 10 !== 0);
    const digits = precision || (needMs ? 3 : 2);
    const out = [];
    // ']' and line breaks would end the tag early: they cannot be represented and are dropped.
    const metaValue = (v) => String(v).replace(/[\]\r\n]/g, '').trim();
    const metaLine = (key) => { const v = metaValue(meta[key]); if (v) out.push(`[${key}:${v}]`); };
    for (const key of ['ti', 'ar', 'al', 'by', 'length']) {
        if (meta[key]) metaLine(key);
    }
    for (const key of Object.keys(meta)) {
        if (!['ti', 'ar', 'al', 'by', 'length'].includes(key) && meta[key]) metaLine(key);
    }
    const sorted = lines.slice().sort((a, b) => a.time - b.time);
    for (const line of sorted) out.push(`${formatLrcTime(line.time, digits)}${line.text || ''}`);
    return out.join('\n') + (out.length ? '\n' : '');
};

/** The index of the line active at `time` (last line whose time <= time), or -1. */
export const activeLineIndex = (lines, time) => {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
};
