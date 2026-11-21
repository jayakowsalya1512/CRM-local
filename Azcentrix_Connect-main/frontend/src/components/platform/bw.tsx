import { Suspense, lazy, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { KpiQuery } from '@/services/platformApi'
import { X } from 'lucide-react'

// Building blocks matching the Bidwise prototype v9 (panel, KPI strip, pill, kv, tabs, switch, note, modal, drawer, stepper).
// Their look lives in the .platform-shell rules of index.css (bw-panel, bw-strip, bw-btn, bw-in, bw-tabs, bw-md …), so light
// and dark both follow the prototype tokens.
// The prototype's icon set (ICO / ic()): single-path 24×24 line icons, 15px, stroke 1.7.
export const ICO = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.5-5 6-5s6 2 6 5M16 5a3 3 0 010 6M17 15c2.5.3 4 2 4 5',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h6M9 17h6', doc: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h3', shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6zM9 12l2 2 4-4',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3', check: 'M4 12l5 5L20 6', folder: 'M3 6h7l2 2h9v11H3z', copy: 'M8 8h12v12H8zM4 16V4h12', plus: 'M12 5v14M5 12h14', scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z', plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0zM12 18v3', layout: 'M4 4h16v16H4zM4 9h16M9 9v11', mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  building: 'M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3', flow: 'M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 013 3v4', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', db: 'M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0zM4 12c0 2 16 2 16 0',
  table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16', alert: 'M12 3l10 18H2zM12 10v5M12 18v.5', dl: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.5M8 17h.5', card: 'M3 6h18v12H3zM3 10h18', tag: 'M3 12V4h8l10 10-8 8z', pie: 'M12 3v9h9a9 9 0 11-9-9z',
  life: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 15a3 3 0 100-6 3 3 0 000 6z', megaphone: 'M3 10v4h4l8 5V5l-8 5zM18 9a4 4 0 010 6',
  git: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9c0 6-12 3-12 6', key: 'M8 15a4 4 0 100-8 4 4 0 000 8zM11 11h10M18 11v4',
  up: 'M12 20V8M7 13l5-5 5 5M5 4h14', menu: 'M4 6h16M4 12h16M4 18h16', bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0',
  moon: 'M20 14A8 8 0 1110 4a6 6 0 0010 10z', out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11', down: 'M6 9l6 6 6-6', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  mobile: 'M7 3h10v18H7zM11 18h2', wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 13h2', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
} as const
export type IconName = keyof typeof ICO
export function Ic({ n, className = '', style }: { n: string; className?: string; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" className={className} style={{ width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', flex: 'none', ...style }}>
    <path d={ICO[n as IconName] ?? ICO.file} />
  </svg>
}

export const C = { ac: 'var(--bw-ac)', sf: 'var(--bw-sf)', hd: 'var(--bw-hd)', ln: 'var(--bw-ln)', ln2: 'var(--bw-ln2)', tx: 'var(--bw-tx)', mu: 'var(--bw-mu)', ok: 'var(--bw-ok)', wa: 'var(--bw-wa)', ba: 'var(--bw-ba)', in: 'var(--bw-in)' }
const TONE = { ok: C.ok, wa: C.wa, ba: C.ba, inf: C.in, ac: C.ac, mu: C.mu } as const
export type Tone = keyof typeof TONE

export const num = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString('en-IN')
export const inr = (n: number) => n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : `₹${Math.round(n).toLocaleString('en-IN')}`
export const mb = (v: number | null | undefined) => v == null ? '—' : v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${v.toFixed(v < 10 ? 2 : 1)} MB`
export const fd = (v: string | number | null | undefined) => v == null || v === '' ? '—' : new Date(typeof v === 'number' ? v * 1000 : v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
export const fdt = (v: string | null | undefined) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
export const cap = (s: string | null | undefined) => s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—'
export const statusTone = (s: string): Tone => ({ active: 'ok', healthy: 'ok', completed: 'ok', available: 'ok', online: 'ok', trial: 'wa', pending: 'wa', in_progress: 'wa', suspended: 'ba', failed: 'ba', cancelled: 'mu' } as Record<string, Tone>)[s.toLowerCase()] ?? 'inf'
export const VISIBILITY_LABEL = { full: 'Full data & workspace access', reports: 'Consolidated reports only', none: 'None (fully isolated)' } as const

// Prototype av(): initials on a colour picked from the name.
const AV_COLORS = ['#5646C2', '#1B8559', '#C13B2A', '#2F6DB5', '#B26B00', '#7A4FB8']
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const initials = name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?'
  return <span className="inline-grid flex-none place-items-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: Math.round(size * .45), background: AV_COLORS[h % AV_COLORS.length] }}>{initials}</span>
}

export function Pill({ children, t = 'inf', title }: { children: ReactNode; t?: Tone; title?: string }) {
  return <span title={title} className="inline-block whitespace-nowrap rounded-[9px] px-[9px] py-px text-[11px] font-semibold leading-[18px] tracking-[.01em]" style={t === 'mu' ? { color: C.mu, background: C.hd, border: `1px solid ${C.ln2}` } : { color: TONE[t], background: `color-mix(in srgb, ${TONE[t]} 14%, var(--bw-sf))` }}>{children}</span>
}

// Prototype panel(): 8px card with a soft shadow and a faintly accent-tinted header.
export function Panel({ title, act, flush, children, className = '', style }: { title?: ReactNode; act?: ReactNode; flush?: boolean; children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`bw-panel ${className}`} style={style}>
    {title != null && <div className="ph">{title}{act && <><span className="flex-1" />{act}</>}</div>}
    <div className={`pb ${flush ? 'z' : ''}`}>{children}</div>
  </div>
}

// Prototype .pg: crumb above a 22px title, count beside it, actions pushed right.
export function PageHead({ crumb, title, cnt, sub, children }: { crumb?: ReactNode; title: ReactNode; cnt?: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return <div className="mb-[14px] flex flex-wrap items-center gap-3">
    <div className="min-w-0">{crumb && <div className="mb-[3px] text-xs" style={{ color: C.mu }}>{crumb}</div>}<h1>{title}</h1>{sub && <div className="mt-0.5" style={{ color: C.mu }}>{sub}</div>}</div>
    {cnt != null && <span style={{ color: C.mu }}>{cnt}</span>}
    <span className="flex-1" />
    {children}
  </div>
}

type StripTone = 'tok' | 'twarn' | 'tbad'
const toneOfColor = (c?: string): StripTone | undefined => c === C.ok ? 'tok' : c === C.wa ? 'twarn' : c === C.ba ? 'tbad' : undefined
const SPARK_TONE: Record<StripTone, string> = { tok: C.ok, twarn: C.wa, tbad: C.ba }
// Prototype v8 strip(): KPI cards with a 3px top accent (coloured by tone), caps label, value, trend chip and sparkline.
// `c` (a C.* colour) is read as the tone, so older callers keep their meaning.
// `min` narrows the card minimum (default 150px, as in the prototype) so a longer row of KPIs stays on one line.
// `kpi` names the drill-down (GET /platform/kpi/{kpi}): clicking the card opens the KPI popup with its records.
const KpiPopup = lazy(() => import('./KpiPopup'))
type KpiOpen = { kpi: string; title: string; value: ReactNode; query?: KpiQuery }
// Opens the KPI popup from anywhere on a page (chart segments, panel counts): const [openKpi, popup] = useKpiPopup(); render {popup}.
export function useKpiPopup() {
  const [open, setOpen] = useState<KpiOpen | null>(null)
  // Portalled to the platform shell so the card/hero styles around it don't leak into the dialog.
  // React bubbles portal events through the component tree: stop them here, or a click on Close would reach the KPI card
  // (or chart) that opened the popup and open it again. Escape is left alone so the popup's own document listener sees it.
  const node = open && createPortal(<div className="contents" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation() }}>
    <Suspense fallback={null}><KpiPopup kpi={open.kpi} title={open.title} value={open.value} fixed={open.query} onClose={() => setOpen(null)} /></Suspense></div>,
    document.querySelector('.platform-shell main') ?? document.querySelector('.platform-shell') ?? document.body)
  return [setOpen, node] as const
}
const pressable = (fn?: () => void) => fn ? { onClick: fn, role: 'button', tabIndex: 0, onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } } } : {}

export type StripItem = { l: string; v: ReactNode; d?: ReactNode; c?: string; dc?: StripTone; sp?: (number | null)[]; onClick?: () => void; on?: boolean; title?: string; kpi?: string; kpiQuery?: KpiQuery }
export function Strip({ items, min }: { items: StripItem[]; min?: number }) {
  const [openKpi, popup] = useKpiPopup()
  return <div className="bw-strip" style={min ? { gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` } : undefined}>
    {popup}
    {items.map(x => {
      const dc = x.dc ?? toneOfColor(x.c)
      const sp = x.sp && x.sp.filter(v => v != null).length > 1 ? x.sp : null
      const click = x.onClick ?? (x.kpi ? () => openKpi({ kpi: x.kpi!, title: x.l, value: x.v, query: x.kpiQuery }) : undefined)
      return <div key={x.l} title={x.title ?? (x.kpi ? `${x.l} — click for details` : undefined)} {...pressable(click)}
        className={`st ${dc ?? ''} ${sp ? 'has-sp' : ''} ${click ? 'clk' : ''} ${x.on ? 'on' : ''}`}>
        <label>{x.l}</label>
        {sp && <span className="spw"><SparkArea v={sp} c={dc ? SPARK_TONE[dc] : C.ac} /></span>}
        <b>{x.v}</b>
        {x.d != null && x.d !== '' && <i className={dc ?? ''} style={!dc && x.c ? { color: x.c } : undefined}>{x.d}</i>}
      </div>
    })}
  </div>
}

