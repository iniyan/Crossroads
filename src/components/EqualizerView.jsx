import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Power, Plus, Trash2, Save, Search, RefreshCw, Headphones, Activity, Pencil, Download, AlertTriangle } from 'lucide-react';
import EqCurve from './EqCurve';
import { effectivePreampDb, autoPreampDb, peakBoostDb, MIN_FREQUENCY, MAX_FREQUENCY, MIN_GAIN, MAX_GAIN, MIN_Q, MAX_Q, MIN_PREAMP, MAX_PREAMP, BOOST_WARNING_DB } from '../audio/eqMath';
import { CROSSFEED_PRESETS, MIN_FCUT, MAX_FCUT, MIN_FEED, MAX_FEED, resolveCrossfeed } from '../audio/crossfeed';
import { BUILTIN_PRESETS, MAX_USER_PRESETS, newBand, bandsFrom } from '../audio/dspState';
import { MAX_BANDS, searchAutoEqIndex, entryLabel } from '../audio/autoeq';
import { loadAutoEqIndex, loadAutoEqProfile, cachedProfilePaths } from '../audio/autoeqStore';
import '../styles/Equalizer.css';

const BAND_TYPE_LABELS = { peaking: 'Peak', lowshelf: 'Low shelf', highshelf: 'High shelf' };

