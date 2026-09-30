import { describe, it, expect, beforeEach } from 'vitest';
import { getBlob, setBlob, deleteBlob, getAllKeys, getAllBlobs, setBlobs, deleteBlobs, _resetBlobStoreForTests, DB_NAME, STORE_NAME } from '../blobStore.js';

// Node has no IndexedDB, so this exercises the in-memory fallback through the public API;
// the IndexedDB path is covered by the Electron harness (persistence across restarts).
describe('blobStore (memory fallback)', () => {
    beforeEach(() => { _resetBlobStoreForTests(); });

    it('names the shared database and store', () => {
        expect(DB_NAME).toBe('crossroads-blobs');
        expect(STORE_NAME).toBe('blobs');
    });

    it('get / set / delete', async () => {
        expect(await getBlob('k')).toBeUndefined();
        await setBlob('k', { a: 1 });
        expect(await getBlob('k')).toEqual({ a: 1 });
        await setBlob('k', 'text');
        expect(await getBlob('k')).toBe('text');
        await deleteBlob('k');
        expect(await getBlob('k')).toBeUndefined();
        await deleteBlob('missing');
    });

    it('prefix listing and bulk operations', async () => {
        await setBlobs([['qa:/m/a', 1], ['qa:/m/b', 2], ['other', 3]]);
        expect((await getAllKeys('qa:')).sort()).toEqual(['qa:/m/a', 'qa:/m/b']);
        expect((await getAllKeys()).length).toBe(3);
        const all = await getAllBlobs('qa:');
        expect(all).toBeInstanceOf(Map);
        expect(Array.from(all.entries()).sort()).toEqual([['qa:/m/a', 1], ['qa:/m/b', 2]]);
        await deleteBlobs(['qa:/m/a', 'nope']);
        expect(await getAllKeys('qa:')).toEqual(['qa:/m/b']);
        await setBlobs([]);
        await deleteBlobs([]);
    });
});
