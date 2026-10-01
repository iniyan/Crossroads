// Sync client (#25): the phone side of pairing and of the /v1/sync exchange. Transport-agnostic:
// `transport({ url, method, body }) -> { status, body }` is the Android native request (the
// WebView cannot call http://192.168.x.x itself: mixed content) or fetch in tests.
//
// Counters: the caller owns the per-desktop frame counters (`seq`: the next value we send,
// `afterSeq`: the last one we accepted from the desktop) and persists `seq` BEFORE calling
// `exchange` and the reply's counter AFTER it resolves; see useLanSync.js.

import * as C from './crypto.mjs';
import { cleanDisplayName } from './names.mjs';

export const PAIR_POLL_MS = 1000;
export const PAIR_TIMEOUT_MS = 150 * 1000;   // the desktop's 2-minute window plus its grace
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class SyncClientError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'SyncClientError';
        this.code = code;
    }
}

const hostForUrl = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
export const baseUrl = (host, port) => `http://${hostForUrl(String(host).trim())}:${Number(port)}`;

const parseJson = (text) => {
    if (typeof text !== 'string' || text.length === 0) return null;
    if (text.length > MAX_RESPONSE_BYTES) throw new SyncClientError('protocol', 'Response too large');
    try { return JSON.parse(text); } catch { throw new SyncClientError('protocol', 'Response is not JSON'); }
};

/** Maps an HTTP status of an authenticated endpoint to a precise client error. */
export const exchangeError = (status, body) => {
    switch (status) {
        case 401: return new SyncClientError('unauthorized', 'The desktop did not accept this phone\'s key.');
        case 403: return new SyncClientError('refused', 'The desktop refused the connection.');
        case 413: return new SyncClientError('too_large', `The desktop refused the sync data as too large${body?.message ? ` (${body.message})` : ''}.`);
        case 415: return new SyncClientError('refused', 'The desktop refused the request format.');
        case 429: return new SyncClientError('rate', 'The desktop is rate-limiting this phone; try again in a minute.');
        case 503: return new SyncClientError('busy', 'The desktop app is not ready to sync (is it open and finished loading?).');
        default:
            if (status >= 500) return new SyncClientError('server', `The desktop app failed to process the sync (${status}).`);
            return new SyncClientError('protocol', `Sync failed (${status}).`);
    }
};

