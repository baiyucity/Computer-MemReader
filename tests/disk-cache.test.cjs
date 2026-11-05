'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createDiskCache } = require('../electron/disk-cache.cjs');
const { createSnapshotStore } = require('../electron/snapshot-store.cjs');

const C = { path: 'C:\\', name: 'SSD', total: 10000, used: 1000, free: 9000, volumeId: 'volume-1' };
const D = { ...C, path: 'D:\\', volumeId: 'volume-2' };
const file = (location, size) => ({ name: path.win32.basename(location), path: location, size, files: 1, folders: 0, isFile: true });
const dir = (location, children = [], extra = {}) => ({ name: path.win32.basename(location) || location, path: location,
  size: children.reduce((sum, node) => sum + node.size, 0), files: children.reduce((sum, node) => sum + node.files, 0),
  folders: children.reduce((sum, node) => sum + node.folders + (node.isFile ? 0 : 1), 0), children, ...extra });
const countNodes = node => 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
function snapshot(id, root, second, extra = {}) {
  const createdAt = new Date(Date.UTC(2026, 9, 16, 0, 0, second)).toISOString();
  const startedAt = new Date(Date.parse(createdAt) - 10).toISOString();
  const scan = { id, root, skipped: 0, cancelled: false, elapsedMs: 10, startedAt, completedAt: createdAt, ...extra.scan };
  return { schemaVersion: 1, id, rootPath: root.path, createdAt, startedAt, scanElapsedMs: 10,
    size: root.size, files: root.files, folders: root.folders, skipped: scan.skipped, incomplete: !!root.incomplete || !!root.inaccessible,
    drive: C, isDriveRoot: /^[a-z]:\\$/i.test(root.path), retainedNodes: countNodes(root), ...extra, scan };
}
function memoryStore(records) {
  const calls = { writes: 0 };
  return { calls,
    list: async () => records.map(({ scan, ...meta }) => structuredClone(meta)),
    get: async id => { const value = records.find(record => record.id === id); if (!value) throw new Error('missing'); return value; },
    save: async () => { calls.writes++; throw new Error('The cache must not write snapshots.'); },
  };
}

test('restores a whole drive and retained descendant directly, with breadcrumb provenance', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\Apps', [dir('C:\\Apps\\Editor', [file('C:\\Apps\\Editor\\data.bin', 100)])])]), 1);
  const cache = createDiskCache(memoryStore([full]));
  const disk = await cache.getDirectory('c:/', C);
  assert.equal(disk.snapshotId, 'full');
  assert.equal(disk.generationId, 'full');
  assert.equal(disk.node.size, 100);
  assert.equal(disk.partial, false);
  assert.equal(disk.needsScan, false);
  const folder = await cache.getDirectory('c:/APPS/editor/', C);
  assert.equal(folder.node.size, 100);
  assert.equal(folder.needsScan, false);
  assert.deepEqual(folder.trail.map(node => node.path.toLowerCase()), ['c:\\', 'c:\\apps', 'c:\\apps\\editor']);
  assert.equal(folder.trail[0].children, undefined);
  assert.equal(folder.trail.at(-1), folder.node);
  assert.equal(folder.createdAt, full.createdAt);
});

test('newer folder fragments overlay navigation while preserving full-drive totals', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\Apps', [file('C:\\Apps\\data.bin', 100)]), file('C:\\other.bin', 10)]), 1);
  const fragment = snapshot('apps-new', dir('C:\\Apps', [file('C:\\Apps\\data.bin', 200)]), 2);
  const store = memoryStore([fragment, full]);
  const original = JSON.stringify([fragment, full]);
  const cache = createDiskCache(store);
  assert.equal((await cache.getDirectory('C:\\', C)).node.size, 110);
  const apps = await cache.getDirectory('C:\\Apps', C);
  assert.equal(apps.node.size, 200);
  assert.equal(apps.snapshotId, 'apps-new');
  assert.equal(apps.generationId, 'full');
  assert.equal(apps.trail[0].size, 110);
  assert.equal(apps.rootSnapshotAt, full.createdAt);
  assert.equal(apps.createdAt, fragment.createdAt);
  assert.equal(store.calls.writes, 0);
  assert.equal(JSON.stringify([fragment, full]), original);
});

