import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
    MAX_FRAME_BODY_BYTES, b64decode, b64encode, commitment, constantTimeEqual, deriveSessionKeys, discoveryTag, frameKeys,
    generateKeyPair, gunzipBytes, gzipBytes, importPublicKey, isFrameShaped, keyFingerprint, openFrame, pairingCode, pairingProof,
    pairingTranscript, randomBytes, sealFrame, sharedSecret, utf8
} from '../crypto.mjs';

const ltk = new Uint8Array(32).map((_, i) => i);

describe('bytes', () => {
    it('round-trips base64 and rejects junk', () => {
        const bytes = randomBytes(70000);
        expect(b64decode(b64encode(bytes))).toEqual(bytes);
        expect(b64encode(new Uint8Array(0))).toBe('');
        expect(() => b64decode('abc')).toThrow();
        expect(() => b64decode('ab$=')).toThrow();
        expect(() => b64decode(5)).toThrow();
    });

    it('compares in constant time semantics', () => {
        expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
        expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
        expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
        expect(constantTimeEqual('a', 'a')).toBe(false);
    });

    it('gzips and gunzips, refusing output above the cap (decompression bomb)', async () => {
        const big = utf8('x'.repeat(5000));
        const z = await gzipBytes(big);
        expect(z.length).toBeLessThan(200);
        expect(await gunzipBytes(z)).toEqual(big);
        await expect(gunzipBytes(z, 4999)).rejects.toMatchObject({ code: 'too_large' });
        expect(await gunzipBytes(z, 5000)).toEqual(big);
        // 64 MB of zeros gzips to ~64 KB; the stream stops long before inflating it all
        const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
        expect(bomb.length).toBeLessThan(100_000);
        const before = process.memoryUsage().rss;
        await expect(gunzipBytes(bomb, 1024 * 1024)).rejects.toMatchObject({ code: 'too_large' });
        expect(process.memoryUsage().rss - before).toBeLessThan(48 * 1024 * 1024);
        await expect(gunzipBytes(utf8('not gzip'))).rejects.toMatchObject({ code: 'encoding' });
    });
});

