import React, { useState, useMemo, useEffect } from 'react';
import { Play, MoreVertical, Shuffle, Heart } from 'lucide-react';
import '../styles/Library.css';

const Library = ({ songs, onPlaySong, playlists = [], onAddToPlaylist, favorites = [], onToggleFavorite }) => {
    const [selectedAlbum, setSelectedAlbum] = useState(null);
    const [contextMenu, setContextMenu] = useState(null);

    const albums = useMemo(() => {
        // ... (unchanged)
        const map = {};
        songs.forEach(song => {
            if (!map[song.album]) {
                map[song.album] = {
                    title: song.album,
                    artist: song.artist,
                    cover: song.picture,
                    songs: []
                };
            }
            map[song.album].songs.push(song);
        });
        return Object.values(map);
    }, [songs]);

    const handleContextMenu = (e, song) => {
        e.preventDefault();
        e.stopPropagation();

        const menuWidth = 180;
        const menuHeight = 200; // Estimated max height

        let x = e.clientX;
        let y = e.clientY;

        // Prevent overflow
        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 20;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 20;

        setContextMenu({ x, y, song });
    };

    // Close menu on click elsewhere
    useEffect(() => {
        const close = () => setContextMenu(null);
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, []);

    if (selectedAlbum) {
        const totalDuration = selectedAlbum.songs.reduce((acc, s) => acc + (s.duration || 0), 0);
        const formatTotalTime = (s) => {
            const mins = Math.floor(s / 60);
            const secs = Math.floor(s % 60);
            return `${mins} min ${secs < 10 ? '0' : ''}${secs} sec`;
        };

        return (
            <div className="album-detail">
                <button className="back-btn" onClick={() => setSelectedAlbum(null)}>← Back to Library</button>

                <div className="album-header">
                    <div className="album-cover-lg">
                        {selectedAlbum.cover ? <img src={selectedAlbum.cover} alt="" /> : <div className="placeholder" />}
                    </div>
                    <div className="album-info">
                        <h1>{selectedAlbum.title}</h1>
                        <p className="artist-meta">
                            {selectedAlbum.artist}
                            {selectedAlbum.songs[0]?.composer && (
                                <span className="composer-tag"> • Music: {selectedAlbum.songs[0].composer}</span>
                            )}
                        </p>
                        <p className="meta">{selectedAlbum.songs.length} songs • {formatTotalTime(totalDuration)}</p>
                        <div className="action-buttons">
                            <button className="play-all-btn" onClick={() => onPlaySong(selectedAlbum.songs[0], selectedAlbum.songs)}>
                                <Play fill="white" size={20} /> Play
                            </button>
                            <button className="shuffle-btn-flat" onClick={() => onPlaySong(selectedAlbum.songs[Math.floor(Math.random() * selectedAlbum.songs.length)], selectedAlbum.songs)}>
                                <Shuffle size={20} /> Shuffle
                            </button>
                        </div>
                    </div>
                </div>

                <div className="track-list">
                    {selectedAlbum.songs.map((song, i) => (
                        <div
                            key={song.path}
                            className="track-row"
                            onClick={() => onPlaySong(song, selectedAlbum.songs)}
                            onContextMenu={(e) => handleContextMenu(e, song)}
                            style={{ position: 'relative' }}
                        >
                            <span className="track-num">{i + 1}</span>
                            <div className="track-fav-icon" onClick={(e) => { e.stopPropagation(); onToggleFavorite(song.path); }}>
                                <Heart size={14} fill={favorites.includes(song.path) ? "var(--accent-color)" : "none"} color={favorites.includes(song.path) ? "var(--accent-color)" : "var(--text-secondary)"} />
                            </div>
                            <span className="track-name">{song.title}</span>
                            <span className="track-dur">{(song.duration / 60).toFixed(0)}:{Math.floor(song.duration % 60).toString().padStart(2, '0')}</span>
                            <button className="context-btn icon-btn sm" onClick={(e) => handleContextMenu(e, song)} style={{ marginLeft: 10 }}>
                                <MoreVertical size={16} />
                            </button>
                        </div>
                    ))}
                </div>

                {contextMenu && (
                    <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
                        <div className="menu-header">Add to Playlist</div>
                        {playlists.length === 0 ? (
                            <div className="menu-item disabled">No Playlists</div>
                        ) : (
                            playlists.map(pl => (
                                <div key={pl.id} className="menu-item" onClick={() => onAddToPlaylist(pl.id, contextMenu.song)}>
                                    {pl.name}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="library">
            <h1>Library</h1>
            <div className="album-grid">
                {albums.map(album => (
                    <div key={album.title} className="album-card" onClick={() => setSelectedAlbum(album)}>
                        <div className="album-cover">
                            {album.cover ? <img src={album.cover} alt="" /> : <div className="placeholder" />}
                        </div>
                        <div className="album-title">{album.title}</div>
                        <div className="album-artist">
                            {album.artist}
                            {album.songs[0]?.composer && <span className="composer-sub"> | {album.songs[0].composer}</span>}
                        </div>
                    </div>
                ))}
            </div>
            {albums.length === 0 && (
                <div className="empty-message">No music found. Add a folder to get started.</div>
            )}
        </div>
    );
};

export default Library;
