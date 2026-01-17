import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Music, AlertCircle, Quote } from 'lucide-react';
import '../styles/LyricsView.css';

const LyricsView = ({ currentSong, currentTime, mini = false }) => {
    const [lyrics, setLyrics] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const scrollContainerRef = useRef(null);
    const activeLineRef = useRef(null);

    useEffect(() => {
        if (!currentSong) return;

        const fetchLyrics = async () => {
            setLoading(true);
            setError(null);
            setLyrics(null);

            try {
                const { artist, title, album, duration } = currentSong;
                const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&album_name=${encodeURIComponent(album)}&duration=${Math.round(duration)}`;

                const response = await fetch(url);
                if (!response.ok) throw new Error('Lyrics not found');

                const data = await response.json();
                setLyrics(data);
            } catch (err) {
                console.error('Lyrics fetch error:', err);
                setError('Could not find lyrics for this track.');
            } finally {
                setLoading(false);
            }
        };

        fetchLyrics();
    }, [currentSong?.path]);

    const parsedLyrics = useMemo(() => {
        if (!lyrics?.syncedLyrics) return null;

        const lines = lyrics.syncedLyrics.split('\n');
        return lines.map(line => {
            const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
            if (!match) return null;
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            return { time, text: match[3].trim() };
        }).filter(line => line && line.text);
    }, [lyrics]);

    useEffect(() => {
        if (activeLineRef.current && scrollContainerRef.current) {
            activeLineRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }, [currentTime, parsedLyrics]);

    if (!currentSong) {
        return (
            <div className={`lyrics-empty ${mini ? 'is-mini' : ''}`}>
                <Music size={mini ? 24 : 48} opacity={0.2} />
                <p>Play a song to see lyrics</p>
            </div>
        );
    }

    return (
        <div className={`lyrics-container ${mini ? 'is-mini' : ''}`}>
            <div className="lyrics-bg">
                {currentSong.picture && <img src={currentSong.picture} alt="" />}
                <div className="lyrics-overlay" />
            </div>

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
                    </div>
                )}

                {!loading && !error && lyrics && (
                    <div className="lyrics-body">
                        {parsedLyrics ? (
                            parsedLyrics.map((line, i) => {
                                const isActive = currentTime >= line.time &&
                                    (i === parsedLyrics.length - 1 || currentTime < parsedLyrics[i + 1].time);

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
                                {lyrics.plainLyrics || "Lyrics format not supported"}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default LyricsView;