const Toggle = ({ checked, onChange, label }) => (
    <button type="button" className={`eq-toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked} aria-label={label}>
        <span className="eq-toggle-knob" />
    </button>
);

const NumberField = ({ value, onCommit, min, max, step, suffix, disabled, width = 78 }) => {
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);
    const commit = () => {
        const n = Number(text);
        if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
        else setText(String(value));
    };
    return (
        <span className="eq-number">
            <input
                type="number" value={text} min={min} max={max} step={step} disabled={disabled} style={{ width }}
                onChange={e => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
            />
            {suffix && <span className="eq-suffix">{suffix}</span>}
        </span>
    );
};

const EqualizerView = ({ dsp, onChange, engine }) => {
    const { eq, crossfeed, bypass, presets } = dsp;
    const [selectedBandId, setSelectedBandId] = useState(null);
    const [autoeq, setAutoeq] = useState({ status: 'idle', entries: null, query: '', results: [], message: null, cached: new Set(), busyPath: null, fetchedAt: null });
    const [presetName, setPresetName] = useState('');
    const [renamingId, setRenamingId] = useState(null);
    const [renameText, setRenameText] = useState('');
    const [engineTick, setEngineTick] = useState(0);
    const searchTimer = useRef(null);

    useEffect(() => engine ? engine.subscribe(() => setEngineTick(t => t + 1)) : undefined, [engine]);
    useEffect(() => { cachedProfilePaths().then(paths => setAutoeq(a => ({ ...a, cached: new Set(paths) }))); }, []);

    const sampleRate = engine ? engine.sampleRate : 48000;
    const update = useCallback((fn) => onChange(prev => fn(prev)), [onChange]);
    const updateEq = useCallback((patch) => update(prev => ({ ...prev, eq: { ...prev.eq, ...(typeof patch === 'function' ? patch(prev.eq) : patch) } })), [update]);
    const updateBand = (id, patch) => updateEq(prevEq => ({ bands: prevEq.bands.map(band => (band.id === id ? { ...band, ...patch } : band)), profile: null }));

    const preampValue = effectivePreampDb(eq, sampleRate);
    const autoValue = autoPreampDb(eq.bands, sampleRate);
    const peakBoost = peakBoostDb(eq.bands, sampleRate);
    const processing = engine ? engine.active : false;

    // ---- presets ----------------------------------------------------------------------------
    const applyPreset = (preset, label) => {
        updateEq({ bands: bandsFrom(preset.bands), preampAuto: preset.preampAuto !== false, preamp: preset.preamp || 0, profile: label, enabled: true });
        setSelectedBandId(null);
    };
    const savePreset = () => {
        const name = presetName.trim();
        if (!name) return;
        update(prev => {
            const existing = prev.presets.find(p => p.name.toLowerCase() === name.toLowerCase());
            const preset = { id: existing ? existing.id : `p${Date.now().toString(36)}`, name, bands: prev.eq.bands, preampAuto: prev.eq.preampAuto, preamp: prev.eq.preamp };
            const list = existing ? prev.presets.map(p => (p.id === existing.id ? preset : p)) : [...prev.presets, preset].slice(-MAX_USER_PRESETS);
            return { ...prev, presets: list, eq: { ...prev.eq, profile: name } };
        });
        setPresetName('');
    };
    const deletePreset = (id) => update(prev => ({ ...prev, presets: prev.presets.filter(p => p.id !== id) }));
    const renamePreset = (id) => {
        const name = renameText.trim();
        if (name) update(prev => ({ ...prev, presets: prev.presets.map(p => (p.id === id ? { ...p, name } : p)) }));
        setRenamingId(null);
    };

    // ---- AutoEq -----------------------------------------------------------------------------
    const ensureIndex = async (force = false) => {
        setAutoeq(a => ({ ...a, status: 'loading', message: force ? 'Refreshing headphone list…' : 'Loading headphone list…' }));
        try {
            const { entries, fromCache, fetchedAt, error } = await loadAutoEqIndex({ force });
            setAutoeq(a => ({
                ...a, status: 'ready', entries, fetchedAt,
                message: error ? 'Offline: showing the cached list.' : `${entries.length} results${fromCache ? ' (cached)' : ''}`,
                results: a.query ? searchAutoEqIndex(entries, a.query) : []
            }));
        } catch (e) {
            setAutoeq(a => ({ ...a, status: 'error', message: `Could not load the AutoEq list (${e.message}). Check your connection.` }));
        }
    };
    const onQuery = (query) => {
        setAutoeq(a => ({ ...a, query, results: a.entries ? searchAutoEqIndex(a.entries, query) : a.results }));
        if (!autoeq.entries && autoeq.status !== 'loading' && query.trim()) {
            clearTimeout(searchTimer.current);
            searchTimer.current = setTimeout(() => ensureIndex(false), 300);
        }
    };
    const applyAutoEq = async (entry) => {
        setAutoeq(a => ({ ...a, busyPath: entry.path, message: `Loading ${entry.name}…` }));
        try {
            const profile = await loadAutoEqProfile(entry);
            update(prev => ({
                ...prev,
                eq: {
                    ...prev.eq,
                    enabled: true,
                    bands: bandsFrom(profile.filters),
                    preamp: profile.preamp,
                    profile: `${entry.name} (${entry.source})`
                }
            }));
            setAutoeq(a => ({ ...a, busyPath: null, cached: new Set([...a.cached, entry.path]), message: `Applied ${entry.name} by ${entry.source}: ${profile.filters.length} filters, AutoEq preamp ${profile.preamp} dB${profile.fromCache ? ' (offline copy)' : ''}.` }));
        } catch (e) {
            setAutoeq(a => ({ ...a, busyPath: null, message: `Could not load ${entry.name} (${e.message}).` }));
        }
    };

    const crossfeedResolved = resolveCrossfeed(crossfeed);
    const bandLimitReached = eq.bands.length >= MAX_BANDS;
    const signalPath = useMemo(() => (engine ? engine.describe() : 'Web Audio unavailable'), [engine, engineTick, dsp]);

    return (
        <div className="eq-view">
            <div className="header-row eq-header">
                <div>
                    <h1>Equalizer</h1>
                    <p className={`eq-signal-path ${processing ? 'active' : ''}`}>
                        <Activity size={14} /> {signalPath}
                    </p>
                </div>
                <button type="button" className={`eq-bypass ${bypass ? 'on' : ''}`} onClick={() => update(prev => ({ ...prev, bypass: !prev.bypass }))} title="Bypass all processing">
                    <Power size={16} /> {bypass ? 'Bypassed' : 'Bypass'}
                </button>
            </div>
            {engine && engine.lastError && (
                <div className="eq-warning"><AlertTriangle size={14} /> {engine.lastError}</div>
            )}

            <section className={`eq-card ${eq.enabled && !bypass ? '' : 'muted'}`}>
                <div className="eq-card-head">
                    <div className="eq-card-title">
                        <Toggle checked={eq.enabled} onChange={v => updateEq({ enabled: v })} label="Enable equalizer" />
                        <h3>Parametric EQ</h3>
                        {eq.profile && <span className="eq-chip">{eq.profile}</span>}
                    </div>
                    <div className="eq-preamp">
                        <label>
                            <input type="checkbox" checked={eq.preampAuto} onChange={e => updateEq({ preampAuto: e.target.checked, preamp: e.target.checked ? eq.preamp : preampValue })} />
                            Auto preamp
                        </label>
                        {eq.preampAuto ? (
                            <span className="eq-preamp-value" title="-(largest boost of the combined curve), so the EQ can never clip">{autoValue.toFixed(1)} dB</span>
                        ) : (
                            <NumberField value={eq.preamp} min={MIN_PREAMP} max={MAX_PREAMP} step={0.5} suffix="dB" onCommit={v => updateEq({ preamp: v })} />
                        )}
                        {!eq.preampAuto && eq.preamp > autoValue + 0.05 && <span className="eq-clip" title="Preamp is above the clipping-safe value">may clip</span>}
                    </div>
                </div>
                {peakBoost > BOOST_WARNING_DB && (
                    <div className="eq-warning">
                        <AlertTriangle size={14} /> The bands add up to a {peakBoost.toFixed(1)} dB boost. The preamp compensates ({preampValue.toFixed(1)} dB), but that much gain amplifies noise and leaves little headroom; consider cutting instead of boosting.
                    </div>
                )}

                <EqCurve eq={eq} sampleRate={sampleRate} selectedBandId={selectedBandId} onSelectBand={setSelectedBandId} />

                <div className="eq-bands">
                    {eq.bands.length === 0 && <div className="eq-empty">No bands. Add one, pick a preset or load an AutoEq profile below.</div>}
                    {eq.bands.map((band, i) => (
                        <div key={band.id} className={`eq-band ${band.enabled ? '' : 'off'} ${selectedBandId === band.id ? 'selected' : ''}`} onClick={() => setSelectedBandId(band.id)}>
                            <input type="checkbox" checked={band.enabled} onChange={e => updateBand(band.id, { enabled: e.target.checked })} title="Band on/off" />
                            <span className="eq-band-index">{i + 1}</span>
                            <select value={band.type} onChange={e => updateBand(band.id, { type: e.target.value })}>
                                {Object.entries(BAND_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                            <NumberField value={band.frequency} min={MIN_FREQUENCY} max={MAX_FREQUENCY} step={1} suffix="Hz" onCommit={v => updateBand(band.id, { frequency: v })} />
                            <input
                                type="range" className="eq-gain-slider" min={MIN_GAIN} max={MAX_GAIN} step={0.1} value={band.gain}
                                onChange={e => updateBand(band.id, { gain: Number(e.target.value) })} title={`${band.gain} dB`}
                            />
                            <NumberField value={band.gain} min={MIN_GAIN} max={MAX_GAIN} step={0.1} suffix="dB" width={64} onCommit={v => updateBand(band.id, { gain: v })} />
                            <NumberField value={band.q} min={MIN_Q} max={MAX_Q} step={0.05} suffix="Q" width={64} disabled={band.type !== 'peaking'} onCommit={v => updateBand(band.id, { q: v })} />
                            <button type="button" className="eq-icon" title="Remove band" onClick={(e) => { e.stopPropagation(); updateEq(prevEq => ({ bands: prevEq.bands.filter(b => b.id !== band.id), profile: null })); }}>
                                <Trash2 size={15} />
                            </button>
                        </div>
                    ))}
                    <div className="eq-band-actions">
                        <button type="button" className="eq-btn" disabled={bandLimitReached} onClick={() => updateEq(prevEq => ({ bands: [...prevEq.bands, newBand()], profile: null }))}>
                            <Plus size={14} /> Add band {bandLimitReached ? `(max ${MAX_BANDS})` : ''}
                        </button>
                        {eq.bands.length > 0 && (
                            <button type="button" className="eq-btn" onClick={() => updateEq({ bands: [], profile: null })}>Clear</button>
                        )}
                    </div>
                </div>
            </section>

            <section className="eq-card">
                <div className="eq-card-head"><h3>Presets</h3></div>
                <div className="eq-preset-row">
                    {BUILTIN_PRESETS.map(preset => (
                        <button key={preset.id} type="button" className={`eq-btn ${eq.profile === preset.name ? 'active' : ''}`} onClick={() => applyPreset(preset, preset.name)}>{preset.name}</button>
                    ))}
                </div>
                {presets.length > 0 && (
                    <div className="eq-user-presets">
                        {presets.map(preset => (
                            <div key={preset.id} className={`eq-user-preset ${eq.profile === preset.name ? 'active' : ''}`}>
                                {renamingId === preset.id ? (
                                    <input
                                        autoFocus value={renameText} onChange={e => setRenameText(e.target.value)}
                                        onBlur={() => renamePreset(preset.id)}
                                        onKeyDown={e => { if (e.key === 'Enter') renamePreset(preset.id); if (e.key === 'Escape') setRenamingId(null); }}
                                    />
                                ) : (
                                    <button type="button" className="eq-preset-name" onClick={() => applyPreset(preset, preset.name)}>{preset.name} <small>{preset.bands.length} bands</small></button>
                                )}
                                <button type="button" className="eq-icon" title="Rename" onClick={() => { setRenamingId(preset.id); setRenameText(preset.name); }}><Pencil size={14} /></button>
                                <button type="button" className="eq-icon" title="Delete" onClick={() => deletePreset(preset.id)}><Trash2 size={14} /></button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="eq-save-row">
                    <input
                        placeholder="Save current bands as…" value={presetName} maxLength={60}
                        onChange={e => setPresetName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') savePreset(); }}
                    />
                    <button type="button" className="eq-btn" disabled={!presetName.trim() || eq.bands.length === 0} onClick={savePreset}><Save size={14} /> Save</button>
                </div>
            </section>

            <section className="eq-card">
                <div className="eq-card-head">
                    <div className="eq-card-title"><Headphones size={18} /><h3>AutoEq headphone profiles</h3></div>
                    <button type="button" className="eq-icon" title="Refresh list" onClick={() => ensureIndex(true)} disabled={autoeq.status === 'loading'}>
                        <RefreshCw size={15} className={autoeq.status === 'loading' ? 'spin' : ''} />
                    </button>
                </div>
                <p className="eq-help">
                    Search the <a href="https://github.com/jaakkopasanen/AutoEq" target="_blank" rel="noreferrer">AutoEq</a> results for your headphones and apply the ParametricEQ profile. Fetched once from GitHub and kept offline.
                </p>
                <div className="eq-search">
                    <Search size={16} />
                    <input placeholder="Headphone model, e.g. HD 650" value={autoeq.query} onChange={e => onQuery(e.target.value)} onFocus={() => { if (!autoeq.entries && autoeq.status === 'idle') ensureIndex(false); }} />
                </div>
                {autoeq.message && <div className={`eq-status ${autoeq.status === 'error' ? 'error' : ''}`}>{autoeq.message}</div>}
                <div className="eq-results">
                    {autoeq.results.map(entry => (
                        <button key={entry.path} type="button" className="eq-result" disabled={autoeq.busyPath !== null} onClick={() => applyAutoEq(entry)}>
                            <span className="eq-result-name">{entry.name}</span>
                            <span className="eq-result-meta">{entryLabel(entry)}</span>
                            {autoeq.cached.has(entry.path) && <span className="eq-chip small" title="Available offline"><Download size={10} /> offline</span>}
                        </button>
                    ))}
                    {autoeq.entries && autoeq.query.trim() && autoeq.results.length === 0 && <div className="eq-empty">No headphones match "{autoeq.query}".</div>}
                </div>
            </section>

            <section className={`eq-card ${crossfeed.enabled && !bypass ? '' : 'muted'}`}>
                <div className="eq-card-head">
                    <div className="eq-card-title">
                        <Toggle checked={crossfeed.enabled} onChange={v => update(prev => ({ ...prev, crossfeed: { ...prev.crossfeed, enabled: v } }))} label="Enable crossfeed" />
                        <h3>Headphone crossfeed</h3>
                    </div>
                </div>
                <p className="eq-help">Bauer-style (bs2b) crossfeed: a low-passed, attenuated copy of each channel is mixed into the other, so hard-panned recordings sit in front of you instead of inside your head. Centred sounds keep their level and tone.</p>
                <div className="eq-crossfeed">
                    <select value={crossfeed.preset} onChange={e => update(prev => ({ ...prev, crossfeed: { ...prev.crossfeed, preset: e.target.value, fcut: crossfeedResolved.fcut, feed: crossfeedResolved.feed } }))}>
                        {CROSSFEED_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <label>
                        Cut-off
                        <input type="range" min={MIN_FCUT} max={MAX_FCUT} step={10} value={crossfeedResolved.fcut} disabled={crossfeed.preset !== 'custom'}
                            onChange={e => update(prev => ({ ...prev, crossfeed: { ...prev.crossfeed, fcut: Number(e.target.value) } }))} />
                        <span>{crossfeedResolved.fcut} Hz</span>
                    </label>
                    <label>
                        Feed level
                        <input type="range" min={MIN_FEED} max={MAX_FEED} step={0.5} value={crossfeedResolved.feed} disabled={crossfeed.preset !== 'custom'}
                            onChange={e => update(prev => ({ ...prev, crossfeed: { ...prev.crossfeed, feed: Number(e.target.value) } }))} />
                        <span>-{crossfeedResolved.feed} dB</span>
                    </label>
                </div>
            </section>

            <p className="eq-footnote">
                Enabling the EQ or crossfeed routes playback through Web Audio for the rest of this session (resampled to {sampleRate} Hz). Bypass removes the filters from the signal path; restart Crossroads to return to native, bit-perfect output.
            </p>
        </div>
    );
};

export default EqualizerView;
