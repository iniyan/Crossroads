import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Share2, Gift, Play } from 'lucide-react';
import { PERIOD_KINDS, periodOf, availablePeriods, computeWrapped, formatHours, WEEKDAY_LABELS } from '../library/wrapped';
import { slideToPngBlob, blobToBase64 } from '../utils/slideImage';
import Platform from '../services/PlatformService';
import Artwork from './Artwork';
import '../styles/Wrapped.css';

const KIND_LABELS = { week: 'Week', month: 'Month', year: 'Year' };
const GRADIENTS = [
    ['#4c1d95', '#0f172a'], ['#0e7490', '#1e1b4b'], ['#9d174d', '#312e81'], ['#b45309', '#3f1d0b'],
    ['#065f46', '#0f172a'], ['#1d4ed8', '#4c0519'], ['#7c2d12', '#1e293b'], ['#155e75', '#3b0764']
];
const TIER_LABELS = { hires: 'Hi-Res', cd: 'CD quality', lossy: 'Lossy', unknown: 'Unknown' };
const TIER_COLORS = { hires: '#f59e0b', cd: '#22d3ee', lossy: '#a78bfa', unknown: '#94a3b8' };

const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Story slides for a recap; a period without plays yields a single empty slide. */
export const buildSlides = (recap, sortBy) => {
    const { period } = recap;
    const label = period.label;
    if (recap.plays === 0) {
        return [{ id: 'empty', kicker: label, title: 'Nothing played yet', subtitle: `No listening recorded for ${label.toLowerCase()}. Press play and come back.`, gradient: GRADIENTS[0], empty: true }];
    }
    const listKey = sortBy === 'time' ? 'byTime' : 'byPlays';
    const valueOf = (item) => (sortBy === 'time' ? formatHours(item.seconds) : plural(item.plays, 'play'));
    const rows = (list) => list.slice(0, 5).map((item, i) => ({ rank: i + 1, label: item.name, sub: item.artist || (item.song ? item.song.artist : undefined), value: valueOf(item), picture: item.picture || null, song: item.song || null }));
    const slides = [];
    const hours = recap.totalSeconds / 3600;

    slides.push({
        id: 'total', kicker: label, title: 'You listened for',
        big: hours >= 10 ? Math.round(hours) : hours.toFixed(1), bigUnit: 'hours',
        subtitle: `${plural(recap.plays, 'play')} across ${plural(recap.uniqueTracks, 'track')}, ${plural(recap.uniqueAlbums, 'album')} and ${plural(recap.uniqueArtists, 'artist')} on ${plural(recap.activeDays, 'day')}.`,
        footer: recap.estimated ? `Includes ${plural(recap.estimatedPlays, 'older play')} estimated from track length.` : null,
        gradient: GRADIENTS[0]
    });

    const tierTotal = Object.values(recap.byTier).reduce((a, b) => a + b, 0) || 1;
    const hiresShare = Math.round(100 * recap.byTier.hires / tierTotal);
    slides.push({
        id: 'quality', kicker: 'Sound quality', title: hiresShare >= 50 ? 'A hi-res listener' : recap.byTier.lossy > recap.byTier.cd + recap.byTier.hires ? 'Mostly lossy' : 'Lossless first',
        subtitle: `${hiresShare}% of your time was hi-res audio.`,
        bars: ['hires', 'cd', 'lossy', 'unknown'].filter(t => recap.byTier[t] > 0 || t !== 'unknown').map(t => ({ label: TIER_LABELS[t], value: recap.byTier[t], valueLabel: formatHours(recap.byTier[t]), color: TIER_COLORS[t] })),
        gradient: GRADIENTS[1]
    });

    const tracks = recap.topTracks[listKey];
    if (tracks.length) slides.push({ id: 'tracks', kicker: 'Top tracks', title: tracks[0].name, subtitle: `by ${tracks[0].artist || 'Unknown Artist'} — your most-played track${sortBy === 'time' ? ' by time' : ''}.`, rows: rows(tracks), gradient: GRADIENTS[2] });
    const artists = recap.topArtists[listKey];
    if (artists.length) slides.push({ id: 'artists', kicker: 'Top artists', title: artists[0].name, subtitle: `${plural(artists[0].plays, 'play')} over ${plural(artists[0].tracks, 'track')}.`, rows: rows(artists).map(r => ({ ...r, sub: undefined })), gradient: GRADIENTS[3] });
    const albums = recap.topAlbums[listKey];
    if (albums.length) slides.push({ id: 'albums', kicker: 'Top albums', title: albums[0].name, subtitle: `by ${albums[0].artist}`, rows: rows(albums), gradient: GRADIENTS[4] });
    const composers = recap.topComposers[listKey];
    if (composers.length) slides.push({ id: 'composers', kicker: 'Top composers', title: composers[0].name, subtitle: `${formatHours(composers[0].seconds)} of their work.`, rows: rows(composers).map(r => ({ ...r, sub: undefined })), gradient: GRADIENTS[5] });

    if (recap.discoveryCount > 0) {
        slides.push({
            id: 'discoveries', kicker: 'New discoveries', title: `${plural(recap.discoveryCount, 'track')} heard for the first time`,
            subtitle: `Starting with ${recap.discoveries[0].title} by ${recap.discoveries[0].artist}.`,
            rows: recap.discoveries.slice(0, 5).map((d, i) => ({ rank: i + 1, label: d.title, sub: d.artist, value: plural(d.plays, 'play'), picture: d.picture, song: d.song })),
            gradient: GRADIENTS[6]
        });
    }

    const streak = recap.longestStreak;
    slides.push({
        id: 'streak', kicker: 'Streak', title: streak.days > 1 ? `${streak.days} days in a row` : 'One day at a time',
        big: streak.days, bigUnit: streak.days === 1 ? 'day' : 'days',
        subtitle: streak.days > 1 ? `Your longest run of daily listening, ${streak.start} to ${streak.end}.` : 'Listen on consecutive days to build a streak.',
        gradient: GRADIENTS[7]
    });

    slides.push({
        id: 'clock', kicker: 'Listening clock', title: `${hourLabel(recap.peakHour)} on ${WEEKDAY_LABELS[recap.peakWeekday]}s`,
        subtitle: 'When you listen the most.',
        bars: WEEKDAY_LABELS.map((day, i) => ({ label: day, value: recap.byWeekday[i], valueLabel: formatHours(recap.byWeekday[i]), color: i === recap.peakWeekday ? '#f59e0b' : '#ffffff' })),
        byHour: recap.byHour,
        gradient: GRADIENTS[1]
    });

    if (recap.topFormat) {
        slides.push({
            id: 'format', kicker: 'Format', title: recap.topFormat.name, subtitle: `${formatHours(recap.topFormat.seconds)} in your most-played format.`,
            bars: recap.formats.slice(0, 5).map(f => ({ label: f.name, value: f.seconds, valueLabel: formatHours(f.seconds), color: '#ffffff' })),
            gradient: GRADIENTS[3]
        });
    }

    slides.push({
        id: 'outro', kicker: label, title: 'That was your soundtrack',
        rows: [
            { rank: '', label: 'Hours', value: hours.toFixed(1) },
            { rank: '', label: 'Top track', value: tracks[0] ? tracks[0].name : '—' },
            { rank: '', label: 'Top artist', value: artists[0] ? artists[0].name : '—' },
            { rank: '', label: 'Hi-res share', value: `${hiresShare}%` },
            { rank: '', label: 'Longest streak', value: plural(streak.days, 'day') }
        ],
        gradient: GRADIENTS[0]
    });
    return slides;
};

