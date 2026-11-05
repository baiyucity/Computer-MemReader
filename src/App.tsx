import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, Disc3, Download, Folder, FolderOpen, Grid2X2, HardDrive, LayoutDashboard, Layers3, LoaderCircle, Maximize2, Minus, Monitor, Palette, PieChart, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, SquareChartGantt, X } from 'lucide-react';
import SpaceChart from './components/SpaceChart';
import ThemePanel, { accentForeground } from './components/ThemePanel';
import ChangesPanel from './components/ChangesPanel';
import SnapshotHistory from './components/SnapshotHistory';
import DiskMemoryInfo, { DriveCacheBadge } from './components/DriveMemoryBadge';
import { cachedDirectoryResult, directoryHasRetainedPreview, historicalTrail, normalizeCachePath } from './cache-navigation';
import { demoSnapshots, demoComparison } from './change-demo';
import { storagePreview } from './storage-preview';
import type { ChartItem, DiskNode, Drive, ScanProgress, ScanResult, Software, Theme, SnapshotMeta, SnapshotComparison, CachedDirectory, DriveCacheInfo } from './types';
import { demoDrives, demoForDrive, demoResult, demoSoftware, findTrail, formatBytes, formatCount, palette } from './data';

const defaultTheme: Theme = { accent: '#8770c9', background: null, glass: 0.87, motion: true, mode: 'light', autoColor: true };
type Mode = 'folders' | 'software' | 'history' | 'changes';
type View = 'treemap' | 'donut' | 'bar';
const native = Boolean(window.memreader);

