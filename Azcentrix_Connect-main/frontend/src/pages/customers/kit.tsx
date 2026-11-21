// React versions of the prototype v17 helpers used by Customers & Contacts:
// strip(), panel(), tbl(), funnel(), bars(), hbars(), donut(), line(), gaugeSvg(), bar(), av(), pill().
import { useId, type ReactNode } from 'react'
import { fmtKpi, pc, type Kpi } from './customerApi'

const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
export const cmp = (v: number) => { const a = Math.abs(v); return a >= 1e7 ? `${+(v / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${+(v / 1e5).toFixed(1)}L` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v * 10) / 10) }
const nmx = (v: number) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p }

export const Pill = ({ s, t }: { s: ReactNode; t?: string }) => <span className={`pill ${t || pc(String(s))}`}>{s}</span>
export function Av({ name }: { name: string }) {
  const n = name || '?'
  return <span className="av" style={{ background: PAL[hash(n) % PAL.length] }} title={n}>{n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}</span>
}
/** prototype bar(): inline progress + % */
export const BarPct = ({ v, c }: { v: number; c?: string }) => <><span className="bar"><i style={{ width: `${Math.min(100, Math.max(0, v))}%`, ...(c ? { background: c } : {}) }} /></span>{Math.round(v)}%</>

export function Strip({ items }: { items: Kpi[] }) {
  return <div className="strip">{items.map(x => <div key={x.l} className={`st ${x.dc || ''}`} title={x.note}>
    <div className="sth"><label>{x.l}</label></div><b className={x.dc || ''}>{fmtKpi(x)}</b>{x.note && <i>{x.note}</i>}
  </div>)}</div>
}

export function Panel({ title, act, z, children, className = '' }: { title: ReactNode; act?: ReactNode; z?: boolean; children: ReactNode; className?: string }) {
  return <div className={`panel ${className}`}><div className="ph">{title}{act && <><span className="fl" />{act}</>}</div><div className={`pb ${z ? 'z' : ''}`}>{children}</div></div>
}

export type Col<R> = { k: string; t: string; r?: boolean; wr?: boolean; fn?: (r: R) => ReactNode }
export function Tbl<R>({ cols, rows, onRow, empty, rowKey }: { cols: Col<R>[]; rows: R[]; onRow?: (r: R) => void; empty?: string; rowKey?: (r: R, i: number) => string | number }) {
  if (!rows.length) return <div className="empty">{empty || 'No records match. Adjust filters or create a new record.'}</div>
  return <table className="t"><thead><tr>{cols.map(c => <th key={c.k} className={c.r ? 'r' : ''}>{c.t}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={rowKey ? rowKey(r, i) : ((r as { id?: number | string }).id ?? i)} data-a={onRow ? 'open' : undefined} onClick={onRow ? () => onRow(r) : undefined}
      tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? e => { if (e.key === 'Enter') onRow(r) } : undefined}>
      {cols.map(c => <td key={c.k} className={`${c.r ? 'r' : ''} ${c.wr ? 'wr' : ''}`}>{c.fn ? c.fn(r) : String((r as any)[c.k] ?? '')}</td>)}
    </tr>)}</tbody></table>
}

export function Funnel({ d }: { d: { l: string; v: number }[] }) {
  const mx = Math.max(...d.map(x => x.v), 1)
  return <div className="fnl2">{d.map((x, i) => <div key={x.l}>
    {i > 0 && <div className="fcv">{d[i - 1].v && x.v <= d[i - 1].v ? <span>↓ {Math.round(x.v / d[i - 1].v * 100)}%</span> : null}</div>}
    <div className="frow"><span className="fln" title={x.l}>{x.l}</span><div className="ftr"><div className="fbar" style={{ width: `${Math.max(9, x.v / mx * 100)}%`, background: `linear-gradient(90deg,color-mix(in srgb,var(--bw-ac) ${100 - i * 9}%,#fff),color-mix(in srgb,var(--bw-ac) ${96 - i * 9}%,#000))` }}><b>{x.v}</b></div></div></div>
  </div>)}</div>
}

