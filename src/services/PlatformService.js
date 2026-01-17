import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { Filesystem, FilesystemDirectory } from '@capacitor/filesystem';
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
        if (Capacitor.getPlatform && Capacitor.getPlatform() === 'android') {
            const status = await Filesystem.requestPermissions();
            if (status.publicStorage !== 'granted') {
                alert('Storage permission denied. Unable to access music files.');
                return null;
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
        if (Capacitor.getPlatform && Capacitor.getPlatform() === 'android') {
            try {
                const result = await Filesystem.readdir({
                    path,
                    directory: FilesystemDirectory.External
                });
                // Filter common audio extensions
                const audioFiles = result.files.filter(f => /\.(mp3|flac|wav|m4a)$/i.test(f));
                return audioFiles.map(f => ({ path: `${path}/${f}` }));
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
