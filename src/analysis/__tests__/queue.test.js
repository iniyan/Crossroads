import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalysisQueue, THROTTLE } from '../queue.js';

/** A worker stand-in that records posted messages and lets the test emit replies. */
function fakeWorker() {
    const w = {
        posted: [],
        transfers: [],
        terminated: false,
        onmessage: null,
        onerror: null,
        postMessage(msg, transfer) { w.posted.push(msg); w.transfers.push(transfer || null); },
        terminate() { w.terminated = true; },
        emit(data) { w.onmessage({ data }); },
        last(type) { return [...w.posted].reverse().find((m) => m.type === type); }
    };
    return w;
}

const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
const idleThrottle = { type: 'throttle', windowGapMs: THROTTLE.windowGapMs.idle, paused: false };

describe('createAnalysisQueue', () => {
    let workers;
    let results;
    let errors;
    let states;
    let progress;
    let cancels;
    let reads;
    let queue;

    beforeEach(() => {
        vi.useFakeTimers();
        workers = [];
        results = [];
        errors = [];
        states = [];
        progress = [];
        cancels = [];
        reads = [];
        queue = createAnalysisQueue({
            createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
            read: async (job, offset, length) => { reads.push([job.key, offset, length]); return new Uint8Array(length).fill(7); },
            onResult: (job, result) => results.push([job.key, result]),
            onError: (job, error) => errors.push([job.key, error.message]),
            onChange: (state) => states.push(state),
            onProgress: (p) => progress.push(p),
            onCancel: (job) => cancels.push(job.key),
            sizeOf: (job) => job.learnedSize || null
        });
    });
    afterEach(() => { queue.destroy(); vi.useRealTimers(); });

    it('runs jobs one at a time through a single worker and serves byte reads', async () => {
        expect(queue.add([{ key: 'a', size: 100, meta: { m: 1 } }, { key: 'b', size: 200, meta: {} }], { label: 'album' })).toBe(2);
        await flush();
        expect(workers.length).toBe(1);
        const w = workers[0];
        expect(w.posted[0]).toEqual(idleThrottle);
        expect(w.last('analyze')).toEqual({ type: 'analyze', id: 1, size: 100, meta: { m: 1 } });
        expect(queue.getState()).toMatchObject({ active: true, paused: false, pending: 1, done: 0, total: 2, label: 'album', current: { key: 'a' } });
        expect(queue.has('b')).toBe(true);
        expect(queue.isRunning('a')).toBe(true);

        w.emit({ type: 'read', id: 1, reqId: 5, offset: 10, length: 4 });
        await flush();
        expect(reads).toEqual([['a', 10, 4]]);
        const bytes = w.last('bytes');
        expect(bytes.reqId).toBe(5);
        expect(bytes.size).toBeNull();
        expect(new Uint8Array(bytes.buffer)).toEqual(new Uint8Array([7, 7, 7, 7]));

        const changesBefore = states.length;
        w.emit({ type: 'progress', id: 1, done: 1, total: 8 });
        expect(queue.getState().progress).toEqual({ done: 1, total: 8 });
        expect(progress).toEqual([{ done: 1, total: 8 }]);
        expect(states.length).toBe(changesBefore); // progress ticks do not go through onChange

        w.emit({ type: 'result', id: 1, result: { verdict: 'genuine' } });
        expect(results).toEqual([['a', { verdict: 'genuine' }]]);
        expect(queue.getState()).toMatchObject({ pending: 1, done: 1, total: 2, current: null });
        // The next job starts only after the track gap.
        expect(w.last('analyze').id).toBe(1);
        await flush(THROTTLE.trackGapMs.idle);
        expect(w.last('analyze')).toMatchObject({ id: 2, size: 200 });

        w.emit({ type: 'result', id: 2, result: { verdict: 'padded' } });
        await flush();
        expect(results.length).toBe(2);
        expect(queue.getState()).toMatchObject({ active: false, pending: 0, done: 0, total: 0, label: null });
        expect(workers.length).toBe(1); // the worker is kept for the next batch
    });

    it('transfers a buffer the view owns and copies a view over a shared buffer', async () => {
        const shared = new Uint8Array(64).fill(1);
        const owned = new Uint8Array(8).fill(2);
        const q = createAnalysisQueue({
            createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
            read: async (job, offset) => (offset === 0 ? shared.subarray(8, 16) : owned),
            onResult: () => {}
        });
        q.add([{ key: 'a', size: 1, meta: {} }]);
        await flush();
        const w = workers[0];
        w.emit({ type: 'read', id: 1, reqId: 1, offset: 0, length: 8 });
        await flush();
        expect(shared.buffer.byteLength).toBe(64);             // not detached
        expect(new Uint8Array(w.last('bytes').buffer)).toEqual(new Uint8Array(8).fill(1));
        expect(w.transfers[w.posted.length - 1]).toEqual([w.last('bytes').buffer]);
        w.emit({ type: 'read', id: 1, reqId: 2, offset: 100, length: 8 });
        await flush();
        expect(w.last('bytes').buffer).toBe(owned.buffer);     // exclusively owned: transferred as is
        q.destroy();
    });

    it('passes the file size the host learned back to the worker', async () => {
        queue.add([{ key: 'a', size: null, meta: {}, learnedSize: 12345 }]);
        await flush();
        const w = workers[0];
        w.emit({ type: 'read', id: 1, reqId: 1, offset: 0, length: 4 });
        await flush();
        expect(w.last('bytes').size).toBe(12345);
    });

    it('ignores duplicates and stale messages', async () => {
        queue.add([{ key: 'a', size: 1, meta: {} }]);
        expect(queue.add([{ key: 'a', size: 1, meta: {} }, { key: null }])).toBe(0);
        await flush();
        const w = workers[0];
        w.emit({ type: 'result', id: 99, result: {} }); // wrong id
        expect(results).toEqual([]);
        w.emit({ type: 'result', id: 1, result: { ok: true } });
        expect(results).toEqual([['a', { ok: true }]]);
        w.emit({ type: 'result', id: 1, result: { ok: true } }); // no current job any more
        expect(results.length).toBe(1);
    });

    it('cancelAll drops pending jobs, cancels the running one and aborts its reads', async () => {
        queue.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }, { key: 'c', size: 1, meta: {} }]);
        await flush();
        const w = workers[0];
        queue.cancelAll();
        expect(w.last('cancel')).toEqual({ type: 'cancel', id: 1 });
        expect(cancels).toEqual(['a']);
        expect(queue.has('b')).toBe(false);
        expect(queue.getState()).toMatchObject({ pending: 0, total: 1 });
        w.emit({ type: 'cancelled', id: 1 });
        await flush();
        expect(queue.getState().active).toBe(false);
        expect(results).toEqual([]);
        expect(queue.has('a')).toBe(false);
    });

    it('cancel(key) removes a pending job without touching the running one', async () => {
        queue.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }]);
        await flush();
        expect(queue.cancel('b')).toBe(true);
        expect(queue.cancel('zzz')).toBe(false);
        expect(queue.getState()).toMatchObject({ pending: 0, total: 1, current: { key: 'a' } });
        expect(workers[0].last('cancel')).toBeUndefined();
        expect(cancels).toEqual([]);
        expect(queue.cancel('a')).toBe(true);
        expect(workers[0].last('cancel')).toEqual({ type: 'cancel', id: 1 });
        expect(cancels).toEqual(['a']);
    });

    it('front jobs jump the queue', async () => {
        queue.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }]);
        await flush();
        queue.add([{ key: 'urgent', size: 1, meta: {} }], { front: true });
        workers[0].emit({ type: 'result', id: 1, result: {} });
        await flush(THROTTLE.trackGapMs.idle);
        expect(queue.getState().current.key).toBe('urgent');
    });

    it('throttles harder while music plays', async () => {
        queue.setPlaybackActive(true);
        queue.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }]);
        await flush();
        const w = workers[0];
        expect(w.posted[0]).toEqual({ type: 'throttle', windowGapMs: THROTTLE.windowGapMs.playing, paused: false });
        queue.setPlaybackActive(false);
        queue.setPlaybackActive(false);
        expect(w.posted.filter((m) => m.type === 'throttle').length).toBe(2);
        expect(w.last('throttle').windowGapMs).toBe(THROTTLE.windowGapMs.idle);
        queue.setPlaybackActive(true);
        w.emit({ type: 'result', id: 1, result: {} });
        await flush(THROTTLE.trackGapMs.idle);
        expect(w.last('analyze').id).toBe(1); // still waiting: the playing gap is longer
        await flush(THROTTLE.trackGapMs.playing - THROTTLE.trackGapMs.idle);
        expect(w.last('analyze').id).toBe(2);
    });

    it('pausing tells the worker to wait and holds the next job until resumed', async () => {
        queue.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }]);
        await flush();
        const w = workers[0];
        queue.setPaused(true);
        queue.setPaused(true);
        expect(w.last('throttle')).toEqual({ type: 'throttle', windowGapMs: THROTTLE.windowGapMs.idle, paused: true });
        expect(queue.getState().paused).toBe(true);
        w.emit({ type: 'result', id: 1, result: {} });
        await flush(THROTTLE.trackGapMs.idle * 5);
        expect(w.last('analyze').id).toBe(1);          // 'b' waits
        expect(queue.getState()).toMatchObject({ active: true, pending: 1 });
        queue.setPaused(false);
        expect(w.last('throttle').paused).toBe(false);
        await flush(THROTTLE.trackGapMs.idle);
        expect(w.last('analyze').id).toBe(2);
        // Pausing before any worker exists is remembered for its first message.
        const q2 = createAnalysisQueue({ createWorker: () => { const x = fakeWorker(); workers.push(x); return x; }, read: async () => new Uint8Array(0), onResult: () => {} });
        q2.setPaused(true);
        q2.add([{ key: 'z', size: 1, meta: {} }]);
        await flush(100);
        expect(workers.length).toBe(1);                 // nothing started while paused
        q2.setPaused(false);
        await flush();
        expect(workers[1].posted[0].paused).toBe(false);
        q2.destroy();
    });

    it('reports worker errors and read failures, and recovers from a crash', async () => {
        const failing = createAnalysisQueue({
            createWorker: () => { const w = fakeWorker(); workers.push(w); return w; },
            read: async () => { throw new Error('disk gone'); },
            onResult: (job, result) => results.push([job.key, result]),
            onError: (job, error) => errors.push([job.key, error.message])
        });
        failing.add([{ key: 'a', size: 1, meta: {} }, { key: 'b', size: 1, meta: {} }]);
        await flush();
        const w = workers[0];
        w.emit({ type: 'read', id: 1, reqId: 1, offset: 0, length: 10 });
        await flush();
        expect(w.last('bytes')).toEqual({ type: 'bytes', reqId: 1, error: 'disk gone' });
        w.emit({ type: 'error', id: 1, message: 'decode failed' });
        expect(errors).toEqual([['a', 'decode failed']]);
        await flush(THROTTLE.trackGapMs.idle);
        expect(w.last('analyze').id).toBe(2);
        w.onerror({ message: 'boom' });
        expect(w.terminated).toBe(true);
        expect(errors[1]).toEqual(['b', 'boom']);
        failing.add([{ key: 'c', size: 1, meta: {} }]);
        await flush(THROTTLE.trackGapMs.idle);
        expect(workers.length).toBe(2);
        expect(workers[1].last('analyze')).toMatchObject({ size: 1 });
        failing.destroy();
        expect(workers[1].terminated).toBe(true);
    });
});
