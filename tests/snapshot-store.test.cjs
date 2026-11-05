'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSnapshotStore } = require('../electron/snapshot-store.cjs');
const { scanDirectory } = require('../electron/scanner.cjs');

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memreader-snapshots-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('memreader-snapshots-'));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}
function snapshot(overrides = {}) {
  const id = randomUUID();
  const rootPath = 'C:\\Games';
  const createdAt = new Date().toISOString();
  const startedAt = new Date(Date.parse(createdAt) - 25).toISOString();
  return {
    schemaVersion: 1, id, rootPath, createdAt, startedAt, scanElapsedMs: 25,
    size: 12, files: 2, folders: 1, skipped: 0, incomplete: false,
    drive: { path: 'C:\\', name: '系统', total: 1000, free: 500, used: 500, fileSystem: 'NTFS', volumeId: 'volume-c' },
    driveBefore: { path: 'C:\\', name: '系统', total: 1000, free: 505, used: 495 },
    isDriveRoot: false, retainedNodes: 3,
    scan: {
      id: `scan-${id}`, skipped: 0, cancelled: false, elapsedMs: 25, startedAt, completedAt: createdAt,
      root: { name: 'Games', path: rootPath, size: 12, files: 2, folders: 1, children: [
        { name: '游戏甲', path: `${rootPath}\\游戏甲`, size: 10, files: 1, folders: 0, childrenTruncated: 1, omittedSize: 10 },
        { name: 'notes.txt', path: `${rootPath}\\notes.txt`, size: 2, files: 1, folders: 0, isFile: true },
      ] },
    },
    ...overrides,
  };
}

test('plain JSON survives reopening and keeps bounded trees and volume identity', async t => {
  const directory = await fixture(t);
  const store = createSnapshotStore(directory);
  const value = snapshot();
  const meta = await store.save(value);
  assert.equal(meta.id, value.id);
  assert.equal('scan' in meta, false);
  const raw = await fs.promises.readFile(path.join(directory, `${value.id}.json`), 'utf8');
  assert.deepEqual(JSON.parse(raw), value);
  assert.ok(raw.includes('游戏甲'));
  const reopened = createSnapshotStore(directory);
  assert.deepEqual(await reopened.list(), [meta]);
  assert.deepEqual(await reopened.get(value.id), value);
  // Callers cannot mutate cached metadata through the returned objects.
  meta.drive.name = 'changed';
  assert.equal((await store.list())[0].drive.name, '系统');
});

test('full directory inventories larger than the former 26k limit survive reopening', async t => {
  const directory = await fixture(t);
  const value = snapshot();
  const children = Array.from({ length: 27000 }, (_, index) => ({
    name: `folder-${index}`, path: `${value.rootPath}\\folder-${index}`, size: 0, files: 0, folders: 0, directoryScanned: true,
  }));
  let branch = { name: 'leaf', path: '', size: 8, files: 3, folders: 0, directoryScanned: true, childrenTruncated: 3, omittedSize: 8 };
  // Build a path deeper than the previous storage depth of 64.
  const segments = Array.from({ length: 80 }, (_, index) => `level-${index}`);
  branch.name = segments.at(-1);
  branch.path = `${value.rootPath}\\${segments.join('\\')}`;
  for (let index = segments.length - 2; index >= 0; index--) branch = {
    name: segments[index], path: `${value.rootPath}\\${segments.slice(0, index + 1).join('\\')}`,
    size: 8, files: 3, folders: segments.length - index - 1, directoryScanned: true, children: [branch],
  };
  children.push(branch);
  value.scan.root = { name: 'Games', path: value.rootPath, size: 8, files: 3, folders: 27080, directoryScanned: true, children };
  value.size = 8; value.files = 3; value.folders = 27080; value.retainedNodes = 27081;
  const store = createSnapshotStore(directory);
  await store.save(value);
  assert.ok(store.cacheToken(value.id));
  const reopened = createSnapshotStore(directory);
  assert.equal((await reopened.list())[0].retainedNodes, 27081);
  const loaded = await reopened.get(value.id);
  assert.equal(loaded.scan.root.children.length, 27001);
  assert.equal(loaded.scan.root.directoryScanned, true);
  let leaf = loaded.scan.root.children.at(-1);
  while (leaf.children) leaf = leaf.children[0];
  assert.equal(leaf.name, 'level-79');
  assert.equal(leaf.omittedSize, 8);
  assert.equal(leaf.directoryScanned, true);
});

