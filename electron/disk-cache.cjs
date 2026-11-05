'use strict';

const path = require('node:path');
const { normalizeRoot } = require('./comparison.cjs');

const within = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith('\\') ? root : root + '\\');
const identity = drive => typeof drive?.volumeId === 'string' ? drive.volumeId.trim().toLowerCase() : '';
const time = record => Date.parse(record.createdAt);
const newestFirst = (a, b) => time(b) - time(a) || b.id.localeCompare(a.id);
const driveRootOf = location => normalizeRoot(path.win32.parse(location).root);
const knownCapacity = drive => Number.isSafeInteger(drive?.total) && drive.total > 0;

function compatible(left, right) {
  if (!left || !right) return true;
  if (identity(left) && identity(right) && identity(left) !== identity(right)) return false;
  return !(knownCapacity(left) && knownCapacity(right) && left.total !== right.total);
}

function placeholder(location) {
  return { name: path.win32.basename(location) || location, path: location, size: 0, files: 0, folders: 0, cachePlaceholder: true };
}

function shallow(node) {
  const { children, ...metadata } = node;
  return { ...metadata };
}

function needsScan(node) {
  if (node.cachePlaceholder) return true;
  // All directory aggregates from current scans remain attached to the drive,
  // even when the bounded file-preview budget is exhausted in an earlier tree.
  if (node.directoryScanned) return false;
  // An attempted but unreadable folder stays browsable as an observed failure.
  // Automatically rescanning it on every click would never resolve permission.
  if (node.inaccessible || node.children?.length) return false;
  return node.size > 0 || node.files > 0 || node.folders > 0 || node.childrenTruncated > 0 || node.omittedSize > 0;
}

function completeDetails(node, snapshot) {
  const legacyIncomplete = (snapshot.incomplete || snapshot.skipped || snapshot.scan.skipped)
    && !snapshot.scan.root.incomplete && !snapshot.scan.root.inaccessible;
  if (legacyIncomplete || node.inaccessible || node.incomplete) return false;
  if (node.isFile) return true;
  if (node.childrenTruncated > 0 || node.omittedSize > 0) return false;
  if (!node.children) return node.size === 0 && node.files === 0 && node.folders === 0;
  return node.children.reduce((sum, child) => sum + child.size, 0) === node.size
    && node.children.reduce((sum, child) => sum + child.files, 0) === node.files
    && node.children.reduce((sum, child) => sum + child.folders + (child.isFile ? 0 : 1), 0) === node.folders;
}

function completeDirectoryListing(node, snapshot) {
  if (!node.directoryScanned) return completeDetails(node, snapshot);
  const legacyIncomplete = (snapshot.incomplete || snapshot.skipped || snapshot.scan.skipped)
    && !snapshot.scan.root.incomplete && !snapshot.scan.root.inaccessible;
  return !legacyIncomplete && !node.inaccessible && !node.incomplete;
}

function locateDirectory(snapshot, target) {
  let node = snapshot.scan.root;
  const sourceRoot = normalizeRoot(node.path);
  if (!within(target, sourceRoot)) return { node: null, absent: false };
  if (target === sourceRoot) return { node: node.isFile ? null : node, absent: !!node.isFile && completeDetails(node, snapshot) };
  const parts = target.slice(sourceRoot.length).replace(/^\\/, '').split('\\').filter(Boolean);
  let location = sourceRoot;
  for (const part of parts) {
    location = path.win32.join(location, part);
    const parent = node;
    node = parent.children?.find(child => normalizeRoot(child.path) === location);
    if (!node) return { node: null, absent: completeDirectoryListing(parent, snapshot) };
    if (node.isFile) return { node: null, absent: completeDetails(node, snapshot) };
  }
  return { node, absent: false };
}

const findDirectory = (snapshot, target) => locateDirectory(snapshot, target).node;

function previewTree(node, depth = 2) {
  const result = shallow(node);
  if (!node.children) return result;
  if (depth > 0) result.children = node.children.map(child => previewTree(child, depth - 1));
  else if (node.children.length) {
    result.childrenTruncated = (result.childrenTruncated || 0) + node.children.length;
    result.omittedSize = (result.omittedSize || 0) + node.children.reduce((sum, child) => sum + child.size, 0);
  } else result.children = [];
  return result;
}

