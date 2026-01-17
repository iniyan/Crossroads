import React, { useMemo, useState } from 'react';
import { Play, Trash2, Sparkles, Clock, Star, Heart, Plus, Search, Check, X, Disc } from 'lucide-react';
import '../styles/Library.css';

const PlaylistView = ({ playlist, allSongs, stats, favorites = [], onPlaySong, onDeletePlaylist, onToggleFavorite, onAddToPlaylist }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [search, setSearch] = useState('');
    const [selectedPaths, setSelectedPaths] = useState(new Set());

    const toggleSongSelection = (path) => {
        const next = new Set(selectedPaths);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        setSelectedPaths(next);
    };

    const handleAddSelected = () => {
        const songsToAdd = Array.from(selectedPaths).map(path => allSongs.find(s => s.path === path)).filter(Boolean);
        onAddToPlaylist(playlist.id, songsToAdd);
        setIsAdding(false);
        setSelectedPaths(new Set());
    };

    if (!playlist) return null;

    const playlistSongs = useMemo(() => {
        if (!playlist.type) {
            // User Playlist
            return playlist.songs.map(path => allSongs.find(s => s.path === path)).filter(Boolean);
        }

        // Smart Playlist Logic
        const history = stats.playHistory || [];

        if (playlist.id === 'favorites') {
            return (favorites || []).map(path => allSongs.find(s => s.path === path)).filter(Boolean);
        }

        if (playlist.id === 'recent') {
            const seen = new Set();
            const lastPlayed = [];
            [...history].reverse().forEach(play => {
                if (!seen.has(play.path)) {
                    const song = allSongs.find(s => s.path === play.path);
                    if (song) {
                        lastPlayed.push(song);
                        seen.add(play.path);
                    }
                }
            });
            return lastPlayed.slice(0, 30);
        }

        if (playlist.id === 'top-tracks') {
            const counts = {};
            history.forEach(play => {
                counts[play.path] = (counts[play.path] || 0) + 1;
            });
            return Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 30)
                .map(([path]) => allSongs.find(s => s.path === path))
                .filter(Boolean);
        }

        if (playlist.id === 'recommendations') {
            // Simple Recommend: Based on top artists
            const artistCounts = {};
            history.forEach(play => {
                const song = allSongs.find(s => s.path === play.path);
                if (song) {
                    artistCounts[song.artist] = (artistCounts[song.artist] || 0) + 1;
                }
            });
            const topArtist = Object.entries(artistCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
            if (!topArtist) return [];

            // Return songs from top artist NOT in recent history
            const recentPaths = new Set(history.slice(-50).map(p => p.path));
            return allSongs.filter(s => s.artist === topArtist && !recentPaths.has(s.path)).slice(0, 30);
        }

        return [];
    }, [playlist, allSongs, stats]);

    const isSmart = playlist.type === 'smart';

    return (
        <div className="album-detail">
            <div className="album-header">
                <div className="album-cover-lg" style={{
                    background: isSmart
                        ? (playlist.id === 'favorites' ? 'linear-gradient(135deg, #f43f5e, #fb7185)' : 'linear-gradient(135deg, #FF3D00, #FFD600)')
                        : 'linear-gradient(45deg, #7c4dff, #00e5ff)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    {isSmart ? (
                        playlist.id === 'favorites' ? <Heart size={80} fill="white" color="white" /> :
                            playlist.id === 'recent' ? <Clock size={80} color="rgba(255,255,255,0.4)" /> :
                                playlist.id === 'top-tracks' ? <Star size={80} color="rgba(255,255,255,0.4)" /> :
                                    <Sparkles size={80} color="rgba(255,255,255,0.4)" />
                    ) : (
                        <div style={{ fontSize: 60, fontWeight: 'bold', color: 'rgba(255,255,255,0.3)' }}>
                            {playlist.name[0].toUpperCase()}
                        </div>
                    )}
                </div>
                <div className="album-info">
                    <div style={{ fontSize: 12, fontWeight: 'bold', letterSpacing: 1, marginBottom: 8, color: 'var(--accent-monitor)' }}>
                        {isSmart ? 'SMART PLAYLIST' : 'USER PLAYLIST'}
                    </div>
                    <h1>{playlist.name}</h1>
                    <p className="meta">{playlistSongs.length} songs • {
                        (() => {
                            const s = playlistSongs.reduce((acc, song) => acc + (song.duration || 0), 0);
                            const mins = Math.floor(s / 60);
                            const secs = Math.floor(s % 60);
                            return `${mins} min ${secs < 10 ? '0' : ''}${secs} sec`;
                        })()
                    }</p>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button className="play-all-btn" onClick={() => onPlaySong(playlistSongs[0], playlistSongs)} disabled={playlistSongs.length === 0}>
                            <Play fill="white" size={20} /> Play
                        </button>
                        {!isSmart && (
                            <>
                                <button className="shuffle-btn-flat" onClick={() => setIsAdding(true)}>
                                    <Plus size={20} /> Add Songs
                                </button>
                                <button className="icon-btn" onClick={() => onDeletePlaylist(playlist.id)} title="Delete Playlist">
                                    <Trash2 size={20} color="#ff5252" />
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {isAdding && (
                <div className="selection-overlay">
                    <div className="selection-content">
                        <div className="selection-header">
                            <div>
                                <h2>Select Songs</h2>
                                <p>{selectedPaths.size} songs selected</p>
                            </div>
                            <div className="search-box">
                                <Search size={16} />
                                <input
                                    placeholder="Filter library..."
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <button className="icon-btn" onClick={() => setIsAdding(false)}><X /></button>
                        </div>

                        <div className="selection-list">
                            {allSongs
                                .filter(s => s.title.toLowerCase().includes(search.toLowerCase()) || s.artist.toLowerCase().includes(search.toLowerCase()))
                                .map(song => (
                                    <div
                                        key={song.path}
                                        className={`sel-row ${selectedPaths.has(song.path) ? 'active' : ''}`}
                                        onClick={() => toggleSongSelection(song.path)}
                                    >
                                        <div className="sel-check">
                                            {selectedPaths.has(song.path) ? <Check size={14} color="white" /> : null}
                                        </div>
                                        <div className="sel-info">
                                            <span className="sel-title">{song.title}</span>
                                            <span className="sel-artist">{song.artist} • {song.album}</span>
                                        </div>
                                    </div>
                                ))}
                        </div>

                        <div className="selection-footer">
                            <button className="cancel-btn" onClick={() => setIsAdding(false)}>Cancel</button>
                            <button
                                className="add-all-btn"
                                onClick={handleAddSelected}
                                disabled={selectedPaths.size === 0}
                            >
                                Add {selectedPaths.size} Songs
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="track-list">
                {playlistSongs.length === 0 ? (
                    <div className="empty-state">
                        <Disc size={48} style={{ opacity: 0.2, marginBottom: 16 }} />
                        <p>This playlist is empty.</p>
                        <button className="shuffle-btn-flat" style={{ marginTop: 20 }} onClick={() => setIsAdding(true)}>
                            <Plus size={18} /> Add Songs from Library
                        </button>
                    </div>
                ) : (
                    playlistSongs.map((song, i) => (
                        <div key={`${song.path}-${i}`} className="track-row" onClick={() => onPlaySong(song, playlistSongs)}>
                            <span className="track-num">{i + 1}</span>
                            <div className="track-fav-icon" onClick={(e) => { e.stopPropagation(); onToggleFavorite(song.path); }}>
                                <Heart size={14} fill={favorites.includes(song.path) ? "var(--accent-color)" : "none"} color={favorites.includes(song.path) ? "var(--accent-color)" : "var(--text-secondary)"} />
                            </div>
                            <div className="track-meta-compact">
                                <span className="track-name">{song.title}</span>
                                <span className="track-artist-sub">{song.artist} • {song.album}</span>
                            </div>
                            <span className="track-dur">{(song.duration / 60).toFixed(0)}:{Math.floor(song.duration % 60).toString().padStart(2, '0')}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default PlaylistView;
