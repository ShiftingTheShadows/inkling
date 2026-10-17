'use strict';
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { createServer } = require('./server');

const PORT = Number(process.env.INKLING_PORT) || 47831;
const ROOT = path.join(__dirname, 'web');

// AppImages can't ship a setuid chrome-sandbox helper; without this Chromium
// refuses to start on many distros. We only ever load our own local origin.
if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

let win = null;
let origin = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    let started;
    try {
      started = await createServer(ROOT, PORT);
    } catch (e) {
      dialog.showErrorBox('Inkling could not start', e.message);
      app.quit();
      return;
    }
    origin = `http://127.0.0.1:${started.port}`;
    if (started.fellBack) {
      dialog.showMessageBoxSync({
        type: 'warning', title: 'Inkling',
        message: `Port ${PORT} is in use, so Inkling started on a temporary port.`,
        detail: 'Your saved characters and chats live under the usual port, so they will not appear this session. Close whatever is using that port (or set INKLING_PORT) and relaunch.',
      });
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]));

    win = new BrowserWindow({
      width: 1280, height: 850, minWidth: 420, minHeight: 500,
      title: 'Inkling', backgroundColor: '#0a0a0a', autoHideMenuBar: true,
      icon: path.join(__dirname, 'icons', '512x512.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
    });
    win.on('closed', () => { win = null; });

    // Anything that isn't our own origin opens in the real browser
    const external = url => { if (/^https?:/i.test(url)) shell.openExternal(url); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); external(url); } });

    win.loadURL(origin);
  });

  app.on('window-all-closed', () => app.quit());
}