test('concurrent saves, lists, and reads remain atomic across store instances', async t => {
  const directory = await fixture(t);
  const first = createSnapshotStore(directory), second = createSnapshotStore(directory);
  const values = Array.from({ length: 14 }, () => snapshot());
  const operations = values.map((value, index) => (index % 2 ? first : second).save(value));
  const during = first.list();
  await Promise.all(operations);
  assert.equal((await during).length, values.length);
  const loaded = await Promise.all(values.map(value => second.get(value.id)));
  assert.deepEqual(new Set(loaded.map(value => value.id)), new Set(values.map(value => value.id)));
  assert.equal((await createSnapshotStore(directory).list()).length, values.length);
  const names = await fs.promises.readdir(directory);
  assert.ok(names.every(name => name.endsWith('.json')));
  const index = JSON.parse(await fs.promises.readFile(path.join(directory, 'index-v1.json'), 'utf8'));
  assert.equal(index.snapshots.length, values.length);
});

test('no count, age, root, or global disk retention silently deletes earlier baselines', async t => {
  const directory = await fixture(t);
  const store = createSnapshotStore(directory);
  const values = Array.from({ length: 34 }, (_, index) => snapshot({ createdAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(), startedAt: new Date(Date.UTC(2020, 0, index + 1) - 25).toISOString() }));
  await Promise.all(values.map(value => store.save(value)));
  assert.equal((await store.list()).length, 34);
  assert.equal((await createSnapshotStore(directory).get(values[0].id)).id, values[0].id);
});

test('invalid ids and duplicate saves cannot traverse or overwrite files', async t => {
  const directory = await fixture(t);
  const store = createSnapshotStore(directory);
  for (const id of ['../outside', '..\\outside', '/absolute', 'C:\\outside', '.', 'hello.json', 'CON', 'index-v1', 'a\0b']) {
    await assert.rejects(store.get(id), { code: 'SNAPSHOT_INVALID_ID' });
    await assert.rejects(store.save(snapshot({ id })), { code: 'SNAPSHOT_INVALID_ID' });
  }
  const value = snapshot();
  await store.save(value);
  await assert.rejects(store.save(value), { code: 'SNAPSHOT_EXISTS' });
  assert.deepEqual(await store.get(value.id), value);
});

test('corrupt records and legacy versions are isolated without deleting their JSON', async t => {
  const directory = await fixture(t);
  const warnings = [];
  const store = createSnapshotStore(directory, { onWarning: value => warnings.push(value) });
  const good = snapshot(), bad = snapshot(), legacy = snapshot();
  await store.save(good);
  await fs.promises.writeFile(path.join(directory, `${bad.id}.json`), '{broken json');
  await fs.promises.writeFile(path.join(directory, `${legacy.id}.json`), JSON.stringify({ ...legacy, schemaVersion: 0 }));
  const reopened = createSnapshotStore(directory, { onWarning: value => warnings.push(value) });
  assert.deepEqual((await reopened.list()).map(value => value.id), [good.id]);
  assert.ok(warnings.some(value => value.code === 'SNAPSHOT_CORRUPT' && value.id === bad.id));
  assert.ok(warnings.some(value => value.code === 'SNAPSHOT_UNSUPPORTED_SCHEMA' && value.id === legacy.id));
  await assert.rejects(reopened.get(bad.id), { code: 'SNAPSHOT_CORRUPT' });
  await assert.rejects(reopened.get(legacy.id), { code: 'SNAPSHOT_UNSUPPORTED_SCHEMA' });
  await assert.rejects(reopened.get(randomUUID()), { code: 'SNAPSHOT_NOT_FOUND' });
  assert.equal(await fs.promises.readFile(path.join(directory, `${bad.id}.json`), 'utf8'), '{broken json');
});

test('damaged or missing metadata indexes recover all records from their source files', async t => {
  const directory = await fixture(t);
  const warnings = [];
  const value = snapshot();
  await createSnapshotStore(directory).save(value);
  const indexPath = path.join(directory, 'index-v1.json');
  await fs.promises.writeFile(indexPath, '{half-written');
  const reopened = createSnapshotStore(directory, { onWarning: value => warnings.push(value) });
  assert.equal((await reopened.list())[0].id, value.id);
  assert.ok(warnings.some(value => value.code === 'SNAPSHOT_INDEX_RECOVERED'));
  assert.equal(JSON.parse(await fs.promises.readFile(indexPath, 'utf8')).snapshots.length, 1);
  await fs.promises.unlink(indexPath);
  assert.equal((await createSnapshotStore(directory).list())[0].id, value.id);
  // An externally damaged record invalidates cached metadata by size/mtime.
  await fs.promises.writeFile(path.join(directory, `${value.id}.json`), '[]');
  assert.deepEqual(await reopened.list(), []);
});