const HourChart = ({ byHour }) => {
    const max = Math.max(1, ...byHour);
    return (
        <div className="wrapped-hours" aria-label="Listening by hour of day">
            {byHour.map((seconds, h) => (
                <div key={h} className="wrapped-hour" title={`${hourLabel(h)}: ${formatHours(seconds)}`}>
                    <div className="wrapped-hour-bar" style={{ height: `${Math.max(3, 100 * seconds / max)}%` }} />
                    {h % 6 === 0 && <span>{hourLabel(h)}</span>}
                </div>
            ))}
        </div>
    );
};

const WrappedView = ({ stats, songs, onPlaySong }) => {
    const [kind, setKind] = useState('week');
    const [periodKey, setPeriodKey] = useState(() => periodOf('week').key);
    const [sortBy, setSortBy] = useState('plays');
    const [index, setIndex] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState(null);
    const touchStart = useRef(null);

    // Only the play history and the archived counts matter; `stats` itself is a new object
    // every second while playing (totalTime), which must not recompute the recap.
    const playHistory = stats?.playHistory;
    const archivedCounts = stats?.archivedCounts;
    const periods = useMemo(() => availablePeriods(playHistory, kind), [playHistory, kind]);
    const period = periods.find(p => p.key === periodKey) || periods[0];
    const recap = useMemo(() => computeWrapped({ stats: { playHistory, archivedCounts }, songs, period }), [playHistory, archivedCounts, songs, period]);
    const slides = useMemo(() => buildSlides(recap, sortBy), [recap, sortBy]);
    const slide = slides[Math.min(index, slides.length - 1)];
    const periodIndex = periods.indexOf(period);

    const selectKind = (nextKind) => { setKind(nextKind); setPeriodKey(periodOf(nextKind).key); setIndex(0); };
    const selectPeriod = (key) => { setPeriodKey(key); setIndex(0); };
    const go = useCallback((delta) => setIndex(i => Math.min(slides.length - 1, Math.max(0, i + delta))), [slides.length]);

    useEffect(() => {
        const onKey = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
        };
        // capture phase: runs before App's global shortcuts, which use the arrow keys for
        // next / previous track (Space is left alone so play/pause keeps working here)
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [go]);

    const onTouchStart = (e) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const onTouchEnd = (e) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    };

    const exportSlide = async () => {
        if (!slide || exporting) return;
        setExporting(true);
        setNotice(null);
        try {
            const blob = await slideToPngBlob(slide, { periodLabel: period.label });
            const base64 = await blobToBase64(blob);
            const filename = `crossroads-wrapped-${period.key.toLowerCase()}-${slide.id}.png`;
            const result = await Platform.exportImage({ base64, filename, blob });
            setNotice(result?.message || (result?.saved ? 'Image saved.' : null));
        } catch (e) {
            console.error('Wrapped export failed', e);
            setNotice(`Could not export the image (${e.message}).`);
        } finally {
            setExporting(false);
        }
    };

    if (!slide) return null;
    const [c1, c2] = slide.gradient;

    return (
        <div className="wrapped">
            <div className="header-row wrapped-header">
                <h1><Gift size={26} /> Wrapped</h1>
                <div className="filter-pills">
                    {PERIOD_KINDS.map(k => (
                        <button key={k} type="button" className={`pill ${kind === k ? 'active' : ''}`} onClick={() => selectKind(k)}>{KIND_LABELS[k]}</button>
                    ))}
                </div>
            </div>

            <div className="wrapped-period">
                <button type="button" className="wrapped-nav" disabled={periodIndex >= periods.length - 1} onClick={() => selectPeriod(periods[periodIndex + 1].key)} title="Previous period"><ChevronLeft size={18} /></button>
                <select value={period.key} onChange={e => selectPeriod(e.target.value)} aria-label="Period">
                    {periods.map((p, i) => (
                        <option key={p.key} value={p.key}>{i === 0 ? `This ${kind} · ` : i === 1 ? `Last ${kind} · ` : ''}{p.label}</option>
                    ))}
                </select>
                <button type="button" className="wrapped-nav" disabled={periodIndex <= 0} onClick={() => selectPeriod(periods[periodIndex - 1].key)} title="Next period"><ChevronRight size={18} /></button>
                <span className="wrapped-sublabel">{period.sublabel}</span>
                <div className="wrapped-sort">
                    <button type="button" className={`pill ${sortBy === 'plays' ? 'active' : ''}`} onClick={() => setSortBy('plays')}>By plays</button>
                    <button type="button" className={`pill ${sortBy === 'time' ? 'active' : ''}`} onClick={() => setSortBy('time')}>By time</button>
                </div>
            </div>

            <div className="wrapped-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                <button type="button" className="wrapped-arrow left" disabled={index === 0} onClick={() => go(-1)} aria-label="Previous slide"><ChevronLeft size={22} /></button>
                <div className="wrapped-slide" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }} key={`${period.key}-${slide.id}-${sortBy}`}>
                    <div className="wrapped-dots">
                        {slides.map((s, i) => <span key={s.id} className={i === index ? 'active' : i < index ? 'done' : ''} onClick={() => setIndex(i)} />)}
                    </div>
                    <div className="wrapped-kicker">{slide.kicker}</div>
                    <h2 className="wrapped-title">{slide.title}</h2>
                    {slide.subtitle && <p className="wrapped-subtitle">{slide.subtitle}</p>}
                    {slide.big !== undefined && (
                        <div className="wrapped-big">{slide.big}<span>{slide.bigUnit}</span></div>
                    )}
                    {slide.rows && (
                        <ol className="wrapped-rows">
                            {slide.rows.map((row, i) => (
                                <li key={i} className={row.song ? 'playable' : ''} onClick={() => row.song && onPlaySong && onPlaySong(row.song)}>
                                    <span className="wrapped-rank">{row.rank}</span>
                                    {row.picture !== undefined && <Artwork src={row.picture} className="wrapped-art" placeholder={<span className="wrapped-art" />} />}
                                    <span className="wrapped-row-text">
                                        <span className="wrapped-row-label">{row.label}</span>
                                        {row.sub && <span className="wrapped-row-sub">{row.sub}</span>}
                                    </span>
                                    <span className="wrapped-row-value">{row.value}</span>
                                    {row.song && <Play size={14} className="wrapped-row-play" />}
                                </li>
                            ))}
                        </ol>
                    )}
                    {slide.bars && (
                        <div className="wrapped-bars">
                            {slide.bars.map((bar, i) => {
                                const max = Math.max(1, ...slide.bars.map(b => b.value));
                                return (
                                    <div key={i} className="wrapped-bar">
                                        <span className="wrapped-bar-label">{bar.label}</span>
                                        <span className="wrapped-bar-track"><span className="wrapped-bar-fill" style={{ width: `${Math.max(2, 100 * bar.value / max)}%`, background: bar.color }} /></span>
                                        <span className="wrapped-bar-value">{bar.valueLabel}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {slide.byHour && <HourChart byHour={slide.byHour} />}
                    {slide.footer && <p className="wrapped-footer">{slide.footer}</p>}
                    {slide.empty && <div className="wrapped-empty-icon"><Gift size={64} /></div>}
                    <div className="wrapped-brand">Crossroads Wrapped</div>
                </div>
                <button type="button" className="wrapped-arrow right" disabled={index >= slides.length - 1} onClick={() => go(1)} aria-label="Next slide"><ChevronRight size={22} /></button>
            </div>

            <div className="wrapped-actions">
                <span className="wrapped-counter">{index + 1} / {slides.length}</span>
                <button type="button" className="wrapped-share" disabled={exporting || slide.empty} onClick={exportSlide}>
                    <Share2 size={15} /> {exporting ? 'Rendering…' : 'Share as image'}
                </button>
                {notice && <span className="wrapped-notice">{notice}</span>}
            </div>
        </div>
    );
};

export default WrappedView;
