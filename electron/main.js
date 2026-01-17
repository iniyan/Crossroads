const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const Store = require('electron-store');

const store = new Store();

app.setName('Crossroads');

app.setAboutPanelOptions({
    applicationName: 'Crossroads',
    applicationVersion: '1.0.0',
    copyright: '© 2026 Crossroads Team',
    authors: ['Iniyan'],
    website: 'https://github.com/iniyan/Crossroads'
});

let mainWindow;

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
                    click: () => mainWindow.webContents.send('menu:scan')
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
                        const { shell } = require('electron');
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
            webSecurity: false
        },
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#00000000',
        icon: path.join(__dirname, '../assets/icon.png'),
    });

    if (process.env.NODE_ENV !== 'production' && !app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Register Media Shortcuts
    globalShortcut.register('MediaPlayPause', () => {
        mainWindow.webContents.send('shortcut', 'playPause');
    });
    globalShortcut.register('MediaNextTrack', () => {
        mainWindow.webContents.send('shortcut', 'next');
    });
    globalShortcut.register('MediaPreviousTrack', () => {
        mainWindow.webContents.send('shortcut', 'prev');
    });

    setCustomMenu();
}

// IPC Handlers
ipcMain.handle('dialog:openDirectory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (canceled) return null;
    return filePaths[0];
});

ipcMain.handle('store:get', (event, key) => {
    return store.get(key);
});

ipcMain.handle('store:set', (event, key, value) => {
    store.set(key, value);
});

async function getFilesRecursively(dir) {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name);
        return dirent.isDirectory() ? getFilesRecursively(res) : res;
    }));
    return Array.prototype.concat(...files);
}

ipcMain.handle('app:scanFolder', async (_, folderPath) => {
    const allFiles = await getFilesRecursively(folderPath);
    const audioFiles = allFiles.filter(f => f.toLowerCase().endsWith('.flac'));

    const results = [];
    const mm = await import('music-metadata');

    for (const file of audioFiles) {
        try {
            const metadata = await mm.parseFile(file);
            const parentDir = path.dirname(file);
            const albumName = path.basename(parentDir);

            results.push({
                path: file,
                title: metadata.common.title || path.basename(file),
                artist: metadata.common.artist || 'Unknown Artist',
                album: metadata.common.album || albumName,
                composer: metadata.common.composer?.[0] || metadata.common.composers?.[0] || '',
                duration: metadata.format.duration,
                bitrate: metadata.format.bitrate,
                sampleRate: metadata.format.sampleRate,
                bitsPerSample: metadata.format.bitsPerSample,
                lossless: metadata.format.lossless,
                picture: metadata.common.picture?.[0] ? `data:${metadata.common.picture[0].format};base64,${metadata.common.picture[0].data.toString('base64')}` : null
            });
        } catch (e) {
            console.error('Error parsing', file, e);
        }
    }
    return results;
});

// Window Controls
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('window:resize', (event, width, height) => {
    mainWindow.setSize(width, height, true);
});
ipcMain.on('window:close', () => mainWindow.close());

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
