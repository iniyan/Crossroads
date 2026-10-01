// Wires the LAN sync server (server.mjs) into the Electron app (#25). The main process owns
// the HTTP server, the mDNS advertisement, the pairing state and the peer keys; the renderer
// owns the data. An incoming /v1/sync request is forwarded to the renderer ('sync:exchange'),
// which merges it (src/sync/model.js) and answers via 'sync:exchangeResult'.
//
// CommonJS shim around ESM modules: server.mjs shares src/sync/crypto.mjs with the renderer,
// so it is loaded with a dynamic import.

const os = require('os');
const { webcrypto } = require('node:crypto');

const EXCHANGE_REPLY_TIMEOUT_MS = 25 * 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

function lanAddresses() {
    const out = [];
    for (const [, infos] of Object.entries(os.networkInterfaces())) {
        for (const info of infos || []) {
            if (info.internal || info.family !== 'IPv4') continue;
            out.push(info.address);
        }
    }
    return out;
}

/**
 * @param {Object} deps
 * @param {import('electron').App} deps.app
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {() => import('electron').BrowserWindow | null} deps.getWindow
 * @param {(channel: string, ...args: any[]) => void} deps.sendToRenderer
 * @returns {{ shutdown: () => Promise<void> }}
 */
function registerSyncIpc({ app, ipcMain, getWindow, sendToRenderer }) {
    const pending = new Map();   // exchange id -> { resolve, reject, timer }
    let loaded = null;           // Promise<{ server, peers, advertiser }>
    let lastError = null;

    const onExchange = (peerId, payload) => new Promise((resolve, reject) => {
        if (!getWindow()) { reject(new Error('The app window is closed')); return; }
        const id = webcrypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The app did not answer in time')); }, EXCHANGE_REPLY_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        sendToRenderer('sync:exchange', { id, peerId, payload });
    });

    const load = () => {
        if (!loaded) {
            loaded = (async () => {
                const [{ createSyncServer }, { createFilePeerStore }, { createAdvertiser }, C] = await Promise.all([
                    import('./server.mjs'), import('./peerStore.mjs'), import('./advertise.mjs'), import('../../src/sync/crypto.mjs')
                ]);
                const peers = await createFilePeerStore({ dir: app.getPath('userData'), newId: () => webcrypto.randomUUID() });
                // Live view: the user may rename the device while the server runs.
                const identity = { get deviceId() { return peers.identity.deviceId; }, get name() { return peers.identity.name; } };
                const server = createSyncServer({ identity, peers, webcrypto, onExchange });
                const advertiser = createAdvertiser();
                const ctx = { server, peers, advertiser, crypto: C };
                server.on('status', () => pushStatus(ctx));
                server.on('paired', () => pushStatus(ctx));
                server.on('unpaired', () => pushStatus(ctx));
                server.on('synced', () => pushStatus(ctx));
                return ctx;
            })();
            loaded.catch((e) => { console.error('sync: failed to load', e); lastError = e.message; loaded = null; });
        }
        return loaded;
    };

    const status = async (ctx) => ({
        ...ctx.server.getStatus(),
        enabled: ctx.peers.enabled,
        addresses: ctx.server.running ? lanAddresses() : [],
        peers: await ctx.server.listPeers(),
        error: lastError
    });

    const pushStatus = (ctx) => { status(ctx).then((s) => sendToRenderer('sync:status', s)).catch(() => {}); };

    // Advertises under the user's device name with a salted, per-start discovery tag (no id).
    const advertise = async (ctx) => {
        const { deviceId, name } = ctx.peers.identity;
        const salt = ctx.crypto.toHex(ctx.crypto.randomBytes(8));
        const tag = await ctx.crypto.discoveryTag(deviceId, salt);
        try {
            await ctx.advertiser.publish({ name, port: ctx.server.port, salt, tag });
            lastError = null;
        } catch (e) {
            console.error('sync: mDNS advertisement failed; manual IP entry still works', e);
            lastError = `Discovery advertisement failed: ${e.message}`;
        }
    };

    const startHosting = async (ctx) => {
        if (ctx.server.running) return;
        await ctx.server.start({ port: 0 });
        await advertise(ctx);
        console.log(`Sync server listening on port ${ctx.server.port}`);
    };

    const stopHosting = async (ctx) => {
        ctx.server.closePairing();
        await ctx.advertiser.stop();
        await ctx.server.stop();
        for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Sync stopped')); pending.delete(id); }
    };

    // Resume hosting at launch when it was enabled last time.
    load().then(async (ctx) => { if (ctx.peers.enabled) await startHosting(ctx); pushStatus(ctx); }).catch(() => {});

    const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
        const ctx = await load();
        try {
            await fn(ctx, ...args);
            lastError = null;
        } catch (e) {
            console.error(`sync: ${channel} failed`, e);
            lastError = e.message;
        }
        return status(ctx);
    });

    handle('sync:getStatus', async () => {});
    handle('sync:setEnabled', async (ctx, enabled) => {
        if (typeof enabled !== 'boolean') return;
        await ctx.peers.setEnabled(enabled);
        if (enabled) await startHosting(ctx);
        else await stopHosting(ctx);
    });
    handle('sync:setDeviceName', async (ctx, name) => {
        if (typeof name !== 'string') return;
        await ctx.peers.setDeviceName(name);
        if (ctx.server.running) await advertise(ctx);
    });
    handle('sync:openPairing', async (ctx) => { if (ctx.server.running) ctx.server.openPairing(); });
    handle('sync:closePairing', async (ctx) => ctx.server.closePairing());
    handle('sync:confirmPairing', async (ctx, sessionId, accept) => {
        if (typeof sessionId !== 'string' || typeof accept !== 'boolean') return;
        ctx.server.confirmPairing(sessionId, accept);
    });
    handle('sync:unpair', async (ctx, deviceId) => { if (typeof deviceId === 'string') await ctx.server.unpair(deviceId); });

    ipcMain.handle('sync:exchangeResult', (_event, id, result) => {
        if (typeof id !== 'string') return;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        if (result && result.ok && result.response && typeof result.response === 'object') {
            p.resolve(result.response);
        } else {
            const error = new Error(typeof result?.error === 'string' ? result.error : 'Exchange failed in the app');
            if (result && typeof result.code === 'string') error.code = result.code;
            p.reject(error);
        }
    });

    return {
        /** Withdraws the mDNS record and closes the server; never takes longer than SHUTDOWN_TIMEOUT_MS. */
        shutdown: async () => {
            if (!loaded) return;
            const work = loaded.then((ctx) => stopHosting(ctx));
            const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.());
            try { await Promise.race([work, timeout]); } catch { /* best effort */ }
        }
    };
}

module.exports = { registerSyncIpc, lanAddresses };
