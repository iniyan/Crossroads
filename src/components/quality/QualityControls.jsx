import React, { useMemo, useState } from 'react';
import { ScanSearch, Filter } from 'lucide-react';
import { useQuality } from './QualityProvider';

/** Queues an analysis of `songs` (skipping those already analysed unless `force`). */
export function AnalyzeButton({ songs, label, force = false, className = '', children }) {
    const store = useQuality();
    const { analysable, analysed } = store.summary(songs);
    const queued = (songs || []).some((s) => store.isQueued(s));
    const allDone = analysable > 0 && analysed >= analysable && !force;
    const disabled = analysable === 0 || queued || allDone;
    const title = analysable === 0
        ? 'Nothing to analyse here (only FLAC, WAV and AIFF files are checked)'
        : allDone ? 'Every lossless track here has been analysed' : 'Check for fake lossless / fake hi-res files';
    return (
        <button
            className={`q-analyze-btn ${className}`}
            disabled={disabled}
            title={title}
            onClick={(e) => { e.stopPropagation(); store.analyze(songs, { label, force }); }}
        >
            <ScanSearch size={16} />
            <span>{children || 'Analyze'}</span>
        </button>
    );
}

/** State for a "Suspicious files" filter over `songs`. */
export function useSuspiciousFilter(songs) {
    const store = useQuality();
    const version = store.getVersion();
    const [enabled, setEnabled] = useState(false);
    const suspicious = useMemo(() => (songs || []).filter((s) => store.isSuspicious(s)), [songs, store, version]);
    return {
        enabled,
        toggle: () => setEnabled((v) => !v),
        count: suspicious.length,
        songs: enabled ? suspicious : songs
    };
}

/** "Analyze library" button, the suspicious-files filter toggle and a short status line. */
export function QualityToolbar({ songs, filter }) {
    const store = useQuality();
    const { analysable, analysed, suspicious } = store.summary(songs);
    if (analysable === 0) return null;
    return (
        <div className="q-toolbar">
            <AnalyzeButton songs={songs} label="library">Analyze library</AnalyzeButton>
            <button
                className={`q-filter-btn ${filter.enabled ? 'active' : ''}`}
                onClick={filter.toggle}
                disabled={!filter.enabled && suspicious === 0}
                title="Show only files that look like fake lossless / fake hi-res"
            >
                <Filter size={14} />
                <span>Suspicious files{suspicious > 0 ? ` (${suspicious})` : ''}</span>
            </button>
            <span className="q-status">{analysed} of {analysable} lossless tracks analysed</span>
        </div>
    );
}
