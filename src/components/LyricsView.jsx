import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Music, AlertCircle, Quote, Settings, Save, Check } from 'lucide-react';
import Artwork from './Artwork';
import Platform from '../services/PlatformService';
import { resolveLyrics, sidecarPathFor, SOURCE_LABELS, LYRICS_SOURCES } from '../library/lyricsResolver';
import { activeLineIndex } from '../library/lrc';
import '../styles/LyricsView.css';
import '../styles/Metadata.css';

// Persisted under 'lyricsSettings' (Electron store whitelist / Capacitor Preferences).
const SETTINGS_KEY = 'lyricsSettings';
const DEFAULT_SETTINGS = { online: true, saveSidecar: false };

/**
 * Lyrics for the current song, resolved in the order of #22: embedded synced -> .lrc sidecar
 * -> embedded unsynced -> LRCLIB (online, when enabled). The source is shown; fetched
 * synced lyrics can be saved next to the track as .lrc (automatically when the setting is on).
 */
const LyricsView = ({ currentSong, currentTime, mini = false }) => {
    const [lyrics, setLyrics] = useState(null);      // { source, synced, lines, plain, lrcText }
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [settings, setSettings] = useState(null);  // null until loaded
    const [showSettings, setShowSettings] = useState(false);
    const [needsAccess, setNeedsAccess] = useState(false);
    const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | 'error:<msg>'
    const [reloadKey, setReloadKey] = useState(0);    // bumped after a folder grant to resolve again
    const scrollContainerRef = useRef(null);
    const activeLineRef = useRef(null);
    const isAndroid = !Platform.isElectron() && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

    // Settings load once; nothing is fetched before they are known.
    useEffect(() => {
        let cancelled = false;
        Platform.getStore(SETTINGS_KEY).then((saved) => {
            if (cancelled) return;
            setSettings({ ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) });
        }).catch(() => { if (!cancelled) setSettings(DEFAULT_SETTINGS); });
        return () => { cancelled = true; };
    }, []);

    const updateSettings = (patch) => {
        setSettings(prev => {
            const next = { ...(prev || DEFAULT_SETTINGS), ...patch };
            Promise.resolve(Platform.setStore(SETTINGS_KEY, next)).catch(e => console.error('Failed to save lyrics settings', e));
            return next;
        });
    };

    const saveSidecar = useCallback(async (song, lrcText) => {
        if (!song?.path || !lrcText) return;
        setSaveState('saving');
        try {
            if (!(await Platform.canAccessFile(song.path))) {
                setNeedsAccess(true);
                setSaveState('error:Grant folder access to save .lrc files');
                return;
            }
            await Platform.writeSidecar(sidecarPathFor(song.path), lrcText);
            setSaveState('saved');
        } catch (e) {
            setSaveState(`error:${e?.message || 'Save failed'}`);
        }
    }, []);

    useEffect(() => {
        if (!currentSong || !settings) return;

        const controller = new AbortController();
        const song = currentSong;

        const fetchLyrics = async () => {
            setError(null);
            setLyrics(null);
            setSaveState(null);
            setNeedsAccess(false);
            setLoading(true);
            try {
                // Sidecars need a folder grant on Android; note when one is missing so the
                // view can offer it (the embedded / online sources still work without it).
                let sidecarAccess = true;
                if (isAndroid) sidecarAccess = await Platform.canAccessFile(song.path);
                const result = await resolveLyrics({
                    song,
                    getDetails: (p) => Platform.getTrackDetails(p),
                    readSidecar: sidecarAccess ? (p) => Platform.readSidecar(p) : null,
                    online: settings.online !== false,
                    signal: controller.signal
                });
                if (controller.signal.aborted) return;
                if (isAndroid && !sidecarAccess && result?.source !== LYRICS_SOURCES.EMBEDDED_SYNCED) setNeedsAccess(true);
                if (!result) {
                    setError(settings.online === false ? 'No lyrics in the file or next to it (online lookup is off).' : 'Could not find lyrics for this track.');
                } else {
                    setLyrics(result);
                    if (result.source === LYRICS_SOURCES.LRCLIB && result.synced && settings.saveSidecar) saveSidecar(song, result.lrcText);
                }
                setLoading(false);
            } catch (err) {
                if (err.name === 'AbortError' || controller.signal.aborted) return;
                console.error('Lyrics fetch error:', err);
                setError('Could not find lyrics for this track.');
                setLoading(false);
            }
        };

        fetchLyrics();
        return () => controller.abort();
    }, [currentSong?.path, settings?.online, saveSidecar, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const parsedLyrics = useMemo(() => (lyrics?.synced ? lyrics.lines.filter(l => l.text) : null), [lyrics]);
    const activeIndex = useMemo(() => (parsedLyrics ? activeLineIndex(parsedLyrics, currentTime) : -1), [parsedLyrics, currentTime]);

    useEffect(() => {
        if (activeLineRef.current && scrollContainerRef.current) {
            activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [activeIndex, parsedLyrics]);

    if (!currentSong) {
        return (
            <div className={`lyrics-empty ${mini ? 'is-mini' : ''}`}>
                <Music size={mini ? 24 : 48} opacity={0.2} />
                <p>Play a song to see lyrics</p>
            </div>
        );
    }

    const sourceLabel = lyrics ? `${SOURCE_LABELS[lyrics.source] || lyrics.source} · ${lyrics.synced ? 'synced' : 'unsynced'}` : null;
    const canSave = lyrics?.source === LYRICS_SOURCES.LRCLIB && lyrics.synced && Platform.supportsTagWriting();

    return (
        <div className={`lyrics-container ${mini ? 'is-mini' : ''}`}>
            <div className="lyrics-bg">
                <Artwork src={currentSong.picture} />
                <div className="lyrics-overlay" />
            </div>

            {!mini && (
                <div className="lyrics-toolbar">
                    {sourceLabel && <span className="lyrics-source" title="Where these lyrics came from">{sourceLabel}</span>}
                    {canSave && (
                        <button className="lyrics-tool-btn" title={saveState === 'saved' ? 'Saved as .lrc next to the track' : 'Save as .lrc next to the track'}
                            onClick={() => saveSidecar(currentSong, lyrics.lrcText)} disabled={saveState === 'saving' || saveState === 'saved'}>
                            {saveState === 'saved' ? <Check size={15} /> : <Save size={15} />}
                        </button>
                    )}
                    <button className="lyrics-tool-btn" title="Lyrics settings" onClick={() => setShowSettings(s => !s)}><Settings size={15} /></button>
                </div>
            )}

            {showSettings && settings && (
                <div className="lyrics-settings">
                    <label><input type="checkbox" checked={settings.online !== false} onChange={e => updateSettings({ online: e.target.checked })} /> Look up lyrics online (LRCLIB)</label>
                    <label><input type="checkbox" checked={!!settings.saveSidecar} disabled={settings.online === false} onChange={e => updateSettings({ saveSidecar: e.target.checked })} /> Save fetched lyrics as .lrc next to the track</label>
                    {isAndroid && needsAccess && (
                        <div className="lyrics-access">
                            Reading and saving .lrc files needs a folder grant. <button onClick={async () => { const grants = await Platform.requestFolderAccess(); if (grants.length) { setNeedsAccess(false); setShowSettings(false); setReloadKey(k => k + 1); } }}>Grant folder access</button>
                        </div>
                    )}
                </div>
            )}

            <div className="lyrics-content" ref={scrollContainerRef}>
                <div className="lyrics-header">
                    <Quote size={32} color="var(--accent-monitor)" />
                    <h1>{currentSong.title}</h1>
                    <p>{currentSong.artist}</p>
                </div>

                {loading && (
                    <div className="lyrics-status">
                        <div className="loader" />
                        <p>Searching for lyrics...</p>
                    </div>
                )}

                {error && !loading && (
                    <div className="lyrics-status">
                        <AlertCircle size={32} color="rgba(255,255,255,0.2)" />
                        <p>{error}</p>
                        {isAndroid && needsAccess && !mini && (
                            <div className="lyrics-access">
                                <button onClick={async () => { const grants = await Platform.requestFolderAccess(); if (grants.length) { setNeedsAccess(false); setReloadKey(k => k + 1); } }}>
                                    Grant folder access to read .lrc files
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {saveState && saveState.startsWith('error:') && !mini && (
                    <div className="lyrics-status" style={{ height: 'auto', padding: '4px 0' }}><p style={{ fontSize: 12 }}>{saveState.slice(6)}</p></div>
                )}

                {!loading && !error && lyrics && (
                    <div className="lyrics-body">
                        {parsedLyrics ? (
                            parsedLyrics.map((line, i) => {
                                const isActive = i === activeIndex;
                                return (
                                    <div
                                        key={i}
                                        ref={isActive ? activeLineRef : null}
                                        className={`lyrics-line ${isActive ? 'active' : ''} ${currentTime > line.time ? 'passed' : ''}`}
                                    >
                                        {line.text}
                                    </div>
                                );
                            })
                        ) : (
                            <div className="plain-lyrics">
                                {lyrics.plain || 'Lyrics format not supported'}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default LyricsView;
