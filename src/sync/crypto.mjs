// Cryptography shared by every side of LAN sync (#25): the Electron main process (server),
// the Android WebView (client) and the Node tests. WebCrypto only, so the exact same code runs
// everywhere; the implementation is injectable because Electron's main process gets it from
// node:crypto (`setWebCrypto(require('node:crypto').webcrypto)`).
//
// Pairing: numeric comparison over ECDH P-256 (Bluetooth SSP style), confirmed on BOTH screens
//   1. client -> start   { clientPub, commit = H(clientNonce) }
//      server <- { serverPub, serverNonce, sessionId }
//   2. client -> reveal  { clientNonce }         (server checks the commitment)
//   3. both compute code = f(serverId, clientId, sessionId, pubs, nonces) and show it. The
//      desktop user confirms the phone shows the same digits; the phone user confirms the
//      computer shows them. Neither side stores anything before both confirmed.
//   4. server -> status  { serverProof } once the desktop user confirmed;
//      client -> finish { clientProof } once the phone user confirmed and the server proof
//      verified (key confirmation in both directions; the peer is stored only then).
//   Long-term key LTK = HKDF(ECDH shared secret, transcript).
// Why not "type the desktop's code into the phone": without a PAKE (not expressible with
// WebCrypto primitives) any scheme that binds a 6-digit secret to the exchange lets an active
// attacker who intercepts the phone's first message brute-force the code offline (10^6 HMACs)
// and then pair with the desktop inside the pairing window. Numeric comparison has no
// secret to brute-force: the commitment forces both nonces to be fixed before either party
// learns the other's, so a man-in-the-middle only gets a matching code on both screens with
// probability 10^-6 per attempt, and every attempt is visible on the desktop and counted.
//
// Frames (every message after pairing): AES-256-GCM with a direction key derived from the
// LTK, a fresh random 96-bit nonce, and { v, from, to, seq, ts, n, re, z } as additional
// authenticated data.
//   seq  the sender's monotonic counter for this (peer, direction): the receiver persists the
//        last accepted value and refuses anything not strictly greater. Replay-proof across
//        restarts and independent of either clock. Recorded only after the tag verified.
//   re   binds a response to the nonce of the request it answers.
//   ts   the sender's wall clock, authenticated but informational only (diagnostics).
// Compressed bodies are inflated through a stream that stops at MAX_FRAME_BODY_BYTES, so a
// small frame cannot expand into hundreds of megabytes.

const PAIR_INFO = 'crossroads-pair-v2';
const LTK_INFO = 'crossroads-ltk-v2';
const CONFIRM_INFO = 'crossroads-confirm-v2';
const FRAME_INFO = 'crossroads-frame-v2';
const CODE_DIGITS = 6;

export const FRAME_VERSION = 2;
export const PUBLIC_KEY_BYTES = 65;   // uncompressed P-256 point
export const NONCE_BYTES = 16;
export const KEY_BYTES = 32;
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;
/** Largest body a frame may inflate / parse to. The wire limit (8 MB) is on the ciphertext. */
export const MAX_FRAME_BODY_BYTES = 32 * 1024 * 1024;

let cryptoImpl = globalThis.crypto;

/** Installs the WebCrypto implementation to use (Electron main: node:crypto's webcrypto). */
export const setWebCrypto = (impl) => { cryptoImpl = impl; };
const subtle = () => {
    if (!cryptoImpl || !cryptoImpl.subtle) throw new Error('WebCrypto is not available');
    return cryptoImpl.subtle;
};

export class CryptoError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'CryptoError';
        this.code = code;
    }
}

// ---- bytes ---------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text) => encoder.encode(String(text));
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export const randomBytes = (n) => {
    if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') throw new Error('WebCrypto is not available');
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) cryptoImpl.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
    return out;
};

export const randomId = () => {
    if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
    const b = randomBytes(16);
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const concatBytes = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
};

export const toHex = (bytes) => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');

export const b64encode = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
};

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const b64decode = (text) => {
    if (typeof text !== 'string' || text.length % 4 !== 0 || !B64_RE.test(text)) throw new CryptoError('encoding', 'Invalid base64');
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
};

/** Decodes base64 and checks the exact byte length; throws CryptoError('encoding'). */
export const b64decodeExact = (text, length) => {
    const bytes = b64decode(text);
    if (bytes.length !== length) throw new CryptoError('encoding', `Expected ${length} bytes`);
    return bytes;
};

