import type { DiskNode, Drive, ScanResult, Software } from './types';
export const GB = 1024 ** 3;
export const palette = ['#a99ae1', '#83c5b2', '#e6b18d', '#83bfd4', '#b2afe3', '#dd9bac', '#b6cd91', '#a6b8c8'];
export const demoDrives: Drive[] = [
  { path: 'C:\\', name: '系统', total: 475.7 * GB, used: 312.4 * GB, free: 163.3 * GB, fileSystem: 'NTFS' },
  { path: 'D:\\', name: '工作与生活', total: 953.9 * GB, used: 386.2 * GB, free: 567.7 * GB, fileSystem: 'NTFS' },
];
function folder(name: string, size: number, files: number, path = 'C:\\', children?: DiskNode[]): DiskNode {
  return { name, path: path + name, size: size * GB, files, folders: children?.length || 12, children };
}
const users = [folder('DemoUser', 98.2, 20432, 'C:\\Users\\', [folder('Downloads', 36.8, 1023, 'C:\\Users\\DemoUser\\'), folder('AppData', 29.6, 14322, 'C:\\Users\\DemoUser\\'), folder('Documents', 18.3, 4287, 'C:\\Users\\DemoUser\\'), folder('Pictures', 13.5, 800, 'C:\\Users\\DemoUser\\')]), folder('Public', 20.4, 1522, 'C:\\Users\\')];
export const demoResult: ScanResult = { id: 'demo', skipped: 0, cancelled: false, elapsedMs: 14230, root: { name: 'C:', path: 'C:\\', size: 312.4 * GB, files: 128406, folders: 8492, children: [folder('Users', 118.6, 21954, 'C:\\', users), folder('Program Files', 72.8, 41482, 'C:\\', [folder('Adobe', 28.3, 19200, 'C:\\Program Files\\'), folder('Microsoft', 20.4, 10983, 'C:\\Program Files\\'), folder('其他应用', 24.1, 11299, 'C:\\Program Files\\')]), folder('Windows', 48.2, 32610), folder('Games', 34.6, 10320), folder('Program Files (x86)', 22.1, 17542), folder('ProgramData', 10.7, 4023), folder('其他文件', 5.4, 475)] } };
const demoDataResult: ScanResult = { id: 'demo-d', skipped: 0, cancelled: false, elapsedMs: 18640, root: { name: 'D:', path: 'D:\\', size: demoDrives[1].used, files: 86729, folders: 4381, children: [
  folder('Projects', 128.4, 33280, 'D:\\', [folder('设计素材', 56.2, 7880, 'D:\\Projects\\'), folder('开发项目', 44.8, 21500, 'D:\\Projects\\'), folder('归档项目', 27.4, 3900, 'D:\\Projects\\')]),
  folder('Games', 104.6, 28170, 'D:\\', [folder('SteamLibrary', 72.3, 19800, 'D:\\Games\\'), folder('其他游戏', 32.3, 8370, 'D:\\Games\\')]),
  folder('Videos', 72.8, 328, 'D:\\'), folder('Backups', 39.7, 10642, 'D:\\'), folder('Photos', 26.4, 12486, 'D:\\'), folder('Downloads', 14.3, 1823, 'D:\\'),
] } };
export function demoForDrive(path: string): ScanResult { return path.toUpperCase().startsWith('D:') ? demoDataResult : demoResult; }
export const demoSoftware: Software[] = [
  { id: 'adobe', name: 'Adobe Creative Cloud', publisher: 'Adobe Inc.', version: '6.4', installLocation: 'C:\\Program Files\\Adobe', size: 28.3 * GB, sizeSource: 'measured' },
  { id: 'steam', name: 'Steam', publisher: 'Valve Corporation', version: '2.10', installLocation: 'C:\\Games\\Steam', size: 24.6 * GB, sizeSource: 'measured' },
  { id: 'office', name: 'Microsoft 365', publisher: 'Microsoft Corporation', version: '16.0', installLocation: 'C:\\Program Files\\Microsoft Office', size: 5.2 * GB, sizeSource: 'estimated' },
  { id: 'vs', name: 'Visual Studio', publisher: 'Microsoft Corporation', version: '17.12', installLocation: 'C:\\Program Files\\Microsoft Visual Studio', size: 4.8 * GB, sizeSource: 'estimated' },
  { id: 'chrome', name: 'Google Chrome', publisher: 'Google LLC', version: '131.0', installLocation: 'C:\\Program Files\\Google\\Chrome', size: 1.6 * GB, sizeSource: 'measured' },
  { id: 'notion', name: 'Notion', publisher: 'Notion Labs, Inc.', version: '3.9', installLocation: '', size: 0, sizeSource: 'unknown' },
];
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? decimals : 0)} ${units[i]}`;
}
export function formatCount(value: number) { return value.toLocaleString('zh-CN'); }
export function findTrail(root: DiskNode, path: string): DiskNode[] | null {
  if (root.path === path) return [root];
  for (const child of root.children || []) {
    const trail = findTrail(child, path);
    if (trail) return [root, ...trail];
  }
  return null;
}
