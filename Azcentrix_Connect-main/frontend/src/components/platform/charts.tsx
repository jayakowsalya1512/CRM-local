import { useMemo, type ReactNode } from 'react'
import { C } from './bw'

// SVG charts ported from the Bidwise prototype v9 helpers (line(), bars(), hbars(), donut(), spark(), heat(), funnel(),
// gaugeSvg()), shared by platform pages. Styling hooks (.lgd, .dlg, .hbr, .fnl2, .dseg, .bgp) live in index.css.
export const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']

let seq = 0
const useId = (p: string) => useMemo(() => `${p}${++seq}`, [p])

// Prototype nmx(): round an axis maximum up to 1 / 2 / 2.5 / 5 / 10 × 10ⁿ.
export const niceMax = (v: number) => {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}
// Prototype cmp(): compact axis numbers (k / L / Cr).
export const compact = (v: number) => {
  const a = Math.abs(v)
  return a >= 1e7 ? `${+(v / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${+(v / 1e5).toFixed(1)}L` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v * 10) / 10)
}

// Prototype smooth(): Catmull-Rom style cubic path through the points.
const smooth = (pts: number[][]) => {
  if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}`
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2, t = .17
    d += ` C${(p1[0] + (p2[0] - p0[0]) * t).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * t).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) * t).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * t).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

// Dashed series (projections) get a dashed swatch so they read differently from measurements.
export const Legend = ({ items }: { items: { n: string; c: string; dash?: boolean }[] }) =>
  <div className="lgd">{items.map(s => <span key={s.n}><i style={s.dash ? { background: 'none', border: `2px dashed ${s.c}`, width: 12, height: 0, borderRadius: 0, verticalAlign: 'middle' } : { background: s.c }} />{s.n}</span>)}</div>

// Prototype line(): smoothed area/line chart, dashed grid, hollow dots with a solid last point, legend below.
// Null slots have no data: the line joins the slots that do (dots mark the real points).
export function LineChart({ series, labels, h = 180, f = compact, legend }: { series: { n: string; c: string; v: (number | null)[]; fill?: boolean; dash?: boolean }[]; labels: string[]; h?: number; f?: (v: number) => string; legend?: boolean }) {
  const id = useId('ln')
  const W = 420, ml = 40, mr = 10, mt = 12, mb = 24
  const mx = niceMax(Math.max(...series.flatMap(s => s.v.filter((v): v is number => v != null)), 1) * 1.05)
  const n = Math.max(labels.length - 1, 1)
  const x = (i: number) => ml + i * (W - ml - mr) / n
  const y = (v: number) => mt + (h - mt - mb) * (1 - v / mx)
  return <>
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: h * 1.5 }}>
      <defs>{series.map((s, k) => <linearGradient key={k} id={`${id}${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={s.c} stopOpacity={k ? .12 : .26} /><stop offset="1" stopColor={s.c} stopOpacity="0" /></linearGradient>)}</defs>
      {[0, .25, .5, .75, 1].map(g => <g key={g}>
        <line x1={ml} x2={W - mr} y1={y(mx * g)} y2={y(mx * g)} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} />
        <text x={ml - 6} y={y(mx * g) + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{f(mx * g)}</text>
      </g>)}
      {labels.map((l, i) => l ? <text key={i} x={x(i)} y={h - 7} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{l}</text> : null)}
      {series.map((s, k) => {
        const pts = s.v.flatMap((v, i) => v == null ? [] : [[x(i), y(v), i, v]])
        if (!pts.length) return null
        const d = smooth(pts)
        const lastIdx = pts[pts.length - 1][2]
        return <g key={s.n}>
          {s.fill !== false && !s.dash && pts.length > 1 && <path d={`${d} L${pts[pts.length - 1][0]} ${h - mb} L${pts[0][0]} ${h - mb}Z`} fill={`url(#${id}${k})`} />}
          {pts.length > 1 && <path d={d} fill="none" stroke={s.c} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dash ? '5 4' : undefined} />}
          {pts.map(([px, py, i, v]) => <circle key={i} cx={px} cy={py} r={i === lastIdx ? 4 : 2.6} fill={i === lastIdx ? s.c : 'var(--bw-sf)'} stroke={s.c} strokeWidth="1.8"><title>{`${s.n} · ${labels[i] || i + 1}: ${f(v)}`}</title></circle>)}
        </g>
      })}
    </svg>
    {(legend ?? (series.length > 1 || !!series[0]?.n)) && <Legend items={series} />}
  </>
}

