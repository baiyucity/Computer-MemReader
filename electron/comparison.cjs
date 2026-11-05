'use strict';

const path = require('node:path');
const { SNAPSHOT_LIMITS } = require('./snapshot-store.cjs');

function normalizeRoot(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || value.includes('\0') || value.length > 32000) {
    throw new Error('快照路径必须是本地 Windows 绝对路径。');
  }
  const normalized = path.win32.resolve(value).toLowerCase();
  return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;
}

const within = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith('\\') ? root : root + '\\');
const validSize = value => Number.isSafeInteger(value) && value >= 0;
const volumeId = drive => typeof drive?.volumeId === 'string' ? drive.volumeId.trim().toLowerCase() : '';

function buildIndex(snapshot, label) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.scan?.root) throw new Error(`${label}快照格式不受支持。`);
  if (snapshot.scan.cancelled) throw new Error('已停止的扫描不能用于快照对比，请完成扫描后重试。');
  const rootPath = normalizeRoot(snapshot.rootPath);
  if (normalizeRoot(snapshot.scan.root.path) !== rootPath) throw new Error(`${label}快照根目录与扫描记录不一致。`);
  const index = new Map();
  const seen = new WeakSet();
  const pending = [{ node: snapshot.scan.root, parentPath: null }];
  while (pending.length) {
    const { node, parentPath } = pending.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) throw new Error(`${label}快照目录结构无效。`);
    seen.add(node);
    const key = normalizeRoot(node.path);
    if (!within(key, rootPath) || (parentPath && normalizeRoot(path.win32.dirname(node.path)) !== parentPath)) throw new Error(`${label}快照包含根目录之外或层级错误的项目。`);
    if (index.has(key)) throw new Error(`${label}快照中存在重复路径。`);
    if (!validSize(node.size) || !validSize(node.files) || !validSize(node.folders)) throw new Error(`${label}快照包含无效容量。`);
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error(`${label}快照的保留明细无效。`);
    if (node.isFile && node.children?.length) throw new Error(`${label}快照中的文件不能包含子项目。`);
    if (node.childrenTruncated !== undefined && !validSize(node.childrenTruncated)) throw new Error(`${label}快照的保留明细计数无效。`);
    if (node.omittedSize !== undefined && !validSize(node.omittedSize)) throw new Error(`${label}快照的未保留容量无效。`);
    if (node.directoryScanned !== undefined && typeof node.directoryScanned !== 'boolean') throw new Error(`${label}快照的目录扫描标记无效。`);
    const childrenSize = (node.children || []).reduce((total, child) => total + (child?.size || 0), 0);
    if (childrenSize > node.size) throw new Error(`${label}快照子项目容量超过父级容量。`);
    index.set(key, node);
    if (index.size > SNAPSHOT_LIMITS.maxTreeNodes) throw new Error(`${label}快照保留的项目过多。`);
    for (const child of node.children || []) pending.push({ node: child, parentPath: key });
  }
  // New scans propagate incomplete up the tree. For older records which only
  // have a global skipped flag, no subtree can be assumed to have full coverage.
  const legacyIncomplete = !!(snapshot.incomplete || snapshot.skipped || snapshot.scan.skipped || snapshot.scan.errors?.length)
    && snapshot.scan.root.incomplete !== true && snapshot.scan.root.inaccessible !== true;
  const unreadable = new WeakMap();
  function incomplete(node) {
    if (!node) return false;
    if (unreadable.has(node)) return unreadable.get(node);
    const result = legacyIncomplete || !!node.incomplete || !!node.inaccessible || (node.children || []).some(incomplete);
    unreadable.set(node, result);
    return result;
  }
  // Populate once in reverse insertion order to avoid recursion on deep trees.
  for (const node of [...index.values()].reverse()) {
    unreadable.set(node, legacyIncomplete || !!node.incomplete || !!node.inaccessible || (node.children || []).some(child => unreadable.get(child)));
  }
  return { snapshot, rootPath, index, incomplete };
}

function residual(node) {
  if (!node || node.isFile) return 0;
  return node.size - (node.children || []).reduce((total, child) => total + child.size, 0);
}

function detailsComplete(node, context) {
  if (!node) return true; // A proven absent ancestor means its whole subtree is absent.
  if (node.isFile) return !context.incomplete(node);
  if (context.incomplete(node) || node.childrenTruncated > 0 || node.omittedSize > 0 || residual(node) !== 0) return false;
  if (!node.children) return node.size === 0 && node.files === 0 && node.folders === 0;
  const files = node.children.reduce((total, child) => total + child.files, 0);
  const folders = node.children.reduce((total, child) => total + child.folders + (child.isFile ? 0 : 1), 0);
  return files === node.files && folders === node.folders;
}

function directoryMembershipComplete(node, context) {
  if (!node || node.isFile || !node.directoryScanned) return detailsComplete(node, context);
  // Current scans retain every directory. Omitted file previews do not make a
  // missing folder ambiguous, but unreadable coverage still cannot prove loss.
  return !context.incomplete(node);
}

