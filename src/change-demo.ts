import type { DiskNode, Drive, ScanSnapshot, SnapshotComparison, SnapshotMeta, SpaceChange } from './types';

const GB = 1024 ** 3;
const dates = ['2026-10-10T03:20:00.000Z', '2026-10-13T06:10:00.000Z', '2026-10-16T01:35:00.000Z'];
const normalize = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const leaf = (name: string, parent: string, sizes: number[], stage: number, isFile = false): DiskNode => ({ name, path: parent + name, size: Math.round(sizes[stage] * GB), files: isFile ? 1 : Math.max(1, Math.round(sizes[stage] * 137)), folders: isFile ? 0 : Math.max(1, Math.round(sizes[stage] * 4)), ...(isFile ? { isFile: true } : {}) });
const branch = (name: string, path: string, children: DiskNode[]): DiskNode => {
  const retained = children.filter(child => child.size > 0);
  return { name, path, size: retained.reduce((sum, node) => sum + node.size, 0), files: retained.reduce((sum, node) => sum + node.files, 0), folders: retained.reduce((sum, node) => sum + node.folders + (node.isFile ? 0 : 1), 0), children: retained };
};

function makeSnapshot(stage: number): ScanSnapshot {
  const downloads = branch('Downloads', 'C:\\Users\\DemoUser\\Downloads', [
    leaf('安装包', 'C:\\Users\\DemoUser\\Downloads\\', [16.2, 16, 15.4], stage),
    leaf('视频素材', 'C:\\Users\\DemoUser\\Downloads\\', [12.4, 12.4, 12.4], stage),
    leaf('旧项目备份.zip', 'C:\\Users\\DemoUser\\Downloads\\', [8.2, 4.1, 0], stage, true),
    leaf('设计素材包', 'C:\\Users\\DemoUser\\Downloads\\', [0, 11.4, 27.2], stage),
  ]);
  const appData = branch('AppData', 'C:\\Users\\DemoUser\\AppData', [
    leaf('Local', 'C:\\Users\\DemoUser\\AppData\\', [18.2, 21.2, 24.7], stage),
    leaf('Roaming', 'C:\\Users\\DemoUser\\AppData\\', [11.4, 11.6, 12.5], stage),
  ]);
  const user = branch('DemoUser', 'C:\\Users\\DemoUser', [downloads, appData, leaf('Documents', 'C:\\Users\\DemoUser\\', [18.3, 18.3, 18.3], stage), leaf('Pictures', 'C:\\Users\\DemoUser\\', [13.5, 12.5, 11.5], stage)]);
  const users = branch('Users', 'C:\\Users', [user, leaf('Public', 'C:\\Users\\', [20.4, 20.4, 20.4], stage)]);
  const programs = branch('Program Files', 'C:\\Program Files', [
    leaf('Adobe', 'C:\\Program Files\\', [28.3, 28.5, 29.4], stage), leaf('Microsoft', 'C:\\Program Files\\', [20.4, 20.5, 21.1], stage), leaf('其他应用', 'C:\\Program Files\\', [24.1, 24.1, 24.1], stage),
  ]);
  const root = branch('C:', 'C:\\', [users, programs, leaf('Windows', 'C:\\', [48.2, 49.5, 50.3], stage), leaf('Games', 'C:\\', [34.6, 34.6, 34.6], stage), leaf('Program Files (x86)', 'C:\\', [22.1, 21.9, 21.7], stage), leaf('ProgramData', 'C:\\', [10.7, 12.1, 14.2], stage), leaf('其他文件', 'C:\\', [5.4, 4.1, 3.2], stage)]);
  const used = Math.round([318.7, 334.4, 354.5][stage] * GB);
  const total = Math.round(475.7 * GB);
  const drive: Drive = { path: 'C:\\', name: '系统 · 示例', fileSystem: 'NTFS', volumeId: 'demo-volume-c', total, used, free: total - used };
  const id = `demo-snapshot-${stage + 1}`;
  const scanElapsedMs = [14230, 15180, 16420][stage];
  const countNodes = (node: DiskNode): number => 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
  const scan = { id, root, skipped: 0, cancelled: false, elapsedMs: scanElapsedMs, startedAt: dates[stage], completedAt: dates[stage], snapshotId: id };
  return { schemaVersion: 1, id, rootPath: root.path, createdAt: dates[stage], startedAt: dates[stage], scanElapsedMs, size: root.size, files: root.files, folders: root.folders, skipped: 0, incomplete: false, drive, isDriveRoot: true, retainedNodes: countNodes(root), scan };
}

