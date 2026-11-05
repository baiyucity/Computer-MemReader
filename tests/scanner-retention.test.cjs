'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDirectory } = require('../electron/scanner.cjs');
const { createSnapshotStore } = require('../electron/snapshot-store.cjs');
const { createDiskCache } = require('../electron/disk-cache.cjs');

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memreader-retention-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('memreader-retention-'));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

const find = (node, name) => node.children?.find(child => child.name === name);

test('whole-scan directory navigation survives file-preview budget exhaustion and deep paths', async t => {
  const root = await fixture(t);
  const deep = ['Users', 'Alice', 'AppData', 'Local', 'Vendor', 'Cache', 'Versions', 'Latest'];
  await fs.promises.mkdir(path.join(root, ...deep), { recursive: true });
  for (let i = 0; i < 6; i++) {
    const folder = path.join(root, `early-${i}`, 'data');
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(path.join(folder, 'large.bin'), Buffer.alloc(10));
    await fs.promises.writeFile(path.join(folder, 'small.bin'), Buffer.alloc(1));
  }
  await fs.promises.writeFile(path.join(root, ...deep, 'cache.bin'), Buffer.alloc(7));
  const result = await scanDirectory(root, { maxChildren: 1, maxTreeNodes: 1 });
  assert.equal(result.root.size, 73);
  assert.equal(result.root.files, 13);
  assert.equal(result.root.folders, 20);
  assert.equal(result.root.children.length, 7, 'directory siblings are never subject to the file limit');
  let current = result.root;
  for (const segment of deep) {
    current = find(current, segment);
    assert.ok(current, `retained ${segment} after the old depth limit`);
    assert.equal(current.directoryScanned, true);
    assert.equal(current.size, 7);
  }
  const pending = [result.root];
  let previewFiles = 0, previewBytes = 0, omittedBytes = 0;
  while (pending.length) {
    const node = pending.pop();
    if (node.isFile) { previewFiles++; previewBytes += node.size; }
    else {
      assert.equal(node.directoryScanned, true);
      assert.equal((node.children || []).reduce((sum, child) => sum + child.size, 0) + (node.omittedSize || 0), node.size);
      omittedBytes += node.omittedSize || 0;
    }
    pending.push(...node.children || []);
  }
  assert.equal(previewFiles, 1);
  assert.equal(previewBytes + omittedBytes, 73);
  assert.ok(omittedBytes > 0);
});

test('per-directory file previews keep the largest files without evicting any directory', async t => {
  const root = await fixture(t);
  await fs.promises.mkdir(path.join(root, 'empty'));
  for (const size of [2, 7, 4, 9]) await fs.promises.writeFile(path.join(root, `${size}.bin`), Buffer.alloc(size));
  const result = await scanDirectory(root, { maxChildren: 2 });
  assert.deepEqual(result.root.children.filter(node => node.isFile).map(node => node.size), [9, 7]);
  assert.equal(find(result.root, 'empty').directoryScanned, true);
  assert.equal(result.root.omittedSize, 6);
  assert.equal(result.root.childrenTruncated, 2);
  assert.equal(result.root.size, 22);
});

test('a cancelled enumeration never receives the completed-directory marker', async t => {
  const root = await fixture(t);
  await fs.promises.writeFile(path.join(root, 'data.bin'), Buffer.alloc(9));
  const controller = new AbortController();
  const result = await scanDirectory(root, { signal: controller.signal, onProgress: progress => {
    if (progress.folders > 0) controller.abort();
  } });
  assert.equal(result.cancelled, true);
  assert.equal(result.root.directoryScanned, undefined);
  assert.equal(result.root.incomplete, true);
});

test('a persisted full-scan generation reopens Users and deep folders without another scan', async t => {
  const root = await fixture(t), storage = await fixture(t);
  const parts = ['Users', 'Alice', 'AppData', 'Local', 'Example', 'Cache', 'Versions', 'Current', 'Data'];
  await fs.promises.mkdir(path.join(root, ...parts), { recursive: true });
  await fs.promises.writeFile(path.join(root, ...parts, 'data.bin'), Buffer.alloc(55));
  const scan = await scanDirectory(root, { maxTreeNodes: 0 });
  // The fixture stands in for a C drive; only its test paths are remapped.
  let nodes = 0;
  const remap = node => {
    nodes++;
    const relative = path.relative(root, node.path);
    return { ...node, path: path.win32.join('C:\\', relative), name: relative ? node.name : 'C:\\',
      ...(node.children ? { children: node.children.map(remap) } : {}) };
  };
  const tree = remap(scan.root);
  const drive = { path: 'C:\\', name: 'Fixture', total: 1000, used: 100, free: 900, volumeId: 'test-drive' };
  const snapshot = { schemaVersion: 1, id: scan.id, rootPath: 'C:\\', createdAt: scan.completedAt, startedAt: scan.startedAt,
    scanElapsedMs: scan.elapsedMs, size: tree.size, files: tree.files, folders: tree.folders, skipped: scan.skipped,
    incomplete: false, drive, isDriveRoot: true, retainedNodes: nodes, scan: { ...scan, root: tree } };
  await createSnapshotStore(storage).save(snapshot);
  const savedFile = path.join(storage, `${snapshot.id}.json`);
  const before = await fs.promises.readFile(savedFile, 'utf8');
  const reopened = createSnapshotStore(storage);
  const cache = createDiskCache(reopened);
  for (const location of ['C:\\', 'C:\\Users', path.win32.join('C:\\', ...parts)]) {
    const directory = await cache.getDirectory(location, drive);
    assert.equal(directory.needsScan, false);
    assert.equal(directory.node.size, 55);
    assert.equal(directory.generationId, scan.id);
    assert.equal(directory.node.directoryScanned, true);
  }
  assert.equal((await reopened.list()).length, 1);
  assert.equal(await fs.promises.readFile(savedFile, 'utf8'), before, 'navigation neither rescans nor rewrites history');
});
