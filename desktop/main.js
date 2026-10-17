'use strict';
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { createServer } = require('./server');

const PORT = Number(process.env.INKLING_PORT) || 47831;
const ROOT = path.join(__dirname, 'web');

// AppImages can't ship a setuid chrome-sandbox helper; without this Chromium
// refuses to start on many distros. We only ever load our own local origin.
if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

// Black-window fix: GPU compositing is the usual culprit on Linux (Wayland,
// NVIDIA, VMs, missing GL drivers). A text chat app doesn't need it, so
// software rendering is the default. Set INKLING_GPU=1 to opt back in.
if (!process.env.INKLING_GPU) app.disableHardwareAcceleration();

let win = null;
let origin = '';

// Log to ~/.config/Inkling/inkling.log so a blank window can be diagnosed
const fs = require('fs');
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'inkling.log'), line); } catch {}
};

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
      title: 'Inkling', backgroundColor: '#0a0a0a', autoHideMenuBar: true, show: false,
      icon: path.join(__dirname, 'icons', '512x512.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
    });
    win.on('closed', () => { win = null; });

    // Anything that isn't our own origin opens in the real browser
    const external = url => { if (/^https?:/i.test(url)) shell.openExternal(url); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); external(url); } });

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log('did-fail-load', code, desc, url);
      win.loadURL('data:text/html,' + encodeURIComponent(
        `<body style="background:#0a0a0a;color:#ddd;font:14px monospace;padding:40px"><h2>Inkling couldn't load</h2><p>${desc} (${code})</p><p>Log: ${path.join(app.getPath('userData'), 'inkling.log')}</p>`));
    });
    win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone', d.reason, d.exitCode));
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) log('renderer:', msg); });
    win.once('ready-to-show', () => win.show());
    log('starting, origin', origin, 'gpu', process.env.INKLING_GPU ? 'on' : 'off');
    win.loadURL(origin);
  });

  app.on('window-all-closed', () => app.quit());
}
