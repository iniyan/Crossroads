import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import Player from './components/Player';
import Dashboard from './components/Dashboard';
import Library from './components/Library';
import PlaylistView from './components/PlaylistView';
import MiniPlayer from './components/MiniPlayer';
import LyricsView from './components/LyricsView';
import FoldersView from './components/FoldersView';
import ClassicalView from './components/ClassicalView';
import EqualizerView from './components/EqualizerView';
import WrappedView from './components/WrappedView';
import VinylView from './components/VinylView';
import { Minimize2, Minus, Square, X, Menu, Sun, Moon } from 'lucide-react';
import './styles/global.css';
import Platform from './services/PlatformService';
import { hasClassicalMusic } from './library/classical';
import { shuffled } from './utils/list';
import { appendPlay, backfillTrackKeys, setListened, ListenTimer } from './library/playHistory';
import useMetadataTools from './hooks/useMetadataTools';
import { DspEngine } from './audio/dsp';
import { DSP_STORE_KEY, DEFAULT_DSP_STATE, normalizeDspState } from './audio/dspState';
import { useQualityLibrary } from './components/quality/QualityProvider';
import qualityStore from './analysis/qualityStore';

const STATS_SAVE_INTERVAL = 15000;
const DSP_SAVE_DELAY = 500;                 // trailing debounce for the dsp settings (sliders fire per step)
const MAX_VIEW_HISTORY = 20;
const NOW_PLAYING_POSITION_INTERVAL = 5000; // how often the OS media session learns the position
const SEEK_PUSH_DELAY = 250;                // trailing delay before a seek reaches the media session

const persist = (key, value) =>
    Promise.resolve(Platform.setStore(key, value)).catch(e => console.error(`Failed to save ${key}`, e));

const safePlay = (audio) => {
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(e => console.warn('Playback failed', e));
};

const unsubscribe = (unsub) => { if (typeof unsub === 'function') unsub(); };