// Prototype bars() axes and gradient columns, coloured for error rates: red when a slot had errors, a green stub when it
// had traffic but no errors (so 0 % is visible and distinct from "no traffic").
// `onPick(index)` on the charts below makes each column / bar / segment clickable (drill-down to its records).
type Pick = { onPick?: (i: number) => void }
export function BarChart({ data, h = 170, f, onPick }: { data: { l: string; v: number; has: boolean; t: string }[]; h?: number; f: (v: number) => string } & Pick) {
  return <Columns h={h} f={f} vals={false} onPick={onPick} data={data.map(d => ({ l: d.l, v: d.has ? d.v : 0, c: d.v > 0 ? 'var(--bw-ba)' : 'var(--bw-ok)', t: `${d.t}: ${d.has ? f(d.v) : 'no data'}`, stub: d.has }))} />
}

// Prototype bars(..., {vals: 1}): one colour per column, value printed above each.
export function ValueBars({ data, h = 170, f, onPick }: { data: { l: string; v: number; c: string; t?: string; txt?: string }[]; h?: number; f: (v: number) => string } & Pick) {
  return <Columns h={h} f={f} vals onPick={onPick} data={data.map(d => ({ ...d, t: d.t ?? `${d.l}: ${f(d.v)}` }))} />
}

// Prototype bars(): dashed grid with axis values, rounded gradient columns, labels below.
export function Columns({ data, h = 170, f = compact, vals, c, onPick }: { data: { l: string; v: number; c?: string; t?: string; txt?: string; stub?: boolean }[]; h?: number; f?: (v: number) => string; vals?: boolean; c?: string } & Pick) {
  const id = useId('bg')
  const W = 400, ml = 34, mb = 24, mt = 16
  const mx = niceMax(Math.max(...data.map(d => d.v), 1) * 1.04), n = data.length || 1, bw = (W - ml - 8) / n
  const showV = vals ?? n <= 9
  return <svg viewBox={`0 0 ${W} ${h}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: h * 1.5 }}>
    <defs>{data.map((d, i) => { const col = d.c || c || 'var(--bw-ac)'; return <linearGradient key={i} id={`${id}${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={col} /><stop offset="1" stopColor={col} stopOpacity=".62" /></linearGradient> })}</defs>
    {[0, .25, .5, .75, 1].map(g => { const gy = mt + (h - mt - mb) * (1 - g); return <g key={g}>
      <line x1={ml} x2={W - 6} y1={gy} y2={gy} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} />
      <text x={ml - 6} y={gy + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{f(mx * g)}</text>
    </g> })}
    {data.map((d, i) => {
      const bh = d.v > 0 ? Math.max(1, d.v / mx * (h - mt - mb)) : d.stub ? 2 : 0
      const bx = ml + i * bw + bw * .2, w = bw * .6
      return <g key={i} className={`bgp ${onPick ? 'pk' : ''}`} onClick={onPick ? () => onPick(i) : undefined}>
        {onPick && <rect x={ml + i * bw} y={mt} width={bw} height={h - mt} fill="transparent" />}
        {bh > 0 && <rect x={bx} y={h - mb - bh} width={w} height={bh} fill={`url(#${id}${i})`} rx={Math.min(5, w / 2, bh / 2)}><title>{d.t ?? `${d.l}: ${f(d.v)}`}</title></rect>}
        {showV && d.v > 0 && <text x={bx + w / 2} y={h - mb - bh - 4} fontSize="9.5" fontWeight="600" textAnchor="middle" fill="var(--bw-tx)">{d.txt ?? f(d.v)}</text>}
        <text x={ml + i * bw + bw / 2} y={h - 8} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{String(d.l).slice(0, 10)}</text>
      </g>
    })}
  </svg>
}

