import { describe, expect, it } from 'vitest';
import { buildFolderTree, collectSongs, findNode } from '../folders.js';

const s = (path, extra = {}) => ({ path, folder: path.slice(0, path.lastIndexOf('/')), title: path, quality: { tier: 'cd' }, ...extra });

describe('buildFolderTree', () => {
    const songs = [
        s('/storage/emulated/0/Music/Artist A/Album 1/02.flac', { trackNumber: 2, quality: { tier: 'hires' } }),
        s('/storage/emulated/0/Music/Artist A/Album 1/01.flac', { trackNumber: 1 }),
        s('/storage/emulated/0/Music/Artist B/Album 2/01.flac', { quality: { tier: 'lossy' } }),
        s('/storage/emulated/0/Music/Artist B/loose.flac', { quality: { tier: 'unknown' } })
    ];

    it('uses the common prefix as root and builds children', () => {
        const { root, rootSegments } = buildFolderTree(songs);
        expect(rootSegments.join('/')).toBe('storage/emulated/0/Music');
        expect(root.name).toBe('Music');
        expect(root.children.map(c => c.name)).toEqual(['Artist A', 'Artist B']);
        expect(root.count).toBe(4);
        expect(root.tiers).toEqual({ hires: 1, cd: 1, lossy: 1, unknown: 1 });
    });

    it('orders tracks in a folder and collects recursively', () => {
        const { root } = buildFolderTree(songs);
        const { node } = findNode(root, ['Artist A', 'Album 1']);
        expect(node.songs.map(x => x.trackNumber)).toEqual([1, 2]);
        expect(collectSongs(findNode(root, ['Artist B']).node).map(x => x.path)).toEqual([
            '/storage/emulated/0/Music/Artist B/loose.flac',
            '/storage/emulated/0/Music/Artist B/Album 2/01.flac'
        ]);
    });

    it('steps one level up when everything is in one folder', () => {
        const { root } = buildFolderTree([s('/m/Only/a.flac'), s('/m/Only/b.flac')]);
        expect(root.name).toBe('m');
        expect(root.children.map(c => c.name)).toEqual(['Only']);
    });

    it('handles multiple roots, Windows paths and empty libraries', () => {
        const { root } = buildFolderTree([s('/a/x/1.flac'), s('/b/y/1.flac')]);
        expect(root.children.map(c => c.name)).toEqual(['a', 'b']);
        const win = buildFolderTree([{ path: 'C:\\Music\\A\\1.flac', folder: 'C:\\Music\\A' }, { path: 'C:\\Music\\B\\1.flac', folder: 'C:\\Music\\B' }]);
        expect(win.root.name).toBe('Music');
        expect(buildFolderTree([]).root.count).toBe(0);
    });

    it('falls back to the nearest existing folder for stale paths', () => {
        const { root } = buildFolderTree(songs);
        expect(findNode(root, ['Artist A', 'Gone']).segments).toEqual(['Artist A']);
    });
});
