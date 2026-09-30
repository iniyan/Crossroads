import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PlatformService pulls in Capacitor; replace it with an in-memory store for these tests.
const platformStore = new Map();
vi.mock('../../services/PlatformService', () => ({
    default: {
        getStore: vi.fn(async (key) => (platformStore.has(key) ? platformStore.get(key) : null)),
        setStore: vi.fn(async (key, value) => { platformStore.set(key, value); })
    }
}));

const { getBlob, setBlob, deleteBlob } = await import('../../services/blobStore.js');
const Platform = (await import('../../services/PlatformService')).default;
const { loadAutoEqIndex, loadAutoEqProfile, cachedProfilePaths, migrateLegacyCache, resetAutoEqStoreForTests, INDEX_STORE_KEY, PROFILES_STORE_KEY } = await import('../autoeqStore.js');

const INDEX_MD = '- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990\n';
const PROFILE_TXT = 'Preamp: -6.1 dB\nFilter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70\n';
const okResponse = (text) => ({ ok: true, status: 200, text: async () => text });

beforeEach(async () => {
    platformStore.clear();
    vi.clearAllMocks();
    await deleteBlob(INDEX_STORE_KEY);
    await deleteBlob(PROFILES_STORE_KEY);
    resetAutoEqStoreForTests();
});

describe('autoeqStore', () => {
    it('caches the index and profiles in the blob store, not the platform store', async () => {
        const fetchImpl = vi.fn(async (url) => okResponse(url.endsWith('INDEX.md') ? INDEX_MD : PROFILE_TXT));
        const { entries, fromCache } = await loadAutoEqIndex({ fetchImpl });
        expect(fromCache).toBe(false);
        expect(entries[0].form).toBe('over-ear');
        expect((await getBlob(INDEX_STORE_KEY)).entries).toEqual([['Sennheiser HD 650', 'oratory1990/over-ear/Sennheiser HD 650', 'oratory1990', null]]);

        const profile = await loadAutoEqProfile(entries[0], { fetchImpl });
        expect(profile.filters).toHaveLength(1);
        expect(await cachedProfilePaths()).toEqual(['oratory1990/over-ear/Sennheiser HD 650']);
        expect((await loadAutoEqProfile(entries[0], { fetchImpl })).fromCache).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        // The platform store only ever saw the legacy-migration reads (and no writes with data).
        const writes = Platform.setStore.mock.calls.filter(([, value]) => value !== null);
        expect(writes).toEqual([]);
    });

    it('migrates a cache left in the platform store once and clears it there', async () => {
        platformStore.set(INDEX_STORE_KEY, { fetchedAt: Date.now(), entries: [['Old Phones', 'crinacle/711 in-ear/Old Phones', 'crinacle', '711']] });
        platformStore.set(PROFILES_STORE_KEY, { 'crinacle/711 in-ear/Old Phones': { name: 'Old Phones', text: PROFILE_TXT, fetchedAt: 1 } });

        const fetchImpl = vi.fn();
        const { entries, fromCache } = await loadAutoEqIndex({ fetchImpl });
        expect(fromCache).toBe(true);                       // fresh enough: no network
        expect(entries[0]).toMatchObject({ name: 'Old Phones', form: 'in-ear' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect((await getBlob(INDEX_STORE_KEY)).entries[0][0]).toBe('Old Phones');
        expect(await getBlob(PROFILES_STORE_KEY)).toHaveProperty('crinacle/711 in-ear/Old Phones');
        expect(platformStore.get(INDEX_STORE_KEY)).toBeNull();
        expect(platformStore.get(PROFILES_STORE_KEY)).toBeNull();

        const profile = await loadAutoEqProfile(entries[0], { fetchImpl });
        expect(profile.fromCache).toBe(true);
        expect(profile.preamp).toBe(-6.1);

        // Read once: further loads do not touch the legacy keys again.
        const reads = Platform.getStore.mock.calls.length;
        await cachedProfilePaths();
        await migrateLegacyCache();
        expect(Platform.getStore.mock.calls.length).toBe(reads);
    });

    it('does not overwrite an existing blob with a stale legacy copy', async () => {
        await setBlob(INDEX_STORE_KEY, { fetchedAt: Date.now(), entries: [['New', 'a/over-ear/New', 'x', null]] });
        platformStore.set(INDEX_STORE_KEY, { fetchedAt: 1, entries: [['Old', 'a/over-ear/Old', 'x', null]] });
        const { entries } = await loadAutoEqIndex({ fetchImpl: vi.fn() });
        expect(entries.map(e => e.name)).toEqual(['New']);
        expect(platformStore.get(INDEX_STORE_KEY)).toBeNull();
    });
});