test('selects the latest source with usable details rather than a newer summary-only node', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\A', [dir('C:\\A\\B', [file('C:\\A\\B\\data.bin', 10)])])]), 1);
  const parent = snapshot('parent', dir('C:\\A', [dir('C:\\A\\B', [], { size: 20, files: 1, childrenTruncated: 1, omittedSize: 20 })]), 2);
  const result = await createDiskCache(memoryStore([full, parent])).getDirectory('C:\\A\\B', C);
  assert.equal(result.snapshotId, 'full');
  assert.equal(result.createdAt, full.createdAt);
  assert.equal(result.node.size, 10);
  assert.equal(result.needsScan, false);
  assert.ok(result.warnings.some(warning => warning.includes('较早的目录缓存')));
});

test('known nonempty summary needs one scan and its completed fragment is then reusable', async () => {
  const records = [snapshot('full', dir('C:\\', [dir('C:\\A', [], { size: 20, files: 1, childrenTruncated: 1, omittedSize: 20 })]), 1)];
  const cache = createDiskCache(memoryStore(records));
  const summary = await cache.getDirectory('C:\\A', C);
  assert.equal(summary.needsScan, true);
  assert.equal(summary.node.size, 20);
  records.push(snapshot('detail', dir('C:\\A', [file('C:\\A\\data.bin', 30)]), 2));
  const detail = await cache.getDirectory('C:\\A', C);
  assert.equal(detail.needsScan, false);
  assert.equal(detail.snapshotId, 'detail');
  assert.equal((await cache.getDirectory('C:\\A', C)).snapshotId, 'detail');
});

test('completed directory aggregates remain browsable even when no file preview fit the budget', async () => {
  const folder = dir('C:\\Users', [], { size: 200, files: 50, childrenTruncated: 50, omittedSize: 200, directoryScanned: true });
  const result = await createDiskCache(memoryStore([snapshot('full', dir('C:\\', [folder], { directoryScanned: true }), 1)])).getDirectory('C:\\Users', C);
  assert.equal(result.needsScan, false);
  assert.equal(result.node.size, 200);
  assert.equal(result.node.directoryScanned, true);
  assert.equal(result.node.omittedSize, 200);
  assert.ok(!result.warnings.some(warning => warning.includes('补齐明细')));
});

test('a small navigation preview preserves full server-side descendants and saved drive sampling', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\Users', [dir('C:\\Users\\Alice', [dir('C:\\Users\\Alice\\Cache', [file('C:\\Users\\Alice\\Cache\\cache.bin', 25)], { directoryScanned: true })], { directoryScanned: true })], { directoryScanned: true })], { directoryScanned: true }), 1);
  const cache = createDiskCache(memoryStore([full]));
  const root = await cache.getDirectory('C:\\', { ...C, used: 9999, free: 1 });
  const clipped = root.node.children[0].children[0];
  assert.equal(clipped.children, undefined);
  assert.equal(clipped.omittedSize, 25);
  assert.equal(clipped.childrenTruncated, 1);
  assert.equal(root.drive.used, C.used, 'a current live sample cannot replace the saved scan sample');
  const deep = await cache.getDirectory('C:\\Users\\Alice\\Cache', C);
  assert.equal(deep.needsScan, false);
  assert.equal(deep.node.children[0].name, 'cache.bin');
  assert.equal(full.scan.root.children[0].children[0].children[0].children[0].size, 25);
});

test('recent immutable parsed snapshots are reused and invalidated by a changed storage token', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\Users')]), 1);
  const store = memoryStore([full]);
  let reads = 0, revision = 1;
  const original = store.get;
  store.get = async id => { reads++; return original(id); };
  store.cacheToken = () => String(revision);
  const cache = createDiskCache(store);
  await cache.getDirectory('C:\\', C);
  await cache.getDirectory('C:\\Users', C);
  await cache.getDirectory('C:\\', C);
  assert.equal(reads, 1);
  revision++;
  await cache.getDirectory('C:\\Users', C);
  assert.equal(reads, 2);
});

