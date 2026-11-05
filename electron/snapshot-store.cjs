'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Snapshots are deliberately readable JSON. Nothing in this repository expires
// or prunes a saved scan: a later folder scan must not erase an earlier baseline.
// File previews are bounded by the scanner, but every visited directory is
// retained for instant navigation. A real system drive can have far more than
// 26k directories; bounds here protect parsing without silently dropping them.
const SNAPSHOT_LIMITS = Object.freeze({ maxFileBytes: 512 * 1024 * 1024, maxTreeNodes: 1000000, maxDepth: 1024 });
const INDEX_NAME = 'index-v1.json';
const queues = new Map();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, name, max = 32768) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) throw failure('SNAPSHOT_INVALID', `${name}无效。`);
  return value;
}
function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('SNAPSHOT_INVALID', `${name}必须是有效的非负整数。`);
  return value;
}
function flag(value, name) {
  if (typeof value !== 'boolean') throw failure('SNAPSHOT_INVALID', `${name}无效。`);
  return value;
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw failure('SNAPSHOT_INVALID', `${name}不是有效时间。`);
  return new Date(value).toISOString();
}
function validId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value) || /^(?:index-v1|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw failure('SNAPSHOT_INVALID_ID', '扫描记录标识无效。');
  return value;
}
function pathKey(value) {
  text(value, '扫描路径');
  if (path.win32.isAbsolute(value) && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)) return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value).replace(/\/+$/, '') || '/';
  throw failure('SNAPSHOT_INVALID', '扫描记录需要绝对路径。');
}
function parentKey(value) {
  return pathKey(/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value) ? path.win32.dirname(value) : path.posix.dirname(value));
}
function normalizeDrive(drive) {
  if (drive === null) return null;
  if (!object(drive)) throw failure('SNAPSHOT_INVALID', '磁盘信息无效。');
  const result = { path: text(drive.path, '磁盘路径'), name: typeof drive.name === 'string' && drive.name.length <= 4096 ? drive.name : '', total: count(drive.total, '磁盘容量'), free: count(drive.free, '可用容量'), used: count(drive.used, '已用容量') };
  pathKey(result.path);
  if (result.free > result.total || result.used > result.total) throw failure('SNAPSHOT_INVALID', '磁盘容量信息不一致。');
  // WMI can return null/empty for an unavailable optional volume attribute.
  if (drive.fileSystem !== undefined && drive.fileSystem !== null && drive.fileSystem !== '') result.fileSystem = text(drive.fileSystem, '文件系统', 128);
  if (drive.volumeId !== undefined && drive.volumeId !== null && drive.volumeId !== '') result.volumeId = text(drive.volumeId, '卷标识', 4096);
  return result;
}
function normalizeMeta(value) {
  if (!object(value)) throw failure('SNAPSHOT_INVALID', '扫描记录元数据无效。');
  if (value.schemaVersion !== 1) throw failure('SNAPSHOT_UNSUPPORTED_SCHEMA', '该扫描记录的格式版本不受支持，原文件已保留。');
  const result = {
    schemaVersion: 1, id: validId(value.id), rootPath: text(value.rootPath, '扫描路径'),
    createdAt: timestamp(value.createdAt, '完成时间'), startedAt: timestamp(value.startedAt, '开始时间'),
    scanElapsedMs: count(value.scanElapsedMs, '扫描耗时'), size: count(value.size, '记录大小'),
    files: count(value.files, '文件数量'), folders: count(value.folders, '文件夹数量'), skipped: count(value.skipped, '跳过数量'),
    incomplete: flag(value.incomplete, '不完整标记'), drive: normalizeDrive(value.drive),
    isDriveRoot: flag(value.isDriveRoot, '整盘扫描标记'), retainedNodes: count(value.retainedNodes, '保留节点数量'),
  };
  pathKey(result.rootPath);
  if (Date.parse(result.startedAt) > Date.parse(result.createdAt)) throw failure('SNAPSHOT_INVALID', '扫描记录的开始时间晚于完成时间。');
  if (result.retainedNodes < 1 || result.retainedNodes > SNAPSHOT_LIMITS.maxTreeNodes) throw failure('SNAPSHOT_INVALID', '扫描记录的节点数量超出范围。');
  if (result.skipped > 0 && !result.incomplete) throw failure('SNAPSHOT_INVALID', '跳过文件的扫描需要标记为不完整。');
  if (value.driveBefore !== undefined) result.driveBefore = normalizeDrive(value.driveBefore);
  return result;
}
function copyMeta(meta) {
  return { ...meta, drive: meta.drive ? { ...meta.drive } : null, ...(own(meta, 'driveBefore') ? { driveBefore: meta.driveBefore ? { ...meta.driveBefore } : null } : {}) };
}
function normalizeSnapshot(value) {
  const meta = normalizeMeta(value);
  if (!object(value.scan)) throw failure('SNAPSHOT_INVALID', '扫描记录缺少目录树。');
  const scan = value.scan;
  if (scan.cancelled !== false) throw failure('SNAPSHOT_INVALID', '已停止的扫描不能保存为完整扫描记录。');
  let nodes = 0, totalText = 0, hasIncompleteNode = false;
  const visited = new WeakSet();
  function tree(node, depth, parent) {
    if (!object(node) || visited.has(node) || depth > SNAPSHOT_LIMITS.maxDepth || ++nodes > SNAPSHOT_LIMITS.maxTreeNodes) throw failure('SNAPSHOT_INVALID', '扫描目录树无效或超出范围。');
    visited.add(node);
    const result = { name: text(node.name, '文件名称', 4096), path: text(node.path, '文件路径'), size: count(node.size, '文件大小'), files: count(node.files, '文件数量'), folders: count(node.folders, '文件夹数量') };
    totalText += result.name.length + result.path.length;
    if (totalText > 256 * 1024 * 1024) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录中的路径文本过多，无法保存；原有记录已保留。');
    pathKey(result.path);
    if (parent && parentKey(result.path) !== pathKey(parent)) throw failure('SNAPSHOT_INVALID', '扫描目录树包含不属于父目录的路径。');
    for (const property of ['isFile', 'inaccessible', 'incomplete', 'directoryScanned']) if (node[property] !== undefined) result[property] = flag(node[property], property);
    if (result.inaccessible || result.incomplete) hasIncompleteNode = true;
    for (const property of ['childrenTruncated', 'omittedSize']) if (node[property] !== undefined) result[property] = count(node[property], property);
    if ((result.omittedSize || 0) > result.size) throw failure('SNAPSHOT_INVALID', '省略的文件大小超过目录大小。');
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw failure('SNAPSHOT_INVALID', '扫描子目录列表无效。');
      result.children = node.children.map(child => tree(child, depth + 1, result.path));
      let bytes = 0, files = 0;
      const childPaths = new Set();
      for (const child of result.children) {
        const key = pathKey(child.path);
        if (childPaths.has(key)) throw failure('SNAPSHOT_INVALID', '扫描目录树包含重复路径。');
        childPaths.add(key); bytes += child.size; files += child.files;
      }
      if (bytes + (result.omittedSize || 0) > result.size || files > result.files) throw failure('SNAPSHOT_INVALID', '扫描子目录总量与父目录不一致。');
    }
    if (result.isFile && (result.files !== 1 || result.folders !== 0 || result.children?.length)) throw failure('SNAPSHOT_INVALID', '文件节点的统计信息不一致。');
    return result;
  }
  const root = tree(scan.root, 0);
  if (pathKey(root.path) !== pathKey(meta.rootPath) || root.size !== meta.size || root.files !== meta.files || root.folders !== meta.folders || scan.skipped !== meta.skipped || scan.elapsedMs !== meta.scanElapsedMs || nodes !== meta.retainedNodes || hasIncompleteNode && !meta.incomplete) throw failure('SNAPSHOT_INVALID', '扫描记录元数据与目录树不一致。');
  const result = { id: text(scan.id, '扫描标识', 128), root, skipped: meta.skipped, cancelled: false, elapsedMs: meta.scanElapsedMs };
  if (scan.errors !== undefined) {
    if (!Array.isArray(scan.errors) || scan.errors.length > 32) throw failure('SNAPSHOT_INVALID', '扫描错误列表无效。');
    result.errors = scan.errors.map(error => text(error, '扫描错误', 32768));
  }
  for (const property of ['startedAt', 'completedAt']) if (scan[property] !== undefined) result[property] = timestamp(scan[property], property);
  return { ...meta, scan: result };
}

