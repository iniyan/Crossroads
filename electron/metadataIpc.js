// IPC for the metadata tools (#20 tag writing, #22 .lrc sidecars, #23 playlist files).
// Registered from main.js with the pieces of its state it needs; every handler is
// restricted to the chosen music root (and to the paths the user picked in a dialog).

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { writeFlacTags, FlacTagError } = require('./flacTagWriter');
const { readTrackDetails, isInside } = require('./libraryScanner');

const SIDECAR_EXTENSIONS = new Set(['.lrc', '.txt']);
const PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8']);
const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;

// What the app sends to MusicBrainz (the renderer cannot set User-Agent itself).
const MUSICBRAINZ_USER_AGENT = 'Crossroads/1.0 (https://github.com/iniyan/Crossroads)';

/**
 * A path under the music root with one of `extensions`, resolved through symlinks.
 * Returns the real path or null. With `mustExist` false the parent directory is checked
 * instead of the file (a sidecar / playlist that will be created).
 */
async function resolveUnderRoot(root, filePath, extensions, { mustExist = true } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return null;
    if (!root) return null;
    const requested = path.resolve(filePath);
    if (!isInside(root, requested)) return null;
    if (!extensions.has(path.extname(requested).toLowerCase())) return null;
    try {
        const realRoot = await fsp.realpath(root);
        if (mustExist) {
            const real = await fsp.realpath(requested);
            return isInside(realRoot, real) ? real : null;
        }
        const realDir = await fsp.realpath(path.dirname(requested));
        const real = path.join(realDir, path.basename(requested));
        return isInside(realRoot, real) ? real : null;
    } catch {
        return null;
    }
}

/**
 * The { set, remove } operations as the writer expects them. Values must be strings (or a
 * list of strings; an empty list removes the key): anything else is an error rather than a
 * silent coercion, so a renderer bug can never turn into a removal. Keys are validated by
 * the writer itself.
 */
function sanitizeOps(ops) {
    if (!ops || typeof ops !== 'object') throw new Error('Tag operations required');
    if (ops.set !== undefined && (ops.set === null || typeof ops.set !== 'object' || Array.isArray(ops.set))) throw new Error('Tag operations required');
    if (ops.remove !== undefined && !Array.isArray(ops.remove)) throw new Error('Tag operations required');
    const set = {};
    const remove = [];
    for (const [key, value] of Object.entries(ops.set || {})) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some(v => typeof v !== 'string')) throw new Error(`Tag values must be strings (${key})`);
        set[key] = values;
    }
    for (const key of ops.remove || []) {
        if (typeof key !== 'string') throw new Error('Tag names must be strings');
        remove.push(key);
    }
    return { set, remove };
}

/** Writes `content` to `file` via a temp file in the same directory; the temp never outlives a failure. */
async function writeTextAtomically(file, content) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const handle = await fsp.open(tmp, 'wx');
    try {
        try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(tmp, file);
    } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw e;
    }
}

/**
 * @param {Object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow
 * @param {() => string|null} deps.getMusicRoot
 * @param {(file:string)=>Promise<string|null>} deps.resolveLibraryFile   main.js's audio-file resolver
 * @param {(run:Function)=>Promise} deps.enqueueIndexJob
 * @param {() => Promise<Object|null>} deps.getLibraryIndex
 * @param {(options:Object)=>number} deps.modelVersionOf
 */
