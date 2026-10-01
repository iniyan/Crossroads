import React, { useEffect, useState } from 'react';
import { RefreshCw, Smartphone, Monitor, Wifi, WifiOff, Trash2, Link2, X, Check, AlertTriangle, Pencil } from 'lucide-react';
import { parseHostPort } from '../sync/useLanSync';
import { formatPairingCode } from '../sync/crypto.mjs';
import { cleanDisplayName } from '../sync/names.mjs';
import '../styles/SyncView.css';

/**
 * A device name chosen by the other side. Sanitised again here (storage from older builds)
 * and rendered as its own isolated left-to-right run (`dir`, plus unicode-bidi: isolate in
 * the stylesheet), so a right-to-left or specially crafted name can neither reorder the text
 * around it nor pull the pairing code into itself; the code is always on a line of its own.
 */
const Name = ({ children, strong }) => {
    const text = cleanDisplayName(children) || 'Unnamed device';
    return strong ? <strong className="sync-name" dir="ltr">{text}</strong> : <span className="sync-name" dir="ltr">{text}</span>;
};

const PairingCode = ({ code }) => <div className="sync-code" dir="ltr">{formatPairingCode(code)}</div>;

const formatWhen = (ts) => {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return new Date(ts).toLocaleString();
};

const Toggle = ({ checked, onChange, label, disabled }) => (
    <label className={`sync-toggle ${disabled ? 'disabled' : ''}`}>
        <input type="checkbox" checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <span className="sync-toggle-track"><span className="sync-toggle-thumb" /></span>
        <span>{label}</span>
    </label>
);

const ResultLine = ({ result }) => {
    if (!result) return null;
    return (
        <div className={`sync-result ${result.error ? 'error' : ''}`}>
            {result.error ? <AlertTriangle size={14} /> : <Check size={14} />}
            <span>
                {result.error ? result.error : result.text}
                {result.peerName ? <> (<Name>{result.peerName}</Name>, {formatWhen(result.at)})</> : ''}
            </span>
        </div>
    );
};

const PeerList = ({ peers, onUnpair, onSyncNow, syncing, discovered }) => (
    <div className="sync-peers">
        {peers.length === 0 && <div className="sync-muted">No paired devices yet.</div>}
        {peers.map(peer => {
            const online = discovered ? discovered.some(d => d.peerId === peer.deviceId) : null;
            return (
                <div className="sync-peer" key={peer.deviceId}>
                    <div className="sync-peer-icon">{onSyncNow ? <Monitor size={20} /> : <Smartphone size={20} />}</div>
                    <div className="sync-peer-body">
                        <div className="sync-peer-name">
                            <Name>{peer.name}</Name>
                            {online === true && <span className="sync-badge online"><Wifi size={12} /> nearby</span>}
                            {online === false && peer.host && <span className="sync-badge"><WifiOff size={12} /> last seen {peer.host}:{peer.port}</span>}
                        </div>
                        <div className="sync-muted">Last sync: {formatWhen(peer.lastSyncAt)}{peer.pairedAt ? ` · paired ${formatWhen(peer.pairedAt)}` : ''}</div>
                    </div>
                    {onSyncNow && (
                        <button className="sync-btn primary" disabled={syncing} onClick={() => onSyncNow(peer.deviceId)} title="Sync now">
                            <RefreshCw size={14} className={syncing ? 'spin' : ''} /> Sync now
                        </button>
                    )}
                    <button className="sync-btn danger" onClick={() => { if (window.confirm(`Unpair ${cleanDisplayName(peer.name) || 'this device'}?`)) onUnpair(peer.deviceId); }} title="Unpair">
                        <Trash2 size={14} />
                    </button>
                </div>
            );
        })}
    </div>
);

// ---- desktop --------------------------------------------------------------------------------

const DeviceName = ({ name, onSave }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name || '');
    useEffect(() => { if (!editing) setDraft(name || ''); }, [name, editing]);
    if (!editing) {
        return (
            <div className="sync-muted">
                Shown to phones as <Name strong>{name}</Name>
                <button className="sync-btn small" onClick={() => setEditing(true)} title="Rename"><Pencil size={12} /> Rename</button>
            </div>
        );
    }
    const save = () => { if (draft.trim()) onSave(draft.trim()); setEditing(false); };
    return (
        <div className="sync-manual">
            <input value={draft} maxLength={48} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} autoFocus />
            <button className="sync-btn primary" onClick={save}><Check size={14} /> Save</button>
            <button className="sync-btn" onClick={() => setEditing(false)}><X size={14} /></button>
        </div>
    );
};

const lockText = (pairing) => {
    switch (pairing?.lockReason) {
        case 'rejected': return 'Pairing was stopped: you rejected the code.';
        case 'expired': return 'The pairing window expired.';
        case 'attempts': return 'The attempt limit for this window was reached.';
        case 'storage': return `Pairing failed: the phone could not be saved (${pairing.session?.error || 'storage error'}).`;
        default: return 'Pairing is closed.';
    }
};

