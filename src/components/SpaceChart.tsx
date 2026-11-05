import { useId, useMemo, useRef, useState, useEffect, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowUpRight, Circle, Layers3, ScanLine } from 'lucide-react';
import { formatBytes, layoutTreemap, percentage } from '../chart-layout';
import type { ChartItem } from '../types';
import './SpaceChart.css';

interface SpaceChartProps {
  items: ChartItem[];
  view: 'treemap' | 'donut' | 'bar';
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onOpenItem?: (id: string) => void;
  total: number;
  busy?: boolean;
}

const palette = ['#c5b8f4', '#a8d9cc', '#f1c4b7', '#a9d7e8', '#e7cee8', '#e7d6a5', '#bdcee9', '#c7ddba'];
const point = (angle: number, radius: number) => ({ x: 150 + Math.cos(angle) * radius, y: 150 + Math.sin(angle) * radius });

function donutPath(start: number, end: number) {
  const angle = Math.min(end - start, Math.PI * 2 - 0.00001);
  const outerStart = point(start, 128);
  const outerEnd = point(start + angle, 128);
  const innerStart = point(start, 92);
  const innerEnd = point(start + angle, 92);
  const large = angle > Math.PI ? 1 : 0;
  return `M ${outerStart.x} ${outerStart.y} A 128 128 0 ${large} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A 92 92 0 ${large} 0 ${innerStart.x} ${innerStart.y} Z`;
}