function locateScope(context, scope) {
  if (context.index.has(scope)) return { node: context.index.get(scope), absent: false };
  const suffix = scope.slice(context.rootPath.length).replace(/^\\/, '');
  let parent = context.index.get(context.rootPath);
  let currentPath = context.rootPath;
  for (const segment of suffix.split('\\').filter(Boolean)) {
    currentPath = path.win32.join(currentPath, segment);
    const child = context.index.get(currentPath);
    if (!child) return { node: null, absent: directoryMembershipComplete(parent, context) };
    parent = child;
  }
  return { node: parent, absent: false };
}

function metadata(snapshot) {
  const { schemaVersion, id, rootPath, createdAt, startedAt, scanElapsedMs, size, files, folders, skipped,
    incomplete, drive, driveBefore, isDriveRoot, retainedNodes } = snapshot;
  return { schemaVersion, id, rootPath, createdAt, startedAt, scanElapsedMs, size, files, folders, skipped,
    incomplete, drive: drive ? { ...drive } : null, ...(driveBefore !== undefined ? { driveBefore: driveBefore ? { ...driveBefore } : null } : {}), isDriveRoot, retainedNodes };
}

function sortChanges(rows, mode = 'absolute') {
  const delta = row => row.delta ?? row.observedDelta;
  const compare = mode === 'growth' ? (a, b) => delta(b) - delta(a)
    : mode === 'shrink' ? (a, b) => delta(a) - delta(b)
      : (a, b) => Math.abs(delta(b)) - Math.abs(delta(a));
  return [...rows].sort((a, b) => compare(a, b) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
}

function compareSnapshots(baseline, current, scopePath) {
  const before = buildIndex(baseline, '基准');
  const after = buildIndex(current, '当前');
  if (before.rootPath !== after.rootPath) throw new Error('只能对比同一文件夹的快照。');
  const oldVolume = volumeId(baseline.drive);
  const newVolume = volumeId(current.drive);
  if (oldVolume && newVolume && oldVolume !== newVolume) throw new Error('两个快照的磁盘卷标识不同，不能对比。');
  const oldTotal = baseline.drive?.total;
  const newTotal = current.drive?.total;
  if (validSize(oldTotal) && validSize(newTotal) && oldTotal !== newTotal) throw new Error('两个快照的磁盘总容量不同，不能确认是同一卷。');
  const warnings = [];
  if (!oldVolume || !newVolume) warnings.push('至少一份快照缺少磁盘卷标识；只能按相同路径对比，无法确认卷身份。');
  const scope = scopePath === undefined ? before.rootPath : normalizeRoot(scopePath);
  if (!within(scope, before.rootPath)) throw new Error('对比范围必须位于快照根目录内。');
  const oldScope = locateScope(before, scope);
  const newScope = locateScope(after, scope);
  if ((!oldScope.node && !oldScope.absent) || (!newScope.node && !newScope.absent)) throw new Error('该目录在另一次快照中的明细未保留或未能读取，无法可靠地逐层对比。');
  if (!oldScope.node && !newScope.node) throw new Error('两份快照中都没有这个目录。');
  if (oldScope.node?.isFile || newScope.node?.isFile) throw new Error('该路径曾是文件，不能作为目录逐层对比。');
  const left = oldScope.node;
  const right = newScope.node;
  const displayPath = right?.path || left.path;
  const beforeSize = left?.size || 0;
  const afterSize = right?.size || 0;
  const netDelta = afterSize - beforeSize;
  const leftChildren = new Map((left?.children || []).map(node => [normalizeRoot(node.path), node]));
  const rightChildren = new Map((right?.children || []).map(node => [normalizeRoot(node.path), node]));
  const keys = new Set([...leftChildren.keys(), ...rightChildren.keys()]);
  const rows = [];
  let ambiguousMembership = false;
  for (const key of keys) {
    const oldNode = leftChildren.get(key);
    const newNode = rightChildren.get(key);
    const missingBeforeKnown = !!oldNode || (newNode?.isFile ? detailsComplete(left, before) : directoryMembershipComplete(left, before));
    const missingAfterKnown = !!newNode || (oldNode?.isFile ? detailsComplete(right, after) : directoryMembershipComplete(right, after));
    const membershipKnown = missingBeforeKnown && missingAfterKnown;
    const coverageKnown = !before.incomplete(oldNode) && !after.incomplete(newNode);
    const reliable = membershipKnown && coverageKnown;
    if (!membershipKnown) ambiguousMembership = true;
    const oldSize = oldNode ? oldNode.size : missingBeforeKnown ? 0 : null;
    const newSize = newNode ? newNode.size : missingAfterKnown ? 0 : null;
    const observedDelta = (newNode?.size || 0) - (oldNode?.size || 0);
    const delta = reliable ? observedDelta : null;
    const node = newNode || oldNode;
    const changedType = oldNode && newNode && !!oldNode.isFile !== !!newNode.isFile;
    const canDrill = membershipKnown && !changedType && !oldNode?.isFile && !newNode?.isFile
      && !!((oldNode?.children?.length || 0) + (newNode?.children?.length || 0));
    const status = !reliable ? 'uncertain' : !oldNode ? 'added' : !newNode ? 'removed'
      : delta > 0 ? 'grown' : delta < 0 ? 'shrunk' : 'unchanged';
    const note = !membershipKnown ? '另一份快照的父目录明细未完整保留或未能完整读取；未出现不等于新增或删除。'
      : !coverageKnown ? '至少一份快照未完整读取此项目；仅展示已读取容量，不确认增长或释放。'
        : changedType ? '同一路径的项目类型发生变化。'
          : !canDrill && !node.isFile && (node.childrenTruncated > 0 || node.omittedSize > 0) ? '快照未保留更深层明细，容量仍计入此项。' : undefined;
    rows.push({ id: key, path: node.path, name: node.name, isFile: !!node.isFile, beforeSize: oldSize, afterSize: newSize,
      delta, observedDelta, status, canDrill, currentExists: !!newNode, ...(note ? { note } : {}) });
  }

  const omittedBefore = residual(left);
  const omittedAfter = residual(right);
  const hasOmissions = left?.childrenTruncated > 0 || right?.childrenTruncated > 0 || omittedBefore > 0 || omittedAfter > 0;
  const scopeIncomplete = before.incomplete(left) || after.incomplete(right);
  const explained = node => !node || residual(node) === 0 || node.childrenTruncated > 0 || node.omittedSize === residual(node);
  if (hasOmissions) {
    const safeAggregate = !scopeIncomplete && !ambiguousMembership && explained(left) && explained(right);
    const observedDelta = netDelta - rows.reduce((sum, row) => sum + row.observedDelta, 0);
    rows.push({ id: `aggregate:${scope}`, path: displayPath, name: '未保留明细（汇总）', isFile: false,
      beforeSize: omittedBefore, afterSize: omittedAfter, delta: safeAggregate ? observedDelta : null,
      observedDelta, status: safeAggregate ? 'aggregate' : 'uncertain', canDrill: false, currentExists: false,
      note: safeAggregate ? '父目录总量包含这些未保留项目；此处只比较合计差额，不判断单个文件事件。'
        : '保留范围或读取覆盖不同；此差额用于核对已观察总量，不能认定为具体文件的增长、释放、新增或删除。' });
    warnings.push('快照保留的明细有限；汇总行包含未保留项目，不能据此判断具体文件事件。');
  }
  const uncertain = scopeIncomplete || rows.some(row => row.delta === null);
  if (scopeIncomplete) warnings.push('至少一份快照未完整读取此范围；净变化仅为已读取逻辑容量之差，不代表已确认的实际增长或释放。');
  if (ambiguousMembership) warnings.push('部分路径只出现在一份保留明细中；这些路径标为不确定，不认定为新增或删除。');
  const growth = rows.reduce((sum, row) => sum + (row.delta !== null && row.delta > 0 ? row.delta : 0), 0);
  const released = rows.reduce((sum, row) => sum + (row.delta !== null && row.delta < 0 ? -row.delta : 0), 0);

  let diskUsedDelta = null;
  let unexplainedDelta = null;
  if (scope === before.rootPath && /^[a-z]:\\$/.test(scope) && baseline.isDriveRoot && current.isDriveRoot
    && oldVolume && oldVolume === newVolume && validSize(baseline.drive?.used) && validSize(current.drive?.used)) {
    diskUsedDelta = current.drive.used - baseline.drive.used;
    unexplainedDelta = diskUsedDelta - netDelta;
    warnings.push('磁盘已用容量与逻辑文件容量使用不同口径；两者差额仅为观测差异，不能据此确定具体原因。');
  }

  const breadcrumbs = [];
  let breadcrumbPath = before.rootPath;
  const rootNode = right && scope === before.rootPath ? right : current.scan.root;
  breadcrumbs.push({ path: rootNode.path, name: rootNode.name });
  const suffix = scope.slice(before.rootPath.length).replace(/^\\/, '');
  for (const segment of suffix.split('\\').filter(Boolean)) {
    breadcrumbPath = path.win32.join(breadcrumbPath, segment);
    const node = after.index.get(breadcrumbPath) || before.index.get(breadcrumbPath);
    breadcrumbs.push({ path: node?.path || breadcrumbPath, name: node?.name || segment });
  }
  return { baseline: metadata(baseline), current: metadata(current), scopePath: displayPath, scopeName: right?.name || left.name,
    breadcrumbs, rows: sortChanges(rows), warnings,
    summary: { beforeSize, afterSize, netDelta, growth, released, uncertain, diskUsedDelta, unexplainedDelta } };
}

module.exports = { compareSnapshots, normalizeRoot, sortChanges };
