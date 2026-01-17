const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
    scanFolder: (path) => ipcRenderer.invoke('app:scanFolder', path),
    getStore: (key) => ipcRenderer.invoke('store:get', key),
    setStore: (key, value) => ipcRenderer.invoke('store:set', key, value),
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    resize: (width, height) => ipcRenderer.send('window:resize', width, height),
    close: () => ipcRenderer.send('window:close'),

    // Events
    onShortcut: (callback) => ipcRenderer.on('shortcut', callback),
    onMenuScan: (callback) => ipcRenderer.on('menu:scan', callback),
    platform: process.platform,
});
