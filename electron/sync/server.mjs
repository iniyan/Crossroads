// LAN sync server (#25): HTTP endpoint hosted by the desktop, pairing state machine and the
// authenticated /v1/sync exchange. Plain Node (no Electron imports) so it runs headless in
// tests; electron/sync/ipc.js wires it to the app, mDNS advertising lives in advertise.mjs.
//
// Security model
//   - Binds every interface but answers only private/loopback remote addresses (RFC 1918,
//     link-local, ULA); anything else gets 403 with an empty body.
//   - Not for browsers: a request carrying Origin or any Sec-Fetch-* header, a POST that is
//     not application/json, or a Host that is not an IP literal is refused (403 / 415) before
//     any route runs, so a web page on the LAN cannot drive the pairing endpoints.
//   - Unauthenticated endpoints are the pairing handshake and GET /v1/info ({ app, v } only).
//     Pairing works only inside a 2-minute window the desktop user opened explicitly, for at
//     most MAX_PAIRING_ATTEMPTS sessions per window. One session at a time: while a session
//     is being compared, confirmed or finished, further /pair/start calls get 409 and only the
//     desktop user can reject or cancel it (the screen never changes under the user). A session
//     that was only started is held for START_HOLD_MS before another /pair/start may replace
//     it: the phone reveals its nonce one round trip after starting, so a LAN observer who saw
//     the plaintext session id cannot slip a start of its own in between. The desktop user's
//     rejection, attempt exhaustion or expiry locks the window; the user opens a new one
//     explicitly. A session the desktop confirmed near the end of the window gets
//     CONFIRM_GRACE_MS more to finish.
//   - The session id and nonces travel in plaintext, so anyone on the LAN can address a live
//     session. What they cannot do is produce the phone's commitment preimage (/pair/reveal)
//     or the key-confirmation proof (/pair/finish): those are unforgeable, and a wrong one is
//     answered 403 without touching the session (no state change, no lock), so an observer
//     cannot kill a pairing the two users are looking at. The pairing rate limit bounds the
//     guesses. Accepted residual: an attacker who keeps calling /pair/start first can burn the
//     window's attempts (each start counts) and deny pairing for that window; the desktop
//     shows the attempt limit being reached, and the window is only ever open for 2 minutes
//     after an explicit click.
//   - /v1/sync and /v1/unpair only accept AES-GCM frames from paired devices
//     (src/sync/crypto.mjs) whose sequence number is above the last one persisted for that
//     device; the counter is recorded (and persisted) only after the tag verified, so forged
//     frames cannot flood anything and a captured frame is useless after a restart. Any
//     failure - unknown device, bad key, tampering, old counter - is a bare 401. The frame
//     shape and the sender id are validated, and the sender looked up, before anything is
//     queued per peer, and a peer's queue entry is dropped once it drained, so bogus senders
//     retain no memory.
//   - Browser-shaped requests are refused before rate accounting, so a web page on the phone
//     cannot spend the phone's per-IP budget. Per-IP rate limits (status polling has a budget
//     of its own so a slow user confirming is never rate-limited away), 8 MB bodies, inflated
//     frames capped by crypto.mjs, data limits enforced by the model (413), no redirects, JSON
//     only.
// See src/sync/crypto.mjs for the pairing protocol (numeric comparison over ECDH P-256).

import http from 'node:http';
import { EventEmitter } from 'node:events';
import * as C from '../../src/sync/crypto.mjs';
import { cleanDisplayName } from '../../src/sync/names.mjs';

export const PROTOCOL_VERSION = 2;
export const SERVICE_TYPE = 'crossroads';           // mDNS: _crossroads._tcp
export const PAIRING_WINDOW_MS = 2 * 60 * 1000;
export const CONFIRM_GRACE_MS = 30 * 1000;
export const START_HOLD_MS = 10 * 1000;
export const MAX_PAIRING_ATTEMPTS = 5;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const RATE_LIMIT_PER_MINUTE = 120;
export const PAIR_RATE_LIMIT_PER_MINUTE = 20;
export const EXCHANGE_TIMEOUT_MS = 30 * 1000;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const LIVE_SESSION = new Set(['started', 'compare', 'confirmed']);

// ---- addresses ---------------------------------------------------------------------------------

const ipv4Parts = (ip) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every(p => p <= 255) ? parts : null;
};

const isIpv6Literal = (v6) => /^[0-9a-f:]+$/i.test(v6) && v6.includes(':') && (v6.match(/::/g) || []).length <= 1;

