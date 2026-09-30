import { describe, expect, it, vi } from 'vitest';

// No fake-indexeddb here: Node has no indexedDB, so the store must fall back to memory.
describe('blobStore without IndexedDB', () => {
    it('falls back to an in-memory map and warns once', async () => {
        expect(globalThis.indexedDB).toBeUndefined();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getBlob, setBlob, deleteBlob, isBlobStoreInMemory } = await import('../blobStore.js');

        expect(await getBlob('x')).toBeUndefined();
        const value = { a: [1, { b: 2 }] };
        await setBlob('x', value);
        value.a.push('mutated after the write');
        expect(await getBlob('x')).toEqual({ a: [1, { b: 2 }] });   // cloned on write
        expect(isBlobStoreInMemory()).toBe(true);
        await deleteBlob('x');
        expect(await getBlob('x')).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/IndexedDB is unavailable/);
        warn.mockRestore();
    });
});
