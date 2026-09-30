// Byte source over a local file for Node (tests and the fixture pipeline). The app uses
// the fetch-backed source in ../byteSource.js; both expose { size, read(offset, length) }.
import fs from 'node:fs/promises';

export async function createFileByteSource(filePath) {
    const handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    return {
        size,
        async read(offset, length) {
            if (offset >= size || length <= 0) return new Uint8Array(0);
            const len = Math.min(length, size - offset);
            const buf = new Uint8Array(len);
            const { bytesRead } = await handle.read(buf, 0, len, offset);
            return bytesRead === len ? buf : buf.subarray(0, bytesRead);
        },
        async close() { await handle.close(); }
    };
}
