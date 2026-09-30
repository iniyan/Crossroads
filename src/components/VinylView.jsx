import React, { useEffect, useMemo, useState } from 'react';
import { X, Play, Pause, SkipBack, SkipForward, Heart, Quote, Activity } from 'lucide-react';
import Artwork from './Artwork';
import LyricsView from './LyricsView';
import { formatTime } from '../utils/format';
import { paletteFromImage, rgbToCss, withLightness, luminance } from '../utils/palette';
import '../styles/Vinyl.css';

// Tonearm: rests off the platter, lands on the lead-in groove at 0 % and reaches the
// run-out groove at 100 %.
const ARM_REST_DEG = -28;
const ARM_START_DEG = -14;
const ARM_END_DEG = 12;

const useReducedMotion = () => {
    const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    useEffect(() => {
        if (!window.matchMedia) return undefined;
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = () => setReduced(query.matches);
        query.addEventListener ? query.addEventListener('change', onChange) : query.addListener(onChange);
        return () => { query.removeEventListener ? query.removeEventListener('change', onChange) : query.removeListener(onChange); };
    }, []);
    return reduced;
};

// Colours from the album art (null while loading or when the canvas is tainted).
const usePalette = (src) => {
    const [palette, setPalette] = useState(null);
    useEffect(() => {
        let cancelled = false;
        setPalette(null);
        if (!src) return undefined;
        paletteFromImage(src).then(result => { if (!cancelled) setPalette(result); });
        return () => { cancelled = true; };
    }, [src]);
    return palette;
};

const VinylView = ({
    currentSong, isPlaying, currentTime, duration, onPlayPause, onNext, onPrev, onSeek, onClose,
    isFavorite, onToggleFavorite, dspActive = false
}) => {
    const [showLyrics, setShowLyrics] = useState(false);
    const reducedMotion = useReducedMotion();
    const palette = usePalette(currentSong?.picture);

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const style = useMemo(() => {
        if (!palette) return {};
        const bg = withLightness(palette.dominant, 0.08, 0.18);
        const bg2 = withLightness(palette.vibrant, 0.12, 0.3);
        const accent = withLightness(palette.vibrant, 0.55, 0.75);
        const text = luminance(bg) > 0.4 ? [15, 23, 42] : [248, 250, 252];
        return {
            '--vinyl-bg': rgbToCss(bg),
            '--vinyl-bg-2': rgbToCss(bg2),
            '--vinyl-accent': rgbToCss(accent),
            '--vinyl-text': rgbToCss(text)
        };
    }, [palette]);

    if (!currentSong) return null;

    const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
    const armAngle = isPlaying || currentTime > 0 ? ARM_START_DEG + (ARM_END_DEG - ARM_START_DEG) * progress : ARM_REST_DEG;
    const quality = currentSong.quality?.label || currentSong.format || '';
    const spinning = isPlaying && !reducedMotion;

    return (
        <div className={`vinyl-overlay ${palette ? 'has-palette' : ''} ${showLyrics ? 'with-lyrics' : ''}`} style={style} role="dialog" aria-label="Now playing">
            <div className="vinyl-backdrop"><Artwork src={currentSong.picture} /></div>
            <div className="vinyl-topbar">
                <span className="vinyl-kicker">Now playing</span>
                <div className="vinyl-topbar-actions">
                    {dspActive && <span className="vinyl-dsp" title="EQ / crossfeed active (not bit-perfect)"><Activity size={12} /> DSP</span>}
                    <button type="button" className={`vinyl-icon ${showLyrics ? 'active' : ''}`} onClick={() => setShowLyrics(v => !v)} title="Lyrics"><Quote size={18} /></button>
                    <button type="button" className="vinyl-icon" onClick={onClose} title="Close (Esc)"><X size={20} /></button>
                </div>
            </div>

            <div className="vinyl-body">
                <div className="vinyl-stage">
                    <div className="vinyl-platter">
                        <div className={`vinyl-record ${spinning ? 'spinning' : ''} ${isPlaying ? '' : 'paused'}`} style={reducedMotion ? { animation: 'none' } : undefined}>
                            <div className="vinyl-grooves" />
                            <div className="vinyl-label">
                                <Artwork src={currentSong.picture} alt="" placeholder={<div className="vinyl-label-placeholder">{(currentSong.title || '?').slice(0, 1)}</div>} />
                            </div>
                            <div className="vinyl-spindle" />
                        </div>
                        <div className="vinyl-tonearm" style={{ transform: `rotate(${armAngle}deg)` }}>
                            <div className="vinyl-arm-base" />
                            <div className="vinyl-arm" />
                            <div className="vinyl-headshell" />
                        </div>
                    </div>
                </div>

                <div className="vinyl-info">
                    {quality && <span className="vinyl-quality">{quality}{currentSong.lossless === true ? ' · lossless' : ''}</span>}
                    <h1 className="vinyl-title">{currentSong.title || 'Unknown Title'}</h1>
                    <p className="vinyl-artist">{currentSong.artist}</p>
                    {currentSong.album && <p className="vinyl-album">{currentSong.album}{currentSong.year ? ` · ${currentSong.year}` : ''}</p>}

                    <div className="vinyl-progress">
                        <span>{formatTime(currentTime, '0:00')}</span>
                        <input
                            type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)}
                            onChange={e => onSeek(Number(e.target.value))} aria-label="Seek"
                            style={{ backgroundSize: `${progress * 100}% 100%` }}
                        />
                        <span>{formatTime(duration, '0:00')}</span>
                    </div>

                    <div className="vinyl-controls">
                        <button type="button" className={`vinyl-icon ${isFavorite ? 'active' : ''}`} onClick={onToggleFavorite} title="Favourite">
                            <Heart size={20} fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                        <button type="button" className="vinyl-icon" onClick={onPrev} title="Previous"><SkipBack size={26} /></button>
                        <button type="button" className="vinyl-play" onClick={onPlayPause} title={isPlaying ? 'Pause' : 'Play'}>
                            {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" className="play-icon-offset" />}
                        </button>
                        <button type="button" className="vinyl-icon" onClick={onNext} title="Next"><SkipForward size={26} /></button>
                        <button type="button" className={`vinyl-icon ${showLyrics ? 'active' : ''}`} onClick={() => setShowLyrics(v => !v)} title="Lyrics"><Quote size={20} /></button>
                    </div>
                </div>

                {showLyrics && (
                    <div className="vinyl-lyrics">
                        <LyricsView currentSong={currentSong} currentTime={currentTime} mini />
                    </div>
                )}
            </div>
        </div>
    );
};

export default VinylView;