export const constantTimeEqual = (a, b) => {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
};

// ---- primitives ----------------------------------------------------------------------------

export const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));

export const hmac = async (keyBytes, data) => {
    const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle().sign('HMAC', key, data));
};

export const hkdf = async (ikm, salt, info, length = KEY_BYTES) => {
    const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, key, length * 8);
    return new Uint8Array(bits);
};

export const generateKeyPair = async () => {
    const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKey };
};

/** Imports a peer's raw public point; rejects anything that is not a valid P-256 point. */
export const importPublicKey = async (raw) => {
    if (!(raw instanceof Uint8Array) || raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
        throw new CryptoError('key', 'Invalid public key');
    }
    try {
        return await subtle().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    } catch {
        throw new CryptoError('key', 'Invalid public key');
    }
};

export const sharedSecret = async (privateKey, peerPublicRaw) => {
    const peer = await importPublicKey(peerPublicRaw);
    return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
};

export const importAesKey = (keyBytes) => {
    if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== KEY_BYTES) throw new CryptoError('key', 'Invalid key');
    return subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

// ---- pairing -------------------------------------------------------------------------------

export const commitment = (nonce) => sha256(concatBytes(utf8(`${PAIR_INFO}|commit|`), nonce));

/** Everything both sides must agree on, in a fixed order. Ids are plain strings. */
export const pairingTranscript = ({ serverId, clientId, sessionId, serverPub, clientPub, clientNonce, serverNonce }) =>
    concatBytes(
        utf8(`${PAIR_INFO}|${serverId}|${clientId}|${sessionId}|`),
        serverPub, clientPub, clientNonce, serverNonce
    );

/** Six decimal digits both screens show. Depends on the transcript only (no secret). */
export const pairingCode = async (transcript) => {
    const digest = await sha256(concatBytes(utf8(`${PAIR_INFO}|code|`), transcript));
    const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
    return String(n % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
};

export const formatPairingCode = (code) => (code ? `${code.slice(0, 3)} ${code.slice(3)}` : '');

/**
 * Short fingerprint of a public key ("3f9a 1c02"), shown next to the device name on the
 * desktop so the user can tell two phones with the same name apart.
 */
export const keyFingerprint = async (publicKey) => {
    const digest = await sha256(concatBytes(utf8(`${PAIR_INFO}|fp|`), publicKey));
    const hex = toHex(digest.subarray(0, 4));
    return `${hex.slice(0, 4)} ${hex.slice(4)}`;
};

/** { ltk, confirmKey } from the ECDH secret, bound to the transcript. */
export const deriveSessionKeys = async (secret, transcript) => {
    const salt = await sha256(transcript);
    const [ltk, confirmKey] = await Promise.all([hkdf(secret, salt, LTK_INFO), hkdf(secret, salt, CONFIRM_INFO)]);
    return { ltk, confirmKey };
};

export const pairingProof = (confirmKey, role) => hmac(confirmKey, utf8(`${PAIR_INFO}|proof|${role}`));

// ---- discovery -----------------------------------------------------------------------------

/**
 * What the desktop puts in its mDNS TXT record instead of its device id: a hash of the id
 * under a salt that changes every time hosting starts. A paired phone (which knows the id)
 * recomputes it to find "its" desktop; a passive listener gets no stable identifier to track
 * the computer across networks. It is only a hint: identity is proven by the encrypted exchange.
 */
export const discoveryTag = async (deviceId, salt) => toHex((await sha256(utf8(`${PAIR_INFO}|tag|${salt}|${deviceId}`))).subarray(0, 8));

// ---- frames --------------------------------------------------------------------------------

/** Direction keys (CryptoKey) for a long-term key: client->server and server->client. */
export const frameKeys = async (ltk) => {
    if (!(ltk instanceof Uint8Array) || ltk.length !== KEY_BYTES) throw new CryptoError('key', 'Invalid key');
    const salt = new Uint8Array(KEY_BYTES);
    const [c2s, s2c] = await Promise.all([
        hkdf(ltk, salt, `${FRAME_INFO}|c2s`).then(importAesKey),
        hkdf(ltk, salt, `${FRAME_INFO}|s2c`).then(importAesKey)
    ]);
    return { c2s, s2c };
};

const hasCompression = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/**
 * Pipes `bytes` through `stream`, collecting at most `maxBytes` of output; throws
 * CryptoError('too_large') as soon as the output exceeds it (the rest is never inflated).
 */
const pipeBytes = async (bytes, stream, maxBytes) => {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    let failure = null;
    const writing = writer.write(bytes).then(() => writer.close()).catch((e) => { failure = failure || e; });
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) {
                failure = new CryptoError('too_large', 'Frame body too large');
                await reader.cancel().catch(() => {});
                break;
            }
            chunks.push(value);
        }
    } catch (e) {
        failure = failure || e;
    }
    await writing;
    if (failure) throw failure instanceof CryptoError ? failure : new CryptoError('encoding', failure.message || 'Compression failed');
    return concatBytes(...chunks);
};

