import React, { useState, useMemo, useEffect } from 'react';
import { Play, MoreVertical, Shuffle, Heart } from 'lucide-react';
import { formatTime, formatTotalTime } from '../utils/format';
import Artwork from './Artwork';
import QualityBadge from './QualityBadge';
import QualityFilters, { useQualityFilters } from './QualityFilters';
import { albumMatchesFilter, albumQuality } from '../library/qualityGroups';
import useViewBack from './useViewBack';
import viewMemory from './viewMemory';
import { trackDisplayTitle } from '../library/classical';
import AnalysisBadge, { AlbumQualityBadge as AlbumAnalysisBadge } from './quality/QualityBadge';
import { AnalyzeButton, QualityToolbar, useSuspiciousFilter } from './quality/QualityControls';
import '../styles/Library.css';

const Library = ({ songs, onPlaySong, playlists = [], onAddToPlaylist, favorites = [], onToggleFavorite, backRef, onTrackInfo, onEditTags, onMusicBrainz }) => {
    const [selectedKey, setSelectedKeyState] = useState(viewMemory.albumKey);
    const setSelectedKey = (key) => { viewMemory.albumKey = key; setSelectedKeyState(key); };
    const [filters, updateFilters] = useQualityFilters();
    const [contextMenu, setContextMenu] = useState(null);
    // "Suspicious files" (#28) narrows the songs before grouping; the tier chips (#31) then
    // filter the resulting albums, so the two filters compose (AND).
    const qualityFilter = useSuspiciousFilter(songs);

    const albums = useMemo(() => {
        const map = {};
        (qualityFilter.songs || []).forEach(song => {
            const albumName = song.album || 'Unknown Album';
            // Group by the explicit album-artist tag only ('' when absent), so compilations
            // with a different artist per track stay one album instead of one card per artist.
            const albumArtist = song.albumArtist || '';
            const key = `${albumName}\u0000${albumArtist}`;
            if (!map[key]) {
                map[key] = {
                    key,
                    title: albumName,
                    albumArtist,
                    cover: song.picture,
                    songs: []
                };
            }
            if (!map[key].cover && song.picture) map[key].cover = song.picture;
            map[key].songs.push(song);
        });
        return Object.values(map).map(album => {
            let artist = album.albumArtist;
            if (!artist) {
                const artists = new Set(album.songs.map(s => s.artist).filter(Boolean));
                artist = artists.size > 1 ? 'Various Artists' : (album.songs[0]?.artist || 'Unknown Artist');
            }
            return { ...album, artist, quality: albumQuality(album.songs) };
        });
    }, [qualityFilter.songs]);

    // Looked up by key so the open album follows library refreshes (Android finishes probing
    // files in the background and the songs are replaced).
    const selectedAlbum = useMemo(() => albums.find(a => a.key === selectedKey) || null, [albums, selectedKey]);
    const visibleAlbums = useMemo(() => albums.filter(a => albumMatchesFilter(a.songs, filters, a.quality)), [albums, filters]);

    // Per-row display data, recomputed only when the open album changes (not on every
    // playback tick).
    const detail = useMemo(() => selectedAlbum && ({
        totalDuration: selectedAlbum.songs.reduce((acc, s) => acc + (s.duration || 0), 0),
        rows: selectedAlbum.songs.map(song => ({ song, title: trackDisplayTitle(song) }))
    }), [selectedAlbum]);

    // Back closes the open album first.
    useViewBack(backRef, () => {
        if (!selectedKey) return false;
        setSelectedKey(null);
        return true;
    });

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
        const { totalDuration, rows } = detail;

        return (
            <div className="album-detail">
                <button className="back-btn" onClick={() => setSelectedKey(null)}>← Back to Library</button>

                <div className="album-header">
                    <div className="album-cover-lg">
                        <Artwork src={selectedAlbum.cover} placeholder={<div className="placeholder" />} />
                    </div>
                    <div className="album-info">
                        <h1>{selectedAlbum.title}</h1>
                        <p className="artist-meta">
                            {selectedAlbum.artist}
                            {selectedAlbum.songs[0]?.composer && (
                                <span className="composer-tag"> • Music: {selectedAlbum.songs[0].composer}</span>
                            )}
                        </p>
                        <p className="meta">
                            {selectedAlbum.songs.length} songs • {formatTotalTime(totalDuration)}
                            <QualityBadge quality={selectedAlbum.quality} mixed={selectedAlbum.quality.mixed} />
                        </p>
                        <div className="action-buttons">
                            <button className="play-all-btn" onClick={() => selectedAlbum.songs.length > 0 && onPlaySong(selectedAlbum.songs[0], selectedAlbum.songs)}>
                                <Play fill="white" size={20} /> Play
                            </button>
                            <button className="shuffle-btn-flat" onClick={() => selectedAlbum.songs.length > 0 && onPlaySong(selectedAlbum.songs[Math.floor(Math.random() * selectedAlbum.songs.length)], selectedAlbum.songs)}>
                                <Shuffle size={20} /> Shuffle
                            </button>
                            <AnalyzeButton songs={selectedAlbum.songs} label={selectedAlbum.title}>Analyze album</AnalyzeButton>
                        </div>
                    </div>
                </div>

                <div className="track-list">
                    {rows.map(({ song, title }, i) => (
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
                            <span className="track-name">{title}</span>
                            <QualityBadge quality={song.quality} compact />
                            <AnalysisBadge song={song} />
                            <span className="track-dur">{formatTime(song.duration)}</span>
                            <button className="context-btn icon-btn sm" onClick={(e) => handleContextMenu(e, song)} style={{ marginLeft: 10 }}>
                                <MoreVertical size={16} />
                            </button>
                        </div>
                    ))}
                </div>

                {contextMenu && (
                    <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
                        {onTrackInfo && <div className="menu-item" onClick={() => onTrackInfo(contextMenu.song, selectedAlbum.songs)}>Track info</div>}
                        {onEditTags && <div className="menu-item" onClick={() => onEditTags([contextMenu.song])}>Edit tags…</div>}
                        {onEditTags && selectedAlbum.songs.length > 1 && <div className="menu-item" onClick={() => onEditTags(selectedAlbum.songs)}>Edit album tags…</div>}
                        {onMusicBrainz && <div className="menu-item" onClick={() => onMusicBrainz(selectedAlbum.songs)}>MusicBrainz lookup…</div>}
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
            <div className="library-toolbar">
                <QualityFilters filters={filters} onChange={updateFilters} />
                <QualityToolbar songs={songs} filter={qualityFilter} />
            </div>
            <div className="album-grid">
                {visibleAlbums.map(album => (
                    <div key={album.key} className="album-card" onClick={() => setSelectedKey(album.key)}>
                        <div className="album-cover">
                            <Artwork src={album.cover} placeholder={<div className="placeholder" />} />
                            <QualityBadge quality={album.quality} mixed={album.quality.mixed} compact />
                        </div>
                        <div className="album-title">{album.title}</div>
                        <div className="album-artist">
                            {album.artist}
                            {album.songs[0]?.composer && <span className="composer-sub"> | {album.songs[0].composer}</span>}
                        </div>
                        <AlbumAnalysisBadge songs={album.songs} />
                    </div>
                ))}
            </div>
            {songs.length === 0 && (
                <div className="empty-message">No music found. Add a folder to get started.</div>
            )}
            {songs.length > 0 && visibleAlbums.length === 0 && (
                <div className="empty-message">No albums match these filters.</div>
            )}
        </div>
    );
};

export default Library;
