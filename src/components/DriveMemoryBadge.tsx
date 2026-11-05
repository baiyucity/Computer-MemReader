import { Clock3, Database, FolderTree, HardDrive, History, Info, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CachedDirectory, DriveCacheInfo } from '../types';
import { formatCount } from '../data';
import './DriveMemoryBadge.css';

interface DiskMemoryInfoProps {
  directory: CachedDirectory | null;
  loading: boolean;
  onRescan: () => void;
  busy: boolean;
  historical?: boolean;
}

function readableTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未建立';
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** Inline status only, safe to place inside the existing disk selection button. */
export function DriveCacheBadge({ info }: { info: DriveCacheInfo }) {
  const hasRoot = !!info.rootSnapshotId;
  const label = !info.hasCache ? '未保存目录' : !hasRoot ? '部分目录' : '目录已保存';
  const description = !info.hasCache
    ? '尚未保存这块磁盘的目录。扫描后可在下次启动时继续浏览。'
    : !hasRoot
      ? `未全盘扫描，只保存了部分子目录。最近保存：${readableTime(info.updatedAt)}。`
      : `这块磁盘已有保存的目录。最近保存：${readableTime(info.updatedAt)}。子目录扫描不会替换整盘基准。`;
  return <span className={`drive-cache-badge${info.hasCache ? ' is-saved' : ' is-empty'}${info.hasCache && (!hasRoot || info.partial) ? ' is-partial' : ''}`} title={description} aria-label={description}>
    {info.hasCache ? <Database size={10} aria-hidden="true" /> : <span className="drive-cache-empty-dot" aria-hidden="true" />}
    <span>{label}</span>
  </span>;
}

export default function DiskMemoryInfo({ directory, loading, onRescan, busy, historical = false }: DiskMemoryInfoProps) {
  const isRoot = !!directory && samePath(directory.node.path, directory.drivePath);
  const placeholder = !!directory?.node.cachePlaceholder;
  const unreadable = !!directory && (!!directory.node.incomplete || !!directory.node.inaccessible || directory.skipped > 0);
  const rootTime = directory?.rootSnapshotAt || null;
  const directoryTime = directory?.createdAt || null;
  const newerFolder = !!directoryTime && !!rootTime && Date.parse(directoryTime) > Date.parse(rootTime);
  const warnings = [...new Set(directory?.warnings.filter(Boolean) || [])];
  const title = loading ? '正在读取已保存的目录' : historical ? '历史扫描结果' : placeholder ? '未全盘扫描，只保存了部分目录' : directory ? '已保存的磁盘目录' : '这块磁盘还没有保存的目录';
  const label = !directory ? '扫描并保存目录' : isRoot ? '重新扫描整盘' : '重新扫描当前文件夹';
  const explanatory = loading ? '从这台电脑读取目录索引，无需重新遍历磁盘。'
    : historical ? '正在查看历史扫描；当前磁盘的目录绑定保持不变。'
      : placeholder ? '下方只列出已保存的子目录，不能代表整盘总量。完整扫描整盘后会建立整盘基准。'
        : !directory ? '扫描完成后会保存在本机，切换磁盘、关闭应用或重启电脑后都能继续浏览。'
          : directory.needsScan ? '已保留此目录的大小，但下一层明细尚未保存。重新扫描当前范围后可继续逐层浏览。'
            : newerFolder ? '此目录来自较新的单独扫描；整盘总量仍取自原整盘基准，两次读取不会混合成新的整盘总量。'
              : !rootTime ? '尚未扫描整盘，当前只保存了所列范围；这些数据不能代表整盘总量。'
                : '子目录重扫只更新该目录；整盘总量取自整盘基准，重新扫描整盘后统一更新目录绑定。';

  return <section className={`disk-memory-info glass${placeholder || directory?.partial ? ' has-partial' : ''}${loading ? ' is-loading' : ''}`} aria-label="磁盘目录保存状态" aria-busy={loading}>
    <span className="disk-memory-icon" aria-hidden="true">{loading ? <LoaderCircle size={20} className="disk-memory-spinner" /> : historical ? <History size={20} /> : placeholder ? <FolderTree size={21} /> : <Database size={20} />}</span>
    <div className="disk-memory-content">
      <div className="disk-memory-title-row"><strong>{title}</strong>{!loading && directory && !historical && !placeholder && <span className={`disk-memory-state${directory.partial || unreadable ? ' is-partial' : ''}`}>{unreadable ? <Info size={10} /> : directory.partial ? <FolderTree size={10} /> : <ShieldCheck size={10} />}{unreadable ? '包含未读取项目' : directory.partial ? '局部目录记忆' : '保存在本机'}</span>}</div>
      {!loading && directory && <div className="disk-memory-times">
        <span title={directory.node.path}><Clock3 size={11} aria-hidden="true" />{historical ? '当前目录索引时间' : '目录上次读取'} <time dateTime={directoryTime || undefined}>{readableTime(directoryTime)}</time></span>
        <span><HardDrive size={11} aria-hidden="true" />整盘基准 <time dateTime={rootTime || undefined}>{rootTime ? readableTime(rootTime) : '未全盘扫描'}</time></span>
        {!placeholder && !directory.needsScan && <span className="disk-memory-count">{formatCount(directory.node.files)} 个文件 · {formatCount(directory.node.folders)} 个文件夹</span>}
      </div>}
      <p className="disk-memory-description" role="status" aria-live="polite">{explanatory}</p>
      {!loading && warnings.length > 0 && <div className="disk-memory-warnings"><Info size={12} aria-hidden="true" /><div>{warnings.map(warning => <p key={warning}>{warning}</p>)}</div></div>}
    </div>
    <button className="disk-memory-rescan secondary-button" onClick={onRescan} disabled={busy || loading} title={busy ? '请等待当前操作完成后再重新扫描' : isRoot ? '重新读取整盘，并更新这块磁盘的目录绑定' : '只重新读取当前文件夹，保留整盘基准'}><RefreshCw size={13} aria-hidden="true" /><span>{label}</span></button>
  </section>;
}