export function Bars({ d, h = 170, f = cmp }: { d: { l: string; v: number; c?: string }[]; h?: number; f?: (v: number) => string }) {
  const id = useId().replace(/:/g, '')
  const W = 400, H = h, ml = 34, mb = 24, mt = 16, mx = nmx(Math.max(...d.map(x => x.v), 1) * 1.04), n = d.length || 1, bw = (W - ml - 8) / n
  return <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: H * 1.5 }}>
    <defs>{d.map((x, i) => <linearGradient key={i} id={`${id}${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={x.c || 'var(--bw-ac)'} /><stop offset="1" stopColor={x.c || 'var(--bw-ac)'} stopOpacity=".62" /></linearGradient>)}</defs>
    {[0, .25, .5, .75, 1].map(g => <g key={g}><line x1={ml} x2={W - 6} y1={mt + (H - mt - mb) * (1 - g)} y2={mt + (H - mt - mb) * (1 - g)} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} />
      <text x={ml - 6} y={mt + (H - mt - mb) * (1 - g) + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{f(mx * g)}</text></g>)}
    {d.map((x, i) => { const hh = Math.max(1, x.v / mx * (H - mt - mb)), bx = ml + i * bw + bw * .2, w = bw * .6
      return <g key={i}><rect x={bx} y={H - mb - hh} width={w} height={hh} fill={`url(#${id}${i})`} rx={Math.min(5, w / 2)}><title>{x.l}: {f(x.v)}</title></rect>
        {x.v ? <text x={bx + w / 2} y={H - mb - hh - 4} fontSize="9.5" fontWeight="600" textAnchor="middle" fill="var(--bw-tx)">{f(x.v)}</text> : null}
        <text x={ml + i * bw + bw / 2} y={H - 8} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{String(x.l).slice(0, 10)}</text></g> })}
  </svg>
}

export function HBars({ d, lw = 120, vw = 60, f }: { d: { l: string; v: number; c?: string }[]; lw?: number; vw?: number; f?: (v: number) => string }) {
  const mx = Math.max(...d.map(x => x.v), 1)
  if (!d.length) return <div className="empty" style={{ padding: 16 }}>Nothing to show</div>
  return <>{d.map(x => <div className="hbr" key={x.l}><span className="hbl" style={{ width: lw }} title={x.l}>{x.l}</span>
    <span className="hbt"><i style={{ width: `${Math.max(x.v ? 2 : 0, x.v / mx * 100)}%`, background: x.c || 'linear-gradient(90deg,color-mix(in srgb,var(--bw-ac) 70%,#fff),var(--bw-ac))' }} /></span>
    <b className="hbv" style={{ width: vw }}>{f ? f(x.v) : x.v}</b></div>)}</>
}

export function Donut({ d, c, cs, f }: { d: { l: string; v: number; c?: string }[]; c?: string | number; cs?: string; f?: (v: number) => string }) {
  const tot = d.reduce((a, b) => a + b.v, 0) || 1, R = 44, sw = 14, C = 2 * Math.PI * R
  let off = 0
  const ct = String(c ?? tot)
  return <div className="row" style={{ gap: 16, alignItems: 'center' }}>
    <svg viewBox="0 0 120 120" width="112" style={{ flex: 'none' }}><circle cx="60" cy="60" r={R} fill="none" stroke="var(--bw-ln2)" strokeWidth={sw} />
      {d.map((x, i) => { const len = x.v / tot * C, g = d.filter(y => y.v).length > 1 ? 1.8 : 0, col = x.c || PAL[i % PAL.length], o = off; off += len
        return x.v ? <circle key={i} cx="60" cy="60" r={R} fill="none" stroke={col} strokeWidth={sw} strokeDasharray={`${Math.max(0, len - g)} ${C - Math.max(0, len - g)}`} strokeDashoffset={-o} transform="rotate(-90 60 60)"><title>{x.l}: {f ? f(x.v) : x.v} ({Math.round(x.v / tot * 100)}%)</title></circle> : null })}
      <text x="60" y={cs ? 58 : 64} textAnchor="middle" fontSize={ct.length > 8 ? 9 : ct.length > 6 ? 11 : ct.length > 4 ? 14 : 17} fontWeight="700" fill="var(--bw-tx)">{ct}</text>
      {cs && <text x="60" y="74" textAnchor="middle" fontSize="8.5" fill="var(--bw-mu)">{cs}</text>}</svg>
    <div className="dlg">{d.map((x, i) => <div className="dlr" key={x.l}><i style={{ background: x.c || PAL[i % PAL.length] }} /><span className="dll" title={x.l}>{x.l}</span><b>{f ? f(x.v) : x.v}</b><small>{Math.round(x.v / tot * 100)}%</small></div>)}</div>
  </div>
}