// Stacked columns in the prototype bars() frame: one gradient segment per series, legend below.
export function StackedBars({ labels, series, h = 170, f = compact, onPick }: { labels: string[]; series: { n: string; c: string; v: number[] }[]; h?: number; f?: (v: number) => string } & Pick) {
  const W = 400, ml = 34, mb = 24, mt = 12
  const tot = labels.map((_, i) => series.reduce((a, s) => a + (s.v[i] || 0), 0))
  const mx = niceMax(Math.max(...tot, 1) * 1.04), n = labels.length || 1, bw = (W - ml - 8) / n, w = bw * .6
  const sy = (v: number) => v / mx * (h - mt - mb)
  return <>
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: h * 1.5 }}>
      {[0, .25, .5, .75, 1].map(g => { const gy = mt + (h - mt - mb) * (1 - g); return <g key={g}>
        <line x1={ml} x2={W - 6} y1={gy} y2={gy} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} />
        <text x={ml - 6} y={gy + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{f(mx * g)}</text>
      </g> })}
      {labels.map((l, i) => {
        let acc = 0
        const bx = ml + i * bw + bw * .2
        return <g key={i} className={`bgp ${onPick ? 'pk' : ''}`} onClick={onPick ? () => onPick(i) : undefined}>
          {onPick && <rect x={ml + i * bw} y={mt} width={bw} height={h - mt} fill="transparent" />}
          {series.map(s => { const v = s.v[i] || 0; if (!v) return null; const y0 = h - mb - sy(acc) - sy(v); acc += v
            return <rect key={s.n} x={bx} y={y0} width={w} height={sy(v)} fill={s.c}><title>{`${s.n} · ${l}: ${f(v)}`}</title></rect> })}
          <text x={ml + i * bw + bw / 2} y={h - 8} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{String(l).slice(0, 10)}</text>
        </g>
      })}
    </svg>
    <Legend items={series} />
  </>
}

