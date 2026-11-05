import { useId, useMemo, useState, type CSSProperties } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChartNoAxesCombined, ChevronDown, ChevronRight, CircleHelp, Clock3, File, Files, Folder, FolderOpen, GitCompareArrows, HardDrive, History, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { SnapshotComparison, SnapshotMeta, SpaceChange } from '../types';
import { formatBytes } from '../data';
import './ChangesPanel.css';

export interface ChangesPanelProps {
  snapshots: SnapshotMeta[];
  comparison: SnapshotComparison | null;
  baselineId: string;
  currentId: string;
  onBaselineChange: (id: string) => void;
  onCurrentChange: (id: string) => void;
  onCompare: () => void;
  onScopeChange: (path: string) => void;
  onOpenPath: (path: string) => void;
  onScan: () => void;
  loading: boolean;
  busy: boolean;
  error?: string;
  sample: boolean;
}

type Filter = 'all' | 'growth' | 'released';
const normalize = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');
const dateTime = (value: string, short = false) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(short ? {} : { year: 'numeric' as const }), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};
const signedBytes = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatBytes(Math.abs(value))}`;
const deltaClass = (value: number | null) => value === null ? 'uncertain' : value > 0 ? 'positive' : value < 0 ? 'negative' : '';
const isSameVolume = (first: SnapshotMeta, second: SnapshotMeta) => (!first.drive || !second.drive || first.drive.total === second.drive.total) && (!first.drive?.volumeId || !second.drive?.volumeId || first.drive.volumeId === second.drive.volumeId);
const snapshotLabel = (snapshot: SnapshotMeta) => `${dateTime(snapshot.createdAt)} · ${formatBytes(snapshot.size)}${snapshot.incomplete || snapshot.skipped ? ' · 部分结果' : ''}`;

function Evidence({ row }: { row: SpaceChange }) {
  const label = { grown: '增长', shrunk: '减少', added: '新增', removed: '已移除', unchanged: '未变化', uncertain: '待确认', aggregate: '合并项' }[row.status];
  const uncertain = row.delta === null || row.status === 'uncertain';
  return <span className={`chg-evidence ${uncertain ? 'uncertain' : row.status}`} title={row.note || label}>{uncertain && <CircleHelp size={10} />}{uncertain ? '待确认' : label}</span>;
}

function CapacityComparison({ comparison, chartId }: { comparison: SnapshotComparison; chartId: string }) {
  const { summary, baseline, current } = comparison;
  const maximum = Math.max(summary.beforeSize, summary.afterSize, 1);
  const changes = Math.max(summary.growth, summary.released, 1);
  return <section className="chg-capacity glass" aria-labelledby={`${chartId}-capacity`}>
    <div className="chg-section-top"><h3 id={`${chartId}-capacity`}>空间变化一览</h3><span className="chg-scope-name" title={comparison.scopePath}><Folder size={12} />{comparison.scopeName || comparison.scopePath}</span></div>
    <div className="chg-capacity-body">
      <div className="chg-net"><span>{summary.uncertain ? '已读容量差值' : '范围净变化'}</span><strong className={deltaClass(summary.netDelta)}>{signedBytes(summary.netDelta)}</strong><small>{dateTime(baseline.createdAt, true)}<ArrowRight size={11} />{dateTime(current.createdAt, true)}</small></div>
      <div className="chg-capacity-bars" role="img" aria-label={`基准已读容量 ${formatBytes(summary.beforeSize)}，本次 ${formatBytes(summary.afterSize)}，${summary.uncertain ? '观测' : '净'}变化 ${signedBytes(summary.netDelta)}`}>
        {[{ label: '基准', value: summary.beforeSize, className: 'before' }, { label: '本次', value: summary.afterSize, className: 'after' }].map(row => <div className="chg-capacity-row" key={row.label}><span>{row.label}</span><div className="chg-capacity-track"><i className={row.className} style={{ width: `${row.value / maximum * 100}%` }} /></div><strong>{formatBytes(row.value)}</strong></div>)}
      </div>
    </div>
    <div className="chg-confirmed" role="img" aria-label={`本层已确认增长 ${formatBytes(summary.growth)}，减少 ${formatBytes(summary.released)}`}>
      <span className="negative"><ArrowDownLeft size={13} />已确认减少<strong>−{formatBytes(summary.released)}</strong></span>
      <div className="chg-balance"><div><i className="negative" style={{ width: `${summary.released / changes * 100}%` }} /></div><div><i className="positive" style={{ width: `${summary.growth / changes * 100}%` }} /></div></div>
      <span className="positive"><ArrowUpRight size={13} />已确认增长<strong>+{formatBytes(summary.growth)}</strong></span>
    </div>
  </section>;
}

function ChangeChart({ rows, disabled, onScopeChange, chartId }: { rows: SpaceChange[]; disabled: boolean; onScopeChange: (path: string) => void; chartId: string }) {
  const candidates = rows.filter(row => row.delta !== null && row.delta !== 0 && row.status !== 'aggregate').sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!)).slice(0, 8);
  const maximum = Math.max(...candidates.map(row => Math.abs(row.delta!)), 1);
  const uncertain = rows.filter(row => row.delta === null).length;
  return <section className="chg-ranking glass" aria-labelledby={`${chartId}-ranking`}>
    <div className="chg-section-top"><h3 id={`${chartId}-ranking`}>变化来自哪里</h3><div className="chg-chart-legend"><span><i className="negative" />减少</span><span><i className="positive" />增长</span></div></div>
    <div className="chg-ranking-columns" aria-hidden="true"><span>本层项目 · TOP 8</span><span>减少<ArrowDownLeft size={11} /><i />0<i /><ArrowUpRight size={11} />增长</span><span>容量变化</span></div>
    {candidates.length ? <div className="chg-diverging">{candidates.map((row, index) => <div className="chg-diverging-row" key={row.id}>
      <button className="chg-chart-name" disabled={!row.canDrill || disabled} type="button" onClick={() => onScopeChange(row.path)} title={row.canDrill ? `查看 ${row.path} 内部变化` : row.path}>{row.isFile ? <File size={14} /> : <Folder size={15} />}<span>{row.name}</span>{row.canDrill && <ChevronRight size={12} />}</button>
      <div className="chg-diverging-track" role="img" aria-label={`${row.name} ${row.delta! > 0 ? '增长' : '减少'} ${formatBytes(Math.abs(row.delta!))}`}><i className={deltaClass(row.delta)} style={{ width: `${Math.abs(row.delta!) / maximum * 50}%`, animationDelay: `${index * 35}ms` } as CSSProperties} /></div>
      <strong className={deltaClass(row.delta)}>{signedBytes(row.delta!)}</strong>
    </div>)}</div> : <div className="chg-chart-empty"><GitCompareArrows size={24} /><span>暂无可单独定位的变化项目</span></div>}
    <div className="chg-chart-footer"><span>点击文件夹，继续定位变化</span>{uncertain > 0 && <span className="chg-uncertain-key"><i />{uncertain} 项待确认 · 见明细</span>}</div>
  </section>;
}

function Trend({ snapshots, selectedIds, chartId }: { snapshots: SnapshotMeta[]; selectedIds: string[]; chartId: string }) {
  const records = [...snapshots].filter(snapshot => Number.isFinite(Date.parse(snapshot.createdAt)) && Number.isFinite(snapshot.size)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-12);
  const values = records.map(snapshot => snapshot.size);
  const smallest = Math.min(...values), largest = Math.max(...values);
  const start = records.length ? Date.parse(records[0].createdAt) : 0;
  const end = records.length ? Date.parse(records[records.length - 1].createdAt) : 0;
  const points = records.map((snapshot, index) => ({ snapshot,
    x: start === end ? 40 + index / Math.max(1, records.length - 1) * 500 : 40 + (Date.parse(snapshot.createdAt) - start) / (end - start) * 500,
    y: smallest === largest ? 53 : 85 - (snapshot.size - smallest) / (largest - smallest) * 52,
  }));
  return <section className="chg-trend-panel glass" aria-labelledby={`${chartId}-trend-title`}>
    <div className="chg-section-top"><h3 id={`${chartId}-trend-title`}><ChartNoAxesCombined size={15} />容量趋势</h3><small>最近 {records.length} 次扫描</small></div>
    {records.length >= 2 ? <div className="chg-trend"><svg viewBox="0 0 580 123" preserveAspectRatio="none" role="img" aria-labelledby={`${chartId}-trend-desc`}>
      <title id={`${chartId}-trend-desc`}>同一路径的已读文件容量。{records.map(snapshot => `${dateTime(snapshot.createdAt)}：${formatBytes(snapshot.size)}${snapshot.incomplete || snapshot.skipped ? '，部分扫描' : ''}`).join('；')}。连线不代表持续监测。</title>
      <defs><linearGradient id={`${chartId}-trend-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".2" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      {[35, 62, 89].map(y => <line key={y} x1="20" x2="560" y1={y} y2={y} className="chg-trend-grid" />)}
      <path d={`M ${points[0].x} 95 L ${points.map(point => `${point.x} ${point.y}`).join(' L ')} L ${points[points.length - 1].x} 95 Z`} fill={`url(#${chartId}-trend-fill)`} />
      <polyline points={points.map(point => `${point.x},${point.y}`).join(' ')} className="chg-trend-line" vectorEffect="non-scaling-stroke" />
      {points.map((point, index) => <g key={point.snapshot.id}>
        <circle cx={point.x} cy={point.y} r={selectedIds.includes(point.snapshot.id) ? 4.5 : 3} className={`chg-trend-dot ${selectedIds.includes(point.snapshot.id) ? 'selected' : ''} ${point.snapshot.incomplete || point.snapshot.skipped ? 'partial' : ''}`} vectorEffect="non-scaling-stroke"><title>{dateTime(point.snapshot.createdAt)} · {formatBytes(point.snapshot.size)}{point.snapshot.incomplete || point.snapshot.skipped ? ' · 部分扫描' : ''}</title></circle>
        {(records.length <= 4 || index === 0 || index === records.length - 1) && <><text x={point.x} y={point.y - 13} className="chg-trend-value" textAnchor="middle">{formatBytes(point.snapshot.size)}</text><text x={point.x} y="119" className="chg-trend-label" textAnchor="middle">{new Date(point.snapshot.createdAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })}</text></>}
      </g>)}
    </svg></div> : <div className="chg-chart-empty"><Clock3 size={22} /><span>同一路径保存两次扫描后显示趋势</span></div>}
    <div className="chg-chart-footer"><span>每个圆点 = 一次扫描</span>{records.some(record => record.incomplete || record.skipped) && <span className="chg-uncertain-key"><i />虚线圆点为部分扫描</span>}</div>
  </section>;
}

