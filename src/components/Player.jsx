import React from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, Repeat, Shuffle, Heart, Quote, Minimize2 } from 'lucide-react';
import '../styles/Player.css';

const Player = ({
    currentSong,
    isPlaying,
    onPlayPause,
    onNext,
    onPrev,
    currentTime,
    duration,
    onSeek,
    volume,
    onVolumeChange,
    isShuffle,
    onToggleShuffle,
    repeatMode,
    onToggleRepeat,
    isFavorite,
    onToggleFavorite,
    onToggleLyrics,
    currentView,
    onToggleMiniMode
}) => {
    const formatTime = (time) => {
        if (!time) return '0:00';
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    };

    const progress = duration ? (currentTime / duration) * 100 : 0;

    return (
        <div className={`player-bar ${isPlaying ? 'is-playing' : ''}`}>
            <div className="track-info">
                {currentSong ? (
                    <>
                        <div className="track-art">
                            {currentSong.picture ? (
                                <img src={currentSong.picture} alt="Cover" />
                            ) : (
                                <div className="art-placeholder" />
                            )}
                        </div>
                        <div className="track-details">
                            <span className="track-title">{currentSong.title}</span>
                            <span className="track-artist">{currentSong.artist}</span>
                        </div>
                        <button
                            className={`favorite-btn ${isFavorite ? 'active' : ''}`}
                            onClick={onToggleFavorite}
                            title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                        >
                            <Heart size={18} fill={isFavorite ? "var(--accent-color)" : "none"} color={isFavorite ? "var(--accent-color)" : "currentColor"} />
                        </button>
                    </>
                ) : (
                    <div className="placeholder-text">Select a track to play</div>
                )}
            </div>

            <div className="progress-container">
                <span className="time">{formatTime(currentTime)}</span>
                <div className="progress-bar-wrapper">
                    <input
                        type="range"
                        min="0"
                        max={duration || 0}
                        value={currentTime}
                        onChange={(e) => onSeek(Number(e.target.value))}
                        className="seek-slider"
                        style={{ backgroundSize: `${progress}% 100%` }}
                    />
                </div>
                <span className="time">{formatTime(duration)}</span>
            </div>

            <div className="controls-center">
                <div className="main-controls">
                    <button
                        className={`icon-btn sm ${isShuffle ? 'active-dot' : ''}`}
                        onClick={onToggleShuffle}
                        disabled={!currentSong}
                        title="Shuffle"
                    >
                        <Shuffle size={18} />
                    </button>

                    <button className="icon-btn sm" onClick={onPrev} disabled={!currentSong}>
                        <SkipBack size={20} />
                    </button>

                    <button
                        className={`play-btn ${isPlaying ? 'playing' : ''}`}
                        onClick={onPlayPause}
                        disabled={!currentSong}
                    >
                        {isPlaying ? <Pause size={24} fill="black" /> : <Play size={24} fill="black" className="play-icon-offset" />}
                    </button>

                    <button className="icon-btn sm" onClick={onNext} disabled={!currentSong}>
                        <SkipForward size={20} />
                    </button>

                    <button
                        className={`icon-btn sm ${repeatMode !== 0 ? 'active-dot' : ''}`}
                        onClick={onToggleRepeat}
                        disabled={!currentSong}
                        title="Repeat"
                    >
                        {repeatMode === 2 ? <Repeat size={18} fill="var(--accent-monitor)" /> : <Repeat size={18} />}
                        {repeatMode === 2 && <span className="repeat-one-badge">1</span>}
                    </button>

                    <button
                        className={`icon-btn sm ${currentView === 'lyrics' ? 'active-dot' : ''}`}
                        onClick={onToggleLyrics}
                        disabled={!currentSong}
                        title="Lyrics"
                    >
                        <Quote size={18} />
                    </button>

                    <button
                        className="icon-btn sm"
                        onClick={onToggleMiniMode}
                        disabled={!currentSong}
                        title="Mini Player (Apple Music Style)"
                    >
                        <Minimize2 size={18} />
                    </button>
                </div>
            </div>

            <div className="audio-tech-info">
                {currentSong && (
                    <>
                        <div className="tech-badge">
                            {currentSong.lossless ? <span className="lossless-badge">LOSSLESS</span> : <span>COMPRESSED</span>}
                            {currentSong.bitsPerSample && <span>{currentSong.bitsPerSample}-bit</span>}
                        </div>
                        <div className="tech-details-nerd">
                            {currentSong.sampleRate && <span>{Math.round(currentSong.sampleRate / 100) / 10}kHz</span>}
                            {currentSong.bitrate && <span>{Math.round(currentSong.bitrate / 1000)}kbps</span>}
                            <span className="format-tag">FLAC</span>
                        </div>
                    </>
                )}
            </div>

            <div className="volume-controls">
                <Volume2 size={18} />
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(e) => onVolumeChange(Number(e.target.value))}
                    className="volume-slider"
                    style={{ backgroundSize: `${volume * 100}% 100%` }}
                />
            </div>
        </div >
    );
};

export default Player;
