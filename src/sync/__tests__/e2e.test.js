// End-to-end: the desktop sync server running headless in Node, a simulated phone client
// doing discovery-bypass (direct host:port) + two-sided pairing + sync rounds with conflicting
// edits, and every server-side hardening item from the reviews (session swap, replay after
// restart, browser requests, decompression bombs, limits, persistence failures, unpair).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import {
    CONFIRM_GRACE_MS, MAX_PAIRING_ATTEMPTS, PAIRING_WINDOW_MS, RATE_LIMIT_PER_MINUTE, START_HOLD_MS, createMemoryPeerStore, createSyncServer, isIpLiteralHost, isPrivateAddress
} from '../../../electron/sync/server.mjs';
import { createSyncClient } from '../client.js';
import { LIMITS, clientReceive, clientRequest, createStore, exportState, serverExchange } from '../model.js';
import * as C from '../crypto.mjs';

// Plain node:http, not fetch: undici's fetch adds "sec-fetch-mode: cors" to every request,
// which the server (rightly) treats as a browser and refuses. The Android client (a raw
// socket) sends exactly what this does.
const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }, agent: false }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});
const fetchTransport = ({ url, method, body }) => request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body });
const rawPost = (url, body, headers = { 'Content-Type': 'application/json' }) => request(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const key = (n) => `meta:artist|album||${n}|track ${n}`;
const path = (device, n) => `/${device}/track${n}.flac`;
const library = (device) => Array.from({ length: 10 }, (_, i) => ({ path: path(device, i + 1), trackKey: key(i + 1) }));

// A desktop app: store + app state, merging every incoming request.
const makeDesktop = () => {
    const desktop = { store: createStore('desk-1'), local: { songs: library('d'), favorites: [], playlists: [], stats: { playHistory: [] } } };
    desktop.onExchange = async (peerId, payload) => {
        const out = serverExchange({ store: desktop.store, local: desktop.local, request: payload, now: desktop.now() });
        desktop.store = out.store;
        desktop.local = { ...desktop.local, favorites: out.favorites, playlists: out.playlists, stats: out.stats };
        desktop.lastReport = out.report;
        return out.response;
    };
    desktop.now = () => Date.now();
    return desktop;
};

// A phone app with its per-desktop counters.
const makePhone = (client, ltk) => {
    const phone = {
        store: createStore('phone-1'),
        local: { songs: library('p'), favorites: [], playlists: [], stats: { playHistory: [] } },
        peer: { deviceId: 'desk-1', ltk, seenRev: 0, pushedRev: 0, tx: 0, rx: 0 }
    };
    phone.exchange = async (host, port, payload) => {
        const seq = ++phone.peer.tx;
        const reply = await client.exchange({ host, port, peer: phone.peer, seq, afterSeq: phone.peer.rx, payload });
        phone.peer.rx = reply.seq;
        return reply.payload;
    };
    phone.sync = async (host, port) => {
        const req = clientRequest({ store: phone.store, local: phone.local, peer: phone.peer, now: Date.now() });
        phone.store = req.store;
        const response = await phone.exchange(host, port, req.request);
        const out = clientReceive({ store: phone.store, local: phone.local, peer: phone.peer, response, now: Date.now() });
        phone.store = out.store;
        phone.peer = { ...phone.peer, ...out.peer };
        phone.local = { ...phone.local, favorites: out.favorites, playlists: out.playlists, stats: out.stats };
        phone.lastReport = out.report;
        return { sent: req.request, received: response };
    };
    return phone;
};

const sortKeys = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v));
const tick = () => new Promise(r => setTimeout(r, 5));
// A phone polls once a second: advancing the simulated clock per poll keeps the per-minute
// limiter honest however fast the test machine runs the loop.
let pollClock = null;
const pollSleep = async () => { if (pollClock) pollClock(); await tick(); };
const until = async (cond) => { for (let i = 0; i < 2000 && !cond(); i++) await tick(); expect(cond()).toBe(true); };

describe('addresses', () => {
    it('accepts loopback and private remote addresses only', () => {
        for (const ip of ['127.0.0.1', '10.0.2.2', '172.16.0.1', '172.31.255.255', '192.168.0.107', '169.254.1.1', '::1', 'fe80::1', 'fe80::1%en0', 'fd12::1', 'fc00::1', '::ffff:192.168.1.1', '::ffff:127.0.0.1']) {
            expect(isPrivateAddress(ip), ip).toBe(true);
        }
        for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.64.0.1', '192.169.0.1', '2001:db8::1', '::ffff:8.8.8.8', '', null, 'localhost', '256.1.1.1']) {
            expect(isPrivateAddress(ip), String(ip)).toBe(false);
        }
    });

    it('accepts only IP-literal Host headers', () => {
        for (const h of ['127.0.0.1:5000', '192.168.1.2', '[fd00::5]:9000', '[::1]:80', '10.0.2.2:65535']) expect(isIpLiteralHost(h), h).toBe(true);
        for (const h of ['desktop.local:5000', 'localhost:5000', 'crossroads:1', 'fd00::5:9000', '127.0.0.1:0', '127.0.0.1:70000', '', undefined, '1.2.3:5', 'evil.example']) expect(isIpLiteralHost(h), String(h)).toBe(false);
    });
});

