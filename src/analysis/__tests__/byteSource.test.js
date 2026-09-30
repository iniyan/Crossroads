import { describe, it, expect, vi } from 'vitest';
import { createFetchByteSource, MAX_FULL_BODY } from '../byteSource.js';

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xFF);

/** A fake local server: `mode` decides how it answers Range requests. */
function fakeFetch(mode, { size = FILE.length, calls = [] } = {}) {
    const body = (bytes) => ({
        arrayBuffer: async () => bytes.slice().buffer
    });
    return async (url, init) => {
        const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), size - 1);
        calls.push({ start, end: Number(range[2]), signal: init.signal });
        const headers = new Map();
        const res = (status, bytes) => ({ status, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, ...body(bytes) });
        switch (mode) {
            case 'range':
                headers.set('content-range', `bytes ${start}-${end}/${size}`);
                return res(206, FILE.subarray(start, end + 1));
            case 'range-unknown-total':
                headers.set('content-range', `bytes ${start}-${end}/*`);
                return res(206, FILE.subarray(start, end + 1));
            case 'from-zero': // Capacitor-style: 206, but the body starts at byte 0
                headers.set('content-range', `bytes 0-${end}/${size}`);
                return res(206, FILE.subarray(0, end + 1));
            case 'from-zero-short':
                headers.set('content-range', `bytes 0-${Math.min(end, 5)}/${size}`);
                return res(206, FILE.subarray(0, Math.min(end, 5) + 1));
            case 'full':
                headers.set('content-length', String(size));
                return res(200, FILE.subarray(0, size));
            case 'huge':
                headers.set('content-length', String(MAX_FULL_BODY + 1));
                return { status: 200, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, arrayBuffer: async () => { throw new Error('body must not be read'); } };
            case 'hang':
                return new Promise((resolve, reject) => {
                    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
                });
            case '416':
                return res(416, new Uint8Array(0));
            default:
                return res(500, new Uint8Array(0));
        }
    };
}

describe('createFetchByteSource', () => {
    it('serves Range requests, learns the size from Content-Range and returns owned buffers', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('range', { calls }) });
        expect(src.size).toBeNull();
        const a = await src.read(10, 4);
        expect(Array.from(a)).toEqual([10, 11, 12, 13]);
        expect(src.size).toBe(1000);
        expect(a.byteOffset).toBe(0);
        expect(a.byteLength).toBe(a.buffer.byteLength);
        expect(calls[0]).toMatchObject({ start: 10, end: 13 });
        // Reads are clamped to the learned size; past the end nothing is fetched.
        expect((await src.read(998, 10)).length).toBe(2);
        expect(calls[1]).toMatchObject({ start: 998, end: 999 });
        expect((await src.read(1000, 10)).length).toBe(0);
        expect(calls.length).toBe(2);
        expect((await src.read(5, 0)).length).toBe(0);
    });

    it('keeps the size unknown when the total is "*"', async () => {
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('range-unknown-total') });
        await src.read(0, 4);
        expect(src.size).toBeNull();
    });

    it('accepts a full 200 body once, then serves copies from memory', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('full', { calls }) });
        const a = await src.read(0, 64);
        expect(Array.from(a.subarray(0, 3))).toEqual([0, 1, 2]);
        expect(src.size).toBe(1000);
        // Simulate the queue transferring the buffer: the next read must still work.
        structuredClone(a.buffer, { transfer: [a.buffer] });
        expect(a.buffer.byteLength).toBe(0);
        const b = await src.read(0, 64);
        expect(Array.from(b.subarray(0, 3))).toEqual([0, 1, 2]);
        expect(b.buffer).not.toBe(a.buffer);
        expect(calls.length).toBe(1);
        expect((await src.read(990, 100)).length).toBe(10);
    });

    it('rejects a 200 whose announced length is too large before reading the body, and aborts it', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('huge', { calls }) });
        await expect(src.read(0, 64)).rejects.toThrow(/Range requests unsupported/);
        expect(calls[0].signal.aborted).toBe(true);
    });

    it('slices a 206 that starts at byte 0 but covers the request, and caches a whole-file body', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('from-zero', { calls }) });
        const a = await src.read(10, 4);
        expect(Array.from(a)).toEqual([10, 11, 12, 13]);
        expect(src.size).toBe(1000);
        const b = await src.read(990, 20); // reaches the end: the body is the whole file
        expect(Array.from(b)).toEqual(Array.from(FILE.subarray(990)));
        expect(calls.length).toBe(2);
        await src.read(3, 3);
        expect(calls.length).toBe(2);      // now served from memory
    });

    it('rejects a 206 that does not cover the request', async () => {
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('from-zero-short') });
        await expect(src.read(10, 4)).rejects.toThrow(/Range request not honoured/);
    });

    it('rejects an oversized mis-ranged 206 without reading it', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push(init);
            return { status: 206, headers: { get: (k) => (k === 'content-range' ? `bytes 0-${MAX_FULL_BODY + 10}/${MAX_FULL_BODY + 11}` : null) }, arrayBuffer: async () => { throw new Error('body must not be read'); } };
        };
        const src = createFetchByteSource('x', { fetchImpl });
        await expect(src.read(10, 4)).rejects.toThrow(/file this large/);
        expect(calls[0].signal.aborted).toBe(true);
    });

    it('416 is end of file, other statuses are errors', async () => {
        expect((await createFetchByteSource('x', { fetchImpl: fakeFetch('416') }).read(0, 4)).length).toBe(0);
        await expect(createFetchByteSource('x', { fetchImpl: fakeFetch('500') }).read(0, 4)).rejects.toThrow(/status 500/);
    });

    it('times out a hung read', async () => {
        vi.useFakeTimers();
        try {
            const src = createFetchByteSource('x', { fetchImpl: fakeFetch('hang'), timeoutMs: 50 });
            const p = src.read(0, 4);
            const outcome = p.then(() => 'resolved', (e) => e.message);
            await vi.advanceTimersByTimeAsync(60);
            expect(await outcome).toMatch(/timed out after 50 ms/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('abort() cancels in-flight reads and rejects every later read', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { fetchImpl: fakeFetch('hang', { calls }) });
        const p = src.read(0, 4);
        const outcome = p.then(() => 'resolved', (e) => e.name);
        src.abort();
        expect(calls[0].signal.aborted).toBe(true);
        expect(await outcome).toBe('AbortError');
        await expect(src.read(0, 4)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('a known size up front clamps the first request', async () => {
        const calls = [];
        const src = createFetchByteSource('x', { size: 20, fetchImpl: fakeFetch('range', { calls }) });
        await src.read(15, 100);
        expect(calls[0]).toMatchObject({ start: 15, end: 19 });
    });
});
