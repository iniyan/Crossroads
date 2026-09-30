const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const Store = require('electron-store');

const store = new Store();

const IS_DEV = !app.isPackaged && process.env.NODE_ENV !== 'production';
const DEV_URL = 'http://localhost:5173';
const MEDIA_SCHEME = 'crossroads-media';
const MEDIA_HOST = 'track';

// Production builds are served from dist/ over a privileged custom scheme rather than
// file://, so the renderer has a real origin (crossroads-app://app) and every response can
// carry the Content-Security-Policy header.
const APP_SCHEME = 'crossroads-app';
const APP_HOST = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const DIST_DIR = path.resolve(__dirname, '../dist');

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src 'self' blob: ${MEDIA_SCHEME}:`,
    `connect-src 'self' https://lrclib.net ${MEDIA_SCHEME}:`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'"
].join('; ');

const APP_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8'
};

// How many directory entries (subfolders / symlinks) a single folder scans in parallel.
const SCAN_CONCURRENCY = 8;

// Keys the renderer may read/write through the store bridge.
const STORE_KEYS = new Set(['stats', 'playlists', 'favorites', 'theme', 'musicFolder']);

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac']);

const MIME_TYPES = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.aac': 'audio/aac'
};

const WINDOW_MIN_WIDTH = 200;
const WINDOW_MIN_HEIGHT = 100;
const WINDOW_MAX_DIMENSION = 16384;

// Custom schemes must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
    {
        scheme: MEDIA_SCHEME,
        privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    },
    {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
]);

app.setName('Crossroads');

app.setAboutPanelOptions({
    applicationName: 'Crossroads',
    applicationVersion: '1.0.0',
    copyright: '© 2026 Crossroads Team',
    authors: ['Iniyan'],
    website: 'https://github.com/iniyan/Crossroads'
});

let mainWindow = null;

// The only folder the app is allowed to scan and serve audio from.
// Set exclusively via the directory picker in the main process (persisted as 'musicFolder').
let allowedMusicRoot = null;

function normalizeFolder(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const resolved = path.resolve(value);
    return path.isAbsolute(resolved) ? resolved : null;
}

allowedMusicRoot = normalizeFolder(store.get('musicFolder'));

function getWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendToRenderer(channel, ...args) {
    const win = getWindow();
    if (win) win.webContents.send(channel, ...args);
}

// Returns true when `candidate` (already resolved) sits inside `root` (already resolved).
// path.relative() normalises the result, so an escape can only show up as a leading '..'
// segment; a name that merely starts with dots ('...And Justice for All') is fine.
function isInside(root, candidate) {
    if (!root || !candidate) return false;
    const rel = path.relative(root, candidate);
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// True for URLs on the app's own origin (crossroads-app://app/...). Node's URL exposes
// origin 'null' for non-special schemes, so compare protocol and host explicitly.
function isAppUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
    } catch {
        return false;
    }
}

function isAllowedOrigin(url) {
    if (IS_DEV) {
        try { return new URL(url).origin === new URL(DEV_URL).origin; } catch { return false; }
    }
    return isAppUrl(url);
}

function setCustomMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: 'Crossroads',
            submenu: [
                { label: 'About Crossroads', role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { label: 'Hide Crossroads', role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { label: 'Quit Crossroads', role: 'quit' }
            ]
        }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Scan Folder',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => sendToRenderer('menu:scan')
                },
                { type: 'separator' },
                process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(process.platform === 'darwin' ? [
                    { type: 'separator' },
                    { role: 'front' },
                    { type: 'separator' },
                    { role: 'window' }
                ] : [
                    { role: 'close' }
                ])
            ]
        },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click: async () => {
                        await shell.openExternal('https://github.com/iniyan/Crossroads');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'Crossroads',
        width: 1000,
        height: 800,
        minWidth: 400,
        minHeight: 150, // Small for mini player
        frame: false, // Custom frame for that premium look
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        },
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
        icon: path.join(__dirname, '../assets/icon.png'),
    });

    // Never let the renderer navigate away from the app's own origin.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedOrigin(url)) event.preventDefault();
    });

    // Open http(s) links in the system browser; never spawn new Electron windows.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    if (IS_DEV) {
        mainWindow.loadURL(DEV_URL);
    } else {
        mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
    }
}

function registerMediaShortcuts() {
    globalShortcut.register('MediaPlayPause', () => sendToRenderer('shortcut', 'playPause'));
    globalShortcut.register('MediaNextTrack', () => sendToRenderer('shortcut', 'next'));
    globalShortcut.register('MediaPreviousTrack', () => sendToRenderer('shortcut', 'prev'));
}

