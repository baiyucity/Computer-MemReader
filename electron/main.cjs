'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanDirectory } = require('./scanner.cjs');
const windows = require('./windows.cjs');
const { createSnapshotStore } = require('./snapshot-store.cjs');
const { compareSnapshots } = require('./comparison.cjs');
const { createDiskCache, previewTree } = require('./disk-cache.cjs');

let mainWindow = null;
let activeScan = null;
let pendingCapture = null;
let software = [];
let softwarePromise = null;
let themeWrites = Promise.resolve();
let snapshotStore = null;
let diskCache = null;
let knownDrives = [];
function diskMemory() { return diskCache ||= createDiskCache(snapshots()); }
const snapshotWarnings = [];
function snapshots() {
  if (!snapshotStore) snapshotStore = createSnapshotStore(path.join(app.getPath('userData'), 'snapshots-v1'), {
    onWarning: warning => { if (!snapshotWarnings.includes(warning.message)) snapshotWarnings.push(warning.message); if (snapshotWarnings.length > 12) snapshotWarnings.shift(); },
  });
  return snapshotStore;
}
function countNodes(node) { return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0); }
function sendScanProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('memreader:scan-progress', progress);
}
function cancelScanOperation() {
  // Once saving starts, the completed result is being committed atomically.
  // Cancellation must never report it as stopped after its snapshot was saved.
  if (pendingCapture?.phase === 'saving') return;
  if (pendingCapture) { pendingCapture.cancelled = true; pendingCapture.controller.abort(); }
  activeScan?.controller.abort();
  activeScan?.inspector?.close();
}
async function sampleDrive(location, capture) {
  try {
    const drives = await windows.getDrives({ signal: capture.controller.signal, timeout: 3000 });
    knownDrives = drives;
    return drives.find(drive => location.toLowerCase().startsWith(drive.path.toLowerCase())) || null;
  } catch { return null; } // Volume metadata is optional; folder data remains usable.
}
function markCancelled(result) {
  result.cancelled = true;
  result.root.incomplete = true;
  return result;
}
async function captureScan(location) {
  if (pendingCapture || activeScan) throw new Error('正在扫描另一个文件夹，请先停止或等待完成。');
  const capture = { cancelled: false, controller: new AbortController(), phase: 'sampling', progress: null };
  pendingCapture = capture;
  try {
  const before = await sampleDrive(location, capture);
  if (capture.cancelled) return { id: '', root: { name: path.basename(location) || location, path: location, size: 0, files: 0, folders: 0, incomplete: true }, skipped: 0, cancelled: true, elapsedMs: 0 };
  capture.phase = 'scanning';
  const result = await performScan(location, true, progress => { capture.progress = progress; });
  if (result.cancelled || capture.cancelled) return markCancelled(result);
  capture.phase = 'sampling';
  const drive = await sampleDrive(result.root.path, capture);
  if (capture.cancelled || capture.controller.signal.aborted) return markCancelled(result);
  const now = result.completedAt || new Date().toISOString();
  const snapshot = {
    schemaVersion: 1, id: result.id, rootPath: result.root.path, createdAt: now,
    startedAt: result.startedAt || new Date(Date.parse(now) - result.elapsedMs).toISOString(),
    scanElapsedMs: result.elapsedMs, size: result.root.size, files: result.root.files,
    folders: result.root.folders, skipped: result.skipped, incomplete: Boolean(result.root.incomplete || result.root.inaccessible || result.skipped),
    drive, driveBefore: before, isDriveRoot: path.win32.resolve(result.root.path).toLowerCase() === path.win32.parse(result.root.path).root.toLowerCase(),
    retainedNodes: countNodes(result.root), scan: result,
  };
  capture.phase = 'saving';
  sendScanProgress({ ...(capture.progress || { id: result.id, root: result.root.path, currentPath: result.root.path,
    files: result.root.files, folders: result.root.folders + 1, bytes: result.root.size, skipped: result.skipped, elapsedMs: result.elapsedMs }), phase: 'saving' });
  try { await snapshots().save(snapshot); result.snapshotId = snapshot.id; }
  catch (error) { result.snapshotWarning = `扫描完成，但记录未保存：${error.message}。请检查本地存储空间后重新扫描。`; }
  return result;
  } finally { if (pendingCapture === capture) pendingCapture = null; }
}
const productionURL = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
const developmentURL = !app.isPackaged && process.env.MEMREADER_DEV_URL === 'http://127.0.0.1:5173' ? process.env.MEMREADER_DEV_URL : null;
const pageURL = developmentURL || productionURL;

