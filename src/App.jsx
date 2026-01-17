import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Player from './components/Player';
import Dashboard from './components/Dashboard';
import Library from './components/Library';
import PlaylistView from './components/PlaylistView';
import MiniPlayer from './components/MiniPlayer';
import LyricsView from './components/LyricsView';
import { Minimize2, Maximize2, Minus, Square, X } from 'lucide-react';
import './styles/global.css';

export default function App() {
    const [songs, setSongs] = useState([]);
    const [queue, setQueue] = useState([]);
    const [playIndex, setPlayIndex] = useState(-1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [view, setView] = useState('dashboard');
    const [stats, setStats] = useState({ totalTime: 0, playHistory: [] });
    const [miniMode, setMiniMode] = useState(false);
    const [isShuffle, setIsShuffle] = useState(false);
    const [repeatMode, setRepeatMode] = useState(0); // 0: off, 1: all, 2: one
    const [shuffledQueue, setShuffledQueue] = useState([]);
    const [playlists, setPlaylists] = useState([]);
    const [favorites, setFavorites] = useState([]);
    const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
    const [smartPlaylists, setSmartPlaylists] = useState([
        { id: 'favorites', name: 'Favorites', type: 'smart' },
        { id: 'top-tracks', name: 'Top Tracks', type: 'smart' },
        { id: 'recent', name: 'Recently Played', type: 'smart' },
        { id: 'recommendations', name: 'Discovery', type: 'smart' }
    ]);

    const audioRef = useRef(new Audio());
    const statsInterval = useRef(null);

    // Initial Data Load
    useEffect(() => {
        async function loadData() {
            if (window.electron) {
                const savedStats = await window.electron.getStore('stats');
                if (savedStats) setStats(savedStats);

                const savedPlaylists = await window.electron.getStore('playlists');
                if (savedPlaylists) setPlaylists(savedPlaylists);

                const savedFavs = await window.electron.getStore('favorites');
                if (savedFavs) setFavorites(savedFavs);

                const savedFolder = await window.electron.getStore('musicFolder');
                if (savedFolder) scanAndSetSongs(savedFolder);
            }
        }
        loadData();
    }, []);

    // persistence
    useEffect(() => { if (window.electron) window.electron.setStore('stats', stats); }, [stats]);
    useEffect(() => { if (window.electron) window.electron.setStore('playlists', playlists); }, [playlists]);
    useEffect(() => { if (window.electron) window.electron.setStore('favorites', favorites); }, [favorites]);

    const generateShuffledQueue = (originalQueue, currentSongPath) => {
        let newQueue = [...originalQueue];
        for (let i = newQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newQueue[i], newQueue[j]] = [newQueue[j], newQueue[i]];
        }
        if (currentSongPath) {
            newQueue = newQueue.filter(s => s.path !== currentSongPath);
            const currentSong = originalQueue.find(s => s.path === currentSongPath);
            if (currentSong) newQueue.unshift(currentSong);
        }
        return newQueue;
    };

    const playAtIndex = useCallback((index, currentQueue) => {
        const song = currentQueue[index];
        if (!song) return;
        audioRef.current.src = `file://${song.path}`;
        audioRef.current.play();
        setIsPlaying(true);
        setStats(prev => ({
            ...prev,
            playHistory: [...(prev.playHistory || []), { path: song.path, timestamp: Date.now() }]
        }));
    }, []);

    const togglePlay = useCallback(() => {
        if (isPlaying) audioRef.current.pause();
        else audioRef.current.play();
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    const playNext = useCallback((auto = false) => {
        const currentQ = isShuffle ? shuffledQueue : queue;
        if (playIndex < currentQ.length - 1) {
            const newIndex = playIndex + 1;
            setPlayIndex(newIndex);
            playAtIndex(newIndex, currentQ);
        } else if (repeatMode === 1) {
            setPlayIndex(0);
            playAtIndex(0, currentQ);
        } else {
            setIsPlaying(false);
        }
    }, [isShuffle, shuffledQueue, queue, playIndex, repeatMode, playAtIndex]);

    const playPrev = useCallback(() => {
        const currentQ = isShuffle ? shuffledQueue : queue;
        if (audioRef.current.currentTime > 3) {
            audioRef.current.currentTime = 0;
            return;
        }
        if (playIndex > 0) {
            const newIndex = playIndex - 1;
            setPlayIndex(newIndex);
            playAtIndex(newIndex, currentQ);
        } else if (repeatMode === 1) {
            setPlayIndex(currentQ.length - 1);
            playAtIndex(currentQ.length - 1, currentQ);
        }
    }, [isShuffle, shuffledQueue, queue, playIndex, repeatMode, playAtIndex]);

    // Keyboard and Shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
            else if (e.code === 'ArrowRight') playNext();
            else if (e.code === 'ArrowLeft') playPrev();
        };
        window.addEventListener('keydown', handleKeyDown);
        if (window.electron) {
            window.electron.onShortcut((event, type) => {
                if (type === 'playPause') togglePlay();
                if (type === 'next') playNext();
                if (type === 'prev') playPrev();
            });
            window.electron.onMenuScan(() => {
                loadSongs();
            });
        }
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [togglePlay, playNext, playPrev]);

    useEffect(() => {
        const audio = audioRef.current;
        const onTimeUpdate = () => setCurrentTime(audio.currentTime);
        const onEnded = () => {
            if (repeatMode === 2) { audio.currentTime = 0; audio.play(); }
            else playNext(true);
        };
        const onLoadedMetadata = () => setDuration(audio.duration);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        return () => {
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
        };
    }, [queue, playIndex, repeatMode, isShuffle, shuffledQueue, playNext]);

    useEffect(() => {
        if (isPlaying) {
            statsInterval.current = setInterval(() => {
                setStats(prev => ({ ...prev, totalTime: (prev.totalTime || 0) + 1 }));
            }, 1000);
        } else if (statsInterval.current) {
            clearInterval(statsInterval.current);
        }
        return () => clearInterval(statsInterval.current);
    }, [isPlaying]);

    const scanAndSetSongs = async (folder) => {
        const scannedSongs = await window.electron.scanFolder(folder);
        setSongs(scannedSongs);
        if (view === 'dashboard' && scannedSongs.length > 0) setView('library');
    };

    const loadSongs = async () => {
        if (!window.electron) return;
        const folder = await window.electron.selectFolder();
        if (folder) {
            window.electron.setStore('musicFolder', folder);
            scanAndSetSongs(folder);
        }
    };

    const playSong = (song, contextQueue = null) => {
        const activeQueue = contextQueue || songs;
        if (isShuffle) {
            const newShuffled = generateShuffledQueue(activeQueue, song.path);
            setShuffledQueue(newShuffled);
            setQueue(activeQueue);
            setPlayIndex(0);
            playAtIndex(0, newShuffled);
        } else {
            const index = activeQueue.findIndex(s => s.path === song.path);
            if (index !== -1) {
                setQueue(activeQueue);
                setPlayIndex(index);
                playAtIndex(index, activeQueue);
            }
        }
    };

    const toggleShuffle = () => {
        const newShuffleState = !isShuffle;
        setIsShuffle(newShuffleState);
        if (newShuffleState) {
            const currentSongObj = queue[playIndex] || songs[0];
            const baseQueue = queue.length > 0 ? queue : songs;
            const newShuffled = generateShuffledQueue(baseQueue, currentSongObj?.path);
            setShuffledQueue(newShuffled);
            setQueue(baseQueue);
            setPlayIndex(0);
        } else {
            const currentSongObj = shuffledQueue[playIndex];
            if (currentSongObj) {
                const originalIndex = queue.findIndex(s => s.path === currentSongObj.path);
                setPlayIndex(originalIndex !== -1 ? originalIndex : 0);
            }
        }
    };

    const toggleRepeat = () => setRepeatMode(prev => (prev + 1) % 3);
    const toggleFavorite = (songPath) => {
        if (!songPath) return;
        setFavorites(prev => prev.includes(songPath) ? prev.filter(p => p !== songPath) : [...prev, songPath]);
    };

    const createPlaylist = (nameFromSidebar) => {
        const name = nameFromSidebar || window.prompt("Enter Playlist Name");
        if (name?.trim()) {
            const newPl = { id: `pl-${Date.now()}`, name: name.trim(), songs: [] };
            setPlaylists(prev => [...prev, newPl]);
        }
    };

    const addToPlaylist = (playlistId, songsToAdd) => {
        const songsArray = Array.isArray(songsToAdd) ? songsToAdd : [songsToAdd];
        setPlaylists(prev => prev.map(pl => {
            if (pl.id === playlistId) {
                const newSongs = [...pl.songs];
                songsArray.forEach(song => { if (!newSongs.includes(song.path)) newSongs.push(song.path); });
                return { ...pl, songs: newSongs };
            }
            return pl;
        }));
    };

    const deletePlaylist = (id) => {
        if (confirm('Delete this playlist?')) {
            setPlaylists(prev => prev.filter(p => p.id !== id));
            if (view === 'playlist' && selectedPlaylistId === id) setView('dashboard');
        }
    };

    const openPlaylist = (id) => { setSelectedPlaylistId(id); setView('playlist'); };
    const seek = (time) => { audioRef.current.currentTime = time; setCurrentTime(time); };
    const changeVolume = (vol) => { audioRef.current.volume = vol; setVolume(vol); };

    const toggleMiniMode = () => {
        if (!window.electron) return;
        if (!miniMode) { window.electron.resize(300, 330); setMiniMode(true); }
        else { window.electron.resize(1000, 800); setMiniMode(false); }
    };

    const currentSong = isShuffle ? shuffledQueue[playIndex] : queue[playIndex];

    if (miniMode) {
        return (
            <MiniPlayer
                currentSong={currentSong || songs[0]}
                isPlaying={isPlaying}
                onPlayPause={togglePlay}
                onNext={playNext}
                onPrev={playPrev}
                onToggleMini={toggleMiniMode}
                currentTime={currentTime}
                duration={duration}
                onSeek={seek}
                isShuffle={isShuffle}
                onToggleShuffle={toggleShuffle}
                repeatMode={repeatMode}
                onToggleRepeat={toggleRepeat}
                queue={isShuffle ? shuffledQueue : queue}
                onPlaySong={(song) => playSong(song, isShuffle ? shuffledQueue : queue)}
                isFavorite={currentSong ? favorites.includes(currentSong.path) : false}
                onToggleFavorite={() => currentSong && toggleFavorite(currentSong.path)}
            />
        );
    }

    const isMac = window.electron?.platform === 'darwin';

    return (
        <div className="layout">
            <div className="titlebar" style={{ justifyContent: 'flex-end', paddingRight: 10 }}>
                <button
                    onClick={toggleMiniMode}
                    title="Mini Player"
                    style={{ marginRight: isMac ? 10 : 0 }}
                >
                    <Minimize2 size={16} />
                </button>

                {!isMac && (
                    <div className="window-controls">
                        <button onClick={() => window.electron.minimize()} title="Minimize"><Minus size={16} /></button>
                        <button onClick={() => window.electron.maximize()} title="Maximize"><Square size={14} /></button>
                        <button onClick={() => window.electron.close()} className="btn-close" title="Close"><X size={16} /></button>
                    </div>
                )}
            </div>
            <div className="app-container">
                <Sidebar
                    view={view} setView={setView} onScan={loadSongs} playlists={playlists}
                    smartPlaylists={smartPlaylists} onCreatePlaylist={createPlaylist}
                    onOpenPlaylist={openPlaylist} selectedPlaylistId={selectedPlaylistId}
                />
                <main className="main-content">
                    {view === 'dashboard' && <Dashboard stats={stats} allSongs={songs} onPlaySong={playSong} />}
                    {view === 'library' && (
                        <Library
                            songs={songs} onPlaySong={playSong} playlists={playlists}
                            onAddToPlaylist={addToPlaylist} favorites={favorites} onToggleFavorite={toggleFavorite}
                        />
                    )}
                    {view === 'lyrics' && <LyricsView currentSong={currentSong} currentTime={currentTime} />}
                    {view === 'playlist' && (
                        <PlaylistView
                            playlist={smartPlaylists.find(p => p.id === selectedPlaylistId) || playlists.find(p => p.id === selectedPlaylistId)}
                            allSongs={songs} stats={stats} favorites={favorites} onPlaySong={playSong}
                            onDeletePlaylist={deletePlaylist} onToggleFavorite={toggleFavorite} onAddToPlaylist={addToPlaylist}
                        />
                    )}
                </main>
            </div>
            <Player
                currentSong={currentSong} isPlaying={isPlaying} onPlayPause={togglePlay}
                onNext={playNext} onPrev={playPrev} currentTime={currentTime} duration={duration}
                onSeek={seek} volume={volume} onVolumeChange={changeVolume} isShuffle={isShuffle}
                onToggleShuffle={toggleShuffle} repeatMode={repeatMode} onToggleRepeat={toggleRepeat}
                isFavorite={currentSong ? favorites.includes(currentSong.path) : false}
                onToggleFavorite={() => currentSong && toggleFavorite(currentSong.path)}
                onToggleLyrics={() => setView(view === 'lyrics' ? 'library' : 'lyrics')}
                currentView={view} onToggleMiniMode={toggleMiniMode}
            />
        </div>
    );
}
