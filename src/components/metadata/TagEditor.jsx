import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Trash2, Plus, Undo2, Eye, Save, Check, AlertCircle, Search } from 'lucide-react';
import Platform from '../../services/PlatformService';
import {
    buildEditModel, previewDiff, isEmptyOperations, isWritableFormat, joinValues,
    createEditState, setFieldValues, removeField, revertField, addField, visibleFields, fieldState, jobsForTracks, isDirtyState
} from '../../library/tagEdit';
import { saveTagJobs } from './saveTags';
import FolderAccessBanner from './FolderAccessBanner';
import '../../styles/Metadata.css';

const MULTILINE_FIELDS = new Set(['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS', 'COMMENT', 'DESCRIPTION']);

/**
 * Edits Vorbis comments on one track or on several at once (album). Values are lists: every
 * value has its own input, and "+ value" adds another (a value may contain ";"). For a bulk
 * edit only the fields shared by every track are proposed; fields whose values differ are
 * kept as they are unless the user types a value (applies to all) or removes them explicitly.
 * The edit logic itself is the pure state API in src/library/tagEdit.js.
 */
const TagEditor = ({ songs, onClose, onSaved, onMusicBrainz }) => {
    const [tracks, setTracks] = useState(null);       // full songs (tags incl. lyrics)
    const [state, setState] = useState(createEditState);
    const [newKey, setNewKey] = useState('');
    const [newValue, setNewValue] = useState('');
    const [view, setView] = useState('edit');         // edit | preview | saving | done
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [results, setResults] = useState(null);
    const [needsAccess, setNeedsAccess] = useState(false);
    const [error, setError] = useState(null);
    const abortRef = useRef(null);

    const bulk = songs.length > 1;
    const canWrite = Platform.supportsTagWriting();
    const anyWritable = songs.some(s => isWritableFormat(s.format));
    const disabled = !canWrite || !anyWritable;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const full = await Promise.all(songs.map(async (song) => (await Platform.getTrackDetails(song.path)) || song));
            if (!cancelled) setTracks(full);
        })();
        return () => { cancelled = true; };
    }, [songs]);

    useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

    const model = useMemo(() => (tracks ? buildEditModel(tracks) : null), [tracks]);
    const fields = useMemo(() => (model ? visibleFields(model, state, { bulk }) : []), [model, state, bulk]);

    const update = (fn) => setState(prev => fn(prev));
    const setValues = (key, values) => update(s => setFieldValues(s, key, values));
    const setValueAt = (field, index, text) => {
        const current = fieldState(field, state).values.slice();
        current[index] = text;
        setValues(field.key, current);
    };
    const addValueRow = (field) => setValues(field.key, [...fieldState(field, state).values, '']);
    const dropValueAt = (field, index) => {
        const current = fieldState(field, state).values.slice();
        current.splice(index, 1);
        setValues(field.key, current);
    };
    const revertAll = () => { setState(createEditState()); setError(null); };

    const addTag = () => {
        const { state: next, error: problem } = addField(state, model, newKey, [newValue], { bulk });
        setError(problem);
        if (problem) return;
        setState(next);
        setNewKey('');
        setNewValue('');
    };

    const jobs = useMemo(() => (tracks && model ? jobsForTracks(tracks, model, state, { bulk }) : []), [tracks, model, state, bulk]);
    const pendingJobs = jobs.filter(j => !isEmptyOperations(j.ops));
    const dirty = pendingJobs.length > 0;

    const save = async () => {
        setView('saving');
        setNeedsAccess(false);
        setError(null);
        setProgress({ done: 0, total: pendingJobs.length });
        abortRef.current = new AbortController();
        const outcome = await saveTagJobs(pendingJobs, { onProgress: setProgress, signal: abortRef.current.signal });
        setResults(outcome.results);
        setNeedsAccess(outcome.needsAccess);
        if (outcome.updated.length && onSaved) onSaved(outcome.updated);
        setView('done');
    };

    const retryAfterGrant = () => { setView('edit'); setResults(null); setNeedsAccess(false); };

    const title = bulk ? `Edit album tags (${songs.length} tracks)` : 'Edit tags';
    const subtitle = bulk ? `${songs[0].album} — ${songs[0].albumArtist || songs[0].artist}` : `${songs[0].title} — ${songs[0].artist}`;

    const renderField = (field) => {
        const fs = fieldState(field, state);
        const removed = fs.status === 'removed';
        const touched = fs.status !== 'untouched' || state.added.includes(field.key);
        const multiline = MULTILINE_FIELDS.has(field.key);
        const placeholder = removed ? '(removed)' : (field.mixed ? '(keep existing — values differ)' : '');
        const rows = fs.values.length ? fs.values : [''];
        const inputClass = `${fs.changed ? 'changed' : ''} ${field.mixed ? 'mixed' : ''}`;
        return (
            <React.Fragment key={field.key}>
                <label title={field.key}>{field.key}{field.mixed ? ' *' : ''}</label>
                <div className="edit-values">
                    {multiline ? (
                        <textarea value={removed ? '' : rows[0]} placeholder={placeholder} disabled={disabled || removed} className={inputClass}
                            onChange={e => setValues(field.key, [e.target.value])} spellCheck={false} />
                    ) : rows.map((text, i) => (
                        <div key={i} className="edit-value-row">
                            <input value={removed ? '' : text} placeholder={i === 0 ? placeholder : ''} disabled={disabled || removed} className={inputClass}
                                onChange={e => setValueAt(field, i, e.target.value)} spellCheck={false} />
                            {!disabled && !removed && rows.length > 1 && (
                                <button className="edit-value-btn" onClick={() => dropValueAt(field, i)} title="Remove this value"><X size={12} /></button>
                            )}
                        </div>
                    ))}
                    {!multiline && !disabled && !removed && (
                        <button className="edit-value-add" onClick={() => addValueRow(field)} title="Add another value to this tag"><Plus size={12} /> value</button>
                    )}
                </div>
                <div className="edit-actions">
                    {touched && <button onClick={() => update(s => revertField(s, field.key))} title="Revert"><Undo2 size={14} /></button>}
                    {!removed && !disabled && (field.values.length > 0 || field.mixed || fs.values.some(v => v.trim())) && (
                        <button onClick={() => update(s => removeField(s, field.key))} title={bulk ? 'Remove from all tracks' : 'Remove tag'}><Trash2 size={14} /></button>
                    )}
                </div>
            </React.Fragment>
        );
    };

    return (
        <div className="meta-overlay" onClick={view === 'saving' ? undefined : onClose}>
            <div className="meta-dialog wide" onClick={e => e.stopPropagation()}>
                <div className="meta-header">
                    <h2>{title}<span className="meta-sub">{subtitle}</span></h2>
                    {view !== 'saving' && <button className="meta-close" onClick={onClose} title="Close"><X size={18} /></button>}
                </div>

                <div className="meta-body">
                    {!canWrite && <div className="meta-banner">Tag writing is not available on this platform; the editor is read-only.</div>}
                    {canWrite && !anyWritable && (
                        <div className="meta-banner">
                            <AlertCircle size={16} />
                            {bulk ? 'None of these files' : `${songs[0].format} files`} can be written in this version (FLAC only). Fields are shown read-only.
                        </div>
                    )}
                    {canWrite && anyWritable && bulk && songs.some(s => !isWritableFormat(s.format)) && (
                        <div className="meta-banner">
                            <AlertCircle size={16} />
                            {songs.filter(s => !isWritableFormat(s.format)).length} non-FLAC track(s) will be skipped (read-only).
                        </div>
                    )}
                    {needsAccess && <FolderAccessBanner path={songs[0].path} purpose="edit tags" onGranted={retryAfterGrant} />}
                    {error && <div className="meta-banner error"><AlertCircle size={16} />{error}</div>}

                    {!tracks && <div className="meta-hint">Reading tags…</div>}

                    {tracks && view === 'edit' && (
                        <>
                            {bulk && <div className="meta-hint">Fields marked * differ between tracks: they are kept as they are unless you type a value (applies to all tracks) or remove them with the trash button (removes from all tracks). Title, track number and other per-track fields are edited per track.</div>}
                            <div className="edit-grid">
                                {fields.map(renderField)}
                            </div>
                            {canWrite && anyWritable && (
                                <div className="add-tag-row">
                                    <input className="meta-input" placeholder="NEW_TAG" value={newKey} onChange={e => setNewKey(e.target.value.toUpperCase())} spellCheck={false} />
                                    <input className="meta-input" placeholder="value" value={newValue} onChange={e => setNewValue(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') addTag(); }} spellCheck={false} />
                                    <button className="meta-btn" onClick={addTag} disabled={!newKey.trim()}><Plus size={14} /> Add</button>
                                </div>
                            )}
                            <div className="meta-hint" style={{ marginTop: 10 }}>A tag can hold several values: use “+ value” to add one (a value may contain “;”). Only the fields you change are written; every other tag in the file (pictures included) stays untouched.</div>
                        </>
                    )}

                    {tracks && view === 'preview' && (
                        <>
                            {pendingJobs.length === 0 && <div className="meta-hint">No changes to write.</div>}
                            {pendingJobs.map(({ song, ops }) => {
                                const diff = previewDiff(song.tags, ops);
                                return (
                                    <div key={song.path} className="diff-file">
                                        <h4>{song.title} <span className="meta-badge muted">{song.format}</span>{!isWritableFormat(song.format) && <span className="meta-badge muted">SKIPPED</span>}</h4>
                                        {diff.map(d => (
                                            <div key={d.key} className="diff-row">
                                                <span className="key">{d.key}</span>
                                                <span className="before">{d.before.length ? joinValues(d.before) : '(none)'}</span>
                                                <span className="after">{d.after.length ? joinValues(d.after) : '(removed)'}</span>
                                            </div>
                                        ))}
                                    </div>
                                );
                            })}
                        </>
                    )}

                    {(view === 'saving' || view === 'done') && (
                        <>
                            <div className="meta-hint">{view === 'saving' ? `Writing ${progress.done}/${progress.total}…` : `Finished: ${results?.filter(r => r.status === 'ok').length || 0} written, ${results?.filter(r => r.status === 'error').length || 0} failed, ${results?.filter(r => r.status === 'skipped').length || 0} skipped.`}</div>
                            <div className="progress-track"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
                            <div className="result-list">
                                {(results || []).map(r => (
                                    <div key={r.song.path} className={`result-row ${r.status}`}>
                                        {r.status === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
                                        <span className="name" title={r.song.path}>{r.song.title}</span>
                                        <span>{r.status === 'ok' ? (r.changed === false ? 'no change' : 'written') : r.error}</span>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                <div className="meta-footer">
                    {view === 'edit' && onMusicBrainz && canWrite && anyWritable && (
                        <button className="meta-btn" onClick={() => onMusicBrainz(songs)} title="Fill tags from a MusicBrainz release"><Search size={14} /> MusicBrainz…</button>
                    )}
                    <div className="spacer" />
                    {view === 'edit' && (
                        <>
                            <button className="meta-btn" onClick={revertAll} disabled={!isDirtyState(state)}><Undo2 size={14} /> Revert</button>
                            <button className="meta-btn" onClick={() => setView('preview')} disabled={!dirty}><Eye size={14} /> Preview ({pendingJobs.length})</button>
                            <button className="meta-btn primary" onClick={save} disabled={!dirty || !canWrite}><Save size={14} /> Save</button>
                        </>
                    )}
                    {view === 'preview' && (
                        <>
                            <button className="meta-btn" onClick={() => setView('edit')}>Back</button>
                            <button className="meta-btn primary" onClick={save} disabled={!dirty || !canWrite}><Save size={14} /> Write {pendingJobs.length} file(s)</button>
                        </>
                    )}
                    {view === 'done' && (
                        <>
                            {results?.some(r => r.status === 'error') && !needsAccess && <button className="meta-btn" onClick={() => setView('edit')}>Back to editor</button>}
                            <button className="meta-btn primary" onClick={onClose}>Done</button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TagEditor;
