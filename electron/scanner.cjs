'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// These are logical file lengths, not NTFS allocated clusters. Hard links are
// counted for each directory entry; compressed/sparse files may use less space.
async function scanDirectory(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const started = Date.now();
  const id = options.id || randomUUID();
  const signal = options.signal;
  // Folder navigation must survive a completed whole-disk scan. The former
  // global, post-order budget was exhausted by the first large subtree, leaving
  // later folders (often Users) with totals but no navigable descendants.
  // Only file previews are bounded by default; every visited directory remains.
  // An explicit maxDepth keeps the older bounded mode for intentional callers.
  const retainDirectories = options.retainDirectories ?? options.maxDepth === undefined;
  const maxDepth = options.maxDepth ?? Infinity;
  const maxChildren = options.maxChildren ?? 160;
  const maxTreeNodes = options.maxTreeNodes ?? 24000;
  let retainedNodes = 0;
  let retainedFiles = 0;
  const errors = [];
  const state = { files: 0, folders: 0, bytes: 0, skipped: 0 };
  let lastProgress = 0;
  let currentPath = root;
  let operations = 0;

  const noteError = (location, error) => {
    state.skipped++;
    if (errors.length < 8) errors.push(`${location}: ${error.code || error.message || error}`);
  };
  const progress = (force = false) => {
    const now = Date.now();
    if (options.onProgress && (force || now - lastProgress >= 120)) {
      lastProgress = now;
      options.onProgress({ id, root, currentPath, ...state, elapsedMs: now - started });
    }
  };
  const yieldOccasionally = async () => {
    if (++operations % 128 === 0) await new Promise(resolve => setImmediate(resolve));
  };
  const makeNode = (name, location) => ({ name, path: location, size: 0, files: 0, folders: 0 });

  const omit = (parent, child) => {
    parent.childrenTruncated = (parent.childrenTruncated || 0) + 1;
    parent.omittedSize = (parent.omittedSize || 0) + child.size;
  };

  // Directory aggregates are inexpensive compared with retaining every file.
  // File previews stay bounded, and omitted file bytes remain in parent totals.
  const retain = (parent, child, depth, retention) => {
    if (retainDirectories) {
      const children = parent.children ||= [];
      if (!child.isFile) { children.push(child); return; }
      if (depth < maxDepth && retention.files < maxChildren && retainedFiles < maxTreeNodes) {
        children.push(child);
        retention.files++;
        retainedFiles++;
        if (retention.minIndex < 0 || child.size < children[retention.minIndex].size) retention.minIndex = children.length - 1;
        return;
      }
      if (retention.minIndex < 0 || child.size <= children[retention.minIndex].size) { omit(parent, child); return; }
      omit(parent, children[retention.minIndex]);
      children[retention.minIndex] = child;
      retention.minIndex = -1;
      for (let i = 0; i < children.length; i++) if (children[i].isFile && (retention.minIndex < 0 || children[i].size < children[retention.minIndex].size)) retention.minIndex = i;
      return;
    }
    if (depth >= maxDepth || (depth > 0 && retainedNodes >= maxTreeNodes)) {
      omit(parent, child);
      return;
    }
    const children = parent.children ||= [];
    if (children.length < maxChildren) {
      children.push(child);
      retainedNodes++;
      if (retention.minIndex < 0 || child.size < children[retention.minIndex].size) retention.minIndex = children.length - 1;
      return;
    }
    parent.childrenTruncated = (parent.childrenTruncated || 0) + 1;
    if (child.size <= children[retention.minIndex].size) {
      parent.omittedSize = (parent.omittedSize || 0) + child.size;
      return;
    }
    parent.omittedSize = (parent.omittedSize || 0) + children[retention.minIndex].size;
    children[retention.minIndex] = child;
    retainedNodes++;
    retention.minIndex = 0;
    for (let i = 1; i < children.length; i++) if (children[i].size < children[retention.minIndex].size) retention.minIndex = i;
  };

  async function visit(location, name, depth) {
    const node = makeNode(name, location);
    currentPath = location;
    if (signal?.aborted) { node.incomplete = true; return node; }
    let stat;
    try { stat = await fs.promises.lstat(location); }
    catch (error) { node.inaccessible = true; node.incomplete = true; noteError(location, error); return node; }
    if (stat.isSymbolicLink()) { state.skipped++; return null; }
    if (stat.isFile()) {
      node.isFile = true;
      node.size = stat.size;
      node.files = 1;
      state.files++;
      state.bytes += stat.size;
      progress();
      await yieldOccasionally();
      return node;
    }
    if (!stat.isDirectory()) { state.skipped++; return null; }

    let reparseEntries;
    try {
      const result = await options.inspectDirectory?.(location, signal);
      if (result?.isReparse) { state.skipped++; return null; }
      reparseEntries = result?.skipNames;
    } catch (error) {
      node.incomplete = true;
      if (!signal?.aborted) { node.inaccessible = true; noteError(location, error); }
      return node;
    }
    state.folders++;
    progress(state.folders === 1);
    const retention = { minIndex: -1, files: 0 };
    try {
      const directory = await fs.promises.opendir(location, { bufferSize: 64 });
      // for-await closes the directory handle even when cancellation breaks it.
      for await (const entry of directory) {
        if (signal?.aborted) break;
        if (reparseEntries?.has(entry.name.toLowerCase())) { state.skipped++; node.incomplete = true; continue; }
        const child = await visit(path.join(location, entry.name), entry.name, depth + 1);
        if (!child) { node.incomplete = true; continue; }
        if (child.incomplete || child.inaccessible) node.incomplete = true;
        node.size += child.size;
        node.files += child.files;
        node.folders += child.folders + (child.isFile ? 0 : 1);
        retain(node, child, depth, retention);
        await yieldOccasionally();
      }
    } catch (error) {
      node.inaccessible = true;
      node.incomplete = true;
      noteError(location, error);
    }
    if (signal?.aborted) node.incomplete = true;
    else if (retainDirectories) node.directoryScanned = true;
    if (node.children) node.children.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    return node;
  }

  progress(true);
  const tree = await visit(root, path.basename(root) || root, 0) || { ...makeNode(path.basename(root) || root, root), inaccessible: true };
  progress(true);
  return { id, root: tree, skipped: state.skipped, cancelled: !!signal?.aborted, elapsedMs: Date.now() - started, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), ...(errors.length ? { errors } : {}) };
}

module.exports = { scanDirectory };