function createSnapshotStore(directory, options = {}) {
  text(directory, '扫描记录存储位置');
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw failure('SNAPSHOT_UNSAFE_DIRECTORY', '扫描记录不能保存在磁盘根目录。');
  const queueKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const maxFileBytes = options.maxFileBytes ?? SNAPSHOT_LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > SNAPSHOT_LIMITS.maxFileBytes) throw failure('SNAPSHOT_INVALID', '扫描记录文件大小上限无效。');
  let cache = null;
  const reported = new Set();
  const warn = (code, message, id) => {
    const key = `${code}:${id || ''}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    try { options.onWarning?.({ code, message, ...(id ? { id } : {}) }); } catch { /* Warnings must not make usable records unavailable. */ }
  };
  const serialize = action => {
    const operation = (queues.get(queueKey) || Promise.resolve()).then(action);
    queues.set(queueKey, operation.catch(() => {}));
    return operation;
  };
  async function ensureDirectory() {
    await fs.promises.mkdir(resolved, { recursive: true });
    const stat = await fs.promises.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('SNAPSHOT_UNSAFE_DIRECTORY', '扫描记录存储目录不能是链接。');
  }
  const location = id => path.join(resolved, `${validId(id)}.json`);
  async function readBounded(file, limit) {
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw failure('SNAPSHOT_UNSAFE_FILE', '扫描记录文件不能是目录或链接。');
    if (before.size > limit) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录超过文件大小上限，原文件已保留。');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录文件过大或无效。');
      const data = await handle.readFile();
      if (data.byteLength > limit) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录超过文件大小上限，原文件已保留。');
      return { data: data.toString('utf8'), stat };
    } finally { await handle.close(); }
  }
  async function atomicWrite(file, data) {
    const temporary = path.join(resolved, `.${path.basename(file)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await ensureDirectory();
      await fs.promises.rename(temporary, file);
      // POSIX permits directory fsync. Windows already flushes the file above.
      if (process.platform !== 'win32') {
        const directoryHandle = await fs.promises.open(resolved, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      // Only our exact, randomly named temporary file is ever removed.
      await ensureDirectory();
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async function persistIndex() {
    try {
      const data = JSON.stringify({ schemaVersion: 1, snapshots: [...cache.values()].map(entry => ({ meta: entry.meta, bytes: entry.bytes, mtimeMs: entry.mtimeMs })) });
      if (Buffer.byteLength(data) > SNAPSHOT_LIMITS.maxFileBytes) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录索引过大；仍可从各记录文件恢复。');
      await atomicWrite(path.join(resolved, INDEX_NAME), data);
    } catch (error) { warn('SNAPSHOT_INDEX_WRITE_FAILED', `扫描记录索引未能更新，记录文件仍已保留：${error.message}`); }
  }
  async function loadIndex() {
    cache = new Map();
    try {
      const { data } = await readBounded(path.join(resolved, INDEX_NAME), SNAPSHOT_LIMITS.maxFileBytes);
      const index = JSON.parse(data);
      if (!object(index) || index.schemaVersion !== 1 || !Array.isArray(index.snapshots)) throw failure('SNAPSHOT_INDEX_INVALID', '扫描记录索引格式无效。');
      for (const entry of index.snapshots) {
        if (!object(entry)) throw failure('SNAPSHOT_INDEX_INVALID', '扫描记录索引项目无效。');
        const meta = normalizeMeta(entry.meta);
        count(entry.bytes, '索引文件大小');
        if (entry.bytes > maxFileBytes || !Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0 || cache.has(meta.id)) throw failure('SNAPSHOT_INDEX_INVALID', '扫描记录索引项目无效。');
        cache.set(meta.id, { meta, bytes: entry.bytes, mtimeMs: entry.mtimeMs });
      }
      return false;
    } catch (error) {
      cache.clear();
      if (error.code !== 'ENOENT') warn('SNAPSHOT_INDEX_RECOVERED', `扫描记录索引损坏或版本不兼容，正在从原始 JSON 文件恢复：${error.message}`);
      return true;
    }
  }
  async function readSnapshot(id) {
    const { data, stat } = await readBounded(location(id), maxFileBytes);
    const snapshot = normalizeSnapshot(JSON.parse(data));
    if (snapshot.id !== id) throw failure('SNAPSHOT_INVALID', '扫描记录标识与文件名不一致。');
    return { snapshot, stat };
  }
  async function refresh() {
    await ensureDirectory();
    let changed = cache === null ? await loadIndex() : false;
    const names = await fs.promises.readdir(resolved);
    const seen = new Set();
    for (const name of names) {
      if (name === INDEX_NAME || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      try { validId(id); } catch { continue; }
      seen.add(id);
      try {
        const stat = await fs.promises.lstat(location(id));
        if (!stat.isFile() || stat.isSymbolicLink()) throw failure('SNAPSHOT_UNSAFE_FILE', '扫描记录文件不能是目录或链接。');
        if (stat.size > maxFileBytes) throw failure('SNAPSHOT_TOO_LARGE', '扫描记录超过文件大小上限，原文件已保留。');
        const entry = cache.get(id);
        if (entry && entry.bytes === stat.size && entry.mtimeMs === stat.mtimeMs) continue;
        const record = await readSnapshot(id);
        const { scan, ...meta } = record.snapshot;
        cache.set(id, { meta, bytes: record.stat.size, mtimeMs: record.stat.mtimeMs });
        changed = true;
      } catch (error) {
        if (cache.delete(id)) changed = true;
        if (error.code !== 'ENOENT') warn(error.code === 'SNAPSHOT_UNSUPPORTED_SCHEMA' ? error.code : 'SNAPSHOT_CORRUPT', `扫描记录 ${id} 无法读取，原文件已保留：${error.message}`, id);
      }
    }
    for (const id of cache.keys()) if (!seen.has(id)) { cache.delete(id); changed = true; }
    if (changed) await persistIndex();
  }
  return {
    // A refreshed list validates file size/mtime first. Navigation can then
    // reuse an immutable parsed tree until the on-disk file changes.
    cacheToken: id => {
      const entry = cache?.get(id);
      return entry ? `${entry.bytes}:${entry.mtimeMs}` : null;
    },
    save: snapshot => serialize(async () => {
      const validated = normalizeSnapshot(snapshot);
      const data = JSON.stringify(validated);
      if (Buffer.byteLength(data) > maxFileBytes) {
        const error = failure('SNAPSHOT_TOO_LARGE', `扫描记录超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB，无法保存；原有记录已保留。`);
        warn(error.code, error.message, validated.id); throw error;
      }
      await refresh();
      const file = location(validated.id);
      try { await fs.promises.lstat(file); throw failure('SNAPSHOT_EXISTS', '此扫描记录标识已存在，原有记录不会被覆盖。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicWrite(file, data);
      const stat = await fs.promises.lstat(file);
      const { scan, ...meta } = validated;
      cache.set(meta.id, { meta, bytes: stat.size, mtimeMs: stat.mtimeMs });
      await persistIndex();
      return copyMeta(meta);
    }),
    list: () => serialize(async () => {
      await refresh();
      return [...cache.values()].map(entry => copyMeta(entry.meta)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    }),
    get: id => serialize(async () => {
      validId(id); await ensureDirectory();
      try { return (await readSnapshot(id)).snapshot; }
      catch (error) {
        if (error.code === 'ENOENT') throw failure('SNAPSHOT_NOT_FOUND', '这份扫描记录已不存在。');
        warn(error.code === 'SNAPSHOT_UNSUPPORTED_SCHEMA' ? error.code : 'SNAPSHOT_CORRUPT', `扫描记录 ${id} 无法读取，原文件已保留：${error.message}`, id);
        throw failure(error.code === 'SNAPSHOT_UNSUPPORTED_SCHEMA' ? error.code : 'SNAPSHOT_CORRUPT', `这份扫描记录损坏或无法读取，原文件已保留：${error.message}`);
      }
    }),
  };
}

module.exports = { createSnapshotStore, SNAPSHOT_LIMITS };
