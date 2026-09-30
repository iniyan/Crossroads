// Background analysis queue: one worker, one job at a time, FIFO with "front" priority for
// jobs the user is looking at, cancelable, pausable (app in the background) and throttled
// (the worker sleeps between windows and between tracks; longer while music is playing so
// decoding never competes with playback, which matters on Android). Framework-free and
// testable with a fake worker.
//
// Byte reads go through the host (see `read`): the worker asks for byte ranges and the host
// answers with transferred ArrayBuffers. That keeps fetch() and its Range handling on the
// main thread where both platforms' local servers are known to serve it. `read` should
// return a Uint8Array that owns its whole buffer (then it is transferred, no copy); any
// other view is copied first so a shared buffer is never detached under the caller.

export const THROTTLE = Object.freeze({
    windowGapMs: { idle: 30, playing: 250 },
    trackGapMs: { idle: 150, playing: 1000 }
});

/**
 * @param {object} options
 * @param {() => Worker} options.createWorker
 * @param {(job, offset:number, length:number) => Promise<Uint8Array>} options.read
 * @param {(job, result) => void} options.onResult
 * @param {(job, error:Error) => void} [options.onError]
 * @param {(state) => void} [options.onChange]      job started / finished / queued / cancelled
 * @param {(progress) => void} [options.onProgress] per-window ticks of the running job
 * @param {(job) => void} [options.onCancel]        the running job is being cancelled (abort its reads)
 * @param {(job) => number|null} [options.sizeOf]  the file size learned by the host's reads, if any
 */