test('empty folders and failed cached attempts do not cause automatic rescanning loops', async () => {
  const empty = { name: 'Empty', path: 'C:\\Empty', size: 0, files: 0, folders: 0 };
  const denied = { name: 'Denied', path: 'C:\\Denied', size: 0, files: 0, folders: 0, inaccessible: true, incomplete: true };
  const full = snapshot('full', dir('C:\\', [empty, denied], { incomplete: true }), 1, { scan: { skipped: 1 } });
  const cache = createDiskCache(memoryStore([full]));
  assert.equal((await cache.getDirectory('C:\\Empty', C)).needsScan, false);
  const failed = await cache.getDirectory('C:\\Denied', C);
  assert.equal(failed.needsScan, false);
  assert.equal(failed.node.inaccessible, true);
  assert.ok(failed.warnings.some(warning => warning.includes('手动重新扫描')));
});

test('truncation with retained preview children is usable and incomplete does not auto-rescan', async () => {
  const preview = dir('C:\\Preview', [file('C:\\Preview\\known.bin', 10)], { size: 100, files: 9, childrenTruncated: 8, omittedSize: 90, incomplete: true });
  const cache = createDiskCache(memoryStore([snapshot('full', dir('C:\\', [preview], { incomplete: true }), 1, { scan: { skipped: 1 } })]));
  const result = await cache.getDirectory('C:\\Preview', C);
  assert.equal(result.node.childrenTruncated, 8);
  assert.equal(result.needsScan, false);
});

test('a new completed whole-drive scan resets fragments without deleting immutable history', async () => {
  const records = [snapshot('old-full', dir('C:\\', [dir('C:\\A', [file('C:\\A\\old.bin', 10)])]), 1),
    snapshot('old-fragment', dir('C:\\A', [file('C:\\A\\old.bin', 20)]), 2),
    snapshot('only-old', dir('C:\\OldOnly', [file('C:\\OldOnly\\old.bin', 7)]), 2)];
  const cache = createDiskCache(memoryStore(records));
  assert.equal((await cache.getDirectory('C:\\A', C)).snapshotId, 'old-fragment');
  const oldHistory = JSON.stringify(records);
  records.push(snapshot('new-full', dir('C:\\', [dir('C:\\A', [], { size: 30, files: 1, childrenTruncated: 1, omittedSize: 30 })]), 3));
  const reset = await cache.getDirectory('C:\\A', C);
  assert.equal(reset.generationId, 'new-full');
  assert.equal(reset.snapshotId, 'new-full');
  assert.equal(reset.node.size, 30);
  assert.equal(reset.needsScan, true);
  assert.equal(await cache.getDirectory('C:\\OldOnly', C), null);
  assert.equal(JSON.stringify(records.slice(0, 3)), oldHistory);
});

test('a completed whole-drive scan with skipped paths still begins a new generation', async () => {
  const records = [snapshot('old-full', dir('C:\\'), 1), snapshot('fragment', dir('C:\\Old', [file('C:\\Old\\data.bin', 7)]), 2),
    snapshot('new-partial-full', dir('C:\\', [], { incomplete: true }), 3, { scan: { skipped: 1 } })];
  const cache = createDiskCache(memoryStore(records));
  const result = await cache.getDirectory('C:\\', C);
  assert.equal(result.generationId, 'new-partial-full');
  assert.equal(result.partial, false);
  assert.equal(result.needsScan, false);
  assert.equal(await cache.getDirectory('C:\\Old', C), null);
});

