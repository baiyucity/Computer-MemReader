import type { ChartItem, DiskNode, Drive } from './types';
import { normalizeCachePath } from './cache-navigation';

export const UNATTRIBUTED_ID = '__unattributed';
export const FREE_SPACE_ID = '__free_space';
const palette = ['#a99ae1', '#83c5b2', '#e6b18d', '#83bfd4', '#b2afe3', '#dd9bac', '#b6cd91', '#a6b8c8'];
const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** The scan's own volume sample is essential: today's free bytes cannot explain an old tree. */
export function storagePreview(node: DiskNode | undefined, rows: DiskNode[], drive: Drive | null | undefined, filtered = false) {
  const items: ChartItem[] = rows.filter(row => row.size > 0).map((row, index) => {
    const color = palette[index % palette.length];
    const children: ChartItem[] = (row.children || []).filter(child => child.size > 0)
      .map(child => ({ id: child.path, label: child.name, value: child.size, color }));
    if (row.omittedSize) children.push({ id: `${row.path}::omitted`, label: row.directoryScanned ? '其他已扫描文件' : '其他已扫描项目', value: row.omittedSize, color, kind: 'omitted', openable: false });
    return { id: row.path, label: row.name, value: row.size, color, children, openable: !row.isFile };
  });
  if (!filtered && node?.omittedSize) items.push({ id: '__omitted', label: node.directoryScanned ? '其他已扫描文件' : '其他已扫描项目', value: node.omittedSize, color: '#c4c0cf', kind: 'omitted', openable: false, detail: '容量已统计，部分明细合并展示' });
  const scannedTotal = items.reduce((sum, item) => sum + item.value, 0);
  const isDriveRoot = Boolean(node && drive && normalizeCachePath(node.path) === normalizeCachePath(drive.path));
  const validSample = Boolean(drive && Number.isFinite(drive.total) && drive.total > 0 && Number.isFinite(drive.free) && drive.free >= 0 && drive.free <= drive.total);
  // Logical lengths can exceed allocated bytes (hard links, compression). Do not
  // invent negative "unknown" space or rescale measured files to force a fit.
  const used = drive && validSample ? drive.total - drive.free : 0;
  const logicalMismatch = !filtered && isDriveRoot && validSample && scannedTotal > used;
  const wholeDrive = !filtered && isDriveRoot && validSample && !node?.cachePlaceholder && !logicalMismatch;
  const unattributed = wholeDrive ? Math.max(0, used - scannedTotal) : 0;
  const free = wholeDrive ? positive(drive!.free) : 0;
  if (unattributed) items.push({ id: UNATTRIBUTED_ID, label: '未归属占用（估算）', value: unattributed, color: '#b6b8be', kind: 'unattributed', openable: false, detail: '扫描时磁盘已用容量 − 已读取文件的逻辑大小；包含受保护内容、系统占用和统计口径差异，不能定位到具体文件夹。' });
  if (free) items.push({ id: FREE_SPACE_ID, label: '可用空间', value: free, color: '#ffffff', kind: 'free', openable: false, detail: '本次扫描完成时的磁盘可用空间，不属于文件或文件夹。' });
  return { items, total: scannedTotal + unattributed + free, scannedTotal, wholeDrive, unattributed, free, logicalMismatch };
}
