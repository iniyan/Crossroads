import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_CACHED_BYTES, artworkCacheStats, clearArtworkCache, imageContentType, readEmbeddedPicture } from '../artwork.js';

// A fake music-metadata whose parseFile returns a picture of the requested size / format.
const fakeParser = (bytes, format) => () => Promise.resolve({
    parseFile: async () => ({ common: { picture: [{ type: 'Cover (front)', format, data: Buffer.alloc(bytes, 1) }] } })
});

describe('artwork cache', () => {
    afterEach(() => clearArtworkCache());

    it('only ever serves image content types', () => {
        expect(imageContentType('image/png')).toBe('image/png');
        expect(imageContentType('IMAGE/JPEG ')).toBe('image/jpeg');
        expect(imageContentType('text/html')).toBe('image/jpeg');
        expect(imageContentType('application/octet-stream')).toBe('image/jpeg');
        expect(imageContentType(undefined)).toBe('image/jpeg');
    });

    it('caps the cached bytes, not just the entry count', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-art-'));
        try {
            const size = 12 * 1024 * 1024; // 12 MB each: six would exceed the 64 MB cap
            for (let i = 0; i < 6; i++) {
                const file = path.join(dir, `${i}.flac`);
                await fs.writeFile(file, 'x');
                const pic = await readEmbeddedPicture(file, fakeParser(size, 'text/plain'));
                expect(pic.format).toBe('image/jpeg');
                expect(pic.data.length).toBe(size);
            }
            const stats = artworkCacheStats();
            expect(stats.bytes).toBeLessThanOrEqual(MAX_CACHED_BYTES);
            expect(stats.entries).toBe(5);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