function DiskDifference({ comparison, chartId }: { comparison: SnapshotComparison; chartId: string }) {
  const { summary } = comparison;
  const rows = [
    { name: '整盘已用', value: summary.diskUsedDelta, className: 'disk' },
    { name: '已读文件', value: summary.netDelta, className: 'files' },
    { name: '未归因', value: summary.unexplainedDelta, className: 'unknown' },
  ];
  const maximum = Math.max(...rows.map(row => Math.abs(row.value || 0)), 1);
  return <section className="chg-disk-panel glass" aria-labelledby={`${chartId}-disk`}>
    <div className="chg-section-top"><h3 id={`${chartId}-disk`}><HardDrive size={15} />整盘差值对照</h3><span className="chg-disk-equation" title="整盘已用变化 − 已读文件变化 = 未归因差值">① − ② = ③</span></div>
    {summary.diskUsedDelta !== null ? <><div className="chg-disk-chart">{rows.map((row, index) => <div className="chg-disk-row" key={row.name}>
      <span><i>{index + 1}</i>{row.name}</span><div className={`chg-disk-track ${row.className}`} role="img" aria-label={`${row.name} ${row.value === null ? '无法确认' : signedBytes(row.value)}`}><i className={row.value !== null && row.value < 0 ? 'left' : 'right'} style={{ width: `${Math.abs(row.value || 0) / maximum * 50}%` }} /></div><strong>{row.value === null ? '—' : signedBytes(row.value)}</strong>
    </div>)}</div><div className="chg-chart-footer"><span>中心为 0 · 左减右增</span><span className="chg-uncertain-key"><i />灰白表示未归因</span></div></> : <div className="chg-chart-empty"><HardDrive size={23} /><span>{comparison.current.isDriveRoot && normalize(comparison.scopePath) !== normalize(comparison.current.rootPath) ? '返回盘符根目录查看整盘差值' : '两次整盘扫描后可对照磁盘变化'}</span></div>}
  </section>;
}

