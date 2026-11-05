'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDirectory } = require('../electron/scanner.cjs');
const { softwareLocationGuard, normalizeSoftware, createReparseInspector } = require('../electron/windows.cjs');

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memreader-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('memreader-test-'));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('folder totals remain exact when children or descendant trees are truncated', async t => {
  const root = await fixture(t);
  await fs.promises.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'nested', 'deep', 'large.bin'), Buffer.alloc(100));
  await fs.promises.writeFile(path.join(root, 'nested', 'small.bin'), Buffer.alloc(10));
  await fs.promises.writeFile(path.join(root, 'tiny.bin'), Buffer.alloc(2));
  await fs.promises.writeFile(path.join(root, 'medium.bin'), Buffer.alloc(20));
  const progress = [];
  const result = await scanDirectory(root, { maxChildren: 2, maxDepth: 1, onProgress: event => progress.push(event) });
  assert.equal(result.root.size, 132);
  assert.equal(result.root.files, 4);
  assert.equal(result.root.folders, 2);
  assert.equal(result.root.children.length, 2);
  assert.equal(result.root.children[0].name, 'nested');
  assert.equal(result.root.children[0].size, 110);
  assert.equal(result.root.children[1].isFile, true);
  assert.equal(result.root.omittedSize, 2);
  assert.equal(result.root.childrenTruncated, 1);
  assert.equal(result.root.children[0].omittedSize, 110);
  assert.equal(progress.at(-1).bytes, result.root.size);
  assert.equal(result.cancelled, false);
});

test('junctions and symbolic directory links cannot create traversal cycles', async t => {
  const root = await fixture(t);
  await fs.promises.mkdir(path.join(root, 'data'));
  await fs.promises.writeFile(path.join(root, 'data', 'file.bin'), Buffer.alloc(9));
  await fs.promises.symlink(root, path.join(root, 'data', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanDirectory(root);
  assert.equal(result.root.size, 9);
  assert.equal(result.root.files, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.root.children[0].children.length, 1);
});

test('cancellation resolves with an explicit partial result and closes directory handles', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 24; i++) await fs.promises.writeFile(path.join(root, `${i}.bin`), Buffer.alloc(1));
  const controller = new AbortController();
  const result = await scanDirectory(root, { signal: controller.signal, onProgress: event => { if (event.folders > 0) controller.abort(); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.root.size, 0);
  assert.equal(result.root.files, 0);
  assert.equal(result.skipped, 0);
  // A second complete scan verifies that the cancelled iterator released handles.
  assert.equal((await scanDirectory(root)).root.size, 24);
});

test('Windows reparse helper classifies a real junction without following it', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  await fs.promises.mkdir(path.join(root, 'normal'));
  await fs.promises.symlink(root, path.join(root, 'loop'), 'junction');
  const inspector = createReparseInspector();
  t.after(() => inspector.close());
  const entries = await inspector.inspect(root);
  assert.equal(entries.isReparse, false);
  assert.ok(entries.skipNames.has('loop'));
  assert.equal((await inspector.inspect(path.join(root, 'loop'))).isReparse, true);
  const result = await scanDirectory(root, { inspectDirectory: directory => inspector.inspect(directory) });
  assert.equal(result.skipped, 1);
  assert.equal(result.root.folders, 1);
});

test('software measurement refuses drive roots and shared generic directories', () => {
  for (const location of ['C:\\', 'D:\\', 'C:\\Program Files', 'C:\\Program Files (x86)\\', 'C:\\Program Files\\Common Files', 'C:\\Windows\\System32', 'C:\\Users\\Alice', 'C:\\Users\\Alice\\Desktop', 'C:\\Users\\Alice\\AppData\\Local', 'C:\\Users\\Alice\\AppData\\Local\\Programs', '\\\\server\\share\\App']) {
    assert.equal(softwareLocationGuard(location).safe, false, location);
  }
  for (const location of ['C:\\Program Files\\Example', 'D:\\Games\\Example', 'C:\\Users\\Alice\\AppData\\Local\\Example']) assert.equal(softwareLocationGuard(location).safe, true, location);
});

test('software estimates convert registry KiB to bytes and deduplicate registry views', () => {
  const result = normalizeSoftware([
    { name: 'Editor', publisher: 'Example', version: '1', installLocation: 'C:\\Program Files\\Editor', estimatedKb: 15 },
    { name: 'Editor', publisher: 'Example', version: '1', installLocation: 'C:\\Program Files\\Editor', estimatedKb: 20 },
    { name: 'Editor Tools', publisher: 'Example', installLocation: 'C:\\Program Files\\Editor', estimatedKb: 0 },
    { name: 'Unknown', estimatedKb: 0 },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].size, 20 * 1024);
  assert.equal(result[0].sizeSource, 'estimated');
  assert.equal(result[0].shared, true);
  assert.equal(result.find(item => item.name === 'Unknown').sizeSource, 'unknown');
});