export default function SpaceChart({ items, view, selectedId, onSelect, onOpenItem, total, busy = false }: SpaceChartProps) {
  const chartId = useId().replace(/:/g, '');
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 760, height: 405 });
  const [hovered, setHovered] = useState<string | null>(null);
  const positiveItems = useMemo(() => items.filter(item => Number.isFinite(item.value) && item.value > 0)
    .map((item, index) => ({ ...item, color: item.color || palette[index % palette.length] }))
    .sort((a, b) => b.value - a.value), [items]);
  const includedTotal = positiveItems.reduce((sum, item) => sum + item.value, 0);
  const denominator = total > 0 ? total : includedTotal;
  const active = positiveItems.find(item => item.id === (hovered ?? selectedId));
  const selected = positiveItems.find(item => item.id === selectedId);
  const rects = useMemo(() => layoutTreemap(positiveItems, frame.width, frame.height), [positiveItems, frame]);
  const canOpen = (item: ChartItem) => Boolean(onOpenItem) && item.openable !== false;
  const itemTitle = (item: ChartItem) => canOpen(item) ? '单击查看详情 · 双击或 Alt + Enter 进入文件夹' : item.detail || '单击查看详情';
  const ariaLabel = (item: ChartItem) => `${item.label}，${formatBytes(item.value)}，占当前范围 ${percentage(item.value, denominator)}。按下查看详情${canOpen(item) ? '，双击或 Alt 加回车进入文件夹' : ''}`;
  const openWithKeyboard = (event: KeyboardEvent<HTMLElement>, item: ChartItem) => { if (event.altKey && event.key === 'Enter' && canOpen(item)) { event.preventDefault(); onOpenItem!(item.id); } };
  const largestValue = positiveItems[0]?.value ?? 0;

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setFrame({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view, positiveItems.length]);

  useEffect(() => { setHovered(null); }, [view, items]);

  if (!positiveItems.length) {
    return <div className={`space-chart chart-empty ${busy ? 'chart-is-busy' : ''}`} aria-live="polite">
      <div className="chart-empty-art" aria-hidden="true"><div /><div /><div /><ScanLine size={30} /></div>
      <strong>{busy ? '正在绘制你的存储地图' : '这里等待你的第一张存储地图'}</strong>
      <p>{busy ? '文件夹会随着扫描逐渐呈现，请稍候。' : '选择一个磁盘或文件夹，看看空间都藏在哪里。'}</p>
    </div>;
  }

  return <div className={`space-chart chart-view-${view} ${busy ? 'chart-is-busy' : ''}`}>
    {view === 'treemap' && <>
      <div className="chart-map" ref={frameRef} role="group" aria-label="按实际容量比例划分的存储方格图">
        {rects.map(({ item, x, y, width, height }, index) => {
          const roomy = width > 145 && height > 125;
          const showText = width > 69 && height > 50;
          const subdivisions = roomy && item.children?.length ? layoutTreemap(item.children, width, height) : [];
          return <button key={item.id} type="button"
            className={`chart-tile chart-kind-${item.kind||'folder'} ${selectedId === item.id ? 'is-selected' : ''} ${roomy ? 'tile-roomy' : ''}`}
            style={{ left: `${x / frame.width * 100}%`, top: `${y / frame.height * 100}%`, width: `${width / frame.width * 100}%`, height: `${height / frame.height * 100}%`, '--tile-color': item.color, '--tile-delay': `${Math.min(index * 30, 300)}ms` } as CSSProperties}
            onClick={() => onSelect(item.id)} onDoubleClick={canOpen(item) ? () => onOpenItem!(item.id) : undefined} onKeyDown={event => openWithKeyboard(event, item)} title={itemTitle(item)} onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(item.id)} onBlur={() => setHovered(null)}
            aria-label={ariaLabel(item)} aria-pressed={selectedId === item.id}>
            <span className="tile-grid" aria-hidden="true" />
            {subdivisions.length > 0 && <span className="tile-subdivisions" aria-hidden="true">{subdivisions.map(child => <i key={child.item.id} style={{ left: `${child.x / width * 100}%`, top: `${child.y / height * 100}%`, width: `${child.width / width * 100}%`, height: `${child.height / height * 100}%` }} />)}</span>}
            {showText && <span className="tile-copy"><strong>{item.label}</strong><span>{formatBytes(item.value)}</span>{roomy && <small>{percentage(item.value, denominator)} 的空间</small>}</span>}
            {roomy && canOpen(item) && <ArrowUpRight className="tile-arrow" size={18} aria-hidden="true" />}
            {width > 85 && height > 190 && <span className="tile-chip" aria-hidden="true"><Layers3 size={12} />{item.kind==='unattributed'?'差额估算':item.kind==='free'?'可用于存储':item.children?.length ? `${item.children.length} 个分区` : '容量分区'}</span>}
          </button>;
        })}
        {active && <div className="chart-tooltip" role="status" aria-live="polite"><i style={{ background: active.color }} /><strong>{active.label}</strong><span>{formatBytes(active.value)}</span><small>{percentage(active.value, denominator)}</small></div>}
      </div>
      <div className="chart-map-caption"><span><i />按显示容量比例划分</span><span>{onOpenItem ? '单击详情 · 双击文件夹进入' : '点击分区查看详情'} <ArrowUpRight size={12} /></span></div>
    </>}

    {view === 'donut' && <div className="chart-donut-layout">
      <div className="chart-donut-visual">
        <svg className="chart-donut" viewBox="0 0 300 300" role="group" aria-labelledby={`${chartId}-title`}>
          <title id={`${chartId}-title`}>各项目容量占比环形图</title>
          <defs><pattern id={`${chartId}-unknown`} width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#b6b8be"/><path d="M-1 1L1 -1M0 7L7 0M6 8L8 6" stroke="#fff" strokeOpacity=".5" strokeWidth="1.5"/></pattern></defs>
          <circle cx="150" cy="150" r="110" fill="none" stroke="currentColor" strokeWidth="36" className="donut-track" />
          {positiveItems.map((item, index) => {
            const before = positiveItems.slice(0, index).reduce((sum, entry) => sum + entry.value, 0);
            const start = before / includedTotal * Math.PI * 2 - Math.PI / 2;
            const end = (before + item.value) / includedTotal * Math.PI * 2 - Math.PI / 2;
            return <path key={item.id} d={donutPath(start, end)} fill={item.kind==='unattributed'?`url(#${chartId}-unknown)`:item.color} strokeWidth="2.8" stroke={item.kind==='free'?'#d6d7dc':'var(--chart-ring-gap, #f9f8fc)'}
              className={`donut-segment ${selectedId === item.id ? 'is-selected' : ''} ${hovered === item.id ? 'is-hovered' : ''}`}
              role="button" tabIndex={0} aria-label={ariaLabel(item)} aria-pressed={selectedId === item.id}
              onClick={() => onSelect(item.id)} onDoubleClick={canOpen(item) ? () => onOpenItem!(item.id) : undefined} onKeyDown={event => { if (event.key === 'Enter' && event.altKey && canOpen(item)) { event.preventDefault(); onOpenItem!(item.id); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.id); } }}
              onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={() => setHovered(null)}
              style={{ '--tile-delay': `${Math.min(index * 35, 300)}ms` } as CSSProperties}><title>{item.label} · {formatBytes(item.value)} · {percentage(item.value, denominator)} · {itemTitle(item)}</title></path>;
          })}
        </svg>
        <div className="donut-center" aria-live="polite"><span>{active ? active.label : '当前范围'}</span><strong>{formatBytes(active?.value ?? denominator)}</strong><small>{active ? `${percentage(active.value, denominator)} 的空间` : `${positiveItems.length} 个容量分区`}</small></div>
        <div className="donut-footnote"><Circle size={10} />空间分布，一眼读懂</div>
      </div>
      <div className="donut-legend" role="group" aria-label="环形图项目列表">
        <div className="chart-legend-heading"><span>容量分区</span><span>占比</span></div>
        {positiveItems.map((item, index) => <button key={item.id} type="button" className={`legend-item chart-kind-${item.kind||'folder'} ${selectedId === item.id ? 'is-selected' : ''}`} aria-pressed={selectedId === item.id} aria-label={ariaLabel(item)}
          onClick={() => onSelect(item.id)} onDoubleClick={canOpen(item) ? () => onOpenItem!(item.id) : undefined} onKeyDown={event => openWithKeyboard(event, item)} title={itemTitle(item)} onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={() => setHovered(null)}>
          <i style={{ background: item.color }} /><span className="legend-copy"><strong>{item.label}</strong><small>{formatBytes(item.value)}</small></span><span className="legend-percent">{percentage(item.value, denominator)}</span>{canOpen(item)&&<ArrowUpRight size={14} />}
          <span className="legend-share" style={{ background: item.color, width: `${item.value / includedTotal * 100}%`, '--tile-delay': `${index * 25}ms` } as CSSProperties} />
        </button>)}
      </div>
    </div>}

    {view === 'bar' && <div className="chart-bars" role="group" aria-label="按容量从大到小排列的条形图">
      <div className="chart-bars-heading"><span>容量排名 <small>由大到小</small></span><span>大小 / 当前范围占比</span></div>
      {positiveItems.map((item, index) => <button key={item.id} type="button" className={`chart-bar-row chart-kind-${item.kind||'folder'} ${selectedId === item.id ? 'is-selected' : ''}`} aria-pressed={selectedId === item.id} aria-label={ariaLabel(item)} onClick={() => onSelect(item.id)} onDoubleClick={canOpen(item) ? () => onOpenItem!(item.id) : undefined} onKeyDown={event => openWithKeyboard(event, item)} title={itemTitle(item)}>
        <span className="bar-rank">{String(index + 1).padStart(2, '0')}</span>
        <span className="bar-main"><span className="bar-label"><strong>{item.label}</strong><span>{formatBytes(item.value)}<small>{percentage(item.value, denominator)}</small></span></span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${item.value / largestValue * 100}%`, background: item.color, '--tile-delay': `${Math.min(index * 40, 400)}ms` } as CSSProperties}><span /></span></span>
        </span>{canOpen(item)&&<ArrowUpRight size={15} className="bar-arrow" />}
      </button>)}
      <p className="bar-footnote">条形长度以最大的分区为参照，百分比表示当前范围内的容量占比。</p>
    </div>}
    {selected && view !== 'treemap' && <div className="chart-selection-note"><i style={{ background: selected.color }} /><span>已选择 <strong>{selected.label}</strong></span><span>{formatBytes(selected.value)}</span></div>}
  </div>;
}