export function Line({ ser, labels, h = 180, f = cmp }: { ser: { n: string; c: string; v: number[]; fill?: boolean }[]; labels: string[]; h?: number; f?: (v: number) => string }) {
  const id = useId().replace(/:/g, '')
  const W = 420, H = h, ml = 40, mr = 10, mt = 12, mb = 24, mx = nmx(Math.max(...ser.flatMap(s => s.v), 1) * 1.05), n = Math.max(labels.length - 1, 1)
  const x = (i: number) => ml + i * (W - ml - mr) / n, y = (v: number) => mt + (H - mt - mb) * (1 - v / mx)
  const path = (pts: number[][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  return <><svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: H * 1.5 }}>
    <defs>{ser.map((s, k) => <linearGradient key={k} id={`${id}${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={s.c} stopOpacity={k ? .12 : .26} /><stop offset="1" stopColor={s.c} stopOpacity="0" /></linearGradient>)}</defs>
    {[0, .25, .5, .75, 1].map(g => <g key={g}><line x1={ml} x2={W - mr} y1={y(mx * g)} y2={y(mx * g)} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} /><text x={ml - 6} y={y(mx * g) + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{f(mx * g)}</text></g>)}
    {labels.map((l, i) => <text key={i} x={x(i)} y={H - 7} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{l}</text>)}
    {ser.map((s, k) => { const pts = s.v.map((v, i) => [x(i), y(v)]); if (!pts.length) return null; const d = path(pts)
      return <g key={k}>{s.fill === false ? null : <path d={`${d} L${pts[pts.length - 1][0]} ${H - mb} L${pts[0][0]} ${H - mb}Z`} fill={`url(#${id}${k})`} />}
        <path d={d} fill="none" stroke={s.c} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {s.v.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === s.v.length - 1 ? 4 : 2.6} fill={i === s.v.length - 1 ? s.c : 'var(--bw-sf)'} stroke={s.c} strokeWidth="1.8"><title>{s.n} · {labels[i]}: {f(v)}</title></circle>)}</g> })}
  </svg><div className="lgd">{ser.map(s => <span key={s.n}><i style={{ background: s.c }} />{s.n}</span>)}</div></>
}

export function Gauge({ v, size = 110 }: { v: number; size?: number }) {
  const r = 2 * Math.PI * 40
  return <svg width={size} height={size} viewBox="0 0 110 110"><circle cx="55" cy="55" r="40" fill="none" stroke="var(--bw-ln2)" strokeWidth="10" />
    <circle cx="55" cy="55" r="40" fill="none" stroke={v < 55 ? 'var(--bw-ba)' : v < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)'} strokeWidth="10" strokeDasharray={`${r * v / 100} ${r}`} transform="rotate(-90 55 55)" />
    <text x="55" y="62" textAnchor="middle" fontSize="24" fontWeight="700" fill="currentColor">{v}</text></svg>
}

export const DOT = (t: string) => t === 'ba' ? 'var(--bw-ba)' : t === 'wa' ? 'var(--bw-wa)' : t === 'ok' ? 'var(--bw-ok)' : 'var(--bw-in)'
export const PALC = PAL