test('first-ever deep folder scan binds under the drive using explicit zero-stat placeholders', async () => {
  const fragment = snapshot('documents', dir('C:\\Users\\Alice\\Documents', [file('C:\\Users\\Alice\\Documents\\data.bin', 7)]), 1);
  const cache = createDiskCache(memoryStore([fragment]));
  const drive = await cache.getDirectory('C:\\', C);
  assert.equal(drive.node.cachePlaceholder, true);
  assert.equal(drive.node.size, 0);
  assert.equal(drive.node.files, 0);
  assert.equal(drive.node.folders, 0);
  assert.equal(drive.node.children[0].path.toLowerCase(), 'c:\\users');
  assert.equal(drive.node.children[0].size, 0);
  assert.equal(drive.needsScan, true);
  assert.equal(drive.partial, true);
  assert.equal(drive.snapshotId, null);
  assert.equal(drive.generationId, null);
  const users = await cache.getDirectory('C:\\Users', C);
  assert.equal(users.node.children[0].path.toLowerCase(), 'c:\\users\\alice');
  const documents = await cache.getDirectory('C:\\Users\\Alice\\Documents', C);
  assert.equal(documents.node.size, 7);
  assert.equal(documents.snapshotId, 'documents');
  assert.equal(documents.partial, true);
  assert.equal(documents.needsScan, false);
  assert.equal(documents.trail.length, 4);
  assert.ok(documents.trail.slice(0, -1).every(node => node.cachePlaceholder && node.size === 0));
  assert.deepEqual(await cache.listDrives([C]), [{ path: 'C:\\', hasCache: true, rootSnapshotId: null, updatedAt: fragment.createdAt, partial: true }]);
});

test('placeholder navigation never sums child snapshots taken at different times', async () => {
  const cache = createDiskCache(memoryStore([snapshot('a', dir('C:\\A', [file('C:\\A\\data.bin', 100)]), 1), snapshot('b', dir('C:\\B', [file('C:\\B\\data.bin', 200)]), 2)]));
  const disk = await cache.getDirectory('C:\\', C);
  assert.equal(disk.node.size, 0);
  assert.deepEqual(disk.node.children.map(node => node.size), [0, 0]);
  assert.equal((await cache.getDirectory('C:\\A', C)).node.size, 100);
  assert.equal((await cache.getDirectory('C:\\B', C)).node.size, 200);
});

test('unknown paths and files return null and drive-letter boundaries never overlap', async () => {
  const cache = createDiskCache(memoryStore([snapshot('full', dir('C:\\', [file('C:\\file.bin', 7), dir('C:\\Data')]), 1)]));
  assert.equal(await cache.getDirectory('C:\\Missing', C), null);
  assert.equal(await cache.getDirectory('C:\\file.bin', C), null);
  assert.equal(await cache.getDirectory('D:\\', D), null);
  await assert.rejects(cache.getDirectory('D:\\', C), /磁盘不一致/);
  assert.deepEqual((await cache.listDrives([C, D])).map(info => info.hasCache), [true, false]);
});

test('known mismatched volume identity and capacity are excluded from cache', async () => {
  const records = [snapshot('old-drive', dir('C:\\', [dir('C:\\A', [file('C:\\A\\old.bin', 100)])]), 1)];
  const cache = createDiskCache(memoryStore(records));
  const replaced = { ...C, volumeId: 'replacement' };
  assert.equal(await cache.getDirectory('C:\\', replaced), null);
  assert.equal((await cache.listDrives([replaced]))[0].hasCache, false);
  assert.equal(await cache.getDirectory('C:\\', { ...C, total: 20000 }), null);
  records.push(snapshot('new-folder', dir('C:\\New', [file('C:\\New\\new.bin', 1)]), 2, { drive: replaced }));
  const partial = await cache.getDirectory('C:\\', replaced);
  assert.equal(partial.generationId, null);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.node.children.map(node => node.name), ['New']);
});

test('without a supplied drive the latest known identity anchors cache generations', async () => {
  const records = [snapshot('old-drive', dir('C:\\'), 1), snapshot('replacement-folder', dir('C:\\New'), 2, { drive: { ...C, volumeId: 'replacement' } })];
  const result = await createDiskCache(memoryStore(records)).getDirectory('C:\\');
  assert.equal(result.generationId, null);
  assert.equal(result.partial, true);
});

test('unknown volume identity remains usable with an explicit warning', async () => {
  const record = snapshot('unknown', dir('C:\\', [dir('C:\\A')]), 1, { drive: { ...C, volumeId: undefined } });
  const result = await createDiskCache(memoryStore([record])).getDirectory('C:\\', C);
  assert.equal(result.snapshotId, 'unknown');
  assert.ok(result.warnings.some(warning => warning.includes('卷标识不完整')));
  const missingDrive = snapshot('missing-drive', dir('C:\\A'), 1, { drive: null });
  const missingResult = await createDiskCache(memoryStore([missingDrive])).getDirectory('C:\\A', C);
  assert.equal(missingResult.snapshotId, 'missing-drive');
  assert.ok(missingResult.warnings.some(warning => warning.includes('卷标识不完整')));
});