function textResponse(status, message) {
    return new Response(message, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

// --- crossroads-app://app/<path under dist/> ---------------------------------------------------
// Serves the built renderer. Only files inside dist/ are reachable, and every response carries
// the CSP (a webRequest header hook would not apply to file:// loads, hence the scheme).
// Vite's `base: './'` makes index.html reference ./assets/..., which resolves against
// crossroads-app://app/index.html to crossroads-app://app/assets/....

async function handleAppRequest(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse(405, 'Method Not Allowed');
    }

    let url;
    try { url = new URL(request.url); } catch { return textResponse(400, 'Bad Request'); }
    if (url.host !== APP_HOST) return textResponse(403, 'Forbidden');

    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return textResponse(400, 'Bad Request'); }
    if (pathname.includes('\0')) return textResponse(400, 'Bad Request');
    if (pathname === '' || pathname === '/') pathname = '/index.html';

    const filePath = path.resolve(DIST_DIR, '.' + pathname);
    if (!isInside(DIST_DIR, filePath)) return textResponse(403, 'Forbidden');

    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch {
        return textResponse(404, 'Not Found');
    }
    if (!stat.isFile()) return textResponse(404, 'Not Found');

    const headers = {
        'Content-Type': APP_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-cache'
    };

    if (request.method === 'HEAD' || stat.size === 0) {
        return new Response(null, { status: 200, headers });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers });
}

// --- crossroads-media://track/<encodeURIComponent(absolutePath)> -------------------------------

async function resolveMediaPath(requestUrl) {
    let url;
    try { url = new URL(requestUrl); } catch { return null; }
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== MEDIA_HOST) return null;

    let decoded;
    try { decoded = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { return null; }
    if (!decoded || decoded.includes('\0')) return null;

    const root = allowedMusicRoot;
    if (!root) return null;

    const requested = path.resolve(decoded);
    if (!isInside(root, requested)) return null;

    // Also compare real paths so symlinks cannot escape the music root.
    try {
        const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(requested)]);
        if (!isInside(realRoot, realFile)) return null;
        return realFile;
    } catch (e) {
        // Lexically inside the root but does not exist: report as missing rather than forbidden.
        if (e && e.code === 'ENOENT') return { missing: true };
        return null;
    }
}

function parseRange(header, size) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return { invalid: true };
    const [, startStr, endStr] = match;
    if (startStr === '' && endStr === '') return { invalid: true };

    let start;
    let end;
    if (startStr === '') {
        // Suffix range: last N bytes.
        const suffix = Number(endStr);
        if (suffix === 0) return { invalid: true };
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(startStr);
        end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return { invalid: true };
    }
    return { start, end };
}

