import React, { useMemo, useState } from 'react';
import { Folder, ChevronRight, Play, Shuffle } from 'lucide-react';
import { formatTime } from '../utils/format';
import { buildFolderTree, collectSongs, findNode } from '../library/folders';
import { describeTierCounts } from '../library/qualityGroups';
import { trackDisplayTitle } from '../library/classical';
import QualityBadge from './QualityBadge';
import AddToPlaylistButton from './AddToPlaylistButton';
import useViewBack from './useViewBack';
import viewMemory from './viewMemory';
import { plural, shuffled } from '../utils/list';
import '../styles/Library.css';
import '../styles/Folders.css';

const FoldersView = ({ songs, onPlaySong, playlists = [], onAddToPlaylist, backRef }) => {
    const [path, setPathState] = useState(viewMemory.foldersPath);
    const setPath = (p) => { viewMemory.foldersPath = p; setPathState(p); };
    const tree = useMemo(() => buildFolderTree(songs), [songs]);
    // A path that no longer exists (library refreshed) resolves to its nearest parent.
    const { node, segments } = useMemo(() => findNode(tree.root, path), [tree, path]);

    useViewBack(backRef, () => {
        if (segments.length === 0) return false;
        setPath(segments.slice(0, -1));
        return true;
    });

    const all = useMemo(() => collectSongs(node), [node]);
    // Display strings per row, recomputed only when the folder changes (not each playback tick).
    const childRows = useMemo(() => node.children.map(child => {
        const summary = describeTierCounts(child.tiers);
        return { child, sub: `${plural(child.count, 'track')}${summary ? ` · ${summary}` : ''}` };
    }), [node]);
    const songRows = useMemo(() => node.songs.map(song => ({ song, title: trackDisplayTitle(song) })), [node]);
    const crumbs = [{ name: tree.root.name, segments: [] }, ...segments.map((name, i) => ({ name, segments: segments.slice(0, i + 1) }))];

    return (
        <div className="folders-view library">
            <h1>Folders</h1>
            <nav className="breadcrumbs" aria-label="Folder path">
                {crumbs.map((c, i) => (
                    <React.Fragment key={c.segments.join('/') || 'root'}>
                        {i > 0 && <ChevronRight size={14} className="crumb-sep" />}
                        {i === crumbs.length - 1
                            ? <span className="crumb current">{c.name}</span>
                            : <button className="crumb" onClick={() => setPath(c.segments)}>{c.name}</button>}
                    </React.Fragment>
                ))}
            </nav>

            {all.length > 0 && (
                <div className="action-buttons folder-actions">
                    <button className="play-all-btn" onClick={() => onPlaySong(all[0], all)}>
                        <Play fill="white" size={20} /> Play
                    </button>
                    <button className="shuffle-btn-flat" onClick={() => { const q = shuffled(all); onPlaySong(q[0], q); }}>
                        <Shuffle size={20} /> Shuffle
                    </button>
                    <AddToPlaylistButton playlists={playlists} getSongs={() => all} onAddToPlaylist={onAddToPlaylist} />
                </div>
            )}

            <div className="folder-list">
                {childRows.map(({ child, sub }) => {
                    return (
                        <div key={child.name} className="folder-row" onClick={() => setPath(child.segments)}>
                            <Folder size={20} className="folder-icon" />
                            <div className="folder-meta">
                                <span className="folder-name">{child.name}</span>
                                <span className="folder-sub">{sub}</span>
                            </div>
                            <ChevronRight size={16} className="folder-chevron" />
                        </div>
                    );
                })}
            </div>

            {node.songs.length > 0 && (
                <div className="track-list">
                    {songRows.map(({ song, title }, i) => (
                        <div key={song.path} className="track-row" onClick={() => onPlaySong(song, node.songs)}>
                            <span className="track-num">{i + 1}</span>
                            <span className="track-name">{title}</span>
                            <QualityBadge quality={song.quality} compact />
                            <span className="track-dur">{formatTime(song.duration)}</span>
                        </div>
                    ))}
                </div>
            )}

            {all.length === 0 && (
                <div className="empty-message">No music found. Add a folder to get started.</div>
            )}
        </div>
    );
};

export default FoldersView;