const HostView = ({ sync }) => {
    const status = sync.hostStatus;
    const pairing = status?.pairing;
    const session = pairing?.session;
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!pairing || pairing.locked) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [pairing?.expiresAt, pairing?.locked]); // eslint-disable-line react-hooks/exhaustive-deps
    const secondsLeft = pairing?.open ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
    const live = session && ['started', 'compare', 'confirmed'].includes(session.status);
    const who = session ? <><Name strong>{session.clientName}</Name> <span className="sync-fingerprint" dir="ltr" title="Fingerprint of the phone's pairing key">{session.fingerprint}</span></> : null;

    return (
        <>
            <section className="sync-card">
                <Toggle checked={!!status?.enabled} disabled={!status} onChange={sync.setHostingEnabled} label="Let phones on this network sync with this computer" />
                {status && <DeviceName name={status.name} onSave={sync.setDeviceName} />}
                {status?.enabled && status.running && (
                    <div className="sync-muted">
                        Listening on port {status.port}
                        {status.addresses?.length ? ` · manual address: ${status.addresses.map(a => `${a}:${status.port}`).join(' or ')}` : ''}
                        <br />Advertised as _crossroads._tcp; phones on the same Wi-Fi find it automatically.
                    </div>
                )}
                {status?.error && <div className="sync-result error"><AlertTriangle size={14} /><span>{status.error}</span></div>}
                {!status?.enabled && <div className="sync-muted">Off: nothing listens on the network.</div>}
            </section>

            {status?.enabled && status.running && (
                <section className="sync-card">
                    <h3>Pair a device</h3>
                    {!pairing && (
                        <>
                            <p className="sync-muted">Open a two-minute window, then tap this computer's name in the Sync view on your phone.</p>
                            <button className="sync-btn primary" onClick={sync.openPairing}><Link2 size={14} /> Pair a device</button>
                        </>
                    )}
                    {pairing && pairing.locked && !live && (
                        <div className="sync-pairing">
                            <div className="sync-muted">{lockText(pairing)}</div>
                            <div className="sync-actions">
                                <button className="sync-btn primary" onClick={sync.openPairing}><Link2 size={14} /> Pair another device</button>
                                <button className="sync-btn" onClick={sync.closePairing}><X size={14} /> Dismiss</button>
                            </div>
                        </div>
                    )}
                    {pairing && !pairing.locked && !live && (
                        <div className="sync-pairing">
                            <div className="sync-muted">Waiting for a phone... {secondsLeft}s left · {pairing.attemptsLeft} attempt{pairing.attemptsLeft === 1 ? '' : 's'} left</div>
                            <button className="sync-btn" onClick={sync.closePairing}><X size={14} /> Cancel</button>
                        </div>
                    )}
                    {live && session.status === 'started' && (
                        <div className="sync-pairing">
                            <div className="sync-muted">{who} is connecting...</div>
                            <button className="sync-btn" onClick={sync.closePairing}><X size={14} /> Cancel</button>
                        </div>
                    )}
                    {live && session.status === 'compare' && (
                        <div className="sync-pairing">
                            <div>{who} wants to pair. Does the phone show this code?</div>
                            <PairingCode code={session.code} />
                            <div className="sync-actions">
                                <button className="sync-btn primary" onClick={() => sync.confirmPairing(session.id, true)}><Check size={14} /> Yes, the phone shows this code</button>
                                <button className="sync-btn danger" onClick={() => sync.confirmPairing(session.id, false)}><X size={14} /> No, reject</button>
                            </div>
                            <div className="sync-muted">Compare the digits and the name. If anything differs, someone else on the network is interfering: reject. The phone must confirm too.</div>
                        </div>
                    )}
                    {live && session.status === 'confirmed' && (
                        <div className="sync-pairing">
                            <div className="sync-muted">Waiting for {who} to confirm this code...</div>
                            <PairingCode code={session.code} />
                            <button className="sync-btn" onClick={sync.closePairing}><X size={14} /> Cancel</button>
                        </div>
                    )}
                </section>
            )}

            <section className="sync-card">
                <h3>Paired phones</h3>
                <PeerList peers={sync.peers} onUnpair={sync.unpair} />
                <p className="sync-muted">Syncs are started from the phone (Sync now, or automatically when it comes back to this network). Unpairing here is one-sided: the phone learns about it the next time it tries to sync.</p>
                <ResultLine result={sync.lastResult} />
                {sync.unmatched > 0 && <div className="sync-muted">{sync.unmatched} synced track{sync.unmatched === 1 ? ' is' : 's are'} not in this library; they stay in the sync data until they appear.</div>}
            </section>
        </>
    );
};

// ---- phone ----------------------------------------------------------------------------------

