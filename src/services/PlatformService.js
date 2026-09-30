import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';

const isElectron = !!(window.electron);
const isNative = Capacitor.isNativePlatform();
const isAndroid = isNative && Capacitor.getPlatform() === 'android';

// Native plugin implemented in android/app/src/main/java/com/crossroads/player/MediaLibraryPlugin.java
const MediaLibrary = registerPlugin('MediaLibrary');

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

async function loadMediaStoreTracks() {
    const { tracks } = await MediaLibrary.getTracks();
    return (tracks || []).map((track) => ({
        ...track,
        picture: track.picture ? Capacitor.convertFileSrc(track.picture) : null
    }));
}

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
    scanFolder: async (path) => {
        if (isElectron) {
            return await window.electron.scanFolder(path);
        }
        if (isAndroid) {
            try {
                if (!(await hasAudioPermission())) return [];
                return await loadMediaStoreTracks();
            } catch (e) {
                console.error('Failed to read music library', e);
                return [];
            }
        }
        return [];
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
    }
};

export default PlatformService;
