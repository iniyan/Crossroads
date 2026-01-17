import React, { useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Maximize2, Heart, Quote, ListMusic, Music, Shuffle, Repeat } from 'lucide-react';
import LyricsView from './LyricsView';
import '../styles/MiniPlayer.css';

const MiniPlayer = ({
    currentSong,
    isPlaying,
    onPlayPause,
    onNext,
    onPrev,
    onToggleMini,
    currentTime,
    duration,
    onSeek,
    isShuffle,
    onToggleShuffle,
    repeatMode,
    onToggleRepeat,
    queue,
    onPlaySong,
    isFavorite,
    onToggleFavorite
}) => {
    const [activeTab, setActiveTab] = useState('nowPlaying'); // 'nowPlaying', 'lyrics', 'queue'

    if (!currentSong) return null;

    const progress = duration ? (currentTime / duration) * 100 : 0;

    const formatTime = (time) => {
        if (!time) return '0:00';
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    };

    return (
        <div className="mini-player">
            <div className="mini-content-area">
                {activeTab === 'nowPlaying' && (
                    <div className="mini-now-playing">
                        <div className="mini-art">
                            {currentSong.picture ? <img src={currentSong.picture} alt="" /> : <div className="placeholder" />}
                            <div className="mini-overlay">
                                <button className="mini-expand" onClick={onToggleMini} title="Exit Mini Mode">
                                    <Maximize2 size={16} />
                                </button>
                                <button
                                    className={`mini-fav ${isFavorite ? 'active' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
                                >
                                    <Heart size={16} fill={isFavorite ? "var(--accent-color)" : "none"} color={isFavorite ? "var(--accent-color)" : "white"} />
                                </button>
                            </div>
                        </div>
                        <div className="mini-song-info-tab">
                            <span className="mini-title">{currentSong.title}</span>
                            <span className="mini-artist">{currentSong.artist}</span>
                        </div>
                    </div>
                )}

                {activeTab === 'lyrics' && (
                    <div className="mini-lyrics-container">
                        <LyricsView currentSong={currentSong} currentTime={currentTime} mini />
                    </div>
                )}

                {activeTab === 'queue' && (
                    <div className="mini-queue-container">
                        <div className="mini-queue-header">UP NEXT</div>
                        <div className="mini-queue-list">
                            {queue.map((song, i) => (
                                <div
                                    key={i}
                                    className={`mini-queue-item ${song.path === currentSong.path ? 'active' : ''}`}
                                    onClick={() => onPlaySong(song)}
                                >
                                    <div className="mini-queue-details">
                                        <span className="mini-queue-title">{song.title}</span>
                                        <span className="mini-queue-artist">{song.artist}</span>
                                    </div>
                                    {song.path === currentSong.path && isPlaying && <div className="playing-bars" />}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <div className="mini-persistent-controls">
                <div className="mini-progress-section">
                    <span className="mini-time-text">{formatTime(currentTime)}</span>
                    <div className="mini-progress-bar-wrapper">
                        <input
                            type="range"
                            min="0"
                            max={duration || 0}
                            value={currentTime}
                            onChange={(e) => onSeek(Number(e.target.value))}
                            className="mini-seek-slider"
                            style={{ backgroundSize: `${progress}% 100%` }}
                        />
                    </div>
                    <span className="mini-time-text">{formatTime(duration)}</span>
                </div>

                <div className="mini-main-controls">
                    <button
                        className={`mini-icon-btn ${isShuffle ? 'active' : ''}`}
                        onClick={onToggleShuffle}
                        title="Shuffle"
                    >
                        <Shuffle size={14} />
                    </button>

                    <button className="mini-icon-btn" onClick={onPrev}><SkipBack size={18} fill="white" /></button>

                    <button className="mini-play-btn" onClick={onPlayPause}>
                        {isPlaying ? <Pause size={20} fill="black" /> : <Play size={20} fill="black" style={{ marginLeft: 2 }} />}
                    </button>

                    <button className="mini-icon-btn" onClick={onNext}><SkipForward size={18} fill="white" /></button>

                    <button
                        className={`mini-icon-btn ${repeatMode !== 0 ? 'active' : ''}`}
                        onClick={onToggleRepeat}
                        title="Repeat"
                    >
                        <Repeat size={14} />
                        {repeatMode === 2 && <span className="mini-repeat-badge">1</span>}
                    </button>
                </div>
            </div>

            <div className="mini-tabs">
                <button
                    className={`mini-tab-btn ${activeTab === 'nowPlaying' ? 'active' : ''}`}
                    onClick={() => setActiveTab('nowPlaying')}
                >
                    <Music size={16} />
                </button>
                <button
                    className={`mini-tab-btn ${activeTab === 'lyrics' ? 'active' : ''}`}
                    onClick={() => setActiveTab('lyrics')}
                >
                    <Quote size={16} />
                </button>
                <button
                    className={`mini-tab-btn ${activeTab === 'queue' ? 'active' : ''}`}
                    onClick={() => setActiveTab('queue')}
                >
                    <ListMusic size={16} />
                </button>
            </div>
        </div>
    );
};

export default MiniPlayer;