/** Deterministic browser samples only. Real comparisons are calculated by the native snapshot engine. */
export const demoSnapshots: ScanSnapshot[] = [makeSnapshot(2), makeSnapshot(1), makeSnapshot(0)];

export function demoComparison(baselineId: string, currentId: string, scopePath?: string): SnapshotComparison {
  const baseline = demoSnapshots.find(snapshot => snapshot.id === baselineId);
  const current = demoSnapshots.find(snapshot => snapshot.id === currentId);
  if (!baseline || !current) throw new Error('请选择两条有效的示例扫描记录。');
  const rootPath = baseline.rootPath;
  const scope = scopePath || rootPath;
  const find = (node: DiskNode, path: string): DiskNode | null => normalize(node.path) === normalize(path) ? node : (node.children || []).map(child => find(child, path)).find(Boolean) || null;
  const beforeNode = find(baseline.scan.root, scope);
  const afterNode = find(current.scan.root, scope);
  if (!beforeNode && !afterNode) throw new Error('示例记录中没有这个文件夹。');
  const beforeChildren = new Map((beforeNode?.children || []).map(node => [normalize(node.path), node]));
  const afterChildren = new Map((afterNode?.children || []).map(node => [normalize(node.path), node]));
  const keys = [...new Set([...beforeChildren.keys(), ...afterChildren.keys()])];
  const rows: SpaceChange[] = keys.map<SpaceChange>(key => {
    const before = beforeChildren.get(key), after = afterChildren.get(key);
    const node = after || before!;
    const delta = (after?.size || 0) - (before?.size || 0);
    return { id: node.path, path: node.path, name: node.name, isFile: Boolean(node.isFile), beforeSize: before?.size ?? 0, afterSize: after?.size ?? 0, delta, observedDelta: delta, status: !before ? 'added' : !after ? 'removed' : delta > 0 ? 'grown' : delta < 0 ? 'shrunk' : 'unchanged', canDrill: !node.isFile && Boolean(before?.children?.length || after?.children?.length), currentExists: Boolean(after), ...(!before ? { note: '基准扫描中不存在，本次扫描中可见。' } : !after ? { note: '基准扫描中可见，本次扫描中不存在。' } : {}) };
  }).sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  const beforeSize = beforeNode?.size || 0, afterSize = afterNode?.size || 0;
  const isRoot = normalize(scope) === normalize(rootPath);
  const diskUsedDelta = isRoot && baseline.drive && current.drive ? current.drive.used - baseline.drive.used : null;
  const parts = scope.slice(rootPath.length).split('\\').filter(Boolean);
  const breadcrumbs = [{ path: rootPath, name: rootPath }, ...parts.map((name, index) => ({ path: rootPath + parts.slice(0, index + 1).join('\\'), name }))];
  const metadata = ({ scan: _scan, ...meta }: ScanSnapshot): SnapshotMeta => meta;
  return { baseline: metadata(baseline), current: metadata(current), scopePath: afterNode?.path || beforeNode!.path, scopeName: afterNode?.name || beforeNode!.name, breadcrumbs, rows, warnings: [], summary: { beforeSize, afterSize, netDelta: afterSize - beforeSize, growth: rows.reduce((sum, row) => sum + Math.max(0, row.delta || 0), 0), released: rows.reduce((sum, row) => sum + Math.max(0, -(row.delta || 0)), 0), uncertain: false, diskUsedDelta, unexplainedDelta: diskUsedDelta === null ? null : diskUsedDelta - (afterSize - beforeSize) } };
}
