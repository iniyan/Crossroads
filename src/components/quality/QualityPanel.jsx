import React, { useEffect } from 'react';
import { X, RefreshCw, ScanSearch, AlertTriangle, ShieldCheck, HelpCircle, Waves } from 'lucide-react';
import { useQuality, useQualityProgress } from './QualityProvider';
import SpectrumPlot from './SpectrumPlot';
import { describeResult, confidenceLabel } from '../../analysis/describe';
import { formatTime } from '../../utils/format';

const ELIGIBILITY_TEXT = {
    lossy: 'This is a lossy file; only lossless files are checked.',
    provisional: 'This file has not been indexed yet.',
    codec: 'Only FLAC, WAV and AIFF files can be decoded for analysis.'
};

const TONE_ICONS = { warn: AlertTriangle, ok: ShieldCheck, neutral: Waves, muted: HelpCircle };

function BitDepthEvidence({ result }) {
    const bd = result.evidence && result.evidence.bitDepth;
    if (!bd || !bd.containerBits) return null;
    const hist = bd.trailingZeroHistogram;
    const total = hist ? hist.reduce((a, b) => a + b, 0) : 0;
    return (
        <div className="q-section">
            <h4>Bit depth</h4>
            <p>
                Effective <strong>{bd.effectiveBits}</strong> of {bd.containerBits} bits
                {bd.lowByteZeroFraction !== null && bd.lowByteZeroFraction !== undefined && (
                    <> · low byte zero in {Math.round(bd.lowByteZeroFraction * 100)} % of samples</>
                )}
            </p>
            {hist && total > 0 && (
                <div className="q-hist" title="Share of samples by number of trailing zero bits">
                    {hist.slice(0, Math.min(hist.length, 17)).map((count, k) => (
                        <div key={k} className="q-hist-col">
                            <div className="q-hist-bar" style={{ height: `${Math.max(1, (count / total) * 100)}%` }} />
                            <span>{k}</span>
                        </div>
                    ))}
                </div>
            )}
            {hist && total > 0 && <p className="q-hint">Trailing zero bits per sample. Genuine 24-bit audio peaks at 0; 16-bit audio in a 24-bit container starts at 8.</p>}
        </div>
    );
}

function WindowsEvidence({ result }) {
    const windows = result.evidence && result.evidence.windows;
    if (!windows || windows.length === 0) return null;
    return (
        <div className="q-section">
            <h4>Sampled passages</h4>
            <div className="q-windows">
                {windows.map((w, i) => (
                    <span key={i} className={`q-window ${w.silent ? 'silent' : w.informative ? '' : 'dull'}`}
                        title={w.silent ? 'silent' : w.informative ? 'enough treble to judge' : 'too little treble to judge'}>
                        {formatTime(w.startSec)}
                        {w.cutoffHz ? ` · ${(w.cutoffHz / 1000).toFixed(1)}k / ${Math.round(w.stepDb)} dB` : w.silent ? ' · silent' : ''}
                    </span>
                ))}
            </div>
        </div>
    );
}

/** "Passage n of m" for the running job; subscribes to progress ticks on its own. */
function RunningNote({ analyzing }) {
    const progress = useQualityProgress();
    if (!analyzing || !progress) return null;
    return <div className="q-verdict-summary">Passage {progress.done} of {progress.total}</div>;
}

/** Details overlay for the song selected via QualityBadge / openPanel. */
export default function QualityPanel() {
    const store = useQuality();
    const song = store.getPanelSong();

    useEffect(() => {
        if (!song) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') store.closePanel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [song, store]);

    if (!song) return null;
    const result = store.getResult(song);
    const eligible = store.eligibility(song);
    const analyzing = store.isAnalyzing(song);
    const queued = store.isQueued(song);
    const busy = analyzing || queued;
    const info = describeResult(result);
    const Icon = TONE_ICONS[info.tone] || HelpCircle;

    return (
        <div className="q-overlay" onClick={() => store.closePanel()}>
            <div className="q-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Audio quality analysis">
                <div className="q-panel-head">
                    <div className="q-panel-title">
                        <h3>{song.title || song.path}</h3>
                        <p>{song.artist}{song.album ? ` · ${song.album}` : ''}{song.quality && song.quality.label ? ` · ${song.quality.label}` : ''}</p>
                    </div>
                    <button className="q-close" onClick={() => store.closePanel()} title="Close"><X size={18} /></button>
                </div>

                <div className="q-panel-body">
                    {busy && (
                        <div className="q-verdict q-muted">
                            <ScanSearch size={20} className="q-spin" />
                            <div>
                                <div className="q-verdict-title">{analyzing ? (result ? 'Analysing again…' : 'Analysing…') : 'Queued for analysis'}</div>
                                <RunningNote analyzing={analyzing} />
                            </div>
                        </div>
                    )}
                    {result ? (
                        <>
                            <div className={`q-verdict q-${info.tone}`}>
                                <Icon size={20} />
                                <div>
                                    <div className="q-verdict-title">
                                        {info.title}
                                        {result.confidence > 0 && <span className="q-conf"> · {confidenceLabel(result.confidence)} ({Math.round(result.confidence * 100)} %)</span>}
                                    </div>
                                    <div className="q-verdict-summary">{info.summary}</div>
                                </div>
                            </div>
                            {info.details.length > 0 && (
                                <ul className="q-details">
                                    {info.details.map((line, i) => <li key={i}>{line}</li>)}
                                </ul>
                            )}
                            {result.evidence && result.evidence.spectrum && (
                                <div className="q-section">
                                    <h4>Averaged spectrum</h4>
                                    <SpectrumPlot
                                        spectrum={result.evidence.spectrum}
                                        cutoffHz={result.cutoffHz}
                                        sampleRate={result.sampleRate}
                                        suspicious={info.suspicious}
                                    />
                                </div>
                            )}
                            <BitDepthEvidence result={result} />
                            <WindowsEvidence result={result} />
                            <p className="q-hint">
                                Heuristic analysis of a few short passages decoded at the file's native sample rate. A verdict is a likelihood, not proof.
                                {result.fromCache && !result.evidence?.windows ? ' Re-analyse to see per-passage evidence.' : ''}
                            </p>
                        </>
                    ) : !busy && (
                        <div className="q-verdict q-muted">
                            <HelpCircle size={20} />
                            <div>
                                <div className="q-verdict-title">Not analysed yet</div>
                                <div className="q-verdict-summary">
                                    {eligible === 'ok'
                                        ? 'Check this track for signs of a lossy transcode, upsampling or padded bit depth.'
                                        : ELIGIBILITY_TEXT[eligible] || ELIGIBILITY_TEXT.codec}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="q-panel-foot">
                    {eligible === 'ok' && !busy && (
                        <button className="q-analyze-btn" onClick={() => store.analyze([song], { label: song.title, force: true, front: true })}>
                            {result ? <RefreshCw size={14} /> : <ScanSearch size={14} />}
                            <span>{result ? 'Analyze again' : 'Analyze this track'}</span>
                        </button>
                    )}
                    <button className="q-secondary-btn" onClick={() => store.closePanel()}>Close</button>
                </div>
            </div>
        </div>
    );
}
