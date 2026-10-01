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

    // LAN sync host (#25, electron/sync/ipc.js). Every call resolves to the current status.
    sync: {
        getStatus: () => ipcRenderer.invoke('sync:getStatus'),
        setEnabled: (enabled) => ipcRenderer.invoke('sync:setEnabled', enabled),
        setDeviceName: (name) => ipcRenderer.invoke('sync:setDeviceName', name),
        openPairing: () => ipcRenderer.invoke('sync:openPairing'),
        closePairing: () => ipcRenderer.invoke('sync:closePairing'),
        confirmPairing: (sessionId, accept) => ipcRenderer.invoke('sync:confirmPairing', sessionId, accept),
        unpair: (deviceId) => ipcRenderer.invoke('sync:unpair', deviceId),
        onStatus: (callback) => subscribe('sync:status', callback, ([status]) => [status]),
        // A paired phone's request: callback({ id, peerId, payload }) must answer with exchangeResult.
        onExchange: (callback) => subscribe('sync:exchange', callback, ([request]) => [request]),
        exchangeResult: (id, result) => ipcRenderer.invoke('sync:exchangeResult', id, result)
    },
});
