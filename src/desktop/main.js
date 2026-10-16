'use strict';

// AirFlash desktop shell: runs an AirFlash node in-process and shows its UI in a
// window. Closing the window keeps it running in the tray so you can still receive.

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startNode } = require('../core');

const ASSETS = path.join(__dirname, 'assets');
const isMac = process.platform === 'darwin';
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let node = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(boot).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
app.setAppUserModelId('app.airflash.desktop'); // needed for Windows notifications

function computerName() {
  let name = os.hostname().replace(/\.local$/i, '');
  if (isMac) {
    try { name = require('node:child_process').execSync('scutil --get ComputerName', { encoding: 'utf8' }).trim() || name; } catch {}
  }
  return name;
}

function receivedDir() {
  return path.join(app.getPath('downloads'), 'AirFlash');
}

async function boot() {
  node = await startNode({
    name: computerName(),
    dataDir: path.join(app.getPath('temp'), 'airflash'),
    log: (m) => console.log(m),
  });
  wireDownloads();
  wireIpc();
  createWindow();
  createTray();
  if (isMac) app.dock?.setIcon?.(nativeImage.createFromPath(path.join(__dirname, '..', 'web', 'icons', 'icon-512.png')));
}

function appOrigin() {
  return `http://localhost:${node.port}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'AirFlash',
    backgroundColor: '#0b0d14',
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, '..', 'web', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep receiving events while hidden in the tray
    },
  });
  win.loadURL(`${appOrigin()}/`);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('focus', () => win.flashFrame(false));

  // Links in text snippets open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appOrigin() + '/')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = isMac
    ? nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('AirFlash');
  const rebuild = () => {
    const login = app.getLoginItemSettings();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open AirFlash', click: showWindow },
      { label: 'Connect a phone…', click: () => { showWindow(); win.webContents.send('open-connect'); } },
      { type: 'separator' },
      { label: 'Open received files', click: openReceived },
      {
        label: 'Start when I log in',
        type: 'checkbox',
        checked: login.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ['--hidden'] });
          rebuild();
        },
      },
      { type: 'separator' },
      { label: 'Quit AirFlash', click: () => app.quit() },
    ]));
  };
  rebuild();
  tray.on('click', () => { if (!isMac) showWindow(); });
}

function openReceived() {
  fs.mkdirSync(receivedDir(), { recursive: true });
  shell.openPath(receivedDir());
}

/** Save straight into Downloads/AirFlash, like AirDrop does, instead of asking every time. */
function wireDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const dir = receivedDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = uniquePath(dir, path.basename(item.getFilename() || 'file'));
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      win?.webContents.send('download-done', { name: path.basename(target), path: target, state });
    });
  });
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function wireIpc() {
  const fromApp = (e) => {
    try { return new URL(e.senderFrame.url).origin === appOrigin(); } catch { return false; }
  };
  ipcMain.on('show-item', (e, p) => {
    if (!fromApp(e) || typeof p !== 'string') return;
    const resolved = path.resolve(p);
    if (resolved.startsWith(receivedDir() + path.sep)) shell.showItemInFolder(resolved);
  });
  ipcMain.on('open-downloads', (e) => { if (fromApp(e)) openReceived(); });
  ipcMain.on('focus', (e) => { if (fromApp(e)) showWindow(); });
  ipcMain.on('set-badge', (e, n) => {
    if (!fromApp(e)) return;
    const count = Math.max(0, Number(n) || 0);
    if (isMac) app.setBadgeCount(count);
    else if (count && win && !win.isFocused()) win.flashFrame(true);
    tray?.setToolTip(count ? `AirFlash · ${count} new` : 'AirFlash');
  });
}

app.on('activate', showWindow); // macOS dock click
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (!node) return;
  e.preventDefault();
  const n = node;
  node = null;
  n.close().finally(() => app.exit(0));
});