function verifySender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无效的应用请求。');
  const url = event.senderFrame.url;
  if (developmentURL ? new URL(url).origin !== developmentURL : url.split('#')[0] !== productionURL) throw new Error('无效的页面来源。');
}

function localPath(value) {
  if (typeof value !== 'string' || value.length > 32000 || value.includes('\0') || !/^[a-zA-Z]:[\\/]/.test(value)) throw new Error('请选择本地磁盘上的文件夹。');
  const resolved = path.win32.resolve(value);
  if (!/^[a-zA-Z]:\\/.test(resolved)) throw new Error('文件路径无效。');
  return resolved;
}

function sanitizeTheme(theme) {
  if (!theme || typeof theme !== 'object' || !/^#[a-f\d]{6}$/i.test(theme.accent) || !Number.isFinite(theme.glass) || theme.glass < 0.6 || theme.glass > 0.95 || !['light', 'dark'].includes(theme.mode)) throw new Error('主题设置无效。');
  if (theme.background !== null && (typeof theme.background !== 'string' || !/^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-zA-Z\d+/=\r\n]+$/.test(theme.background) || theme.background.length > 28 * 1024 * 1024)) throw new Error('背景需要是小于 20 MB 的 PNG、JPEG、WebP 或 GIF 图片。');
  return { accent: theme.accent, background: theme.background, glass: theme.glass, motion: !!theme.motion, mode: theme.mode, autoColor: !!theme.autoColor };
}

async function performScan(location, sendProgress = true, onProgress) {
  if (activeScan) throw new Error('正在扫描另一个文件夹，请先停止或等待完成。');
  const controller = new AbortController();
  const operation = { controller, inspector: null };
  activeScan = operation;
  try {
    const target = localPath(location);
    const stat = await fs.promises.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择普通本地文件夹；链接和重解析点不会被扫描。');
    if (controller.signal.aborted) return { id: '', root: { name: path.basename(target) || target, path: target, size: 0, files: 0, folders: 0 }, skipped: 0, cancelled: true, elapsedMs: 0 };
    operation.inspector = windows.createReparseInspector();
    return await scanDirectory(target, {
      signal: controller.signal,
      inspectDirectory: (directory, signal) => operation.inspector.inspect(directory, signal),
      onProgress: sendProgress || onProgress ? progress => { onProgress?.(progress); if (sendProgress) sendScanProgress(progress); } : undefined,
    });
  } finally {
    operation.inspector?.close();
    if (activeScan === operation) activeScan = null;
  }
}

