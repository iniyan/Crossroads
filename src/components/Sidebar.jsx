import React, { useState } from 'react';
import { Home, Library, Disc, Music, ListMusic, Plus, Sparkles, Check, X, Quote } from 'lucide-react';
import '../styles/Sidebar.css';

const Sidebar = ({ view, setView, onScan, playlists = [], smartPlaylists = [], onCreatePlaylist, onOpenPlaylist, selectedPlaylistId }) => {
    const [isCreating, setIsCreating] = useState(false);
    const [newName, setNewName] = useState('');

    const handleCreateSubmit = () => {
        console.log('Sidebar: handleCreateSubmit', newName);
        if (newName.trim()) {
            onCreatePlaylist(newName.trim());
            setNewName('');
            setIsCreating(false);
        }
    };

    return (
        <div className="sidebar">
            <div className="brand">
                <div className="brand-logo">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#CD7F32" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" strokeOpacity="0.2" />
                        <path d="M12 2v20M2 12h20" strokeOpacity="0.2" />
                        <path d="M5 5l14 14M5 19l14-14" />
                    </svg>
                </div>
                <h2>Cross<span style={{ color: '#CD7F32' }}>roads</span></h2>
            </div>

            <div className="nav-items">
                <div
                    className={`nav-item ${view === 'dashboard' ? 'active' : ''}`}
                    onClick={() => setView('dashboard')}
                >
                    <Home size={20} />
                    <span>Dashboard</span>
                </div>
                <div
                    className={`nav-item ${view === 'library' ? 'active' : ''}`}
                    onClick={() => setView('library')}
                >
                    <Library size={20} />
                    <span>Library</span>
                </div>
                <div
                    className={`nav-item ${view === 'lyrics' ? 'active' : ''}`}
                    onClick={() => setView('lyrics')}
                >
                    <Quote size={20} />
                    <span>Lyrics</span>
                </div>

                <div className="section-title">SMART PLAYLISTS</div>
                <div className="playlist-list">
                    {smartPlaylists.map(pl => (
                        <div
                            key={pl.id}
                            className={`nav-item sm ${view === 'playlist' && pl.id === selectedPlaylistId ? 'active' : ''}`}
                            onClick={() => {
                                console.log('Opening smart playlist:', pl.id);
                                onOpenPlaylist(pl.id);
                            }}
                        >
                            <Sparkles size={16} />
                            <span>{pl.name}</span>
                        </div>
                    ))}
                </div>

                <div className="section-title">
                    USER PLAYLISTS
                    <button className="add-pl-btn" title="Create Playlist" onClick={e => {
                        console.log('Plus button clicked');
                        e.stopPropagation();
                        setIsCreating(true);
                    }}>
                        <Plus size={14} />
                    </button>
                </div>

                {isCreating && (
                    <div className="inline-create">
                        <input
                            autoFocus
                            placeholder="Playlist name..."
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCreateSubmit();
                                if (e.key === 'Escape') setIsCreating(false);
                            }}
                        />
                        <div className="actions">
                            <button onClick={handleCreateSubmit} className="btn-save"><Check size={14} /></button>
                            <button onClick={() => setIsCreating(false)} className="btn-cancel"><X size={14} /></button>
                        </div>
                    </div>
                )}

                <div className="playlist-list">
                    {playlists.map(pl => (
                        <div
                            key={pl.id}
                            className={`nav-item sm ${view === 'playlist' && pl.id === selectedPlaylistId ? 'active' : ''}`}
                            onClick={() => {
                                console.log('Opening user playlist:', pl.id);
                                onOpenPlaylist(pl.id);
                            }}
                        >
                            <ListMusic size={16} />
                            <span>{pl.name}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="spacer" style={{ flex: 1 }}></div>

            <button className="scan-btn" onClick={onScan}>
                <Music size={16} />
                <span>Add Music Folder</span>
            </button>
        </div>
    );
};

export default Sidebar;
