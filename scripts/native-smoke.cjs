'use strict';

// Recommended: node scripts/native-smoke.cjs (cleans userData after child exit).
// Also supported: electron scripts/native-smoke.cjs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');

function removeFixture(directory) {
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('memreader-smoke-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

if (!process.versions.electron) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memreader-smoke-'));
  const environment = { ...process.env, MEMREADER_SMOKE_ROOT: temporaryRoot };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.MEMREADER_DEV_URL;
  const child = spawn(require('electron'), [__filename], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit', env: environment });
  let finished = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error('Native smoke test timed out.');
    if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
  }, 60000);
  const cleanup = code => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try { removeFixture(temporaryRoot); } catch (error) { console.error('Smoke fixture cleanup:', error.message); }
    process.exitCode = timedOut ? 1 : code;
  };
  child.on('error', error => { console.error(error.message); cleanup(1); });
  child.on('exit', code => cleanup(code || 0));
} else {
  delete process.env.MEMREADER_DEV_URL;
  const { app } = require('electron');
  const ownsTemporaryRoot = !process.env.MEMREADER_SMOKE_ROOT;
  const temporaryRoot = process.env.MEMREADER_SMOKE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'memreader-smoke-'));
  assert.ok(path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(temporaryRoot).startsWith('memreader-smoke-'));
  const userData = path.join(temporaryRoot, 'userData');
  const fixture = path.join(temporaryRoot, 'fixture');
  const cancellationFixture = path.join(temporaryRoot, 'cancellation');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(fixture, 'nested', 'deep'), { recursive: true });
  fs.mkdirSync(cancellationFixture);
  fs.writeFileSync(path.join(fixture, 'small.bin'), Buffer.alloc(2));
  fs.writeFileSync(path.join(fixture, 'nested', 'medium.bin'), Buffer.alloc(10));
  fs.writeFileSync(path.join(fixture, 'nested', 'deep', 'large.bin'), Buffer.alloc(100));
  for (let i = 0; i < 1600; i++) fs.writeFileSync(path.join(cancellationFixture, `${i}.bin`), Buffer.alloc(1));
  app.setPath('userData', userData);
  const windows = require('../electron/windows.cjs');
  const readRealSoftware = windows.getSoftware;
  const fixtureSoftwareId = 'memreader-smoke-fixture';
  windows.getSoftware = async () => [...await readRealSoftware(), {
    id: fixtureSoftwareId, name: 'Memreader smoke fixture', publisher: 'Memreader tests', version: '1',
    installLocation: fixture, size: 0, sizeSource: 'unknown', shared: false,
  }];
  const native = require('../electron/main.cjs');
  let window;
  app.whenReady().then(async () => {
    native.configureSession();
    native.registerIPC();
    window = native.createWindow({ visible: false });
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}. Run pnpm build first.`)));
    });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const api = window.memreader;
      if (!api) throw new Error('Sandboxed preload bridge is missing.');
      const progress = [];
      const unsubscribe = api.onScanProgress(event => progress.push(event));
      const drives = await api.getDrives();
      const software = await api.getSoftware();
      const scanPromise = api.scanFolder(${JSON.stringify(fixture)});
      const concurrentRejected = await api.scanFolder(${JSON.stringify(fixture)}).then(() => false, error => error.message.includes('正在扫描'));
      const scan = await scanPromise;
      unsubscribe();
      const measured = await api.measureSoftware(${JSON.stringify(fixtureSoftwareId)});
      const afterMeasurement = await api.listSnapshots();
      const saved = await api.getSnapshot(scan.snapshotId);
      const theme = { accent: '#8770c9', background: null, glass: 0.87, motion: false, mode: 'dark', autoColor: true };
      await api.saveTheme(theme);
      const persisted = await api.getTheme();
      let requested = false;
      const unsubscribeCancel = api.onScanProgress(event => {
        if (event.root === ${JSON.stringify(cancellationFixture)} && event.folders > 0 && !requested) {
          requested = true; api.cancelScan();
        }
      });
      const cancelled = await api.scanFolder(${JSON.stringify(cancellationFixture)});
      unsubscribeCancel();
      const afterCancellation = await api.listSnapshots();
      return { drives, softwareCount: software.length - 1, scan, measured, saved,
        afterMeasurement, afterCancellation, cancelledSnapshotId: cancelled.snapshotId, progressEvents: progress.length,
        concurrentRejected, themeMatches: JSON.stringify(theme) === JSON.stringify(persisted),
        cancelled: cancelled.cancelled, partialBytes: cancelled.root.size, isolated: typeof require === 'undefined' };
    })()`, true);
    assert.ok(Array.isArray(result.drives) && result.drives.length > 0);
    assert.ok(result.drives.every(drive => drive.total > 0 && drive.free >= 0 && drive.used >= 0));
    assert.equal(result.scan.root.size, 112);
    assert.equal(result.scan.root.files, 3);
    assert.equal(result.scan.root.folders, 2);
    assert.equal(result.scan.skipped, 0);
    assert.equal(result.scan.cancelled, false);
    assert.equal(result.measured.id, fixtureSoftwareId);
    assert.equal(result.measured.size, 112);
    assert.equal(result.measured.sizeSource, 'measured');
    assert.equal(typeof result.scan.snapshotId, 'string');
    assert.equal(result.saved.id, result.scan.snapshotId);
    assert.equal(result.saved.scan.root.size, 112);
    assert.equal(result.afterMeasurement.snapshots.length, 1);
    assert.equal(result.afterCancellation.snapshots.length, 1);
    assert.equal(result.afterCancellation.snapshots[0].id, result.scan.snapshotId);
    assert.equal(result.cancelledSnapshotId, undefined);
    assert.equal(result.concurrentRejected, true);
    assert.equal(result.themeMatches, true);
    assert.equal(result.cancelled, true);
    assert.ok(result.partialBytes < 1600);
    assert.equal(result.isolated, true);
    assert.ok(result.progressEvents >= 1);
    const snapshotDirectory = path.join(userData, 'snapshots-v1');
    const baselineFile = path.join(snapshotDirectory, `${result.scan.snapshotId}.json`);
    const originalJSON = fs.readFileSync(baselineFile, 'utf8');
    assert.equal(originalJSON.trim()[0], '{');
    assert.equal(JSON.parse(originalJSON).schemaVersion, 1);
    assert.equal(JSON.parse(originalJSON).scan.root.size, 112);
    fs.writeFileSync(path.join(fixture, 'nested', 'medium.bin'), Buffer.alloc(42));
    fs.unlinkSync(path.join(fixture, 'small.bin'));
    fs.writeFileSync(path.join(fixture, 'new.bin'), Buffer.alloc(64));
    const second = await window.webContents.executeJavaScript(`(async () => {
      const api = window.memreader;
      const scan = await api.scanFolder(${JSON.stringify(fixture)});
      const listing = await api.listSnapshots();
      const reopened = await api.getSnapshot(${JSON.stringify(result.scan.snapshotId)});
      const comparison = await api.compareSnapshots(${JSON.stringify(result.scan.snapshotId)}, scan.snapshotId);
      const nested = await api.compareSnapshots(${JSON.stringify(result.scan.snapshotId)}, scan.snapshotId, ${JSON.stringify(path.join(fixture, 'nested'))});
      const subfolder = await api.scanFolder(${JSON.stringify(path.join(fixture, 'nested'))});
      const afterSubfolder = await api.listSnapshots();
      const preservedBaseline = await api.getSnapshot(${JSON.stringify(result.scan.snapshotId)});
      const preservedCurrent = await api.getSnapshot(scan.snapshotId);
      return { scan, listing, reopened, comparison, nested, subfolder, afterSubfolder, preservedBaseline, preservedCurrent };
    })()`, true);
    assert.equal(second.scan.root.size, 206);
    assert.equal(second.listing.snapshots.length, 2);
    assert.equal(second.reopened.scan.root.size, 112);
    assert.equal(second.comparison.summary.netDelta, 94);
    assert.equal(second.comparison.summary.growth, 96);
    assert.equal(second.comparison.summary.released, 2);
    assert.equal(second.comparison.summary.uncertain, false);
    assert.equal(second.comparison.summary.diskUsedDelta, null);
    assert.equal(second.comparison.summary.unexplainedDelta, null);
    assert.equal(second.comparison.rows.length, 3);
    assert.equal(second.comparison.rows.reduce((total, row) => total + row.delta, 0), 94);
    assert.equal(second.comparison.rows.find(row => row.name === 'nested').delta, 32);
    assert.equal(second.comparison.rows.find(row => row.name === 'small.bin').status, 'removed');
    assert.equal(second.comparison.rows.find(row => row.name === 'new.bin').status, 'added');
    assert.equal(second.nested.summary.netDelta, 32);
    assert.equal(second.nested.summary.growth, 32);
    assert.equal(second.nested.summary.released, 0);
    assert.equal(second.nested.rows.find(row => row.name === 'medium.bin').delta, 32);
    assert.equal(second.subfolder.root.size, 142);
    assert.equal(second.afterSubfolder.snapshots.length, 3);
    const wholeFixtureIds = second.afterSubfolder.snapshots.filter(record => record.rootPath.toLowerCase() === fixture.toLowerCase()).map(record => record.id);
    assert.deepEqual(wholeFixtureIds.sort(), [result.scan.snapshotId, second.scan.snapshotId].sort());
    assert.equal(second.preservedBaseline.scan.root.size, 112);
    assert.equal(second.preservedCurrent.scan.root.size, 206);
    assert.equal(fs.readFileSync(baselineFile, 'utf8'), originalJSON);
    const reopenedStore = require('../electron/snapshot-store.cjs').createSnapshotStore(snapshotDirectory);
    const recoveredListing = await reopenedStore.list();
    assert.equal(recoveredListing.length, 3);
    assert.ok(recoveredListing.some(record => record.id === result.scan.snapshotId));
    assert.equal((await reopenedStore.get(result.scan.snapshotId)).scan.root.size, 112);
    const drivePath = path.parse(fixture).root;
    const liveDrive = result.drives.find(drive => drive.path.toLowerCase() === drivePath.toLowerCase());
    assert.ok(liveDrive);
    const partialMemory = await window.webContents.executeJavaScript(`(async () => ({
      directory: await window.memreader.getCachedDirectory(${JSON.stringify(fixture)}),
      root: await window.memreader.getCachedDirectory(${JSON.stringify(drivePath)}),
      badges: await window.memreader.listDriveCaches()
    }))()`);
    assert.equal(partialMemory.directory.snapshotId, second.scan.snapshotId);
    assert.equal(partialMemory.directory.node.size, 206);
    assert.equal(partialMemory.root.node.cachePlaceholder, true);
    assert.equal(partialMemory.root.node.size, 0);
    assert.equal(partialMemory.root.partial, true);
    assert.equal(partialMemory.badges.find(info => info.path.toLowerCase() === drivePath.toLowerCase()).hasCache, true);
    assert.equal(partialMemory.badges.find(info => info.path.toLowerCase() === drivePath.toLowerCase()).partial, true);
    // These deliberately synthetic drive trees contain only this isolated QA
    // fixture. They verify generation handling without scanning a real drive.
    const countNodes = node => 1 + (node.children || []).reduce((total, child) => total + countNodes(child), 0);
    function driveFixtureTree(directory) {
      let node = structuredClone(directory);
      while (node.path.toLowerCase() !== drivePath.toLowerCase()) {
        const parent = path.dirname(node.path);
        node = { name: path.basename(parent) || parent, path: parent, size: node.size, files: node.files,
          folders: node.folders + 1, children: [node] };
      }
      return node;
    }
    async function seedDriveGeneration(id, directory) {
      const root = driveFixtureTree(directory);
      const createdAt = new Date().toISOString();
      const snapshot = { schemaVersion: 1, id, rootPath: drivePath, createdAt, startedAt: createdAt,
        scanElapsedMs: 0, size: root.size, files: root.files, folders: root.folders, skipped: 0, incomplete: false,
        drive: liveDrive, isDriveRoot: true, retainedNodes: countNodes(root),
        scan: { id, root, skipped: 0, cancelled: false, elapsedMs: 0, startedAt: createdAt, completedAt: createdAt } };
      await reopenedStore.save(snapshot);
      return snapshot;
    }
    const firstGeneration = await seedDriveGeneration('smoke-drive-generation-1', second.preservedCurrent.scan.root);
    const firstGenerationJSON = fs.readFileSync(path.join(snapshotDirectory, `${firstGeneration.id}.json`), 'utf8');
    const generationMemory = await window.webContents.executeJavaScript(`(async () => ({
      root: await window.memreader.getCachedDirectory(${JSON.stringify(drivePath)}),
      directory: await window.memreader.getCachedDirectory(${JSON.stringify(fixture)})
    }))()`);
    assert.equal(generationMemory.root.snapshotId, firstGeneration.id);
    assert.equal(generationMemory.root.node.size, 206);
    assert.equal(generationMemory.directory.generationId, firstGeneration.id);
    fs.writeFileSync(path.join(fixture, 'nested', 'medium.bin'), Buffer.alloc(50));
    const attached = await window.webContents.executeJavaScript(`(async () => {
      const api = window.memreader;
      const scan = await api.scanFolder(${JSON.stringify(path.join(fixture, 'nested'))});
      const child = await api.getCachedDirectory(${JSON.stringify(path.join(fixture, 'nested'))});
      const deep = await api.getCachedDirectory(${JSON.stringify(path.join(fixture, 'nested', 'deep'))});
      const root = await api.getCachedDirectory(${JSON.stringify(drivePath)});
      return { scan, child, deep, root };
    })()`);
    assert.equal(attached.scan.root.size, 150);
    assert.equal(attached.child.snapshotId, attached.scan.snapshotId);
    assert.equal(attached.child.generationId, firstGeneration.id);
    assert.equal(attached.child.needsScan, false);
    assert.equal(attached.deep.node.size, 100);
    assert.equal(attached.deep.needsScan, false);
    assert.equal(attached.root.snapshotId, firstGeneration.id);
    assert.equal(attached.root.node.size, 206);
    assert.equal(attached.child.trail[0].path.toLowerCase(), drivePath.toLowerCase());
    assert.equal(attached.child.trail[0].size, 206);
    const cacheService = require('../electron/disk-cache.cjs');
    const reopenedCache = cacheService.createDiskCache(require('../electron/snapshot-store.cjs').createSnapshotStore(snapshotDirectory));
    assert.equal((await reopenedCache.getDirectory(path.join(fixture, 'nested'), liveDrive)).snapshotId, attached.scan.snapshotId);
    const updatedFixture = structuredClone(second.preservedCurrent.scan.root);
    updatedFixture.children = updatedFixture.children.map(node => node.path.toLowerCase() === attached.scan.root.path.toLowerCase() ? structuredClone(attached.scan.root) : node);
    updatedFixture.size = updatedFixture.children.reduce((total, node) => total + node.size, 0);
    updatedFixture.files = updatedFixture.children.reduce((total, node) => total + node.files, 0);
    updatedFixture.folders = updatedFixture.children.reduce((total, node) => total + node.folders + (node.isFile ? 0 : 1), 0);
    const secondGeneration = await seedDriveGeneration('smoke-drive-generation-2', updatedFixture);
    const resetMemory = await window.webContents.executeJavaScript(`(async () => ({
      root: await window.memreader.getCachedDirectory(${JSON.stringify(drivePath)}),
      child: await window.memreader.getCachedDirectory(${JSON.stringify(path.join(fixture, 'nested'))}),
      badges: await window.memreader.listDriveCaches()
    }))()`);
    assert.equal(resetMemory.root.generationId, secondGeneration.id);
    assert.equal(resetMemory.root.node.size, 214);
    assert.equal(resetMemory.child.snapshotId, secondGeneration.id);
    assert.equal(resetMemory.child.node.size, 150);
    assert.equal(resetMemory.badges.find(info => info.path.toLowerCase() === drivePath.toLowerCase()).rootSnapshotId, secondGeneration.id);
    assert.equal(resetMemory.badges.find(info => info.path.toLowerCase() === drivePath.toLowerCase()).partial, false);
    const finalStore = require('../electron/snapshot-store.cjs').createSnapshotStore(snapshotDirectory);
    const finalListing = await finalStore.list();
    assert.equal(finalListing.length, 6);
    assert.equal((await finalStore.get(firstGeneration.id)).scan.root.size, 206);
    assert.equal((await finalStore.get(result.scan.snapshotId)).scan.root.size, 112);
    assert.equal(fs.readFileSync(baselineFile, 'utf8'), originalJSON);
    assert.equal(fs.readFileSync(path.join(snapshotDirectory, `${firstGeneration.id}.json`), 'utf8'), firstGenerationJSON);
    assert.equal((await cacheService.createDiskCache(finalStore).getDirectory(drivePath, liveDrive)).generationId, secondGeneration.id);
    console.log(JSON.stringify({ nativeSmoke: 'passed', electron: process.versions.electron, drives: result.drives.length,
      software: result.softwareCount, fixtureBytes: result.scan.root.size, progressEvents: result.progressEvents,
      softwareFixtureMeasuredBytes: result.measured.size, snapshots: finalListing.length, comparisonNet: second.comparison.summary.netDelta,
      comparisonGrowth: second.comparison.summary.growth, comparisonReleased: second.comparison.summary.released,
      nestedGrowth: second.nested.summary.netDelta, persistedJSON: true, recreatedStore: true,
      concurrentRejected: true, cancelledWithoutSnapshot: true, themePersisted: true, sandboxedPreload: true,
      driveCache: true, childAttached: true, cacheReopened: true, generationReset: true, immutableHistory: true }));
    window.destroy();
    app.quit();
  }).catch(error => {
    console.error(error.stack || error.message);
    window?.destroy();
    app.exit(1);
  });
  if (ownsTemporaryRoot) app.once('quit', () => { try { removeFixture(temporaryRoot); } catch {} });
}
