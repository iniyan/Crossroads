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
const ImageExport = registerPlugin('ImageExport');

// Sentinel persisted as 'musicFolder' on Android: the library comes from MediaStore, not a folder.
const MEDIASTORE_SENTINEL = 'mediastore';

const PERMISSION_DENIED_MESSAGE =
    'Crossroads needs permission to read your music. Please allow access to music and audio in Settings > Apps > Crossroads > Permissions.';

const noop = () => {};

const ALREADY_URL = /^(https?:|data:|blob:|crossroads-media:)/i;

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

    // Exports a PNG rendered in the renderer (Crossroads Wrapped slides, #27). `base64` is the
    // PNG without the data: prefix; `blob` the same bytes when available.
    //   Electron: native save dialog (main process validates the PNG bytes and the .png name).
    //   Android: the WebView has no Web Share API, so ImageExportPlugin writes the file to the
    //            app cache and opens the system share sheet via FileProvider (its targets include
    //            Photos / Files, so "save" is covered without a storage permission). The call
    //            resolves when the chooser opens, so the outcome is unknown: it is reported as
    //            "shared", never as saved.
    //   Browser: Web Share with files when available (same caveat), else a download link.
    // Resolves { saved, shared, message }: `saved` only when a file is known to exist on disk,
    // `shared` when a share sheet was opened; `message` (may be null) is shown to the user.
    exportImage: async ({ base64, filename, blob }) => {
        const name = filename || 'crossroads-wrapped.png';
        if (isElectron) {
            const result = await window.electron.saveImage(name, base64);
            if (result?.saved) return { saved: true, shared: false, message: `Saved to ${result.path}` };
            return { saved: false, shared: false, message: result?.canceled ? null : (result?.message || 'Not saved') };
        }
        if (isAndroid) {
            const result = await ImageExport.share({ base64, filename: name });
            const shared = !!result?.shared;
            return { saved: false, shared, message: shared ? 'Opened the share sheet.' : 'Could not open the share sheet.' };
        }
        const file = blob && typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null;
        if (file && typeof navigator !== 'undefined' && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
            try {
                await navigator.share({ files: [file], title: 'Crossroads Wrapped' });
                return { saved: false, shared: true, message: 'Shared.' };
            } catch (e) {
                if (e && e.name === 'AbortError') return { saved: false, shared: false, message: null };
            }
        }
        const bytes = blob || new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' });
        const url = URL.createObjectURL(bytes);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { saved: true, shared: false, message: `Downloaded ${name}` };
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