function createDiskCache(snapshotStore) {
  if (!snapshotStore || typeof snapshotStore.list !== 'function' || typeof snapshotStore.get !== 'function') throw new TypeError('需要扫描记录存储。');
  // Readable JSON is immutable, so keep at most two recently parsed snapshots.
  // The store's size/mtime token invalidates this cache on an external edit.
  // Without a token (e.g. an alternate store), reads retain their old semantics.
  const parsed = new Map();
  const maxCachedNodes = 1000000;
  async function readSnapshot(record) {
    const token = snapshotStore.cacheToken?.(record.id);
    if (!token) return snapshotStore.get(record.id);
    const existing = parsed.get(record.id);
    if (existing?.token === token) {
      parsed.delete(record.id); parsed.set(record.id, existing);
      return existing.snapshot;
    }
    parsed.delete(record.id);
    const snapshot = await snapshotStore.get(record.id);
    const nodes = snapshot.retainedNodes;
    if (nodes <= maxCachedNodes) {
      let retained = [...parsed.values()].reduce((sum, entry) => sum + entry.nodes, 0);
      while (parsed.size && (parsed.size >= 2 || retained + nodes > maxCachedNodes)) {
        const key = parsed.keys().next().value;
        retained -= parsed.get(key).nodes; parsed.delete(key);
      }
      parsed.set(record.id, { token, snapshot, nodes });
    }
    return snapshot;
  }

  function selectRecords(records, root, drive) {
    if (drive && normalizeRoot(drive.path) !== root) throw new Error('缓存路径与所选磁盘不一致。');
    const local = records.filter(record => {
      try { return Number.isFinite(time(record)) && within(normalizeRoot(record.rootPath), root)
        && (!record.drive || normalizeRoot(record.drive.path) === root); }
      catch { return false; }
    }).sort(newestFirst);
    // With no live disk metadata, anchor to the latest known volume identity so
    // histories from a replaced drive letter are not silently mixed together.
    const anchor = drive || local.find(record => identity(record.drive))?.drive || local.find(record => record.drive)?.drive || null;
    return local.filter(record => compatible(record.drive, anchor));
  }

  function generation(records, root) {
    return records.find(record => record.isDriveRoot && normalizeRoot(record.rootPath) === root) || null;
  }

  async function getDirectory(location, drive = null) {
    const target = normalizeRoot(location);
    const drivePath = driveRootOf(target);
    const warnings = [];
    const allRecords = await snapshotStore.list();
    for (const key of parsed.keys()) if (!allRecords.some(record => record.id === key)) parsed.delete(key);
    let records = selectRecords(allRecords, drivePath, drive);
    const loaded = new Map();
    async function load(record) {
      if (!loaded.has(record.id)) loaded.set(record.id, (async () => {
        try {
          const snapshot = await readSnapshot(record);
          if (!snapshot?.scan?.root || snapshot.scan.cancelled || normalizeRoot(snapshot.scan.root.path) !== normalizeRoot(record.rootPath)) {
            warnings.push(`扫描记忆 ${record.id} 不是可用的已完成扫描，已跳过。`);
            return null;
          }
          return snapshot;
        } catch {
          warnings.push(`扫描记忆 ${record.id} 未能读取，原有历史记录不会被修改。`);
          return null;
        }
      })());
      return loaded.get(record.id);
    }

    let baseline = null;
    let baselineSnapshot = null;
    for (const candidate of records.filter(record => record.isDriveRoot && normalizeRoot(record.rootPath) === drivePath)) {
      const snapshot = await load(candidate);
      if (snapshot) { baseline = candidate; baselineSnapshot = snapshot; break; }
    }
    if (baseline) records = records.filter(record => time(record) >= time(baseline) && compatible(record.drive, baseline.drive));

    async function resolve(directory) {
      let summaryOnly = null;
      for (const record of records) {
        if (!within(directory, normalizeRoot(record.rootPath))) continue;
        const snapshot = await load(record);
        if (!snapshot) continue;
        const { node, absent } = locateDirectory(snapshot, directory);
        // A newer complete enumeration supersedes older remembered descendants.
        // Truncated or unreadable parents cannot establish this absence.
        if (absent) break;
        if (!node) continue;
        const found = { record, snapshot, node };
        if (!needsScan(node)) return found;
        summaryOnly ||= found;
      }
      return summaryOnly;
    }

    const source = await resolve(target);
    let node;
    if (source) node = previewTree(source.node);
    else {
      // A fragment may be deeper than any retained parent. These are navigation
      // links with explicitly unknown zero statistics, never summed disk totals.
      const descendantRecords = records.filter(record => {
        const key = normalizeRoot(record.rootPath);
        return key !== target && within(key, target);
      });
      const navigation = new Map();
      for (const record of descendantRecords) {
        if (!await resolve(normalizeRoot(record.rootPath))) continue;
        const suffix = path.win32.resolve(record.rootPath).slice(target.length).replace(/^\\/, '');
        const childPath = path.win32.join(path.win32.resolve(location), suffix.split('\\')[0]);
        const childKey = normalizeRoot(childPath);
        if (!navigation.has(childKey)) navigation.set(childKey, placeholder(childPath));
      }
      if (!navigation.size) return null;
      node = { ...placeholder(path.win32.resolve(location)), children: [...navigation.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) };
      warnings.push('此目录尚无自身扫描结果；这里只列出已记住的子目录，未统计此层容量。');
    }

    const trail = [];
    const ancestors = [];
    let ancestorPath = target;
    while (ancestorPath !== drivePath) {
      ancestorPath = normalizeRoot(path.win32.dirname(ancestorPath));
      ancestors.unshift(ancestorPath);
    }
    for (const ancestor of ancestors) {
      const fromBaseline = baselineSnapshot && findDirectory(baselineSnapshot, ancestor);
      const found = fromBaseline ? { node: fromBaseline } : await resolve(ancestor);
      trail.push(found ? shallow(found.node) : placeholder(ancestor));
    }
    trail.push(node);

    // Live disk identity cannot establish the identity of a saved record whose
    // optional drive probe was unavailable when the record was created.
    const usedDrive = source ? source.record.drive : baseline ? baseline.drive : records[0]?.drive;
    if (!identity(usedDrive) || (drive && !identity(drive)) || (baseline && !identity(baseline.drive))) warnings.push('卷标识不完整；扫描记忆按磁盘路径匹配，无法完全确认当前卷身份。');
    if (!baseline) warnings.push('本磁盘还没有整盘扫描记忆；当前仅保存了部分目录的扫描结果。');
    if (source && baseline && source.record.id !== baseline.id) warnings.push('此目录来自局部扫描；返回磁盘根目录时仍显示整盘扫描当时的总量。');
    if (source && records.some(record => time(record) > time(source.record) && within(target, normalizeRoot(record.rootPath)))) warnings.push('较新扫描未保留此目录的可浏览明细；这里保留较早的目录缓存及其扫描时间。');
    if (needsScan(node) && !node.cachePlaceholder) warnings.push('已记住此目录的总量，但未保留可浏览的子项；扫描此目录可以补齐明细。');
    if (node.inaccessible || node.incomplete) warnings.push('这份缓存含有无法读取或跳过的项目；可以查看已记录内容，按需手动重新扫描。');
    return { drivePath: drive?.path || path.win32.parse(node.path).root, node, trail,
      snapshotId: source?.record.id || null, createdAt: source?.record.createdAt || null,
      generationId: baseline?.id || null, rootSnapshotAt: baseline?.createdAt || null,
      needsScan: needsScan(node), partial: !baseline || !!node.cachePlaceholder, warnings: [...new Set(warnings)],
      elapsedMs: source?.snapshot.scan.elapsedMs || 0, skipped: source?.snapshot.scan.skipped || 0,
      drive: source?.snapshot.drive ? { ...source.snapshot.drive } : null };
  }

  async function listDrives(drives) {
    const records = await snapshotStore.list();
    return drives.map(drive => {
      const root = normalizeRoot(drive.path);
      const compatibleRecords = selectRecords(records, root, drive);
      const baseline = generation(compatibleRecords, root);
      const currentGeneration = baseline ? compatibleRecords.filter(record => time(record) >= time(baseline) && compatible(record.drive, baseline.drive)) : compatibleRecords;
      return { path: drive.path, hasCache: currentGeneration.length > 0, rootSnapshotId: baseline?.id || null,
        updatedAt: currentGeneration[0]?.createdAt || null, partial: currentGeneration.length > 0 && !baseline };
    });
  }

  return { getDirectory, listDrives };
}

module.exports = { createDiskCache, previewTree };
