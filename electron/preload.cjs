'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`memreader:${name}`, ...args);

contextBridge.exposeInMainWorld('memreader', Object.freeze({
  getDrives: () => invoke('get-drives'),
  chooseFolder: () => invoke('choose-folder'),
  scanFolder: location => invoke('scan-folder', location),
  cancelScan: () => invoke('cancel-scan'),
  listSnapshots: () => invoke('list-snapshots'),
  getSnapshot: id => invoke('get-snapshot', id),
  compareSnapshots: (baselineId, currentId, scopePath) => invoke('compare-snapshots', baselineId, currentId, scopePath),
  openSnapshotFolder: () => invoke('open-snapshot-folder'),
  getCachedDirectory: location => invoke('get-cached-directory', location),
  listDriveCaches: () => invoke('list-drive-caches'),
  onScanProgress: callback => {
    if (typeof callback !== 'function') throw new TypeError('需要提供扫描进度回调。');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('memreader:scan-progress', listener);
    return () => ipcRenderer.removeListener('memreader:scan-progress', listener);
  },
  getSoftware: () => invoke('get-software'),
  measureSoftware: id => invoke('measure-software', id),
  openPath: location => invoke('open-path', location),
  exportReport: data => invoke('export-report', data),
  getTheme: () => invoke('get-theme'),
  saveTheme: theme => invoke('save-theme', theme),
  windowAction: action => { if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('memreader:window-action', action); },
}));