test('oversize and inconsistent payloads fail without losing earlier snapshots', async t => {
  const directory = await fixture(t);
  const warnings = [];
  const small = snapshot();
  const maxFileBytes = Buffer.byteLength(JSON.stringify(small)) + 100;
  const store = createSnapshotStore(directory, { maxFileBytes, onWarning: value => warnings.push(value) });
  await store.save(small);
  const large = snapshot(); large.scan.errors = ['x'.repeat(4000)];
  await assert.rejects(store.save(large), { code: 'SNAPSHOT_TOO_LARGE' });
  const cancelled = snapshot(); cancelled.scan.cancelled = true;
  await assert.rejects(store.save(cancelled), { code: 'SNAPSHOT_INVALID' });
  await assert.rejects(store.save(snapshot({ size: 99 })), { code: 'SNAPSHOT_INVALID' });
  await assert.rejects(store.save(snapshot({ retainedNodes: 2 })), { code: 'SNAPSHOT_INVALID' });
  await assert.rejects(store.save(snapshot({ createdAt: 'not a date' })), { code: 'SNAPSHOT_INVALID' });
  const outside = snapshot(); outside.scan.root.children[0].path = 'C:\\Elsewhere';
  await assert.rejects(store.save(outside), { code: 'SNAPSHOT_INVALID' });
  assert.deepEqual((await store.list()).map(value => value.id), [small.id]);
  assert.ok(warnings.some(value => value.code === 'SNAPSHOT_TOO_LARGE'));
});

test('optional unavailable volume fields are accepted and only scan metadata is persisted', async t => {
  const directory = await fixture(t);
  const value = snapshot({ driveBefore: undefined });
  value.drive.volumeId = '';
  value.drive.fileSystem = null;
  value.scan.root.contents = 'file contents must never be persisted';
  value.extra = 'not part of the schema';
  const store = createSnapshotStore(directory);
  await store.save(value);
  const loaded = await store.get(value.id);
  assert.equal('contents' in loaded.scan.root, false);
  assert.equal('extra' in loaded, false);
  assert.equal('driveBefore' in loaded, false);
  assert.equal('volumeId' in loaded.drive, false);
  assert.equal('fileSystem' in loaded.drive, false);
});

test('real bounded scanner output with unreadable coverage survives strict storage validation', async t => {
  const root = await fixture(t), directory = await fixture(t);
  await fs.promises.mkdir(path.join(root, 'readable', 'deeper'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'protected'));
  await fs.promises.writeFile(path.join(root, 'readable', 'deeper', 'data.bin'), 'THIS_CONTENT_MUST_NOT_BE_IN_THE_SNAPSHOT');
  const scan = await scanDirectory(root, {
    maxChildren: 2, maxDepth: 1,
    inspectDirectory: async location => { if (location === path.join(root, 'protected')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  const countNodes = node => 1 + (node.children || []).reduce((total, child) => total + countNodes(child), 0);
  const value = snapshot({ id: scan.id, rootPath: scan.root.path, createdAt: scan.completedAt, startedAt: scan.startedAt,
    scanElapsedMs: scan.elapsedMs, size: scan.root.size, files: scan.root.files, folders: scan.root.folders,
    skipped: scan.skipped, incomplete: !!scan.root.incomplete, retainedNodes: countNodes(scan.root), drive: null, driveBefore: null, scan });
  assert.equal(scan.root.incomplete, true);
  assert.equal(scan.skipped, 1);
  const store = createSnapshotStore(directory);
  await store.save(value);
  assert.deepEqual(await store.get(value.id), value);
  const raw = await fs.promises.readFile(path.join(directory, `${value.id}.json`), 'utf8');
  assert.equal(raw.includes('THIS_CONTENT_MUST_NOT_BE_IN_THE_SNAPSHOT'), false);
});

test('a directory junction cannot redirect repository writes outside its chosen directory', async t => {
  const directory = await fixture(t);
  const target = await fixture(t);
  const link = path.join(directory, 'store-link');
  await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const store = createSnapshotStore(link);
  await assert.rejects(store.save(snapshot()), { code: 'SNAPSHOT_UNSAFE_DIRECTORY' });
  await assert.rejects(store.list(), { code: 'SNAPSHOT_UNSAFE_DIRECTORY' });
  assert.deepEqual(await fs.promises.readdir(target), []);
});

test('symlink records are not followed and unrelated files remain untouched', async t => {
  const directory = await fixture(t);
  const outsideDirectory = await fixture(t);
  const outside = path.join(outsideDirectory, 'private.json');
  await fs.promises.writeFile(outside, 'private data');
  const id = randomUUID();
  try { await fs.promises.symlink(outside, path.join(directory, `${id}.json`), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows requires symlink privilege'); throw error; }
  const warnings = [];
  const store = createSnapshotStore(directory, { onWarning: value => warnings.push(value) });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.get(id), { code: 'SNAPSHOT_CORRUPT' });
  assert.equal(await fs.promises.readFile(outside, 'utf8'), 'private data');
  assert.ok((await fs.promises.lstat(path.join(directory, `${id}.json`))).isSymbolicLink());
  assert.ok(warnings.some(value => value.id === id));
});
