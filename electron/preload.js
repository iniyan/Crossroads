const { contextBridge, ipcRenderer } = require('electron');

// Subscribe to a main-process channel without leaking ipcRenderer or the IPC event object.
// `mapArgs` turns the raw IPC args into what the renderer callback should receive.
function subscribe(channel, callback, mapArgs) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, ...args) => callback(...mapArgs(args));
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electron', {
    selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
    scanFolder: (path, options) => ipcRenderer.invoke('app:scanFolder', path, options),
    getTrackDetails: (path, options) => ipcRenderer.invoke('app:getTrackDetails', path, options),
    // Metadata tools (electron/metadataIpc.js)
    writeTags: (path, ops, options) => ipcRenderer.invoke('app:writeTags', path, ops, options),
    readSidecar: (path) => ipcRenderer.invoke('app:readSidecar', path),
    writeSidecar: (path, content) => ipcRenderer.invoke('app:writeSidecar', path, content),
    savePlaylistDialog: (defaultName) => ipcRenderer.invoke('dialog:savePlaylist', defaultName),
    writePlaylist: (path, content) => ipcRenderer.invoke('app:writePlaylist', path, content),
    openPlaylist: () => ipcRenderer.invoke('dialog:openPlaylist'),
    getStore: (key) => ipcRenderer.invoke('store:get', key),
    setStore: (key, value) => ipcRenderer.invoke('store:set', key, value),
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    resize: (width, height) => ipcRenderer.send('window:resize', width, height),
    close: () => ipcRenderer.send('window:close'),

    // Events: each returns an unsubscribe function.
    onShortcut: (callback) => subscribe('shortcut', callback, ([type]) => [type]),
    onMenuScan: (callback) => subscribe('menu:scan', callback, () => []),
    platform: process.platform,
});
