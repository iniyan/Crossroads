// Tag editing model (#20): what the editor shows for one or many tracks, the { set, remove }
// operations it produces, and the preview diff. Pure; the platform writers apply the
// operations against the tags actually in each file (see electron/flacTagWriter.js).

import { canonicalTags } from './tags.js';

/** Fields the editor always offers, in display order. Everything else is a free-form tag. */
export const STANDARD_FIELDS = Object.freeze([
    'TITLE', 'ARTIST', 'ALBUM', 'ALBUMARTIST', 'DATE', 'TRACKNUMBER', 'TRACKTOTAL', 'DISCNUMBER', 'DISCTOTAL',
    'GENRE', 'COMPOSER', 'CONDUCTOR', 'PERFORMER', 'WORK', 'MOVEMENTNAME', 'MOVEMENT', 'MOVEMENTTOTAL',
    'LABEL', 'CATALOGNUMBER', 'ISRC', 'COMMENT', 'LYRICS'
]);

/** Fields that differ per track by nature; a bulk edit never proposes them. */
export const PER_TRACK_FIELDS = Object.freeze(['TITLE', 'TRACKNUMBER', 'ISRC', 'LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS',
    'MUSICBRAINZ_TRACKID', 'MUSICBRAINZ_RELEASETRACKID', 'MUSICBRAINZ_RECORDINGID']);

/** Formats the tag editor can write; everything else is read-only. */
export const WRITABLE_FORMATS = Object.freeze(['FLAC']);

export const isWritableFormat = (format) => WRITABLE_FORMATS.includes(String(format || '').toUpperCase());

// A comment key: printable ASCII 0x20..0x7D except '='. Only keys NEW to a file must satisfy
// it; keys a file already carries are edited by their folded spelling whatever it is.
const KEY_RE = /^[\x20-\x3C\x3E-\x7D]+$/;

/** The folded spelling of a key (trimmed, upper-cased), the way tags.js canonicalises it; '' when empty. */
export const foldTagKey = (key) => String(key === null || key === undefined ? '' : key).trim().toUpperCase();

/** Upper-cased key, or null when it is not a valid name for a NEW Vorbis comment. */
export const normalizeTagKey = (key) => {
    const upper = foldTagKey(key);
    return upper && KEY_RE.test(upper) ? upper : null;
};

const sameValues = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Non-blank strings of a value list, in order. */
export const cleanValues = (raw) => (Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]))
    .map(v => String(v)).filter(v => v.trim() !== '');

/**
 * The editor model for `tracks` (each with its full `tags`).
 *
 * @returns {{ count:number, fields: {key:string, values:string[], mixed:boolean, standard:boolean, perTrack:boolean}[] }}
 *   `mixed` = the tracks disagree (a bulk edit leaves it alone unless the user sets it);
 *   `values` = the shared values, or the first track's values when mixed.
 */
export const buildEditModel = (tracks) => {
    const list = (Array.isArray(tracks) ? tracks : []).map(t => canonicalTags(t?.tags));
    const keys = new Set(STANDARD_FIELDS);
    for (const tags of list) for (const key of Object.keys(tags)) keys.add(key);
    const fields = [];
    const ordered = [...STANDARD_FIELDS, ...Array.from(keys).filter(k => !STANDARD_FIELDS.includes(k)).sort()];
    for (const key of ordered) {
        const first = list.length ? (list[0][key] || []) : [];
        const mixed = list.some(tags => !sameValues(tags[key] || [], first));
        const present = list.some(tags => (tags[key] || []).length > 0);
        if (!present && !STANDARD_FIELDS.includes(key)) continue;
        fields.push({ key, values: first.slice(), mixed, standard: STANDARD_FIELDS.includes(key), perTrack: PER_TRACK_FIELDS.includes(key) });
    }
    return { count: list.length, fields };
};

/**
 * Turns editor edits into writer operations.
 * @param {Object.<string, string[]|null>} edits   KEY -> new values ([] or null removes the key)
 * @param {Object} [opts]
 * @param {Object.<string,string[]>} [opts.original]  the model's values, to skip untouched keys
 * @returns {{ set: Object.<string,string[]>, remove: string[] }}
 */
export const operationsFromEdits = (edits, { original = null } = {}) => {
    const set = {};
    const remove = [];
    for (const rawKey of Object.keys(edits || {})) {
        const key = foldTagKey(rawKey);
        if (!key) continue;
        const values = cleanValues(edits[rawKey]);
        const existed = original ? (original[key] || []).length > 0 : null;
        if (original && Object.prototype.hasOwnProperty.call(original, key) && sameValues(original[key] || [], values)) continue;
        if (values.length === 0) {
            if (existed !== false) remove.push(key);
        } else {
            // A key the file does not carry yet has to be a legal comment name; existing keys are
            // edited by their folded spelling whatever it is.
            if (existed !== true && !KEY_RE.test(key)) continue;
            set[key] = values;
        }
    }
    return { set, remove };
};

export const isEmptyOperations = (ops) => !ops || (Object.keys(ops.set || {}).length === 0 && (ops.remove || []).length === 0);

/** Applies operations to a tags map (renderer-side mirror of the writer, for previews). */
export const applyOperations = (tags, ops) => {
    const out = {};
    for (const [key, values] of Object.entries(canonicalTags(tags))) out[key] = values.slice();
    for (const key of ops?.remove || []) delete out[foldTagKey(key)];
    for (const [rawKey, values] of Object.entries(ops?.set || {})) {
        const key = foldTagKey(rawKey);
        if (!key) continue;
        const list = cleanValues(values);
        if (list.length === 0) delete out[key];
        else out[key] = list;
    }
    return out;
};