function registerMetadataIpc({ ipcMain, dialog, getWindow, getMusicRoot, resolveLibraryFile, enqueueIndexJob, getLibraryIndex, modelVersionOf }) {
    // Paths the save dialog handed out and the renderer may now write once.
    const pendingPlaylistWrites = new Set();

    const showDialog = async (kind, options) => {
        const win = getWindow();
        const fn = kind === 'save' ? dialog.showSaveDialog : dialog.showOpenDialog;
        return win ? fn(win, options) : fn(options);
    };

    // --- #20: tag writing (FLAC only, inside the music root) ---------------------------------
    ipcMain.handle('app:writeTags', async (_event, filePath, ops, options) => {
        const file = await resolveLibraryFile(filePath);
        if (!file) throw new Error('File is not in the music library');
        if (path.extname(file).toLowerCase() !== '.flac') throw new Error('Only FLAC files can be written');
        const operations = sanitizeOps(ops);
        const modelVersion = modelVersionOf(options);
        return enqueueIndexJob(async () => {
            let result;
            try {
                result = await writeFlacTags(file, operations);
            } catch (e) {
                if (e instanceof FlacTagError) throw new Error(e.message);
                throw e;
            }
            // Drop the cached entry explicitly (never rely on size/mtime to notice the rewrite),
            // then re-parse the file into the index so the library is current.
            const index = await getLibraryIndex();
            if (result.changed && index) index.delete(file);
            const song = await readTrackDetails({ file, index, modelVersion });
            const requested = path.resolve(filePath);
            const reported = song && requested !== file ? { ...song, path: requested, folder: path.dirname(requested) } : song;
            return { ok: true, strategy: result.strategy, changed: result.changed, tags: result.tags, song: reported || null };
        });
    });

    // --- #22: .lrc sidecars ----------------------------------------------------------------
    ipcMain.handle('app:readSidecar', async (_event, filePath) => {
        const file = await resolveUnderRoot(getMusicRoot(), filePath, SIDECAR_EXTENSIONS);
        if (!file) return null;
        try {
            const st = await fsp.stat(file);
            if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) return null;
            return await fsp.readFile(file, 'utf8');
        } catch {
            return null;
        }
    });

    ipcMain.handle('app:writeSidecar', async (_event, filePath, content) => {
        if (typeof content !== 'string' || content.length > MAX_SIDECAR_BYTES) throw new Error('Invalid lyrics content');
        const file = await resolveUnderRoot(getMusicRoot(), filePath, new Set(['.lrc']), { mustExist: false });
        if (!file) throw new Error('Lyrics can only be saved next to tracks in the music library');
        await writeTextAtomically(file, content);
        return { ok: true, path: file };
    });

    // --- #23: playlist files ---------------------------------------------------------------
    ipcMain.handle('dialog:savePlaylist', async (_event, defaultName) => {
        const name = typeof defaultName === 'string' && defaultName.trim() ? defaultName.trim() : 'Playlist.m3u8';
        const root = getMusicRoot();
        const { canceled, filePath } = await showDialog('save', {
            title: 'Export playlist',
            defaultPath: root ? path.join(root, name) : name,
            filters: [{ name: 'M3U8 playlist', extensions: ['m3u8'] }, { name: 'M3U playlist', extensions: ['m3u'] }]
        });
        if (canceled || !filePath) return null;
        let target = path.resolve(filePath);
        if (!PLAYLIST_EXTENSIONS.has(path.extname(target).toLowerCase())) {
            // The OS dialog only confirmed overwriting `filePath`; a different final name must
            // not silently replace an existing file.
            target += '.m3u8';
            let exists = false;
            try { await fsp.stat(target); exists = true; } catch { /* does not exist */ }
            if (exists) throw new Error(`${path.basename(target)} already exists; pick the name including its extension`);
        }
        pendingPlaylistWrites.add(target);
        return { path: target, musicRoot: root };
    });

    ipcMain.handle('app:writePlaylist', async (_event, filePath, content) => {
        if (typeof filePath !== 'string' || !pendingPlaylistWrites.has(path.resolve(filePath))) {
            throw new Error('Playlist destination must be chosen through the save dialog');
        }
        if (typeof content !== 'string' || content.length > MAX_PLAYLIST_BYTES) throw new Error('Invalid playlist content');
        const target = path.resolve(filePath);
        pendingPlaylistWrites.delete(target);
        await writeTextAtomically(target, content);
        return { ok: true, path: target };
    });

    ipcMain.handle('dialog:openPlaylist', async () => {
        const root = getMusicRoot();
        const { canceled, filePaths } = await showDialog('open', {
            title: 'Import playlist',
            defaultPath: root || undefined,
            properties: ['openFile'],
            filters: [{ name: 'Playlists', extensions: ['m3u8', 'm3u'] }]
        });
        if (canceled || !filePaths || !filePaths[0]) return null;
        const file = path.resolve(filePaths[0]);
        if (!PLAYLIST_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('Not a playlist file');
        const st = await fsp.stat(file);
        if (!st.isFile() || st.size > MAX_PLAYLIST_BYTES) throw new Error('Playlist file too large');
        const content = await fsp.readFile(file, 'utf8');
        return { path: file, name: path.basename(file), content, musicRoot: root };
    });
}

/** Identifies the app to MusicBrainz, which the renderer's fetch cannot do itself. */
function installMusicBrainzUserAgent(session) {
    session.webRequest.onBeforeSendHeaders({ urls: ['https://musicbrainz.org/*'] }, (details, callback) => {
        const requestHeaders = { ...details.requestHeaders, 'User-Agent': MUSICBRAINZ_USER_AGENT };
        callback({ requestHeaders });
    });
}

module.exports = { registerMetadataIpc, installMusicBrainzUserAgent, resolveUnderRoot, sanitizeOps, writeTextAtomically, MUSICBRAINZ_USER_AGENT };