/** Loopback or private LAN address (IPv4 RFC 1918 / link-local, IPv6 loopback / link-local / ULA). */
export const isPrivateAddress = (ip) => {
    if (typeof ip !== 'string' || !ip) return false;
    let addr = ip;
    if (addr.startsWith('::ffff:')) addr = addr.slice(7);
    const v4 = ipv4Parts(addr);
    if (v4) {
        const [a, b] = v4;
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    const v6 = addr.split('%')[0].toLowerCase();
    if (v6 === '::1') return true;
    if (!/^[0-9a-f:]+$/.test(v6)) return false;
    const head = v6.split(':')[0];
    if (head.length === 0) return false;
    const first = parseInt(head.padStart(4, '0').slice(0, 2), 16);
    const second = parseInt(head.padStart(4, '0').slice(2), 16);
    return (first === 0xfe && (second & 0xc0) === 0x80) || (first & 0xfe) === 0xfc;
};

/** "192.168.1.2:51234", "[fd00::5]:51234" or the bare literal: an IP literal Host header. */
export const isIpLiteralHost = (host) => {
    if (typeof host !== 'string' || host.length === 0 || host.length > 64) return false;
    const m = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+))(?::(\d{1,5}))?$/.exec(host);
    if (!m) return false;
    if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false;
    return m[1] ? isIpv6Literal(m[1]) : ipv4Parts(m[2]) !== null;
};

// ---- helpers ------------------------------------------------------------------------------------

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH && ID_RE.test(v) && !RESERVED_IDS.has(v);
const cleanName = (v) => cleanDisplayName(v, MAX_NAME_LENGTH) || 'Unnamed device';

const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

class RateLimiter {
    constructor(limit, now) { this.limit = limit; this.now = now; this.hits = new Map(); }
    allow(key) {
        const t = this.now();
        if (this.hits.size > 10000) this.hits.clear();
        const entry = this.hits.get(key);
        if (!entry || t - entry.start >= 60_000) { this.hits.set(key, { start: t, count: 1 }); return true; }
        entry.count += 1;
        return entry.count <= this.limit;
    }
}

/**
 * In-memory peer store (tests). Records: { name, key (base64 LTK), pairedAt, lastSyncAt,
 * txSeq, rxSeq }. `failWrites` makes every write reject (tests of persistence failures).
 */
export const createMemoryPeerStore = () => {
    const peers = new Map();
    const store = {
        failWrites: false,
        async list() { return [...peers.entries()].map(([deviceId, r]) => ({ deviceId, ...r })); },
        async get(deviceId) { return peers.get(deviceId) || null; },
        async put(deviceId, record) {
            if (store.failWrites) throw new Error('disk full');
            peers.set(deviceId, { txSeq: 0, rxSeq: 0, ...record });
        },
        async remove(deviceId) { if (store.failWrites) throw new Error('disk full'); peers.delete(deviceId); },
        async touch(deviceId, patch) {
            if (store.failWrites) throw new Error('disk full');
            const r = peers.get(deviceId);
            if (r) peers.set(deviceId, { ...r, ...patch });
        }
    };
    return store;
};

/** Public view of a peer record (no key material, no counters). */
const publicPeer = ({ deviceId, name, pairedAt, lastSyncAt }) => ({ deviceId, name, pairedAt: pairedAt || null, lastSyncAt: lastSyncAt || null });

// ---- server ----------------------------------------------------------------------------------

/**
 * @param {Object} options
 * @param {{deviceId: string, name: string}} options.identity   (name is read live: it may be renamed)
 * @param {Object} options.peers          peer store (createMemoryPeerStore / peerStore.mjs)
 * @param {Object} options.webcrypto      WebCrypto implementation (node:crypto webcrypto)
 * @param {(peerId: string, payload: Object) => Promise<Object>} options.onExchange
 *        Runs the merge for a paired peer's request and returns the response payload. A
 *        rejection whose `code` is 'limit' is reported to the peer as 413.
 * @param {() => number} [options.now]
 */
