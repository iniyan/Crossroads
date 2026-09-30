import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { normalizeSong, normalizeSongs } from '../library/normalize';
import { LIBRARY_MODEL_VERSION } from '../library/song';

const isElectron = !!(window.electron);
const isNative = Capacitor.isNativePlatform();
const isAndroid = isNative && Capacitor.getPlatform() === 'android';

// Native plugins implemented in android/app/src/main/java/com/crossroads/player/
const MediaLibrary = registerPlugin('MediaLibrary');
const MediaSession = registerPlugin('MediaSession');
const MediaFiles = registerPlugin('MediaFiles');   // SAF folder grants, tag writing, sidecars, playlist files

// Sentinel persisted as 'musicFolder' on Android: the library comes from MediaStore, not a folder.
const MEDIASTORE_SENTINEL = 'mediastore';

const PERMISSION_DENIED_MESSAGE =
    'Crossroads needs permission to read your music. Please allow access to music and audio in Settings > Apps > Crossroads > Permissions.';

const noop = () => {};

const ALREADY_URL = /^(https?:|data:|blob:|crossroads-media:)/i;

// Electron reports a main-process throw as "Error invoking remote method 'x': Error: msg".
const ipcError = (e) => {
    const message = String(e?.message || e || 'Unknown error').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    const error = new Error(message);
    error.code = e?.code || null;
    return error;
};

async function hasAudioPermission() {
    try {
        const status = await MediaLibrary.checkPermissions();
        return status?.audio === 'granted';
    } catch (e) {
        console.error('MediaLibrary.checkPermissions failed', e);
        return false;
    }
}

// MediaStore rows come back at once; files whose probe did not fit in `budgetMs` are marked
// provisional and finished on a background thread (see onLibraryIndexed).
const MEDIASTORE_FIRST_PASS_BUDGET_MS = 1500;

const withPictureUrls = (track) => ({
    ...track,
    picture: track.picture ? Capacitor.convertFileSrc(track.picture) : null,
    // Original content:// URI, for native consumers (the media-session artwork).
    rawPicture: track.picture || null
});

async function loadMediaStoreTracks() {
    const { tracks } = await MediaLibrary.getTracks({
        budgetMs: MEDIASTORE_FIRST_PASS_BUDGET_MS,
        modelVersion: LIBRARY_MODEL_VERSION
    });
    return (tracks || []).map(withPictureUrls);
}

// ---- Now-playing / media session -----------------------------------------------------------
//
// On Android this drives MediaSessionPlugin (media notification, lock-screen and headset
// controls, foreground service). Elsewhere it uses navigator.mediaSession, which Chromium wires
// to the OS (macOS Now Playing, Windows SMTC, Linux MPRIS, browser media hubs).

const MEDIA_ACTIONS = ['play', 'pause', 'next', 'prev', 'seekto', 'stop'];
const BROWSER_ACTION_MAP = {
    play: 'play',
    pause: 'pause',
    nexttrack: 'next',
    previoustrack: 'prev',
    seekto: 'seekto',
    stop: 'stop'
};

const browserMediaSession = () => (!isNative && typeof navigator !== 'undefined' && navigator.mediaSession) || null;

const finiteOr = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

function updateBrowserNowPlaying({ title, artist, album, artwork, duration, position, isPlaying }) {
    const ms = browserMediaSession();
    if (!ms) return;
    try {
        if (!title) {
            ms.metadata = null;
            ms.playbackState = 'none';
            return;
        }
        const artworkList = artwork ? [{ src: artwork }] : [];
        const current = ms.metadata;
        if (!current || current.title !== title || current.artist !== (artist || '') ||
            current.album !== (album || '') || (current.artwork?.[0]?.src || '') !== (artwork || '')) {
            ms.metadata = new MediaMetadata({ title, artist: artist || '', album: album || '', artwork: artworkList });
        }
        ms.playbackState = isPlaying ? 'playing' : 'paused';
        if (typeof ms.setPositionState === 'function') {
            const dur = finiteOr(duration, 0);
            if (dur > 0) {
                ms.setPositionState({
                    duration: dur,
                    playbackRate: 1,
                    position: Math.min(finiteOr(position, 0), dur)
                });
            } else {
                ms.setPositionState();
            }
        }
    } catch (e) {
        console.warn('mediaSession update failed', e);
    }
}

