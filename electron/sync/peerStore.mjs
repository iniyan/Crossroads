// Desktop-side persistence for LAN sync (#25): the desktop's identity, the user-visible device
// name, the "hosting enabled" flag and, per paired device, the long-term key plus the frame
// counters (txSeq: last counter we sent it, rxSeq: last counter accepted from it). Kept out of
// electron-store (which the renderer can read through the store bridge) in its own JSON file
// created with mode 0600, written atomically (temp file + rename). Keys never reach the
// renderer. Every write surfaces its error to the caller: a pairing or a counter update that
// could not be persisted must not be treated as done.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cleanDisplayName } from '../../src/sync/names.mjs';

export const PEERS_FILE = 'sync-peers.json';
export const DEFAULT_DEVICE_NAME = 'Crossroads';

const MAX_PEERS = 32;
const MAX_NAME_LENGTH = 48;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && !RESERVED.has(v);
const seqOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** The desktop's own name (mDNS instance name, shown on phones): printable, one line, <= 48 chars. */
export const cleanDeviceName = (v) => cleanDisplayName(v, MAX_NAME_LENGTH);

const normalizeRecord = (r) => ({
    name: cleanDisplayName(r.name) || 'Unnamed device',
    key: r.key,
    pairedAt: r.pairedAt || null,
    lastSyncAt: r.lastSyncAt || null,
    txSeq: seqOf(r.txSeq),
    rxSeq: seqOf(r.rxSeq)
});

const normalize = (data) => {
    const d = data && typeof data === 'object' ? data : {};
    const peers = new Map();
    if (d.peers && typeof d.peers === 'object') {
        for (const [id, r] of Object.entries(d.peers)) {
            if (isId(id) && r && typeof r === 'object' && typeof r.key === 'string') peers.set(id, normalizeRecord(r));
        }
    }
    return {
        deviceId: typeof d.deviceId === 'string' && d.deviceId ? d.deviceId : null,
        deviceName: cleanDeviceName(d.deviceName) || null,
        enabled: d.enabled === true,
        peers
    };
};

/**
 * @param {string} dir       directory of the file (Electron userData)
 * @param {() => string} newId   mints a device id when the file has none
 * @param {string} [defaultName]
 */
export const createFilePeerStore = async ({ dir, newId, defaultName = DEFAULT_DEVICE_NAME }) => {
    const file = path.join(dir, PEERS_FILE);
    let data;
    try {
        data = normalize(JSON.parse(await fsp.readFile(file, 'utf8')));
    } catch (e) {
        if (e && e.code !== 'ENOENT') console.warn('sync: peers file unreadable, starting fresh', e.message);
        data = normalize(null);
    }
    let dirty = false;
    if (!data.deviceId) { data.deviceId = newId(); dirty = true; }
    if (!data.deviceName) { data.deviceName = cleanDeviceName(defaultName) || DEFAULT_DEVICE_NAME; dirty = true; }

    // Writes are serialised; each caller gets a promise that rejects with its own failure.
    let writing = Promise.resolve();
    const save = () => {
        const run = writing.then(async () => {
            await fsp.mkdir(dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            const json = JSON.stringify({ ...data, peers: Object.fromEntries(data.peers) }, null, 2);
            await fsp.writeFile(tmp, json, { mode: 0o600 });
            await fsp.rename(tmp, file);
            try { await fsp.chmod(file, 0o600); } catch { /* not supported (Windows) */ }
        });
        writing = run.catch(() => {});
        return run;
    };
    if (dirty) await save();
    // Tighten the mode of a file created by an earlier build, if any.
    try { if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch { /* missing */ }

    return {
        get identity() { return { deviceId: data.deviceId, name: data.deviceName }; },
        get enabled() { return data.enabled; },
        async setEnabled(enabled) { data.enabled = !!enabled; await save(); },
        async setDeviceName(name) {
            const clean = cleanDeviceName(name);
            if (!clean) throw new Error('The device name cannot be empty');
            data.deviceName = clean;
            await save();
        },
        async list() { return [...data.peers.entries()].map(([deviceId, r]) => ({ deviceId, ...r })); },
        async get(deviceId) { return data.peers.get(deviceId) || null; },
        async put(deviceId, record) {
            if (!isId(deviceId)) throw new Error('Invalid device id');
            if (!data.peers.has(deviceId) && data.peers.size >= MAX_PEERS) throw new Error('Too many paired devices');
            data.peers.set(deviceId, normalizeRecord(record));
            await save();
        },
        async remove(deviceId) { if (data.peers.delete(deviceId)) await save(); },
        async touch(deviceId, patch) {
            const r = data.peers.get(deviceId);
            if (!r) return;
            data.peers.set(deviceId, normalizeRecord({ ...r, ...patch }));
            await save();
        },
        get file() { return file; }
    };
};