export function createAnalysisQueue({ createWorker, read, onResult, onError, onChange, onProgress, onCancel, sizeOf }) {
    const pending = [];          // jobs waiting: { key, size, meta, label, ...user fields }
    const keys = new Set();      // keys queued or running
    let worker = null;
    let current = null;          // running job
    let currentId = 0;
    let playing = false;
    let paused = false;
    let batch = { total: 0, done: 0, label: null };
    let progress = null;
    let destroyed = false;
    let idle = true;
    let nextTimer = null;

    const state = () => ({
        active: !!current || pending.length > 0,
        paused,
        current: current ? { key: current.key, label: current.label, meta: current.meta } : null,
        pending: pending.length,
        done: batch.done,
        total: batch.total,
        label: batch.label,
        progress
    });
    const emit = () => { if (onChange) onChange(state()); };
    const emitProgress = () => { if (onProgress) onProgress(progress); };

    const throttleMessage = () => ({
        type: 'throttle',
        windowGapMs: playing ? THROTTLE.windowGapMs.playing : THROTTLE.windowGapMs.idle,
        paused
    });

    function ensureWorker() {
        if (worker) return worker;
        worker = createWorker();
        worker.onmessage = (event) => handleMessage(event.data);
        worker.onerror = (event) => {
            const error = new Error(event && event.message ? event.message : 'analysis worker crashed');
            const job = current;
            try { worker.terminate(); } catch (e) { /* ignore */ }
            worker = null;
            current = null;
            progress = null;
            if (job) {
                keys.delete(job.key);
                batch.done++;
                if (onError) onError(job, error);
            }
            scheduleNext(THROTTLE.trackGapMs.idle);
        };
        worker.postMessage(throttleMessage());
        return worker;
    }

    async function serveRead(job, msg) {
        let buffer = null;
        let error = null;
        try {
            const bytes = await read(job, msg.offset, msg.length);
            // Transfer only a buffer the view owns outright; otherwise transfer a copy.
            buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                ? bytes.buffer
                : bytes.slice().buffer;
        } catch (e) {
            error = e && e.message ? e.message : String(e);
        }
        if (!worker || current !== job) return; // job cancelled meanwhile
        if (error) worker.postMessage({ type: 'bytes', reqId: msg.reqId, error });
        else {
            const size = sizeOf ? sizeOf(job) : null;
            worker.postMessage({ type: 'bytes', reqId: msg.reqId, buffer, size: Number.isFinite(size) && size > 0 ? size : null }, [buffer]);
        }
    }

    function finishCurrent() {
        const job = current;
        current = null;
        progress = null;
        if (job) keys.delete(job.key);
        batch.done++;
        scheduleNext(playing ? THROTTLE.trackGapMs.playing : THROTTLE.trackGapMs.idle);
        return job;
    }

    function handleMessage(msg) {
        if (!msg || !current || msg.id !== currentId) return;
        const job = current;
        switch (msg.type) {
            case 'read':
                serveRead(job, msg);
                break;
            case 'progress':
                progress = { done: msg.done, total: msg.total };
                emitProgress();
                break;
            case 'result':
                finishCurrent();
                onResult(job, msg.result);
                emit();
                break;
            case 'error':
                finishCurrent();
                if (onError) onError(job, new Error(msg.message || 'analysis failed'));
                emit();
                break;
            case 'cancelled':
                finishCurrent();
                emit();
                break;
            default:
                break;
        }
    }

    function scheduleNext(delay) {
        clearTimeout(nextTimer);
        if (destroyed) return;
        if (pending.length === 0) {
            if (!idle) { idle = true; batch = { total: 0, done: 0, label: null }; emit(); }
            return;
        }
        if (paused) return; // resumed by setPaused(false)
        nextTimer = setTimeout(startNext, delay);
    }

    function startNext() {
        if (destroyed || current || paused || pending.length === 0) return;
        current = pending.shift();
        currentId++;
        progress = null;
        ensureWorker().postMessage({ type: 'analyze', id: currentId, size: current.size, meta: current.meta || {} });
        emit();
    }

    function cancelRunning() {
        if (!current || !worker) return false;
        worker.postMessage({ type: 'cancel', id: currentId });
        if (onCancel) onCancel(current);
        return true;
    }

    return {
        /**
         * @param {Array<{ key:string, size:number|null, meta:object }>} jobs
         * @param {{ label?: string, front?: boolean }} [options]
         * @returns {number} jobs actually added (duplicates are skipped)
         */
        add(jobs, { label = null, front = false } = {}) {
            if (destroyed) return 0;
            let added = 0;
            const fresh = [];
            for (const job of jobs) {
                if (!job || !job.key || keys.has(job.key)) continue;
                keys.add(job.key);
                fresh.push({ ...job, label });
                added++;
            }
            if (added === 0) return 0;
            if (front) pending.unshift(...fresh);
            else pending.push(...fresh);
            if (idle) { idle = false; batch = { total: 0, done: 0, label }; }
            batch.total += added;
            if (label && !batch.label) batch.label = label;
            if (!current) scheduleNext(0);
            emit();
            return added;
        },

        /** Removes a pending job, or cancels it when it is the running one. */
        cancel(key) {
            const idx = pending.findIndex((j) => j.key === key);
            if (idx >= 0) {
                pending.splice(idx, 1);
                keys.delete(key);
                batch.total = Math.max(batch.done, batch.total - 1);
                if (pending.length === 0 && !current) scheduleNext(0);
                emit();
                return true;
            }
            if (current && current.key === key) return cancelRunning();
            return false;
        },

        cancelAll() {
            for (const j of pending) keys.delete(j.key);
            pending.length = 0;
            batch.total = batch.done + (current ? 1 : 0);
            if (!cancelRunning()) scheduleNext(0);
            emit();
        },

        setPlaybackActive(active) {
            const next = !!active;
            if (next === playing) return;
            playing = next;
            if (worker) worker.postMessage(throttleMessage());
        },

        /** Paused: the running job waits between windows and no further job starts. */
        setPaused(value) {
            const next = !!value;
            if (next === paused) return;
            paused = next;
            if (worker) worker.postMessage(throttleMessage());
            if (!paused && !current) scheduleNext(0);
            emit();
        },

        has: (key) => keys.has(key),
        isRunning: (key) => !!current && current.key === key,
        isPaused: () => paused,
        getState: state,
        getProgress: () => progress,

        destroy() {
            destroyed = true;
            clearTimeout(nextTimer);
            pending.length = 0;
            keys.clear();
            if (current && onCancel) onCancel(current);
            current = null;
            if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
        }
    };
}
