'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compareSnapshots, normalizeRoot, sortChanges } = require('../electron/comparison.cjs');

const file = (location, size, extra = {}) => ({ name: path.win32.basename(location), path: location, size, files: 1, folders: 0, isFile: true, ...extra });
const dir = (location, children = [], extra = {}) => ({ name: path.win32.basename(location) || location, path: location,
  size: children.reduce((sum, node) => sum + node.size, 0), files: children.reduce((sum, node) => sum + node.files, 0),
  folders: children.reduce((sum, node) => sum + node.folders + (node.isFile ? 0 : 1), 0), children, ...extra });
function snapshot(root, extra = {}) {
  const scan = { id: 'scan', root, skipped: 0, cancelled: false, elapsedMs: 10, ...extra.scan };
  return { schemaVersion: 1, id: 'snapshot', rootPath: root.path, createdAt: '2026-10-16T01:00:00.000Z', startedAt: '2026-10-16T00:59:59.990Z',
    scanElapsedMs: 10, size: root.size, files: root.files, folders: root.folders, skipped: scan.skipped,
    incomplete: !!root.incomplete || !!root.inaccessible, drive: { path: 'C:\\', name: 'SSD', total: 10000, free: 9000, used: 1000, volumeId: 'volume-1' },
    isDriveRoot: normalizeRoot(root.path) === 'c:\\', retainedNodes: 1, ...extra, scan };
}
const byName = result => Object.fromEntries(result.rows.map(row => [row.name, row]));
const observedSum = result => result.rows.reduce((sum, row) => sum + row.observedDelta, 0);

test('normalizes Windows drive roots, separators, dot components and path casing', () => {
  assert.equal(normalizeRoot('C:/Data/folder/../'), 'c:\\data');
  assert.equal(normalizeRoot('C:\\'), 'c:\\');
  for (const value of ['C:relative', '/tmp/example', '\\\\server\\share', 'C:\\data\0bad']) assert.throws(() => normalizeRoot(value), /绝对路径/);
});

test('direct child rows partition the scope without counting nested files twice', () => {
  const before = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [file('C:\\Data\\A\\inside.bin', 100)]), file('C:\\Data\\B.bin', 40)]));
  const after = snapshot(dir('c:\\DATA\\', [dir('c:\\DATA\\a', [file('c:\\DATA\\a\\inside.bin', 70)]), file('c:\\DATA\\B.bin', 90)]));
  const result = compareSnapshots(before, after);
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.netDelta, 20);
  assert.equal(result.summary.growth, 50);
  assert.equal(result.summary.released, 30);
  assert.equal(result.summary.uncertain, false);
  assert.equal(observedSum(result), result.summary.netDelta);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 20);
  assert.equal(result.rows[0].name, 'B.bin');
  assert.equal(result.rows.find(row => row.name === 'a').canDrill, true);
  const nested = compareSnapshots(before, after, 'C:\\Data\\A');
  assert.equal(nested.rows.length, 1);
  assert.equal(nested.rows[0].delta, -30);
  assert.equal(nested.summary.netDelta, -30);
  assert.equal(nested.breadcrumbs.length, 2);
  assert.equal(nested.summary.diskUsedDelta, null);
});

test('adds and removes only when the opposing parent has complete readable details', () => {
  const result = compareSnapshots(snapshot(dir('C:\\Data', [file('C:\\Data\\old.bin', 30)])), snapshot(dir('C:\\Data', [file('C:\\Data\\new.bin', 50)])));
  const rows = byName(result);
  assert.equal(rows['old.bin'].status, 'removed');
  assert.equal(rows['old.bin'].afterSize, 0);
  assert.equal(rows['old.bin'].currentExists, false);
  assert.equal(rows['new.bin'].status, 'added');
  assert.equal(rows['new.bin'].beforeSize, 0);
  assert.equal(result.summary.growth, 50);
  assert.equal(result.summary.released, 30);
});

test('known absent added and removed directory subtrees support deeper comparison', () => {
  const empty = snapshot(dir('C:\\Data'));
  const populated = snapshot(dir('C:\\Data', [dir('C:\\Data\\new', [dir('C:\\Data\\new\\deep', [file('C:\\Data\\new\\deep\\item.bin', 7)])])]));
  assert.equal(compareSnapshots(empty, populated).rows[0].canDrill, true);
  const added = compareSnapshots(empty, populated, 'C:\\Data\\new\\deep');
  assert.equal(added.rows[0].status, 'added');
  assert.equal(added.summary.beforeSize, 0);
  assert.equal(added.summary.growth, 7);
  assert.equal(added.breadcrumbs.length, 3);
  const removed = compareSnapshots(populated, empty, 'C:\\Data\\new\\deep');
  assert.equal(removed.rows[0].status, 'removed');
  assert.equal(removed.summary.released, 7);
});

