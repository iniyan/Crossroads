import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getBlob, setBlob, deleteBlob, isBlobStoreInMemory } from '../blobStore.js';

describe('blobStore on IndexedDB', () => {
    it('round-trips structured values and deletes them', async () => {
        expect(await getBlob('missing')).toBeUndefined();
        const value = { fetchedAt: 123, entries: [['HD 650', 'oratory1990/over-ear/HD 650', 'oratory1990', null]], bytes: new Uint8Array([1, 2, 3]) };
        await setBlob('autoeqIndex', value);
        const read = await getBlob('autoeqIndex');
        expect(read).toEqual(value);
        expect(read).not.toBe(value);              // structured clone, not the same object
        expect(read.bytes).toBeInstanceOf(Uint8Array);
        expect(isBlobStoreInMemory()).toBe(false);

        await setBlob('autoeqIndex', { replaced: true });
        expect(await getBlob('autoeqIndex')).toEqual({ replaced: true });
        await deleteBlob('autoeqIndex');
        expect(await getBlob('autoeqIndex')).toBeUndefined();
        await expect(deleteBlob('never-there')).resolves.toBeUndefined();
    });

    it('persists across connections (the data is in the database, not the module)', async () => {
        await setBlob('k', [1, 2, 3]);
        const raw = await new Promise((resolve, reject) => {
            const req = indexedDB.open('crossroads-blobs');
            req.onsuccess = () => {
                const db = req.result;
                const get = db.transaction('blobs', 'readonly').objectStore('blobs').get('k');
                get.onsuccess = () => { resolve(get.result); db.close(); };
                get.onerror = () => reject(get.error);
            };
            req.onerror = () => reject(req.error);
        });
        expect(raw).toEqual([1, 2, 3]);
    });
});
