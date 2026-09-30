import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Save, Check, AlertCircle } from 'lucide-react';
import Platform from '../../services/PlatformService';
import { createMusicBrainzClient, matchTracks, tagsForTrack, selectRowsToApply, OPT_IN_STATUSES } from '../../library/musicbrainz';
import { isWritableFormat } from '../../library/tagEdit';
import { formatTime } from '../../utils/format';
import { saveTagJobs } from './saveTags';
import FolderAccessBanner from './FolderAccessBanner';
import '../../styles/Metadata.css';

// One client for the whole app so the 1 req/s limit spans dialogs.
let sharedClient = null;
const client = () => (sharedClient = sharedClient || createMusicBrainzClient());

const STATUS_LABEL = { match: 'match', title: 'title differs', duration: 'length differs', unmatched: 'no release track', extra: 'not in library' };

/**
 * Looks an album up on MusicBrainz, shows candidate releases, a track-list diff for the
 * selected one and writes the chosen mapping (MUSICBRAINZ_* ids, numbering, album fields,
 * titles) to the files. Only exact matches are written by default: rows whose title or
 * length differs need a per-row opt-in, pairing leftovers by order is off unless asked for,
 * and unmatched tracks never receive tags.
 */
const MusicBrainzLookup = ({ songs, onClose, onSaved }) => {
    const first = songs[0] || {};
    const [album, setAlbum] = useState(first.album || '');
    const [artist, setArtist] = useState(first.albumArtist || first.artist || '');
    const [trackCount, setTrackCount] = useState(String(songs.length));
    const [candidates, setCandidates] = useState(null);
    const [selected, setSelected] = useState(null);      // full release
    const [selectedId, setSelectedId] = useState(null);
    const [loadingRelease, setLoadingRelease] = useState(false);
    const [busy, setBusy] = useState(false);
    const [optIn, setOptIn] = useState(() => new Set());   // song paths opted in for title/length mismatches
    const [pairByOrder, setPairByOrder] = useState(false);
    const [error, setError] = useState(null);
    const [writeTitles, setWriteTitles] = useState(true);
    const [writeAlbum, setWriteAlbum] = useState(true);
    const [view, setView] = useState('search');          // search | saving | done
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [results, setResults] = useState(null);
    const [needsAccess, setNeedsAccess] = useState(false);
    const abortRef = useRef(null);          // the search in flight
    const releaseAbortRef = useRef(null);   // the getRelease in flight
    const releaseSeq = useRef(0);           // token of the selection the next response must belong to

    useEffect(() => () => {
        if (abortRef.current) abortRef.current.abort();
        if (releaseAbortRef.current) releaseAbortRef.current.abort();
    }, []);

    const search = async () => {
        if (abortRef.current) abortRef.current.abort();
        abortRef.current = new AbortController();
        setBusy(true);
        setError(null);
        setCandidates(null);
        setSelected(null);
        setSelectedId(null);
        setOptIn(new Set());
        releaseSeq.current++;
        if (releaseAbortRef.current) releaseAbortRef.current.abort();
        setLoadingRelease(false);
        try {
            const n = parseInt(trackCount, 10);
            const list = await client().searchReleases({ album, artist, trackCount: Number.isInteger(n) && n > 0 ? n : undefined }, { signal: abortRef.current.signal });
            setCandidates(list);
            if (list.length === 0) setError('No releases found. Try fewer words or drop the track count.');
        } catch (e) {
            if (e?.name !== 'AbortError') setError(e?.message || 'Search failed');
        } finally {
            setBusy(false);
        }
    };

    // Search once on open with the album's own data.
    useEffect(() => { if (album || artist) search(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

    const choose = async (candidate) => {
        // Each selection gets its own token and controller: a response that arrives for an
        // earlier selection is ignored (and its request aborted), so the table never shows
        // one release's tracks under another release's name.
        const token = ++releaseSeq.current;
        if (releaseAbortRef.current) releaseAbortRef.current.abort();
        const controller = new AbortController();
        releaseAbortRef.current = controller;
        setSelectedId(candidate.id);
        setSelected(null);
        setOptIn(new Set());
        setLoadingRelease(true);
        setError(null);
        try {
            const release = await client().getRelease(candidate.id, { signal: controller.signal });
            if (token !== releaseSeq.current) return;   // stale: another candidate was chosen since
            if (!release || release.id !== candidate.id) throw new Error('Release not found');
            setSelected(release);
        } catch (e) {
            if (token !== releaseSeq.current || e?.name === 'AbortError') return;
            setError(e?.message || 'Could not load the release');
        } finally {
            if (token === releaseSeq.current) setLoadingRelease(false);
        }
    };

    const match = useMemo(() => (selected ? matchTracks(songs, selected, { pairLeftoversByOrder: pairByOrder }) : null), [selected, songs, pairByOrder]);

    const toggleOptIn = (path) => setOptIn(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
    });

    const applicable = useMemo(() => (match ? selectRowsToApply(match.rows, optIn) : []), [match, optIn]);
    const applicablePaths = useMemo(() => new Set(applicable.map(r => r.song.path)), [applicable]);

    const jobs = useMemo(() => applicable.map(r => ({ song: r.song, ops: tagsForTrack(selected, r.track, { titles: writeTitles, album: writeAlbum }) })),
        [applicable, selected, writeTitles, writeAlbum]);

    const writable = jobs.filter(j => isWritableFormat(j.song.format));
    const optInCount = match ? match.rows.filter(r => r.song && OPT_IN_STATUSES.includes(r.status)).length : 0;

    const apply = async () => {
        setView('saving');
        setNeedsAccess(false);
        setProgress({ done: 0, total: jobs.length });
        const outcome = await saveTagJobs(jobs, { onProgress: setProgress });
        setResults(outcome.results);
        setNeedsAccess(outcome.needsAccess);
        if (outcome.updated.length && onSaved) onSaved(outcome.updated);
        setView('done');
    };

    return (
        <div className="meta-overlay" onClick={view === 'saving' ? undefined : onClose}>
            <div className="meta-dialog wide" onClick={e => e.stopPropagation()}>
                <div className="meta-header">
                    <h2>MusicBrainz lookup<span className="meta-sub">{songs.length} track(s) · {first.album}</span></h2>
                    {view !== 'saving' && <button className="meta-close" onClick={onClose}><X size={18} /></button>}
                </div>

                <div className="meta-body">
                    {needsAccess && <FolderAccessBanner path={first.path} purpose="write tags" onGranted={() => { setView('search'); setResults(null); setNeedsAccess(false); }} />}
                    {error && <div className="meta-banner error"><AlertCircle size={16} />{error}</div>}

                    {view === 'search' && (
                        <>
                            <div className="mb-search">
                                <div><label>Album</label><input className="meta-input" value={album} onChange={e => setAlbum(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} /></div>
                                <div><label>Artist</label><input className="meta-input" value={artist} onChange={e => setArtist(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} /></div>
                                <div><label>Tracks</label><input className="meta-input" value={trackCount} onChange={e => setTrackCount(e.target.value.replace(/\D/g, ''))} /></div>
                                <button className="meta-btn primary" onClick={search} disabled={busy || (!album && !artist)}><Search size={14} /> Search</button>
                            </div>

                            {busy && !candidates && <div className="meta-hint">Searching MusicBrainz… (requests are spaced 1 s apart)</div>}

                            {candidates && candidates.length > 0 && (
                                <>
                                    <div className="meta-section-title">Candidates</div>
                                    {candidates.map(c => (
                                        <div key={c.id} className={`mb-candidate ${c.id === selectedId ? 'active' : ''}`} onClick={() => choose(c)}>
                                            <div>
                                                <div className="title">{c.title} <span style={{ fontWeight: 400 }}>— {c.artist}</span></div>
                                                <div className="details">
                                                    {[c.date, c.country, c.label, c.catalogNumber, c.status, c.disambiguation].filter(Boolean).join(' · ')}
                                                    {' · '}{c.trackCount} tracks{c.media.length > 1 ? ` on ${c.media.length} discs` : ''}{c.media[0]?.format ? ` · ${c.media[0].format}` : ''}
                                                </div>
                                            </div>
                                            {c.score !== null && <span className="score">{c.score}%</span>}
                                        </div>
                                    ))}
                                </>
                            )}

                            {selectedId && !selected && loadingRelease && <div className="meta-hint">Loading track list…</div>}

                            {selected && match && (
                                <>
                                    <div className="meta-section-title">Track list — {match.matched}/{match.total} exact matches, {writable.length} to write</div>
                                    <table className="mb-diff">
                                        <thead>
                                            <tr><th title="Write tags to this track">✓</th><th>#</th><th>Library</th><th>Length</th><th>#</th><th>MusicBrainz</th><th>Length</th><th>Status</th></tr>
                                        </thead>
                                        <tbody>
                                            {match.rows.map((row, i) => (
                                                <tr key={i} className={`${row.status} ${row.song && !applicablePaths.has(row.song.path) ? 'skipped' : ''}`}>
                                                    <td className="opt">
                                                        {row.song && row.status === 'match' && <Check size={13} />}
                                                        {row.song && OPT_IN_STATUSES.includes(row.status) && (
                                                            <input type="checkbox" checked={optIn.has(row.song.path)} onChange={() => toggleOptIn(row.song.path)}
                                                                title="Write this track anyway (title or length differs)" />
                                                        )}
                                                    </td>
                                                    <td>{row.song ? `${row.song.discNumber ? row.song.discNumber + '-' : ''}${row.song.trackNumber ?? '—'}` : ''}</td>
                                                    <td>{row.song?.title || ''}</td>
                                                    <td>{row.song ? formatTime(row.song.duration) : ''}</td>
                                                    <td>{row.track ? `${match.discCount > 1 ? row.track.disc + '-' : ''}${row.track.position}` : ''}</td>
                                                    <td>{row.track?.title || ''}</td>
                                                    <td>{row.track ? formatTime(row.track.length) : ''}</td>
                                                    <td className="status">{STATUS_LABEL[row.status]}{row.status === 'duration' ? ` (${row.durationDelta > 0 ? '+' : ''}${row.durationDelta}s)` : ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className="mb-options">
                                        <label><input type="checkbox" checked={writeTitles} onChange={e => setWriteTitles(e.target.checked)} /> Write titles and artists</label>
                                        <label><input type="checkbox" checked={writeAlbum} onChange={e => setWriteAlbum(e.target.checked)} /> Write album, album artist, date, label</label>
                                        <label title="Guess: pairs the tracks left over on both sides in order"><input type="checkbox" checked={pairByOrder} onChange={e => setPairByOrder(e.target.checked)} /> Pair remaining tracks by order</label>
                                    </div>
                                    <div className="meta-hint" style={{ marginTop: 8 }}>
                                        Only exact matches are written{optInCount > 0 ? `; tick the ${optInCount} row(s) whose title or length differs to write them too` : ''}. Tracks without a release track never get tags.
                                        {' '}Written for each: MUSICBRAINZ_ALBUMID, RELEASETRACKID, TRACKID, ARTISTID, ALBUMARTISTID, RELEASEGROUPID, TRACKNUMBER/TRACKTOTAL, DISCNUMBER/DISCTOTAL.
                                        {writable.length < jobs.length && ` ${jobs.length - writable.length} non-FLAC track(s) will be skipped.`}
                                    </div>
                                </>
                            )}
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
                                        <span className="name">{r.song.title}</span>
                                        <span>{r.status === 'ok' ? (r.changed === false ? 'no change' : 'written') : r.error}</span>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                <div className="meta-footer">
                    <div className="spacer" />
                    {view === 'search' && (
                        <button className="meta-btn primary" onClick={apply} disabled={!selected || loadingRelease || writable.length === 0 || busy || !Platform.supportsTagWriting()}>
                            <Save size={14} /> Apply to {writable.length} file(s)
                        </button>
                    )}
                    {view === 'done' && <button className="meta-btn primary" onClick={onClose}>Done</button>}
                </div>
            </div>
        </div>
    );
};

export default MusicBrainzLookup;