test('different retained membership stays uncertain and reconciles only observed totals', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\A.bin', 100)], { size: 150, files: 2, childrenTruncated: 1, omittedSize: 50 }));
  const after = snapshot(dir('C:\\Data', [file('C:\\Data\\B.bin', 150)], { size: 170, files: 2, childrenTruncated: 1, omittedSize: 20 }));
  const result = compareSnapshots(before, after);
  const rows = byName(result);
  assert.equal(rows['A.bin'].status, 'uncertain');
  assert.equal(rows['A.bin'].afterSize, null);
  assert.equal(rows['A.bin'].delta, null);
  assert.equal(rows['B.bin'].beforeSize, null);
  assert.equal(rows['B.bin'].delta, null);
  assert.equal(result.rows.find(row => row.id.startsWith('aggregate:')).delta, null);
  assert.equal(observedSum(result), 20);
  assert.equal(result.summary.growth, 0);
  assert.equal(result.summary.released, 0);
  assert.equal(result.summary.uncertain, true);
  assert.ok(result.warnings.some(warning => warning.includes('不认定为新增或删除')));
});

test('completed directory inventories confirm folder additions and removals despite file omissions', () => {
  const before = snapshot(dir('C:\\Data', [dir('C:\\Data\\Old', [file('C:\\Data\\Old\\data.bin', 100)], { directoryScanned: true })],
    { size: 200, files: 51, directoryScanned: true, childrenTruncated: 50, omittedSize: 100 }));
  const after = snapshot(dir('C:\\Data', [dir('C:\\Data\\New', [file('C:\\Data\\New\\data.bin', 150)], { directoryScanned: true })],
    { size: 250, files: 51, directoryScanned: true, childrenTruncated: 50, omittedSize: 100 }));
  const result = compareSnapshots(before, after);
  const rows = byName(result);
  assert.equal(rows.Old.status, 'removed');
  assert.equal(rows.Old.delta, -100);
  assert.equal(rows.New.status, 'added');
  assert.equal(rows.New.delta, 150);
  assert.equal(result.summary.growth, 150);
  assert.equal(result.summary.released, 100);
  assert.equal(result.summary.uncertain, false);
  assert.equal(observedSum(result), 50);
  const nested = compareSnapshots(before, after, 'C:\\Data\\New');
  assert.equal(nested.rows[0].status, 'added');
  assert.equal(nested.rows[0].delta, 150);
});

test('the directory marker never establishes missing file membership or masks unreadable folders', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\A.bin', 100)],
    { directoryScanned: true, size: 150, files: 2, childrenTruncated: 1, omittedSize: 50 }));
  const after = snapshot(dir('C:\\Data', [file('C:\\Data\\B.bin', 120)],
    { directoryScanned: true, size: 150, files: 2, childrenTruncated: 1, omittedSize: 30 }));
  const files = byName(compareSnapshots(before, after));
  assert.equal(files['A.bin'].afterSize, null);
  assert.equal(files['A.bin'].delta, null);
  assert.equal(files['B.bin'].beforeSize, null);
  assert.equal(files['B.bin'].status, 'uncertain');
  const readable = snapshot(dir('C:\\Data', [dir('C:\\Data\\Protected', [file('C:\\Data\\Protected\\data.bin', 20)], { directoryScanned: true })], { directoryScanned: true }));
  const unreadable = snapshot(dir('C:\\Data', [], { directoryScanned: true, inaccessible: true, incomplete: true }), { scan: { skipped: 1 } });
  const result = compareSnapshots(readable, unreadable);
  assert.equal(byName(result).Protected.status, 'uncertain');
  assert.equal(result.summary.released, 0);
  assert.throws(() => compareSnapshots(readable, unreadable, 'C:\\Data\\Protected'), /未保留或未能读取/);
  const badFlag = snapshot(dir('C:\\Data', [], { directoryScanned: 'yes' }));
  assert.throws(() => compareSnapshots(badFlag, readable), /目录扫描标记/);
});

test('truncated descendants preserve exact folder totals and aggregate unexplored details', () => {
  const before = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [], { size: 100, files: 10, childrenTruncated: 10, omittedSize: 100 })]));
  const after = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [], { size: 130, files: 11, childrenTruncated: 11, omittedSize: 130 })]));
  const result = compareSnapshots(before, after);
  assert.equal(result.rows[0].status, 'grown');
  assert.equal(result.rows[0].delta, 30);
  assert.equal(result.rows[0].canDrill, false);
  assert.equal(result.summary.uncertain, false);
  const aggregate = compareSnapshots(before, after, 'C:\\Data\\A');
  assert.equal(aggregate.rows.length, 1);
  assert.equal(aggregate.rows[0].status, 'aggregate');
  assert.equal(aggregate.rows[0].delta, 30);
  assert.equal(aggregate.summary.growth, 30);
  assert.equal(observedSum(aggregate), 30);
});

