import React, { useState, useMemo } from 'react';
import { Clock, TrendingUp, Calendar, Filter } from 'lucide-react';
import '../styles/Dashboard.css';

const Dashboard = ({ stats, allSongs, onPlaySong }) => {
    const [filter, setFilter] = useState('lifetime');

    const filteredStats = useMemo(() => {
        const now = Date.now();
        const history = stats.playHistory || [];

        let rangeMs = Infinity;
        if (filter === 'today') rangeMs = 24 * 60 * 60 * 1000;
        else if (filter === '7d') rangeMs = 7 * 24 * 60 * 60 * 1000;
        else if (filter === '28d') rangeMs = 28 * 24 * 60 * 60 * 1000;
        else if (filter === '90d') rangeMs = 90 * 24 * 60 * 60 * 1000;
        else if (filter === '1y') rangeMs = 365 * 24 * 60 * 60 * 1000;

        const filteredHistory = filter === 'lifetime'
            ? history
            : history.filter(p => (now - p.timestamp) < rangeMs);

        // Calculate counts
        const counts = {};
        filteredHistory.forEach(p => {
            counts[p.path] = (counts[p.path] || 0) + 1;
        });

        // Get Top Songs
        const topSongs = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([path, count]) => {
                const song = allSongs.find(s => s.path === path);
                return song ? { ...song, count } : null;
            })
            .filter(Boolean);

        return {
            history: filteredHistory,
            topSongs,
            totalTracks: Object.keys(counts).length
        };
    }, [stats, filter, allSongs]);

    const totalHours = (stats.totalTime / 3600).toFixed(1);

    return (
        <div className="dashboard">
            <div className="header-row">
                <h1>Dashboard</h1>
                <div className="filter-pills">
                    {[
                        { id: 'today', label: 'Today' },
                        { id: '7d', label: '7 Days' },
                        { id: '28d', label: '28 Days' },
                        { id: '90d', label: '90 Days' },
                        { id: '1y', label: '1 Year' },
                        { id: 'lifetime', label: 'Lifetime' }
                    ].map(f => (
                        <button
                            key={f.id}
                            className={`pill ${filter === f.id ? 'active' : ''}`}
                            onClick={() => setFilter(f.id)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="stats-grid">
                <div className="stat-card gradient-1">
                    <div className="icon-wrapper">
                        <Clock size={24} color="white" />
                    </div>
                    <div className="stat-info">
                        <span className="label">Total Listen Time</span>
                        <span className="value">{totalHours} <span className="unit">Hrs</span></span>
                    </div>
                </div>

                <div className="stat-card gradient-2">
                    <div className="icon-wrapper">
                        <TrendingUp size={24} color="white" />
                    </div>
                    <div className="stat-info">
                        <span className="label">Unique Tracks ({filter})</span>
                        <span className="value">{filteredStats.totalTracks}</span>
                    </div>
                </div>
            </div>

            <div className="section">
                <div className="section-header">
                    <h3>Top Songs</h3>
                    <span className="subtitle">{filter === 'lifetime' ? 'All time favorites' : `Your favorites from ${filter}`}</span>
                </div>
                <div className="song-list">
                    {filteredStats.topSongs.length === 0 ? (
                        <div className="empty-state">No data for this period. Keep listening!</div>
                    ) : (
                        filteredStats.topSongs.map((song, i) => (
                            <div key={song.path} className="song-row" onClick={() => onPlaySong(song)}>
                                <span className="index">{i + 1}</span>
                                <img src={song.picture || ''} className="list-art" alt="" />
                                <div className="song-meta">
                                    <div className="title">{song.title}</div>
                                    <div className="artist">{song.artist}</div>
                                </div>
                                <div className="play-count-badge">
                                    {song.count} plays
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

export default Dashboard;
