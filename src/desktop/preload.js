'use strict';

// The only bridge between the web UI and the desktop app. Keep it small.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airflashDesktop', {
  platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, info) => cb(info)),
  onOpenConnect: (cb) => ipcRenderer.on('open-connect', () => cb()),
  showItemInFolder: (p) => ipcRenderer.send('show-item', p),
  openDownloads: () => ipcRenderer.send('open-downloads'),
  focus: () => ipcRenderer.send('focus'),
  setBadge: (n) => ipcRenderer.send('set-badge', n),
});
