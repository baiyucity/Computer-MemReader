import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ImageOff, ImagePlus, LoaderCircle, Moon, Palette, Sparkles, Sun, X } from 'lucide-react';
import type { Theme } from '../types';
import './ThemePanel.css';

type HSV = { h: number; s: number; v: number };
type ThemePanelProps = { theme: Theme; onChange: (theme: Theme) => void; onClose: () => void };

const palettes = [
  { name: '薄荷绿', color: '#77e2ba' }, { name: '湖泊蓝', color: '#72baf4' },
  { name: '鸢尾紫', color: '#b7a3f6' }, { name: '玫瑰粉', color: '#ed98be' },
  { name: '杏子橙', color: '#f3b17d' }, { name: '日光金', color: '#e5ca77' },
];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hsvToHex({ h, s, v }: HSV): string {
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function hexToHsv(hex: string): HSV {
  const value = hex.replace('#', '');
  const rgb = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = delta === 0 ? 0 : max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** Select the text color with the greater WCAG contrast ratio against the accent. */
export function accentForeground(hex: string): '#050505' | '#ffffff' {
  const luminance = (color: string) => {
    const channels = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const accentLuminance = luminance(hex), darkLuminance = luminance('#050505');
  const darkRatio = (accentLuminance + .05) / (darkLuminance + .05);
  const whiteRatio = 1.05 / (accentLuminance + .05);
  return darkRatio >= whiteRatio ? '#050505' : '#ffffff';
}

function imageAccent(canvas: HTMLCanvasElement, mode: Theme['mode']): string {
  const sample = document.createElement('canvas');
  sample.width = 64; sample.height = 64;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return '#77e2ba';
  context.drawImage(canvas, 0, 0, 64, 64);
  const pixels = context.getImageData(0, 0, 64, 64).data;
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, x: 0, y: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const hsv = hexToHsv(`#${[pixels[i], pixels[i + 1], pixels[i + 2]].map(value => value.toString(16).padStart(2, '0')).join('')}`);
    if (hsv.s < .16 || hsv.v < .12 || hsv.v > .97 && hsv.s < .3) continue;
    const weight = hsv.s ** 1.5 * Math.sin(hsv.v * Math.PI / 2);
    const bin = bins[Math.floor(hsv.h / 15) % 24];
    bin.weight += weight;
    bin.x += Math.cos(hsv.h * Math.PI / 180) * weight;
    bin.y += Math.sin(hsv.h * Math.PI / 180) * weight;
  }
  const dominant = bins.reduce((best, bin) => bin.weight > best.weight ? bin : best, bins[0]);
  const h = dominant.weight ? (Math.atan2(dominant.y, dominant.x) * 180 / Math.PI + 360) % 360 : 157;
  return hsvToHex({ h, s: mode === 'dark' ? .48 : .68, v: mode === 'dark' ? .91 : .75 });
}

async function readBackground(file: File): Promise<HTMLCanvasElement> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片超过 12 MB，请选择一张小一些的图片。');
  if (file.size === 0) throw new Error('这张图片是空文件，请重新选择。');
  const url = URL.createObjectURL(file);
  try {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    if (!picture.naturalWidth || !picture.naturalHeight) throw new Error('图片无法读取，请换一张试试。');
    const scale = Math.min(1, 1920 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('暂时无法处理这张图片，请重试。');
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export default function ThemePanel({ theme, onChange, onClose }: ThemePanelProps) {
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(theme.accent));
  const [hexDraft, setHexDraft] = useState(theme.accent);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [processing, setProcessing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const themeRef = useRef(theme);
  const changeRef = useRef(onChange);
  const closeRef = useRef(onClose);
  const mounted = useRef(true);
  themeRef.current = theme; changeRef.current = onChange; closeRef.current = onClose;

  useEffect(() => {
    setHsv(hexToHsv(theme.accent));
    setHexDraft(theme.accent);
  }, [theme.accent]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>('.theme-close')?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])]
        .filter(element => element.getClientRects().length > 0);
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const patch = (values: Partial<Theme>) => onChange({ ...theme, ...values });
  const chooseColor = (value: HSV) => {
    setHsv(value);
    patch({ accent: hsvToHex(value), autoColor: false });
  };
  const wheelPoint = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = wheelRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const h = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360;
    chooseColor({ h, s: clamp(Math.hypot(x, y) / (bounds.width / 2), 0, 1), v: hsv.v });
  };

  const importBackground = async (file: File | undefined) => {
    if (!file) return;
    setProcessing(true); setError(false); setMessage('正在为图片提取配色…');
    try {
      const canvas = await readBackground(file);
      let background = canvas.toDataURL('image/webp', .82);
      if (!background.startsWith('data:image/webp')) background = canvas.toDataURL('image/jpeg', .85);
      if (!mounted.current) return;
      const current = themeRef.current;
      changeRef.current({ ...current, background, accent: current.autoColor ? imageAccent(canvas, current.mode) : current.accent });
      setMessage(current.autoColor ? '背景已导入，已自动提取和谐配色。' : '背景已导入，保留你选择的主题色。');
    } catch (reason) {
      if (!mounted.current) return;
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '图片处理失败，请换一张图片试试。');
    } finally { if (mounted.current) setProcessing(false); }
  };

  const autoColor = async (enabled: boolean) => {
    patch({ autoColor: enabled });
    if (!enabled || !theme.background) return;
    const originalBackground = theme.background;
    try {
      const picture = new Image(); picture.src = originalBackground; await picture.decode();
      if (!mounted.current || !themeRef.current.autoColor || themeRef.current.background !== originalBackground) return;
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      canvas.getContext('2d')?.drawImage(picture, 0, 0, 64, 64);
      changeRef.current({ ...themeRef.current, accent: imageAccent(canvas, themeRef.current.mode) });
    } catch { setError(true); setMessage('暂时无法从当前背景提取配色，可以手动选择主题色。'); }
  };

  const radius = hsv.s * 50;
  const angle = (hsv.h - 90) * Math.PI / 180;
  const customStyle = { '--theme-accent': theme.accent, '--theme-accent-text': accentForeground(theme.accent) } as CSSProperties;

  return createPortal(
    <div className={`theme-overlay theme-${theme.mode}${theme.motion ? '' : ' theme-no-motion'}`} style={customStyle}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="theme-sheet" role="dialog" aria-modal="true" aria-labelledby="theme-title" aria-describedby="theme-description" ref={dialogRef}>
        <header className="theme-header">
          <span className="theme-symbol"><Palette size={20} strokeWidth={1.6} /></span>
          <div><span className="theme-eyebrow">MAKE IT YOURS</span><h2 id="theme-title">你的空间，你的风格</h2></div>
          <button className="theme-close" onClick={onClose} aria-label="关闭主题设置"><X size={20} /></button>
        </header>
        <p className="theme-intro" id="theme-description">让每一次探索，都有喜欢的颜色。所有设置自动保存。</p>
        <div className="theme-content">
          <div className="theme-color-column">
            <div className="theme-preview" style={theme.background ? { backgroundImage: `url("${theme.background}")` } : undefined}>
              <div className="theme-preview-glass" style={{ backgroundColor: theme.mode === 'dark' ? `rgba(35,31,45,${theme.glass})` : `rgba(250,249,253,${theme.glass})` }}>
                <span className="theme-preview-title"><span className="theme-preview-dot" /> MEMREADER</span>
                <svg className="theme-orbits" viewBox="0 0 180 84" fill="none" aria-hidden="true">
                  <ellipse cx="90" cy="42" rx="62" ry="24" stroke="currentColor" strokeWidth=".8" opacity=".28" />
                  <ellipse className="theme-orbit-a" cx="90" cy="42" rx="62" ry="24" transform="rotate(42 90 42)" stroke="currentColor" strokeWidth=".8" opacity=".42" />
                  <ellipse className="theme-orbit-b" cx="90" cy="42" rx="62" ry="24" transform="rotate(-42 90 42)" stroke="currentColor" strokeWidth=".8" opacity=".42" />
                  <circle cx="90" cy="42" r="16" fill="currentColor" opacity=".12" />
                  <path d="M83 43v-9h6v9m2 7V36h6v14m-20 0h27" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <circle className="theme-orbit-spark" cx="150" cy="38" r="3" fill="currentColor" />
                </svg>
                <span className="theme-preview-copy">空间，也可以很美</span>
                <button className="theme-preview-button" tabIndex={-1} aria-hidden="true">开始探索 <Sparkles size={12} /></button>
              </div>
            </div>
            <div className="theme-section-heading"><h3>自定义色轮</h3><span>H {Math.round(hsv.h)}° / S {Math.round(hsv.s * 100)}%</span></div>
            <div className="theme-wheel-shell">
              <div className="theme-wheel" ref={wheelRef} role="slider" tabIndex={0} aria-label="主题色轮，左右键调整色相，上下键调整饱和度"
                aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} aria-valuetext={`色相 ${Math.round(hsv.h)} 度，饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%`}
                style={{ filter: `brightness(${Math.max(.1, hsv.v)})` }}
                onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); wheelPoint(event); }}
                onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) wheelPoint(event); }}
                onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const step = event.shiftKey ? 10 : 2;
                  chooseColor({ h: event.key === 'ArrowLeft' ? (hsv.h - step + 360) % 360 : event.key === 'ArrowRight' ? (hsv.h + step) % 360 : hsv.h,
                    s: event.key === 'ArrowUp' ? clamp(hsv.s + step / 100, 0, 1) : event.key === 'ArrowDown' ? clamp(hsv.s - step / 100, 0, 1) : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : hsv.s, v: hsv.v });
                }}>
                <span className="theme-wheel-marker" style={{ left: `${50 + Math.cos(angle) * radius}%`, top: `${50 + Math.sin(angle) * radius}%`, background: theme.accent }} />
              </div>
            </div>
            <div className="theme-brightness-label"><label htmlFor="theme-brightness">亮度</label><span>{Math.round(hsv.v * 100)}%</span></div>
            <input className="theme-range theme-brightness" id="theme-brightness" type="range" min="5" max="100" value={Math.round(hsv.v * 100)}
              style={{ background: `linear-gradient(90deg, #111, ${hsvToHex({ ...hsv, v: 1 })})` }}
              onChange={event => chooseColor({ ...hsv, v: Number(event.target.value) / 100 })} />
            <div className="theme-hex-row">
              <label className="theme-color-swatch" htmlFor="theme-native-color" style={{ background: theme.accent }} aria-label="打开系统颜色选择器">
                <input id="theme-native-color" type="color" value={theme.accent} onChange={event => patch({ accent: event.target.value, autoColor: false })} aria-label="系统主题色选择器" />
              </label>
              <label className="theme-hex-label" htmlFor="theme-hex">HEX</label>
              <input id="theme-hex" className="theme-hex-input" value={hexDraft} spellCheck={false} maxLength={7} aria-label="主题色十六进制值"
                onChange={event => { const value = event.target.value; setHexDraft(value); if (/^#[\da-f]{6}$/i.test(value)) patch({ accent: value.toLowerCase(), autoColor: false }); }}
                onBlur={() => setHexDraft(theme.accent)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
              <span className="theme-hex-caption">即刻生效</span>
            </div>
          </div>
          <div className="theme-settings-column">
            <section className="theme-section">
              <div className="theme-section-heading"><h3>外观</h3><span>随心切换</span></div>
              <div className="theme-mode-group" role="group" aria-label="外观模式">
                <button className={theme.mode === 'dark' ? 'selected' : ''} aria-pressed={theme.mode === 'dark'} onClick={() => patch({ mode: 'dark' })}><Moon size={16} /> 深色 <span className="theme-mode-check">{theme.mode === 'dark' && <Check size={14} />}</span></button>
                <button className={theme.mode === 'light' ? 'selected' : ''} aria-pressed={theme.mode === 'light'} onClick={() => patch({ mode: 'light' })}><Sun size={16} /> 浅色 <span className="theme-mode-check">{theme.mode === 'light' && <Check size={14} />}</span></button>
              </div>
              <div className="theme-section-heading theme-palette-heading"><h3>灵感配色</h3><span>一个颜色，一种心情</span></div>
              <div className="theme-palettes" role="group" aria-label="预设主题色">{palettes.map(palette => <button key={palette.color} style={{ background: palette.color, color: accentForeground(palette.color) }}
                aria-label={palette.name} title={palette.name} aria-pressed={theme.accent.toLowerCase() === palette.color} onClick={() => patch({ accent: palette.color, autoColor: false })}>{theme.accent.toLowerCase() === palette.color && <Check size={17} />}</button>)}</div>
            </section>
            <section className="theme-section theme-background-section">
              <div className="theme-section-heading"><h3>自己的风景</h3><span>主题背景</span></div>
              <button className={`theme-upload${theme.background ? ' has-background' : ''}`} disabled={processing} onClick={() => fileRef.current?.click()}
                style={theme.background ? { backgroundImage: `linear-gradient(rgba(29,21,47,.66), rgba(29,21,47,.66)), url("${theme.background}")` } : undefined}>
                {processing ? <LoaderCircle className="theme-spinner" size={21} /> : <ImagePlus size={23} strokeWidth={1.4} />}
                <strong>{processing ? '正在处理图片' : theme.background ? '换一张喜欢的背景' : '导入一张喜欢的图片'}</strong>
                <span>PNG · JPG · WebP / 最大 12 MB</span>
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="theme-file-input" tabIndex={-1} aria-hidden="true"
                onChange={event => { void importBackground(event.target.files?.[0]); event.currentTarget.value = ''; }} />
              <div className="theme-background-actions"><span>图片仅保存在这台电脑</span>{theme.background && <button onClick={() => { patch({ background: null }); setMessage('已移除背景图片。'); setError(false); }}><ImageOff size={13} /> 移除背景</button>}</div>
              <label className="theme-toggle-row" htmlFor="theme-auto-color"><span><strong>从背景提取主题色</strong><small>让按钮与图片自然呼应</small></span><input id="theme-auto-color" className="theme-switch" type="checkbox" checked={theme.autoColor} onChange={event => void autoColor(event.target.checked)} /></label>
            </section>
            <section className="theme-section theme-finish-section">
              <div className="theme-glass-heading"><label htmlFor="theme-glass">毛玻璃浓度</label><span>{Math.round(theme.glass * 100)}%</span></div>
              <input className="theme-range theme-glass-range" id="theme-glass" type="range" min="60" max="95" step="1" value={Math.round(theme.glass * 100)} onChange={event => patch({ glass: Number(event.target.value) / 100 })} />
              <div className="theme-range-captions"><span>通透</span><span>清晰</span></div>
              <label className="theme-toggle-row theme-motion-row" htmlFor="theme-motion"><span><strong>柔和的矢量动效</strong><small>跟随系统的减少动态效果设置</small></span><input id="theme-motion" className="theme-switch" type="checkbox" checked={theme.motion} onChange={event => patch({ motion: event.target.checked })} /></label>
            </section>
          </div>
        </div>
        <footer className="theme-footer"><span className={`theme-status${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite">{message || '偏好自动保存，随时都可以回来调整。'}</span><button className="theme-done" onClick={onClose}>完成 <Check size={15} /></button></footer>
      </div>
    </div>, document.body,
  );
}