export const createSyncServer = ({ identity, peers, webcrypto, onExchange, now = Date.now, log = console, exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS }) => {
    if (!identity || !isId(identity.deviceId)) throw new Error('Invalid identity');
    C.setWebCrypto(webcrypto);
    const events = new EventEmitter();
    const limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE, now);
    const pairLimiter = new RateLimiter(PAIR_RATE_LIMIT_PER_MINUTE, now);
    const keyCache = new Map();      // deviceId -> { keyB64, keys: { c2s, s2c } }
    const peerQueues = new Map();    // deviceId -> Promise: frames from one peer are handled one at a time
    let server = null;
    let port = 0;
    let pairing = null;              // { expiresAt, attempts, locked, lockReason, session, timer }

    const emitStatus = () => events.emit('status', getStatus());

    // ---- pairing state machine ----

    const lock = (reason) => {
        if (!pairing || pairing.locked) return;
        pairing.locked = true;
        pairing.lockReason = reason;
    };

    const sessionDeadline = (s) => (s.status === 'confirmed' ? Math.max(pairing.expiresAt, s.confirmedAt + CONFIRM_GRACE_MS) : pairing.expiresAt);

    /** Marks a session expired once its deadline passed; returns true while it is still live. */
    const sessionAlive = (s) => {
        if (!pairing || !s || !LIVE_SESSION.has(s.status)) return false;
        if (now() >= sessionDeadline(s)) { s.status = 'expired'; lock('expired'); emitStatus(); return false; }
        return true;
    };

    /** The window accepts new /pair/start calls. */
    const pairingOpen = () => {
        if (!pairing) return false;
        if (!pairing.locked && now() >= pairing.expiresAt) { lock('expired'); if (pairing.session && pairing.session.status !== 'confirmed') sessionAlive(pairing.session); }
        return !pairing.locked;
    };

    const publicSession = (s) => (s ? {
        id: s.id,
        clientId: s.clientId,
        clientName: s.clientName,
        fingerprint: s.fingerprint,
        code: s.status === 'compare' || s.status === 'confirmed' ? s.code : null,
        status: s.status,
        error: s.error || null
    } : null);

    const getStatus = () => ({
        deviceId: identity.deviceId,
        name: identity.name,
        running: !!server,
        port,
        pairing: pairing ? {
            open: pairingOpen(),
            locked: !!pairing.locked,
            lockReason: pairing.lockReason || null,
            expiresAt: pairing.expiresAt,
            attemptsLeft: Math.max(0, MAX_PAIRING_ATTEMPTS - pairing.attempts),
            session: publicSession(pairing.session)
        } : null
    });

    const closePairing = (reason = 'closed') => {
        if (!pairing) return;
        clearTimeout(pairing.timer);
        if (pairing.session && LIVE_SESSION.has(pairing.session.status)) {
            pairing.session.status = reason === 'expired' ? 'expired' : 'rejected';
        }
        pairing = null;
        emitStatus();
    };

    /** Explicit desktop action: opens a fresh window (dismissing whatever the last one showed). */
    const openPairing = () => {
        closePairing();
        const expiresAt = now() + PAIRING_WINDOW_MS;
        const timer = setTimeout(() => {
            if (!pairing) return;
            lock('expired');
            const s = pairing.session;
            if (s && (s.status === 'started' || s.status === 'compare')) s.status = 'expired';
            emitStatus();
        }, PAIRING_WINDOW_MS);
        if (typeof timer.unref === 'function') timer.unref();
        pairing = { expiresAt, attempts: 0, locked: false, lockReason: null, session: null, timer };
        emitStatus();
        return getStatus();
    };

    /** The desktop user compared the codes: accept or reject the pending session. */
    const confirmPairing = (sessionId, accept) => {
        const s = pairing?.session;
        if (!s || s.id !== sessionId || s.status !== 'compare' || !sessionAlive(s)) return getStatus();
        if (accept) {
            s.status = 'confirmed';
            s.confirmedAt = now();
        } else {
            s.status = 'rejected';
            lock('rejected');
        }
        emitStatus();
        return getStatus();
    };

    const peerKeys = async (deviceId, record) => {
        const cached = keyCache.get(deviceId);
        if (cached && cached.keyB64 === record.key) return cached.keys;
        const keys = await C.frameKeys(C.b64decodeExact(record.key, C.KEY_BYTES));
        keyCache.set(deviceId, { keyB64: record.key, keys });
        return keys;
    };

    /**
     * Runs `fn` after everything already queued for `deviceId`. Only called for ids that
     * passed isId and belong to a paired device (see authenticatedRoute); the map entry goes
     * away as soon as the queue drains, so it never holds more than the peers mid-request.
     */
    const withPeer = (deviceId, fn) => {
        const previous = peerQueues.get(deviceId) || Promise.resolve();
        const run = previous.then(fn, fn);
        const tail = run.catch(() => {}).then(() => { if (peerQueues.get(deviceId) === tail) peerQueues.delete(deviceId); });
        peerQueues.set(deviceId, tail);
        return run;
    };

    /**
     * Opens a frame from a paired device and persists its counter. Resolves { record, keys,
     * payload } or an HTTP tuple to send as-is.
     */
    const authenticate = async (frame) => {
        if (!C.isFrameShaped(frame) || !isId(frame.from)) return { reply: [401, null] };
        const record = await peers.get(frame.from);
        if (!record) return { reply: [401, null] };
        let keys;
        let payload;
        try {
            keys = await peerKeys(frame.from, record);
            payload = await C.openFrame({ key: keys.c2s, frame, from: frame.from, to: identity.deviceId, afterSeq: record.rxSeq || 0 });
        } catch (e) {
            log.warn?.(`sync: rejected frame from ${frame.from} (${e.code || e.message})`);
            return { reply: [401, null] };
        }
        try {
            await peers.touch(frame.from, { rxSeq: frame.seq });
        } catch (e) {
            log.error?.('sync: could not persist the frame counter', e);
            return { reply: [503, { error: 'storage' }] };
        }
        return { record, keys, payload };
    };

    // ---- routes ----

    /**
     * Gate for the frame routes: a well-formed frame with a valid id from a paired device is
     * queued behind that device's earlier frames; anything else is a bare 401 before any
     * per-sender state exists (a hostile `from` must not become a map key).
     */
    const authenticatedRoute = async (frame, fn) => {
        if (!C.isFrameShaped(frame) || !isId(frame.from)) return [401, null];
        if (!(await peers.get(frame.from))) return [401, null];
        return withPeer(frame.from, fn);
    };

    const send = (res, status, body) => {
        const text = body === undefined || body === null ? '' : JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(text),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(text);
    };

    const routes = {
        'GET /v1/info': async () => [200, { app: 'crossroads', v: PROTOCOL_VERSION }],

        'POST /v1/pair/start': async (body, ip) => {
            if (!pairLimiter.allow(ip)) return [429, { error: 'rate' }];
            if (!pairing) return [403, { error: 'closed' }];
            if (!pairingOpen()) return pairing.lockReason === 'attempts' ? [429, { error: 'locked' }] : [403, { error: 'closed' }];
            const active = pairing.session;
            // One session at a time: nothing replaces a session the users may be looking at,
            // and a freshly started one is held long enough for its phone to reveal (one round
            // trip) so a start by someone else cannot pre-empt it. A phone that gave up
            // between start and reveal simply waits out the hold before retrying.
            if (active && sessionAlive(active)) {
                if (active.status !== 'started') return [409, { error: 'busy' }];
                if (now() - active.startedAt < START_HOLD_MS) return [409, { error: 'busy' }];
            }
            if (!body || !isId(body.clientId) || body.clientId === identity.deviceId) return [400, { error: 'bad_request' }];
            if (await peers.get(body.clientId)) return [409, { error: 'already_paired' }];
            let clientPub;
            let commit;
            try {
                clientPub = C.b64decodeExact(body.clientPub, C.PUBLIC_KEY_BYTES);
                await C.importPublicKey(clientPub);
                commit = C.b64decodeExact(body.commit, 32);
            } catch {
                return [400, { error: 'bad_request' }];
            }
            pairing.attempts += 1;
            if (active && active.status === 'started') active.status = 'superseded';
            const pair = await C.generateKeyPair();
            const session = {
                id: C.randomId(),
                clientId: body.clientId,
                clientName: cleanName(body.clientName),
                fingerprint: await C.keyFingerprint(clientPub),
                clientPub,
                commit,
                serverPriv: pair.privateKey,
                serverPub: pair.publicKey,
                serverNonce: C.randomBytes(C.NONCE_BYTES),
                status: 'started',
                startedAt: now()
            };
            pairing.session = session;
            // The last allowed attempt still runs to completion; only new starts are refused.
            if (pairing.attempts >= MAX_PAIRING_ATTEMPTS) lock('attempts');
            emitStatus();
            return [200, {
                sessionId: session.id,
                serverId: identity.deviceId,
                serverName: identity.name,
                serverPub: C.b64encode(session.serverPub),
                serverNonce: C.b64encode(session.serverNonce),
                fingerprint: session.fingerprint
            }];
        },

        'POST /v1/pair/reveal': async (body, ip) => {
            if (!pairLimiter.allow(ip)) return [429, { error: 'rate' }];
            const s = pairing?.session;
            if (!s || !body || body.sessionId !== s.id || s.status !== 'started' || !sessionAlive(s)) return [403, { error: 'closed' }];
            let clientNonce;
            try { clientNonce = C.b64decodeExact(body.clientNonce, C.NONCE_BYTES); } catch { return [400, { error: 'bad_request' }]; }
            // A wrong preimage cannot come from the phone that made the commitment: refuse it
            // and leave the session exactly as it was (anyone on the LAN knows the session id).
            if (!C.constantTimeEqual(await C.commitment(clientNonce), s.commit)) {
                log.warn?.(`sync: /pair/reveal from ${ip} did not match the commitment; ignored`);
                return [403, { error: 'commitment' }];
            }
            s.clientNonce = clientNonce;
            const transcript = C.pairingTranscript({
                serverId: identity.deviceId, clientId: s.clientId, sessionId: s.id,
                serverPub: s.serverPub, clientPub: s.clientPub, clientNonce, serverNonce: s.serverNonce
            });
            const secret = await C.sharedSecret(s.serverPriv, s.clientPub);
            const keys = await C.deriveSessionKeys(secret, transcript);
            s.code = await C.pairingCode(transcript);
            s.ltk = keys.ltk;
            s.confirmKey = keys.confirmKey;
            s.status = 'compare';
            emitStatus();
            return [200, { ok: true }];
        },

        // Polled once a second by the phone while both users compare: only the general limiter applies.
        'GET /v1/pair/status': async (_body, _ip, url) => {
            const s = pairing?.session;
            const id = url.searchParams.get('session');
            if (!s || !id || id !== s.id) return [404, { status: 'unknown' }];
            sessionAlive(s);
            if (s.status !== 'confirmed') return [200, { status: s.status }];
            return [200, { status: 'confirmed', serverProof: C.b64encode(await C.pairingProof(s.confirmKey, 'server')) }];
        },

        'POST /v1/pair/finish': async (body, ip) => {
            if (!pairLimiter.allow(ip)) return [429, { error: 'rate' }];
            const s = pairing?.session;
            if (!s || !body || body.sessionId !== s.id || !sessionAlive(s)) return [403, { error: 'closed' }];
            if (s.status === 'compare') return [409, { error: 'not_confirmed' }];
            if (s.status !== 'confirmed') return [403, { error: 'closed' }];
            let proof;
            try { proof = C.b64decodeExact(body.clientProof, 32); } catch { return [400, { error: 'bad_request' }]; }
            // Same here: the proof is an HMAC under the session's confirmation key. A wrong
            // one is a guess (or an interfering device) and must not end the real phone's
            // session; the real phone's finish still goes through afterwards.
            if (!C.constantTimeEqual(proof, await C.pairingProof(s.confirmKey, 'client'))) {
                log.warn?.(`sync: /pair/finish from ${ip} carried a wrong proof; ignored`);
                return [403, { error: 'proof' }];
            }
            const record = { name: s.clientName, key: C.b64encode(s.ltk), pairedAt: now(), lastSyncAt: null, txSeq: 0, rxSeq: 0 };
            try {
                await peers.put(s.clientId, record);
            } catch (e) {
                log.error?.('sync: could not store the paired device', e);
                s.status = 'failed';
                s.error = `storage: ${e.message}`;
                lock('storage');
                emitStatus();
                return [503, { error: 'storage' }];
            }
            keyCache.delete(s.clientId);
            s.status = 'finished';
            events.emit('paired', publicPeer({ deviceId: s.clientId, ...record }));
            closePairing();
            return [200, { ok: true }];
        },

        'POST /v1/sync': async (frame) => authenticatedRoute(frame, async () => {
            const auth = await authenticate(frame);
            if (auth.reply) return auth.reply;
            const { keys, payload } = auth;
            if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.since) || payload.since < 0 || !payload.delta || typeof payload.delta !== 'object') {
                return [400, { error: 'bad_request' }];
            }
            let result;
            try {
                result = await Promise.race([
                    onExchange(frame.from, payload),
                    new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('exchange timeout')), exchangeTimeoutMs); if (t.unref) t.unref(); })
                ]);
            } catch (e) {
                if (e && e.code === 'limit') {
                    log.warn?.(`sync: refused over-limit data from ${frame.from}: ${e.message}`);
                    return [413, { error: 'too_large', message: e.message }];
                }
                log.error?.('sync: exchange failed', e);
                return [503, null];
            }
            const fresh = await peers.get(frame.from);
            if (!fresh) return [401, null];
            const txSeq = (fresh.txSeq || 0) + 1;
            try {
                await peers.touch(frame.from, { txSeq, lastSyncAt: now() });   // persisted before it is sent
            } catch (e) {
                log.error?.('sync: could not persist the frame counter', e);
                return [503, { error: 'storage' }];
            }
            events.emit('synced', { deviceId: frame.from, at: now() });
            const reply = await C.sealFrame({ key: keys.s2c, from: identity.deviceId, to: frame.from, seq: txSeq, re: frame.n, payload: result, now: now() });
            return [200, reply];
        }),

        // A paired phone revoking the pairing from its side (best effort; the phone forgets the key regardless).
        'POST /v1/unpair': async (frame) => authenticatedRoute(frame, async () => {
            const auth = await authenticate(frame);
            if (auth.reply) return auth.reply;
            if (!auth.payload || auth.payload.op !== 'unpair') return [400, { error: 'bad_request' }];
            try {
                await peers.remove(frame.from);
            } catch (e) {
                log.error?.('sync: could not remove the peer', e);
                return [503, { error: 'storage' }];
            }
            keyCache.delete(frame.from);
            events.emit('unpaired', { deviceId: frame.from, at: now() });
            return [200, { ok: true }];
        })
    };

    /** Refuses anything a browser would send: Origin / Sec-Fetch-* headers, non-JSON posts, named hosts. */
    const browserCheck = (req) => {
        const h = req.headers;
        if (h.origin !== undefined) return 403;
        for (const name of Object.keys(h)) if (name.startsWith('sec-fetch-')) return 403;
        if (!isIpLiteralHost(h.host)) return 403;
        if (req.method === 'POST') {
            const type = String(h['content-type'] || '').toLowerCase();
            if (!type.startsWith('application/json')) return 415;
        }
        return 0;
    };

    const handle = async (req, res) => {
        const ip = req.socket.remoteAddress || '';
        if (!isPrivateAddress(ip)) return send(res, 403, null);
        // Refused requests never count: a web page on the phone must not spend the phone's budget.
        const refused = browserCheck(req);
        if (refused) return send(res, refused, null);
        if (!limiter.allow(ip)) return send(res, 429, null);
        let url;
        try { url = new URL(req.url, 'http://local'); } catch { return send(res, 400, null); }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return send(res, 404, null);
        let body = null;
        if (req.method === 'POST') {
            let raw;
            try { raw = await readBody(req, MAX_BODY_BYTES); } catch { return send(res, 413, null); }
            try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, null); }
        }
        try {
            const [status, payload] = await route(body, ip, url);
            send(res, status, payload);
        } catch (e) {
            log.error?.('sync: request failed', e);
            send(res, 500, null);
        }
    };

    const start = ({ host = '0.0.0.0', port: wanted = 0 } = {}) => new Promise((resolve, reject) => {
        if (server) return resolve({ port });
        const s = http.createServer((req, res) => { handle(req, res).catch(() => { try { send(res, 500, null); } catch { /* closed */ } }); });
        s.keepAliveTimeout = 5000;
        s.headersTimeout = 10000;
        s.requestTimeout = 60000;
        s.on('error', (e) => { if (!server) reject(e); else log.error?.('sync: server error', e); });
        s.listen(wanted, host, () => {
            server = s;
            port = s.address().port;
            emitStatus();
            resolve({ port });
        });
    });

    const stop = () => new Promise((resolve) => {
        closePairing();
        keyCache.clear();
        if (!server) return resolve();
        const s = server;
        server = null;
        port = 0;
        s.closeAllConnections?.();
        s.close(() => { emitStatus(); resolve(); });
    });

    return {
        start, stop, openPairing, closePairing, confirmPairing, getStatus,
        listPeers: async () => (await peers.list()).map(publicPeer),
        unpair: async (deviceId) => { await peers.remove(deviceId); keyCache.delete(deviceId); },
        on: (event, listener) => { events.on(event, listener); return () => events.off(event, listener); },
        /** Sizes of the per-sender tables (tests: nothing may accumulate across requests). */
        stats: () => ({ queuedPeers: peerQueues.size, cachedKeys: keyCache.size }),
        get port() { return port; },
        get running() { return !!server; }
    };
};
