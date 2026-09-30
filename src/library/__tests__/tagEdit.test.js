import { describe, expect, it } from 'vitest';
import {
    STANDARD_FIELDS, applyOperations, buildEditModel, isEmptyOperations, isWritableFormat,
    joinValues, normalizeTagKey, foldTagKey, operationsFromEdits, previewDiff,
    createEditState, setFieldValues, removeField, revertField, addField, visibleFields, fieldState, jobsForTracks, isDirtyState
} from '../tagEdit.js';

describe('buildEditModel', () => {
    it('lists standard fields first, then the file-specific ones, flagging mixed values', () => {
        const model = buildEditModel([
            { tags: { TITLE: ['One'], ALBUM: ['X'], ARTIST: ['A', 'B'], REPLAYGAIN_TRACK_GAIN: ['-3 dB'] } },
            { tags: { TITLE: ['Two'], ALBUM: ['X'], ARTIST: ['A', 'B'], ZZZ: ['z'] } }
        ]);
        expect(model.count).toBe(2);
        const byKey = Object.fromEntries(model.fields.map(f => [f.key, f]));
        expect(byKey.ALBUM).toMatchObject({ values: ['X'], mixed: false, standard: true, perTrack: false });
        expect(byKey.TITLE).toMatchObject({ values: ['One'], mixed: true, perTrack: true });
        expect(byKey.ARTIST.values).toEqual(['A', 'B']);
        expect(byKey.REPLAYGAIN_TRACK_GAIN).toMatchObject({ values: ['-3 dB'], mixed: true, standard: false });
        expect(byKey.ZZZ.mixed).toBe(true);
        expect(byKey.GENRE).toMatchObject({ values: [], mixed: false });
        const keys = model.fields.map(f => f.key);
        expect(keys.slice(0, STANDARD_FIELDS.length)).toEqual([...STANDARD_FIELDS]);
        expect(keys.slice(STANDARD_FIELDS.length)).toEqual(['REPLAYGAIN_TRACK_GAIN', 'ZZZ']);
    });

    it('handles a single track and no tracks', () => {
        expect(buildEditModel([{ tags: { title: 'x' } }]).fields.find(f => f.key === 'TITLE')).toMatchObject({ values: ['x'], mixed: false });
        expect(buildEditModel([]).fields.every(f => !f.mixed)).toBe(true);
    });
});

describe('operationsFromEdits', () => {
    it('produces set / remove, skipping untouched keys against the original', () => {
        const ops = operationsFromEdits(
            { TITLE: ['Same'], ALBUM: ['New'], genre: [], COMMENT: [' ', ''], 'bad=key': ['x'], NEWKEY: 'single' },
            { original: { TITLE: ['Same'], ALBUM: ['Old'], GENRE: ['Rock'] } }
        );
        expect(ops).toEqual({ set: { ALBUM: ['New'], NEWKEY: ['single'] }, remove: ['GENRE'] });
    });

    it('does not remove a key that was already absent', () => {
        expect(operationsFromEdits({ GENRE: [] }, { original: {} })).toEqual({ set: {}, remove: [] });
        expect(operationsFromEdits({ GENRE: [] })).toEqual({ set: {}, remove: ['GENRE'] });
    });

    it('edits keys the file already carries by their folded spelling, but validates new keys', () => {
        const original = { 'WEIRD~KEY': ['1'], 'ÜBER': ['2'], TITLE: ['T'] };
        expect(operationsFromEdits({ 'weird~key ': ['3'], 'über': [], ' title': ['U'] }, { original }))
            .toEqual({ set: { 'WEIRD~KEY': ['3'], TITLE: ['U'] }, remove: ['ÜBER'] });
        // The same spellings are refused when the file does not have them.
        expect(operationsFromEdits({ 'WEIRD~KEY': ['3'], 'ÜBER': ['x'], 'bad=key': ['x'] }, { original: { TITLE: ['T'] } })).toEqual({ set: {}, remove: [] });
        expect(applyOperations({ 'WEIRD~KEY': ['1'] }, { set: { 'weird~key': ['2'] }, remove: ['über'] })).toEqual({ 'WEIRD~KEY': ['2'] });
    });

    it('a value containing ";" stays one value', () => {
        expect(operationsFromEdits({ ARTIST: ['AC; DC'] }, { original: { ARTIST: ['AC/DC'] } })).toEqual({ set: { ARTIST: ['AC; DC'] }, remove: [] });
        expect(operationsFromEdits({ ARTIST: 'a; b' }).set.ARTIST).toEqual(['a; b']);
    });

    it('isEmptyOperations', () => {
        expect(isEmptyOperations({ set: {}, remove: [] })).toBe(true);
        expect(isEmptyOperations({ set: { A: ['1'] }, remove: [] })).toBe(false);
        expect(isEmptyOperations(null)).toBe(true);
    });
});

