import React, { useState } from 'react';
import { X, Check, AlertCircle, ListMusic } from 'lucide-react';
import '../../styles/Metadata.css';

const METHOD_LABEL = {
    path: 'path', 'relative-to-playlist': 'relative path', 'relative-to-root': 'relative to library', trackKey: 'track key', metadata: 'artist/title', filename: 'file name'
};

/**
 * Shows what an imported .m3u/.m3u8 resolved to (matched tracks with how they were found,
 * unmatched entries) and lets the user name and create the playlist.
 */
const PlaylistImportDialog = ({ fileName, resolution, onCreate, onClose }) => {
    const defaultName = String(fileName || 'Imported playlist').replace(/\.m3u8?$/i, '');
    const [name, setName] = useState(defaultName);
    const { results, matched, unmatched } = resolution;

    return (
        <div className="meta-overlay" onClick={onClose}>
            <div className="meta-dialog" onClick={e => e.stopPropagation()}>
                <div className="meta-header">
                    <h2>Import playlist<span className="meta-sub">{fileName} · {matched.length} of {results.length} entries found</span></h2>
                    <button className="meta-close" onClick={onClose}><X size={18} /></button>
                </div>
                <div className="meta-body">
                    {unmatched.length > 0 && (
                        <div className="meta-banner">
                            <AlertCircle size={16} />
                            {unmatched.length} entr{unmatched.length === 1 ? 'y' : 'ies'} could not be matched to a track in your library and will be left out.
                        </div>
                    )}
                    <div className="meta-section-title">Playlist name</div>
                    <input className="meta-input" value={name} onChange={e => setName(e.target.value)} />

                    <div className="meta-section-title">Entries</div>
                    <div className="result-list">
                        {results.map((r, i) => (
                            <div key={i} className={`result-row ${r.song ? 'ok' : 'error'}`}>
                                {r.song ? <Check size={14} /> : <AlertCircle size={14} />}
                                <span className="name" title={r.entry.path}>
                                    {r.song ? `${r.song.title} — ${r.song.artist}` : (r.entry.title ? `${r.entry.artist ? r.entry.artist + ' — ' : ''}${r.entry.title}` : r.entry.path)}
                                </span>
                                <span style={{ fontSize: 11, opacity: 0.8 }}>{r.song ? METHOD_LABEL[r.method] || r.method : `line ${r.entry.line}: not found`}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="meta-footer">
                    <div className="spacer" />
                    <button className="meta-btn" onClick={onClose}>Cancel</button>
                    <button className="meta-btn primary" disabled={matched.length === 0 || !name.trim()} onClick={() => onCreate(name.trim(), matched)}>
                        <ListMusic size={14} /> Create playlist ({matched.length})
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PlaylistImportDialog;
