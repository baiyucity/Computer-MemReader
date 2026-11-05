export interface Drive { path: string; name: string; total: number; free: number; used: number; fileSystem?: string; volumeId?: string }
export interface DiskNode { name: string; path: string; size: number; files: number; folders: number; children?: DiskNode[]; isFile?: boolean; inaccessible?: boolean; incomplete?: boolean; childrenTruncated?: number; omittedSize?: number; cachePlaceholder?: boolean; directoryScanned?: boolean }
export interface ScanProgress { id: string; root: string; currentPath: string; files: number; folders: number; bytes: number; skipped: number; elapsedMs: number; phase?: 'scanning' | 'saving' }
export interface ScanResult { id: string; root: DiskNode; skipped: number; cancelled: boolean; elapsedMs: number; errors?: string[]; startedAt?: string; completedAt?: string; snapshotId?: string; snapshotWarning?: string }
export interface SnapshotMeta {
  schemaVersion: 1; id: string; rootPath: string; createdAt: string; startedAt: string;
  scanElapsedMs: number; size: number; files: number; folders: number; skipped: number;
  incomplete: boolean; drive: Drive | null; driveBefore?: Drive | null; isDriveRoot: boolean; retainedNodes: number;
}
export interface ScanSnapshot extends SnapshotMeta { scan: ScanResult }
export interface SnapshotList { snapshots: SnapshotMeta[]; warnings: string[] }
export interface CachedDirectory {
  drivePath: string; node: DiskNode; trail: DiskNode[]; snapshotId: string | null;
  createdAt: string | null; generationId: string | null; rootSnapshotAt: string | null;
  needsScan: boolean; partial: boolean; warnings: string[]; elapsedMs: number; skipped: number;
  drive?: Drive | null;
}
export interface DriveCacheInfo {
  path: string; hasCache: boolean; rootSnapshotId: string | null; updatedAt: string | null; partial: boolean;
}
export type ChangeStatus = 'grown' | 'shrunk' | 'added' | 'removed' | 'unchanged' | 'uncertain' | 'aggregate';
export interface SpaceChange {
  id: string; path: string; name: string; isFile: boolean; beforeSize: number | null; afterSize: number | null;
  delta: number | null; observedDelta: number; status: ChangeStatus; canDrill: boolean; currentExists: boolean; note?: string;
}
export interface SnapshotComparison {
  baseline: SnapshotMeta; current: SnapshotMeta; scopePath: string; scopeName: string;
  breadcrumbs: Array<{path: string; name: string}>; rows: SpaceChange[]; warnings: string[];
  summary: { beforeSize: number; afterSize: number; netDelta: number; growth: number; released: number;
    uncertain: boolean; diskUsedDelta: number | null; unexplainedDelta: number | null };
}
export interface Software { id: string; name: string; publisher: string; version: string; installLocation: string; size: number; sizeSource: 'measured' | 'estimated' | 'unknown'; shared?: boolean }
export interface Theme { accent: string; background: string | null; glass: number; motion: boolean; mode: 'light' | 'dark'; autoColor: boolean }
export interface ChartItem { id: string; label: string; value: number; color: string; detail?: string; children?: ChartItem[]; kind?: 'unattributed' | 'free' | 'omitted'; openable?: boolean }
export interface MemreaderApi {
  getDrives(): Promise<Drive[]>;
  chooseFolder(): Promise<string | null>;
  scanFolder(path: string): Promise<ScanResult>;
  cancelScan(): Promise<void>;
  onScanProgress(callback: (progress: ScanProgress) => void): () => void;
  listSnapshots(): Promise<SnapshotList>;
  getSnapshot(id: string): Promise<ScanSnapshot>;
  compareSnapshots(baselineId: string, currentId: string, scopePath?: string): Promise<SnapshotComparison>;
  openSnapshotFolder(): Promise<void>;
  getCachedDirectory(path: string): Promise<CachedDirectory | null>;
  listDriveCaches(): Promise<DriveCacheInfo[]>;
  getSoftware(): Promise<Software[]>;
  measureSoftware(id: string): Promise<Software>;
  openPath(path: string): Promise<void>;
  exportReport(data: unknown): Promise<boolean>;
  getTheme(): Promise<Theme | null>;
  saveTheme(theme: Theme): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
declare global { interface Window { memreader?: MemreaderApi } }