describe('applyOperations / previewDiff', () => {
    const tags = { TITLE: ['T'], ARTIST: ['A'], GENRE: ['G'] };

    it('applies set and remove on a copy', () => {
        const out = applyOperations(tags, { set: { ARTIST: ['B', 'C'], album: 'X' }, remove: ['genre'] });
        expect(out).toEqual({ TITLE: ['T'], ARTIST: ['B', 'C'], ALBUM: ['X'] });
        expect(tags.GENRE).toEqual(['G']);
    });

    it('describes the differences', () => {
        expect(previewDiff(tags, { set: { ARTIST: ['B'], ALBUM: ['X'] }, remove: ['GENRE'] })).toEqual([
            { key: 'ALBUM', before: [], after: ['X'], kind: 'added' },
            { key: 'ARTIST', before: ['A'], after: ['B'], kind: 'changed' },
            { key: 'GENRE', before: ['G'], after: [], kind: 'removed' }
        ]);
        expect(previewDiff(tags, { set: { TITLE: ['T'] } })).toEqual([]);
    });
});

describe('helpers', () => {
    it('normalizeTagKey', () => {
        expect(normalizeTagKey(' title ')).toBe('TITLE');
        expect(normalizeTagKey('a=b')).toBeNull();
        expect(normalizeTagKey('')).toBeNull();
        expect(normalizeTagKey('Ünï')).toBeNull();
    });

    it('joinValues is display only', () => {
        expect(joinValues(['a', 'b'])).toBe('a; b');
        expect(joinValues(null)).toBe('');
    });

    it('foldTagKey', () => {
        expect(foldTagKey(' weird~key ')).toBe('WEIRD~KEY');
        expect(foldTagKey(null)).toBe('');
    });

    it('isWritableFormat', () => {
        expect(isWritableFormat('FLAC')).toBe(true);
        expect(isWritableFormat('flac')).toBe(true);
        expect(isWritableFormat('MP3')).toBe(false);
        expect(isWritableFormat(null)).toBe(false);
    });
});