// Prototype spark(): area sparkline with a gradient fill and an end dot (used inside KPI cards).
let sparkSeq = 0
export function SparkArea({ v, c = C.ac }: { v: (number | null)[]; c?: string }) {
  const id = useMemo(() => `bwsp${++sparkSeq}`, [])
  const vals = v.map(x => x ?? 0)
  if (vals.length < 2) return null
  const mx = Math.max(...vals), mn = Math.min(...vals), W = 96, H = 28
  const pts = vals.map((x, i) => [i * W / (vals.length - 1), H - 4 - (x - mn) / ((mx - mn) || 1) * (H - 10)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".28" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
    <path d={`${d} L${W} ${H} L0 ${H}Z`} fill={`url(#${id})`} />
    <path d={d} fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={last[0]} cy={last[1]} r="2.4" fill={c} />
  </svg>
}

// Prototype .hero: dark gradient band of live headline numbers.
export function Hero({ cells }: { cells: { l: string; v: ReactNode; sub?: ReactNode; title?: string; kpi?: string; kpiQuery?: KpiQuery }[] }) {
  const [openKpi, popup] = useKpiPopup()
  return <div className="bw-hero">{popup}{cells.map(c => <div key={c.l} className={`min-w-0 ${c.kpi ? 'clk' : ''}`} title={c.title ?? (c.kpi ? `${c.l} — click for details` : undefined)}
    {...pressable(c.kpi ? () => openKpi({ kpi: c.kpi!, title: c.l, value: c.v, query: c.kpiQuery }) : undefined)}><label>{c.l}</label><b>{c.v}</b>{c.sub != null && <small>{c.sub}</small>}</div>)}</div>
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return <div className="grid gap-x-[18px] sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-2.5 border-b py-[5px]" style={{ borderColor: C.ln2 }}><span style={{ color: C.mu }}>{k}</span><span className="min-w-0 break-words text-right">{v ?? '—'}</span></div>)}</div>
}

