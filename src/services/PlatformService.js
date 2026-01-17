import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { Filesystem } from '@capacitor/filesystem';
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
        // For Android, we might use a simple picker or a fixed directory for now
        // This part is complex on mobile due to Scoped Storage
        alert("Folder selection on Android is handled via system media scanning in this version.");
        return "/storage/emulated/0/Music";
    },

    scanFolder: async (path) => {
        if (isElectron) {
            return await window.electron.scanFolder(path);
        }
        // On Mobile, we'd typically use a native plugin to scan the MediaStore
        // For a prototype, we return an empty list or mock data
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