test('fragments at the generation timestamp are eligible and drive badges use latest metadata', async () => {
  const full = snapshot('a-full', dir('C:\\', [dir('C:\\A')]), 1);
  const fragment = snapshot('z-fragment', dir('C:\\A', [file('C:\\A\\data.bin', 7)]), 1);
  const newer = snapshot('latest', dir('C:\\Other'), 2);
  const cache = createDiskCache(memoryStore([full, fragment, newer]));
  assert.equal((await cache.getDirectory('C:\\A', C)).snapshotId, 'z-fragment');
  const info = (await cache.listDrives([C]))[0];
  assert.equal(info.rootSnapshotId, 'a-full');
  assert.equal(info.updatedAt, newer.createdAt);
  assert.equal(info.partial, false);
});

test('unreadable or cancelled sources cannot replace an earlier usable full generation', async () => {
  const records = [snapshot('good', dir('C:\\', [dir('C:\\A')]), 1), snapshot('cancelled', dir('C:\\'), 2, { scan: { cancelled: true } })];
  const store = memoryStore(records);
  const result = await createDiskCache(store).getDirectory('C:\\', C);
  assert.equal(result.generationId, 'good');
  assert.equal(result.snapshotId, 'good');
  assert.ok(result.warnings.some(warning => warning.includes('已跳过')));
  const originalGet = store.get;
  store.get = async id => { if (id === 'cancelled') throw new Error('unreadable'); return originalGet(id); };
  assert.equal((await createDiskCache(store).getDirectory('C:\\', C)).generationId, 'good');
});

test('returned mutable nodes cannot mutate immutable snapshot history', async () => {
  const record = snapshot('full', dir('C:\\', [dir('C:\\A', [file('C:\\A\\data.bin', 7)])]), 1);
  const original = JSON.stringify(record);
  const store = memoryStore([record]);
  const cache = createDiskCache(store);
  const result = await cache.getDirectory('C:\\A', C);
  result.node.children[0].size = 999;
  result.trail[0].size = 999;
  assert.equal((await cache.getDirectory('C:\\A', C)).node.size, 7);
  assert.equal(JSON.stringify(record), original);
  assert.equal(store.calls.writes, 0);
});

test('newer complete ancestor absence masks old exact folders and deeper placeholders', async () => {
  const full = snapshot('full', dir('C:\\', [dir('C:\\Users', [dir('C:\\Users\\Old', [file('C:\\Users\\Old\\old.bin', 10)])])]), 1);
  const old = snapshot('old-fragment', dir('C:\\Users\\Old', [file('C:\\Users\\Old\\old.bin', 20)]), 2);
  const deep = snapshot('old-deep-fragment', dir('C:\\Users\\Old\\Unretained\\Deep', [file('C:\\Users\\Old\\Unretained\\Deep\\old.bin', 30)]), 2);
  const nowEmpty = snapshot('users-empty', dir('C:\\Users'), 3);
  const records = [full, old, deep, nowEmpty];
  const original = JSON.stringify(records);
  const cache = createDiskCache(memoryStore(records));
  assert.equal(await cache.getDirectory('C:\\Users\\Old', C), null);
  assert.equal(await cache.getDirectory('C:\\Users\\Old\\Unretained', C), null);
  assert.equal(await cache.getDirectory('C:\\Users\\Old\\Unretained\\Deep', C), null);
  assert.equal((await cache.getDirectory('C:\\Users', C)).snapshotId, 'users-empty');
  assert.equal((await cache.getDirectory('C:\\', C)).snapshotId, 'full');
  assert.equal(JSON.stringify(records), original);
});