function BrandMark() { return <svg viewBox="0 0 40 40" className="brand-mark" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="12" fill="currentColor"/><path d="M11 27V14a3 3 0 0 1 5-2l4 5 4-5a3 3 0 0 1 5 2v13h-5V18l-4 5-4-5v9z" fill="white"/><circle cx="29" cy="10" r="2" fill="#e4ddf8"/></svg>; }
function OrbitIllustration() { return <svg className="orbit-illustration" viewBox="0 0 260 150" aria-hidden="true"><defs><linearGradient id="chipg" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ded6f2"/><stop offset="1" stopColor="#f6f3fb"/></linearGradient></defs><g className="orbital-lines" fill="none" stroke="var(--accent)" strokeOpacity=".18"><ellipse cx="142" cy="80" rx="104" ry="36" transform="rotate(-19 142 80)"/><ellipse cx="142" cy="80" rx="75" ry="51" transform="rotate(21 142 80)"/></g><g className="floating-chip"><path d="m84 57 59-31 62 33-60 33z" fill="url(#chipg)" stroke="#c7bbe6"/><path d="m84 57 61 35v30L84 87z" fill="#b9a7df"/><path d="m145 92 60-33v30l-60 33z" fill="#cebee9"/><path d="m106 56 37-20 40 22-38 20z" fill="#f8f5ff" stroke="#c5b5e7"/><path d="m116 55 27-14 30 16-28 15z" fill="var(--accent)" fillOpacity=".6"/><path d="m94 80 6 3m4 2 6 3m4 2 6 3m4 2 6 3" stroke="#f9f6ff" strokeWidth="3" strokeLinecap="round"/></g><g fill="var(--accent)"><circle className="orbit-spark" cx="51" cy="96" r="5"/><circle cx="224" cy="59" r="3" opacity=".5"/><path d="M66 29v12m-6-6h12" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/><circle cx="207" cy="118" r="2" opacity=".4"/></g></svg>; }
function DriveCard({drive, active, disabled, onClick}: {drive:Drive;active:boolean;disabled?:boolean;onClick:()=>void}) {
  const percentage = Math.min(100, drive.total ? drive.used / drive.total * 100 : 0);
  return <button className={`drive-card glass ${active ? 'active' : ''}`} disabled={disabled} onClick={onClick} aria-pressed={active}><div className="drive-card-top"><span className={`drive-icon ${active ? 'selected' : ''}`}><HardDrive size={20}/></span><span className="drive-name"><strong>{drive.path.slice(0, 2)} <span>{drive.name || '本地磁盘'}</span></strong><small>{drive.fileSystem || '本地磁盘'} · {formatBytes(drive.total)}</small></span><span className="drive-percent">{percentage.toFixed(0)}<small>%</small></span></div><div className="drive-meter"><span style={{width:`${percentage}%`}}/></div><div className="drive-card-bottom"><span>已用 <b>{formatBytes(drive.used)}</b></span><span>可用 <b>{formatBytes(drive.free)}</b></span></div></button>;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('folders');
  const [view, setView] = useState<View>('treemap');
  const [drives, setDrives] = useState<Drive[]>(native ? [] : demoDrives);
  const [selectedDrive, setSelectedDrive] = useState('C:\\');
  const [result, setResult] = useState<ScanResult | null>(native ? null : demoResult);
  const [trail, setTrail] = useState<DiskNode[]>(native ? [] : [demoResult.root]);
  const [demo, setDemo] = useState(!native);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [software, setSoftware] = useState<Software[]>(native ? [] : demoSoftware);
  const [softwareLoaded, setSoftwareLoaded] = useState(!native);
  const [loadingSoftware, setLoadingSoftware] = useState(false);
  const [measuring, setMeasuring] = useState<string | null>(null);
  const [savedSnapshots, setSavedSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(native);
  const [snapshotWarnings, setSnapshotWarnings] = useState<string[]>([]);
  const [baselineId, setBaselineId] = useState('');
  const [currentSnapshotId, setCurrentSnapshotId] = useState('');
  const [comparison, setComparison] = useState<SnapshotComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [cachedDirectory, setCachedDirectory] = useState<CachedDirectory | null>(null);
  const [driveCaches, setDriveCaches] = useState<DriveCacheInfo[]>([]);
  const [browseSource, setBrowseSource] = useState<'cache' | 'history' | 'unsaved'>('cache');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<Theme>(() => { try { return { ...defaultTheme, ...JSON.parse(localStorage.getItem('memreader-theme') || '{}') }; } catch { return defaultTheme; } });
  const [themeOpen, setThemeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [sortAsc, setSortAsc] = useState(false);
  const themeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const softwareRequest = useRef(0);
  const helpDialog = useRef<HTMLElement>(null);
  const snapshotRequest = useRef(0);
  const comparisonRequest = useRef(0);
  const startupRestoreTried = useRef(false);
  const navigationRequest = useRef(0);
  const operationBusy = busy || Boolean(measuring) || restoring;
  const availableSnapshots = useMemo(()=>[...(demo?demoSnapshots:savedSnapshots)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),[demo,savedSnapshots]);

  useEffect(() => {
    mounted.current = true;
    if (window.memreader) {
      window.memreader.getDrives().then(data => { if (!mounted.current) return; setDrives(data); if (data[0]) setSelectedDrive(previous=>data.some(d=>d.path.toLowerCase()===previous.toLowerCase())?previous:data[0].path); }).catch(e => setError(`读取磁盘失败：${e.message}`));
      window.memreader.getTheme().then(data => { if (data && mounted.current) setTheme({ ...defaultTheme, ...data }); }).catch(() => {});
      void refreshSnapshots();
      void refreshDriveCaches();
      const unsubscribe = window.memreader.onScanProgress(p => setProgress(p));
      return () => { mounted.current = false; unsubscribe(); };
    }
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme.mode;
    document.documentElement.dataset.motion = theme.motion ? 'on' : 'off';
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.style.setProperty('--accent-soft', `${theme.accent}1c`);
    document.documentElement.style.setProperty('--accent-text', accentForeground(theme.accent));
    const channels = [1,3,5].map(i=>parseInt(theme.accent.slice(i,i+2),16));
    const luminance = (values:number[]) => values.map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
    const surfaceLuminance = theme.mode==='dark' ? luminance([35,31,45]) : luminance([245,243,250]);
    let inkChannels = channels;
    for(let blend=0;blend<=1;blend+=.04) {
      const target = theme.mode==='dark'?245:35;
      inkChannels=channels.map(c=>Math.round(c*(1-blend)+target*blend));
      const l=luminance(inkChannels);
      if ((Math.max(l,surfaceLuminance)+.05)/(Math.min(l,surfaceLuminance)+.05)>=4.5) break;
    }
    document.documentElement.style.setProperty('--accent-ink', '#'+inkChannels.map(c=>c.toString(16).padStart(2,'0')).join(''));
    document.documentElement.style.setProperty('--glass-opacity', String(theme.glass));
    if (themeTimer.current) clearTimeout(themeTimer.current);
    themeTimer.current = setTimeout(() => {
      try { localStorage.setItem('memreader-theme', JSON.stringify(theme)); } catch { setToast('浏览器主题存储空间不足；桌面版仍会保存主题'); }
      window.memreader?.saveTheme(theme).catch(e => setToast(`主题保存失败：${e.message}`));
    }, 400);
    return () => { if (themeTimer.current) clearTimeout(themeTimer.current); };
  }, [theme]);
  useEffect(() => { if (!toast) return; const t = setTimeout(()=>setToast(''),4500); return ()=>clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (mode !== 'software' || demo || softwareLoaded || loadingSoftware || !window.memreader) return;
    const request = ++softwareRequest.current;
    setLoadingSoftware(true); setError('');
    window.memreader.getSoftware().then(data => { if (mounted.current && request === softwareRequest.current) { setSoftware(data); setSoftwareLoaded(true); } }).catch(e => { if (mounted.current && request === softwareRequest.current) { setSoftwareLoaded(true); setError(`读取软件列表失败：${e.message}`); } }).finally(()=>{ if (mounted.current && request === softwareRequest.current) setLoadingSoftware(false); });
  }, [mode, demo, softwareLoaded, loadingSoftware]);
  useEffect(() => {
    if (!availableSnapshots.length) { setCurrentSnapshotId(''); setBaselineId(''); setComparison(null); return; }
    if (!availableSnapshots.some(s=>s.id===currentSnapshotId)) {
      const latest = availableSnapshots.find(s=>s.rootPath.toLowerCase()===selectedDrive.toLowerCase()) || availableSnapshots[0];
      chooseComparison(latest.id);
    }
  }, [availableSnapshots, currentSnapshotId, selectedDrive]);
  useEffect(() => {
    if (mode==='changes') void runComparison();
    return ()=>{comparisonRequest.current++;};
  }, [mode,baselineId,currentSnapshotId,demo]);
  useEffect(() => {
    if(!native||demo||snapshotLoading||startupRestoreTried.current||operationBusy)return;
    startupRestoreTried.current=true;
    if(!result&&savedSnapshots.length) {
      const latest=[...savedSnapshots].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
      const root=/^[a-z]:[\\/]/i.test(latest.rootPath)?latest.rootPath.slice(0,2)+'\\':selectedDrive;
      void openCachedPath(root);
    }
  },[snapshotLoading,savedSnapshots,demo,operationBusy]);
  useEffect(() => {
    if (!helpOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = helpDialog.current;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setHelpOpen(false); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, [tabindex="0"]')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, [helpOpen]);

  const current = trail[trail.length-1] || result?.root;
  const folderRows = useMemo(() => (current?.children || []).filter(n => n.name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sortAsc?a.size-b.size:b.size-a.size),[current,query,sortAsc]);
  const appRows = useMemo(() => software.filter(a => `${a.name} ${a.publisher}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sortAsc?a.size-b.size:b.size-a.size),[software,query,sortAsc]);
  const rows = mode === 'software' ? appRows : folderRows;
  const previewDrive = demo ? demoDrives.find(d=>normalizeCachePath(d.path)===normalizeCachePath(current?.path||'')) : cachedDirectory?.drive || availableSnapshots.find(s=>s.id===result?.snapshotId)?.drive;
  const diskPreview = useMemo(()=>storagePreview(current,folderRows,previewDrive,Boolean(query)),[current,folderRows,previewDrive,query]);
  const items = useMemo<ChartItem[]>(() => {
    if (mode === 'software') return appRows.filter(a=>a.size>0).map((a,i)=>({id:a.id,label:a.name,value:a.size,color:palette[i%palette.length],detail:a.sizeSource==='measured'?'目录实测':'系统估算'}));
    return diskPreview.items;
  },[mode,appRows,diskPreview]);
  const total = items.reduce((s,n)=>s+n.value,0);
  const selectedFolder = mode === 'folders' ? folderRows.find(n=>n.path===selectedId) : undefined;
  const selectedApp = mode === 'software' ? appRows.find(a=>a.id===selectedId) : undefined;
  const selectedOmitted = mode === 'folders' && selectedId === '__omitted' && !query && Boolean(current?.omittedSize);
  const selectedSpace = mode === 'folders' ? items.find(item=>item.id===selectedId&&(item.kind==='unattributed'||item.kind==='free')) : undefined;
  const switchMode = (next: Mode) => { if(next!=='folders'&&restoring){navigationRequest.current++;setRestoring(false);}setMode(next); setQuery(''); setSelectedId(null); setError(''); if (next==='history'&&!demo) void refreshSnapshots(); };
  function compatible(a:SnapshotMeta,b:SnapshotMeta) {
    return a.rootPath.replace(/[\\/]+$/,'').toLowerCase()===b.rootPath.replace(/[\\/]+$/,'').toLowerCase() && (!a.drive?.volumeId || !b.drive?.volumeId || a.drive.volumeId===b.drive.volumeId) && (!a.drive||!b.drive||a.drive.total===b.drive.total);
  }
  function chooseComparison(id:string, list=availableSnapshots) {
    const chosen=list.find(s=>s.id===id);
    setCurrentSnapshotId(id); setComparison(null); setComparisonError('');
    const earlier=chosen?list.filter(s=>s.id!==id&&compatible(s,chosen)&&s.createdAt<chosen.createdAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]:undefined;
    setBaselineId(earlier?.id||'');
  }
  async function refreshSnapshots(preferredId?:string) {
    if (!window.memreader) return;
    const request=++snapshotRequest.current; setSnapshotLoading(true);
    try { const data=await window.memreader.listSnapshots(); if (!mounted.current||request!==snapshotRequest.current) return; setSavedSnapshots(data.snapshots); setSnapshotWarnings(data.warnings); if(preferredId) chooseComparison(preferredId,data.snapshots); }
    catch(e) { if(request===snapshotRequest.current) setSnapshotWarnings([`本地记录读取失败：${e instanceof Error?e.message:String(e)}。请刷新重试，现有文件不会被清除。`]); }
    finally {if(request===snapshotRequest.current) setSnapshotLoading(false);}
  }
  async function runComparison(scopePath?:string) {
    const request=++comparisonRequest.current; setComparisonError(''); setComparison(null);
    if(!baselineId||!currentSnapshotId) {setComparisonLoading(false);return;}
    setComparisonLoading(true);
    try {const data=demo?demoComparison(baselineId,currentSnapshotId,scopePath):await window.memreader!.compareSnapshots(baselineId,currentSnapshotId,scopePath);if(request===comparisonRequest.current) setComparison(data);}
    catch(e) {if(request===comparisonRequest.current) setComparisonError(e instanceof Error?e.message:String(e));}
    finally {if(request===comparisonRequest.current) setComparisonLoading(false);}
  }
  async function restoreSavedSnapshot(id:string) {
    if(operationBusy)return;
    const request=++navigationRequest.current;
    setRestoring(true);setError('');
    try {
      const snapshot=demo?demoSnapshots.find(s=>s.id===id):await window.memreader!.getSnapshot(id);
      if(!snapshot)throw new Error('未找到这条扫描记录');
      if(request!==navigationRequest.current)return;
      const data={...snapshot.scan,snapshotId:snapshot.id}; setBrowseSource('history');setCachedDirectory(null);setResult(data);setTrail([data.root]);syncDrive(data.root.path);switchMode('folders');
    } catch(e) {setError(`记录无法打开：${e instanceof Error?e.message:String(e)}`);}
    finally {if(request===navigationRequest.current)setRestoring(false);}
  }
  async function refreshDriveCaches() {
    if(!window.memreader)return;
    try {const data=await window.memreader.listDriveCaches();if(mounted.current)setDriveCaches(data);}
    catch(e){setSnapshotWarnings(w=>[...w,`磁盘目录记忆读取失败：${e instanceof Error?e.message:String(e)}`].slice(-8));}
  }
  function displayCachedDirectory(directory:CachedDirectory) {
    setDemo(false);setBrowseSource('cache');setCachedDirectory(directory);
    setResult(cachedDirectoryResult(directory));setTrail(directory.trail);syncDrive(directory.drivePath);
    setSelectedId(null);setQuery('');setMode('folders');
  }
  async function openCachedPath(path:string, scanMissing=false) {
    if(!window.memreader||operationBusy)return;
    const request=++navigationRequest.current;setRestoring(true);setError('');
    let shouldScan=false;
    try {
      const directory=await window.memreader.getCachedDirectory(path);
      if(request!==navigationRequest.current||!mounted.current)return;
      if(directory) {
        if(scanMissing&&directory.needsScan&&!directory.node.cachePlaceholder) shouldScan=true;
        else displayCachedDirectory(directory);
      } else if(scanMissing) shouldScan=true;
      else {setBrowseSource('cache');setCachedDirectory(null);setResult(null);setTrail([]);syncDrive(path);setSelectedId(null);setQuery('');setMode('folders');}
    } catch(e){if(request===navigationRequest.current){setError(`已保存目录无法打开：${e instanceof Error?e.message:String(e)}。原记录仍然保留，可重试或重新扫描。`);if(cachedDirectory)syncDrive(cachedDirectory.drivePath);else if(result)syncDrive(result.root.path);}}
    finally{if(request===navigationRequest.current)setRestoring(false);}
    if(shouldScan&&request===navigationRequest.current)await scan(path);
  }
  function navigateBreadcrumb(index:number) {
    const target=trail[index];if(!target||operationBusy)return;
    if(!demo&&browseSource==='cache')void openCachedPath(target.path);
    else{setTrail(trail.slice(0,index+1));setSelectedId(null);setQuery('');}
  }
  function showChanges(id?:string) { if(id)chooseComparison(id); switchMode('changes'); }
  async function openSnapshotStorage() {try{await window.memreader?.openSnapshotFolder();}catch(e){setError(String(e));}}
  function resetNativeSoftware() { softwareRequest.current++; setSoftware([]); setSoftwareLoaded(false); setLoadingSoftware(false); }
  function syncDrive(path: string, available = drives) {
    const matched = available.find(d=>path.toLowerCase().startsWith(d.path.toLowerCase()));
    if (matched) setSelectedDrive(matched.path);
    else if (/^[a-z]:[\\/]/i.test(path)) setSelectedDrive(path.slice(0,2).toUpperCase()+'\\');
  }
  function changeDrive(drive: Drive) {
    if (operationBusy) return;
    setSelectedDrive(drive.path); switchMode('folders');
    if (demo) { navigationRequest.current++;setCachedDirectory(null);const sample = demoForDrive(drive.path); setResult(sample); setTrail([sample.root]); }
    else void openCachedPath(drive.path);
  }
  function changeQuery(value: string) { setQuery(value); setSelectedId(null); }
  function selectChartItem(id: string) {
    setSelectedId(id);
  }

  async function scan(path: string) {
    if (!window.memreader || operationBusy) return;
    if (demo) resetNativeSoftware();
    const previous={result,trail,cachedDirectory,browseSource,demo};
    const request=++navigationRequest.current;
    setBusy(true); setCancelling(false); setProgress(null); setError(''); setDemo(false);if(demo){setResult(null);setTrail([]);setCachedDirectory(null);}setMode('folders'); setSelectedId(null); setQuery('');
    try {
      const data = await window.memreader.scanFolder(path);
      if(request!==navigationRequest.current)return;
      if(data.cancelled&&previous.result&&!previous.demo) {
        setResult(previous.result);setTrail(previous.trail);setCachedDirectory(previous.cachedDirectory);setBrowseSource(previous.browseSource);
      } else if(!data.cancelled&&data.snapshotId) {
        let directory:CachedDirectory|null=null;
        try{directory=await window.memreader.getCachedDirectory(path);}
        catch(e){setSnapshotWarnings(w=>[...w,`扫描已保存，但目录记忆暂时无法打开：${e instanceof Error?e.message:String(e)}`].slice(-8));}
        if(request!==navigationRequest.current)return;
        if(directory)displayCachedDirectory(directory);
        else{setResult(data);setTrail([data.root]);setCachedDirectory(null);setBrowseSource('unsaved');syncDrive(data.root.path);}
      } else {setResult(data);setTrail([data.root]);setCachedDirectory(null);setBrowseSource('unsaved');syncDrive(data.root.path);}
      setToast(data.cancelled ? previous.result&&!previous.demo?'扫描已停止，继续显示原来的目录记忆':'扫描已停止，显示部分结果；已有快照保持不变' : `扫描完成 · ${formatCount(data.root.files)} 个文件${data.snapshotId?' · 记录已保存':''}`);
      if(data.snapshotWarning) setSnapshotWarnings([data.snapshotWarning]);
      if(data.snapshotId) await refreshSnapshots(data.snapshotId);
      if(data.snapshotId) await refreshDriveCaches();
      const displayedPath=data.cancelled&&previous.result&&!previous.demo?previous.trail.at(-1)?.path||previous.result.root.path:data.root.path;
      try { const dataDrives = await window.memreader.getDrives(); setDrives(dataDrives); syncDrive(displayedPath, dataDrives); }
      catch(e) { setError(`扫描完成，但磁盘概览刷新失败：${e instanceof Error ? e.message : String(e)}`); }
    } catch(e) { setError(`扫描失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); setCancelling(false); }
  }
  async function chooseFolder() {
    if (operationBusy) return;
    if (!window.memreader) { setToast('请启动桌面版，即可选择本机文件夹并扫描'); return; }
    try { const path = await window.memreader.chooseFolder(); if (path) void scan(path); } catch(e) { setError(String(e)); }
  }
  function showDemo() { if (operationBusy) return;navigationRequest.current++;setCachedDirectory(null); softwareRequest.current++; setLoadingSoftware(false); setDemo(true); setResult(demoResult); setTrail([demoResult.root]); setSoftware(demoSoftware); setSoftwareLoaded(true); setSelectedDrive('C:\\'); setQuery(''); setSelectedId(null); }
  function leaveDemo() { if (operationBusy) return; setDemo(false); setResult(null); setTrail([]);setCachedDirectory(null); resetNativeSoftware(); setQuery(''); setSelectedId(null); if (drives[0]) {setSelectedDrive(drives[0].path);void openCachedPath(drives[0].path);} }
  function drill(node: DiskNode) {
    if (node.isFile || operationBusy) return;
    if(!demo&&browseSource==='cache'){void openCachedPath(node.path,true);return;}
    if (directoryHasRetainedPreview(node)||browseSource==='history') { const found = result ? historicalTrail(result.root,node.path) : null; setTrail(found || [...trail,node]); setQuery(''); setSelectedId(null);if(!directoryHasRetainedPreview(node)&&browseSource==='history')setToast('这份历史记录未保留下级明细。可重新扫描当前文件夹，读取现在的内容。'); }
    else if (native && !demo) void scan(node.path);
    else setToast('示例只展开预设层级；桌面版可以继续扫描该文件夹');
  }
  async function measure(app: Software) {
    if (operationBusy) return;
    if (!window.memreader || demo) { setToast('在桌面版使用实际软件列表，才能实测安装目录'); return; }
    setMeasuring(app.id); setCancelling(false); setError('');
    try { const measured = await window.memreader.measureSoftware(app.id); setSoftware(list=>list.map(a=>a.id===app.id?measured:a)); setToast(`${app.name} · 安装目录测量完成`); }
    catch(e) { const message = e instanceof Error ? e.message : String(e); if (message.includes('测量已停止')) setToast('测量已停止，原有大小已保留'); else setError(`无法测量：${message}`); }
    finally { setMeasuring(null); setCancelling(false); }
  }
  async function stopOperation() {
    if (!window.memreader || !operationBusy || cancelling || (busy&&progress?.phase==='saving')) return;
    setCancelling(true);
    try { await window.memreader.cancelScan(); }
    catch(e) { setCancelling(false); setError(`停止失败：${e instanceof Error ? e.message : String(e)}`); }
  }
  async function openPath(path: string) {
    if (demo || !window.memreader) { setToast('示例路径无法打开；请先扫描本机磁盘'); return; }
    try { await window.memreader.openPath(path); } catch(e) { setError(String(e)); }
  }
  async function exportReport() {
    const report = { app:'Memreader', createdAt:new Date().toISOString(), sampleData:demo, perspective:mode, unit:'logical bytes', root:current?.path, scan:mode==='folders'?result:undefined, software:mode==='software'?software:undefined };
    try {
      if (window.memreader) { if (await window.memreader.exportReport(report)) setToast('报告已保存'); }
      else { const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})); const a=document.createElement('a'); a.href=url;a.download='memreader-report.json';a.click();URL.revokeObjectURL(url);setToast('示例报告已导出'); }
    } catch(e) { setError(`导出失败：${String(e)}`); }
  }

  return <div className={`app-shell ${theme.background?'custom-background':''}`} style={theme.background ? {backgroundImage:`url("${theme.background}")`} as CSSProperties : undefined}>
    <aside className="sidebar glass">
      <div className="brand"><BrandMark/><div><strong>Memreader</strong><span>让空间一目了然</span></div></div>
      <div className="sidebar-label">工作空间</div>
      <nav className="main-nav" aria-label="主导航">
        <button className={mode==='folders'?'active':''} onClick={()=>switchMode('folders')}><LayoutDashboard size={19}/>空间总览<span className="nav-active-dot"/></button>
        <button className={mode==='software'?'active':''} onClick={()=>switchMode('software')}><Grid2X2 size={19}/>应用占用</button>
        <button className={mode==='history'?'active':''} onClick={()=>switchMode('history')}><Clock3 size={19}/>扫描记录{availableSnapshots.length>0&&<span className="nav-count">{availableSnapshots.length}</span>}</button>
        <button className={mode==='changes'?'active':''} onClick={()=>showChanges()}><SquareChartGantt size={19}/>空间变化<span className="nav-active-dot"/></button>
      </nav>
      <div className="sidebar-label disks-label">本机磁盘 <span>{demo?demoDrives.length:drives.length}</span></div>
      <div className="disk-nav">{(demo?demoDrives:drives).map(d=><button key={d.path} className={selectedDrive===d.path?'active':''} disabled={operationBusy} onClick={()=>changeDrive(d)}><HardDrive size={17}/><span className="disk-nav-label">本地磁盘 {d.path.slice(0,2)}{!demo&&<DriveCacheBadge info={driveCaches.find(info=>normalizeCachePath(info.path)===normalizeCachePath(d.path))||{path:d.path,hasCache:false,rootSnapshotId:null,updatedAt:null,partial:false}}/>}</span><i className={d.used/d.total>.85?'full':''}/></button>)}</div>
      <div className="sidebar-bottom">
        <div className="local-card"><span className="local-icon"><ShieldCheck size={19}/></span><strong>你的数据，留在本机</strong><p>本地扫描 · 无需上传文件</p></div>
        <button className="theme-shortcut" onClick={()=>setThemeOpen(true)}><Palette size={18}/><span>个性化外观</span><Settings2 size={16}/></button>
        <div className="sidebar-footer"><span className="online-dot"/> MEMREADER <small>v0.4.0</small></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar glass"><div className="topbar-crumb"><span>工作空间</span><ChevronRight size={14}/><strong>{mode==='folders'?'空间总览':mode==='software'?'应用占用':mode==='changes'?'空间变化':'扫描记录'}</strong></div><div className="topbar-actions">{demo ? <span className="preview-badge"><span/>{native?'示例数据':'浏览器预览 · 示例数据'}</span> : <span className="device-badge"><Monitor size={14}/>本地设备</span>}<button className="icon-button" title="使用说明" aria-label="使用说明" onClick={()=>setHelpOpen(true)}><CircleHelp size={18}/></button><button className="icon-button" title="个性化外观" aria-label="个性化外观" onClick={()=>setThemeOpen(true)}><Palette size={18}/></button>{native&&<div className="window-controls"><button aria-label="最小化" onClick={()=>window.memreader?.windowAction('minimize')}><Minus size={15}/></button><button aria-label="最大化或还原" onClick={()=>window.memreader?.windowAction('maximize')}><Maximize2 size={13}/></button><button className="window-close" aria-label="关闭" onClick={()=>window.memreader?.windowAction('close')}><X size={17}/></button></div>}</div></header>
      <main className="workspace">
        <section className="page-heading"><div><div className="eyebrow"><span/> A LITTLE CLARITY, A LOT OF SPACE</div><h1>{mode==='folders'?'空间，清晰可见。':mode==='software'?'每个应用，都有分寸。':mode==='changes'?'空间的变化，有迹可循。':'每次探索，都有迹可循。'}</h1><p>{mode==='folders'?'从一整个磁盘，到一个小文件夹。发现空间里的每一处细节。':mode==='software'?'换个角度看空间，了解已安装应用的存储占用。':mode==='changes'?'对比两次扫描，看看哪些文件夹让可用空间变少了。':'扫描结果长期保存在本机，重启后仍可打开、继续探索和对比。'}</p></div><OrbitIllustration/></section>
        {demo&&native&&<div className="notice demo-notice"><Sparkles size={16}/><span>正在体验示例数据，扫描本机后将显示真实结果。</span><button disabled={operationBusy} onClick={leaveDemo}>退出示例<X size={14}/></button></div>}
        {error&&<div className="notice error-notice" role="alert"><CircleHelp size={17}/><span>{error}</span><button aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}
        {measuring&&<div className="notice demo-notice" role="status"><LoaderCircle size={16} className="spin"/><span>{cancelling ? '正在停止安装目录测量…' : `正在测量 ${software.find(a=>a.id===measuring)?.name || '安装目录'}，扫描结果会更新应用大小。`}</span><button disabled={cancelling} onClick={stopOperation}><Square size={12}/>{cancelling?'停止中…':'停止测量'}</button></div>}
        {busy&&mode!=='folders'&&<div className="notice demo-notice snapshot-operation-banner" role="status"><LoaderCircle size={16} className="spin"/><span>{progress?.phase==='saving'?'扫描已完成，正在保存 JSON 快照…':cancelling?'正在停止扫描…':`后台扫描中 · ${formatCount(progress?.files||0)} 个文件 · ${formatBytes(progress?.bytes||0)}`}</span><button disabled={cancelling||progress?.phase==='saving'} onClick={stopOperation}><Square size={12}/>{progress?.phase==='saving'?'保存中':'停止扫描'}</button></div>}
        {mode==='changes'?<ChangesPanel snapshots={availableSnapshots} comparison={comparison} baselineId={baselineId} currentId={currentSnapshotId} onBaselineChange={id=>{setBaselineId(id);setComparison(null);}} onCurrentChange={chooseComparison} onCompare={()=>void runComparison()} onScopeChange={path=>void runComparison(path)} onOpenPath={openPath} onScan={()=>{const target=availableSnapshots.find(s=>s.id===currentSnapshotId)?.rootPath||selectedDrive; if(native)void scan(target);else setToast('请在桌面版扫描真实磁盘；此处为变化示例');}} loading={comparisonLoading||snapshotLoading} busy={operationBusy} error={comparisonError||(!demo?snapshotWarnings.join('；'):undefined)} sample={demo}/>:mode==='history'?<SnapshotHistory snapshots={availableSnapshots} loading={!demo&&snapshotLoading} busy={operationBusy} sample={demo} warnings={demo?[]:snapshotWarnings} onRefresh={()=>void refreshSnapshots()} onOpen={id=>void restoreSavedSnapshot(id)} onCompare={showChanges} onScan={path=>native?void scan(path||selectedDrive):setToast('请在桌面版扫描真实磁盘')} onOpenStorage={()=>void openSnapshotStorage()}/>:<>
          {mode==='folders'&&!demo&&(browseSource!=='unsaved'||restoring)&&<DiskMemoryInfo directory={cachedDirectory} loading={restoring} historical={browseSource==='history'} onRescan={()=>void scan(current?.path||selectedDrive)} busy={operationBusy}/>}
          {mode==='folders'&&!demo&&browseSource==='unsaved'&&result&&<div className="notice demo-notice"><CircleHelp size={16}/><span>{result.cancelled?'此为未完成的临时结果，已保存的磁盘目录保持不变。':result.snapshotWarning||'扫描结果已读取，但磁盘目录记忆暂时无法打开。可稍后从本机磁盘重试。'}</span></div>}
          {mode==='folders'&&<div className="drives-row">{(demo?demoDrives:drives).map(d=><DriveCard key={d.path} drive={d} active={selectedDrive===d.path} disabled={operationBusy} onClick={()=>changeDrive(d)}/>)}{!(demo?demoDrives:drives).length&&<div className="drive-loading glass"><LoaderCircle size={20} className="spin"/> 正在读取本机磁盘…</div>}<div className="scan-card glass"><div className="scan-card-top"><span className="scan-icon"><Disc3 size={21}/></span><div><strong>发现更多空间</strong><small>完整扫描，细致到文件夹</small></div></div><div className="scan-buttons"><button className="primary-button" disabled={operationBusy||(!demo&&!selectedDrive)} onClick={()=>native?scan(selectedDrive):setToast('此处是浏览器预览，请运行桌面版进行真实扫描')}>{busy?<LoaderCircle size={16} className="spin"/>:<RefreshCw size={15}/>} {busy?'正在扫描…':'扫描此磁盘'}</button><button className="icon-button outlined" aria-label="选择文件夹扫描" title="选择文件夹扫描" disabled={operationBusy} onClick={chooseFolder}><FolderOpen size={18}/></button></div></div></div>}
          {mode==='software'&&<div className="software-summary glass"><div className="software-summary-icon"><Grid2X2 size={25}/></div><div><strong>{softwareLoaded?`${software.length} 个已安装应用`:'正在发现你的应用'}</strong><p>系统估算来自安装信息，选择应用可单独测量安装目录。</p></div><button className="secondary-button" disabled={loadingSoftware||Boolean(measuring)||busy} onClick={()=>{if(demo){setToast('示例数据无需刷新');return;}setSoftwareLoaded(false);}}>{loadingSoftware?<LoaderCircle size={16} className="spin"/>:<RefreshCw size={16}/>}刷新应用</button></div>}
          {busy&&<div className="scan-progress glass" role="status"><div className="scan-progress-summary"><LoaderCircle className="spin" size={18}/><strong>{progress?.phase==='saving'?'正在保存扫描记录':cancelling?'正在停止扫描…':'正在读取空间分布'}</strong><span>{formatCount(progress?.files||0)} 个文件 · {formatBytes(progress?.bytes||0)} · 跳过 {progress?.skipped||0} 项</span><button disabled={cancelling||progress?.phase==='saving'} onClick={stopOperation}><Square size={12}/>{progress?.phase==='saving'?'保存中':'停止'}</button></div><div className="indeterminate-bar"><span/></div><div className="scan-current-path" title={progress?.currentPath}>{progress?.currentPath||'准备扫描…'}</div></div>}
          <div className="analysis-layout">
            <section className="chart-panel glass"><div className="chart-toolbar"><div><h2>{mode==='software'?'应用空间分布':'空间分布'} <span className="tiny-badge">{mode==='software'?'应用视角':'文件夹视角'}</span></h2><p>{mode==='software'?'按已知大小展示应用，未知大小不计入图表':diskPreview.wholeDrive?'彩色为已读取文件 · 灰色为未归属占用 · 白色为可用空间':'单击查看详情，双击文件夹进入。'}</p></div><div className="view-switch" role="group" aria-label="图表视图"><button className={view==='treemap'?'active':''} aria-pressed={view==='treemap'} onClick={()=>setView('treemap')} aria-label="方格图" title="方格图"><Grid2X2 size={16}/><span>方格</span></button><button className={view==='donut'?'active':''} aria-pressed={view==='donut'} onClick={()=>setView('donut')} aria-label="饼状图" title="饼状图"><PieChart size={16}/><span>饼图</span></button><button className={view==='bar'?'active':''} aria-pressed={view==='bar'} onClick={()=>setView('bar')} aria-label="条形图" title="条形图"><SquareChartGantt size={16}/><span>条形</span></button></div></div>
              <div className="chart-breadcrumb"><span className="breadcrumb-icon">{mode==='software'?<Grid2X2 size={14}/>:<Folder size={14}/>}</span>{mode==='folders'&&trail.length?trail.map((n,i)=><span key={n.path}><button className={i===trail.length-1?'current':''} onClick={()=>navigateBreadcrumb(i)}>{i===0?n.path:n.name}</button>{i<trail.length-1&&<ChevronRight size={12}/>}</span>):<span>{mode==='software'?'已安装应用':selectedDrive+' 等待扫描'}</span>}<span className="chart-total">{current?.cachePlaceholder?'未扫描容量':formatBytes(total)}<small>{current?.cachePlaceholder?'目录入口':mode==='folders'&&diskPreview.wholeDrive?'磁盘容量':'已统计'}</small></span></div>
              {mode==='folders'&&current?.cachePlaceholder?<div className="cached-directory-shell"><div className="cached-shell-heading"><FolderOpen size={27}/><h3>从已保存的目录继续浏览</h3><p>这里尚未扫描完整容量。已记住的下级目录可以直接打开；扫描整盘后会统一建立分布图。</p></div><div className="cached-directory-links">{folderRows.map(node=><button key={node.path} disabled={operationBusy} onClick={()=>drill(node)}><Folder size={21}/><span>{node.name}<small>打开已保存的下级目录</small></span><ChevronRight size={17}/></button>)}</div></div>:(mode==='folders'&&!current)||loadingSoftware?<div className="empty-chart"><div className="empty-art"><HardDrive size={45}/><span className="empty-art-spark">✦</span></div><h3>{loadingSoftware?'正在读取已安装应用…':'看见空间，从一次扫描开始'}</h3><p>{loadingSoftware?'读取本机的应用安装信息，请稍候。':'选择磁盘或文件夹，让占用情况变得一目了然。'}</p>{!loadingSoftware&&<div><button className="primary-button" disabled={operationBusy} onClick={chooseFolder}><FolderOpen size={16}/>选择文件夹</button><button className="text-button" disabled={operationBusy} onClick={showDemo}>体验示例<ArrowUpRight size={14}/></button></div>}</div>:items.length?<SpaceChart items={items} view={view} selectedId={selectedId} onSelect={selectChartItem} onOpenItem={mode==='folders'?id=>{const node=current?.children?.find(n=>n.path===id);if(node&&!node.isFile)drill(node);}:undefined} total={total} busy={busy}/>:<div className="empty-chart"><Search size={32}/><h3>{query?'没有匹配的结果':browseSource==='history'&&current&&!directoryHasRetainedPreview(current)?'历史记录未保留下级明细':'暂无可绘制的大小数据'}</h3><p>{mode==='software'?'可以在下方选择应用，测量安装目录。':browseSource==='history'&&current&&!directoryHasRetainedPreview(current)?'可重新扫描当前文件夹，读取现在的内容并保存到本机磁盘。':'当前目录为空，或其中的文件无法读取。'}</p></div>}
              {mode==='folders'&&diskPreview.wholeDrive&&<div className="storage-preview-key"><span><i className="readable-swatch"/>已读取 {formatBytes(diskPreview.scannedTotal)}</span><button onClick={()=>setSelectedId('__unattributed')} disabled={!diskPreview.unattributed}><i className="unattributed-swatch"/>未归属 {formatBytes(diskPreview.unattributed)} <small>估算</small></button><button onClick={()=>setSelectedId('__free_space')} disabled={!diskPreview.free}><i className="free-swatch"/>可用 {formatBytes(diskPreview.free)}</button></div>}
              {mode==='folders'&&diskPreview.logicalMismatch&&<div className="notice demo-notice bounded-notice"><CircleHelp size={14}/><span>文件逻辑大小超过磁盘实际已用容量（压缩、硬链接等可能造成差异），当前按文件大小展示，不估算未归属空间。</span></div>}
              {mode==='folders'&&Boolean(current?.childrenTruncated)&&<div className="notice demo-notice bounded-notice"><CircleHelp size={14}/><span>{query ? `搜索仅覆盖当前保留的 ${formatCount(current?.children?.length || 0)} 项明细，其他 ${formatCount(current?.childrenTruncated || 0)} 项尚未参与搜索。清空搜索可恢复完整容量合计。` : `本层保留 ${formatCount(current?.children?.length || 0)} 项明细，其余 ${formatCount(current?.childrenTruncated || 0)} 项共 ${formatBytes(current?.omittedSize || 0)} 已计入图表。${current?.directoryScanned?'文件明细合并展示，已扫描目录可直接进入。':'旧记录未保留全部下级明细，完整重扫后可补齐。'}`}</span></div>}
              <div className="chart-footer"><span><span className="status-dot"/>{demo?'示例结果':busy?'扫描进行中':current?.cachePlaceholder?'已保存子目录':browseSource==='history'?'历史快照':result?.cancelled?'部分扫描结果':result?'已保存目录':'准备就绪'}</span><span>{mode==='folders'?current?.cachePlaceholder?`${current.children?.length||0} 个已保存路径入口`:`${formatCount(current?.files||0)} 个文件 · ${formatCount(current?.folders||0)} 个文件夹`:`${appRows.filter(a=>a.size>0).length} 个应用有大小数据`}</span>{result?.skipped&&mode==='folders'?<span>跳过 {formatCount(result.skipped)} 项</span>:null}</div>
            </section>
            <aside className="detail-panel glass"><div className="detail-heading"><span>空间详情</span><span className="detail-spark">✦</span></div>{selectedSpace?<><div className={`detail-icon space-detail-${selectedSpace.kind}`}><HardDrive size={28}/></div><h3>{selectedSpace.label}</h3><p className="detail-path">{current?.path} · 扫描时的磁盘状态</p><div className="detail-size">{formatBytes(selectedSpace.value)}</div><div className="detail-ratio">占磁盘容量 {total?(selectedSpace.value/total*100).toFixed(1):0}%</div><div className="detail-tip"><CircleHelp size={16}/><p>{selectedSpace.detail}</p></div>{selectedSpace.kind==='unattributed'&&<div className="residual-equation"><span>系统报告的已用空间<b>{formatBytes(diskPreview.scannedTotal+diskPreview.unattributed)}</b></span><span>− 已读取文件<b>{formatBytes(diskPreview.scannedTotal)}</b></span><span>= 未归属占用<b>{formatBytes(diskPreview.unattributed)}</b></span></div>}</>:selectedOmitted?<><div className="detail-icon"><Layers3 size={28}/></div><h3>{current?.directoryScanned?'其他已扫描文件':`其余 ${formatCount(current?.childrenTruncated || 0)} 项`}</h3><p className="detail-path">{current?.path}</p><div className="detail-size">{formatBytes(current?.omittedSize || 0)}</div><div className="detail-ratio">占当前显示空间 {total?((current?.omittedSize || 0)/total*100).toFixed(1):0}%</div><div className="detail-properties"><div><span>明细状态</span><strong>已合并展示</strong></div><div><span>数据统计</span><strong>容量已完整计入</strong></div></div><div className="detail-tip"><CircleHelp size={16}/><p>为保持扫描流畅，{current?.directoryScanned?'部分文件明细合并展示，容量仍已统计。已扫描的文件夹可直接进入。':'旧记录未保留全部下级明细。用新版完整扫描一次后，可直接进入已扫描目录。'}</p></div></>:selectedFolder||selectedApp?<><div className="detail-icon"><Folder size={28}/></div><h3>{selectedFolder?.name||selectedApp?.name}</h3><p className="detail-path" title={selectedFolder?.path||selectedApp?.installLocation}>{selectedFolder?.path||selectedApp?.installLocation||'未提供安装目录'}</p><div className="detail-size">{selectedFolder?.cachePlaceholder?'未扫描':selectedFolder?.inaccessible&&!selectedFolder.size?'大小未知':formatBytes(selectedFolder?.size||selectedApp?.size||0)}</div><div className="detail-ratio">占当前已统计空间 {total?((selectedFolder?.size||selectedApp?.size||0)/total*100).toFixed(1):0}%</div><div className="detail-meter"><span style={{width:`${Math.min(100,total?(selectedFolder?.size||selectedApp?.size||0)/total*100:0)}%`}}/></div><div className="detail-properties">{selectedFolder?<><div><span>文件数</span><strong>{formatCount(selectedFolder.files)}</strong></div><div><span>文件夹数</span><strong>{formatCount(selectedFolder.folders)}</strong></div><div><span>类型</span><strong>{selectedFolder.isFile?'文件':'文件夹'}</strong></div></>:<><div><span>数据来源</span><strong>{selectedApp?.sizeSource==='measured'?'目录实测':selectedApp?.sizeSource==='estimated'?'系统估算':'未知'}</strong></div><div><span>发布者</span><strong>{selectedApp?.publisher||'未知'}</strong></div><div><span>版本</span><strong>{selectedApp?.version||'未知'}</strong></div></>}</div><div className="detail-actions">{selectedFolder&&!selectedFolder.isFile&&<button className="primary-button" disabled={operationBusy} onClick={()=>drill(selectedFolder)}>进入文件夹<ArrowRight size={15}/></button>}{selectedApp&&<button className="primary-button" disabled={Boolean(measuring)||busy||!selectedApp.installLocation} onClick={()=>measure(selectedApp)}>{measuring===selectedApp.id?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}测量安装目录</button>}<button className="secondary-button" disabled={!selectedFolder?.path&&!selectedApp?.installLocation} onClick={()=>openPath(selectedFolder?.path||selectedApp?.installLocation||'')}><FolderOpen size={15}/>在资源管理器中打开</button></div></>:<><div className="detail-icon"><HardDrive size={28}/></div><h3>{mode==='software'?'应用占用概览':current?.name||'你的本地空间'}</h3><p className="detail-path">{mode==='software'?'让每一份空间，都有来处':current?.path||'等待开始探索'}</p><div className="detail-size">{current?.cachePlaceholder?'未扫描':formatBytes(total)}</div><div className="detail-ratio">{mode==='software'?'已知应用大小合计（可能重叠）':current?.cachePlaceholder?'目录入口尚未统计容量':diskPreview.wholeDrive?'磁盘容量（含可用空间）':'当前层级已读取文件大小'}</div><div className="detail-properties"><div><span>{mode==='software'?'已安装应用':'本层项目'}</span><strong>{mode==='software'?software.length:current?.children?.length||0}</strong></div><div><span>{mode==='software'?'未知大小':'扫描耗时'}</span><strong>{mode==='software'?`${software.filter(a=>!a.size).length} 个`:`${((result?.elapsedMs||0)/1000).toFixed(1)} 秒`}</strong></div></div><div className="detail-tip"><Sparkles size={16}/><p>点选图表中的{view==='treemap'?'任意方格':'项目'}，看看它的空间故事。</p></div></>}<div className="detail-footnote"><ShieldCheck size={13}/><span>{mode==='software'?'应用数据与缓存可能位于其他目录':'只读扫描，不修改你的文件'}</span></div></aside>
          </div>
          <section className="list-panel glass"><div className="list-toolbar"><div><h2>{mode==='software'?'应用列表':'占用明细'} <span className="list-count">{rows.length}</span></h2></div><div className="list-tools"><label className="search-box"><Search size={15}/><input value={query} onChange={e=>changeQuery(e.target.value)} placeholder={mode==='software'?'搜索应用或发布者…':'搜索当前文件夹…'} aria-label={mode==='software'?'搜索应用':'搜索文件夹'}/>{query&&<button aria-label="清空搜索" onClick={()=>changeQuery('')}><X size={13}/></button>}</label><button className="icon-button outlined" title="导出 JSON 报告" aria-label="导出报告" disabled={busy||(!result&&mode==='folders')} onClick={exportReport}><Download size={17}/></button></div></div><div className="table-scroll"><table><thead><tr><th>{mode==='software'?'应用名称':'名称'}</th><th><button onClick={()=>setSortAsc(!sortAsc)}>占用空间{sortAsc?<ArrowUpRight size={12}/>:<ArrowDown size={12}/>}</button></th><th>{mode==='software'?'来源':'文件数'}</th><th>{mode==='software'?'发布者':'空间占比'}</th><th className="action-column">操作</th></tr></thead><tbody>{mode==='software'?appRows.map((a,i)=><tr key={a.id} className={selectedId===a.id?'selected':''}><td><button className="name-cell" onClick={()=>setSelectedId(a.id)}><span className="file-chip" style={{background:`${palette[i%palette.length]}26`,color:palette[i%palette.length]}}><Grid2X2 size={17}/></span><span><strong>{a.name}</strong><small>{a.version||'未知版本'}{a.shared?' · 共享目录':''}</small></span></button></td><td className="size-cell">{a.size?formatBytes(a.size):'未知'}</td><td><span className={`source-badge ${a.sizeSource}`}>{a.sizeSource==='measured'?'目录实测':a.sizeSource==='estimated'?'系统估算':'待测量'}</span></td><td className="muted-cell">{a.publisher||'未知'}</td><td><button className="row-action" disabled={Boolean(measuring)||busy||!a.installLocation} onClick={()=>measure(a)}>{measuring===a.id?<LoaderCircle size={14} className="spin"/>:<RefreshCw size={14}/>}测量</button></td></tr>):folderRows.map((n,i)=><tr key={n.path} className={selectedId===n.path?'selected':''}><td><button className="name-cell" onClick={()=>n.cachePlaceholder?drill(n):setSelectedId(n.path)} onDoubleClick={()=>drill(n)}><span className="file-chip" style={{background:`${palette[i%palette.length]}26`,color:palette[i%palette.length]}}>{n.isFile?<Square size={16}/>:<Folder size={17}/>}</span><span><strong>{n.name}</strong><small>{n.cachePlaceholder?'已保存子目录入口':n.inaccessible?'部分内容无法访问':n.isFile?'文件':`${formatCount(n.folders)} 个文件夹`}</small></span></button></td><td className="size-cell">{n.cachePlaceholder?'未扫描':n.inaccessible&&!n.size?'无法读取':formatBytes(n.size)}</td><td className="muted-cell">{n.cachePlaceholder?'—':formatCount(n.files)}</td><td><div className="table-ratio"><span className="table-ratio-track"><span style={{width:`${total?n.size/total*100:0}%`,background:palette[i%palette.length]}}/></span><span>{n.cachePlaceholder?'—':`${total?(n.size/total*100).toFixed(1):0}%`}</span></div></td><td><button className="row-action" disabled={operationBusy} onClick={()=>n.isFile?openPath(n.path):drill(n)}>{n.isFile?'打开':'查看'}<ArrowUpRight size={14}/></button></td></tr>)}</tbody></table>{!rows.length&&<div className="table-empty">{query?'没有符合搜索条件的项目':'完成扫描或加载应用后，明细会显示在这里'}</div>}</div></section>
          <div className="workspace-footnote"><span><ShieldCheck size={13}/>文件夹统计为逻辑文件大小，可能与磁盘已用空间不同。受保护目录与链接会跳过。</span>{native&&!demo&&<button className="text-button" disabled={operationBusy} onClick={showDemo}>体验示例<ArrowUpRight size={13}/></button>}{mode==='folders'&&trail.length>1&&<button className="text-button" onClick={()=>navigateBreadcrumb(trail.length-2)}><ArrowLeft size={13}/>返回上一级</button>}</div>
        </>}
      </main>
    </div>
    {themeOpen&&<ThemePanel theme={theme} onChange={setTheme} onClose={()=>setThemeOpen(false)}/>}
    {helpOpen&&<div className="modal-overlay" onClick={()=>setHelpOpen(false)}><section className="help-dialog glass" ref={helpDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e=>e.stopPropagation()}><button className="icon-button modal-close" aria-label="关闭说明" onClick={()=>setHelpOpen(false)}><X size={20}/></button><span className="help-icon"><Sparkles size={25}/></span><h2 id="help-title">和你的空间，好好相处。</h2><p>Memreader 查看的是磁盘存储空间，也就是 C、D 盘保存文件所用的容量。</p><ol><li><strong>选择磁盘或文件夹</strong><span>扫描时可以停止，已读取的数据会作为部分结果保留。</span></li><li><strong>切换图表，逐层探索</strong><span>单击图表看详情，双击文件夹直接进入下一层。完整扫描会自动保存 JSON 快照；在“空间变化”中对比同一路径两次扫描，查看增长与释放，重启后记录仍保留。</span></li><li><strong>换到应用视角</strong><span>应用列表来自 Windows 注册表的安装信息，便携软件和部分商店应用可能不在列表内。系统提供的大小是估算值。目录实测仅统计安装目录，不包含其他位置的数据和缓存；共享目录可能重复计入。</span></li><li><strong>定制自己的外观</strong><span>导入背景、自动取色，或用色轮选择喜欢的颜色。毛玻璃保持文字清晰。</span></li></ol><p className="help-note">磁盘已用空间还包括文件系统、系统保留空间等，因此不会与可读取文件的逻辑大小完全一致。</p><button className="primary-button" onClick={()=>setHelpOpen(false)}>开始探索<ArrowRight size={16}/></button></section></div>}
    {toast&&<div className="toast glass" role="status"><Check size={17}/>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><X size={14}/></button></div>}
  </div>;
}
