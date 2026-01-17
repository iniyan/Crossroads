import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const isElectron = !!(window.electron);

const PlatformService = {
    isElectron: () => isElectron,

    convertFileSrc: (path) => {
        if (!path) return '';
        if (path.startsWith('http') || path.startsWith('data:')) return path;
        if (isElectron) return `file://${path}`;
        return Capacitor.convertFileSrc(path);
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
        // Android: request storage permission and use default Music folder
        if (Capacitor.getPlatform() === 'android') {
            try {
                const status = await Filesystem.requestPermissions();
                // On Android 13+, it might be 'granted' but for specific media types
                // or 'status.publicStorage' might be the key
                if (status.publicStorage !== 'granted' && status.storage !== 'granted') {
                    // Check if it's already granted
                    const check = await Filesystem.checkPermissions();
                    if (check.publicStorage !== 'granted' && check.storage !== 'granted') {
                        alert('Storage permission is required to access music files. Please enable it in Settings.');
                        return null;
                    }
                }
            } catch (e) {
                console.error("Permission request failed", e);
            }
        }
        // Return the common external music directory
        return '/storage/emulated/0/Music';
    },

    scanFolder: async (path) => {
        if (isElectron) {
            return await window.electron.scanFolder(path);
        }
        // Android: read external storage directory for audio files
        if (Capacitor.getPlatform() === 'android') {
            try {
                const result = await Filesystem.readdir({
                    path,
                    directory: Directory.External
                });

                // Capacitor 6+ readdir results have a 'files' array of objects or strings
                const audioFiles = result.files.filter(f => {
                    const name = typeof f === 'string' ? f : f.name;
                    return /\.(mp3|flac|wav|m4a)$/i.test(name);
                });

                return audioFiles.map(f => ({
                    path: `${path}/${typeof f === 'string' ? f : f.name}`,
                    name: typeof f === 'string' ? f : f.name
                }));
            } catch (e) {
                console.error('Failed to read music folder', e);
                return [];
            }
        }
        // Fallback for other platforms
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

    onShortcut: (callback) => {
        if (isElectron) window.electron.onShortcut(callback);
    },

    onMenuScan: (callback) => {
        if (isElectron) window.electron.onMenuScan(callback);
    }
};

export default PlatformService;