export const gzipBytes = (bytes) => pipeBytes(bytes, new CompressionStream('gzip'), Infinity);
/** Inflates gzip, refusing output above `maxBytes` (decompression-bomb guard). */
export const gunzipBytes = (bytes, maxBytes = MAX_FRAME_BODY_BYTES) => pipeBytes(bytes, new DecompressionStream('gzip'), maxBytes);

const GZIP_THRESHOLD = 512;

const frameAad = (frame) => utf8(JSON.stringify([frame.v, frame.from, frame.to, frame.seq, frame.ts, frame.n, frame.re, frame.z]));

export const isSeq = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SEQ;

/**
 * Encrypts `payload` (JSON-serialisable) for `to`. `seq` is the sender's next counter for
 * this direction (persist it before sending); `re` is the nonce of the request this frame
 * answers ('' for requests).
 */
export const sealFrame = async ({ key, from, to, seq, re = '', payload, now = Date.now() }) => {
    if (!isSeq(seq)) throw new CryptoError('seq', 'Invalid sequence number');
    let body = utf8(JSON.stringify(payload));
    if (body.length > MAX_FRAME_BODY_BYTES) throw new CryptoError('too_large', 'Frame body too large');
    let z = 0;
    if (body.length > GZIP_THRESHOLD && hasCompression()) {
        body = await gzipBytes(body);
        z = 1;
    }
    const iv = randomBytes(12);
    const frame = { v: FRAME_VERSION, from: String(from), to: String(to), seq, ts: Math.floor(now), n: b64encode(iv), re: String(re), z };
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: frameAad(frame) }, key, body);
    return { ...frame, ct: b64encode(new Uint8Array(ct)) };
};

const isNonEmptyString = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Shape check only (no crypto); false for anything that is not a well-formed frame. */
export const isFrameShaped = (frame) =>
    !!frame && typeof frame === 'object' && frame.v === FRAME_VERSION &&
    isNonEmptyString(frame.from, 128) && isNonEmptyString(frame.to, 128) &&
    isSeq(frame.seq) && Number.isInteger(frame.ts) &&
    isNonEmptyString(frame.n, 32) &&
    typeof frame.re === 'string' && frame.re.length <= 32 &&
    (frame.z === 0 || frame.z === 1) && typeof frame.ct === 'string';

/**
 * Verifies and decrypts a frame. `afterSeq` is the last counter accepted from this sender in
 * this direction: the frame's must be greater (callers record `frame.seq` once this resolves).
 * Throws CryptoError with code 'shape' | 'binding' | 'replay' | 'auth' | 'encoding' |
 * 'too_large'; callers must answer every one of them identically.
 */
export const openFrame = async ({ key, frame, from, to, re = '', afterSeq = 0, maxBytes = MAX_FRAME_BODY_BYTES }) => {
    if (!isFrameShaped(frame)) throw new CryptoError('shape', 'Malformed frame');
    if (frame.from !== String(from) || frame.to !== String(to) || frame.re !== String(re)) {
        throw new CryptoError('binding', 'Frame is not addressed to us');
    }
    if (frame.seq <= afterSeq) throw new CryptoError('replay', 'Frame sequence number already used');
    const iv = b64decodeExact(frame.n, 12);
    const ct = b64decode(frame.ct);
    let body;
    try {
        body = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: frameAad(frame) }, key, ct));
    } catch {
        throw new CryptoError('auth', 'Frame authentication failed');
    }
    if (frame.z === 1) {
        if (!hasCompression()) throw new CryptoError('encoding', 'Compressed frame not supported');
        body = await gunzipBytes(body, maxBytes);
    } else if (body.length > maxBytes) {
        throw new CryptoError('too_large', 'Frame body too large');
    }
    try {
        return JSON.parse(fromUtf8(body));
    } catch {
        throw new CryptoError('encoding', 'Frame body is not JSON');
    }
};