describe('desktop <-> phone over HTTP', () => {
    let server;
    let peers;
    let desktop;
    let port;
    let base;
    let clock;
    const now = () => clock;

    beforeEach(async () => {
        clock = Date.now();
        pollClock = () => { clock += 1000; };
        peers = createMemoryPeerStore();
        desktop = makeDesktop();
        desktop.now = now;
        server = createSyncServer({ identity: { deviceId: 'desk-1', name: 'Studio Mac' }, peers, webcrypto, onExchange: desktop.onExchange, now, log: { warn() {}, error() {} } });
        ({ port } = await server.start({ host: '127.0.0.1' }));
        base = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => { await server.stop(); });

    const newClient = (id = 'phone-1', name = 'Pixel', extra = {}) => createSyncClient({ transport: fetchTransport, identity: { deviceId: id, name }, webcrypto, now, sleep: () => Promise.resolve(), ...extra });

    // Drives both sides of pairing: the desktop confirms when it sees the code, the phone user
    // confirms right after the code appears (unless told otherwise).
    const pairPhone = async (client, { accept = true, phoneConfirms = true, codeSeenOnDesktop } = {}) => {
        let desktopCode = null;
        let phoneConfirmed = false;
        const unsubscribe = server.on('status', (status) => {
            const session = status.pairing?.session;
            if (session && session.status === 'compare' && desktopCode === null) {
                desktopCode = session.code;
                codeSeenOnDesktop?.(session);
                server.confirmPairing(session.id, accept);
            }
        });
        try {
            let phoneCode = null;
            const result = await client.pair({
                host: '127.0.0.1', port,
                onCode: ({ code }) => { phoneCode = code; if (phoneConfirms) phoneConfirmed = true; },
                clientConfirmed: () => phoneConfirmed
            });
            return { result, phoneCode, desktopCode };
        } finally {
            unsubscribe();
        }
    };

    const startRaw = async (clientId, extra = {}) => rawPost(`${base}/v1/pair/start`, { clientId, clientName: 'x', clientPub: C.b64encode((await C.generateKeyPair()).publicKey), commit: C.b64encode(new Uint8Array(32)), ...extra });

    it('pairs with both users confirming, shows the same code and fingerprint, stores a working key only at the end', async () => {
        server.openPairing();
        expect(server.getStatus().pairing.open).toBe(true);
        const client = newClient();
        let seen = null;
        const { result, phoneCode, desktopCode } = await pairPhone(client, { codeSeenOnDesktop: (s) => { seen = s; } });
        expect(phoneCode).toMatch(/^\d{6}$/);
        expect(desktopCode).toBe(phoneCode);
        expect(seen.clientName).toBe('Pixel');
        expect(seen.fingerprint).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
        expect(result.deviceId).toBe('desk-1');
        expect(result.name).toBe('Studio Mac');
        expect(result.fingerprint).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
        const stored = await peers.get('phone-1');
        expect(stored).toMatchObject({ name: 'Pixel', key: result.ltk, txSeq: 0, rxSeq: 0 });
        // pairing window closes after success
        expect(server.getStatus().pairing).toBeNull();
        // the key works for an exchange and counters advance on both sides
        const phone = makePhone(client, result.ltk);
        await phone.sync('127.0.0.1', port);
        expect((await peers.get('phone-1'))).toMatchObject({ lastSyncAt: clock, rxSeq: 1, txSeq: 1 });
        expect(phone.peer).toMatchObject({ tx: 1, rx: 1 });
    });

    it('stores nothing until the phone user confirmed too (D1)', async () => {
        server.openPairing();
        let phoneConfirmed = false;
        let sessionId = null;
        const unsub = server.on('status', (st) => { const s = st.pairing?.session; if (s?.status === 'compare' && !sessionId) { sessionId = s.id; server.confirmPairing(s.id, true); } });
        const client = createSyncClient({ transport: fetchTransport, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: pollSleep });
        const pairing = client.pair({ host: '127.0.0.1', port, clientConfirmed: () => phoneConfirmed });
        await until(() => server.getStatus().pairing?.session?.status === 'confirmed');
        await tick(); await tick();
        // desktop confirmed, phone has not: nothing stored, session waits
        expect(await peers.get('phone-1')).toBeNull();
        expect(server.getStatus().pairing.session.status).toBe('confirmed');
        phoneConfirmed = true;
        await pairing;
        unsub();
        expect(await peers.get('phone-1')).not.toBeNull();
    });

    it('refuses pairing while the window is closed, after rejection, and locks after the attempt limit while the last attempt still completes (fix 7)', async () => {
        const client = newClient();
        await expect(client.pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'closed' });

        server.openPairing();
        await expect(pairPhone(client, { accept: false })).rejects.toMatchObject({ code: 'rejected' });
        expect(server.getStatus().pairing).toMatchObject({ open: false, locked: true, lockReason: 'rejected' });
        await expect(client.pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'closed' });
        expect(await peers.get('phone-1')).toBeNull();
        // the locked window stays on screen until the user dismisses it (no silent reopen)
        expect(server.getStatus().pairing.session.status).toBe('rejected');
        server.closePairing();
        expect(server.getStatus().pairing).toBeNull();

        server.openPairing();
        // a started session is held for START_HOLD_MS before another start may replace it
        for (let i = 0; i < MAX_PAIRING_ATTEMPTS - 1; i++) { clock += START_HOLD_MS; expect((await startRaw(`p${i}`)).status).toBe(200); }
        expect(server.getStatus().pairing).toMatchObject({ open: true, locked: false, attemptsLeft: 1 });
        // the fifth attempt is a real phone: it may still complete although the window locks
        clock += START_HOLD_MS;
        const last = newClient('phone-5', 'Fifth');
        const { result } = await pairPhone(last);
        expect(result.deviceId).toBe('desk-1');
        expect(await peers.get('phone-5')).not.toBeNull();
        // and a new window after the limit: the sixth start is refused as locked
        server.openPairing();
        for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) { clock += START_HOLD_MS; expect((await startRaw(`q${i}`)).status).toBe(200); }
        expect(server.getStatus().pairing).toMatchObject({ open: false, locked: true, lockReason: 'attempts', attemptsLeft: 0 });
        clock += START_HOLD_MS;
        await expect(newClient('phone-6').pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'locked' });
    });

    it('holds a started session for START_HOLD_MS: a second start is busy until then, and the hold does not burn attempts (C3)', async () => {
        server.openPairing();
        expect((await startRaw('first')).status).toBe(200);
        const first = server.getStatus().pairing.session;
        expect(first.status).toBe('started');
        clock += START_HOLD_MS - 1;
        const early = await startRaw('second');
        expect(early.status).toBe(409);
        expect(JSON.parse(early.body)).toEqual({ error: 'busy' });
        expect(server.getStatus().pairing.session.id).toBe(first.id);
        expect(server.getStatus().pairing.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - 1);
        await expect(newClient('phone-2').pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'busy' });
        clock += 1;
        expect((await startRaw('second')).status).toBe(200);
        expect(server.getStatus().pairing.session).toMatchObject({ clientId: 'second', status: 'started' });
        expect(server.getStatus().pairing.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS - 2);
    });

    it('expires the window after two minutes but lets a confirmed session finish within the grace period (fix 24)', async () => {
        server.openPairing();
        clock += PAIRING_WINDOW_MS + 1;
        await expect(newClient().pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'closed' });
        expect(server.getStatus().pairing).toMatchObject({ open: false, locked: true, lockReason: 'expired' });

        // confirmation one second before the window ends, finish 20 s after it: still fine
        server.openPairing();
        let phoneConfirmed = false;
        const unsub = server.on('status', (st) => { const s = st.pairing?.session; if (s?.status === 'compare') server.confirmPairing(s.id, true); });
        const client = createSyncClient({ transport: fetchTransport, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: pollSleep });
        clock += PAIRING_WINDOW_MS - 1000;
        const pairing = client.pair({ host: '127.0.0.1', port, clientConfirmed: () => phoneConfirmed });
        await until(() => server.getStatus().pairing?.session?.status === 'confirmed');
        clock += 21_000;
        phoneConfirmed = true;
        await expect(pairing).resolves.toMatchObject({ deviceId: 'desk-1' });
        unsub();
        expect(await peers.get('phone-1')).not.toBeNull();

        // but not forever: past the grace the confirmed session expires
        await peers.remove('phone-1');
        server.openPairing();
        let confirmed2 = false;
        const unsub2 = server.on('status', (st) => { const s = st.pairing?.session; if (s?.status === 'compare') server.confirmPairing(s.id, true); });
        clock += PAIRING_WINDOW_MS - 1000;
        const late = client.pair({ host: '127.0.0.1', port, clientConfirmed: () => confirmed2 });
        late.catch(() => {});   // it rejects while this test is still waiting below; asserted afterwards
        await until(() => server.getStatus().pairing?.session?.status === 'confirmed');
        clock += CONFIRM_GRACE_MS + 1000;
        // the phone's next status poll makes the server notice the expiry; only then does the
        // phone user "confirm" (otherwise the poll that saw 'confirmed' races the clock bump)
        await until(() => server.getStatus().pairing?.session?.status === 'expired');
        confirmed2 = true;
        await expect(late).rejects.toMatchObject({ code: 'expired' });
        unsub2();
        expect(await peers.get('phone-1')).toBeNull();
    });

    it('answers a reveal that does not match the commitment with 403 and leaves the session untouched (C3, reviewer test 3)', async () => {
        server.openPairing();
        const pair = await C.generateKeyPair();
        const nonce = C.randomBytes(16);
        const start = await rawPost(`${base}/v1/pair/start`, { clientId: 'phone-1', clientName: 'Pixel', clientPub: C.b64encode(pair.publicKey), commit: C.b64encode(await C.commitment(nonce)) });
        const { sessionId } = JSON.parse(start.body);
        // a LAN observer who saw the plaintext session id guesses a nonce
        const bogus = await rawPost(`${base}/v1/pair/reveal`, { sessionId, clientNonce: C.b64encode(C.randomBytes(16)) });
        expect(bogus.status).toBe(403);
        expect(JSON.parse(bogus.body)).toEqual({ error: 'commitment' });
        expect(server.getStatus().pairing).toMatchObject({ open: true, locked: false, lockReason: null });
        expect(server.getStatus().pairing.session).toMatchObject({ id: sessionId, status: 'started', error: null, code: null });
        // the real phone's reveal still goes through
        const real = await rawPost(`${base}/v1/pair/reveal`, { sessionId, clientNonce: C.b64encode(nonce) });
        expect(real.status).toBe(200);
        expect(server.getStatus().pairing.session).toMatchObject({ status: 'compare' });
        expect(server.getStatus().pairing.session.code).toMatch(/^\d{6}$/);
        // a second reveal (either kind) is refused now, without changing anything
        expect((await rawPost(`${base}/v1/pair/reveal`, { sessionId, clientNonce: C.b64encode(nonce) })).status).toBe(403);
        expect(server.getStatus().pairing.session.status).toBe('compare');
        // finish before the desktop confirmed is refused, and nothing is stored
        const finish = await rawPost(`${base}/v1/pair/finish`, { sessionId, clientProof: C.b64encode(new Uint8Array(32)) });
        expect(finish.status).toBe(409);
        expect(await peers.list()).toEqual([]);
        expect((await startRaw('other')).status).toBe(409);
    });

    it('cannot have a started session killed by an observer revealing a wrong nonce (reviewer test 3, end to end)', async () => {
        server.openPairing();
        let bogus = null;
        const spy = async (req) => {
            const res = await fetchTransport(req);
            if (req.url.endsWith('/pair/start') && res.status === 200) {
                const sid = JSON.parse(res.body).sessionId;
                bogus = await rawPost(`${base}/v1/pair/reveal`, { sessionId: sid, clientNonce: C.b64encode(new Uint8Array(16)) });
            }
            return res;
        };
        const client = createSyncClient({ transport: spy, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: () => Promise.resolve() });
        const { result } = await pairPhone(client);
        expect(bogus.status).toBe(403);
        expect(result.deviceId).toBe('desk-1');
        expect(await peers.get('phone-1')).not.toBeNull();
        expect(server.getStatus().pairing).toBeNull();
    });

    it('answers a wrong client proof with 403 and lets the real phone finish (C3, reviewer test 2)', async () => {
        server.openPairing();
        let bogus = null;
        let sessionId = null;
        const spyTransport = async (req) => {
            if (req.url.endsWith('/v1/pair/finish')) {
                // an observer races the real finish with a guessed proof
                sessionId = JSON.parse(req.body).sessionId;
                bogus = await fetchTransport({ ...req, body: JSON.stringify({ sessionId, clientProof: C.b64encode(new Uint8Array(32)) }) });
                expect(server.getStatus().pairing.session).toMatchObject({ id: sessionId, status: 'confirmed', error: null });
                expect(server.getStatus().pairing.locked).toBe(false);
            }
            return fetchTransport(req);
        };
        const client = createSyncClient({ transport: spyTransport, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: () => Promise.resolve() });
        const { result } = await pairPhone(client);
        expect(bogus.status).toBe(403);
        expect(JSON.parse(bogus.body)).toEqual({ error: 'proof' });
        expect(result.deviceId).toBe('desk-1');
        expect(await peers.get('phone-1')).toMatchObject({ key: result.ltk });
        // a wrong proof on its own (the phone never had the key) stores nothing either
        server.openPairing();
        const bad = createSyncClient({
            transport: async (req) => (req.url.endsWith('/v1/pair/finish') ? fetchTransport({ ...req, body: JSON.stringify({ sessionId: JSON.parse(req.body).sessionId, clientProof: C.b64encode(new Uint8Array(32)) }) }) : fetchTransport(req)),
            identity: { deviceId: 'phone-2', name: 'Bad' }, webcrypto, now, sleep: () => Promise.resolve()
        });
        await expect(pairPhone(bad)).rejects.toMatchObject({ code: 'protocol' });
        expect(await peers.get('phone-2')).toBeNull();
        expect(server.getStatus().pairing).toMatchObject({ locked: false });
        expect(server.getStatus().pairing.session).toMatchObject({ clientId: 'phone-2', status: 'confirmed' });
    });

    it('cannot have a started session pre-empted by another start before the phone reveals (reviewer test 8)', async () => {
        server.openPairing();
        const kp = await C.generateKeyPair();
        let attacker = null;
        const spy = async (req) => {
            const res = await fetchTransport(req);
            if (req.url.endsWith('/pair/start') && res.status === 200) {
                attacker = await rawPost(`${base}/v1/pair/start`, { clientId: 'phone-evil', clientName: 'Pixel', clientPub: C.b64encode(kp.publicKey), commit: C.b64encode(new Uint8Array(32)) });
            }
            return res;
        };
        const client = createSyncClient({ transport: spy, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: () => Promise.resolve() });
        const { result } = await pairPhone(client);
        expect(attacker.status).toBe(409);
        expect(result.deviceId).toBe('desk-1');
        expect((await server.listPeers()).map(p => p.deviceId)).toEqual(['phone-1']);
    });

    it('cannot have its session swapped while the user compares codes (reviewer test B, D2)', async () => {
        server.openPairing();
        const legit = createSyncClient({ transport: fetchTransport, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: pollSleep });
        let legitConfirmed = false;
        let firstSession = null;
        const legitPairing = legit.pair({ host: '127.0.0.1', port, onCode: () => { firstSession = server.getStatus().pairing.session; }, clientConfirmed: () => legitConfirmed });
        await until(() => firstSession !== null);
        expect(firstSession.status).toBe('compare');
        // attacker: same display name, fresh keys, tries to replace the session on screen
        const attacker = createSyncClient({ transport: fetchTransport, identity: { deviceId: 'phone-evil', name: 'Pixel' }, webcrypto, now, sleep: pollSleep });
        await expect(attacker.pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'busy' });
        const shown = server.getStatus().pairing.session;
        expect(shown.id).toBe(firstSession.id);
        expect(shown.clientId).toBe('phone-1');
        // the desktop user clicks "Yes" on what is shown: still the legit phone
        server.confirmPairing(shown.id, true);
        // ...and even now (confirmed) nobody can take over the session
        await expect(attacker.pair({ host: '127.0.0.1', port })).rejects.toMatchObject({ code: 'busy' });
        legitConfirmed = true;
        await legitPairing;
        expect((await server.listPeers()).map(p => p.deviceId)).toEqual(['phone-1']);
    });

    it('survives a slow desktop user: 60 seconds of status polling is not rate limited (reviewer test A, fix 11)', async () => {
        server.openPairing();
        let polls = 0;
        const counting = async (req) => { if (req.url.includes('/pair/status')) polls++; return fetchTransport(req); };
        const client = createSyncClient({ transport: counting, identity: { deviceId: 'phone-1', name: 'Pixel' }, webcrypto, now, sleep: async () => { clock += 1000; await tick(); } });
        let code = null;
        const t0 = clock;
        const pairing = client.pair({ host: '127.0.0.1', port, onCode: (c) => { code = c.code; } });
        await until(() => code !== null);
        await until(() => clock - t0 >= 60_000);
        const s = server.getStatus().pairing.session;
        expect(s.status).toBe('compare');
        server.confirmPairing(s.id, true);
        await expect(pairing).resolves.toMatchObject({ deviceId: 'desk-1' });
        expect(polls).toBeGreaterThanOrEqual(60);
        // other requests from the same phone are still fine afterwards
        expect((await fetchTransport({ url: `${base}/v1/info`, method: 'GET' })).status).toBe(200);
    });

    it('syncs two rounds with conflicting edits until both sides converge', async () => {
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        const phone = makePhone(client, result.ltk);

        // Round 1: disjoint data on both sides.
        phone.local = { ...phone.local, favorites: [path('p', 1)], playlists: [{ id: 'pl-p', name: 'Phone mix', songs: [path('p', 2), path('p', 3)] }], stats: { playHistory: [{ path: path('p', 1), timestamp: 100, trackKey: key(1), listened: 40 }] } };
        desktop.local = { ...desktop.local, favorites: [path('d', 4)], playlists: [{ id: 'pl-d', name: 'Desk mix', songs: [path('d', 5)] }], stats: { playHistory: [{ path: path('d', 4), timestamp: 200, trackKey: key(4) }] } };
        const r1 = await phone.sync('127.0.0.1', port);
        expect(phone.local.favorites).toEqual([path('p', 1), path('p', 4)]);
        expect(desktop.local.favorites).toEqual([path('d', 4), path('d', 1)]);
        expect(phone.local.playlists.map(p => p.name).sort()).toEqual(['Desk mix', 'Phone mix']);
        expect(desktop.local.playlists.find(p => p.id === 'pl-p').songs).toEqual([path('d', 2), path('d', 3)]);
        expect(desktop.local.stats.playHistory).toEqual([
            { path: path('d', 1), timestamp: 100, trackKey: key(1), listened: 40 },
            { path: path('d', 4), timestamp: 200, trackKey: key(4) }
        ]);
        expect(phone.local.stats.playHistory.map(e => e.timestamp)).toEqual([100, 200]);
        expect(phone.lastReport).toMatchObject({ favoritesAdded: 1, playlistsCreated: 1, playsAdded: 1, unmatched: 0 });
        expect(desktop.lastReport).toMatchObject({ favoritesAdded: 1, playlistsCreated: 1, playsAdded: 1 });
        expect(sortKeys(exportState(phone.store))).toEqual(sortKeys(exportState(desktop.store)));

        // Round 2: conflicting edits. Phone renames the desk playlist first; the desktop
        // renames it later (so the desktop wins); the phone unfavorites 4 and the desktop
        // deletes the phone playlist.
        phone.local = { ...phone.local, favorites: [path('p', 1)], playlists: phone.local.playlists.map(p => p.id === 'pl-d' ? { ...p, name: 'Phone rename' } : p) };
        const phoneReq = clientRequest({ store: phone.store, local: phone.local, peer: phone.peer, now: clock });
        phone.store = phoneReq.store;
        clock += 1000;
        desktop.local = { ...desktop.local, playlists: desktop.local.playlists.filter(p => p.id !== 'pl-p').map(p => p.id === 'pl-d' ? { ...p, name: 'Desk rename' } : p) };
        const response = await phone.exchange('127.0.0.1', port, phoneReq.request);
        const out = clientReceive({ store: phone.store, local: phone.local, peer: phone.peer, response, now: clock });
        phone.store = out.store; phone.peer = { ...phone.peer, ...out.peer };
        phone.local = { ...phone.local, favorites: out.favorites, playlists: out.playlists, stats: out.stats };
        expect(phone.local.playlists).toEqual([{ id: 'pl-d', name: 'Desk rename', songs: [path('p', 5)] }]);
        expect(desktop.local.playlists).toEqual([{ id: 'pl-d', name: 'Desk rename', songs: [path('d', 5)] }]);
        expect(desktop.local.favorites).toEqual([path('d', 1)]);
        expect(sortKeys(exportState(phone.store))).toEqual(sortKeys(exportState(desktop.store)));
        // only deltas travelled in round 2
        expect(Object.keys(phoneReq.request.delta.history)).toEqual([]);
        expect(Object.keys(response.delta.history)).toEqual([]);
        expect(Object.keys(response.delta.playlists).sort()).toEqual(['pl-d', 'pl-p']);
        expect(r1.received.rev).toBeGreaterThan(0);

        // Round 3: nothing to do.
        const r3 = await phone.sync('127.0.0.1', port);
        expect(r3.sent.delta).toEqual({ favorites: {}, playlists: {}, history: {} });
        expect(r3.received.delta).toEqual({ favorites: {}, playlists: {}, history: {} });
        expect(phone.peer).toMatchObject({ tx: 3, rx: 3 });
    });

    it('rejects unpaired, tampered, replayed and misaddressed frames without a body; replays stay dead after a restart (reviewer test D, D3)', async () => {
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        const ltk = C.b64decode(result.ltk);
        const keys = await C.frameKeys(ltk);
        const post = async (frame, p = port) => rawPost(`http://127.0.0.1:${p}/v1/sync`, frame);
        const payload = { since: 0, delta: { favorites: {}, playlists: {}, history: {} } };
        const seal = (seq, extra = {}) => C.sealFrame({ key: keys.c2s, from: 'phone-1', to: 'desk-1', seq, payload, now: clock, ...extra });

        const good = await seal(1);
        const ok = await post(good);
        expect(ok.status).toBe(200);
        // replay
        const replay = await post(good);
        expect(replay.status).toBe(401);
        expect(replay.body).toBe('');
        // a stale counter is a replay too, a fresh one is fine
        expect((await post(await seal(1))).status).toBe(401);
        expect((await post(await seal(3))).status).toBe(200);
        expect((await post(await seal(2))).status).toBe(401);
        // forged frames do not advance the counter (fix 6): seq 1000 with a bad key, then a real 4
        const otherKeys = await C.frameKeys(C.randomBytes(32));
        expect((await post(await C.sealFrame({ key: otherKeys.c2s, from: 'phone-1', to: 'desk-1', seq: 1000, payload, now: clock }))).status).toBe(401);
        expect((await peers.get('phone-1')).rxSeq).toBe(3);
        expect((await post(await seal(4))).status).toBe(200);
        // tampered ciphertext
        const tampered = await seal(5);
        const ct = C.b64decode(tampered.ct); ct[3] ^= 0x10;
        expect((await post({ ...tampered, ct: C.b64encode(ct) })).status).toBe(401);
        // tampered header (timestamp and counter are authenticated)
        expect((await post({ ...tampered, ts: tampered.ts + 1 })).status).toBe(401);
        expect((await post({ ...tampered, seq: 6 })).status).toBe(401);
        // addressed to another desktop
        expect((await post(await C.sealFrame({ key: keys.c2s, from: 'phone-1', to: 'desk-2', seq: 5, payload, now: clock }))).status).toBe(401);
        // clock does not matter: a frame stamped a year ago with a fresh counter is accepted
        expect((await post(await seal(5, { now: clock - 365 * 86_400_000 }))).status).toBe(200);
        // unknown device / wrong key
        const unknown = await post(await C.sealFrame({ key: otherKeys.c2s, from: 'phone-9', to: 'desk-1', seq: 1, payload, now: clock }));
        expect(unknown.status).toBe(401);
        expect(unknown.body).toBe('');
        // garbage
        expect((await post({ hello: 'world' })).status).toBe(401);
        expect((await post({ ...good, from: '__proto__' })).status).toBe(401);
        expect((await rawPost(`${base}/v1/sync`, 'not json')).status).toBe(400);
        // the client surfaces 401 precisely, not as a generic failure
        await expect(client.exchange({ host: '127.0.0.1', port, peer: { deviceId: 'desk-1', ltk: C.b64encode(C.randomBytes(32)) }, seq: 9, payload })).rejects.toMatchObject({ code: 'unauthorized' });

        // restart: the persisted counter keeps every captured frame dead
        const captured = await seal(6);
        expect((await post(captured)).status).toBe(200);
        await server.stop();
        const again = await server.start({ host: '127.0.0.1' });
        expect((await post(captured, again.port)).status).toBe(401);
        expect((await post(good, again.port)).status).toBe(401);
        expect((await post(await seal(7), again.port)).status).toBe(200);

        // replies are bound to their request: a captured reply cannot answer a later request
        const phone = makePhone(client, result.ltk);
        phone.peer.tx = 7;
        phone.peer.rx = (await peers.get('phone-1')).txSeq;
        const replyA = JSON.parse((await post(await seal(8), again.port)).body);
        phone.peer.tx = 8;
        await expect(C.openFrame({ key: keys.s2c, frame: replyA, from: 'desk-1', to: 'phone-1', re: 'other-nonce', afterSeq: 0 })).rejects.toMatchObject({ code: 'binding' });

        // and after unpairing, the real key stops working
        await server.unpair('phone-1');
        expect((await post(await seal(9), again.port)).status).toBe(401);
    });

    it('refuses browser-originated requests before they count (reviewer tests C/C2, D4)', async () => {
        server.openPairing();
        const kp = await C.generateKeyPair();
        const body = { clientId: 'web', clientName: 'Pixel', clientPub: C.b64encode(kp.publicKey), commit: C.b64encode(new Uint8Array(32)) };
        const json = { 'Content-Type': 'application/json' };
        expect((await rawPost(`${base}/v1/pair/start`, body, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' })).status).toBe(403);
        expect((await rawPost(`${base}/v1/pair/start`, body, { ...json, Origin: 'https://evil.example' })).status).toBe(403);
        expect((await rawPost(`${base}/v1/pair/start`, body, { ...json, Origin: 'null' })).status).toBe(403);
        expect((await rawPost(`${base}/v1/pair/start`, body, { ...json, 'Sec-Fetch-Mode': 'cors' })).status).toBe(403);
        expect((await rawPost(`${base}/v1/pair/start`, body, { ...json, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
        expect((await rawPost(`${base}/v1/pair/start`, body, { 'Content-Type': 'text/plain' })).status).toBe(415);
        expect((await rawPost(`${base}/v1/pair/start`, body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
        expect((await rawPost(`${base}/v1/pair/start`, body, { ...json, Host: 'desktop.local' })).status).toBe(403);
        expect((await request(`${base}/v1/info`, { headers: { 'Sec-Fetch-Dest': 'empty' } })).status).toBe(403);
        // what undici's fetch sends by default is a browser-shaped request too
        expect((await fetch(`${base}/v1/info`)).status).toBe(403);
        // a web page cannot burn the attempts either
        for (let i = 0; i < MAX_PAIRING_ATTEMPTS + 1; i++) await rawPost(`${base}/v1/pair/start`, { ...body, clientId: `web${i}` }, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' });
        expect(server.getStatus().pairing).toMatchObject({ open: true, locked: false, attemptsLeft: MAX_PAIRING_ATTEMPTS });
        // a proper client is unaffected
        expect((await startRaw('phone-ok')).status).toBe(200);
    });

    it('refuses browser-shaped requests before they count against the per-IP budget (C4, reviewer test 7)', async () => {
        for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 5; i++) expect((await request(`${base}/v1/info`, { headers: { Origin: 'http://evil' } })).status).toBe(403);
        expect((await request(`${base}/v1/info`)).status).toBe(200);
        // and the opposite still holds: proper requests do get limited
        const statuses = [];
        for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 5; i++) statuses.push((await request(`${base}/v1/info`)).status);
        expect(statuses[statuses.length - 1]).toBe(429);
    });

    it('keeps no per-sender state for frames from unknown or malformed senders (C1, reviewer test 1)', async () => {
        const big = 'x'.repeat(1024 * 1024);
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 40; i++) expect((await rawPost(`${base}/v1/sync`, { from: big + i })).status).toBe(401);
        for (const bad of [{ from: 'nobody', to: 'desk-1', v: 2, seq: 1, ts: 1, n: 'x', re: '', z: 0, ct: 'x' }, { from: '__proto__' }, { from: 'a'.repeat(65) }, '"str"', 1, null, []]) {
            expect((await rawPost(`${base}/v1/unpair`, bad)).status).toBe(401);
            expect((await rawPost(`${base}/v1/sync`, bad)).status).toBe(401);
        }
        expect(server.stats()).toEqual({ queuedPeers: 0, cachedKeys: 0 });
        if (typeof global.gc === 'function') {
            global.gc();
            expect(process.memoryUsage().heapUsed - before).toBeLessThan(20 * 1024 * 1024);
        }
        // a paired sender's queue entry goes away once its frames drained
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        const phone = makePhone(client, result.ltk);
        await phone.sync('127.0.0.1', port);
        await phone.sync('127.0.0.1', port);
        // two frames in flight at once (seq 3 and 4): both are queued behind each other and
        // the entry still goes away afterwards, whatever order they arrived in
        const keys = await C.frameKeys(C.b64decode(result.ltk));
        const payload = { since: 0, delta: { favorites: {}, playlists: {}, history: {} } };
        const [a, b] = await Promise.all([3, 4].map(async (seq) => rawPost(`${base}/v1/sync`, await C.sealFrame({ key: keys.c2s, from: 'phone-1', to: 'desk-1', seq, payload, now: clock }))));
        expect([a.status, b.status].filter(s => s === 200).length).toBeGreaterThanOrEqual(1);
        await tick();
        expect(server.stats().queuedPeers).toBe(0);
        expect(server.stats().cachedKeys).toBe(1);
    });

    it('strips bidi, zero-width and control characters from phone names (C6, reviewer test 9)', async () => {
        server.openPairing();
        const hostile = 'Pixel‮​ 123\u0007 456⁦﻿؜᠎‏⁩  \t x';
        expect((await startRaw('p', { clientName: hostile })).status).toBe(200);
        const name = server.getStatus().pairing.session.clientName;
        expect(name).toBe('Pixel 123 456 x');
        expect(name).not.toMatch(/[​-‏‪-‮⁦-⁩﻿؜᠎\u0000-\u001f\u007f-\u009f]/);
        clock += START_HOLD_MS;
        expect((await startRaw('q', { clientName: '‮​\u0000' })).status).toBe(200);
        expect(server.getStatus().pairing.session.clientName).toBe('Unnamed device');
        clock += START_HOLD_MS;
        expect((await startRaw('r', { clientName: 'n'.repeat(200) })).status).toBe(200);
        expect(server.getStatus().pairing.session.clientName).toHaveLength(64);
    });

    it('rejects prototype-ish ids everywhere (reviewer test H, fix 8)', async () => {
        server.openPairing();
        for (const id of ['__proto__', 'constructor', 'prototype']) expect((await startRaw(id)).status, id).toBe(400);
        expect(server.getStatus().pairing.attemptsLeft).toBe(MAX_PAIRING_ATTEMPTS);
        expect(server.getStatus().pairing.session).toBeNull();   // a refused start never holds the slot
        expect((await startRaw('toString')).status).toBe(200);   // a real string id; stored in a Map, harmless
        expect(({}).toString).toBe(Object.prototype.toString);
    });

    it('stops a decompression bomb from a paired device at the cap (reviewer test F, fix 13)', async () => {
        let got = 0;
        desktop.onExchange = async (_p, payload) => { got = JSON.stringify(payload).length; return { rev: 0, delta: {} }; };
        const bombServer = createSyncServer({ identity: { deviceId: 'desk-1', name: 'Studio Mac' }, peers, webcrypto, onExchange: desktop.onExchange, now, log: { warn() {}, error() {} } });
        const { port: p2 } = await bombServer.start({ host: '127.0.0.1' });
        try {
            const ltk = C.randomBytes(32);
            await peers.put('phone-1', { name: 'Pixel', key: C.b64encode(ltk) });
            const keys = await C.frameKeys(ltk);
            const big = { since: 0, delta: { favorites: {} }, pad: 'a'.repeat(64 * 1024 * 1024) };
            const body = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(big))));
            const iv = C.randomBytes(12);
            const head = { v: 2, from: 'phone-1', to: 'desk-1', seq: 1, ts: clock, n: C.b64encode(iv), re: '', z: 1 };
            const aad = new TextEncoder().encode(JSON.stringify([head.v, head.from, head.to, head.seq, head.ts, head.n, head.re, head.z]));
            const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, keys.c2s, body));
            const wire = JSON.stringify({ ...head, ct: C.b64encode(ct) });
            expect(wire.length).toBeLessThan(200_000);
            const before = process.memoryUsage().rss;
            const r = await rawPost(`http://127.0.0.1:${p2}/v1/sync`, wire);
            expect(r.status).toBe(401);
            expect(got).toBe(0);
            expect(process.memoryUsage().rss - before).toBeLessThan(C.MAX_FRAME_BODY_BYTES + 32 * 1024 * 1024);
            // the counter was not consumed by the refused frame
            expect((await peers.get('phone-1')).rxSeq).toBe(0);
        } finally {
            await bombServer.stop();
        }
    });

    it('fails pairing visibly when the peer cannot be persisted (fix 9)', async () => {
        server.openPairing();
        peers.failWrites = true;
        const client = newClient();
        await expect(pairPhone(client)).rejects.toMatchObject({ code: 'storage' });
        peers.failWrites = false;
        expect(await peers.get('phone-1')).toBeNull();
        expect(server.getStatus().pairing).toMatchObject({ locked: true, lockReason: 'storage' });
        expect(server.getStatus().pairing.session).toMatchObject({ status: 'failed' });
        expect(server.getStatus().pairing.session.error).toMatch(/disk full/);
    });

    it('refuses over-limit data with 413 and a clear message (fix 17)', async () => {
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        const phone = makePhone(client, result.ltk);
        const delta = { playlists: {} };
        for (let i = 0; i < 6; i++) delta.playlists[`p${i}`] = { name: 'a', tracks: Array.from({ length: LIMITS.playlistTracks }, (_, j) => `k${j}`), t: { w: 1, c: i, d: 'phone-1' } };
        await expect(phone.exchange('127.0.0.1', port, { since: 0, delta })).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/playlist entries/) });
        // the desktop merged nothing and still talks to the phone afterwards
        expect(Object.keys(desktop.store.state.playlists)).toEqual([]);
        await phone.sync('127.0.0.1', port);
    });

    it('lets a phone revoke its pairing with an authenticated unpair frame (fix 25)', async () => {
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        const phone = makePhone(client, result.ltk);
        await phone.sync('127.0.0.1', port);
        let unpaired = null;
        server.on('unpaired', (e) => { unpaired = e; });
        // a forged unpair does nothing
        const otherKeys = await C.frameKeys(C.randomBytes(32));
        expect((await rawPost(`${base}/v1/unpair`, await C.sealFrame({ key: otherKeys.c2s, from: 'phone-1', to: 'desk-1', seq: 99, payload: { op: 'unpair' }, now: clock }))).status).toBe(401);
        expect(await peers.get('phone-1')).not.toBeNull();
        // a sync frame on the unpair route is not an unpair
        const keys = await C.frameKeys(C.b64decode(result.ltk));
        expect((await rawPost(`${base}/v1/unpair`, await C.sealFrame({ key: keys.c2s, from: 'phone-1', to: 'desk-1', seq: 2, payload: { since: 0, delta: {} }, now: clock }))).status).toBe(400);
        // the real thing
        expect(await client.unpair({ host: '127.0.0.1', port, peer: phone.peer, seq: 3 })).toBe(true);
        expect(unpaired).toMatchObject({ deviceId: 'phone-1' });
        expect(await peers.get('phone-1')).toBeNull();
        await expect(phone.sync('127.0.0.1', port)).rejects.toMatchObject({ code: 'unauthorized' });
    });

    it('answers 503 (no data) when the app cannot run the exchange, rate limits, and reveals nothing on /v1/info', async () => {
        server.openPairing();
        const client = newClient();
        const { result } = await pairPhone(client);
        desktop.onExchange = async () => { throw new Error('renderer gone'); };
        const failing = createSyncServer({ identity: { deviceId: 'desk-1', name: 'Studio Mac' }, peers, webcrypto, onExchange: desktop.onExchange, now, log: { warn() {}, error() {} } });
        const { port: p2 } = await failing.start({ host: '127.0.0.1' });
        try {
            await expect(client.exchange({ host: '127.0.0.1', port: p2, peer: { deviceId: 'desk-1', ltk: result.ltk }, seq: 1, payload: { since: 0, delta: {} } })).rejects.toMatchObject({ code: 'busy' });
            const statuses = [];
            for (let i = 0; i < 125; i++) statuses.push((await fetchTransport({ url: `http://127.0.0.1:${p2}/v1/info`, method: 'GET' })).status);
            expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
            expect((await fetchTransport({ url: `http://127.0.0.1:${p2}/nope`, method: 'GET' })).status).toBe(429);
            await expect(client.exchange({ host: '127.0.0.1', port: p2, peer: { deviceId: 'desk-1', ltk: result.ltk }, seq: 2, payload: { since: 0, delta: {} } })).rejects.toMatchObject({ code: 'rate' });
        } finally {
            await failing.stop();
        }
        expect((await fetchTransport({ url: `${base}/nope`, method: 'GET' })).status).toBe(404);
        const info = JSON.parse((await fetchTransport({ url: `${base}/v1/info`, method: 'GET' })).body);
        expect(info).toEqual({ app: 'crossroads', v: 2 });
        expect(await client.info({ host: '127.0.0.1', port })).toEqual({ v: 2 });
        expect((await fetchTransport({ url: `${base}/v1/pair/status?session=nope`, method: 'GET' })).status).toBe(404);
    });
});
