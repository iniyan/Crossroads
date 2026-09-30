import React from 'react';
import { X, ScanSearch, PauseCircle } from 'lucide-react';
import { useQuality, useQualityProgress } from './QualityProvider';

/** The bar that moves with every decoded window; isolated so only it re-renders per tick. */
function ProgressBar({ done, total }) {
    const progress = useQualityProgress();
    const fraction = (done + (progress ? progress.done / Math.max(1, progress.total) : 0)) / Math.max(1, total);
    return <div className="q-progress-bar"><div style={{ width: `${Math.round(Math.min(1, fraction) * 100)}%` }} /></div>;
}

/** Small toast above the player while the background analysis queue is busy. */
export default function QualityProgress() {
    const store = useQuality();
    const state = store.getQueueState();
    if (!state.active) return null;
    const current = state.current && state.current.meta ? state.current.key : null;
    const name = current ? current.split(/[\\/]/).pop() : '';
    return (
        <div className="q-progress" role="status">
            {state.paused ? <PauseCircle size={16} /> : <ScanSearch size={16} className="q-spin" />}
            <div className="q-progress-text">
                <div className="q-progress-title">
                    {state.paused ? 'Analysis paused' : 'Analysing'} {state.label ? `${state.label} ` : ''}({Math.min(state.done + 1, state.total)}/{state.total})
                </div>
                {name && <div className="q-progress-track" title={current}>{name}</div>}
                <ProgressBar done={state.done} total={state.total} />
            </div>
            <button className="q-close" onClick={() => store.cancelAll()} title="Cancel analysis"><X size={16} /></button>
        </div>
    );
}