/**
 * Per-key differences a write would make.
 * @returns {{ key:string, before:string[], after:string[], kind:'added'|'removed'|'changed' }[]}
 */
export const previewDiff = (tags, ops) => {
    const before = canonicalTags(tags);
    const after = applyOperations(before, ops);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const diff = [];
    for (const key of Array.from(keys).sort()) {
        const a = before[key] || [];
        const b = after[key] || [];
        if (sameValues(a, b)) continue;
        diff.push({ key, before: a, after: b, kind: a.length === 0 ? 'added' : b.length === 0 ? 'removed' : 'changed' });
    }
    return diff;
};

/** Values as one line for read-only display (previews, results): "a; b". Never parsed back. */
export const joinValues = (values) => (Array.isArray(values) ? values : []).join('; ');

// --- editor state ------------------------------------------------------------------------------
//
// What the user did to the fields of an edit model, independent of React:
//   edits    KEY -> string[]   values typed for the key (may contain blanks while typing)
//   removed  KEY[]             keys removed with the explicit remove action
//   added    KEY[]             keys the user added that the model did not list, in order
// A mixed field (values differ between tracks) whose edit ends up blank is "keep existing":
// nothing is written for it. Only the explicit remove action removes a mixed field.

export const createEditState = () => ({ edits: {}, removed: [], added: [] });

const without = (list, key) => list.filter(k => k !== key);

/** Records the values typed for `key` (an array; a value containing ';' is still one value). */
export const setFieldValues = (state, key, values) => ({
    ...state,
    edits: { ...state.edits, [key]: Array.isArray(values) ? values.slice() : [String(values ?? '')] },
    removed: without(state.removed, key)
});

/** The explicit remove action: the key is dropped from every track. */
export const removeField = (state, key) => {
    const edits = { ...state.edits };
    delete edits[key];
    return { ...state, edits, removed: state.removed.includes(key) ? state.removed : [...state.removed, key] };
};

/** Forgets everything done to `key` (an added key disappears again). */
export const revertField = (state, key) => {
    const edits = { ...state.edits };
    delete edits[key];
    return { edits, removed: without(state.removed, key), added: without(state.added, key) };
};

/**
 * Adds a key the model does not list. Returns { state, error } — the error names why the key
 * cannot be added (invalid name, or a per-track field in a bulk edit).
 */
export const addField = (state, model, rawKey, values, { bulk = false } = {}) => {
    const folded = foldTagKey(rawKey);
    const known = (model?.fields || []).find(f => f.key === folded);
    const key = known ? known.key : normalizeTagKey(rawKey);
    if (!key) return { state, error: 'Tag names may only use printable ASCII (no "=")' };
    if (bulk && PER_TRACK_FIELDS.includes(key)) return { state, error: `${key} is a per-track field; edit it on each track` };
    const next = setFieldValues(state, key, values);
    if (!known && !state.added.includes(key)) next.added = [...state.added, key];
    return { state: next, error: null };
};

export const isDirtyState = (state) => Object.keys(state.edits).length > 0 || state.removed.length > 0 || state.added.length > 0;

/** The fields the editor shows: the model's (minus per-track ones in bulk mode) plus the added keys. */
export const visibleFields = (model, state, { bulk = false } = {}) => {
    const list = (model?.fields || []).filter(f => !bulk || !f.perTrack);
    const known = new Set(list.map(f => f.key));
    for (const key of state.added) if (!known.has(key)) list.push({ key, values: [], mixed: false, standard: false, perTrack: false, added: true });
    return list;
};

/**
 * What one field looks like under `state`:
 *   values   the values to show (raw edits while typing, else the model's)
 *   status   'untouched' | 'set' | 'keep' (mixed field touched but blank) | 'removed'
 *   changed  true when a write would result for a track that differs
 */
export const fieldState = (field, state) => {
    if (state.removed.includes(field.key)) return { values: [], status: 'removed', changed: true };
    if (Object.prototype.hasOwnProperty.call(state.edits, field.key)) {
        const values = state.edits[field.key];
        const clean = cleanValues(values);
        if (field.mixed) return { values, status: clean.length ? 'set' : 'keep', changed: clean.length > 0 };
        const changed = !sameValues(clean, field.values);
        return { values, status: changed ? 'set' : 'untouched', changed };
    }
    return { values: field.mixed ? [] : field.values.slice(), status: 'untouched', changed: false };
};

/**
 * The per-track write jobs for `state`: [{ song, ops }] with empty ops for tracks nothing
 * applies to. In bulk mode per-track keys are never written to every track.
 */
export const jobsForTracks = (tracks, model, state, { bulk = false } = {}) => {
    const fields = visibleFields(model, state, { bulk });
    const byKey = new Map(fields.map(f => [f.key, f]));
    const edits = {};
    for (const key of state.removed) {
        if (bulk && PER_TRACK_FIELDS.includes(key)) continue;
        edits[key] = [];
    }
    for (const [key, raw] of Object.entries(state.edits)) {
        if (bulk && PER_TRACK_FIELDS.includes(key)) continue;
        const field = byKey.get(key);
        const values = cleanValues(raw);
        if (field?.mixed && values.length === 0) continue;   // keep existing
        if (field && !field.mixed && sameValues(values, field.values)) continue;
        edits[key] = values;
    }
    return (Array.isArray(tracks) ? tracks : []).map((track) => {
        const tags = canonicalTags(track?.tags);
        const original = Object.fromEntries(Object.keys(edits).map(k => [k, tags[k] || []]));
        return { song: track, ops: operationsFromEdits(edits, { original }) };
    });
};
