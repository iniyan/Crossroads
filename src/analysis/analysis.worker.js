// Web Worker entry for the quality analyser. Protocol (see queue.js):
//   host -> worker: { type:'analyze', id, size, meta } | { type:'bytes', reqId, buffer|error, size? }
//                   | { type:'cancel', id } | { type:'throttle', windowGapMs, paused }
//   worker -> host: { type:'read', id, reqId, offset, length } | { type:'progress', id, done, total }
//                   | { type:'result', id, result } | { type:'error', id, message } | { type:'cancelled', id }
// `size` on a 'bytes' reply is the file size the host learned from the server (Content-Range)
// when the job started without one.

import { analyzeTrack, AnalysisCancelled } from './analyzeTrack.js';

const reads = new Map(); // reqId -> { resolve, reject }
let nextReqId = 1;
let current = null;      // { id, cancelled, source }
let windowGapMs = 30;
let paused = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSource(id, size) {
    return {
        size: Number.isFinite(size) && size > 0 ? size : null,
        read(offset, length) {
            return new Promise((resolve, reject) => {
                const reqId = nextReqId++;
                reads.set(reqId, { resolve, reject });
                self.postMessage({ type: 'read', id, reqId, offset, length });
            });
        }
    };
}

async function pauseBetweenWindows(job) {
    await sleep(windowGapMs);
    while (paused && !job.cancelled) await sleep(250);
}

async function run(job) {
    const source = makeSource(job.id, job.size);
    job.source = source;
    try {
        const result = await analyzeTrack(source, job.meta || {}, {
            onProgress: ({ done, total }) => self.postMessage({ type: 'progress', id: job.id, done, total }),
            shouldCancel: () => job.cancelled,
            pause: () => pauseBetweenWindows(job)
        });
        if (job.cancelled) self.postMessage({ type: 'cancelled', id: job.id });
        else self.postMessage({ type: 'result', id: job.id, result });
    } catch (e) {
        if (e instanceof AnalysisCancelled || job.cancelled) self.postMessage({ type: 'cancelled', id: job.id });
        else self.postMessage({ type: 'error', id: job.id, message: e && e.message ? e.message : String(e) });
    } finally {
        if (current === job) current = null;
        for (const { reject } of reads.values()) reject(new Error('job finished'));
        reads.clear();
    }
}

self.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    switch (msg.type) {
        case 'analyze':
            if (current) current.cancelled = true;
            current = { id: msg.id, size: msg.size, meta: msg.meta, cancelled: false, source: null };
            run(current);
            break;
        case 'bytes': {
            const pending = reads.get(msg.reqId);
            if (!pending) break;
            reads.delete(msg.reqId);
            if (current && current.source && current.source.size === null && Number.isFinite(msg.size) && msg.size > 0) {
                current.source.size = msg.size;
            }
            if (msg.error) pending.reject(new Error(msg.error));
            else pending.resolve(new Uint8Array(msg.buffer));
            break;
        }
        case 'cancel':
            if (current && current.id === msg.id) current.cancelled = true;
            break;
        case 'throttle':
            if (Number.isFinite(msg.windowGapMs)) windowGapMs = Math.max(0, msg.windowGapMs);
            if (typeof msg.paused === 'boolean') paused = msg.paused;
            break;
        default:
            break;
    }
};