test('an enumerated directory can establish folder absence despite omitted file previews', async () => {
  const old = snapshot('old', dir('C:\\Users\\Gone', [file('C:\\Users\\Gone\\old.bin', 20)]), 1);
  const current = snapshot('current', dir('C:\\Users', [], { directoryScanned: true, size: 100, files: 50, childrenTruncated: 50, omittedSize: 100 }), 2);
  const cache = createDiskCache(memoryStore([old, current]));
  assert.equal(await cache.getDirectory('C:\\Users\\Gone', C), null);
  assert.equal((await cache.getDirectory('C:\\Users', C)).needsScan, false);
});

test('unknown omission from truncated or incomplete ancestors keeps older retained data', async () => {
  const old = snapshot('old', dir('C:\\Users\\Old', [file('C:\\Users\\Old\\old.bin', 20)]), 1);
  for (const incomplete of [false, true]) {
    const newer = snapshot('users', dir('C:\\Users', [], incomplete
      ? { incomplete: true }
      : { size: 10, files: 1, childrenTruncated: 1, omittedSize: 10 }), 2);
    const result = await createDiskCache(memoryStore([old, newer])).getDirectory('C:\\Users\\Old', C);
    assert.equal(result.snapshotId, 'old');
    assert.equal(result.needsScan, false);
  }
});

test('a later fragment may recreate a previously absent branch without reviving old siblings', async () => {
  const old = snapshot('old', dir('C:\\Users\\Old', [dir('C:\\Users\\Old\\Sibling', [file('C:\\Users\\Old\\Sibling\\old.bin', 20)])]), 1);
  const absent = snapshot('absence', dir('C:\\Users'), 2);
  const recreated = snapshot('new-deep', dir('C:\\Users\\Old\\New', [file('C:\\Users\\Old\\New\\new.bin', 7)]), 3);
  const cache = createDiskCache(memoryStore([old, absent, recreated]));
  const parent = await cache.getDirectory('C:\\Users\\Old', C);
  assert.equal(parent.node.cachePlaceholder, true);
  assert.deepEqual(parent.node.children.map(node => node.name), ['New']);
  assert.equal((await cache.getDirectory('C:\\Users\\Old\\New', C)).snapshotId, 'new-deep');
  assert.equal(await cache.getDirectory('C:\\Users\\Old\\Sibling', C), null);
});

test('newer summary after a proved absence cannot reuse details from before that absence', async () => {
  const old = snapshot('old', dir('C:\\Users\\Old', [file('C:\\Users\\Old\\old.bin', 20)]), 1);
  const absent = snapshot('absence', dir('C:\\Users'), 2);
  const summary = snapshot('new-summary', dir('C:\\Users', [dir('C:\\Users\\Old', [], { size: 7, files: 1, childrenTruncated: 1, omittedSize: 7 })]), 3);
  const result = await createDiskCache(memoryStore([old, absent, summary])).getDirectory('C:\\Users\\Old', C);
  assert.equal(result.snapshotId, 'new-summary');
  assert.equal(result.node.size, 7);
  assert.equal(result.needsScan, true);
});

test('recreated cache resolves persisted immutable JSON without new snapshot writes', async t => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memreader-cache-test-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('memreader-cache-test-'));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  const store = createSnapshotStore(temporary);
  const full = snapshot('full', dir('C:\\', [dir('C:\\A', [file('C:\\A\\data.bin', 7)])]), 1);
  const fragment = snapshot('fragment', dir('C:\\A', [file('C:\\A\\data.bin', 9)]), 2);
  await store.save(full); await store.save(fragment);
  const original = await fs.promises.readFile(path.join(temporary, 'full.json'), 'utf8');
  const recreatedStore = createSnapshotStore(temporary);
  const cache = createDiskCache(recreatedStore);
  assert.equal((await cache.getDirectory('C:\\', C)).node.size, 7);
  assert.equal((await cache.getDirectory('C:\\A', C)).node.size, 9);
  assert.equal((await recreatedStore.list()).length, 2);
  assert.equal(await fs.promises.readFile(path.join(temporary, 'full.json'), 'utf8'), original);
  assert.deepEqual((await fs.promises.readdir(temporary)).sort(), ['fragment.json', 'full.json', 'index-v1.json']);
});
