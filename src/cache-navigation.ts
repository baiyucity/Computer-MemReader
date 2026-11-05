import type { CachedDirectory, DiskNode, ScanResult } from './types';

/** Cache keys are local Windows paths; casing and separator style are immaterial. */
export function normalizeCachePath(path: string): string {
  return path.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');
}

/** Whether entering a retained node can show a useful result without another scan. */
export function directoryHasRetainedPreview(node: DiskNode): boolean {
  if (node.isFile) return false;
  if (node.directoryScanned || node.cachePlaceholder || node.children?.length || node.inaccessible) return true;
  // Legacy snapshots omit `children` for empty directories. Zero counters alone
  // do not prove emptiness when enumeration failed or children were omitted.
  return !node.incomplete && !node.childrenTruncated && !node.omittedSize
    && node.size === 0 && node.files === 0 && node.folders === 0;
}

/** Wrap this directory's fragment; the drive breadcrumb is not its scan root. */
export function cachedDirectoryResult(directory: CachedDirectory): ScanResult {
  const finishedAt = directory.createdAt ? Date.parse(directory.createdAt) : NaN;
  const timestamps = Number.isFinite(finishedAt) ? {
    completedAt: directory.createdAt!,
    startedAt: new Date(finishedAt - directory.elapsedMs).toISOString(),
  } : {};
  return {
    id: directory.snapshotId || 'cached-directory',
    root: directory.node,
    skipped: directory.skipped,
    cancelled: false,
    elapsedMs: directory.elapsedMs,
    ...timestamps,
    ...(directory.snapshotId ? { snapshotId: directory.snapshotId } : {}),
  };
}

/** A historical view only traverses the selected immutable snapshot's own tree. */
export function historicalTrail(root: DiskNode, path: string): DiskNode[] | null {
  const wanted = normalizeCachePath(path);
  function visit(node: DiskNode): DiskNode[] | null {
    if (normalizeCachePath(node.path) === wanted) return [node];
    for (const child of node.children || []) {
      const found = visit(child);
      if (found) return [node, ...found];
    }
    return null;
  }
  return visit(root);
}
