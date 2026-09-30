// Byte source over an HTTP(-like) URL using Range requests. Both platforms serve library
// audio with Range support: Electron's crossroads-media:// handler and the Android
// RangeAwareWebViewClient. { size, read(offset, length) -> Promise<Uint8Array>, abort() }.
//
// Defensive on purpose, because a local server that misbehaves must never stall or bloat
// the analysis queue:
//   - a 200 (Range ignored) is only accepted when its announced length is small enough, and
//     the response is aborted before the body downloads otherwise;
//   - a 206 whose Content-Range does not start at the requested offset (Capacitor's
//     WebViewLocalServer has been seen answering from byte 0) is sliced when it covers the
//     request and rejected when it does not;
//   - every read has a timeout, and abort() cancels in-flight reads (queue cancellation).
//
// Every Uint8Array returned owns its ArrayBuffer exclusively, so the caller may transfer it.

export const MAX_FULL_BODY = 64 * 1024 * 1024;
export const READ_TIMEOUT_MS = 20000;

const parseContentRange = (header) => {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(header || '');
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
};

export function createFetchByteSource(url, { size = null, fetchImpl, timeoutMs = READ_TIMEOUT_MS, maxFullBody = MAX_FULL_BODY } = {}) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    const inFlight = new Set();
    let fullBody = null; // only when the server ignored Range (should not happen in the app)
    let aborted = false;

    const abortError = () => {
        const e = new Error('read aborted');
        e.name = 'AbortError';
        return e;
    };

    const source = {
        size,
        async read(offset, length) {
            if (aborted) throw abortError();
            if (length <= 0) return new Uint8Array(0);
            if (source.size !== null && offset >= source.size) return new Uint8Array(0);
            if (fullBody) return fullBody.slice(offset, offset + length);
            const end = source.size !== null ? Math.min(offset + length, source.size) - 1 : offset + length - 1;
            if (end < offset) return new Uint8Array(0);

            const controller = new AbortController();
            inFlight.add(controller);
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await doFetch(url, { headers: { Range: `bytes=${offset}-${end}` }, cache: 'no-store', signal: controller.signal });
                if (res.status === 206) {
                    const range = parseContentRange(res.headers.get('content-range'));
                    if (range && range.total !== null && range.total > 0) source.size = range.total;
                    if (!range || range.start === offset) {
                        return new Uint8Array(await res.arrayBuffer());
                    }
                    // Wrong start: usable only when the body still covers the requested range.
                    if (range.start > offset || range.end < end) {
                        controller.abort();
                        throw new Error(`Range request not honoured (asked ${offset}-${end}, got ${range.start}-${range.end})`);
                    }
                    if (range.end - range.start + 1 > maxFullBody) {
                        controller.abort();
                        throw new Error('Range request not honoured for a file this large');
                    }
                    const body = new Uint8Array(await res.arrayBuffer());
                    if (range.start === 0 && range.total !== null && body.length === range.total) {
                        fullBody = body; // the whole file came back: serve everything else from it
                        source.size = body.length;
                    }
                    return body.slice(offset - range.start, offset - range.start + length);
                }
                if (res.status === 416) return new Uint8Array(0);
                if (res.status === 200) {
                    const announced = Number(res.headers.get('content-length'));
                    if (Number.isFinite(announced) && announced > maxFullBody) {
                        controller.abort();
                        throw new Error('Range requests unsupported for a file this large');
                    }
                    const body = new Uint8Array(await res.arrayBuffer());
                    if (body.length > maxFullBody) throw new Error('Range requests unsupported for a file this large');
                    fullBody = body;
                    source.size = body.length;
                    return body.slice(offset, offset + length);
                }
                throw new Error(`Audio fetch failed with status ${res.status}`);
            } catch (e) {
                if (e && e.name === 'AbortError') throw aborted ? abortError() : new Error(`Audio read timed out after ${timeoutMs} ms`);
                throw e;
            } finally {
                clearTimeout(timer);
                inFlight.delete(controller);
            }
        },
        /** Cancels in-flight reads; every later read rejects with an AbortError. */
        abort() {
            aborted = true;
            for (const c of inFlight) c.abort();
            inFlight.clear();
        }
    };
    return source;
}
