import React, { useEffect, useState } from 'react';
import { X, Tag, Disc, Search } from 'lucide-react';
import Artwork from '../Artwork';
import Platform from '../../services/PlatformService';
import { isWritableFormat } from '../../library/tagEdit';
import { formatTime } from '../../utils/format';
import '../../styles/Metadata.css';

const formatBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDate = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—');

const LONG_VALUE = 200;

const TagValue = ({ values }) => {
    const [expanded, setExpanded] = useState(false);
    const text = values.join('\n');
    const long = text.length > LONG_VALUE || values.some(v => v.includes('\n'));
    return (
        <div>
            <div className={`tag-long ${expanded || !long ? 'expanded' : ''}`}>
                {values.map((v, i) => <div key={i} className="tag-value-line">{v}</div>)}
            </div>
            {long && <button className="tag-expand" onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : 'Show all'}</button>}
        </div>
    );
};

/**
 * Every tag (multi-value), the audio properties, the file's path and size and the embedded
 * art of one track. `albumSongs` enables the "Edit album" and MusicBrainz actions.
 */
const TrackInfoPanel = ({ song, albumSongs = null, onClose, onEdit, onEditAlbum, onMusicBrainz }) => {
    const [details, setDetails] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setDetails(null);
        Platform.getTrackDetails(song.path).then((full) => {
            if (cancelled) return;
            setDetails(full || song);
            setLoading(false);
        }).catch(() => {
            if (cancelled) return;
            setDetails(song);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [song?.path]);

    if (!song) return null;
    const s = details || song;
    const writable = isWritableFormat(s.format);
    const tags = s.tags || {};
    const tagNames = Object.keys(tags).sort();
    const canWrite = Platform.supportsTagWriting();

    return (
        <div className="meta-overlay" onClick={onClose}>
            <div className="meta-dialog" onClick={e => e.stopPropagation()}>
                <div className="meta-header">
                    <h2>
                        Track info
                        <span className="meta-sub">{s.title} — {s.artist}</span>
                    </h2>
                    <button className="meta-close" onClick={onClose} title="Close"><X size={18} /></button>
                </div>
                <div className="meta-body">
                    <div className="info-hero">
                        <div className="info-art">
                            <Artwork src={s.picture} placeholder={<div className="placeholder" style={{ width: '100%', height: '100%' }} />} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <h3>{s.title}</h3>
                            <p>{s.artist}</p>
                            <p>{s.album}{s.year ? ` (${s.year})` : ''}</p>
                            <div style={{ marginTop: 8 }}>
                                <span className="meta-badge">{s.quality?.label || s.format}</span>
                                {s.lossless === true && <span className="meta-badge">LOSSLESS</span>}
                                {s.hasEmbeddedLyrics && <span className="meta-badge muted">LYRICS</span>}
                                {!writable && <span className="meta-badge muted">READ-ONLY TAGS</span>}
                            </div>
                        </div>
                    </div>

                    <div className="meta-section-title">Audio</div>
                    <div className="props-grid">
                        <div><span>Format</span><strong>{s.format}{s.codec && s.codec !== s.format ? ` (${s.codec})` : ''}</strong></div>
                        <div><span>Sample rate</span><strong>{s.sampleRate ? `${s.sampleRate / 1000} kHz` : '—'}</strong></div>
                        <div><span>Bit depth</span><strong>{s.bitsPerSample ? `${s.bitsPerSample}-bit` : '—'}</strong></div>
                        <div><span>Channels</span><strong>{s.channels ?? '—'}</strong></div>
                        <div><span>Bitrate</span><strong>{s.bitrate ? `${Math.round(s.bitrate / 1000)} kbps` : '—'}</strong></div>
                        <div><span>Duration</span><strong>{formatTime(s.duration)}</strong></div>
                        <div><span>Samples</span><strong>{s.totalSamples ? s.totalSamples.toLocaleString() : '—'}</strong></div>
                        <div><span>Audio MD5</span><strong title={s.md5 || ''}>{s.md5 ? `${s.md5.slice(0, 12)}…` : '—'}</strong></div>
                    </div>

                    <div className="meta-section-title">File</div>
                    <div className="file-path">{s.path}</div>
                    <div className="props-grid" style={{ marginTop: 8 }}>
                        <div><span>Size</span><strong>{formatBytes(s.fileSize)}</strong></div>
                        <div><span>Modified</span><strong>{formatDate(s.mtime)}</strong></div>
                        <div><span>Track key</span><strong style={{ fontSize: 11 }}>{s.trackKey}</strong></div>
                    </div>

                    <div className="meta-section-title">Tags {loading ? '(loading…)' : `(${tagNames.length})`}</div>
                    {tagNames.length === 0 && !loading && <div className="meta-hint">No tags in this file.</div>}
                    <table className="tag-table">
                        <tbody>
                            {tagNames.map(name => (
                                <tr key={name}>
                                    <td>{name}</td>
                                    <td><TagValue values={tags[name]} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className="meta-footer">
                    {!writable && <span className="meta-hint" style={{ margin: 0 }}>Only FLAC tags can be edited in this version.</span>}
                    <div className="spacer" />
                    {onMusicBrainz && albumSongs && (
                        <button className="meta-btn" onClick={() => onMusicBrainz(albumSongs)} disabled={!canWrite}><Search size={14} /> MusicBrainz</button>
                    )}
                    {onEditAlbum && albumSongs && albumSongs.length > 1 && (
                        <button className="meta-btn" onClick={() => onEditAlbum(albumSongs)} disabled={!canWrite}><Disc size={14} /> Edit album</button>
                    )}
                    {onEdit && (
                        <button className="meta-btn primary" onClick={() => onEdit([s])} disabled={!canWrite} title={writable ? 'Edit tags' : 'Open the editor (read-only for this format)'}>
                            <Tag size={14} /> {writable ? 'Edit tags' : 'View tags'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TrackInfoPanel;