test('stable retained membership plus omitted aggregate reconciles root growth', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\A.bin', 100)], { size: 150, files: 5, childrenTruncated: 4, omittedSize: 50 }));
  const after = snapshot(dir('C:\\Data', [file('C:\\Data\\A.bin', 120)], { size: 180, files: 6, childrenTruncated: 5, omittedSize: 60 }));
  const result = compareSnapshots(before, after);
  assert.equal(result.rows.find(row => row.status === 'aggregate').delta, 10);
  assert.equal(result.summary.netDelta, 30);
  assert.equal(result.summary.growth, 30);
  assert.equal(result.summary.released, 0);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 30);
});

test('permission loss cannot masquerade as deletion or released space', () => {
  const before = snapshot(dir('C:\\Data', [dir('C:\\Data\\Protected', [file('C:\\Data\\Protected\\item.bin', 100)])]));
  const after = snapshot(dir('C:\\Data', [dir('C:\\Data\\Protected', [], { inaccessible: true, incomplete: true })], { incomplete: true }), { skipped: 1, scan: { skipped: 1 } });
  const result = compareSnapshots(before, after);
  assert.equal(result.summary.netDelta, -100);
  assert.equal(result.summary.uncertain, true);
  assert.equal(result.summary.released, 0);
  assert.equal(result.rows[0].status, 'uncertain');
  assert.equal(result.rows[0].delta, null);
  assert.equal(result.rows[0].observedDelta, -100);
  const nested = compareSnapshots(before, after, 'C:\\Data\\Protected');
  assert.equal(nested.rows[0].status, 'uncertain');
  assert.equal(nested.rows[0].afterSize, null);
  assert.equal(nested.summary.released, 0);
});

test('an unreadable descendant is discovered even without an ancestor flag', () => {
  const before = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [file('C:\\Data\\A\\item.bin', 10)])]));
  const after = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [file('C:\\Data\\A\\item.bin', 0, { inaccessible: true })])]));
  const result = compareSnapshots(before, after);
  assert.equal(result.rows[0].delta, null);
  assert.equal(result.summary.released, 0);
  assert.equal(result.summary.uncertain, true);
});

test('legacy skipped coverage makes matched sizes uncertain without claiming growth', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\item.bin', 10)]));
  const after = snapshot(dir('C:\\Data', [file('C:\\Data\\item.bin', 20)]), { skipped: 1, scan: { skipped: 1 } });
  const result = compareSnapshots(before, after);
  assert.equal(result.rows[0].delta, null);
  assert.equal(result.rows[0].observedDelta, 10);
  assert.equal(result.summary.growth, 0);
});

test('clean matched subtrees remain measurable when another propagated subtree is incomplete', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\clean.bin', 10), dir('C:\\Data\\bad', [file('C:\\Data\\bad\\lost.bin', 50)])]));
  const after = snapshot(dir('C:\\Data', [file('C:\\Data\\clean.bin', 20), dir('C:\\Data\\bad', [], { incomplete: true, inaccessible: true })], { incomplete: true }), { skipped: 1, scan: { skipped: 1 } });
  const result = compareSnapshots(before, after);
  const rows = byName(result);
  assert.equal(rows['clean.bin'].delta, 10);
  assert.equal(rows.bad.delta, null);
  assert.equal(result.summary.growth, 10);
  assert.equal(result.summary.released, 0);
  assert.equal(result.summary.netDelta, -40);
});

test('cancelled scans cannot serve as either side of a comparison', () => {
  const complete = snapshot(dir('C:\\Data'));
  const cancelled = snapshot(dir('C:\\Data'), { scan: { cancelled: true } });
  assert.throws(() => compareSnapshots(cancelled, complete), /已停止/);
  assert.throws(() => compareSnapshots(complete, cancelled), /已停止/);
});

test('rejects changed roots, known volume identity and volume capacity', () => {
  const base = snapshot(dir('C:\\Data'));
  assert.throws(() => compareSnapshots(base, snapshot(dir('C:\\Other'))), /同一文件夹/);
  assert.throws(() => compareSnapshots(base, snapshot(dir('C:\\Data'), { drive: { ...base.drive, volumeId: 'other-volume' } })), /卷标识/);
  assert.throws(() => compareSnapshots(base, snapshot(dir('C:\\Data'), { drive: { ...base.drive, total: 20000 } })), /总容量/);
});