describe('pairing math', () => {
    it('both sides derive the same code and keys from the transcript', async () => {
        const server = await generateKeyPair();
        const client = await generateKeyPair();
        const clientNonce = randomBytes(16);
        const serverNonce = randomBytes(16);
        const parts = { serverId: 's', clientId: 'c', sessionId: 'sess', serverPub: server.publicKey, clientPub: client.publicKey, clientNonce, serverNonce };
        const t1 = pairingTranscript(parts);
        const t2 = pairingTranscript({ ...parts });
        expect(t1).toEqual(t2);
        const code = await pairingCode(t1);
        expect(code).toMatch(/^\d{6}$/);
        const ss1 = await sharedSecret(server.privateKey, client.publicKey);
        const ss2 = await sharedSecret(client.privateKey, server.publicKey);
        expect(ss1).toEqual(ss2);
        const k1 = await deriveSessionKeys(ss1, t1);
        const k2 = await deriveSessionKeys(ss2, t2);
        expect(k1.ltk).toEqual(k2.ltk);
        expect(k1.confirmKey).toEqual(k2.confirmKey);
        expect(await pairingProof(k1.confirmKey, 'server')).toEqual(await pairingProof(k2.confirmKey, 'server'));
        expect(await pairingProof(k1.confirmKey, 'server')).not.toEqual(await pairingProof(k1.confirmKey, 'client'));
        // a substituted public key (man in the middle) changes the code
        const mitm = await generateKeyPair();
        const codeMitm = await pairingCode(pairingTranscript({ ...parts, serverPub: mitm.publicKey }));
        expect(codeMitm === code).toBe(false);
    });

    it('commitment is deterministic and hides the nonce', async () => {
        const n = randomBytes(16);
        expect(await commitment(n)).toEqual(await commitment(n));
        expect((await commitment(n)).length).toBe(32);
        expect(await commitment(randomBytes(16))).not.toEqual(await commitment(n));
    });

    it('rejects invalid public keys', async () => {
        await expect(importPublicKey(new Uint8Array(65))).rejects.toMatchObject({ code: 'key' });
        await expect(importPublicKey(new Uint8Array(10))).rejects.toMatchObject({ code: 'key' });
        const bad = (await generateKeyPair()).publicKey.slice();
        bad[10] ^= 0xff;
        await expect(importPublicKey(bad)).rejects.toMatchObject({ code: 'key' });
    });

    it('fingerprints keys and salts discovery tags', async () => {
        const a = (await generateKeyPair()).publicKey;
        const b = (await generateKeyPair()).publicKey;
        expect(await keyFingerprint(a)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
        expect(await keyFingerprint(a)).toBe(await keyFingerprint(a));
        expect(await keyFingerprint(a)).not.toBe(await keyFingerprint(b));
        expect(await discoveryTag('desk-1', 'salt1')).toMatch(/^[0-9a-f]{16}$/);
        expect(await discoveryTag('desk-1', 'salt1')).toBe(await discoveryTag('desk-1', 'salt1'));
        expect(await discoveryTag('desk-1', 'salt2')).not.toBe(await discoveryTag('desk-1', 'salt1'));
        expect(await discoveryTag('desk-2', 'salt1')).not.toBe(await discoveryTag('desk-1', 'salt1'));
    });
});

describe('frames', () => {
    const now = 1_700_000_000_000;

    it('seals and opens with the right direction key, binding and counter', async () => {
        const keys = await frameKeys(ltk);
        const payload = { since: 3, delta: { favorites: {}, history: { 'a@1': {} } } };
        const frame = await sealFrame({ key: keys.c2s, from: 'phone', to: 'desk', seq: 1, payload, now });
        expect(frame.z).toBe(0);
        expect(frame.seq).toBe(1);
        expect(frame.ts).toBe(now);
        expect(isFrameShaped(frame)).toBe(true);
        expect(await openFrame({ key: keys.c2s, frame, from: 'phone', to: 'desk', afterSeq: 0 })).toEqual(payload);
        // the response is bound to the request nonce
        const reply = await sealFrame({ key: keys.s2c, from: 'desk', to: 'phone', seq: 7, re: frame.n, payload: { rev: 1 }, now });
        expect(await openFrame({ key: keys.s2c, frame: reply, from: 'desk', to: 'phone', re: frame.n, afterSeq: 6 })).toEqual({ rev: 1 });
        await expect(openFrame({ key: keys.s2c, frame: reply, from: 'desk', to: 'phone', re: 'other', afterSeq: 6 })).rejects.toMatchObject({ code: 'binding' });
        // wrong direction key
        await expect(openFrame({ key: keys.s2c, frame, from: 'phone', to: 'desk' })).rejects.toMatchObject({ code: 'auth' });
        // invalid counters cannot be sealed
        await expect(sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 0, payload: {}, now })).rejects.toMatchObject({ code: 'seq' });
        await expect(sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 1.5, payload: {}, now })).rejects.toMatchObject({ code: 'seq' });
    });

    it('refuses counters that did not advance (replay) and nothing depends on the clock', async () => {
        const keys = await frameKeys(ltk);
        const f5 = await sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 5, payload: { ok: 1 }, now });
        await expect(openFrame({ key: keys.c2s, frame: f5, from: 'a', to: 'b', afterSeq: 5 })).rejects.toMatchObject({ code: 'replay' });
        await expect(openFrame({ key: keys.c2s, frame: f5, from: 'a', to: 'b', afterSeq: 9 })).rejects.toMatchObject({ code: 'replay' });
        expect(await openFrame({ key: keys.c2s, frame: f5, from: 'a', to: 'b', afterSeq: 4 })).toEqual({ ok: 1 });
        // a frame sealed a year ago, or a year ahead, is fine as long as its counter is new
        const old = await sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 6, payload: { ok: 2 }, now: now - 365 * 86_400_000 });
        expect(await openFrame({ key: keys.c2s, frame: old, from: 'a', to: 'b', afterSeq: 5 })).toEqual({ ok: 2 });
        const future = await sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 7, payload: { ok: 3 }, now: now + 365 * 86_400_000 });
        expect(await openFrame({ key: keys.c2s, frame: future, from: 'a', to: 'b', afterSeq: 6 })).toEqual({ ok: 3 });
        // the counter is authenticated: bumping it on a captured frame fails the tag, not the counter check
        await expect(openFrame({ key: keys.c2s, frame: { ...f5, seq: 99 }, from: 'a', to: 'b', afterSeq: 5 })).rejects.toMatchObject({ code: 'auth' });
    });

    it('compresses large payloads transparently and caps what they may inflate to', async () => {
        const keys = await frameKeys(ltk);
        const payload = { text: 'y'.repeat(20000) };
        const frame = await sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 1, payload, now });
        expect(frame.z).toBe(1);
        expect(frame.ct.length).toBeLessThan(2000);
        expect(await openFrame({ key: keys.c2s, frame, from: 'a', to: 'b' })).toEqual(payload);
        await expect(openFrame({ key: keys.c2s, frame, from: 'a', to: 'b', maxBytes: 10_000 })).rejects.toMatchObject({ code: 'too_large' });
        // a hostile peer with a valid key sends a bomb: 64 MB of JSON, ~64 KB on the wire
        const bombBody = new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ pad: 'a'.repeat(64 * 1024 * 1024) }))));
        const iv = randomBytes(12);
        const head = { v: 2, from: 'a', to: 'b', seq: 2, ts: now, n: b64encode(iv), re: '', z: 1 };
        const aad = utf8(JSON.stringify([head.v, head.from, head.to, head.seq, head.ts, head.n, head.re, head.z]));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, keys.c2s, bombBody));
        const bomb = { ...head, ct: b64encode(ct) };
        expect(JSON.stringify(bomb).length).toBeLessThan(200_000);
        const before = process.memoryUsage().rss;
        await expect(openFrame({ key: keys.c2s, frame: bomb, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'too_large' });
        expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);   // never the whole bomb
        // an uncompressed body over the cap cannot even be sealed
        await expect(sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 3, payload: { pad: 'a'.repeat(MAX_FRAME_BODY_BYTES + 1) }, now })).rejects.toMatchObject({ code: 'too_large' });
    });

    it('detects tampering of ciphertext and of every authenticated header', async () => {
        const keys = await frameKeys(ltk);
        const frame = await sealFrame({ key: keys.c2s, from: 'a', to: 'b', seq: 1, payload: { ok: 1 }, now });
        const ct = b64decode(frame.ct);
        ct[0] ^= 1;
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, ct: b64encode(ct) }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'auth' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, ts: frame.ts + 1 }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'auth' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, z: 1 }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'auth' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, seq: 2 }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'auth' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, from: 'c' }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'binding' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, to: 'c' }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'binding' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, v: 1 }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'shape' });
        await expect(openFrame({ key: keys.c2s, frame: { ...frame, seq: '1' }, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'shape' });
        await expect(openFrame({ key: keys.c2s, frame: null, from: 'a', to: 'b' })).rejects.toMatchObject({ code: 'shape' });
    });
});
