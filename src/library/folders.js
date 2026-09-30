// Folder tree derived from `song.folder` paths, relative to the common music root.
import { tierCounts } from './qualityGroups.js';
import { compareDiscTrack } from '../utils/list.js';

const splitPath = (p) => String(p || '').split(/[\\/]+/).filter(Boolean);
const dirnameSegments = (path) => splitPath(path).slice(0, -1);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const commonPrefix = (lists) => {
    if (lists.length === 0) return [];
    let prefix = lists[0];
    for (const list of lists) {
        let i = 0;
        while (i < prefix.length && i < list.length && prefix[i] === list[i]) i++;
        prefix = prefix.slice(0, i);
        if (prefix.length === 0) break;
    }
    return prefix;
};

const compareTracks = (a, b) =>
    compareDiscTrack(a, b) ||
    collator.compare(a.path || '', b.path || '');

/**
 * @typedef {Object} FolderNode
 * @property {string} name
 * @property {string[]} segments  Path relative to the root ([] for the root itself).
 * @property {FolderNode[]} children
 * @property {object[]} songs     Tracks directly in this folder (album order).
 * @property {number} count       Tracks in this folder and everything below it.
 * @property {{hires:number,cd:number,lossy:number,unknown:number}} tiers  Same scope as count.
 */

/** @returns {{ root: FolderNode, rootSegments: string[] }} */
export const buildFolderTree = (songs) => {
    const entries = (songs || []).map(song => ({
        song,
        segs: splitPath(song.folder || '').length ? splitPath(song.folder) : dirnameSegments(song.path)
    }));
    let rootSegments = commonPrefix(entries.map(e => e.segs));
    // Every track sits directly in the common folder (e.g. a single album): start one level
    // up so the folder itself is still visible and navigable.
    if (rootSegments.length > 0 && entries.every(e => e.segs.length === rootSegments.length)) {
        rootSegments = rootSegments.slice(0, -1);
    }
    const make = (name, segments) => ({ name, segments, children: [], songs: [], count: 0, tiers: null, _map: new Map() });
    const root = make(rootSegments[rootSegments.length - 1] || 'Library', []);
    for (const { song, segs } of entries) {
        let node = root;
        for (const name of segs.slice(rootSegments.length)) {
            let child = node._map.get(name);
            if (!child) {
                child = make(name, node.segments.concat(name));
                node._map.set(name, child);
            }
            node = child;
        }
        node.songs.push(song);
    }
    const finish = (node) => {
        node.children = [...node._map.values()].sort((a, b) => collator.compare(a.name, b.name));
        delete node._map;
        node.songs.sort(compareTracks);
        node.children.forEach(finish);
        const all = collectSongs(node);
        node.count = all.length;
        node.tiers = tierCounts(all);
    };
    finish(root);
    return { root, rootSegments };
};

/** Every track in the folder and below, folder's own tracks first, then subfolders in order. */
export const collectSongs = (node) => {
    const out = [...node.songs];
    for (const child of node.children) out.push(...collectSongs(child));
    return out;
};

/** Deepest node matching `segments` (a stale path after a rescan falls back to the nearest parent). */
export const findNode = (root, segments) => {
    let node = root;
    const matched = [];
    for (const name of segments || []) {
        const child = node.children.find(c => c.name === name);
        if (!child) break;
        node = child;
        matched.push(name);
    }
    return { node, segments: matched };
};
