const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTs(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, { exports: compiledModule.exports, module: compiledModule, require: name === 'storage-preview' ? () => loadTs('cache-navigation') : undefined });
  return compiledModule.exports;
}
const { storagePreview, UNATTRIBUTED_ID, FREE_SPACE_ID } = loadTs('storage-preview');
const node = (nodePath, size, extra = {}) => ({ name: nodePath.split('\\').filter(Boolean).at(-1) || nodePath, path: nodePath, size, files: 1, folders: 0, ...extra });
const drive = (total = 1000, free = 200) => ({ path: 'C:\\', name: 'Local disk', total, free, used: total - free });
const item = (preview, id) => preview.items.find(entry => entry.id === id);

test('whole-drive preview closes the capacity equation including readable omitted files', () => {
  const rows = [node('C:\\Users', 500), node('C:\\Windows', 100), node('C:\\Protected', 0, { inaccessible: true })];
  const root = node('C:\\', 650, { children: rows, omittedSize: 50, childrenTruncated: 4 });
  const before = JSON.stringify({ root, rows });
  const preview = storagePreview(root, rows, drive());
  assert.equal(preview.wholeDrive, true);
  assert.equal(preview.scannedTotal, 650);
  assert.equal(preview.unattributed, 150);
  assert.equal(preview.free, 200);
  assert.equal(preview.total, 1000);
  assert.equal(preview.items.reduce((sum, entry) => sum + entry.value, 0), 1000);
  assert.equal(item(preview, '__omitted').value, 50);
  assert.equal(item(preview, UNATTRIBUTED_ID).color, '#b6b8be');
  assert.equal(item(preview, FREE_SPACE_ID).color, '#ffffff');
  assert.equal(item(preview, UNATTRIBUTED_ID).openable, false);
  assert.equal(item(preview, FREE_SPACE_ID).openable, false);
  assert.equal(item(preview, '__omitted').openable, false);
  assert.equal(JSON.stringify({ root, rows }), before);
});

test('saved capture free bytes determine the estimate without using the drive used field', () => {
  const root = node('C:\\', 400);
  const rows = [node('C:\\Users', 400)];
  const capturedSample = { ...drive(1000, 100), used: 123 };
  const preview = storagePreview(root, rows, capturedSample);
  assert.equal(preview.unattributed, 500);
  assert.equal(preview.free, 100);
  assert.equal(preview.total, 1000);
  assert.equal(capturedSample.used, 123);
});

test('child directories and a different drive never inherit a whole-drive residual', () => {
  const rows = [node('C:\\Users\\DemoUser', 400)];
  for (const root of [node('C:\\Users', 400), node('D:\\', 400)]) {
    const preview = storagePreview(root, rows, drive());
    assert.equal(preview.wholeDrive, false);
    assert.equal(preview.total, 400);
    assert.equal(item(preview, UNATTRIBUTED_ID), undefined);
    assert.equal(item(preview, FREE_SPACE_ID), undefined);
  }
  assert.equal(storagePreview(node('c:/', 400), rows, drive()).wholeDrive, true);
});

test('search results exclude omitted aggregates, free capacity and unknown capacity', () => {
  const rows = [node('C:\\Users', 400)];
  const root = node('C:\\', 650, { omittedSize: 250 });
  const preview = storagePreview(root, rows, drive(), true);
  assert.equal(preview.total, 400);
  assert.equal(preview.scannedTotal, 400);
  assert.equal(preview.wholeDrive, false);
  assert.equal(preview.items.length, 1);
});

test('navigation-only roots and unavailable capacity samples do not fabricate a disk map', () => {
  const rows = [node('C:\\Users', 400)];
  assert.equal(storagePreview(node('C:\\', 0, { cachePlaceholder: true }), rows, drive()).wholeDrive, false);
  for (const sample of [null, undefined, drive(0, 0), drive(1000, 1001), drive(1000, -1), drive(NaN, 200), drive(1000, Infinity)]) {
    const preview = storagePreview(node('C:\\', 400), rows, sample);
    assert.equal(preview.total, 400);
    assert.equal(preview.unattributed, 0);
    assert.equal(preview.free, 0);
    assert.equal(preview.wholeDrive, false);
  }
});

test('logical size greater than allocated bytes remains unscaled and has no negative residual', () => {
  const rows = [node('C:\\Users', 850), node('C:\\Windows', 100)];
  const preview = storagePreview(node('C:\\', 950), rows, drive());
  assert.equal(preview.logicalMismatch, true);
  assert.equal(preview.wholeDrive, false);
  assert.equal(preview.total, 950);
  assert.equal(item(preview, rows[0].path).value, 850);
  assert.equal(preview.unattributed, 0);
  assert.equal(preview.free, 0);
  assert.equal(item(preview, UNATTRIBUTED_ID), undefined);
  assert.equal(item(preview, FREE_SPACE_ID), undefined);
});

test('an exactly covered used region omits the zero residual but preserves available capacity', () => {
  const rows = [node('C:\\Users', 800)];
  const preview = storagePreview(node('C:\\', 800), rows, drive());
  assert.equal(preview.wholeDrive, true);
  assert.equal(preview.logicalMismatch, false);
  assert.equal(preview.unattributed, 0);
  assert.equal(item(preview, UNATTRIBUTED_ID), undefined);
  assert.equal(item(preview, FREE_SPACE_ID).value, 200);
  assert.equal(preview.total, 1000);
});

test('nested retained files and omitted file previews partition their directory without becoming scan targets', () => {
  const file = node('C:\\Users\\visible.bin', 300, { isFile: true });
  const folder = node('C:\\Users', 500, { children: [file], omittedSize: 200 });
  const rootFile = node('C:\\pagefile.sys', 100, { isFile: true });
  const preview = storagePreview(node('C:\\', 600), [folder, rootFile], drive());
  const directoryItem = item(preview, folder.path);
  assert.equal(directoryItem.openable, true);
  assert.equal(directoryItem.children.reduce((sum, entry) => sum + entry.value, 0), 500);
  const omitted = directoryItem.children.find(entry => entry.kind === 'omitted');
  assert.equal(omitted.value, 200);
  assert.equal(omitted.openable, false);
  assert.equal(item(preview, rootFile.path).openable, false);
});
