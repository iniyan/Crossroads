import React, { useMemo, useState } from 'react';
import { ChevronRight, Play, User, Music2 } from 'lucide-react';
import { formatTime } from '../utils/format';
import { buildClassicalIndex, performersLine } from '../library/classical';
import { albumQuality } from '../library/qualityGroups';
import Artwork from './Artwork';
import QualityBadge from './QualityBadge';
import AddToPlaylistButton from './AddToPlaylistButton';
import useViewBack from './useViewBack';
import viewMemory from './viewMemory';
import { plural } from '../utils/list';
import '../styles/Library.css';
import '../styles/Folders.css';
import '../styles/Classical.css';

// Composers -> Works -> Recordings of one work.
const ClassicalView = ({ songs, onPlaySong, playlists = [], onAddToPlaylist, backRef }) => {
    const [composerKey, setComposerKeyState] = useState(viewMemory.composerKey);
    const [workKey, setWorkKeyState] = useState(viewMemory.workKey);
    const setComposerKey = (k) => { viewMemory.composerKey = k; setComposerKeyState(k); };
    const setWorkKey = (k) => { viewMemory.workKey = k; setWorkKeyState(k); };

    const index = useMemo(() => buildClassicalIndex(songs), [songs]);
    const composer = index.find(c => c.key === composerKey) || null;
    const work = composer?.works.find(w => w.key === workKey) || null;

    useViewBack(backRef, () => {
        if (work) { setWorkKey(null); return true; }
        if (composer) { setComposerKey(null); return true; }
        return false;
    });

    const openComposer = (key) => { setComposerKey(key); setWorkKey(null); };

    // Quality + performer strings per recording, recomputed only when the open work changes.
    const recordings = useMemo(() => (work ? work.recordings.map(rec => ({
        rec,
        quality: albumQuality(rec.songs),
        who: [rec.conductor, rec.ensemble].filter(Boolean).join(' · '),
        movements: rec.movements.map(m => ({ ...m, performers: performersLine(m.song) }))
    })) : []), [work]);

    const crumbs = [{ name: 'Composers', go: () => { setComposerKey(null); setWorkKey(null); } }];
    if (composer) crumbs.push({ name: composer.name, go: () => setWorkKey(null) });
    if (work) crumbs.push({ name: work.title });

    return (
        <div className="classical-view library">
            <h1>{work ? work.title : composer ? composer.name : 'Composers'}</h1>
            <nav className="breadcrumbs" aria-label="Classical navigation">
                {crumbs.map((c, i) => (
                    <React.Fragment key={i}>
                        {i > 0 && <ChevronRight size={14} className="crumb-sep" />}
                        {i === crumbs.length - 1
                            ? <span className="crumb current">{c.name}</span>
                            : <button className="crumb" onClick={c.go}>{c.name}</button>}
                    </React.Fragment>
                ))}
            </nav>

            {!composer && (
                <div className="folder-list">
                    {index.map(c => (
                        <div key={c.key} className="folder-row" onClick={() => openComposer(c.key)}>
                            <User size={20} className="folder-icon" />
                            <div className="folder-meta">
                                <span className="folder-name">{c.name}</span>
                                <span className="folder-sub">{plural(c.works.length, 'work')} {'·'} {plural(c.trackCount, 'track')}</span>
                            </div>
                            <ChevronRight size={16} className="folder-chevron" />
                        </div>
                    ))}
                    {index.length === 0 && <div className="empty-message">No composer tags found in your library.</div>}
                </div>
            )}

            {composer && !work && (
                <div className="folder-list">
                    {composer.works.map(w => (
                        <div key={w.key} className="folder-row" onClick={() => setWorkKey(w.key)}>
                            <Music2 size={20} className="folder-icon" />
                            <div className="folder-meta">
                                <span className="folder-name">{w.title}</span>
                                <span className="folder-sub">{plural(w.recordings.length, 'recording')} {'·'} {plural(w.trackCount, 'track')}</span>
                            </div>
                            <ChevronRight size={16} className="folder-chevron" />
                        </div>
                    ))}
                </div>
            )}

            {work && recordings.map(({ rec, quality, who, movements }) => {
                return (
                    <section key={rec.key} className="recording">
                        <div className="recording-head">
                            <div className="recording-cover">
                                <Artwork src={rec.cover} placeholder={<div className="placeholder" />} />
                            </div>
                            <div className="recording-info">
                                <div className="recording-album">{rec.album || 'Unknown Album'}{rec.year ? ` (${rec.year})` : ''}</div>
                                {who && <div className="recording-who">{who}</div>}
                                {rec.performers.length > 0 && <div className="recording-perf">{rec.performers.join(', ')}</div>}
                                <div className="recording-actions">
                                    <button className="play-all-btn" onClick={() => onPlaySong(rec.songs[0], rec.songs)}>
                                        <Play fill="white" size={18} /> Play work
                                    </button>
                                    <AddToPlaylistButton playlists={playlists} getSongs={() => rec.songs} onAddToPlaylist={onAddToPlaylist} label="Add" />
                                    <QualityBadge quality={quality} mixed={quality.mixed} />
                                </div>
                            </div>
                        </div>
                        <div className="track-list">
                            {movements.map((m, i) => (
                                <div key={m.song.path} className="track-row" onClick={() => onPlaySong(m.song, rec.songs)} title={m.performers}>
                                    <span className="track-num">{m.number ?? i + 1}</span>
                                    <span className="track-name">{m.name}</span>
                                    <QualityBadge quality={m.song.quality} compact />
                                    <span className="track-dur">{formatTime(m.song.duration)}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                );
            })}
        </div>
    );
};

export default ClassicalView;