async function handleMediaRequest(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse(405, 'Method Not Allowed');
    }

    const filePath = await resolveMediaPath(request.url);
    if (!filePath) return textResponse(403, 'Forbidden');
    if (typeof filePath !== 'string') return textResponse(404, 'Not Found');

    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return textResponse(403, 'Forbidden');
    }

    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch {
        return textResponse(404, 'Not Found');
    }
    if (!stat.isFile()) return textResponse(404, 'Not Found');

    const size = stat.size;
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Last-Modified': stat.mtime.toUTCString()
    };

    const range = parseRange(request.headers.get('range'), size);
    if (range && range.invalid) {
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${size}` }
        });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const status = range ? 206 : 200;
    headers['Content-Length'] = String(end - start + 1);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    if (request.method === 'HEAD' || size === 0) {
        return new Response(null, { status, headers });
    }

    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status, headers });
}

// --- IPC ---------------------------------------------------------------------------------------

ipcMain.handle('dialog:openDirectory', async () => {
    const win = getWindow();
    const options = { properties: ['openDirectory'] };
    const { canceled, filePaths } = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    if (canceled || !filePaths || !filePaths[0]) return null;

    const folder = normalizeFolder(filePaths[0]);
    if (!folder) return null;

    allowedMusicRoot = folder;
    store.set('musicFolder', folder);
    return folder;
});

ipcMain.handle('store:get', (_event, key) => {
    if (typeof key !== 'string' || !STORE_KEYS.has(key)) return undefined;
    return store.get(key);
});

ipcMain.handle('store:set', (_event, key, value) => {
    if (typeof key !== 'string' || !STORE_KEYS.has(key)) return;
    if (key === 'musicFolder') {
        // Only the dialog path may change the music root; accept a renderer write only
        // when it merely echoes the folder that was already selected via the dialog.
        const folder = normalizeFolder(value);
        if (!folder || folder !== allowedMusicRoot) return;
    }
    if (value === undefined) {
        store.delete(key);
    } else {
        store.set(key, value);
    }
});

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            await fn(items[next++]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function getFilesRecursively(dir, realRoot, out = []) {
    let dirents;
    try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        console.warn('Skipping unreadable directory', dir, e.message);
        return out;
    }

    const subdirs = [];
    const symlinks = [];
    for (const dirent of dirents) {
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) subdirs.push(res);
        else if (dirent.isFile()) out.push(res);
        else if (dirent.isSymbolicLink()) symlinks.push(res);
    }

    // Never follow symlinked directories (loop protection). Symlinked files are fine
    // as long as they resolve to somewhere inside the music root.
    await mapLimit(symlinks, SCAN_CONCURRENCY, async (res) => {
        try {
            const real = await fsp.realpath(res);
            const st = await fsp.stat(real);
            if (st.isFile() && isInside(realRoot, real)) out.push(res);
        } catch {
            // Broken symlink or unreadable target; ignore.
        }
    });
    await mapLimit(subdirs, SCAN_CONCURRENCY, (sub) => getFilesRecursively(sub, realRoot, out));
    return out;
}

function detectFormat(file, metadata) {
    const ext = path.extname(file).slice(1).toUpperCase();
    const codec = String(metadata?.format?.codec || '').toUpperCase();
    const container = String(metadata?.format?.container || '').toUpperCase();
    if (ext === 'OGG' && codec.includes('OPUS')) return 'OPUS';
    if (ext === 'M4A' && codec.includes('ALAC')) return 'ALAC';
    if (container.includes('FLAC') || codec.includes('FLAC')) return 'FLAC';
    return ext || 'UNKNOWN';
}

ipcMain.handle('app:scanFolder', async (_event, folderPath) => {
    const requested = normalizeFolder(folderPath);
    if (!requested || !allowedMusicRoot || requested !== allowedMusicRoot) {
        throw new Error('Folder not permitted. Select it through the folder picker first.');
    }

    let realRoot;
    try {
        realRoot = await fsp.realpath(requested);
    } catch (e) {
        throw new Error(`Music folder is not accessible: ${e.message}`);
    }

    const allFiles = await getFilesRecursively(requested, realRoot);
    // The concurrent walk yields files in arrival order; sort for a stable library.
    const audioFiles = allFiles.filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase())).sort();

    const results = [];
    const mm = await import('music-metadata');

    for (const file of audioFiles) {
        try {
            const metadata = await mm.parseFile(file);
            const parentDir = path.dirname(file);
            const albumName = path.basename(parentDir);
            const artist = metadata.common.artist || 'Unknown Artist';

            results.push({
                path: file,
                title: metadata.common.title || path.basename(file),
                artist,
                // Only the explicit tag: the renderer groups albums by it and shows
                // 'Various Artists' for untagged compilations.
                albumArtist: metadata.common.albumartist || '',
                album: metadata.common.album || albumName,
                composer: metadata.common.composer?.[0] || metadata.common.composers?.[0] || '',
                format: detectFormat(file, metadata),
                duration: metadata.format.duration,
                bitrate: metadata.format.bitrate,
                sampleRate: metadata.format.sampleRate,
                bitsPerSample: metadata.format.bitsPerSample,
                lossless: metadata.format.lossless,
                picture: metadata.common.picture?.[0] ? `data:${metadata.common.picture[0].format};base64,${metadata.common.picture[0].data.toString('base64')}` : null
            });
        } catch (e) {
            console.error('Error parsing', file, e);
        }
    }
    return results;
});

// Window Controls
ipcMain.on('window:minimize', () => {
    const win = getWindow();
    if (win) win.minimize();
});
ipcMain.on('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
});
ipcMain.on('window:resize', (_event, width, height) => {
    const win = getWindow();
    if (!win) return;
    if (typeof width !== 'number' || typeof height !== 'number') return;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const w = Math.round(width);
    const h = Math.round(height);
    if (w < WINDOW_MIN_WIDTH || w > WINDOW_MAX_DIMENSION) return;
    if (h < WINDOW_MIN_HEIGHT || h > WINDOW_MAX_DIMENSION) return;
    win.setSize(w, h, true);
});
ipcMain.on('window:close', () => {
    const win = getWindow();
    if (win) win.close();
});

app.whenReady().then(() => {
    protocol.handle(MEDIA_SCHEME, handleMediaRequest);
    // In dev, Vite serves the renderer (and needs inline scripts / websockets for HMR).
    if (!IS_DEV) protocol.handle(APP_SCHEME, handleAppRequest);
    registerMediaShortcuts();
    setCustomMenu();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
