import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INDEX_VERSION, LibraryIndex, RETRY_FAILED_MS, versionKey } from '../libraryIndex.js';

const isInside = (root, file) => file.startsWith(root + '/');

describe('LibraryIndex', () => {
    let dir;
    beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-index-')); });
    afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    it('serves entries that match size and mtime, and persists the model version', async () => {
        const index = await new LibraryIndex(dir).load();
        index.ensureModelVersion(1);
        index.put('/m/a.flac', 10, 20, { path: '/m/a.flac', title: 'A' });
        expect(index.get('/m/a.flac', 10, 20)).toEqual({ path: '/m/a.flac', title: 'A' });
        expect(index.get('/m/a.flac', 11, 20)).toBeNull();
        expect(await index.save()).toBe(true);

        const data = JSON.parse(await fs.readFile(path.join(dir, 'library-index.json'), 'utf8'));
        expect(data.version).toBe(versionKey(1));
        expect(data.version).toBe(`${INDEX_VERSION}.1`);
        expect(data.modelVersion).toBe(1);

        const again = await new LibraryIndex(dir).load();
        expect(again.ensureModelVersion(1)).toBe(false);
        expect(again.get('/m/a.flac', 10, 20)).toEqual({ path: '/m/a.flac', title: 'A' });
    });

    it('drops every entry when the renderer model version changes', async () => {
        const index = await new LibraryIndex(dir).load();
        index.ensureModelVersion(1);
        index.put('/m/a.flac', 10, 20, { title: 'A' });
        await index.save();

        const next = await new LibraryIndex(dir).load();
        expect(next.size).toBe(1);
        expect(next.ensureModelVersion(2)).toBe(true);
        expect(next.size).toBe(0);
        expect(next.get('/m/a.flac', 10, 20)).toBeNull();
    });

    it('ignores index files written by another INDEX_VERSION', async () => {
        await fs.writeFile(path.join(dir, 'library-index.json'), JSON.stringify({
            version: '1.1', modelVersion: 1, entries: { '/m/a.flac': { size: 10, mtime: 20, song: { title: 'A' } } }
        }));
        const index = await new LibraryIndex(dir).load();
        expect(index.size).toBe(0);
        expect(index.dirty).toBe(true);
    });

    it('caches failures only for RETRY_FAILED_MS', async () => {
        const index = await new LibraryIndex(dir).load();
        const failedAt = 1_000_000;
        index.put('/m/bad.flac', 10, 20, { title: 'bad' }, { failedAt });
        expect(index.isFailed('/m/bad.flac')).toBe(true);
        expect(index.get('/m/bad.flac', 10, 20, failedAt + 1000)).toEqual({ title: 'bad' });
        expect(index.get('/m/bad.flac', 10, 20, failedAt + RETRY_FAILED_MS)).toBeNull();
        index.put('/m/bad.flac', 10, 20, { title: 'good' });
        expect(index.isFailed('/m/bad.flac')).toBe(false);
        expect(index.get('/m/bad.flac', 10, 20, failedAt + 2 * RETRY_FAILED_MS)).toEqual({ title: 'good' });
    });

    it('prunes missing files under the root but never on an empty listing', async () => {
        const index = await new LibraryIndex(dir).load();
        index.put('/m/a.flac', 1, 1, {});
        index.put('/m/b.flac', 1, 1, {});
        index.put('/other/c.flac', 1, 1, {});
        expect(index.prune('/m', new Set(), isInside)).toBe(0);
        expect(index.size).toBe(3);
        expect(index.prune('/m', new Set(['/m/a.flac']), isInside)).toBe(1);
        expect([...index.entries.keys()].sort()).toEqual(['/m/a.flac', '/other/c.flac']);
    });
});
