const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/cache-navigation.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledModule = { exports: {} };
vm.runInNewContext(compiled, { exports: compiledModule.exports, module: compiledModule });
const { normalizeCachePath, directoryHasRetainedPreview, cachedDirectoryResult, historicalTrail } = compiledModule.exports;

const folder = (nodePath, extra = {}) => ({ name: nodePath.split('\\').filter(Boolean).at(-1), path: nodePath, size: 0, files: 0, folders: 0, ...extra });
const freezeTree = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freezeTree);
  }
  return value;
};

test('cache paths compare Windows casing and separators without conflating siblings or drives', () => {
  assert.equal(normalizeCachePath('C:\\'), 'c:');
  assert.equal(normalizeCachePath('C:/Users/DemoUser/'), normalizeCachePath('c:\\users\\demouser'));
  assert.equal(normalizeCachePath('C:\\\\Users//DemoUser\\'), 'c:\\users\\demouser');
  assert.notEqual(normalizeCachePath('C:\\A'), normalizeCachePath('C:\\AB'));
  assert.notEqual(normalizeCachePath('C:\\Users'), normalizeCachePath('D:\\Users'));
});

test('known empty and inaccessible attempted directories open without repeated scans', () => {
  assert.equal(directoryHasRetainedPreview(folder('C:\\Empty')), true);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Empty', { children: [] })), true);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Protected', { inaccessible: true, incomplete: true })), true);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Unknown', { incomplete: true })), false);
  assert.equal(directoryHasRetainedPreview(folder('C:\\file.txt', { isFile: true })), false);
});

test('completed directory scans stay navigable after file previews are omitted', () => {
  const scanned = freezeTree(folder('C:\\Users\\DemoUser\\VeryDeep', { directoryScanned: true, size: 25000, files: 500, folders: 0, omittedSize: 25000, childrenTruncated: 500 }));
  assert.equal(directoryHasRetainedPreview(scanned), true);
  const attempted = freezeTree(folder('C:\\Protected', { directoryScanned: true, incomplete: true }));
  assert.equal(directoryHasRetainedPreview(attempted), true);
  assert.equal(directoryHasRetainedPreview(folder('C:\\file.bin', { isFile: true, directoryScanned: true })), false);
});

test('summary-only and deep aggregate nodes need detail, while partial retained rows remain navigable', () => {
  assert.equal(directoryHasRetainedPreview(folder('C:\\Deep', { size: 5000, files: 4, folders: 2, childrenTruncated: 6, omittedSize: 5000 })), false);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Deep', { childrenTruncated: 4 })), false);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Deep', { files: 1 })), false);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Deep', { folders: 1 })), false);
  assert.equal(directoryHasRetainedPreview(folder('C:\\Deep', { size: 1 })), false);
  const retained = freezeTree(folder('C:\\Partial', { incomplete: true, childrenTruncated: 3, children: [folder('C:\\Partial\\Visible')] }));
  assert.equal(directoryHasRetainedPreview(retained), true);
  const shell = freezeTree(folder('C:\\', { cachePlaceholder: true, incomplete: true, folders: 1 }));
  assert.equal(directoryHasRetainedPreview(shell), true);
});

test('cached fragment result keeps the current directory as root and preserves provenance without mutating input', () => {
  const node = folder('C:\\Users', { size: 1024, files: 1 });
  const directory = freezeTree({ drivePath: 'C:\\', node, trail: [folder('C:\\'), node], snapshotId: 'saved-users', createdAt: '2026-10-16T04:00:00.000Z', generationId: 'disk-generation', rootSnapshotAt: '2026-10-15T04:00:00.000Z', needsScan: false, partial: true, warnings: ['部分内容不可访问'], elapsedMs: 1500, skipped: 2 });
  const before = JSON.stringify(directory);
  const result = cachedDirectoryResult(directory);
  assert.equal(result.root, directory.node);
  assert.equal(result.root.path, 'C:\\Users');
  assert.notEqual(result.root, directory.trail[0]);
  assert.equal(result.id, 'saved-users');
  assert.equal(result.snapshotId, 'saved-users');
  assert.equal(result.startedAt, '2026-10-16T03:59:58.500Z');
  assert.equal(result.completedAt, directory.createdAt);
  assert.equal(result.elapsedMs, 1500);
  assert.equal(result.skipped, 2);
  assert.equal(result.cancelled, false);
  assert.equal(JSON.stringify(directory), before);
});

test('cache navigation shells do not invent a saved snapshot or capture time', () => {
  const directory = freezeTree({ drivePath: 'D:\\', node: folder('D:\\', { cachePlaceholder: true }), trail: [], snapshotId: null, createdAt: null, generationId: null, rootSnapshotAt: null, needsScan: false, partial: true, warnings: [], elapsedMs: 0, skipped: 0 });
  const result = cachedDirectoryResult(directory);
  assert.equal(result.id, 'cached-directory');
  assert.equal(Object.hasOwn(result, 'snapshotId'), false);
  assert.equal(Object.hasOwn(result, 'startedAt'), false);
  assert.equal(Object.hasOwn(result, 'completedAt'), false);
});

test('historical trails stay within their snapshot and compare normalized exact paths', () => {
  const downloads = folder('C:\\Users\\DemoUser\\Downloads');
  const user = folder('C:\\Users\\DemoUser', { children: [downloads] });
  const users = folder('C:\\Users', { children: [user] });
  const root = freezeTree(folder('C:\\', { children: [users, folder('C:\\Users-old')] }));
  const before = JSON.stringify(root);
  const trail = historicalTrail(root, 'c:/USERS/demouser/downloads/');
  assert.equal(trail.length, 4);
  assert.equal(trail[0], root);
  assert.equal(trail[1], users);
  assert.equal(trail[2], user);
  assert.equal(trail[3], downloads);
  assert.equal(historicalTrail(root, 'C:\\Users\\DemoUser\\NewerCacheOnly'), null);
  assert.equal(historicalTrail(root, 'D:\\Users'), null);
  assert.equal(historicalTrail(root, 'C:\\Users-old\\Missing'), null);
  assert.equal(historicalTrail(root, 'c:/')[0], root);
  assert.equal(JSON.stringify(root), before);
});