// Prototype hbars(): label, rounded gradient track, value.
export function HBars({ rows, lw = 110, vw = 92, c, onPick }: { rows: { l: string; v: number | null; text: string; note?: string | null; muted?: boolean; c?: string }[]; lw?: number; vw?: number; c?: string } & Pick) {
  const mx = Math.max(...rows.map(r => r.v ?? 0), 1)
  return <div>{rows.map((r, i) => <div key={r.l} className={`hbr ${onPick ? 'pk' : ''}`} title={r.note || undefined}
    {...(onPick ? { onClick: () => onPick(i), role: 'button', tabIndex: 0, onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') onPick(i) } } : {})}>
    <span className="hbl" style={{ width: lw }} title={r.l}>{r.l}</span>
    <span className="hbt">{r.v != null && <i style={{ width: `${Math.max(r.v ? 2 : 0, r.v / mx * 100)}%`, background: r.c || c || 'linear-gradient(90deg, color-mix(in srgb, var(--bw-ac) 70%, #fff), var(--bw-ac))', opacity: r.muted ? .55 : 1 }} />}</span>
    <b className="hbv" style={{ width: vw, color: r.v == null ? C.mu : undefined }}>{r.text}</b>
  </div>)}</div>
}

// Prototype donut(): stroked ring with the total (and an optional caption) in the middle; legend rows show value and share.
export function Donut({ data, f, center, caption, onPick }: { data: { l: string; v: number; c?: string }[]; f: (v: number) => string; center?: string; caption?: string } & Pick) {
  const tot = data.reduce((a, d) => a + d.v, 0), safe = tot || 1
  const R = 44, sw = 14, CIRC = 2 * Math.PI * R
  const gap = data.filter(d => d.v).length > 1 ? 1.8 : 0
  let off = 0
  const segs = data.map((d, i) => {
    const len = d.v / safe * CIRC, col = d.c || PAL[i % PAL.length], o = off
    off += len
    return d.v ? <circle key={d.l} className={`dseg ${onPick ? 'pk' : ''}`} onClick={onPick ? () => onPick(i) : undefined} cx="60" cy="60" r={R} fill="none" stroke={col} strokeWidth={sw} strokeDasharray={`${Math.max(0, len - gap)} ${CIRC - Math.max(0, len - gap)}`} strokeDashoffset={-o} transform="rotate(-90 60 60)"><title>{`${d.l}: ${f(d.v)} (${Math.round(d.v / safe * 100)}%)`}</title></circle> : null
  })
  const ct = center ?? f(tot)
  return <div className="flex items-center gap-4">
    <svg viewBox="0 0 120 120" width={112} className="flex-none">
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--bw-ln2)" strokeWidth={sw} />{segs}
      <text x="60" y={caption ? 58 : 64} textAnchor="middle" fontSize={ct.length > 8 ? 9 : ct.length > 6 ? 11 : ct.length > 4 ? 14 : 17} fontWeight="700" fill="var(--bw-tx)">{ct}</text>
      {caption && <text x="60" y="74" textAnchor="middle" fontSize="8.5" fill="var(--bw-mu)">{caption}</text>}
    </svg>
    <div className="dlg">{data.map((d, i) => <div key={d.l} className={`dlr ${onPick ? 'pk' : ''}`} {...(onPick ? { onClick: () => onPick(i), role: 'button', tabIndex: 0, onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') onPick(i) } } : {})}><i style={{ background: d.c || PAL[i % PAL.length] }} /><span className="dll" title={d.l}>{d.l}</span><b>{f(d.v)}</b><small>{Math.round(d.v / safe * 100)}%</small></div>)}</div>
  </div>
}

// Small inline sparkline (prototype spark() look) for use beside a value outside KPI cards.
export function Spark({ v, c = 'var(--bw-ac)' }: { v: (number | null)[]; c?: string }) {
  const id = useId('isp')
  const vals = v.map(x => x ?? 0)
  if (vals.length < 2) return null
  const mx = Math.max(...vals), mn = Math.min(...vals), W = 60, H = 18
  const pts = vals.map((x, i) => [i * W / (vals.length - 1), H - 3 - (x - mn) / ((mx - mn) || 1) * (H - 6)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  return <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="ml-1.5 inline-block align-middle" aria-hidden>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".28" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
    <path d={`${d} L${W} ${H} L0 ${H}Z`} fill={`url(#${id})`} /><path d={d} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

// Prototype heat(): row labels, column headers, cells shaded by value (0–100). A null cell has no data yet (period not
// reached / no accounts) and is drawn as an empty outline, so it can't be mistaken for 0 %.
export function Heat({ rows, cols, cell }: { rows: string[]; cols: string[]; cell: (i: number, j: number) => { v: number | null; t: string } }) {
  return <div className="grid gap-[2px]" style={{ gridTemplateColumns: `90px repeat(${cols.length}, minmax(0, 1fr))` }}>
    <span />
    {cols.map(c => <small key={c} className="text-center text-[11px]" style={{ color: C.mu }}>{c}</small>)}
    {rows.map((r, i) => <div key={r} className="contents">
      <small className="truncate text-[11px] leading-[13px]" title={r}>{r}</small>
      {cols.map((c, j) => { const x = cell(i, j); return <i key={c} title={x.t} data-v={x.v ?? ''} className="block h-[13px] rounded-[3px]"
        style={x.v == null ? { border: `1px dashed ${C.ln}` } : { background: `color-mix(in srgb, var(--bw-ac) ${x.v}%, var(--bw-ln2))` }} /> })}
    </div>)}
  </div>
}

// Prototype funnel(): centred bars that narrow with each stage, step conversion between rows.
export function Funnel({ data, f = String }: { data: { l: string; v: number }[]; f?: (v: number) => string }) {
  const mx = Math.max(...data.map(d => d.v), 1)
  return <div className="fnl2">{data.map((d, i) => <div key={d.l}>
    {i > 0 && <div className="fcv">{data[i - 1].v && d.v <= data[i - 1].v ? `↓ ${Math.round(d.v / data[i - 1].v * 100)}%` : ''}</div>}
    <div className="frow"><span className="fln" title={d.l}>{d.l}</span><div className="ftr"><div className="fbar" style={{ width: `${Math.max(9, d.v / mx * 100)}%`, background: `linear-gradient(90deg, color-mix(in srgb, var(--bw-ac) ${100 - i * 9}%, #fff), color-mix(in srgb, var(--bw-ac) ${96 - i * 9}%, #000))` }}><b>{f(d.v)}</b></div></div></div>
  </div>)}</div>
}

// Prototype gaugeSvg() / ring(): health ring, red under 55, amber under 75, green above.
export function Gauge({ v, size = 110, label }: { v: number | null; size?: number; label?: ReactNode }) {
  const big = size >= 80, r = big ? 40 : 17, sw = big ? 10 : 5, box = big ? 110 : 44, circ = 2 * Math.PI * r
  const col = v == null ? 'var(--bw-ln)' : v < 55 ? 'var(--bw-ba)' : v < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)'
  return <svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} className="flex-none">
    <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke="var(--bw-ln2)" strokeWidth={sw} />
    {v != null && <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke={col} strokeWidth={sw} strokeDasharray={`${circ * Math.min(100, v) / 100} ${circ}`} strokeLinecap="round" transform={`rotate(-90 ${box / 2} ${box / 2})`} />}
    <text x={box / 2} y={box / 2 + (big ? 7 : 4)} textAnchor="middle" fontSize={big ? 24 : 11} fontWeight="700" fill="var(--bw-tx)">{v == null ? '—' : Math.round(v)}</text>
    {label && big && <text x={box / 2} y={box / 2 + 22} textAnchor="middle" fontSize="9" fill="var(--bw-mu)">{label}</text>}
  </svg>
}

// Prototype .gauge: thin utilisation meter.
export const Meter = ({ v, c }: { v: number; c?: string }) =>
  <div className="gauge"><i style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: c || (v > 80 ? C.ba : v > 65 ? C.wa : C.ok) }} /></div>
