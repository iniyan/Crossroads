// React glue for LAN sync (#25): owns the small persisted sync record (identity, peers,
// watermarks), the model store (IndexedDB via blobStore: it holds the whole synced history and
// is too large for the settings store), runs exchanges against the app state (favorites /
// playlists / stats live in App.jsx) and exposes what the Sync view needs. Desktop: answers
// the main process's incoming exchanges. Android: discovers desktops, pairs, syncs (manually
// or when the app comes to the foreground).
//
// Concurrency: exchanges run one at a time (`withStore`), capture from the local mirror (see
// mirror.js) and apply their ops with functional state updates so edits made while a request
// was in flight survive.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Platform from '../services/PlatformService';
import { deleteBlob, getBlob, setBlob } from '../services/blobStore.js';
import { applyFavoriteOps, applyPlaylistOps, applyPlaysToStats, clientReceive, clientRequest, countUnmatched, createStore, serverExchange } from './model.js';
import { createSyncClient } from './client.js';
import { createLocalMirror } from './mirror.js';
import { chooseEndpoints, describeSyncFailure, matchDiscovered, shouldTryNext, unverifiedStreak } from './endpoints.js';
import { randomId } from './crypto.mjs';
import { cleanDisplayName } from './names.mjs';

const RECORD_VERSION = 2;
const STORE_BLOB = 'sync:store';
const AUTO_SYNC_DISCOVERY_MS = 20 * 1000;
const AUTO_SYNC_MIN_INTERVAL_MS = 60 * 1000;
const secretKey = (deviceId) => `peer:${deviceId}`;

const emptyRecord = () => ({ version: RECORD_VERSION, deviceId: null, deviceName: null, autoSync: false, peers: [] });

const normalizeRecord = (saved) => {
    const r = saved && typeof saved === 'object' && saved.version === RECORD_VERSION ? saved : {};
    return {
        ...emptyRecord(),
        deviceId: typeof r.deviceId === 'string' && r.deviceId ? r.deviceId : null,
        deviceName: cleanDisplayName(r.deviceName) || null,
        autoSync: r.autoSync === true,
        // Peer names were sanitised when stored, but records written by earlier builds get it here.
        peers: Array.isArray(r.peers) ? r.peers.filter(p => p && typeof p.deviceId === 'string').map(p => ({ ...p, name: cleanDisplayName(p.name) || 'Desktop' })) : []
    };
};

const errorMessage = (e) => (e && typeof e.message === 'string' && e.message) || String(e || 'Unknown error');
const codedError = (code, message) => Object.assign(new Error(message), { code });

/** The phone's per-desktop secret: { ltk, tx: last counter sent, rx: last counter accepted }. */
const parseSecret = (text) => {
    if (typeof text !== 'string' || !text) return null;
    try {
        const s = JSON.parse(text);
        if (!s || typeof s.ltk !== 'string') return null;
        return { ltk: s.ltk, tx: Number.isSafeInteger(s.tx) && s.tx >= 0 ? s.tx : 0, rx: Number.isSafeInteger(s.rx) && s.rx >= 0 ? s.rx : 0 };
    } catch {
        return null;
    }
};

/** "12 plays, 2 playlists, 3 favorites synced; 4 tracks not in this library" */
export const describeReport = (report) => {
    if (!report) return '';
    const parts = [];
    const plays = report.playsAdded || 0;
    const playlists = (report.playlistsCreated || 0) + (report.playlistsUpdated || 0) + (report.playlistsDeleted || 0);
    const favorites = (report.favoritesAdded || 0) + (report.favoritesRemoved || 0);
    if (plays) parts.push(`${plays} play${plays === 1 ? '' : 's'}`);
    if (playlists) parts.push(`${playlists} playlist${playlists === 1 ? '' : 's'}`);
    if (favorites) parts.push(`${favorites} favorite${favorites === 1 ? '' : 's'}`);
    let text = parts.length ? `${parts.join(', ')} synced` : 'Already up to date';
    if (report.unmatched) text += `; ${report.unmatched} track${report.unmatched === 1 ? '' : 's'} not in this library`;
    if (report.rejected) text += `; ${report.rejected} invalid item${report.rejected === 1 ? '' : 's'} ignored`;
    return text;
};

