import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Player from './components/Player';
import Dashboard from './components/Dashboard';
import Library from './components/Library';
import PlaylistView from './components/PlaylistView';
import MiniPlayer from './components/MiniPlayer';
import LyricsView from './components/LyricsView';
import { Minimize2, Maximize2, Minus, Square, X, Menu } from 'lucide-react';
import './styles/global.css';
import Platform from './services/PlatformService';

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
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
    const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 768);

    const audioRef = useRef(new Audio());
    const statsInterval = useRef(null);

    // Mobile Detection
    useEffect(() => {
        const handleResize = () => {
            const mobile = window.innerWidth < 768;
            setIsMobile(mobile);
            if (!mobile) setSidebarOpen(true);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Initial Data Load
    useEffect(() => {
        async function loadData() {
            const savedStats = await Platform.getStore('stats');
            if (savedStats) setStats(savedStats);

            const savedPlaylists = await Platform.getStore('playlists');
            if (savedPlaylists) setPlaylists(savedPlaylists);

            const savedFavs = await Platform.getStore('favorites');
            if (savedFavs) setFavorites(savedFavs);

            const savedFolder = await Platform.getStore('musicFolder');
            if (savedFolder) scanAndSetSongs(savedFolder);
        }
        loadData();
    }, []);

    // persistence
    useEffect(() => { Platform.setStore('stats', stats); }, [stats]);
    useEffect(() => { Platform.setStore('playlists', playlists); }, [playlists]);
    useEffect(() => { Platform.setStore('favorites', favorites); }, [favorites]);

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
        audioRef.current.src = Platform.convertFileSrc(song.path);
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

        Platform.onShortcut((event, type) => {
            if (type === 'playPause') togglePlay();
            if (type === 'next') playNext();
            if (type === 'prev') playPrev();
        });

        Platform.onMenuScan(() => {
            loadSongs();
        });

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
        const scannedSongs = await Platform.scanFolder(folder);
        setSongs(scannedSongs);
        if (view === 'dashboard' && scannedSongs.length > 0) setView('library');
    };

    const loadSongs = async () => {
        const folder = await Platform.selectFolder();
        if (folder) {
            Platform.setStore('musicFolder', folder);
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
        if (!Platform.isElectron()) return;
        if (!miniMode) { Platform.resize(300, 330); setMiniMode(true); }
        else { Platform.resize(1000, 800); setMiniMode(false); }
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

    const isMac = window.electron?.platform === 'darwin' || (Platform.isElectron() && navigator.platform.includes('Mac'));

    return (
        <div className={`layout ${isMobile ? 'is-mobile' : ''}`}>
            <div className="titlebar" style={{ justifyContent: 'space-between', paddingRight: 10, paddingLeft: 10 }}>
                <div className="titlebar-left">
                    {isMobile && (
                        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="menu-toggle">
                            <Menu size={20} />
                        </button>
                    )}
                </div>
                <div className="titlebar-right" style={{ display: 'flex', gap: 10 }}>
                    <button
                        onClick={toggleMiniMode}
                        title="Mini Player"
                        style={{ marginRight: (isMac && !isMobile) ? 10 : 0 }}
                    >
                        <Minimize2 size={16} />
                    </button>

                    {!isMac && Platform.isElectron() && (
                        <div className="window-controls">
                            <button onClick={() => Platform.minimize()} title="Minimize"><Minus size={16} /></button>
                            <button onClick={() => Platform.maximize()} title="Maximize"><Square size={14} /></button>
                            <button onClick={() => Platform.close()} className="btn-close" title="Close"><X size={16} /></button>
                        </div>
                    )}
                </div>
            </div>
            <div className="app-container">
                <div className={`sidebar-wrapper ${sidebarOpen ? 'open' : 'closed'}`}>
                    <Sidebar
                        view={view}
                        setView={(v) => { setView(v); if (isMobile) setSidebarOpen(false); }}
                        onScan={loadSongs}
                        playlists={playlists}
                        smartPlaylists={smartPlaylists}
                        onCreatePlaylist={createPlaylist}
                        onOpenPlaylist={(id) => { openPlaylist(id); if (isMobile) setSidebarOpen(false); }}
                        selectedPlaylistId={selectedPlaylistId}
                    />
                    {isMobile && sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
                </div>
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
