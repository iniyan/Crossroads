// Desktop harness: drives the IPC handlers of electron/metadataIpc.js the way the renderer
// does (through a fake ipcMain / dialog) against ffmpeg-encoded FLACs in a temporary music
// root, and checks the written files with ffmpeg (clean decode, decoded-PCM MD5 unchanged).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';   // the object metadataIpc.js requires: patchable
import fss from 'node:fs';
import { registerMetadataIpc, sanitizeOps, resolveUnderRoot, writeTextAtomically } from '../metadataIpc.js';
import { LibraryIndex } from '../libraryIndex.js';
import { isInside, AUDIO_EXTENSIONS } from '../libraryScanner.js';
import { readFlacTags } from '../flacTagWriter.js';
import { hasFfmpeg, makeFlac, withPadding, decodedMd5, decodesCleanly, ffmpegTags } from './helpers/flacFixtures.mjs';

const describeFfmpeg = hasFfmpeg() ? describe : describe.skip;

function fakeIpc() {
    const handlers = new Map();
    return {
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
        invoke: (channel, ...args) => handlers.get(channel)({}, ...args)
    };
}

describeFfmpeg('metadata IPC (desktop)', () => {
    let root;        // the music root
    let outside;     // a folder outside the root
    let userData;
    let index;
    let ipc;
    let dialogResult = null;

    beforeAll(async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-ipc-'));
        root = path.join(base, 'Music');
        outside = path.join(base, 'Elsewhere');
        userData = path.join(base, 'userData');
        await fs.mkdir(path.join(root, 'Album'), { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.mkdir(userData, { recursive: true });
        index = await new LibraryIndex(userData).load();

        ipc = fakeIpc();
        let chain = Promise.resolve();
        const resolveLibraryFile = async (filePath) => {
            if (typeof filePath !== 'string') return null;
            const requested = path.resolve(filePath);
            if (!isInside(root, requested) || !AUDIO_EXTENSIONS.has(path.extname(requested).toLowerCase())) return null;
            try { return await fs.realpath(requested); } catch { return null; }
        };
        registerMetadataIpc({
            ipcMain: ipc.ipcMain,
            dialog: {
                showSaveDialog: async () => dialogResult,
                showOpenDialog: async () => dialogResult
            },
            getWindow: () => null,
            getMusicRoot: () => root,
            resolveLibraryFile,
            enqueueIndexJob: (run) => { const r = chain.then(run, run); chain = r.catch(() => {}); return r; },
            getLibraryIndex: async () => index,
            modelVersionOf: (o) => (o && Number.isInteger(o.modelVersion) ? o.modelVersion : 0)
        });
    });

    afterAll(async () => { await fs.rm(path.dirname(root), { recursive: true, force: true }); });

    const putFlac = async (rel, buf) => {
        const file = path.join(root, rel);
        await fs.writeFile(file, buf);
        return file;
    };

    it('app:writeTags writes a FLAC in the root, keeps the audio decodable and identical, and refreshes the index', async () => {
        const file = await putFlac('Album/01.flac', withPadding(makeFlac({ tags: { title: 'Before', artist: 'Band' } }), 2048));
        const md5Before = decodedMd5(file);
        const result = await ipc.invoke('app:writeTags', file, { set: { TITLE: 'After', ALBUM: 'The Album' }, remove: ['ARTIST'] }, { modelVersion: 1 });
        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('rewrite');
        expect(result.changed).toBe(true);
        expect(result.tags).toMatchObject({ TITLE: ['After'], ALBUM: ['The Album'] });
        expect(result.song).toMatchObject({ path: file, title: 'After', album: 'The Album', format: 'FLAC' });
        expect(result.song.tags.ARTIST).toBeUndefined();
        expect(decodesCleanly(file)).toBe(true);
        expect(decodedMd5(file)).toBe(md5Before);
        expect(ffmpegTags(file)).toMatchObject({ title: 'After', album: 'The Album' });
        // The index is keyed by the real path (os.tmpdir() is a symlink on macOS).
        const real = await fs.realpath(file);
        const st = await fs.stat(real);
        expect(index.get(real, st.size, Math.round(st.mtimeMs))).toMatchObject({ title: 'After' });
    });

    it('app:writeTags rewrites when needed (picture kept) and the decoded audio stays identical', async () => {
        const file = await putFlac('Album/02.flac', makeFlac({ tags: { title: 'Pic' }, picture: true }));
        const md5Before = decodedMd5(file);
        // Well beyond whatever padding the encoder left: forces the temp-file rewrite path.
        const lyrics = Array.from({ length: 3000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00]line ${i} of the lyrics`).join('\n');
        const result = await ipc.invoke('app:writeTags', file, { set: { LYRICS: lyrics } });
        expect(result.strategy).toBe('rewrite');
        expect(decodesCleanly(file)).toBe(true);
        expect(decodedMd5(file)).toBe(md5Before);
        expect((await readFlacTags(file)).tags.LYRICS).toEqual([lyrics]);
        expect(result.song.hasEmbeddedLyrics).toBe(true);
        expect(result.song.picture).toMatch(/^crossroads-media:\/\/art\//);
        expect(await fs.readdir(path.join(root, 'Album'))).not.toContainEqual(expect.stringMatching(/\.tmp$/));
    });

    it('app:writeTags refuses files outside the root, non-FLAC files and bad operations', async () => {
        const away = path.join(outside, 'x.flac');
        await fs.writeFile(away, makeFlac());
        await expect(ipc.invoke('app:writeTags', away, { set: { TITLE: 'x' } })).rejects.toThrow(/not in the music library/);
        await expect(ipc.invoke('app:writeTags', path.join(root, '..', 'Elsewhere', 'x.flac'), { set: { TITLE: 'x' } })).rejects.toThrow(/not in the music library/);
        const mp3 = path.join(root, 'Album', 'song.mp3');
        await fs.writeFile(mp3, Buffer.from('ID3'));
        await expect(ipc.invoke('app:writeTags', mp3, { set: { TITLE: 'x' } })).rejects.toThrow(/Only FLAC/);
        const flac = await putFlac('Album/03.flac', makeFlac());
        await expect(ipc.invoke('app:writeTags', flac, { set: { 'BAD=KEY': 'x' } })).rejects.toThrow(/Invalid tag name/);
        await expect(ipc.invoke('app:writeTags', flac, null)).rejects.toThrow(/operations/);
        await expect(ipc.invoke('app:writeTags', flac, { set: { TITLE: 5 } })).rejects.toThrow(/must be strings/);
        expect(decodesCleanly(flac)).toBe(true);
    });

    it('app:writeTags drops the index entry explicitly before re-parsing', async () => {
        const file = await putFlac('Album/05.flac', withPadding(makeFlac({ tags: { title: 'Idx' } }), 2048));
        const real = await fs.realpath(file);
        const st = await fs.stat(real);
        // A stale entry with the same size/mtime as the file will have after the write would be trusted
        // if the handler relied on size/mtime alone.
        index.put(real, st.size, Math.round(st.mtimeMs), { title: 'STALE', path: real });
        const deleted = [];
        const origDelete = index.delete.bind(index);
        index.delete = (f) => { deleted.push(f); return origDelete(f); };
        try {
            const result = await ipc.invoke('app:writeTags', file, { set: { TITLE: 'Fresh' } }, { modelVersion: 1 });
            expect(result.song.title).toBe('Fresh');
        } finally {
            index.delete = origDelete;
        }
        expect(deleted).toEqual([real]);
        const now = await fs.stat(real);
        expect(index.get(real, now.size, Math.round(now.mtimeMs))).toMatchObject({ title: 'Fresh' });
    });

    it('sidecars are read and written only inside the root and only as .lrc', async () => {
        const track = await putFlac('Album/04.flac', makeFlac());
        const lrc = track.replace(/\.flac$/, '.lrc');
        expect(await ipc.invoke('app:readSidecar', lrc)).toBeNull();
        const written = await ipc.invoke('app:writeSidecar', lrc, '[00:01.00]Hello\n');
        expect(written.ok).toBe(true);
        expect(await ipc.invoke('app:readSidecar', lrc)).toBe('[00:01.00]Hello\n');
        await expect(ipc.invoke('app:writeSidecar', path.join(outside, 'x.lrc'), 'x')).rejects.toThrow(/music library/);
        await expect(ipc.invoke('app:writeSidecar', track, 'x')).rejects.toThrow(/music library/);
        expect(await ipc.invoke('app:readSidecar', track)).toBeNull();
        expect(await ipc.invoke('app:readSidecar', path.join(outside, 'x.lrc'))).toBeNull();
        expect(await fs.readdir(path.join(root, 'Album'))).not.toContainEqual(expect.stringMatching(/\.tmp$/));
    });

    it('playlists are written only to the path the save dialog returned, and read through the open dialog', async () => {
        dialogResult = { canceled: false, filePath: path.join(root, 'mine') };
        const target = await ipc.invoke('dialog:savePlaylist', 'mine.m3u8');
        expect(target).toEqual({ path: path.join(root, 'mine.m3u8'), musicRoot: root });
        await expect(ipc.invoke('app:writePlaylist', path.join(root, 'other.m3u8'), '#EXTM3U\n')).rejects.toThrow(/save dialog/);
        const written = await ipc.invoke('app:writePlaylist', target.path, '#EXTM3U\nAlbum/01.flac\n');
        expect(written.ok).toBe(true);
        // One-shot permission.
        await expect(ipc.invoke('app:writePlaylist', target.path, 'again')).rejects.toThrow(/save dialog/);
        expect(await fs.readFile(target.path, 'utf8')).toBe('#EXTM3U\nAlbum/01.flac\n');

        dialogResult = { canceled: false, filePaths: [target.path] };
        const opened = await ipc.invoke('dialog:openPlaylist');
        expect(opened).toEqual({ path: target.path, name: 'mine.m3u8', content: '#EXTM3U\nAlbum/01.flac\n', musicRoot: root });

        dialogResult = { canceled: true };
        expect(await ipc.invoke('dialog:savePlaylist', 'x.m3u8')).toBeNull();
        expect(await ipc.invoke('dialog:openPlaylist')).toBeNull();
    });

    it('the save dialog never appends an extension onto an existing file silently', async () => {
        await fs.writeFile(path.join(root, 'taken.m3u8'), '#EXTM3U\nold\n');
        dialogResult = { canceled: false, filePath: path.join(root, 'taken') };
        await expect(ipc.invoke('dialog:savePlaylist', 'taken.m3u8')).rejects.toThrow(/already exists/);
        await expect(ipc.invoke('app:writePlaylist', path.join(root, 'taken.m3u8'), 'new')).rejects.toThrow(/save dialog/);
        expect(await fs.readFile(path.join(root, 'taken.m3u8'), 'utf8')).toBe('#EXTM3U\nold\n');
        // The OS confirmed this exact name: overwriting it is what the user asked for.
        dialogResult = { canceled: false, filePath: path.join(root, 'taken.m3u8') };
        const target = await ipc.invoke('dialog:savePlaylist', 'taken.m3u8');
        expect(target.path).toBe(path.join(root, 'taken.m3u8'));
    });
});

describe('helpers', () => {
    it('sanitizeOps accepts strings / string lists and rejects everything else', () => {
        expect(sanitizeOps({ set: { A: ['1', '2'], B: 'x', C: [] }, remove: ['D'] })).toEqual({ set: { A: ['1', '2'], B: ['x'], C: [] }, remove: ['D'] });
        expect(() => sanitizeOps(null)).toThrow(/operations/);
        expect(() => sanitizeOps({ set: { A: ['1', 2] } })).toThrow(/must be strings/);
        expect(() => sanitizeOps({ set: { B: 5 } })).toThrow(/must be strings/);
        expect(() => sanitizeOps({ set: { B: null } })).toThrow(/must be strings/);
        expect(() => sanitizeOps({ set: { B: { nested: true } } })).toThrow(/must be strings/);
        expect(() => sanitizeOps({ remove: [5] })).toThrow(/must be strings/);
        expect(() => sanitizeOps({ set: [] })).toThrow(/operations/);
        expect(() => sanitizeOps({ remove: 'A' })).toThrow(/operations/);
    });

    it('writeTextAtomically leaves no temp behind on failure and can be retried', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-atomic-'));
        const target = path.join(dir, 'song.lrc');
        const originalOpen = fsp.open;
        let once = true;
        fsp.open = async (...args) => {
            const h = await originalOpen(...args);
            if (once) { once = false; h.writeFile = async () => { throw Object.assign(new Error('ENOSPC simulated'), { code: 'ENOSPC' }); }; }
            return h;
        };
        try {
            await expect(writeTextAtomically(target, 'x')).rejects.toThrow(/ENOSPC/);
            expect(fss.readdirSync(dir)).toEqual([]);
            await writeTextAtomically(target, 'second');
        } finally {
            fsp.open = originalOpen;
        }
        expect(await fs.readFile(target, 'utf8')).toBe('second');
        expect(fss.readdirSync(dir)).toEqual(['song.lrc']);
        // Rename failure (target directory vanished) also cleans up.
        const gone = path.join(dir, 'sub', 'x.lrc');
        await fs.mkdir(path.dirname(gone));
        const origRename = fsp.rename;
        fsp.rename = async () => { throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' }); };
        try {
            await expect(writeTextAtomically(gone, 'x')).rejects.toThrow(/EACCES/);
        } finally {
            fsp.rename = origRename;
        }
        expect(fss.readdirSync(path.dirname(gone))).toEqual([]);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('resolveUnderRoot rejects traversal, wrong extensions and null bytes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-root-'));
        await fs.writeFile(path.join(dir, 'a.lrc'), 'x');
        const exts = new Set(['.lrc']);
        expect(await resolveUnderRoot(dir, path.join(dir, 'a.lrc'), exts)).toBe(await fs.realpath(path.join(dir, 'a.lrc')));
        expect(await resolveUnderRoot(dir, path.join(dir, '..', 'a.lrc'), exts)).toBeNull();
        expect(await resolveUnderRoot(dir, path.join(dir, 'a.txt'), exts)).toBeNull();
        expect(await resolveUnderRoot(dir, path.join(dir, 'a\0.lrc'), exts)).toBeNull();
        expect(await resolveUnderRoot(dir, path.join(dir, 'new.lrc'), exts, { mustExist: false })).toBe(path.join(await fs.realpath(dir), 'new.lrc'));
        expect(await resolveUnderRoot(null, path.join(dir, 'a.lrc'), exts)).toBeNull();
        await fs.rm(dir, { recursive: true, force: true });
    });
});
