const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const Store = require('electron-store');
const { scanLibrary, readTrackDetails, isInside, AUDIO_EXTENSIONS, ART_HOST } = require('./libraryScanner');
const { LibraryIndex } = require('./libraryIndex');
const { readEmbeddedPicture } = require('./artwork');

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
    `img-src 'self' data: blob: ${MEDIA_SCHEME}:`,
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

// Keys the renderer may read/write through the store bridge.
const STORE_KEYS = new Set(['stats', 'playlists', 'favorites', 'theme', 'musicFolder', 'libraryFilters']);

const MIME_TYPES = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.ape': 'audio/x-ape',
    '.wv': 'audio/x-wavpack'
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
// --- crossroads-media://art/<encodeURIComponent(absolutePath)>  (embedded picture) -------------

async function resolveMediaPath(requestUrl, host = MEDIA_HOST) {
    let url;
    try { url = new URL(requestUrl); } catch { return null; }
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== host) return null;

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

async function handleArtRequest(request) {
    const filePath = await resolveMediaPath(request.url, ART_HOST);
    if (!filePath) return textResponse(403, 'Forbidden');
    if (typeof filePath !== 'string') return textResponse(404, 'Not Found');
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return textResponse(403, 'Forbidden');

    const picture = await readEmbeddedPicture(filePath);
    if (!picture) return textResponse(404, 'Not Found');
    const headers = {
        'Content-Type': picture.format,
        'Content-Length': String(picture.data.length),
        'Cache-Control': 'max-age=86400'
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(picture.data, { status: 200, headers });
}

async function handleMediaRequest(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse(405, 'Method Not Allowed');
    }

    let host = null;
    try { host = new URL(request.url).host; } catch { return textResponse(400, 'Bad Request'); }
    if (host === ART_HOST) return handleArtRequest(request);

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

// The persistent library index (userData/library-index.json): unchanged files are served
// from it instead of being re-parsed. One scan at a time; a second request waits, and
// single-track detail reads queue behind scans so index writes stay serialised.
let libraryIndexPromise = null;
let scanInFlight = Promise.resolve();

// The renderer's LIBRARY_MODEL_VERSION (src/library/song.js) as sent with the request.
function modelVersionOf(options) {
    const v = options && typeof options === 'object' ? options.modelVersion : undefined;
    return Number.isInteger(v) && v >= 0 ? v : 0;
}

function enqueueIndexJob(run) {
    const result = scanInFlight.then(run, run);
    scanInFlight = result.catch(() => {});
    return result;
}

// A file the renderer may ask details for: inside the music root (lexically and after
// resolving symlinks) with an audio extension. Returns the real path or null.
async function resolveLibraryFile(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return null;
    const root = allowedMusicRoot;
    if (!root) return null;
    const requested = path.resolve(filePath);
    if (!isInside(root, requested)) return null;
    if (!AUDIO_EXTENSIONS.has(path.extname(requested).toLowerCase())) return null;
    try {
        const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(requested)]);
        return isInside(realRoot, realFile) ? realFile : null;
    } catch {
        return null;
    }
}

function getLibraryIndex() {
    if (!libraryIndexPromise) {
        libraryIndexPromise = new LibraryIndex(app.getPath('userData')).load().catch((e) => {
            console.warn('Library index unavailable; scanning without cache', e.message);
            return null;
        });
    }
    return libraryIndexPromise;
}

ipcMain.handle('app:scanFolder', async (_event, folderPath, options) => {
    const requested = normalizeFolder(folderPath);
    if (!requested || !allowedMusicRoot || requested !== allowedMusicRoot) {
        throw new Error('Folder not permitted. Select it through the folder picker first.');
    }
    const modelVersion = modelVersionOf(options);

    return enqueueIndexJob(async () => {
        const index = await getLibraryIndex();
        const started = Date.now();
        const { songs, parsed, cached, pruned } = await scanLibrary({
            root: requested,
            index,
            modelVersion,
            onProgress: (progress) => sendToRenderer('library:scanProgress', progress)
        });
        console.log(`Library scan: ${songs.length} tracks (${parsed} parsed, ${cached} cached, ${pruned} pruned) in ${Date.now() - started} ms`);
        return songs;
    });
});

// Full tags (lyrics included) of one file under the music root; null when it is not there.
ipcMain.handle('app:getTrackDetails', async (_event, filePath, options) => {
    const file = await resolveLibraryFile(filePath);
    if (!file) return null;
    const modelVersion = modelVersionOf(options);
    return enqueueIndexJob(async () => {
        const index = await getLibraryIndex();
        // Report the path the renderer knows (the un-resolved one) so it matches the library.
        const song = await readTrackDetails({ file, index, modelVersion });
        if (!song) return null;
        const requested = path.resolve(filePath);
        return requested === file ? song : { ...song, path: requested, folder: path.dirname(requested) };
    });
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
