import { useMemo, useState } from 'react';
import { ArrowRight, Clock3, FileJson, FolderOpen, GitCompareArrows, HardDrive, LoaderCircle, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import type { SnapshotMeta } from '../types';
import { formatBytes, formatCount } from '../data';
import './SnapshotHistory.css';

interface Props {
  snapshots: SnapshotMeta[]; loading: boolean; busy: boolean; sample: boolean; warnings: string[];
  onRefresh:()=>void; onOpen:(id:string)=>void; onCompare:(id:string)=>void;
  onScan:(path?:string)=>void; onOpenStorage:()=>void;
}
export default function SnapshotHistory({snapshots,loading,busy,sample,warnings,onRefresh,onOpen,onCompare,onScan,onOpenStorage}:Props) {
  const [query,setQuery] = useState('');
  const [scope,setScope] = useState('all');
  const roots = useMemo(()=>[...new Set(snapshots.map(s=>s.rootPath))],[snapshots]);
  const rows = snapshots.filter(s=>(scope==='all'||s.rootPath===scope)&&s.rootPath.toLowerCase().includes(query.toLowerCase()));
  return <section className="snapshot-history">
    <div className="snapshot-storage glass"><span className="snapshot-storage-icon"><FileJson size={25}/></span><div><h2>扫描有记录，变化有依据。</h2><p>{sample?'当前展示示例快照。':'扫描结果以 JSON 文本保存在本机，关闭软件或重启电脑后仍可查看。'}子文件夹扫描不会覆盖整盘记录，停止的扫描不会写入基准。</p></div><button className="secondary-button" onClick={onOpenStorage} disabled={sample}><FolderOpen size={15}/>查看本地记录</button></div>
    {warnings.length>0&&<div className="notice error-notice" role="alert"><ShieldCheck size={17}/><span>{warnings.join('；')}</span><button onClick={onRefresh}>重试</button></div>}
    <div className="snapshot-list glass"><div className="snapshot-toolbar"><h2><Clock3 size={18}/>已保存的扫描 <span>{snapshots.length}</span></h2><div className="snapshot-tools"><label className="search-box"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索扫描路径…" aria-label="搜索扫描记录"/></label><select aria-label="按扫描路径筛选" value={scope} onChange={e=>setScope(e.target.value)}><option value="all">全部路径</option>{roots.map(r=><option key={r} value={r}>{r}</option>)}</select><button className="icon-button outlined" aria-label="刷新扫描记录" title="刷新扫描记录" disabled={loading||busy} onClick={onRefresh}>{loading?<LoaderCircle size={17} className="spin"/>:<RefreshCw size={17}/>}</button></div></div>
    {loading&&!snapshots.length?<div className="snapshot-empty"><LoaderCircle size={30} className="spin"/><p>正在读取本地扫描记录…</p></div>:rows.length?<div className="saved-snapshot-list">{rows.map((s,i)=>{
      const earlier=snapshots.some(other=>other.id!==s.id&&other.rootPath.toLowerCase()===s.rootPath.toLowerCase()&&other.createdAt<s.createdAt);
      return <article key={s.id} className="saved-snapshot-row"><div className="saved-snapshot-icon"><HardDrive size={20}/></div><div className="saved-snapshot-info"><div><strong title={s.rootPath}>{s.rootPath}</strong><span className="snapshot-kind">{s.isDriveRoot?'整盘扫描':'文件夹扫描'}</span>{i===0&&!query&&scope==='all'&&<span className="snapshot-latest">最近</span>}</div><p>{new Date(s.createdAt).toLocaleString('zh-CN',{hour12:false})} · {formatCount(s.files)} 个文件 · {(s.scanElapsedMs/1000).toFixed(1)} 秒</p>{s.incomplete&&<small>包含跳过或无法读取的项目，对比时会标明不确定变化</small>}</div><div className="saved-snapshot-size"><strong>{formatBytes(s.size)}</strong><small>已读取文件大小</small></div><div className="saved-snapshot-actions"><button className="secondary-button" disabled={busy} onClick={()=>onOpen(s.id)}>打开结果<ArrowRight size={13}/></button><button className="secondary-button" disabled={busy||!earlier} title={earlier?'与上一次同路径扫描对比':'还需要一次同路径扫描才能对比'} onClick={()=>onCompare(s.id)}><GitCompareArrows size={14}/>查看变化</button><button className="icon-button" disabled={busy||sample} aria-label={`重新扫描 ${s.rootPath}`} title="再次扫描此路径" onClick={()=>onScan(s.rootPath)}><RefreshCw size={16}/></button></div></article>;
    })}</div>:<div className="snapshot-empty"><FileJson size={38}/><h3>{query?'没有匹配的扫描记录':'第一次扫描，会成为你的空间基准'}</h3><p>{query?'试试其他路径关键词。':'完整扫描后会自动保存到本机。以后再次扫描同一路径，就能知道空间变到了哪里。'}</p>{!query&&<button className="primary-button" disabled={busy} onClick={()=>onScan()}>开始扫描<ArrowRight size={15}/></button>}</div>}
    <div className="snapshot-history-note"><ShieldCheck size={14}/><span>记录不会因重启、切换目录或再次扫描而自动清除。文件只包含路径、大小与时间，不包含文件内容；你可以自行备份 JSON。升级前未保存的临时记录无法追溯。</span></div></div>
  </section>;
}