export function Note({ children, info, className = '' }: { children: ReactNode; info?: boolean; className?: string }) {
  const tone = info ? C.ac : C.wa
  return <div className={`rounded-lg border px-[13px] py-[9px] text-xs leading-normal ${className}`} style={{ background: `color-mix(in srgb, ${tone} ${info ? 8 : 10}%, var(--bw-sf))`, borderColor: `color-mix(in srgb, ${tone} ${info ? 30 : 35}%, var(--bw-ln))` }}>{children}</div>
}

// Prototype tabsH(): pass `card` for the free-standing rounded tab bar (.tabs.mb).
export function Tabs({ tabs, active, onChange, card }: { tabs: readonly string[]; active: string; onChange: (t: string) => void; card?: boolean }) {
  return <div role="tablist" className={`bw-tabs ${card ? 'mb' : ''}`}>
    {tabs.map(t => <button key={t} type="button" role="tab" aria-selected={t === active} onClick={() => onChange(t)} className={`bw-tab ${t === active ? 'on' : ''}`}>{t}</button>)}
  </div>
}

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className="relative inline-block h-4 w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-50" style={{ background: on ? C.ac : C.ln }}>
    {/* explicit #fff: the dark theme remaps .bg-white to the dark surface */}
    <span className="absolute top-0.5 h-3 w-3 rounded-full transition-all" style={{ left: on ? 16 : 2, background: '#fff' }} />
  </button>
}