test('whole-drive observed physical difference is descriptive and absent for subfolders', () => {
  const before = snapshot(dir('C:\\', [dir('C:\\A', [file('C:\\A\\item.bin', 100)])]));
  const after = snapshot(dir('C:\\', [dir('C:\\A', [file('C:\\A\\item.bin', 120)])]), { drive: { ...before.drive, used: 1050, free: 8950 } });
  const result = compareSnapshots(before, after);
  assert.equal(result.summary.diskUsedDelta, 50);
  assert.equal(result.summary.netDelta, 20);
  assert.equal(result.summary.unexplainedDelta, 30);
  assert.ok(result.warnings.some(warning => warning.includes('不能据此确定具体原因')));
  assert.equal(compareSnapshots(before, after, 'C:\\A').summary.diskUsedDelta, null);
  assert.equal(compareSnapshots(before, after, 'C:\\A').summary.unexplainedDelta, null);
  const foldersWithIncorrectFlag = compareSnapshots(snapshot(dir('C:\\Data'), { isDriveRoot: true }), snapshot(dir('C:\\Data'), { isDriveRoot: true }));
  assert.equal(foldersWithIncorrectFlag.summary.diskUsedDelta, null);
});

test('missing volume identity warns and prevents physical volume subtraction', () => {
  const before = snapshot(dir('C:\\'));
  const after = snapshot(dir('C:\\'), { drive: { ...before.drive, volumeId: undefined } });
  const result = compareSnapshots(before, after);
  assert.equal(result.summary.diskUsedDelta, null);
  assert.ok(result.warnings.some(warning => warning.includes('无法确认卷身份')));
});

test('scope boundaries reject prefix siblings and unavailable hidden directories', () => {
  const base = snapshot(dir('C:\\Data'));
  assert.throws(() => compareSnapshots(base, base, 'C:\\Database'), /根目录内/);
  assert.throws(() => compareSnapshots(base, base, 'C:\\Data\\missing'), /都没有/);
  const hidden = snapshot(dir('C:\\Data', [], { size: 10, files: 1, omittedSize: 10, childrenTruncated: 1 }));
  const visible = snapshot(dir('C:\\Data', [dir('C:\\Data\\A', [file('C:\\Data\\A\\inside.bin', 10)])]));
  const row = compareSnapshots(hidden, visible).rows.find(item => item.name === 'A');
  assert.equal(row.status, 'uncertain');
  assert.equal(row.canDrill, false);
  assert.throws(() => compareSnapshots(hidden, visible, 'C:\\Data\\A'), /未保留或未能读取/);
});

test('growth, shrink and absolute sorting are deterministic and do not mutate rows', () => {
  const rows = [{ id: '1', name: 'small', delta: 2, observedDelta: 2 }, { id: '2', name: 'release', delta: -9, observedDelta: -9 }, { id: '3', name: 'growth', delta: 8, observedDelta: 8 }];
  assert.deepEqual(sortChanges(rows, 'growth').map(row => row.id), ['3', '1', '2']);
  assert.deepEqual(sortChanges(rows, 'shrink').map(row => row.id), ['2', '1', '3']);
  assert.deepEqual(sortChanges(rows, 'absolute').map(row => row.id), ['2', '3', '1']);
  assert.deepEqual(rows.map(row => row.id), ['1', '2', '3']);
});

test('malformed paths, duplicate paths and impossible retained totals are rejected', () => {
  const good = snapshot(dir('C:\\Data'));
  assert.throws(() => compareSnapshots(snapshot(dir('C:\\Data', [file('D:\\elsewhere.bin', 1)])), good), /根目录之外/);
  assert.throws(() => compareSnapshots(snapshot(dir('C:\\Data', [file('C:\\Data\\same.bin', 1), file('c:\\data\\SAME.bin', 1)])), good), /重复路径/);
  assert.throws(() => compareSnapshots(snapshot(dir('C:\\Data', [file('C:\\Data\\A.bin', 10)], { size: 2 })), good), /超过父级/);
  assert.throws(() => compareSnapshots(snapshot(dir('C:\\Data', [], { size: -1 })), good), /无效容量/);
});

test('empty scopes compare unchanged and input snapshot data is never modified', () => {
  const base = snapshot(dir('C:\\Data'));
  const before = JSON.stringify(base);
  const result = compareSnapshots(base, base);
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary.netDelta, 0);
  assert.equal(result.summary.uncertain, false);
  assert.equal(JSON.stringify(base), before);
  assert.equal('scan' in result.baseline, false);
});

test('replacement of a file with a folder reports size change without an unsafe drill', () => {
  const before = snapshot(dir('C:\\Data', [file('C:\\Data\\item', 10)]));
  const after = snapshot(dir('C:\\Data', [dir('C:\\Data\\item', [file('C:\\Data\\item\\inside.bin', 20)])]));
  const result = compareSnapshots(before, after);
  assert.equal(result.rows[0].delta, 10);
  assert.equal(result.rows[0].canDrill, false);
  assert.match(result.rows[0].note, /类型发生变化/);
  assert.throws(() => compareSnapshots(before, after, 'C:\\Data\\item'), /曾是文件/);
});