const ClientView = ({ sync }) => {
    const [manual, setManual] = useState('');
    const [manualError, setManualError] = useState('');
    useEffect(() => sync.acquireDiscovery(), []); // eslint-disable-line react-hooks/exhaustive-deps

    const pairable = sync.discovered.filter(d => !d.peerId);
    const pairing = sync.pairing;

    const submitManual = () => {
        const target = parseHostPort(manual);
        if (!target) { setManualError('Enter the address as ip:port, e.g. 192.168.1.20:51234'); return; }
        setManualError('');
        sync.pairWith(target);
    };

    return (
        <>
            <section className="sync-card">
                <h3>Paired computers</h3>
                <PeerList peers={sync.peers} onUnpair={sync.unpair} onSyncNow={(id) => sync.syncNow(id)} syncing={sync.syncing} discovered={sync.discovered} />
                <Toggle checked={sync.autoSync} onChange={sync.setAutoSync} label="Sync automatically when a paired computer is nearby" disabled={sync.peers.length === 0} />
                <ResultLine result={sync.lastResult} />
                {sync.unmatched > 0 && <div className="sync-muted">{sync.unmatched} synced track{sync.unmatched === 1 ? ' is' : 's are'} not on this phone; they stay in the sync data until they appear.</div>}
            </section>

            <section className="sync-card">
                <h3>Pair with a computer</h3>
                {pairing && pairing.status !== 'error' && pairing.status !== 'done' && (
                    <div className="sync-pairing">
                        {pairing.status === 'connecting' && <div className="sync-muted">Connecting to {pairing.host}:{pairing.port}...</div>}
                        {pairing.status === 'compare' && (
                            <>
                                <div>Pairing with <Name strong>{pairing.serverName}</Name> <span className="sync-fingerprint" dir="ltr" title="Fingerprint of the computer's pairing key">{pairing.fingerprint}</span>. Both screens must show this code:</div>
                                <PairingCode code={pairing.code} />
                                {!pairing.confirmed && (
                                    <button className="sync-btn primary" onClick={sync.confirmPairingCode}><Check size={14} /> The computer shows this code</button>
                                )}
                                {pairing.confirmed && <div className="sync-muted">Waiting for the computer to confirm...</div>}
                                <div className="sync-muted">If the computer shows different digits, cancel: someone else on the network is interfering.</div>
                            </>
                        )}
                        <button className="sync-btn" onClick={sync.cancelPairing}><X size={14} /> Cancel</button>
                    </div>
                )}
                {pairing?.status === 'done' && <div className="sync-result"><Check size={14} /><span>Paired with <Name>{pairing.serverName}</Name>. You can sync now.</span></div>}
                {pairing?.status === 'error' && <div className="sync-result error"><AlertTriangle size={14} /><span>{pairing.error}</span></div>}
                {(!pairing || pairing.status === 'error' || pairing.status === 'done') && (
                    <>
                        <p className="sync-muted">On the computer, open Sync and click "Pair a device", then tap it here.</p>
                        <div className="sync-discovered">
                            {pairable.length === 0 && <div className="sync-muted">{sync.discovering ? 'Looking for Crossroads on this network...' : 'Not looking right now.'}</div>}
                            {pairable.map(d => (
                                <button key={d.name} className="sync-btn wide" onClick={() => sync.pairWith({ host: d.host, port: d.port })}>
                                    <Monitor size={14} /> <Name>{d.label || d.name}</Name> <span className="sync-muted" dir="ltr">{d.host}:{d.port}</span>
                                </button>
                            ))}
                        </div>
                        <div className="sync-manual">
                            <input
                                value={manual}
                                onChange={e => setManual(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitManual(); }}
                                placeholder="Or enter ip:port shown on the computer"
                                inputMode="decimal"
                            />
                            <button className="sync-btn" onClick={submitManual}><Link2 size={14} /> Pair</button>
                        </div>
                        {manualError && <div className="sync-result error"><AlertTriangle size={14} /><span>{manualError}</span></div>}
                    </>
                )}
            </section>
        </>
    );
};

const SyncView = ({ sync }) => (
    <div className="sync-view">
        <div className="header-row">
            <h1>Sync</h1>
        </div>
        {!sync.mode && <section className="sync-card"><div className="sync-muted">Sync is available in the desktop and Android apps.</div></section>}
        {sync.mode && !sync.loaded && <section className="sync-card"><div className="sync-muted">Loading...</div></section>}
        {sync.mode === 'host' && sync.loaded && <HostView sync={sync} />}
        {sync.mode === 'client' && sync.loaded && <ClientView sync={sync} />}
        {sync.mode && (
            <p className="sync-footnote">
                Playlists, favorites and play history are matched across devices by track (artist, album, title or MusicBrainz id),
                never by file path. Everything stays on your local network, encrypted with the key created when you paired.
                {sync.deviceName ? <> This device: <Name>{sync.deviceName}</Name>.</> : ''}
            </p>
        )}
    </div>
);

export default SyncView;
