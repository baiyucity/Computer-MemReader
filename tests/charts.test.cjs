const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/chart-layout.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const compiledModule = { exports: {} };
vm.runInNewContext(compiled, { exports: compiledModule.exports, module: compiledModule });
const { layoutTreemap, formatBytes, percentage } = compiledModule.exports;

test('treemap covers its frame with exact capacity proportions and no overlapping cells', () => {
  const items = [49, 25, 11, 9, 5, 1].map((value, index) => ({ id: String(index), value }));
  for (const [width, height] of [[800, 405], [375, 350], [405, 800]]) {
    const rectangles = layoutTreemap(items, width, height);
    assert.equal(rectangles.length, items.length);
    let area = 0;
    rectangles.forEach(rect => {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.x + rect.width <= width + 1e-7);
      assert.ok(rect.y + rect.height <= height + 1e-7);
      assert.ok(Math.abs(rect.width * rect.height / (width * height) - rect.item.value / 100) < 1e-9);
      area += rect.width * rect.height;
    });
    assert.ok(Math.abs(area - width * height) < 1e-7);
    for (let first = 0; first < rectangles.length; first++) for (let second = first + 1; second < rectangles.length; second++) {
      const a = rectangles[first], b = rectangles[second];
      const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapWidth <= 1e-7 || overlapHeight <= 1e-7);
    }
  }
});

test('treemap ignores unusable values and supports one item and very small shares', () => {
  const rects = layoutTreemap([{ id: 'large', value: 1e12 }, { id: 'tiny', value: 1 }, { id: 'zero', value: 0 }, { id: 'bad', value: NaN }, { id: 'negative', value: -1 }], 1000, 400);
  assert.equal(rects.length, 2);
  assert.ok(rects.every(rect => Number.isFinite(rect.width) && Number.isFinite(rect.height)));
  const single = layoutTreemap([{ id: 'single', value: 10 }], 1000, 400)[0];
  assert.equal(single.width, 1000);
  assert.equal(single.height, 400);
  assert.equal(layoutTreemap([], 1000, 400).length, 0);
  assert.equal(layoutTreemap([{ id: 'x', value: 1 }], 0, 400).length, 0);
});

test('capacity labels use binary units and preserve tiny share information', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 ** 3 * 24.5), '24.5 GB');
  assert.equal(percentage(1, 10000), '<0.1%');
  assert.equal(percentage(25, 100), '25%');
  assert.equal(percentage(10, 0), '0%');
});
