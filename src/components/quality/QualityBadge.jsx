import React from 'react';
import { AlertTriangle, ShieldCheck, HelpCircle, Loader2, Waves } from 'lucide-react';
import { useQuality } from './QualityProvider';
import { badgeLabel, describeResult } from '../../analysis/describe';

/**
 * Unobtrusive verdict badge for one track: a warning pill for suspicious files, a neutral
 * pill for band-limited ones, a faint check for genuine ones, a faint "?" for inconclusive
 * results, nothing when not analysed. Click opens the details panel.
 */
export default function QualityBadge({ song, className = '' }) {
    const store = useQuality();
    if (!song) return null;
    if (store.isAnalyzing(song)) {
        return <span className={`q-badge q-busy ${className}`} title="Analysing…"><Loader2 size={12} className="q-spin" /></span>;
    }
    const result = store.getResult(song);
    if (!result) return null;
    const open = (e) => { e.stopPropagation(); store.openPanel(song); };
    const { title, suspicious } = describeResult(result);
    const label = badgeLabel(result);
    if (label && suspicious) {
        return (
            <button className={`q-badge q-suspicious ${className}`} onClick={open} title={`${title} (click for details)`}>
                <AlertTriangle size={11} /><span>{label}</span>
            </button>
        );
    }
    if (result.verdict === 'band-limited') {
        return (
            <button className={`q-badge q-neutral ${className}`} onClick={open} title={`${title} (click for details)`}>
                <Waves size={11} /><span>{label}</span>
            </button>
        );
    }
    if (result.verdict === 'genuine') {
        return (
            <button className={`q-badge q-genuine ${className}`} onClick={open} title={`${title} (click for details)`}>
                <ShieldCheck size={12} />
            </button>
        );
    }
    if (result.verdict === 'unsupported') return null;
    return (
        <button className={`q-badge q-muted ${className}`} onClick={open} title={`${title} (click for details)`}>
            <HelpCircle size={12} />
        </button>
    );
}

/** "N suspicious" pill for an album card; nothing when all is well (band-limited does not count). */
export function AlbumQualityBadge({ songs, className = '' }) {
    const store = useQuality();
    const count = (songs || []).reduce((n, s) => n + (store.isSuspicious(s) ? 1 : 0), 0);
    if (count === 0) return null;
    return (
        <span className={`q-badge q-suspicious q-album ${className}`} title={`${count} track${count > 1 ? 's' : ''} look${count > 1 ? '' : 's'} like fake lossless / fake hi-res`}>
            <AlertTriangle size={11} /><span>{count} suspicious</span>
        </span>
    );
}