function onBrowserMediaAction(callback) {
    const ms = browserMediaSession();
    if (!ms) return noop;
    const registered = [];
    Object.entries(BROWSER_ACTION_MAP).forEach(([browserAction, action]) => {
        try {
            ms.setActionHandler(browserAction, (details) => {
                callback(action, action === 'seekto' ? details?.seekTime : undefined);
            });
            registered.push(browserAction);
        } catch (e) {
            // This browser does not support the action; ignore.
        }
    });
    return () => {
        registered.forEach((browserAction) => {
            try { ms.setActionHandler(browserAction, null); } catch (e) { /* ignore */ }
        });
    };
}

let notificationPermissionRequested = false;

const PlatformService = {
    isElectron: () => isElectron,

    supportsMiniMode: () => isElectron,

    convertFileSrc: (path) => {
        if (!path) return '';
        if (ALREADY_URL.test(path)) return path;
        if (isElectron) return `crossroads-media://track/${encodeURIComponent(path)}`;
        if (isNative) {
            // content:// URIs are already URI-safe; pass them through untouched.
            if (path.startsWith('content://')) return Capacitor.convertFileSrc(path);
            // Absolute paths are concatenated verbatim into the local-server URL, so each
            // segment must be percent-encoded for names containing '#', '?' or '%' to
            // survive (the server decodes them again via Uri.getPath()).
            if (path.startsWith('/')) {
                return Capacitor.convertFileSrc(path.split('/').map(encodeURIComponent).join('/'));
            }
        }
        return path;
    },

    getPlatform: async () => {
        if (isElectron) return window.electron.platform;
        const info = await Device.getInfo();
        return info.platform; // 'android', 'ios', 'web'
    },

    getStore: async (key) => {
        if (isElectron) {
            return await window.electron.getStore(key);
        }
        const { value } = await Preferences.get({ key });
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
    },

    setStore: async (key, value) => {
        if (isElectron) {
            return await window.electron.setStore(key, value);
        }
        await Preferences.set({
            key,
            value: typeof value === 'string' ? value : JSON.stringify(value)
        });
    },

    selectFolder: async () => {
        if (isElectron) {
            return await window.electron.selectFolder();
        }
        if (isAndroid) {
            try {
                const status = await MediaLibrary.requestPermissions();
                if (status?.audio === 'granted') return MEDIASTORE_SENTINEL;
            } catch (e) {
                console.error('MediaLibrary.requestPermissions failed', e);
            }
            alert(PERMISSION_DENIED_MESSAGE);
            return null;
        }
        return null;
    },

    // On Android the `path` argument is ignored (it is either the 'mediastore'
    // sentinel or a legacy '/storage/emulated/0/Music' value): the whole music
    // library is read from MediaStore. If permission has not been granted the
    // scan returns [] without prompting, so a launch-time scan never nags.
    // Results are normalised into the full Song model (src/library/song.js).
    scanFolder: async (path) => {
        if (isElectron) {
            return normalizeSongs(await window.electron.scanFolder(path, { modelVersion: LIBRARY_MODEL_VERSION }));
        }
        if (isAndroid) {
            try {
                if (!(await hasAudioPermission())) return [];
                return normalizeSongs(await loadMediaStoreTracks());
            } catch (e) {
                console.error('Failed to read music library', e);
                return [];
            }
        }
        return [];
    },

    // The full Song for one file (every tag including lyrics text, which scanFolder leaves
    // out of the bulk payload). null when the platform cannot provide it. `path` must belong
    // to the scanned library.
    getTrackDetails: async (path) => {
        if (!path) return null;
        try {
            if (isElectron) {
                const raw = await window.electron.getTrackDetails(path, { modelVersion: LIBRARY_MODEL_VERSION });
                return raw ? normalizeSong(raw) : null;
            }
            if (isAndroid) {
                if (!(await hasAudioPermission())) return null;
                const { track } = await MediaLibrary.getTrackDetails({ path, modelVersion: LIBRARY_MODEL_VERSION });
                return track ? normalizeSong(withPictureUrls(track)) : null;
            }
        } catch (e) {
            console.error('Failed to read track details', e);
        }
        return null;
    },

    // Android keeps indexing files that did not fit in the scan's time budget after
    // getTracks() returns; the callback fires when that background pass has finished
    // and a rescan would pick up the newly parsed metadata. Returns an unsubscribe.
    onLibraryIndexed: (callback) => {
        if (!isAndroid || typeof callback !== 'function') return noop;
        let handle = null;
        let removed = false;
        MediaLibrary.addListener('libraryIndexed', callback)
            .then((h) => {
                if (removed) h.remove();
                else handle = h;
            })
            .catch((e) => console.error('libraryIndexed listener failed', e));
        return () => {
            removed = true;
            if (handle) {
                handle.remove();
                handle = null;
            }
        };
    },

    // ---- Metadata tools: #20 tag writing, #22 .lrc sidecars, #23 playlist files -------------
    // Desktop: the Electron main process (electron/metadataIpc.js), restricted to the music
    // root. Android: the MediaFiles plugin over a Storage Access Framework folder grant.

    // The music folder on desktop; null on Android (MediaStore has no single root).
    getMusicRoot: async () => {
        if (!isElectron) return null;
        const folder = await window.electron.getStore('musicFolder');
        return typeof folder === 'string' && folder ? folder : null;
    },

    supportsTagWriting: () => isElectron || isAndroid,

    // Android only: whether a persisted folder grant covers `path` (desktop: always true).
    canAccessFile: async (path) => {
        if (isElectron) return true;
        if (!isAndroid) return false;
        try {
            const { granted } = await MediaFiles.canAccess({ path });
            return !!granted;
        } catch (e) {
            console.error('MediaFiles.canAccess failed', e);
            return false;
        }
    },

    // Android only: asks the user for a folder (ACTION_OPEN_DOCUMENT_TREE). Resolves to the
    // list of granted folders ({ uri, path }); empty when cancelled.
    requestFolderAccess: async () => {
        if (!isAndroid) return [];
        try {
            const { grants } = await MediaFiles.requestFolderAccess();
            return grants || [];
        } catch (e) {
            console.error('MediaFiles.requestFolderAccess failed', e);
            return [];
        }
    },

    // Writes { set: {KEY: [values]}, remove: [KEY] } to a FLAC file and returns
    // { ok, strategy, changed, song } with the re-read Song. Throws with a user-facing message;
    // on Android the error carries code 'NEEDS_ACCESS' when no folder grant covers the file.
    writeTags: async (path, ops) => {
        if (isElectron) {
            let result;
            try {
                result = await window.electron.writeTags(path, ops, { modelVersion: LIBRARY_MODEL_VERSION });
            } catch (e) {
                throw ipcError(e);
            }
            return { ...result, song: result?.song ? normalizeSong(result.song) : null };
        }
        if (isAndroid) {
            let result;
            try {
                result = await MediaFiles.writeTags({ path, ops });
            } catch (e) {
                const error = new Error(e?.message || 'Writing tags failed');
                error.code = e?.code || null;
                throw error;
            }
            const song = result?.changed ? await PlatformService.getTrackDetails(path) : null;
            return { ...result, song };
        }
        throw new Error('Tag editing is not available on this platform');
    },

    // Text of a .lrc sidecar (or null). Android needs a folder grant covering the file.
    readSidecar: async (path) => {
        if (!path) return null;
        try {
            if (isElectron) return await window.electron.readSidecar(path);
            if (isAndroid) {
                const { content } = await MediaFiles.readSidecar({ path });
                return typeof content === 'string' ? content : null;
            }
        } catch (e) {
            console.warn('Sidecar read failed', e);
        }
        return null;
    },

    writeSidecar: async (path, content) => {
        if (isElectron) return await window.electron.writeSidecar(path, content).catch((e) => { throw ipcError(e); });
        if (isAndroid) return await MediaFiles.writeSidecar({ path, content });
        throw new Error('Saving lyrics is not available on this platform');
    },

    // Saves a playlist file. `buildContent({ playlistDir, musicRoot })` is called once the
    // destination is known (desktop dialogs return the path first, so relative entries can be
    // computed). Resolves to { ok, path?, name? } or { canceled: true }.
    exportPlaylistFile: async ({ name, buildContent }) => {
        if (isElectron) {
            const target = await window.electron.savePlaylistDialog(name);
            if (!target) return { canceled: true };
            const slash = Math.max(target.path.lastIndexOf('/'), target.path.lastIndexOf('\\'));
            const playlistDir = slash > 0 ? target.path.slice(0, slash) : target.path;
            const content = buildContent({ playlistDir, musicRoot: target.musicRoot || null });
            return await window.electron.writePlaylist(target.path, content).catch((e) => { throw ipcError(e); });
        }
        if (isAndroid) {
            const content = buildContent({ playlistDir: null, musicRoot: null });
            return await MediaFiles.savePlaylist({ name, content });
        }
        throw new Error('Playlist export is not available on this platform');
    },

    // Opens a playlist file: { name, content, path|null, musicRoot|null } or { canceled: true }.
    importPlaylistFile: async () => {
        if (isElectron) {
            const result = await window.electron.openPlaylist().catch((e) => { throw ipcError(e); });
            return result || { canceled: true };
        }
        if (isAndroid) {
            const result = await MediaFiles.openPlaylist();
            return result?.canceled ? { canceled: true } : { ...result, musicRoot: null };
        }
        throw new Error('Playlist import is not available on this platform');
    },

    minimize: () => {
        if (isElectron) window.electron.minimize();
    },

    maximize: () => {
        if (isElectron) window.electron.maximize();
    },

    resize: (width, height) => {
        if (isElectron) window.electron.resize(width, height);
    },

    close: () => {
        if (isElectron) window.electron.close();
    },

    // callback receives (type) where type is 'playPause' | 'next' | 'prev'.
    onShortcut: (callback) => {
        if (isElectron && typeof window.electron.onShortcut === 'function') {
            const unsubscribe = window.electron.onShortcut(callback);
            return typeof unsubscribe === 'function' ? unsubscribe : noop;
        }
        return noop;
    },

    onMenuScan: (callback) => {
        if (isElectron && typeof window.electron.onMenuScan === 'function') {
            const unsubscribe = window.electron.onMenuScan(callback);
            return typeof unsubscribe === 'function' ? unsubscribe : noop;
        }
        return noop;
    },

    onBackButton: (callback) => {
        if (!isAndroid) return noop;
        let handle = null;
        let removed = false;
        App.addListener('backButton', callback)
            .then((h) => {
                if (removed) h.remove();
                else handle = h;
            })
            .catch((e) => console.error('backButton listener failed', e));
        return () => {
            removed = true;
            if (handle) {
                handle.remove();
                handle = null;
            }
        };
    },

    exitApp: () => {
        if (isNative) App.exitApp();
    },

    // Publishes the current track / playback state to the OS media session.
    // { title, artist, album, artwork, duration, position, isPlaying }; duration/position in
    // seconds. `artwork` on Android should be the raw content:// URI (song.rawPicture), on
    // Electron the data: URL. A missing title clears the session.
    updateNowPlaying: (state) => {
        if (isAndroid) {
            const { title, artist, album, artwork, duration, position, isPlaying } = state || {};
            MediaSession.update({
                title: title || '',
                artist: artist || '',
                album: album || '',
                artwork: artwork || '',
                duration: finiteOr(duration, 0),
                position: finiteOr(position, 0),
                isPlaying: !!isPlaying
            }).catch((e) => console.error('MediaSession.update failed', e));
            return;
        }
        updateBrowserNowPlaying(state || {});
    },

    clearNowPlaying: () => {
        if (isAndroid) {
            MediaSession.clear().catch((e) => console.error('MediaSession.clear failed', e));
            return;
        }
        updateBrowserNowPlaying({});
    },

    // Asks for the notification permission that makes the Android media notification visible
    // (Android 13+). Asked at most once per app session; playback works either way.
    ensureNotificationPermission: () => {
        if (!isAndroid || notificationPermissionRequested) return;
        notificationPermissionRequested = true;
        MediaSession.requestPermissions().catch((e) => console.warn('Notification permission request failed', e));
    },

    // callback receives (action, position): action is one of 'play' | 'pause' | 'next' | 'prev'
    // | 'seekto' | 'stop'; position (seconds) is only set for 'seekto'.
    onMediaAction: (callback) => {
        if (!isAndroid) return onBrowserMediaAction(callback);
        let handle = null;
        let removed = false;
        MediaSession.addListener('action', (event) => {
            const action = event?.action;
            if (!MEDIA_ACTIONS.includes(action)) return;
            callback(action, action === 'seekto' ? event.position : undefined);
        })
            .then((h) => {
                if (removed) h.remove();
                else handle = h;
            })
            .catch((e) => console.error('MediaSession listener failed', e));
        return () => {
            removed = true;
            if (handle) {
                handle.remove();
                handle = null;
            }
        };
    }
};

export default PlatformService;