function registerIPC() {
  const handle = (name, handler) => ipcMain.handle(`memreader:${name}`, async (event, ...args) => { verifySender(event); return handler(...args); });
  handle('get-drives', async () => { knownDrives = await windows.getDrives(); return knownDrives; });
  handle('get-cached-directory', async location => {
    const target = localPath(location);
    if (!knownDrives.length) { try { knownDrives = await windows.getDrives({ timeout: 3000 }); } catch {} }
    const drive = knownDrives.find(d => target.toLowerCase().startsWith(d.path.toLowerCase())) || null;
    return diskMemory().getDirectory(target, drive);
  });
  handle('list-drive-caches', async () => {
    if (!knownDrives.length) knownDrives = await windows.getDrives();
    return diskMemory().listDrives(knownDrives);
  });
  handle('choose-folder', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, { title: '选择要分析的文件夹', properties: ['openDirectory'], buttonLabel: '分析此文件夹' });
    return choice.canceled ? null : localPath(choice.filePaths[0]);
  });
  handle('scan-folder', async location => {
    const result = await captureScan(localPath(location));
    // The complete directory tree stays in the local snapshot. Each navigation
    // fetches its own preview, so a full disk never needs a huge IPC transfer.
    return { ...result, root: result.snapshotId ? previewTree(result.root) : result.root };
  });
  handle('cancel-scan', () => cancelScanOperation());
  handle('list-snapshots', async () => ({ snapshots: await snapshots().list(), warnings: [...snapshotWarnings] }));
  handle('get-snapshot', id => snapshots().get(id));
  handle('compare-snapshots', async (baselineId, currentId, scopePath) => {
    if (scopePath !== undefined) localPath(scopePath);
    const [baseline, current] = await Promise.all([snapshots().get(baselineId), snapshots().get(currentId)]);
    return compareSnapshots(baseline, current, scopePath);
  });
  handle('open-snapshot-folder', async () => {
    const directory = path.join(app.getPath('userData'), 'snapshots-v1');
    await fs.promises.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  handle('get-software', async () => {
    if (!softwarePromise) softwarePromise = windows.getSoftware().then(items => { software = items; return items; }).finally(() => { softwarePromise = null; });
    return softwarePromise;
  });
  handle('measure-software', async id => {
    if (pendingCapture) throw new Error('正在扫描另一个文件夹，请先停止或等待完成。');
    if (typeof id !== 'string') throw new Error('应用标识无效。');
    const item = software.find(entry => entry.id === id);
    if (!item) throw new Error('请先加载应用列表。');
    const guard = windows.softwareLocationGuard(item.installLocation);
    if (!guard.safe) throw new Error(guard.reason);
    const result = await performScan(guard.path, false);
    if (result.cancelled) throw new Error('测量已停止，原有大小已保留。');
    if (result.skipped) throw new Error(`安装目录有 ${result.skipped} 个项目无法读取或属于链接，不能提供完整实测值。`);
    const measured = { ...item, size: result.root.size, sizeSource: 'measured' };
    software = software.map(entry => entry.id === id ? measured : entry);
    return measured;
  });
  handle('open-path', async location => {
    const target = localPath(location);
    const stat = await fs.promises.lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    } else shell.showItemInFolder(target);
  });
  handle('export-report', async data => {
    const content = JSON.stringify(data, null, 2);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('报告数据过大或无效。');
    const choice = await dialog.showSaveDialog(mainWindow, { title: '导出空间分析报告', defaultPath: `Memreader-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON 空间报告', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return false;
    await fs.promises.writeFile(choice.filePath, content, 'utf8');
    return true;
  });
  handle('get-theme', async () => {
    try { return sanitizeTheme(JSON.parse(await fs.promises.readFile(path.join(app.getPath('userData'), 'theme.json'), 'utf8'))); }
    catch { return null; }
  });
  handle('save-theme', theme => {
    const safeTheme = sanitizeTheme(theme);
    const destination = path.join(app.getPath('userData'), 'theme.json');
    const write = themeWrites.catch(() => {}).then(async () => {
      await fs.promises.mkdir(app.getPath('userData'), { recursive: true });
      const temporary = destination + '.tmp';
      await fs.promises.writeFile(temporary, JSON.stringify(safeTheme), 'utf8');
      await fs.promises.rename(temporary, destination);
    });
    themeWrites = write;
    return write;
  });
  ipcMain.on('memreader:window-action', (event, action) => {
    try {
      verifySender(event);
      if (action === 'minimize') mainWindow.minimize();
      else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      else if (action === 'close') mainWindow.close();
    } catch { /* Reject requests from any unexpected frame. */ }
  });
}

function createWindow({ visible = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1460, height: 950, minWidth: 1080, minHeight: 740, frame: false, show: false,
    backgroundColor: '#f5f3fa', title: 'Memreader · 空间，清晰可见', icon: path.join(__dirname, '..', 'dist', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== pageURL) event.preventDefault(); });
  if (visible) mainWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    dialog.showErrorBox('Memreader 页面加载失败', `无法加载应用界面：${description} (${code})。\n开发运行时请确认 Vite 已启动；正式运行时请重新构建或安装应用。`);
    app.quit();
  });
  if (visible) mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { cancelScanOperation(); mainWindow = null; });
  mainWindow.loadURL(pageURL).catch(error => { console.error('Memreader renderer load failed:', error.message); });
  return mainWindow;
}

function configureSession() {
  app.setAppUserModelId('com.memreader.desktop');
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const csp = `default-src 'self'; script-src 'self'${developmentURL ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${developmentURL ? ' ws://127.0.0.1:5173' : ''}; object-src 'none'; base-uri 'self'; frame-src 'none'`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }));
}

module.exports = { createWindow, registerIPC, configureSession };

// Electron's ESM package loader may not mark a .cjs entry as require.main
// when started with `electron .`; keep imported test harnesses inert.
const applicationEntry = require.main === module || app.isPackaged ||
  Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, '..'));
if (applicationEntry) {
 if (!app.requestSingleInstanceLock()) app.quit();
 else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    configureSession();
    registerIPC(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { dialog.showErrorBox('Memreader 无法启动', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => cancelScanOperation());
 }
}