export function Btn({ children, onClick, p, d, s, g, disabled, title, type = 'button', className = '' }: { children: ReactNode; onClick?: () => void; p?: boolean; d?: boolean; s?: boolean; g?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string }) {
  return <button type={type} title={title} disabled={disabled} onClick={onClick} className={`bw-btn ${p ? 'p' : ''} ${d ? 'd' : ''} ${s ? 's' : ''} ${g ? 'g' : ''} ${className}`}>{children}</button>
}

// Prototype .chip: rounded filter toggle.
export function Chip({ children, on, onClick, title }: { children: ReactNode; on?: boolean; onClick?: () => void; title?: string }) {
  return <button type="button" title={title} aria-pressed={on} onClick={onClick} className={`bw-chip ${on ? 'on' : ''}`}>{children}</button>
}

// Prototype .path: chevron stepper. Steps before `cur` read as done; pass onPick to make them clickable.
export function Steps({ steps, cur, onPick }: { steps: readonly string[]; cur: number; onPick?: (i: number) => void }) {
  return <div className="bw-path">{steps.map((s, i) => onPick && i < cur
    ? <button key={s} type="button" className="s done" onClick={() => onPick(i)}>{i + 1}. {s}</button>
    : <span key={s} aria-current={i === cur ? 'step' : undefined} className={`s ${i === cur ? 'cur' : i < cur ? 'done' : ''}`}>{i + 1}. {s}</span>)}</div>
}

export function Bar({ value, tone }: { value: number | null; tone?: string }) {
  if (value == null) return <span style={{ color: C.mu }}>—</span>
  return <div className="flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded" style={{ background: C.ln2 }}><i className="block h-full rounded" style={{ width: `${Math.min(100, value)}%`, background: tone || (value < 70 ? C.wa : C.ok) }} /></div><small className="w-8 text-right text-xs tabular-nums">{Math.round(value)}</small></div>
}