export default function ChangesPanel({ snapshots, comparison, baselineId, currentId, onBaselineChange, onCurrentChange, onCompare, onScopeChange, onOpenPath, onScan, loading, busy, error, sample }: ChangesPanelProps) {
  const chartId = useId().replace(/:/g, '');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const ordered = useMemo(() => [...snapshots].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [snapshots]);
  const current = ordered.find(snapshot => snapshot.id === currentId);
  const baseline = ordered.find(snapshot => snapshot.id === baselineId);
  const grouped = useMemo(() => {
    const groups = new Map<string, { path: string; records: SnapshotMeta[] }>();
    ordered.forEach(snapshot => { const key = normalize(snapshot.rootPath); if (!groups.has(key)) groups.set(key, { path: snapshot.rootPath, records: [] }); groups.get(key)!.records.push(snapshot); });
    return [...groups.values()];
  }, [ordered]);
  const compatible = current ? ordered.filter(snapshot => normalize(snapshot.rootPath) === normalize(current.rootPath) && snapshot.id !== current.id) : [];
  const validPair = Boolean(current && baseline && current.id !== baseline.id && normalize(current.rootPath) === normalize(baseline.rootPath) && isSameVolume(current, baseline));
  const active = comparison && comparison.baseline.id === baselineId && comparison.current.id === currentId ? comparison : null;
  const trendSnapshots = current ? ordered.filter(snapshot => normalize(snapshot.rootPath) === normalize(current.rootPath) && isSameVolume(snapshot, current)) : [];
  const qualityWarnings = active ? [...new Set([...active.warnings, ...(active.summary.uncertain && !active.warnings.length ? ['净变化是已读容量的观测差值；增长与减少仅包含可确认的项目。'] : [])])] : [];
  const displayedRows = useMemo(() => (active?.rows || []).filter(row => {
    const matches = `${row.name} ${row.path}`.toLowerCase().includes(query.trim().toLowerCase());
    return matches && (filter === 'all' || (row.delta !== null && (filter === 'growth' ? row.delta > 0 : row.delta < 0)));
  }).sort((a, b) => Math.abs(b.delta ?? b.observedDelta) - Math.abs(a.delta ?? a.observedDelta)), [active, query, filter]);
  const changeRoot = current?.rootPath || '';
  const hasSecondSnapshot = trendSnapshots.length >= 2;

  return <div className="changes-panel" aria-busy={loading}>
    <section className="chg-select-panel glass" aria-labelledby={`${chartId}-heading`}>
      <div className="chg-selector-heading"><h2 id={`${chartId}-heading`}><GitCompareArrows size={18} />空间变化</h2>{sample ? <span className="chg-sample-label"><Sparkles size={12} />演示数据</span> : <span className="chg-local-label"><History size={12} />已保存 {ordered.length} 次扫描</span>}</div>
      <div className="chg-selectors">
        <label className="chg-select-wrap"><span className="chg-select-label"><i>A</i>基准扫描</span><span className="chg-select-box"><select aria-label="选择基准扫描" value={baselineId} onChange={event => onBaselineChange(event.target.value)} disabled={loading || busy || !compatible.length}><option value="">{compatible.length ? '选择对照记录' : '同路径还没有第二次扫描'}</option>{compatible.map(snapshot => <option key={snapshot.id} value={snapshot.id} disabled={Boolean(current && !isSameVolume(snapshot, current))}>{snapshotLabel(snapshot)}{current && !isSameVolume(snapshot, current) ? ' · 磁盘不同' : ''}</option>)}</select><ChevronDown size={13} /></span></label>
        <ArrowRight className="chg-compare-arrow" size={17} aria-hidden="true" />
        <label className="chg-select-wrap"><span className="chg-select-label"><i>B</i>本次扫描</span><span className="chg-select-box"><select aria-label="选择本次扫描" value={currentId} onChange={event => onCurrentChange(event.target.value)} disabled={loading || busy || !ordered.length}><option value="">{ordered.length ? '选择查看的记录' : '尚无扫描记录'}</option>{grouped.map(group => <optgroup key={group.path} label={group.path}>{group.records.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshotLabel(snapshot)}</option>)}</optgroup>)}</select><ChevronDown size={13} /></span></label>
        <button type="button" className="primary-button" disabled={!validPair || loading || busy} onClick={onCompare}>{loading ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />}{loading ? '正在比较…' : '比较变化'}</button>
      </div>
      <div className="chg-selector-footer"><span title={changeRoot}><Folder size={12} />{changeRoot || '选择一个扫描路径'}</span><button type="button" onClick={onScan} disabled={loading || busy}><RefreshCw size={12} />{busy ? '正在扫描…' : changeRoot ? '重新扫描' : '开始扫描'}</button></div>
    </section>
    {baseline && current && baseline.id !== current.id && !validPair && <div className="chg-quality" role="status"><CircleHelp size={15} /><span>{normalize(baseline.rootPath) !== normalize(current.rootPath) ? '请选择同一路径的两次扫描。' : '磁盘标识或容量不同，请选择同一磁盘的记录。'}</span></div>}
    {error && <div className="notice error-notice chg-error" role="alert"><CircleHelp size={16} /><span>{error}</span></div>}
    {loading ? <div className="chg-loading glass" role="status"><LoaderCircle size={21} className="spin" />正在比较扫描记录…</div> : active ? <>
      <nav className="chg-breadcrumb" aria-label="变化比较路径"><FolderOpen size={13} />{active.breadcrumbs.map((crumb, index) => <span key={crumb.path}><button type="button" disabled={loading || busy} className={index === active.breadcrumbs.length - 1 ? 'current' : ''} aria-current={index === active.breadcrumbs.length - 1 ? 'location' : undefined} onClick={() => onScopeChange(crumb.path)} title={crumb.path}>{index === 0 ? crumb.path : crumb.name}</button>{index < active.breadcrumbs.length - 1 && <ChevronRight size={12} />}</span>)}</nav>
      <CapacityComparison comparison={active} chartId={chartId} />
      {qualityWarnings.length > 0 && <details className="chg-quality"><summary><CircleHelp size={14} /><span>{active.summary.uncertain ? '部分变化待确认' : '比较说明'}</span><ChevronDown size={13} /></summary><ul>{qualityWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <ChangeChart rows={active.rows} disabled={loading || busy} onScopeChange={onScopeChange} chartId={chartId} />
      <details className="chg-secondary glass"><summary className="chg-secondary-toggle"><span>历史趋势与整盘对照</span><ChevronDown size={16} /></summary><div className="chg-secondary-grid"><Trend snapshots={trendSnapshots} selectedIds={[baselineId, currentId]} chartId={chartId} /><DiskDifference comparison={active} chartId={chartId} /></div></details>
      <details className="chg-details glass">
        <summary className="chg-details-toggle"><span>查看变化明细 <small>{active.rows.length} 项</small></span><ChevronDown size={16} /></summary>
        <div className="chg-detail-actions"><div className="chg-filter" role="group" aria-label="筛选变化类型">{([['all', '全部'], ['growth', '增长'], ['released', '减少']] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="chg-search"><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或路径…" aria-label="搜索变化明细" />{query && <button type="button" onClick={() => setQuery('')} aria-label="清空变化搜索"><X size={12} /></button>}</label></div>
        <div className="chg-table-wrap"><table className="chg-table"><thead><tr><th scope="col">名称</th><th scope="col">基准大小</th><th scope="col">本次大小</th><th scope="col">变化</th><th scope="col">操作</th></tr></thead><tbody>{displayedRows.map(row => <tr key={row.id}>
          <td><div className="chg-entry"><span className="chg-entry-icon">{row.status === 'aggregate' ? <Files size={16} /> : row.isFile ? <File size={16} /> : <Folder size={17} />}</span><div className="chg-entry-copy"><div className="chg-entry-title"><button type="button" disabled={!row.canDrill || busy} onClick={() => onScopeChange(row.path)} title={row.canDrill ? `查看 ${row.name} 内部变化` : row.path}><span>{row.name}</span>{row.canDrill && <ChevronRight size={12} />}</button><Evidence row={row} /></div><small title={row.note || row.path}>{row.note || row.path}</small></div></div></td>
          <td className="chg-size">{row.beforeSize === null ? '未确认' : formatBytes(row.beforeSize)}</td><td className="chg-size">{row.afterSize === null ? '未确认' : formatBytes(row.afterSize)}</td><td><span className={`chg-delta ${deltaClass(row.delta)}`}>{row.delta === null ? '待确认' : signedBytes(row.delta)}</span>{row.delta === null && <small className="chg-observed">观测 {signedBytes(row.observedDelta)}</small>}</td><td>{row.canDrill && <button type="button" className="chg-row-action" disabled={busy} onClick={() => onScopeChange(row.path)} title="查看下一层变化">展开<ChevronRight size={12} /></button>}<button type="button" className="chg-row-action" disabled={!row.currentExists || row.status === 'aggregate' || busy || sample} onClick={() => onOpenPath(row.path)} title={sample ? '示例路径不能打开' : !row.currentExists ? '本次记录中不存在' : '在资源管理器中打开'} aria-label={`在资源管理器中打开 ${row.name}`}><FolderOpen size={13} /></button></td>
        </tr>)}</tbody></table>{!displayedRows.length && <div className="chg-table-empty"><Search size={23} /><span>{query ? '没有匹配的项目' : '本层没有符合筛选条件的项目'}</span></div>}</div>
      </details>
      <details className="chg-reading-note"><summary><CircleHelp size={12} />图表说明<ChevronDown size={12} /></summary><ul><li>增长和减少只统计本层可确认的项目；父目录与子目录分层显示，不重复相加。</li><li>容量趋势来自手动扫描记录，连线不代表持续监测；进入子目录后，趋势仍展示扫描根目录的历史。</li><li>整盘已用空间与文件逻辑大小的口径不同。未归因差值可能来自系统保留、分配方式、链接、未读取区域或扫描期间的写入，无法确定属于哪个文件夹。</li></ul></details>
    </> : <section className="chg-setup-empty glass"><div className="chg-empty-illustration" aria-hidden="true"><History size={28} /><ArrowRight size={19} /><GitCompareArrows size={28} /></div><h3>{hasSecondSnapshot ? '选择两次扫描，看看空间去了哪里' : '再扫一次，就能看见空间变化'}</h3><p>{hasSecondSnapshot ? '选择同一路径的两份记录，点击“比较变化”。' : current ? `${current.rootPath} 已有一份记录，下一次扫描后即可对比。` : '第一次扫描作为基准，下一次扫描用来对照。'}</p><div className="chg-empty-steps"><span><i>1</i>扫描</span><ArrowRight size={12} /><span><i>2</i>同路径再扫描</span><ArrowRight size={12} /><span><i>3</i>查看变化</span></div><button type="button" className="primary-button" disabled={busy || loading} onClick={hasSecondSnapshot && validPair ? onCompare : onScan}>{hasSecondSnapshot && validPair ? <GitCompareArrows size={15} /> : <RefreshCw size={15} />}{busy ? '正在扫描…' : hasSecondSnapshot && validPair ? '比较选中的记录' : current ? '再次扫描此路径' : '开始扫描'}</button></section>}
  </div>;
}