describe('edit state (bulk and single)', () => {
    const tracks = [
        { path: '/a/1.flac', tags: { TITLE: ['One'], ALBUM: ['X'], GENRE: ['Rock'], ARTIST: ['A'], TRACKNUMBER: ['1'] } },
        { path: '/a/2.flac', tags: { TITLE: ['Two'], ALBUM: ['X'], GENRE: ['Jazz'], ARTIST: ['A'] } }
    ];
    const model = buildEditModel(tracks);
    const opsByPath = (jobs) => Object.fromEntries(jobs.map(j => [j.song.path, j.ops]));
    const NONE = { set: {}, remove: [] };

    it('mixed field typed then cleared is "keep existing": no operation', () => {
        let state = setFieldValues(createEditState(), 'GENRE', ['Pop']);
        expect(fieldState(model.fields.find(f => f.key === 'GENRE'), state)).toMatchObject({ status: 'set', changed: true, values: ['Pop'] });
        state = setFieldValues(state, 'GENRE', ['']);
        expect(fieldState(model.fields.find(f => f.key === 'GENRE'), state)).toMatchObject({ status: 'keep', changed: false });
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: true }))).toEqual({ '/a/1.flac': NONE, '/a/2.flac': NONE });
        state = setFieldValues(state, 'GENRE', ['  ']);
        expect(jobsForTracks(tracks, model, state, { bulk: true }).every(j => isEmptyOperations(j.ops))).toBe(true);
    });

    it('mixed field explicitly removed removes it from every track', () => {
        const state = removeField(setFieldValues(createEditState(), 'GENRE', ['Pop']), 'GENRE');
        expect(fieldState(model.fields.find(f => f.key === 'GENRE'), state)).toMatchObject({ status: 'removed', changed: true });
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: true }))).toEqual({
            '/a/1.flac': { set: {}, remove: ['GENRE'] }, '/a/2.flac': { set: {}, remove: ['GENRE'] }
        });
        expect(state.edits.GENRE).toBeUndefined();
        // Typing again cancels the removal.
        expect(setFieldValues(state, 'GENRE', ['Z']).removed).toEqual([]);
    });

    it('mixed field set applies to every track', () => {
        const state = setFieldValues(createEditState(), 'GENRE', ['Pop', 'Rock; Roll']);
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: true }))).toEqual({
            '/a/1.flac': { set: { GENRE: ['Pop', 'Rock; Roll'] }, remove: [] }, '/a/2.flac': { set: { GENRE: ['Pop', 'Rock; Roll'] }, remove: [] }
        });
    });

    it('a shared (non-mixed) field emptied removes it; unchanged values write nothing', () => {
        let state = setFieldValues(createEditState(), 'ALBUM', ['']);
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: true }))).toEqual({
            '/a/1.flac': { set: {}, remove: ['ALBUM'] }, '/a/2.flac': { set: {}, remove: ['ALBUM'] }
        });
        state = setFieldValues(createEditState(), 'ALBUM', ['X']);
        expect(fieldState(model.fields.find(f => f.key === 'ALBUM'), state)).toMatchObject({ status: 'untouched', changed: false });
        expect(jobsForTracks(tracks, model, state, { bulk: true }).every(j => isEmptyOperations(j.ops))).toBe(true);
        // A standard field no track has, left blank, is not "removed".
        state = setFieldValues(createEditState(), 'COMPOSER', ['']);
        expect(jobsForTracks(tracks, model, state, { bulk: true }).every(j => isEmptyOperations(j.ops))).toBe(true);
        // Removing a key only some tracks carry removes it where present.
        state = removeField(createEditState(), 'TRACKNUMBER');
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: false }))).toEqual({
            '/a/1.flac': { set: {}, remove: ['TRACKNUMBER'] }, '/a/2.flac': NONE
        });
    });

    it('add a key, then revert it', () => {
        const { state, error } = addField(createEditState(), model, ' label ', ['Blue Note'], { bulk: true });
        expect(error).toBeNull();
        expect(state.added).toEqual([]);   // LABEL is a standard field: not "added"
        const custom = addField(state, model, 'my_tag', ['v'], { bulk: true });
        expect(custom.state.added).toEqual(['MY_TAG']);
        expect(visibleFields(model, custom.state, { bulk: true }).find(f => f.key === 'MY_TAG')).toMatchObject({ added: true, values: [] });
        expect(isDirtyState(custom.state)).toBe(true);
        expect(opsByPath(jobsForTracks(tracks, model, custom.state, { bulk: true }))['/a/1.flac']).toEqual({ set: { LABEL: ['Blue Note'], MY_TAG: ['v'] }, remove: [] });
        const reverted = revertField(revertField(custom.state, 'MY_TAG'), 'LABEL');
        expect(reverted).toEqual(createEditState());
        expect(visibleFields(model, reverted, { bulk: true }).some(f => f.key === 'MY_TAG')).toBe(false);
        expect(isDirtyState(reverted)).toBe(false);
        // Invalid new names and keys already shown are handled.
        expect(addField(createEditState(), model, 'bad=key', ['x']).error).toMatch(/printable ASCII/);
        expect(addField(createEditState(), model, 'genre', ['x']).state.edits.GENRE).toEqual(['x']);
    });

    it('bulk mode never writes per-track keys to every track', () => {
        expect(addField(createEditState(), model, 'TITLE', ['Same'], { bulk: true }).error).toBe('TITLE is a per-track field; edit it on each track');
        expect(addField(createEditState(), model, 'musicbrainz_trackid', ['id'], { bulk: true }).error).toMatch(/per-track/);
        expect(addField(createEditState(), model, 'TITLE', ['Same'], { bulk: false }).error).toBeNull();
        expect(visibleFields(model, createEditState(), { bulk: true }).some(f => f.perTrack)).toBe(false);
        expect(visibleFields(model, createEditState(), { bulk: false }).some(f => f.key === 'TITLE')).toBe(true);
        // Even when the state carries one (e.g. from a single-track session), bulk jobs skip it.
        const state = removeField(setFieldValues(createEditState(), 'TITLE', ['Same']), 'TRACKNUMBER');
        expect(jobsForTracks(tracks, model, state, { bulk: true }).every(j => isEmptyOperations(j.ops))).toBe(true);
        expect(opsByPath(jobsForTracks(tracks, model, state, { bulk: false }))['/a/1.flac']).toEqual({ set: { TITLE: ['Same'] }, remove: ['TRACKNUMBER'] });
    });

    it('edits a key the file carries under an illegal spelling', () => {
        const weird = [{ path: '/w.flac', tags: { 'WEIRD~KEY': ['1'], TITLE: ['T'] } }];
        const m = buildEditModel(weird);
        expect(m.fields.some(f => f.key === 'WEIRD~KEY')).toBe(true);
        const state = setFieldValues(createEditState(), 'WEIRD~KEY', ['2']);
        expect(jobsForTracks(weird, m, state)[0].ops).toEqual({ set: { 'WEIRD~KEY': ['2'] }, remove: [] });
        expect(jobsForTracks(weird, m, removeField(createEditState(), 'WEIRD~KEY'))[0].ops).toEqual({ set: {}, remove: ['WEIRD~KEY'] });
    });
});