// Prototype hbars() look (.hbr): rounded track, gradient fill, value on the right.
export function HBars({ rows, lw = 190 }: { rows: { l: string; v: number | null }[]; lw?: number }) {
  return <div>{rows.map(r => <div key={r.l} className="hbr"><span className="hbl" style={{ width: lw }} title={r.l}>{r.l}</span><span className="hbt">{r.v != null && <i style={{ width: `${Math.min(100, r.v)}%`, background: r.v > 90 ? C.ba : 'linear-gradient(90deg, color-mix(in srgb, var(--bw-ac) 70%, #fff), var(--bw-ac))' }} />}</span><b className="hbv" style={{ width: 44 }}>{r.v == null ? '—' : `${Math.round(r.v)}%`}</b></div>)}</div>
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-5 py-10 text-center text-[13px]" style={{ color: C.mu }}>{children}</div>
export const Loading = () => <Empty>Loading…</Empty>

export function Table({ head, children, minWidth = 640 }: { head: (string | { t: string; r?: boolean })[]; children: ReactNode; minWidth?: number }) {
  return <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth }}>
    <thead><tr>{head.map((h, i) => { const c = typeof h === 'string' ? { t: h } : h; return <th key={i} className={c.r ? 'text-right' : ''}>{c.t}</th> })}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>
}

const useEscape = (onClose: () => void) => useEffect(() => {
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
}, [onClose])
const CloseX = ({ onClose }: { onClose: () => void }) => <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 flex-none place-items-center rounded-md hover:bg-[var(--bw-hd)]" style={{ color: C.mu }}><X size={16} /></button>

// Prototype .ov / .md: blurred overlay, top-anchored 12px-radius dialog with a tinted footer.
// Rendered at the root of the app shell, not inside the page: a page container with a transform or filter would
// otherwise clip the fixed overlay, leaving the mask over part of the screen. The shell root keeps the theme tokens.
export function BwModal({ title, onClose, children, foot, width = 560 }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; width?: number }) {
  useEscape(onClose)
  return createPortal(<div className="bw-ov" role="dialog" aria-modal="true" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="bw-md" style={{ maxWidth: width }}>
      <div className="ph">{title}<span className="flex-1" /><CloseX onClose={onClose} /></div>
      <div className="pb">{children}</div>
      {foot && <div className="pf">{foot}</div>}
    </div>
  </div>, document.querySelector('.platform-shell, .crm-shell') ?? document.body)
}

// Prototype .dw: right-hand drawer for record detail.
export function Drawer({ title, sub, act, onClose, children, width = 680 }: { title: ReactNode; sub?: ReactNode; act?: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEscape(onClose)
  return <>
    <div className="fixed inset-0 z-[99]" style={{ background: 'rgba(8,14,22,.35)' }} onMouseDown={onClose} aria-hidden />
    <aside className="bw-dw" role="dialog" aria-modal="true" style={{ width: `min(${width}px, 100%)` }}>
      <div className="dh"><div className="min-w-0 flex-1"><h2 className="text-[15px] font-semibold">{title}</h2>{sub && <small style={{ color: C.mu }}>{sub}</small>}</div>{act}<CloseX onClose={onClose} /></div>
      <div className="db">{children}</div>
    </aside>
  </>
}

// Prototype .in: 30px, 6px radius, accent focus ring (see .bw-in in index.css).
export const inputCls = 'bw-in'
export const inputStyle = { background: C.sf, borderColor: C.ln, color: C.tx }
export function Field({ label, children, req }: { label: string; children: ReactNode; req?: boolean }) {
  return <label className="block"><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>{label}{req && <b style={{ color: C.ba }}> *</b>}</span>{children}</label>
}

export function downloadBlob(data: Blob, name: string) {
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// Clipboard copy that also works on plain-http addresses (e.g. a LAN IP), where navigator.clipboard is unavailable.
export async function copyText(text: string): Promise<boolean> {
  try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true } } catch { /* fall back below */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  try { return document.execCommand('copy') } catch { return false } finally { ta.remove() }
}

export const errMsg = (err: any, fallback: string) => err?.response?.data?.detail && typeof err.response.data.detail === 'string' ? err.response.data.detail : fallback