// Exposes the DSP engine as window.__crossroadsDsp for the Electron harness / dev tools:
// in Vite dev builds, or when localStorage 'crossroads:debug' is '1' (a harness flag).
const dspDebugHook = () => {
    if (import.meta.env.DEV) return true;
    try { return localStorage.getItem('crossroads:debug') === '1'; } catch { return false; }
};

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
    const [theme, setTheme] = useState('dark');
    const [dsp, setDsp] = useState(DEFAULT_DSP_STATE);   // EQ / crossfeed settings (#24)
    const [dspActive, setDspActive] = useState(false);   // processing graph in the signal path
    const [vinylOpen, setVinylOpen] = useState(false);   // full-screen now-playing overlay (#26)

    const audioRef = useRef(null);
    if (!audioRef.current) {
        audioRef.current = new Audio();
        // CORS mode before the first src: Web Audio (EQ) reads samples only from CORS-enabled
        // media. Same-origin on Android (Capacitor server); the Electron media scheme answers
        // with Access-Control-Allow-Origin for the app origin.
        audioRef.current.crossOrigin = 'anonymous';
    }
    const dspRef = useRef(null);
    if (!dspRef.current) dspRef.current = new DspEngine(audioRef.current);

    // Store keys whose saved value was read successfully. A key is only ever persisted once it
    // is in here, so defaults never overwrite saved data (nor data we failed to read).
    const loadedKeysRef = useRef(new Set());
    const isLoaded = (key) => loadedKeysRef.current.has(key);
    const statsRef = useRef(stats);
    const statsDirtyRef = useRef(false);
    const lastStatsSaveRef = useRef(0);
    const statsSaveTimer = useRef(null);
    const dspStateRef = useRef(dsp);
    const dspDirtyRef = useRef(false);
    const dspSaveTimer = useRef(null);
    const errorStreakRef = useRef(0);
    const historyRef = useRef([]);            // previous { view, selectedPlaylistId } entries
    const latest = useRef({});                // latest handlers/state for once-registered listeners
    const lastPositionPushRef = useRef(0);    // when the media session last got a position update
    const seekPushTimer = useRef(null);
    const listenTimerRef = useRef(new ListenTimer());   // seconds the current play has actually played
    const currentPlayRef = useRef(null);      // { path, timestamp } of the play-history entry being timed
    const viewBackRef = useRef(null);         // a view's own "go up" handler (folders, composers), tried before the view history
    const musicFolderRef = useRef(null);      // the folder (or Android 'mediastore' sentinel) the library came from

    const canMiniMode = Platform.supportsMiniMode();

    // Fake lossless / fake hi-res analyser (#28): library + its root for result pruning,
    // playback for throttling.
    useQualityLibrary(songs, isPlaying, musicFolderRef);

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

    // `rescan` re-reads a library already on screen (Android finished probing in the
    // background): the queue keeps its order and position, only the song objects are
    // refreshed by path, and the current view is left alone.
    const scanAndSetSongs = async (folder, { rescan = false } = {}) => {
        try {
            const scannedSongs = (await Platform.scanFolder(folder)) || [];
            setSongs(scannedSongs);
            // Plays recorded while a song was provisional carry no trackKey yet; fill them in
            // now that the library may hold the final keys.
            setStats(prev => backfillTrackKeys(prev, scannedSongs));
            if (rescan) {
                const byPath = new Map(scannedSongs.map(song => [song.path, song]));
                const refresh = (list) => list.map(song => byPath.get(song.path) || song);
                setQueue(refresh);
                setShuffledQueue(refresh);
                return;
            }
            if (scannedSongs.length > 0) setView(v => v === 'dashboard' ? 'library' : v);
        } catch (e) {
            console.error('Failed to scan music folder', e);
        }
    };

    // Initial Data Load
    useEffect(() => {
        let cancelled = false;
        const read = async (key) => {
            try {
                const value = await Platform.getStore(key);
                loadedKeysRef.current.add(key);
                return value;
            } catch (e) {
                // Leave the key unloaded: it must not be overwritten with defaults this session.
                console.error(`Failed to load ${key}; it will not be saved this session`, e);
                return null;
            }
        };
        async function loadData() {
            const [savedStats, savedPlaylists, savedFavs, savedTheme, savedFolder, savedDsp] = await Promise.all(
                ['stats', 'playlists', 'favorites', 'theme', 'musicFolder', DSP_STORE_KEY].map(read)
            );
            if (cancelled) return;
            if (savedStats) setStats(savedStats);
            if (savedPlaylists) setPlaylists(savedPlaylists);
            if (savedFavs) setFavorites(savedFavs);
            if (savedTheme) setTheme(savedTheme);
            if (savedDsp) setDsp(normalizeDspState(savedDsp));
            if (savedFolder) {
                musicFolderRef.current = savedFolder;
                scanAndSetSongs(savedFolder);
            }
        }
        loadData();
        return () => { cancelled = true; };
    }, []);

    // Apply theme
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        if (isLoaded('theme')) persist('theme', theme);
    }, [theme]);

    // persistence (skipped until the key's saved value has been read, see loadedKeysRef)
    useEffect(() => { if (isLoaded('playlists')) persist('playlists', playlists); }, [playlists]);
    useEffect(() => { if (isLoaded('favorites')) persist('favorites', favorites); }, [favorites]);

    // DSP: every change goes into the Web Audio graph at once (created lazily by the engine
    // the first time processing is wanted; see src/audio/dsp.js for the routing rules) and is
    // persisted after a DSP_SAVE_DELAY lull, flushed on pause/hide like the stats.
    const flushDsp = useCallback(() => {
        clearTimeout(dspSaveTimer.current);
        if (!loadedKeysRef.current.has(DSP_STORE_KEY) || !dspDirtyRef.current) return;
        dspDirtyRef.current = false;
        persist(DSP_STORE_KEY, dspStateRef.current);
    }, []);
    useEffect(() => {
        dspRef.current.apply(dsp);
        dspStateRef.current = dsp;
        if (!isLoaded(DSP_STORE_KEY)) return;
        dspDirtyRef.current = true;
        clearTimeout(dspSaveTimer.current);
        dspSaveTimer.current = setTimeout(flushDsp, DSP_SAVE_DELAY);
    }, [dsp, flushDsp]);
    useEffect(() => {
        const engine = dspRef.current;
        const sync = () => setDspActive(engine.active);
        sync();
        const unsub = engine.subscribe(sync);
        // Diagnostics hook (Electron harness): window.__crossroadsDsp.measure() -> { peak, rms, wiring }
        const debug = dspDebugHook();
        if (debug) window.__crossroadsDsp = engine;
        return () => { unsub(); if (debug) delete window.__crossroadsDsp; };
    }, []);

    // Stats persistence: throttled to once per STATS_SAVE_INTERVAL, flushed on pause/hide
    const flushStats = useCallback(() => {
        clearTimeout(statsSaveTimer.current);
        if (!loadedKeysRef.current.has('stats') || !statsDirtyRef.current) return;
        statsDirtyRef.current = false;
        lastStatsSaveRef.current = Date.now();
        persist('stats', statsRef.current);
    }, []);

    // Writes the seconds played so far onto the current play-history entry (cheap: no-op
    // when the value has not changed). Applied to statsRef synchronously as well as to the
    // React state, so a flushStats() in the same tick (pagehide, visibility hidden, back
    // button) persists the value instead of the stats from the last render.
    const commitListened = useCallback(() => {
        const entry = currentPlayRef.current;
        if (!entry) return;
        const listened = listenTimerRef.current.seconds();
        const next = setListened(statsRef.current, entry, listened);
        if (next !== statsRef.current) {
            statsRef.current = next;
            statsDirtyRef.current = true;
        }
        setStats(prev => setListened(prev, entry, listened));
    }, []);

    useEffect(() => {
        statsRef.current = stats;
        if (!isLoaded('stats')) return;
        statsDirtyRef.current = true;
        const elapsed = Date.now() - lastStatsSaveRef.current;
        if (elapsed >= STATS_SAVE_INTERVAL) { flushStats(); return; }
        clearTimeout(statsSaveTimer.current);
        statsSaveTimer.current = setTimeout(flushStats, STATS_SAVE_INTERVAL - elapsed);
    }, [stats, flushStats]);

    useEffect(() => {
        const onVisibility = () => { if (document.visibilityState === 'hidden') { commitListened(); flushStats(); flushDsp(); } };
        const onPageHide = () => { commitListened(); flushStats(); flushDsp(); };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', onPageHide);
            flushStats();
            flushDsp();
        };
    }, [flushStats, flushDsp, commitListened]);

    const generateShuffledQueue = (originalQueue, currentSongPath) => {
        let newQueue = shuffled(originalQueue);
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
        const audio = audioRef.current;
        commitListened();
        listenTimerRef.current.reset();
        const timestamp = Date.now();
        currentPlayRef.current = { path: song.path, timestamp };
        audio.src = Platform.convertFileSrc(song.path);
        safePlay(audio);
        setStats(prev => appendPlay(prev, song, timestamp).stats);
    }, [commitListened]);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio.src) return;
        if (audio.paused) safePlay(audio);
        else audio.pause();
    }, []);

    const playNext = useCallback(() => {
        const currentQ = isShuffle ? shuffledQueue : queue;
        if (playIndex < currentQ.length - 1) {
            const newIndex = playIndex + 1;
            setPlayIndex(newIndex);
            playAtIndex(newIndex, currentQ);
        } else if (repeatMode === 1 && currentQ.length > 0) {
            setPlayIndex(0);
            playAtIndex(0, currentQ);
        } else {
            audioRef.current.pause();
        }
    }, [isShuffle, shuffledQueue, queue, playIndex, repeatMode, playAtIndex]);

    // OS media session (Android notification / lock screen, macOS Now Playing, ...)
    const pushNowPlaying = useCallback(() => {
        const { currentSong: song, isPlaying: playing, duration: dur } = latest.current;
        lastPositionPushRef.current = Date.now();
        if (!song) { Platform.clearNowPlaying(); return; }
        const audio = audioRef.current;
        Platform.updateNowPlaying({
            title: song.title || 'Unknown Title',
            artist: song.artist,
            album: song.album,
            // Android needs the original content:// URI, not the converted http://localhost one.
            artwork: song.rawPicture || song.picture,
            duration: dur || song.duration || 0,
            position: audio.currentTime,
            isPlaying: playing
        });
    }, []);

    const seek = useCallback((time) => {
        audioRef.current.currentTime = time;
        setCurrentTime(time);
        // Tell the OS media session promptly so its seek bar does not lag behind, but only once
        // per burst: scrubbing the slider fires this on every step.
        clearTimeout(seekPushTimer.current);
        seekPushTimer.current = setTimeout(pushNowPlaying, SEEK_PUSH_DELAY);
    }, [pushNowPlaying]);

    const playPrev = useCallback(() => {
        const currentQ = isShuffle ? shuffledQueue : queue;
        if (audioRef.current.currentTime > 3) {
            seek(0);
            return;
        }
        if (playIndex > 0) {
            const newIndex = playIndex - 1;
            setPlayIndex(newIndex);
            playAtIndex(newIndex, currentQ);
        } else if (repeatMode === 1 && currentQ.length > 0) {
            setPlayIndex(currentQ.length - 1);
            playAtIndex(currentQ.length - 1, currentQ);
        }
    }, [isShuffle, shuffledQueue, queue, playIndex, repeatMode, playAtIndex, seek]);

    const loadSongs = async () => {
        const folder = await Platform.selectFolder();
        if (folder) {
            musicFolderRef.current = folder;
            persist('musicFolder', folder);
            scanAndSetSongs(folder);
        }
    };

    // Android has finished probing the files that did not fit in the first pass: re-read the
    // library so the provisional rows get their tags, audio properties and quality.
    const onLibraryIndexed = () => {
        if (musicFolderRef.current) scanAndSetSongs(musicFolderRef.current, { rescan: true });
    };

    // Navigation with a small history stack (used by the Android back button)
    const navigate = useCallback((nextView, playlistId) => {
        const { view: curView, selectedPlaylistId: curId } = latest.current;
        const nextId = playlistId === undefined ? curId : playlistId;
        if (curView === nextView && curId === nextId) return;
        historyRef.current.push({ view: curView, selectedPlaylistId: curId });
        if (historyRef.current.length > MAX_VIEW_HISTORY) historyRef.current.shift();
        setView(nextView);
        setSelectedPlaylistId(nextId);
    }, []);

    const goBack = useCallback(() => {
        const prev = historyRef.current.pop();
        if (!prev) return false;
        setView(prev.view);
        setSelectedPlaylistId(prev.selectedPlaylistId);
        return true;
    }, []);

    const hasClassical = useMemo(() => hasClassicalMusic(songs), [songs]);

    const currentSong = isShuffle ? shuffledQueue[playIndex] : queue[playIndex];

    // Tag editor / track info / MusicBrainz / playlist import-export (src/hooks/useMetadataTools.jsx).
    // Songs re-read after a tag write replace their previous objects by path, everywhere.
    const onSongsUpdated = useCallback((updated) => {
        const byPath = new Map(updated.map(song => [song.path, song]));
        const refresh = (list) => list.map(song => byPath.get(song.path) || song);
        setSongs(refresh);
        setQueue(refresh);
        setShuffledQueue(refresh);
    }, []);
    const createPlaylistFromImport = useCallback((name, importedSongs) => {
        setPlaylists(prev => [...prev, { id: `pl-${Date.now()}`, name, songs: importedSongs.map(s => s.path) }]);
    }, []);
    const metadataTools = useMetadataTools({ songs, onSongsUpdated, onCreatePlaylist: createPlaylistFromImport });

    // Keep the latest state/handlers reachable from listeners registered once
    useEffect(() => {
        latest.current = {
            view, selectedPlaylistId, isMobile, sidebarOpen, repeatMode, currentSong, isPlaying, duration, vinylOpen,
            queueLength: (isShuffle ? shuffledQueue : queue).length,
            togglePlay, playNext, playPrev, loadSongs, onLibraryIndexed,
            closeMetadataOverlay: metadataTools.closeOverlay
        };
    });

    // Full media-session update on track / play state / duration change (runs after `latest`
    // is refreshed above)
    useEffect(() => {
        pushNowPlaying();
        if (isPlaying) Platform.ensureNotificationPermission();
    }, [currentSong, isPlaying, duration, pushNowPlaying]);

    useEffect(() => () => {
        clearTimeout(seekPushTimer.current);
        Platform.clearNowPlaying();
    }, []);

    // Keyboard, global shortcuts, menu and Android back button
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.code === 'Space') { e.preventDefault(); latest.current.togglePlay(); }
            else if (e.code === 'ArrowRight') latest.current.playNext();
            else if (e.code === 'ArrowLeft') latest.current.playPrev();
        };
        window.addEventListener('keydown', handleKeyDown);

        const unsubs = [
            Platform.onShortcut((type) => {
                if (type === 'playPause') latest.current.togglePlay();
                else if (type === 'next') latest.current.playNext();
                else if (type === 'prev') latest.current.playPrev();
            }),
            Platform.onMenuScan(() => latest.current.loadSongs()),
            Platform.onLibraryIndexed(() => latest.current.onLibraryIndexed()),
            Platform.onMediaAction((action, position) => {
                const audio = audioRef.current;
                switch (action) {
                    case 'play': if (audio.src && audio.paused) safePlay(audio); break;
                    case 'pause':
                    case 'stop': audio.pause(); break;
                    case 'next': latest.current.playNext(); break;
                    case 'prev': latest.current.playPrev(); break;
                    case 'seekto': if (Number.isFinite(position)) seek(position); break;
                    default: break;
                }
            }),
            Platform.onBackButton(() => {
                const { isMobile: mobile, sidebarOpen: open, view: curView, vinylOpen: vinyl } = latest.current;
                if (vinyl) { setVinylOpen(false); return; }
                if (qualityStore.getPanelSong()) { qualityStore.closePanel(); return; }
                if (latest.current.closeMetadataOverlay?.()) return;
                if (mobile && open) { setSidebarOpen(false); return; }
                if (viewBackRef.current?.()) return;
                if (goBack()) return;
                if (curView !== 'dashboard') { setView('dashboard'); return; }
                flushStats();
                Platform.exitApp();
            })
        ];

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            unsubs.forEach(unsubscribe);
        };
    }, [goBack, flushStats, seek]);

    // Audio element events: isPlaying is derived from the element itself
    useEffect(() => {
        const audio = audioRef.current;
        const onPlay = () => { listenTimerRef.current.start(); setIsPlaying(true); };
        const onPause = () => {
            // Reaching the end fires pause right before ended. When another track follows,
            // playback never really stopped, so do not report a pause to the OS media session
            // (on Android that would drop the foreground service, which a backgrounded app
            // cannot get back). onEnded settles the state and the listened time.
            if (audio.ended) return;
            listenTimerRef.current.stop();
            commitListened();
            setIsPlaying(false);
        };
        const onPlaying = () => { errorStreakRef.current = 0; };
        const onTimeUpdate = () => {
            setCurrentTime(audio.currentTime);
            if (Date.now() - lastPositionPushRef.current >= NOW_PLAYING_POSITION_INTERVAL) pushNowPlaying();
        };
        const onLoadedMetadata = () => setDuration(audio.duration);
        const onEnded = () => {
            listenTimerRef.current.stop();
            commitListened();
            if (latest.current.repeatMode === 2) { seek(0); safePlay(audio); }
            else latest.current.playNext();
            // Nothing followed (end of the queue): now it is a real pause.
            if (audio.paused) setIsPlaying(false);
        };
        const onError = () => {
            if (!audio.src) return;
            console.error('Audio error', audio.error, audio.src);
            errorStreakRef.current += 1;
            if (errorStreakRef.current >= latest.current.queueLength) {
                console.error('Every track in the queue failed to play; stopping.');
                errorStreakRef.current = 0;
                audio.pause();
                return;
            }
            latest.current.playNext();
        };
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('playing', onPlaying);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        return () => {
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('playing', onPlaying);
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
        };
    }, [pushNowPlaying, seek, commitListened]);

    // Listening time: tick while playing, flush stats when playback stops
    useEffect(() => {
        if (!isPlaying) { flushStats(); return; }
        const id = setInterval(() => {
            setStats(prev => ({ ...prev, totalTime: (prev.totalTime || 0) + 1 }));
        }, 1000);
        return () => clearInterval(id);
    }, [isPlaying, flushStats]);

    const playSong = (song, contextQueue = null) => {
        if (!song) return;
        errorStreakRef.current = 0; // a user-initiated play starts a fresh streak
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
                const seen = new Set(newSongs);
                songsArray.forEach(song => { if (!seen.has(song.path)) { seen.add(song.path); newSongs.push(song.path); } });
                return { ...pl, songs: newSongs };
            }
            return pl;
        }));
    };

    const deletePlaylist = (id) => {
        if (confirm('Delete this playlist?')) {
            setPlaylists(prev => prev.filter(p => p.id !== id));
            historyRef.current = historyRef.current.filter(h => !(h.view === 'playlist' && h.selectedPlaylistId === id));
            if (view === 'playlist' && selectedPlaylistId === id) { setView('dashboard'); setSelectedPlaylistId(null); }
        }
    };

    const openPlaylist = (id) => navigate('playlist', id);
    const toggleLyrics = () => {
        if (view !== 'lyrics') navigate('lyrics');
        else if (!goBack()) setView('library');
    };
    const changeVolume = (vol) => { audioRef.current.volume = vol; setVolume(vol); };

    // The mini player renders nothing without a song, which would leave the user in an
    // empty frameless window: refuse to enter mini mode when there is nothing to show.
    const hasMiniContent = !!(currentSong || songs.length > 0);

    const toggleMiniMode = () => {
        if (!canMiniMode) return;
        if (!miniMode) {
            if (!hasMiniContent) return;
            Platform.resize(300, 330);
            setMiniMode(true);
        } else {
            Platform.resize(1000, 800);
            setMiniMode(false);
        }
    };

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
                        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                        title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
                    >
                        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                    </button>

                    {canMiniMode && (
                        <button
                            onClick={toggleMiniMode}
                            disabled={!hasMiniContent}
                            title="Mini Player"
                            style={{ marginRight: (isMac && !isMobile) ? 10 : 0 }}
                        >
                            <Minimize2 size={16} />
                        </button>
                    )}

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
                        setView={(v) => { navigate(v); if (isMobile) setSidebarOpen(false); }}
                        onScan={loadSongs}
                        playlists={playlists}
                        smartPlaylists={smartPlaylists}
                        onCreatePlaylist={createPlaylist}
                        onImportPlaylist={metadataTools.importPlaylist}
                        onOpenPlaylist={(id) => { openPlaylist(id); if (isMobile) setSidebarOpen(false); }}
                        selectedPlaylistId={selectedPlaylistId}
                        hasClassical={hasClassical}
                    />
                    {isMobile && sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
                </div>
                <main className="main-content">
                    {view === 'dashboard' && <Dashboard stats={stats} allSongs={songs} onPlaySong={playSong} />}
                    {view === 'library' && (
                        <Library
                            songs={songs} onPlaySong={playSong} playlists={playlists}
                            onAddToPlaylist={addToPlaylist} favorites={favorites} onToggleFavorite={toggleFavorite}
                            backRef={viewBackRef}
                            onTrackInfo={metadataTools.openTrackInfo} onEditTags={metadataTools.openTagEditor}
                            onMusicBrainz={metadataTools.openMusicBrainz}
                        />
                    )}
                    {view === 'folders' && (
                        <FoldersView
                            songs={songs} onPlaySong={playSong} playlists={playlists}
                            onAddToPlaylist={addToPlaylist} backRef={viewBackRef}
                        />
                    )}
                    {view === 'classical' && (
                        <ClassicalView
                            songs={songs} onPlaySong={playSong} playlists={playlists}
                            onAddToPlaylist={addToPlaylist} backRef={viewBackRef}
                        />
                    )}
                    {view === 'lyrics' && <LyricsView currentSong={currentSong} currentTime={currentTime} />}
                    {view === 'equalizer' && <EqualizerView dsp={dsp} onChange={setDsp} engine={dspRef.current} />}
                    {view === 'wrapped' && <WrappedView stats={stats} songs={songs} onPlaySong={playSong} />}
                    {view === 'playlist' && (
                        <PlaylistView
                            playlist={smartPlaylists.find(p => p.id === selectedPlaylistId) || playlists.find(p => p.id === selectedPlaylistId)}
                            allSongs={songs} stats={stats} favorites={favorites} onPlaySong={playSong}
                            onDeletePlaylist={deletePlaylist} onToggleFavorite={toggleFavorite} onAddToPlaylist={addToPlaylist}
                            onExportPlaylist={metadataTools.exportPlaylist} onTrackInfo={metadataTools.openTrackInfo}
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
                onToggleLyrics={toggleLyrics} onTrackInfo={() => currentSong && metadataTools.openTrackInfo(currentSong)}
                currentView={view} onToggleMiniMode={toggleMiniMode} canMiniMode={canMiniMode}
                onOpenVinyl={() => { if (currentSong) setVinylOpen(true); }} dspActive={dspActive}
            />
            {metadataTools.overlay}
            {vinylOpen && currentSong && (
                <VinylView
                    currentSong={currentSong} isPlaying={isPlaying} currentTime={currentTime} duration={duration}
                    onPlayPause={togglePlay} onNext={playNext} onPrev={playPrev} onSeek={seek}
                    onClose={() => setVinylOpen(false)} dspActive={dspActive}
                    isFavorite={favorites.includes(currentSong.path)} onToggleFavorite={() => toggleFavorite(currentSong.path)}
                />
            )}
        </div>
    );
}