/**
 * @param {Object} options
 * @param {Function} options.transport
 * @param {{ deviceId: string, name: string }} options.identity
 * @param {Object} [options.webcrypto]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export const createSyncClient = ({ transport, identity, webcrypto = null, now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) => {
    if (webcrypto) C.setWebCrypto(webcrypto);

    const call = async (url, method, payload) => {
        let response;
        try {
            response = await transport({ url, method, body: payload === undefined ? undefined : JSON.stringify(payload) });
        } catch (e) {
            throw new SyncClientError('network', e?.message || 'Could not reach the device');
        }
        if (!response || !Number.isInteger(response.status)) throw new SyncClientError('network', 'No response');
        return { status: response.status, body: parseJson(response.body) };
    };

    /** Whether host:port is a Crossroads desktop (manual entry check); reveals nothing else. */
    const info = async ({ host, port }) => {
        const { status, body } = await call(`${baseUrl(host, port)}/v1/info`, 'GET');
        if (status !== 200 || !body || body.app !== 'crossroads') throw new SyncClientError('protocol', 'Not a Crossroads desktop');
        return { v: body.v };
    };

    /**
     * Runs the pairing handshake. `onCode({ code, serverName, serverId, fingerprint })` fires
     * when the six digits are known; the promise resolves once the desktop user confirmed,
     * the phone user confirmed (`clientConfirmed()` turned true) and both proofs verified.
     * Nothing is stored before that. `isCancelled()` aborts between steps.
     */
    const pair = async ({ host, port, onCode = () => {}, isCancelled = () => false, clientConfirmed = () => true }) => {
        const base = baseUrl(host, port);
        const keyPair = await C.generateKeyPair();
        const clientNonce = C.randomBytes(C.NONCE_BYTES);
        const commit = await C.commitment(clientNonce);

        const started = await call(`${base}/v1/pair/start`, 'POST', {
            clientId: identity.deviceId,
            clientName: identity.name,
            clientPub: C.b64encode(keyPair.publicKey),
            commit: C.b64encode(commit)
        });
        if (started.status === 403) throw new SyncClientError('closed', 'The desktop is not accepting pairing right now. Open "Pair a device" on it first.');
        if (started.status === 409 && started.body?.error === 'already_paired') throw new SyncClientError('already_paired', 'This device is already paired with that desktop. Unpair it there first.');
        if (started.status === 409) throw new SyncClientError('busy', 'The desktop is already pairing with another phone. Finish or reject that first.');
        if (started.status === 429) throw new SyncClientError('locked', 'Too many pairing attempts; open pairing on the desktop again.');
        if (started.status !== 200 || !started.body) throw new SyncClientError('protocol', `Pairing failed (${started.status})`);
        const { sessionId, serverId, serverPub: serverPubB64, serverNonce: serverNonceB64 } = started.body;
        // The desktop's name is shown next to the code: printable, single line, capped (names.mjs).
        const serverName = cleanDisplayName(started.body.serverName) || 'Desktop';
        if (typeof sessionId !== 'string' || typeof serverId !== 'string') throw new SyncClientError('protocol', 'Malformed pairing reply');
        let serverPub;
        let serverNonce;
        try {
            serverPub = C.b64decodeExact(serverPubB64, C.PUBLIC_KEY_BYTES);
            serverNonce = C.b64decodeExact(serverNonceB64, C.NONCE_BYTES);
        } catch {
            throw new SyncClientError('protocol', 'Malformed pairing reply');
        }
        if (isCancelled()) throw new SyncClientError('cancelled', 'Pairing cancelled');

        const revealed = await call(`${base}/v1/pair/reveal`, 'POST', { sessionId, clientNonce: C.b64encode(clientNonce) });
        if (revealed.status !== 200) throw new SyncClientError('protocol', `Pairing failed (${revealed.status})`);

        const transcript = C.pairingTranscript({ serverId, clientId: identity.deviceId, sessionId, serverPub, clientPub: keyPair.publicKey, clientNonce, serverNonce });
        const secret = await C.sharedSecret(keyPair.privateKey, serverPub);
        const keys = await C.deriveSessionKeys(secret, transcript);
        const code = await C.pairingCode(transcript);
        const fingerprint = await C.keyFingerprint(serverPub);
        onCode({ code, serverName, serverId, fingerprint });

        // Both users compare. Poll until the desktop confirmed (its proof arrives then) and the
        // phone user confirmed; either may come first.
        const deadline = now() + PAIR_TIMEOUT_MS;
        let serverVerified = false;
        for (;;) {
            if (isCancelled()) throw new SyncClientError('cancelled', 'Pairing cancelled');
            if (now() > deadline) throw new SyncClientError('expired', 'Pairing timed out');
            const st = await call(`${base}/v1/pair/status?session=${encodeURIComponent(sessionId)}`, 'GET');
            const status = st.body?.status;
            if (status === 'rejected') throw new SyncClientError('rejected', 'The desktop rejected the pairing (codes did not match?)');
            if (status === 'confirmed' && !serverVerified) {
                let proofBytes;
                try { proofBytes = C.b64decodeExact(st.body.serverProof, 32); } catch { throw new SyncClientError('protocol', 'Malformed proof'); }
                if (!C.constantTimeEqual(proofBytes, await C.pairingProof(keys.confirmKey, 'server'))) {
                    throw new SyncClientError('rejected', 'The desktop could not prove it holds the pairing key');
                }
                serverVerified = true;
            } else if (status !== 'compare' && status !== 'confirmed') {
                throw new SyncClientError('expired', status === 'unknown' || st.status !== 200 ? 'Pairing expired' : `Pairing ${status}`);
            }
            if (serverVerified && clientConfirmed()) break;
            await sleep(PAIR_POLL_MS);
        }

        const finished = await call(`${base}/v1/pair/finish`, 'POST', { sessionId, clientProof: C.b64encode(await C.pairingProof(keys.confirmKey, 'client')) });
        if (finished.status === 503) throw new SyncClientError('storage', 'The desktop could not save the pairing. Try again.');
        if (finished.status !== 200) throw new SyncClientError('protocol', `Pairing failed (${finished.status})`);
        return { deviceId: serverId, name: serverName, ltk: C.b64encode(keys.ltk), code, fingerprint };
    };

    const sealed = async ({ peer, seq, payload }) => {
        const keys = await C.frameKeys(C.b64decodeExact(peer.ltk, C.KEY_BYTES));
        const frame = await C.sealFrame({ key: keys.c2s, from: identity.deviceId, to: peer.deviceId, seq, payload, now: now() });
        return { keys, frame };
    };

    /**
     * One authenticated exchange with a paired desktop. `peer.ltk` is the base64 key, `seq`
     * the counter for this request (already persisted), `afterSeq` the last reply counter
     * accepted. Resolves { payload, seq: the reply's counter (persist it) }.
     */
    const exchange = async ({ host, port, peer, seq, afterSeq = 0, payload }) => {
        const { keys, frame } = await sealed({ peer, seq, payload });
        const { status, body } = await call(`${baseUrl(host, port)}/v1/sync`, 'POST', frame);
        if (status !== 200) throw exchangeError(status, body);
        if (!body) throw new SyncClientError('unverified', 'The desktop sent an empty reply.');
        try {
            const reply = await C.openFrame({ key: keys.s2c, frame: body, from: peer.deviceId, to: identity.deviceId, re: frame.n, afterSeq });
            return { payload: reply, seq: body.seq };
        } catch (e) {
            throw new SyncClientError('unverified', `The reply from the desktop could not be verified (${e.code || e.message}).`);
        }
    };

    /** Tells the desktop this phone is unpairing. Resolves true when the desktop accepted it. */
    const unpair = async ({ host, port, peer, seq }) => {
        const { frame } = await sealed({ peer, seq, payload: { op: 'unpair' } });
        const { status } = await call(`${baseUrl(host, port)}/v1/unpair`, 'POST', frame);
        return status === 200;
    };

    return { info, pair, exchange, unpair };
};