export const parseHostPort = (text) => {
    const m = /^\s*\[?([0-9a-fA-F.:]+?)\]?\s*:\s*(\d{1,5})\s*$/.exec(text || '');
    if (!m) return null;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    return { host: m[1], port };
};

/**
 * @param {Object} app
 * @param {Array} app.songs
 * @param {Array} app.favorites
 * @param {Array} app.playlists
 * @param {Object} app.stats
 * @param {Function} app.setFavorites
 * @param {Function} app.setPlaylists
 * @param {Function} app.setStats
 * @param {() => boolean} app.isReady   true once favorites, playlists and stats were loaded
 * @param {() => void} [app.onPlaysApplied]  asks the app to persist stats as soon as they re-render
 */
export default function useLanSync({ songs, favorites, playlists, stats, setFavorites, setPlaylists, setStats, isReady, onPlaysApplied }) {
    const mode = Platform.sync.mode;
    const [record, setRecord] = useState(null);           // persisted sync record (null until loaded)
    const [storeTick, setStoreTick] = useState(0);        // bumps when the model store changed
    const [hostStatus, setHostStatus] = useState(null);   // desktop: main-process status
    const [discovered, setDiscovered] = useState([]);     // phone: [{ name, host, port, salt, tag, peerId }]
    const [discoveryActive, setDiscoveryActive] = useState(false);
    const [pairing, setPairing] = useState(null);         // phone: { status, code, serverName, fingerprint, confirmed, error }
    const [syncing, setSyncing] = useState(false);
    const [lastResult, setLastResult] = useState(null);   // { at, peerName, text, error }

    const recordRef = useRef(null);
    const storeRef = useRef(null);
    const mirrorRef = useRef(null);
    if (!mirrorRef.current) mirrorRef.current = createLocalMirror();
    const callbacks = useRef({});
    const queueRef = useRef(Promise.resolve());
    const pairingCancelRef = useRef(false);
    const pairingConfirmedRef = useRef(false);
    const discoveredRef = useRef([]);
    const discoveryUsersRef = useRef(0);
    const lastAutoSyncRef = useRef(0);
    const hostStatusRef = useRef(null);
    const syncingRef = useRef(false);

    mirrorRef.current.observe({ songs, favorites, playlists, stats });
    callbacks.current = { setFavorites, setPlaylists, setStats, isReady, onPlaysApplied };
    discoveredRef.current = discovered;
    hostStatusRef.current = hostStatus;

    const saveRecord = useCallback((next) => {
        recordRef.current = next;
        setRecord(next);
        Promise.resolve(Platform.sync.setRecord(next)).catch(e => {
            console.error('Failed to save sync state', e);
            setLastResult({ at: Date.now(), error: `Could not save the sync settings: ${errorMessage(e)}` });
        });
    }, []);

    // Load the record and the model store once; mint the phone's identity on first use.
    useEffect(() => {
        if (!mode) return undefined;
        let cancelled = false;
        (async () => {
            let loaded;
            let savedStore;
            try {
                loaded = normalizeRecord(await Platform.sync.getRecord());
                savedStore = await getBlob(STORE_BLOB);
            } catch (e) {
                console.error('Failed to load sync state; sync disabled this session', e);
                return;
            }
            if (cancelled) return;
            let fresh = false;
            if (mode === 'client' && !loaded.deviceId) { loaded = { ...loaded, deviceId: `phone-${randomId()}` }; fresh = true; }
            if (mode === 'client' && !loaded.deviceName) loaded = { ...loaded, deviceName: cleanDisplayName(await Platform.sync.getDeviceName()) || 'Android phone' };
            if (cancelled) return;
            if (fresh && savedStore) {
                // A new identity with an old store (restored backup): the snapshot and clock belong
                // to another device; start over.
                savedStore = null;
                deleteBlob(STORE_BLOB).catch(() => {});
            }
            storeRef.current = createStore(loaded.deviceId || 'desktop', savedStore);
            recordRef.current = loaded;
            setRecord(loaded);
            if (fresh) saveRecord(loaded);
        })();
        return () => { cancelled = true; };
    }, [mode, saveRecord]);

    // Runs `fn` with the current model store and app state, one at a time, applies its ops
    // and persists the store. `fn(store, local)` -> { store, ops?, report?, recordPatch? }.
    const withStore = useCallback((deviceId, fn) => {
        const run = async () => {
            const rec = recordRef.current;
            if (!rec || !storeRef.current) throw new Error('Sync state is not loaded yet');
            const { setFavorites: sf, setPlaylists: sp, setStats: ss, isReady: ready, onPlaysApplied: flush } = callbacks.current;
            if (!ready()) throw new Error('The library data has not finished loading');
            const store = storeRef.current.deviceId === deviceId ? storeRef.current : createStore(deviceId, storeRef.current);
            const local = mirrorRef.current.get();
            const out = await fn(store, local);
            const ops = out.ops;
            if (ops) {
                if (ops.favorites.add.length || ops.favorites.remove.length) sf(prev => applyFavoriteOps(prev, ops));
                if (ops.playlists.upsert.length || ops.playlists.remove.length) sp(prev => applyPlaylistOps(prev, ops));
                if (ops.plays.length) {
                    ss(prev => applyPlaysToStats(prev, ops.plays));
                    flush?.();
                }
                mirrorRef.current.commit(ops);
            }
            storeRef.current = out.store;
            setStoreTick(t => t + 1);
            if (out.recordPatch) saveRecord({ ...recordRef.current, ...out.recordPatch });
            try {
                await setBlob(STORE_BLOB, out.store);
            } catch (e) {
                console.error('Failed to persist the sync store', e);
                setLastResult({ at: Date.now(), error: `Synced, but the sync state could not be saved: ${errorMessage(e)}` });
            }
            return out;
        };
        const result = queueRef.current.then(run, run);
        queueRef.current = result.catch(() => {});
        return result;
    }, [saveRecord]);

    // ---- desktop: host -------------------------------------------------------------------------

    useEffect(() => {
        if (mode !== 'host') return undefined;
        const host = Platform.sync.host;
        host.getStatus().then(setHostStatus).catch(e => console.error('sync status failed', e));
        const unsubStatus = host.onStatus(setHostStatus);
        const unsubExchange = host.onExchange(async ({ id, peerId, payload }) => {
            const deviceId = hostStatusRef.current?.deviceId;
            try {
                if (!deviceId) throw new Error('Sync identity unknown');
                const out = await withStore(deviceId, async (store, local) => serverExchange({ store, local, request: payload }));
                const peer = hostStatusRef.current?.peers?.find(p => p.deviceId === peerId);
                setLastResult({ at: Date.now(), peerName: peer?.name || peerId, text: describeReport(out.report) });
                host.exchangeResult(id, { ok: true, response: out.response });
            } catch (e) {
                console.error('sync exchange failed', e);
                setLastResult({ at: Date.now(), error: errorMessage(e) });
                host.exchangeResult(id, { ok: false, error: errorMessage(e), code: e?.code });
            }
        });
        return () => { unsubStatus(); unsubExchange(); };
    }, [mode, withStore]);

    const hostCall = useCallback(async (fn) => {
        if (mode !== 'host') return;
        try { setHostStatus(await fn(Platform.sync.host)); } catch (e) { setLastResult({ at: Date.now(), error: errorMessage(e) }); }
    }, [mode]);
    const setHostingEnabled = useCallback((enabled) => hostCall(h => h.setEnabled(!!enabled)), [hostCall]);
    const setDeviceName = useCallback((name) => hostCall(h => h.setDeviceName(String(name))), [hostCall]);
    const openPairing = useCallback(() => hostCall(h => h.openPairing()), [hostCall]);
    const closePairing = useCallback(() => hostCall(h => h.closePairing()), [hostCall]);
    const confirmPairing = useCallback((sessionId, accept) => hostCall(h => h.confirmPairing(sessionId, !!accept)), [hostCall]);

    // ---- phone: discovery (reference counted: the view and auto-sync share one browse) ----------

    const acquireDiscovery = useCallback(() => {
        discoveryUsersRef.current += 1;
        if (discoveryUsersRef.current === 1) setDiscoveryActive(true);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            discoveryUsersRef.current = Math.max(0, discoveryUsersRef.current - 1);
            if (discoveryUsersRef.current === 0) setDiscoveryActive(false);
        };
    }, []);

    useEffect(() => {
        if (mode !== 'client' || !discoveryActive) return undefined;
        let stopped = false;
        const unsubscribe = Platform.sync.startDiscovery(
            async (service) => {
                if (!service || !service.host || !service.port) return;
                const txt = service.txt || {};
                // `name` is the raw mDNS instance name (the key serviceLost reports); `label` is what the UI shows.
                const entry = { name: service.name, label: cleanDisplayName(service.name) || 'Unnamed computer', host: service.host, port: Number(service.port), salt: txt.s || null, tag: txt.h || null, v: txt.v || null, peerId: null };
                entry.peerId = await matchDiscovered(entry, recordRef.current?.peers);
                if (stopped) return;
                setDiscovered(prev => [...prev.filter(d => d.name !== entry.name), entry]);
            },
            (service) => { if (service?.name) setDiscovered(prev => prev.filter(d => d.name !== service.name)); }
        );
        return () => { stopped = true; unsubscribe(); setDiscovered([]); };
    }, [mode, discoveryActive]);

    const client = useCallback(() => {
        const rec = recordRef.current;
        return createSyncClient({ transport: Platform.sync.request, identity: { deviceId: rec.deviceId, name: rec.deviceName || 'Android phone' } });
    }, []);

    // ---- phone: pairing (both users confirm; nothing is stored before both did) ----------------

    const pairWith = useCallback(async ({ host, port }) => {
        if (mode !== 'client' || !recordRef.current) return;
        pairingCancelRef.current = false;
        pairingConfirmedRef.current = false;
        setPairing({ status: 'connecting', host, port });
        try {
            const result = await client().pair({
                host, port,
                onCode: ({ code, serverName, fingerprint }) => setPairing({ status: 'compare', code, serverName, fingerprint, host, port, confirmed: false }),
                isCancelled: () => pairingCancelRef.current,
                clientConfirmed: () => pairingConfirmedRef.current
            });
            await Platform.sync.setSecret(secretKey(result.deviceId), JSON.stringify({ ltk: result.ltk, tx: 0, rx: 0 }));
            const rec = recordRef.current;
            const peer = { deviceId: result.deviceId, name: result.name, fingerprint: result.fingerprint, host, port, pairedAt: Date.now(), lastSyncAt: null, seenRev: 0, pushedRev: 0, unverifiedStreak: 0 };
            saveRecord({ ...rec, peers: [...rec.peers.filter(p => p.deviceId !== peer.deviceId), peer] });
            setPairing({ status: 'done', serverName: result.name });
        } catch (e) {
            setPairing(pairingCancelRef.current ? null : { status: 'error', error: errorMessage(e), host, port });
        }
    }, [mode, client, saveRecord]);

    /** The phone user saw the same code on the computer. */
    const confirmPairingCode = useCallback(() => {
        pairingConfirmedRef.current = true;
        setPairing(p => (p && p.status === 'compare' ? { ...p, confirmed: true } : p));
    }, []);

    const cancelPairing = useCallback(() => { pairingCancelRef.current = true; setPairing(null); }, []);

    // ---- phone: sync -----------------------------------------------------------------------------

    const readSecret = useCallback(async (peer) => {
        let text;
        try {
            text = await Platform.sync.getSecret(secretKey(peer.deviceId));
        } catch (e) {
            throw codedError('transient', errorMessage(e));
        }
        const secret = parseSecret(text);
        if (!secret) throw codedError('missing_key', 'The pairing key is missing');
        return secret;
    }, []);

    const writeSecret = useCallback((peer, secret) => Platform.sync.setSecret(secretKey(peer.deviceId), JSON.stringify(secret)), []);

    const syncNow = useCallback(async (deviceId = null, endpoint = null) => {
        const rec = recordRef.current;
        if (mode !== 'client' || !rec || syncingRef.current) return null;
        const peer = deviceId ? rec.peers.find(p => p.deviceId === deviceId) : rec.peers[0];
        if (!peer) { setLastResult({ at: Date.now(), error: 'No paired desktop. Pair one first.' }); return null; }
        syncingRef.current = true;
        setSyncing(true);
        let result;
        try {
            const secret = await readSecret(peer);
            const endpoints = chooseEndpoints(peer, discoveredRef.current, endpoint);
            if (endpoints.length === 0) throw codedError('network', 'No address known for this desktop');
            const failures = [];
            for (const ep of endpoints) {
                try {
                    const out = await withStore(rec.deviceId, async (store, local) => {
                        const req = clientRequest({ store, local, peer });
                        const seq = secret.tx + 1;
                        await writeSecret(peer, { ...secret, tx: seq });   // persisted before the frame leaves
                        secret.tx = seq;
                        const reply = await client().exchange({ host: ep.host, port: ep.port, peer: { deviceId: peer.deviceId, ltk: secret.ltk }, seq, afterSeq: secret.rx, payload: req.request });
                        await writeSecret(peer, { ...secret, rx: reply.seq });   // recorded only after the reply authenticated
                        secret.rx = reply.seq;
                        const res = clientReceive({ store: req.store, local, peer, response: reply.payload });
                        const sent = Object.values(req.request.delta).reduce((n, m) => n + Object.keys(m).length, 0);
                        const peers = recordRef.current.peers.map(p => p.deviceId === peer.deviceId ? { ...p, ...res.peer, host: ep.host, port: ep.port, lastSyncAt: Date.now(), unverifiedStreak: 0 } : p);
                        return { ...res, report: { ...res.report, sent }, recordPatch: { peers } };
                    });
                    result = { at: Date.now(), peerName: peer.name, text: describeReport(out.report) };
                    break;
                } catch (e) {
                    failures.push({ error: e, endpoint: ep });
                    if (!shouldTryNext(e)) break;
                }
            }
            if (!result) {
                // Report the known address's failure when there was one; otherwise the impostor.
                const known = failures.find(f => f.endpoint.source === 'last' || (f.endpoint.host === peer.host && f.endpoint.port === peer.port)) || failures[failures.length - 1];
                // Replies from the known address that keep failing verification point at a
                // desktop whose counters or key went backwards (restored backup): after a few in
                // a row the message says so instead of "could not be verified" forever.
                const streak = unverifiedStreak(peer, known.error, known.endpoint);
                const stale = { ...peer, unverifiedStreak: streak };
                const rec2 = recordRef.current;
                if (rec2 && streak !== (peer.unverifiedStreak || 0)) saveRecord({ ...rec2, peers: rec2.peers.map(p => (p.deviceId === peer.deviceId ? { ...p, unverifiedStreak: streak } : p)) });
                result = { at: Date.now(), peerName: peer.name, error: describeSyncFailure({ error: known.error, endpoint: known.endpoint, peer: stale }) };
            }
        } catch (e) {
            result = { at: Date.now(), peerName: peer.name, error: describeSyncFailure({ error: e, endpoint: null, peer }) };
        } finally {
            syncingRef.current = false;
            setSyncing(false);
        }
        setLastResult(result);
        return result;
    }, [mode, withStore, client, readSecret, writeSecret]);

    const unpair = useCallback(async (deviceId) => {
        if (mode === 'host') { await hostCall(h => h.unpair(deviceId)); return; }
        const rec = recordRef.current;
        if (!rec) return;
        const peer = rec.peers.find(p => p.deviceId === deviceId);
        // Best effort: tell the desktop (authenticated frame) so it forgets this phone too.
        // Without it the revocation is one-sided until the desktop user unpairs there.
        if (peer) {
            try {
                const secret = await readSecret(peer);
                const ep = chooseEndpoints(peer, discoveredRef.current)[0];
                if (ep) {
                    const seq = secret.tx + 1;
                    await writeSecret(peer, { ...secret, tx: seq });
                    await client().unpair({ host: ep.host, port: ep.port, peer: { deviceId: peer.deviceId, ltk: secret.ltk }, seq });
                }
            } catch (e) {
                console.warn('sync: could not notify the desktop of the unpair', e);
            }
        }
        await Platform.sync.deleteSecret(secretKey(deviceId)).catch(() => {});
        saveRecord({ ...rec, peers: rec.peers.filter(p => p.deviceId !== deviceId) });
    }, [mode, hostCall, saveRecord, readSecret, writeSecret, client]);

    const setAutoSync = useCallback((enabled) => {
        const rec = recordRef.current;
        if (rec) saveRecord({ ...rec, autoSync: !!enabled });
    }, [saveRecord]);

    // Auto-sync: when the app comes to the foreground (and once after launch), look for the
    // paired desktop for a while and sync once if it shows up.
    const syncNowRef = useRef(syncNow);
    syncNowRef.current = syncNow;
    const autoSyncArmedRef = useRef(false);
    const [foregroundTick, setForegroundTick] = useState(0);
    useEffect(() => {
        if (mode !== 'client') return undefined;
        setForegroundTick(t => t + 1);
        return Platform.sync.onForeground(() => setForegroundTick(t => t + 1));
    }, [mode]);
    useEffect(() => {
        if (mode !== 'client' || !record?.autoSync || record.peers.length === 0 || foregroundTick === 0) return undefined;
        if (Date.now() - lastAutoSyncRef.current < AUTO_SYNC_MIN_INTERVAL_MS) return undefined;
        autoSyncArmedRef.current = true;
        const release = acquireDiscovery();
        const timer = setTimeout(() => { autoSyncArmedRef.current = false; release(); }, AUTO_SYNC_DISCOVERY_MS);
        return () => { clearTimeout(timer); autoSyncArmedRef.current = false; release(); };
    }, [mode, record?.autoSync, record?.peers?.length, foregroundTick, acquireDiscovery]);
    useEffect(() => {
        if (!autoSyncArmedRef.current || !record) return;
        if (!callbacks.current.isReady() || !songs || songs.length === 0) return;
        const found = discovered.find(d => d.peerId && record.peers.some(p => p.deviceId === d.peerId));
        if (!found) return;
        autoSyncArmedRef.current = false;
        lastAutoSyncRef.current = Date.now();
        syncNowRef.current(found.peerId, { host: found.host, port: found.port });
    }, [discovered, record, songs]);

    // Walks the whole synced state: only when the store or the library changed, never per render.
    const unmatched = useMemo(
        () => (storeRef.current ? countUnmatched(storeRef.current, songs) : 0),
        [storeTick, songs] // eslint-disable-line react-hooks/exhaustive-deps
    );

    return {
        mode,
        loaded: !!record,
        deviceId: mode === 'host' ? hostStatus?.deviceId || null : record?.deviceId || null,
        deviceName: mode === 'host' ? hostStatus?.name || null : record?.deviceName || null,
        // desktop
        hostStatus, setHostingEnabled, setDeviceName, openPairing, closePairing, confirmPairing,
        // phone
        peers: mode === 'host' ? hostStatus?.peers || [] : record?.peers || [],
        discovered, discovering: discoveryActive, acquireDiscovery,
        pairing, pairWith, confirmPairingCode, cancelPairing, syncNow, syncing,
        autoSync: !!record?.autoSync, setAutoSync,
        // both
        unpair, lastResult, unmatched
    };
}
