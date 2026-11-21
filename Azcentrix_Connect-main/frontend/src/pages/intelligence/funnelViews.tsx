// Funnel & analytics – the five analysis views of prototype v17 (p31 Journey & trends, p33 Segment / Vertical / Customer /
// Leadership, p34 deep-dives). Everything is computed from the real rows of GET /api/v1/funnel/data. Where the prototype
// invents a number (hash-based ageing / cycle, random loss reasons, a target of "won × 1.6"), the real value is used or "—".
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Avatar, Bar, Empty, Strip, inr } from '@/components/platform/bw'
import { Columns, Donut, HBars, LineChart } from '@/components/platform/charts'
import { Ic } from '@/components/crm/kit'
import { LINK, daysAgo, dimVal, journeySteps, stats, sum, won, type Board, type Row } from '@/pages/dashboard/v9/boards/Funnel'

export type Cust = { id: number; name: string; parent_id: number | null; root_id: number; root: string; segment: string; sub: string; level: string; revenue: number; health: number | null; kam: string }
export type ModuleData = Board & { customers: Cust[]; target: number | null; fy: string | null; fy_start: string | null; fy_end: string | null; thresholds: { commit: number; best: number } }
type Go = (dim: string, v: string) => void

const FC = { lead: '#3E63A8', deal: '#0F6E8C', ten: '#7A4DB8', q: '#B26B00', won: '#1B8559', lost: '#C13B2A', open: '#9AA8B6', wo: '#0E9F8E' }
const pct = (a: number, b: number) => (b ? Math.round(a / b * 100) : 0)
const lost = (r: Row) => r.kind === 'lost', open = (r: Row) => r.kind === 'open'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// prototype ML6 / bm(): the last six calendar months ending with the current one
const months = (today: string) => { const t = new Date(today); return Array.from({ length: 6 }, (_, i) => { const d = new Date(t.getFullYear(), t.getMonth() - 5 + i, 1); return { k: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, l: MON[d.getMonth()] } }) }
const bm = <T,>(today: string, a: T[], date: (x: T) => string | null | undefined, val: (x: T) => number = () => 1) => months(today).map(m => sum(a.filter(x => (date(x) || '').slice(0, 7) === m.k), val))
const cycleOf = (r: Row) => (r.closed && r.date ? Math.max(0, Math.round((Date.parse(r.closed) - Date.parse(r.date)) / 864e5)) : null)
const avgCycle = (W: Row[]) => { const c = W.map(cycleOf).filter((x): x is number => x != null); return c.length ? Math.round(sum(c, x => x) / c.length) : null }

function P({ icon, t, act, z, children, className = '' }: { icon?: string; t: ReactNode; act?: ReactNode; z?: boolean; children: ReactNode; className?: string }) {
  return <div className={`bw-panel ${className}`}><div className="ph">{icon && <Ic n={icon} size={15} />} {t}{act && <><span className="flex-1" />{act}</>}</div><div className={`pb ${z ? 'z' : ''}`}>{children}</div></div>
}
const Note = ({ icon, children }: { icon: string; children: ReactNode }) => <div className="fnote mb"><Ic n={icon} size={14} /> <span>{children}</span></div>

// ── Journey & trends (prototype dashFunnel p31) ──────────────────────────────────────────────────────────────────────────────
export function JourneyView({ d, go, toFunnel }: { d: ModuleData; go: Go; toFunnel: () => void }) {
  const R = d.rows, today = d.today
  const L = R.filter(x => x.k === 'leads'), O = R.filter(x => x.k === 'opps'), T = R.filter(x => x.k === 'tenders'), Q = R.filter(x => x.k === 'quotes')
  const steps = journeySteps(R, d.orders)
  const wonD = O.filter(won), lostD = O.filter(lost), lostAll = R.filter(x => x.k !== 'leads' && lost(x))
  const openV = sum(R.filter(open), x => x.value)
  const probKnown = O.filter(open).filter(x => x.prob != null)
  const wV = probKnown.length ? sum(probKnown, x => x.value * (x.prob || 0) / 100) : null
  const cyc = avgCycle(wonD), wr = pct(wonD.length, wonD.length + lostD.length)
  const vel = cyc ? Math.round(sum(O.filter(open), x => x.value) * wr / 100 / Math.max(cyc, 1)) : null
  const created = bm(today, L, x => x.date), conv = bm(today, L.filter(x => x.converted || /[DTQ]/.test(x.j || '')), x => x.date), wonM = bm(today, wonD, x => x.closed)
  // journey flow (sankey) from the linked journey of every record
  const has = (r: Row, s: string) => (r.j || '').includes(s)
  const lD = L.filter(x => has(x, 'D')).length, lX = L.filter(lost).length
  const lT = T.filter(x => has(x, 'L') && !has(x, 'D')).length, lQ = Q.filter(x => has(x, 'L') && !has(x, 'D')).length
  const lO = Math.max(0, L.length - lD - lX - L.filter(x => !has(x, 'D') && /[TQ]/.test(x.j || '')).length)
  const dNoL = O.filter(x => !has(x, 'L')).length, dT = O.filter(x => has(x, 'T')).length, dQ = O.filter(x => has(x, 'Q')).length
  const dW = O.filter(x => won(x) && !/[TQ]/.test(x.j || '')).length, dL = O.filter(x => lost(x) && !/[TQ]/.test(x.j || '')).length
  const dO = Math.max(0, O.length - dT - dQ - dW - dL)
  const tDir = T.filter(x => !has(x, 'L') && !has(x, 'D')).length, qDir = Q.filter(x => !has(x, 'L') && !has(x, 'D')).length
  const tW = T.filter(won).length, tL = T.filter(lost).length, qW = Q.filter(won).length, qL = Q.filter(lost).length
  const sk = <Sankey h={310} cols={[[{ id: 'L', l: 'Leads', c: FC.lead }, { id: 'DD', l: 'Direct deals', c: FC.open }, { id: 'DB', l: 'Direct bids / quotes', c: FC.open }],
    [{ id: 'D', l: 'Deals', c: FC.deal }, { id: 'LX', l: 'Disqualified', c: FC.lost }, { id: 'LO', l: 'Open leads', c: FC.open }],
    [{ id: 'T', l: 'Tenders', c: FC.ten }, { id: 'Q', l: 'Quotes', c: FC.q }, { id: 'DO', l: 'Open deals', c: FC.open }, { id: 'DL', l: 'Deals lost', c: FC.lost }],
    [{ id: 'W', l: 'Won', c: FC.won }, { id: 'X', l: 'Lost', c: FC.lost }, { id: 'P', l: 'In progress', c: FC.open }], [{ id: 'WO', l: 'Work orders', c: FC.wo }]]}
    links={[{ s: 'L', t: 'D', v: lD }, { s: 'L', t: 'LX', v: lX }, { s: 'L', t: 'LO', v: lO }, { s: 'L', t: 'T', v: lT }, { s: 'L', t: 'Q', v: lQ }, { s: 'DD', t: 'D', v: dNoL },
      { s: 'DB', t: 'T', v: tDir }, { s: 'DB', t: 'Q', v: qDir }, { s: 'D', t: 'T', v: dT }, { s: 'D', t: 'Q', v: dQ }, { s: 'D', t: 'DO', v: dO }, { s: 'D', t: 'DL', v: dL }, { s: 'D', t: 'W', v: dW },
      { s: 'T', t: 'W', v: tW }, { s: 'T', t: 'X', v: tL }, { s: 'T', t: 'P', v: T.length - tW - tL }, { s: 'Q', t: 'W', v: qW }, { s: 'Q', t: 'X', v: qL }, { s: 'Q', t: 'P', v: Q.length - qW - qL },
      { s: 'W', t: 'WO', v: Math.min(d.orders.length, tW + qW + dW) }]} />
  // conversion by sales flow
  const flowRows = (k: 'leads' | 'opps' | 'tenders') => (d.flows[k] || []).map(f => { const X = R.filter(x => x.k === k && x.flow === f.key), w = X.filter(won).length, l = X.filter(lost).length
    return { f: f.name, n: X.length, open: X.filter(open).length, cv: pct(w, w + l), v: sum(X, x => x.value) } }).filter(x => x.n)
  // tender ageing: real days in stage (bid profile), amber when any bid in the stage is past its SLA
  const tst: string[] = []; (d.flows.tenders || []).forEach(f => f.stages.forEach(s => { if (s.kind === 'open' && !tst.includes(s.name)) tst.push(s.name) }))
  const age = tst.map(n => { const X = T.filter(x => open(x) && x.stage === n && x.age != null); return { l: n, v: X.length ? Math.round(sum(X, x => x.age || 0) / X.length) : 0, c: X.some(x => x.stuck) ? 'var(--bw-wa)' : 'var(--bw-ok)' } }).filter(x => x.v)
  const reasons: Record<string, number> = {}
  lostD.forEach(x => { const k = x.reason || 'Not recorded'; reasons[k] = (reasons[k] || 0) + x.value })
  const RC = ['#C13B2A', '#B26B00', '#7A4DB8', '#3E63A8', '#9AA8B6']
  const byBiz = Object.entries(R.reduce<Record<string, number>>((m, x) => { m[x.biz] = (m[x.biz] || 0) + x.value; return m }, {}))
  const own = Object.entries(R.filter(open).reduce<Record<string, number>>((m, x) => { m[x.owner] = (m[x.owner] || 0) + x.value; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const subs = Object.entries(R.reduce<Record<string, number>>((m, x) => { m[x.sub] = (m[x.sub] || 0) + x.value; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const mxS = Math.max(...steps.map(x => x.n), 1)

  return <>
    <Strip items={[{ l: 'In funnel', v: R.length.toLocaleString('en-IN'), sp: created }, { l: 'Funnel value', v: inr(sum(R, x => x.value)) }, { l: 'Open value', v: inr(openV) },
      { l: 'Weighted pipeline', v: wV == null ? '—' : inr(wV) }, { l: 'Lead → won', v: L.length ? `${pct(R.filter(x => x.k !== 'leads' && won(x) && (x.j || '').includes('L')).length, L.length)}%` : '—', dc: 'tok', title: 'Won deals, bids and quotes that started as a lead ÷ leads' },
      { l: 'Avg sales cycle', v: cyc == null ? '—' : `${cyc} d` }, { l: 'Velocity / day', v: vel == null ? '—' : inr(vel) }, { l: 'Leakage (lost value)', v: inr(sum(lostAll, x => x.value)), dc: 'tbad' }]} />
    <P icon="route" className="mb" t="Journey flow · where every enquiry goes" act={<><small className="mu">leads, direct deals and direct bids → deals → tenders / quotes → outcome → orders</small><a className="flink fgo" onClick={toFunnel}>Open funnel analysis →</a></>}>{R.length ? sk : <Empty>No records in your funnel yet</Empty>}</P>
    <div className="bw-g g21 mb">
      <P t="Journey funnel" z><div className="fnl3">{steps.map((s, i) => <div key={s.l} className="frow2" role="button" tabIndex={0} onClick={toFunnel}><span className="fl2">{s.l}</span>
        <div className="fbar2" style={{ width: `${Math.max(7, s.n / mxS * 100)}%` }}><b>{s.n}</b><small>{inr(s.v)}</small></div>
        <span className="fc2">{i ? (steps[i - 1].n && s.n <= steps[i - 1].n ? `${Math.round(s.n / steps[i - 1].n * 100)}%` : '—') : '—'}</span></div>)}</div></P>
      <P t="Conversion trend · 6 months"><LineChart h={200} labels={months(today).map(m => m.l)} series={[{ n: 'Leads created', c: FC.lead, v: created }, { n: 'Converted', c: FC.deal, v: conv, fill: false }, { n: 'Deals won', c: FC.won, v: wonM, fill: false }]} /></P>
    </div>
    <P icon="flow" className="mb" t="Conversion by sales flow" act={<small className="mu">every way the company sells, side by side</small>}>
      <div className="flcmp">{([['Lead', 'leads'], ['Deal', 'opps'], ['Tender', 'tenders']] as const).map(([o, k]) => <div key={o}><div className="flch"><b>{o} flows</b></div>
        {flowRows(k).length ? flowRows(k).map(r => <div key={r.f} className="flr"><div className="min-w-0 flex-1"><b>{r.f}</b><small className="mu">{r.n} records · {r.open} open · {inr(r.v)}</small></div><div className="flr-b"><Bar value={r.cv} /></div></div>) : <Empty>No records</Empty>}</div>)}</div>
    </P>
    <div className="bw-g g2 mb">
      <P t="Where we lose · value by reason">{lostD.length ? <Donut f={inr} center={inr(sum(lostD, x => x.value))} caption="lost" data={Object.entries(reasons).map(([l, v], i) => ({ l, v, c: RC[i % 5] }))} /> : <Empty>No lost deals</Empty>}</P>
      <P t="Tender ageing · avg days in stage" act={<small className="mu">amber = past SLA</small>}>{age.length ? <HBars lw={150} vw={50} rows={age.map(a => ({ l: a.l, v: a.v, text: `${a.v} d`, c: a.c }))} /> : <Empty>No open tenders with a recorded stage date</Empty>}</P>
    </div>
    <P icon="layout" className="mb" t="Segment funnel" act={<small className="mu">click a row to drill in</small>} z><Mtx rows={R} dim="segment" lab="Segment" go={go} /></P>
    <div className="bw-g g2 mb">
      <P icon="chart" t="Vertical funnel" z><Mtx rows={R} dim="vertical" lab="Vertical" go={go} /></P>
      <P icon="building" t={<>Customer funnel <small className="mu">· grouped to main customer</small></>} z><Mtx rows={R} dim="customer" lab="Main customer" go={go} /></P>
    </div>
    <div className="bw-g g3">
      <P t="By business model">{byBiz.length ? <Donut f={inr} data={byBiz.map(([l, v]) => ({ l, v }))} /> : <Empty>No records</Empty>}</P>
      <P t="Top owners · open value">{own.length ? <HBars lw={120} vw={84} rows={own.map(([l, v]) => ({ l, v, text: inr(v) }))} /> : <Empty>Nothing open</Empty>}</P>
      <P t="By sub-segment">{subs.length ? <HBars lw={130} vw={84} rows={subs.map(([l, v]) => ({ l, v, text: inr(v) }))} /> : <Empty>No records</Empty>}</P>
    </div>
  </>
}

// prototype mtx(): leads / deals / bids + quotes / won / lost per group, top 8 by deal value
function Mtx({ rows, dim, lab, go }: { rows: Row[]; dim: string; lab: string; go: Go }) {
  const g: Record<string, { l: number; dl: number; b: number; w: number; lo: number; val: number; wv: number }> = {}
  rows.forEach(r => { const v = dimVal(r, dim), x = (g[v] ??= { l: 0, dl: 0, b: 0, w: 0, lo: 0, val: 0, wv: 0 })
    if (r.k === 'leads') x.l++
    if (r.k === 'opps') { x.dl++; x.val += r.value }
    if (r.k === 'tenders' || r.k === 'quotes') x.b++
    if (won(r) && r.k !== 'leads') { x.w++; x.wv += r.value }
    if (lost(r)) x.lo++ })
  const E = Object.entries(g).sort((a, b) => b[1].val - a[1].val).slice(0, 8), mx = Math.max(...E.map(e => e[1].l + e[1].dl), 1)
  if (!E.length) return <Empty>No records</Empty>
  return <div className="fmx-w"><table className="w-full text-left fmx">
    <thead><tr><th>{lab}</th><th className="text-right">Leads</th><th className="text-right">Deals</th><th className="text-right">Bids + quotes</th><th className="text-right">Won</th><th className="text-right">Lost</th><th>Lead → won</th><th className="text-right">Pipeline</th><th className="text-right">Won value</th></tr></thead>
    <tbody>{E.map(([n, x]) => <tr key={n} className="cursor-pointer" onClick={() => go(dim, n)} title={`Open the funnel for ${n}`}>
      <td><b title={n}>{n.length > 30 ? n.slice(0, 28) + '…' : n}</b><div className="mini"><i style={{ width: `${x.l / mx * 100}%`, background: FC.lead }} /><i style={{ width: `${x.dl / mx * 100}%`, background: FC.deal }} /><i style={{ width: `${x.b / mx * 100}%`, background: FC.ten }} /><i style={{ width: `${x.w / mx * 100}%`, background: FC.won }} /></div></td>
      <td className="text-right tabular-nums">{x.l}</td><td className="text-right tabular-nums">{x.dl}</td><td className="text-right tabular-nums">{x.b}</td>
      <td className="text-right tabular-nums tok">{x.w}</td><td className="text-right tabular-nums tbad">{x.lo}</td><td style={{ minWidth: 120 }}><Bar value={pct(x.w, Math.max(x.l, 1))} /></td>
      <td className="text-right tabular-nums">{inr(x.val)}</td><td className="text-right tabular-nums"><b>{inr(x.wv)}</b></td></tr>)}</tbody>
  </table></div>
}

// prototype sankey(): five columns of nodes, links sized by count
type SNode = { id: string; l: string; c: string }
function Sankey({ cols, links, h: H = 300, w: W = 900 }: { cols: SNode[][]; links: { s: string; t: string; v: number }[]; h?: number; w?: number }) {
  const nw = 14, pad = 10, cx = (i: number) => 12 + i * ((W - 24 - nw) / (cols.length - 1))
  const val: Record<string, number> = {}
  cols.flat().forEach(n => { val[n.id] = Math.max(sum(links.filter(l => l.t === n.id), l => l.v), sum(links.filter(l => l.s === n.id), l => l.v)) })
  const sc = Math.min(...cols.map(c => (H - pad * (c.length - 1)) / Math.max(sum(c, n => val[n.id]), 1)))
  const pos: Record<string, { x: number; y: number; h: number; so: number; to: number; c: string; l: string }> = {}
  cols.forEach((c, ci) => { const tot = sum(c, n => val[n.id]) * sc + pad * (c.length - 1); let y = (H - tot) / 2
    c.forEach(n => { pos[n.id] = { x: cx(ci), y, h: Math.max(2, val[n.id] * sc), so: 0, to: 0, c: n.c, l: n.l }; y += pos[n.id].h + pad }) })
  const paths = links.filter(l => l.v > 0 && pos[l.s] && pos[l.t]).map((l, i) => { const a = pos[l.s], b = pos[l.t], w = l.v * sc, y1 = a.y + a.so + w / 2, y2 = b.y + b.to + w / 2
    a.so += w; b.to += w; const x1 = a.x + nw, x2 = b.x, m = (x1 + x2) / 2
    return <path key={i} d={`M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`} stroke={b.c} strokeOpacity={0.28} strokeWidth={Math.max(1, w)} fill="none"><title>{`${a.l} → ${b.l}: ${l.v}`}</title></path> })
  return <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', maxHeight: H * 1.2, overflow: 'visible' }}>{paths}
    {Object.entries(pos).map(([id, p]) => <g key={id}><rect x={p.x} y={p.y} width={nw} height={p.h} rx={4} fill={p.c}><title>{`${p.l}: ${val[id]}`}</title></rect>
      <text x={p.x + (p.x > W / 2 ? -6 : nw + 6)} y={p.y + p.h / 2 + 4} textAnchor={p.x > W / 2 ? 'end' : 'start'} fontSize="11.5" fontWeight="600" fill="var(--bw-tx)"
        style={{ paintOrder: 'stroke', stroke: 'var(--bw-sf)', strokeWidth: 4, strokeLinejoin: 'round' }}>{p.l} <tspan fill="var(--bw-mu)" fontWeight="400">{val[id]}</tspan></text></g>)}</svg>
}

// ── deep-dive (prototype p34 deep()) ─────────────────────────────────────────────────────────────────────────────────────────
function Deep({ d, dim, val }: { d: ModuleData; dim: 'segment' | 'vertical'; val: string }) {
  const navigate = useNavigate()
  const rows = d.rows.filter(x => dimVal(x, dim) === val), st = journeySteps(rows, d.orders.filter(o => dimVal(o, dim) === val)), s = stats(rows), stk = rows.filter(x => x.stuck)
  const other = dim === 'segment' ? 'vertical' : 'segment'
  const g = Object.entries(rows.reduce<Record<string, number>>((m, x) => { const v = dimVal(x, other); m[v] = (m[v] || 0) + x.value; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 7)
  const own = Object.entries(rows.filter(open).reduce<Record<string, number>>((m, x) => { m[x.owner] = (m[x.owner] || 0) + x.value; return m }, {})).sort((a, b) => b[1] - a[1]).slice(0, 7)
  const deals = rows.filter(x => x.k === 'opps'), cust = new Set(rows.map(x => x.customer)).size, mx = Math.max(st[0]?.n || 0, 1)
  const big = rows.filter(open).sort((a, b) => b.value - a.value).slice(0, 8)
  return <>
    <Strip items={[{ l: 'Records', v: s.n }, { l: 'Customers', v: cust }, { l: 'Open value', v: inr(s.ov) }, { l: 'Won value', v: inr(s.wv), dc: 'tok' }, { l: 'Win rate', v: s.w + s.l ? `${s.cv}%` : '—' },
      { l: 'Avg won deal', v: inr(s.w ? s.wv / s.w : 0) }, { l: 'Stuck', v: stk.length, dc: stk.length ? 'tbad' : undefined }]} />
    <div className="bw-g g3 mb">
      <P t={`${val} · journey`}><div className="dfn">{st.map((x, i) => <div key={x.l}><span>{x.l}</span><div><i style={{ width: `${Math.max(4, x.n / mx * 100)}%` }} /></div><b>{x.n}</b><small>{i && st[i - 1].n ? `${Math.min(100, Math.round(x.n / st[i - 1].n * 100))}%` : ''}</small></div>)}</div></P>
      <P t={dim === 'segment' ? 'Which verticals this segment buys' : 'Which customer segments buy this vertical'}>{g.length ? <HBars lw={150} vw={84} rows={g.map(([l, v]) => ({ l, v, text: inr(v) }))} /> : <Empty>No records</Empty>}</P>
      <P t="Open value by owner">{own.length ? <HBars lw={120} vw={84} rows={own.map(([l, v]) => ({ l, v, text: inr(v) }))} /> : <Empty>Nothing open</Empty>}</P>
    </div>
    <div className="bw-g g2 mb">
      <P t="Deals created vs won · 6 months"><LineChart h={170} labels={months(d.today).map(m => m.l)} series={[{ n: 'Created', c: '#2F6FED', v: bm(d.today, deals, x => x.date) }, { n: 'Won', c: '#0FA5A0', v: bm(d.today, deals.filter(won), x => x.closed), fill: false }]} /></P>
      <P t="Biggest open opportunities" z>{big.length ? <div className="bw-list fscroll">{big.map(x => <div key={`${x.k}:${x.id}`}><span className="min-w-0 flex-1"><a className="flink" onClick={() => navigate(LINK[x.k](x.id))}><b>{(x.name || x.ref).slice(0, 40)}</b></a><br />
        <small className="mu">{x.stage} · {x.owner}{x.age != null ? ` · ${x.age} d` : ''}</small></span><b className="tabular-nums">{inr(x.value)}</b></div>)}</div> : <Empty>Nothing open</Empty>}</P>
    </div>
  </>
}

// ── Segment analytics (customer property) ───────────────────────────────────────────────────────────────────────────────────
export function SegmentView({ d }: { d: ModuleData }) {
  const navigate = useNavigate()
  const C = d.customers, O = d.rows.filter(x => x.k === 'opps')
  const by: Record<string, Cust[]> = {}
  C.forEach(c => { (by[c.segment] ??= []).push(c) })
  const st = Object.entries(by).map(([s, L]) => { const ids = new Set(L.map(c => c.id)), op = O.filter(o => o.customer_id != null && ids.has(o.customer_id)), w = op.filter(won), l = op.filter(lost), H = L.filter(c => c.health != null)
    return { s, n: L.length, main: L.filter(c => !c.parent_id).length, rev: sum(L, c => c.revenue), pipe: sum(op.filter(open), o => o.value), wr: pct(w.length, w.length + l.length), avg: w.length ? sum(w, o => o.value) / w.length : 0,
      hl: H.length ? Math.round(sum(H, c => c.health || 0) / H.length) : null, risk: L.filter(c => c.health != null && c.health < 55).length, subs: new Set(L.map(c => c.sub)).size } }).sort((a, b) => b.rev - a.rev || b.n - a.n)
  // deep-dive chips: the customer segments that have funnel records (prototype: every segment – its demo has seven)
  const segs = [...new Set(d.rows.map(x => x.segment))].sort()
  const [deep, setDeep] = useState(segs[0] || '')
  const [sel, setSel] = useState(st[0]?.s || '')
  const SL = by[sel] || [], sub: Record<string, Cust[]> = {}
  SL.forEach(c => { (sub[c.sub] ??= []).push(c) })
  if (!C.length) return <Empty>No customers in your view – Segment analytics needs Customers access.</Empty>
  return <>
    <P icon="layout" className="mb" t="Segment deep-dive" act={<small className="mu">pick one customer segment</small>}>
      <div className="fchips mb">{segs.map(x => <button key={x} type="button" className={`bw-chip ${x === deep ? 'on' : ''}`} onClick={() => setDeep(x)}>{x}</button>)}</div>
      {deep && <Deep d={d} dim="segment" val={deep} />}
    </P>
    <h3 className="fsec">All segments</h3>
    <Note icon="building"><b>Segment</b> describes the <b>customer</b> (who they are) – set on the customer record with its sub-segment. Figures below roll up every customer in the segment.</Note>
    <Strip items={[{ l: 'Segments', v: st.length }, { l: 'Customers', v: C.length }, { l: 'Largest segment', v: st[0]?.s || '—' }, { l: 'Revenue', v: inr(sum(st, x => x.rev)) },
      { l: 'Open pipeline', v: inr(sum(st, x => x.pipe)) }, { l: 'Customers at risk', v: sum(st, x => x.risk), dc: 'tbad' }]} />
    <div className="bw-g g2 mb">
      <P t="Revenue share by segment">{sum(st, x => x.rev) ? <Donut f={inr} center={inr(sum(st, x => x.rev))} caption="revenue" data={st.filter(x => x.rev).map(x => ({ l: x.s, v: x.rev }))} /> : <Empty>No revenue booked in this FY</Empty>}</P>
      <P t="Open pipeline by segment">{st.some(x => x.pipe) ? <HBars lw={170} vw={90} rows={st.filter(x => x.pipe).sort((a, b) => b.pipe - a.pipe).slice(0, 10).map(x => ({ l: x.s, v: x.pipe, text: inr(x.pipe) }))} /> : <Empty>No open pipeline</Empty>}</P>
    </div>
    <P t="Segment scorecard" z><div className="fmx-w fscroll-l"><table className="w-full text-left">
      <thead><tr><th>Segment</th><th className="text-right">Customers</th><th className="text-right">Main customers</th><th className="text-right">Sub-segments</th><th className="text-right">Revenue</th><th className="text-right">Open pipeline</th><th className="text-right">Avg won deal</th><th>Win rate</th><th>Avg health</th><th className="text-right">At risk</th></tr></thead>
      <tbody>{st.map(r => <tr key={r.s}><td><a className="flink" onClick={() => setSel(r.s)}><b>{r.s}</b></a></td><td className="text-right tabular-nums">{r.n}</td><td className="text-right tabular-nums">{r.main}</td><td className="text-right tabular-nums">{r.subs}</td>
        <td className="text-right tabular-nums">{inr(r.rev)}</td><td className="text-right tabular-nums">{inr(r.pipe)}</td><td className="text-right tabular-nums">{inr(r.avg)}</td><td style={{ minWidth: 110 }}><Bar value={r.wr} /></td>
        <td style={{ minWidth: 110 }}>{r.hl == null ? <span className="mu">—</span> : <Bar value={r.hl} />}</td><td className="text-right tabular-nums">{r.risk}</td></tr>)}</tbody>
      <tfoot><tr><td><b>Total</b></td><td className="text-right tabular-nums"><b>{sum(st, x => x.n)}</b></td><td /><td /><td className="text-right tabular-nums"><b>{inr(sum(st, x => x.rev))}</b></td><td className="text-right tabular-nums"><b>{inr(sum(st, x => x.pipe))}</b></td><td colSpan={4} /></tr></tfoot>
    </table></div></P>
    <div className="bw-g g2 mt">
      <P t={`Sub-segments of ${sel}`} z act={<select className="bwd-per fsel" value={sel} onChange={e => setSel(e.target.value)} aria-label="Segment">{st.map(x => <option key={x.s}>{x.s}</option>)}</select>}>
        <table className="w-full text-left"><thead><tr><th>Sub-segment</th><th className="text-right">Customers</th><th className="text-right">Revenue</th><th>Avg health</th></tr></thead>
          <tbody>{Object.entries(sub).map(([s, L]) => { const H = L.filter(c => c.health != null); return { s, n: L.length, rev: sum(L, c => c.revenue), hl: H.length ? Math.round(sum(H, c => c.health || 0) / H.length) : null } }).sort((a, b) => b.rev - a.rev || b.n - a.n)
            .map(r => <tr key={r.s}><td>{r.s}</td><td className="text-right tabular-nums">{r.n}</td><td className="text-right tabular-nums">{inr(r.rev)}</td><td style={{ minWidth: 110 }}>{r.hl == null ? <span className="mu">—</span> : <Bar value={r.hl} />}</td></tr>)}</tbody></table>
      </P>
      <P t={`Top customers in ${sel}`} z><div className="bw-list">{SL.slice().sort((a, b) => b.revenue - a.revenue).slice(0, 8).map(c => <div key={c.id}>
        <span className="min-w-0 flex-1"><a className="flink" onClick={() => navigate(`/customers/${c.id}`)}><b>{c.name}</b></a><br /><small className="mu">{c.sub} · {c.level || '—'}</small></span>
        <span style={{ width: 110 }}>{c.health == null ? <span className="mu">—</span> : <Bar value={c.health} />}</span><b className="tabular-nums">{inr(c.revenue)}</b></div>)}</div></P>
    </div>
  </>
}

// ── Vertical analytics (record property) ────────────────────────────────────────────────────────────────────────────────────
export function VerticalView({ d }: { d: ModuleData }) {
  const R = d.rows, L = R.filter(x => x.k === 'leads'), O = R.filter(x => x.k === 'opps'), Q = R.filter(x => x.k === 'quotes'), T = R.filter(x => x.k === 'tenders')
  const V = [...new Set(R.map(x => x.vertical))]
  const st = V.map(v => { const l = L.filter(x => x.vertical === v), o = O.filter(x => x.vertical === v), q = Q.filter(x => x.vertical === v), t = T.filter(x => x.vertical === v), w = o.filter(won), ls = o.filter(lost), mix: Record<string, number> = {}
    o.forEach(x => { mix[x.biz] = (mix[x.biz] || 0) + 1 })
    return { v, l: l.length, o: o.length, q: q.length, t: t.length, pipe: sum(o.filter(open), x => x.value), qv: sum(q, x => x.value), wv: sum(w, x => x.value),
      conv: pct(l.filter(x => x.converted || /[DTQ]/.test(x.j || '')).length, l.length || 1), wr: pct(w.length, w.length + ls.length), cyc: avgCycle(w),
      mix: Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b} ${n}`).join(' · ') } }).sort((a, b) => b.pipe + b.wv - (a.pipe + a.wv))
  const verts = [...V].sort()
  const [deep, setDeep] = useState(verts[0] || '')
  const m = Math.max(...st.map(y => y.pipe + y.wv), 1)
  if (!R.length) return <Empty>No records in your view yet</Empty>
  return <>
    <P icon="chart" className="mb" t="Vertical deep-dive" act={<small className="mu">pick one business vertical</small>}>
      <div className="fchips mb">{verts.map(x => <button key={x} type="button" className={`bw-chip ${x === deep ? 'on' : ''}`} onClick={() => setDeep(x)}>{x}</button>)}</div>
      {deep && <Deep d={d} dim="vertical" val={deep} />}
    </P>
    <h3 className="fsec">All verticals</h3>
    <Note icon="chart"><b>Vertical</b> describes the <b>business opportunity</b> – set on each lead, deal and quote. One customer can buy across many verticals.</Note>
    <Strip items={[{ l: 'Verticals active', v: st.length }, { l: 'Leads', v: L.length }, { l: 'Deals', v: O.length }, { l: 'Quotes', v: Q.length }, { l: 'Open pipeline', v: inr(sum(st, x => x.pipe)) }, { l: 'Won value', v: inr(sum(st, x => x.wv)), dc: 'tok' }]} />
    <div className="bw-g g2 mb">
      <P t="Pipeline vs won by vertical"><div className="vb">{st.map(x => <div key={x.v} className="vb-r"><span title={x.v}>{x.v}</span><div><i className="p" style={{ width: `${x.pipe / m * 100}%` }} /><i className="w" style={{ width: `${x.wv / m * 100}%` }} /></div><b>{inr(x.pipe + x.wv)}</b></div>)}
        <div className="vb-k"><span><i className="p" />Open pipeline</span><span><i className="w" />Won</span></div></div></P>
      <P t="Lead → deal conversion & win rate"><div className="vb">{st.map(x => <div key={x.v} className="vb-r"><span title={x.v}>{x.v}</span><div className="two"><i className="c" style={{ width: `${x.conv}%` }} /></div><b>{x.conv}% · {x.wr}%</b></div>)}</div>
        <small className="mu">first value = lead conversion · second = deal win rate</small></P>
    </div>
    <P t="Vertical scorecard" z><div className="fmx-w"><table className="w-full text-left">
      <thead><tr><th>Vertical</th><th className="text-right">Leads</th><th className="text-right">Deals</th><th className="text-right">Quotes</th><th className="text-right">Tenders</th><th className="text-right">Quoted value</th><th className="text-right">Open pipeline</th><th className="text-right">Won</th><th>Win rate</th><th className="text-right">Avg cycle</th><th>Business model mix</th></tr></thead>
      <tbody>{st.map(r => <tr key={r.v}><td><b>{r.v}</b></td><td className="text-right tabular-nums">{r.l}</td><td className="text-right tabular-nums">{r.o}</td><td className="text-right tabular-nums">{r.q}</td><td className="text-right tabular-nums">{r.t}</td>
        <td className="text-right tabular-nums">{inr(r.qv)}</td><td className="text-right tabular-nums">{inr(r.pipe)}</td><td className="text-right tabular-nums">{inr(r.wv)}</td><td style={{ minWidth: 110 }}><Bar value={r.wr} /></td>
        <td className="text-right tabular-nums">{r.cyc == null ? '—' : `${r.cyc} d`}</td><td><small>{r.mix || '—'}</small></td></tr>)}</tbody>
      <tfoot><tr><td><b>Total</b></td><td className="text-right tabular-nums"><b>{sum(st, x => x.l)}</b></td><td className="text-right tabular-nums"><b>{sum(st, x => x.o)}</b></td><td className="text-right tabular-nums"><b>{sum(st, x => x.q)}</b></td><td className="text-right tabular-nums"><b>{sum(st, x => x.t)}</b></td>
        <td className="text-right tabular-nums"><b>{inr(sum(st, x => x.qv))}</b></td><td className="text-right tabular-nums"><b>{inr(sum(st, x => x.pipe))}</b></td><td className="text-right tabular-nums"><b>{inr(sum(st, x => x.wv))}</b></td><td colSpan={3} /></tr></tfoot>
    </table></div></P>
  </>
}

// ── Customer analytics (grouped to the main customer) ───────────────────────────────────────────────────────────────────────
export function CustomerView({ d }: { d: ModuleData }) {
  const navigate = useNavigate()
  const C = d.customers, O = d.rows.filter(x => x.k === 'opps')
  const roots = C.filter(c => !c.parent_id)
  const rs = roots.map(r => { const F = C.filter(c => c.root_id === r.id), ids = new Set(F.map(c => c.id)), o = O.filter(x => x.customer_id != null && ids.has(x.customer_id)), w = o.filter(won), l = o.filter(lost)
    return { id: r.id, n: r.name, ent: F.length || 1, seg: r.segment, rev: sum(F, c => c.revenue), pipe: sum(o.filter(open), x => x.value), wv: sum(w, x => x.value), wr: pct(w.length, w.length + l.length),
      hl: r.health, kam: r.kam || '—', verts: new Set(o.map(x => x.vertical).filter(v => v !== 'Unmapped')).size } }).sort((a, b) => b.rev - a.rev || b.pipe - a.pipe)
  const tot = sum(rs, x => x.rev)
  let cum = 0
  const par = rs.slice(0, 12).map(x => { cum += x.rev; return { l: x.n.replace(/\s*–.*$/, '').slice(0, 18), v: tot ? Math.round(cum / tot * 100) : 0 } })
  const top10 = tot ? pct(sum(rs.slice(0, 10), x => x.rev), tot) : 0, risk = rs.filter(x => x.hl != null && x.hl < 55)
  const mxR = Math.max(...rs.map(y => y.rev), 1)
  if (!C.length) return <Empty>No customers in your view – Customer analytics needs Customers access.</Empty>
  return <>
    <Note icon="building">Grouped to the <b>main customer</b> – every LHO, zone, division and branch rolls up into its head office.</Note>
    <Strip items={[{ l: 'Main customers', v: rs.length }, { l: 'Entities', v: C.length }, { l: 'Top-10 revenue share', v: tot ? `${top10}%` : '—', dc: top10 > 70 ? 'twarn' : undefined },
      { l: 'Avg revenue / customer', v: inr(tot / Math.max(rs.length, 1)) }, { l: 'At risk (health < 55)', v: risk.length, dc: 'tbad' }, { l: 'Multi-vertical buyers', v: rs.filter(x => x.verts > 1).length }]} />
    <div className="bw-g g2 mb">
      <P t="Revenue concentration (cumulative %)" act={<small className="mu">how fast the top customers reach 80%</small>}>{tot ? <HBars lw={140} vw={46} rows={par.map(p => ({ l: p.l, v: p.v, text: `${p.v}%` }))} /> : <Empty>No revenue booked in this FY</Empty>}</P>
      <P t="Health vs revenue"><div className="sc">{rs.filter(x => x.hl != null).slice(0, 30).map(x => <i key={x.id} title={`${x.n} · health ${x.hl} · ${inr(x.rev)}`}
        style={{ left: `${x.hl}%`, bottom: `${Math.min(96, x.rev / mxR * 96)}%`, background: (x.hl || 0) < 55 ? 'var(--bw-ba)' : (x.hl || 0) < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)' }} />)}<span className="sx">health →</span><span className="sy">revenue ↑</span></div></P>
    </div>
    <P t="Customer scorecard" z><div className="fmx-w fscroll-l"><table className="w-full text-left">
      <thead><tr><th>Main customer</th><th>Segment</th><th className="text-right">Entities</th><th className="text-right">Verticals bought</th><th className="text-right">Revenue</th><th className="text-right">Open pipeline</th><th className="text-right">Won</th><th>Win rate</th><th>Health</th><th>KAM</th></tr></thead>
      <tbody>{rs.map(r => <tr key={r.id}><td><a className="flink" onClick={() => navigate(`/customers/${r.id}`)}><b>{r.n}</b></a></td><td>{r.seg}</td><td className="text-right tabular-nums">{r.ent}</td><td className="text-right tabular-nums">{r.verts}</td>
        <td className="text-right tabular-nums">{inr(r.rev)}</td><td className="text-right tabular-nums">{inr(r.pipe)}</td><td className="text-right tabular-nums">{inr(r.wv)}</td><td style={{ minWidth: 110 }}><Bar value={r.wr} /></td>
        <td style={{ minWidth: 110 }}>{r.hl == null ? <span className="mu">—</span> : <Bar value={r.hl} />}</td><td>{r.kam}</td></tr>)}</tbody>
      <tfoot><tr><td><b>Total</b></td><td /><td /><td /><td className="text-right tabular-nums"><b>{inr(tot)}</b></td><td className="text-right tabular-nums"><b>{inr(sum(rs, x => x.pipe))}</b></td><td className="text-right tabular-nums"><b>{inr(sum(rs, x => x.wv))}</b></td><td colSpan={3} /></tr></tfoot>
    </table></div></P>
  </>
}

// ── Leadership ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function LeadershipView({ d }: { d: ModuleData }) {
  const O = d.rows.filter(x => x.k === 'opps'), op = O.filter(open), w = O.filter(won), l = O.filter(lost)
  const inFy = (v: string | null) => !!v && (!d.fy_start || v >= d.fy_start) && (!d.fy_end || v <= d.fy_end)
  const wFy = w.filter(x => inFy(x.closed)), wv = sum(wFy, x => x.value)
  // target: the team's sales targets for the FY (Field Sales 360); a leader can try another figure here (not saved)
  const [tgtCr, setTgtCr] = useState<string>(d.target ? String(Math.round(d.target / 1e7 * 100) / 100) : '')
  const tgt = Number(tgtCr) > 0 ? Number(tgtCr) * 1e7 : 0
  const { commit: cm, best: bc } = d.thresholds
  const commit = sum(op.filter(o => (o.prob ?? -1) >= cm), o => o.value), best = sum(op.filter(o => (o.prob ?? -1) >= bc), o => o.value)
  const known = op.filter(o => o.prob != null), wtd = known.length ? sum(known, o => o.value * (o.prob || 0) / 100) : null
  const gap = tgt ? Math.max(0, tgt - wv) : 0, cov = gap ? Math.round(sum(op, o => o.value) / gap * 10) / 10 : null
  const own: Record<string, { n: string; o: number; w: number; l: number; wv: number; pipe: number }> = {}
  O.forEach(o => { const x = (own[o.owner] ??= { n: o.owner, o: 0, w: 0, l: 0, wv: 0, pipe: 0 }); x.o++; if (won(o)) { x.w++; x.wv += o.value } if (lost(o)) x.l++; if (open(o)) x.pipe += o.value })
  const OW = Object.values(own).map(x => ({ ...x, wr: pct(x.w, x.w + x.l) })).sort((a, b) => b.wv - a.wv)
  const segOf = (r: Row) => r.segment
  // rows: customer segments that have deals (a tenant's full segment master would be mostly empty rows)
  const segs = [...new Set(O.map(segOf))], verts = [...new Set(O.map(x => x.vertical))]
  const mxC = Math.max(1, sum(O, o => o.value) / 6)
  const reasons: Record<string, number> = {}
  l.forEach(o => { const k = o.reason || 'Not recorded'; reasons[k] = (reasons[k] || 0) + 1 })
  const aging: [string, number][] = [['0–30 d', 0], ['31–60 d', 0], ['61–90 d', 0], ['90+ d', 0]]
  op.forEach(o => { const a = daysAgo(o.date, d.today); if (a == null) return; aging[a <= 30 ? 0 : a <= 60 ? 1 : a <= 90 ? 2 : 3][1] += o.value })
  const RC = ['#E5484D', '#F29A2E', '#8B5CF6', '#2F6FED', '#64748B']
  const wonM = bm(d.today, w, x => x.closed, x => x.value / 1e5)
  return <>
    <Strip items={[{ l: 'Target (FY)', v: tgt ? inr(tgt) : '—', title: d.fy ? `Sales target for ${d.fy}` : undefined }, { l: 'Won so far', v: inr(wv), dc: 'tok' }, { l: 'Gap to target', v: tgt ? inr(gap) : '—', dc: tgt ? (gap ? 'twarn' : 'tok') : undefined },
      { l: 'Pipeline coverage', v: cov == null ? '—' : `${cov}×`, dc: cov == null ? undefined : cov >= 3 ? 'tok' : cov >= 2 ? 'twarn' : 'tbad' },
      { l: `Commit (≥${cm}%)`, v: inr(commit) }, { l: `Best case (≥${bc}%)`, v: inr(best) }, { l: 'Weighted forecast', v: wtd == null ? '—' : inr(wtd) }, { l: 'Win rate', v: w.length + l.length ? `${pct(w.length, w.length + l.length)}%` : '—' }]} />
    <div className="bw-g g3 mb">
      <P t="Forecast to target">{tgt ? <><div className="ft2">{([['Won', wv, 'var(--bw-ok)'], ['Commit', commit, 'var(--bw-ac)'], ['Best case', Math.max(0, best - commit), 'color-mix(in srgb, var(--bw-ac) 45%, #fff)']] as const).map(([n, v, c]) =>
        <i key={n} style={{ width: `${Math.min(100, v / tgt * 100)}%`, background: c }} title={`${n}: ${inr(v)}`} />)}<em style={{ left: '100%' }} /></div>
        <div className="fleg"><span><i className="fdot" style={{ background: 'var(--bw-ok)' }} /> Won</span><span><i className="fdot" style={{ background: 'var(--bw-ac)' }} /> Commit</span><span><i className="fdot" style={{ background: 'color-mix(in srgb, var(--bw-ac) 45%, #fff)' }} /> Best case</span></div></>
        : <Empty>No sales target set for this FY – enter one below, or set KAM targets in Field Sales 360</Empty>}
        <div className="ftgt"><label className="mu">Target</label><input className="bwd-per" type="number" min={0} step="0.01" value={tgtCr} onChange={e => setTgtCr(e.target.value)} style={{ width: 90 }} aria-label="Target in crore" /><small className="mu">Cr</small></div>
      </P>
      <P t="Open pipeline ageing" act={<small className="mu">older = riskier</small>}><HBars lw={70} vw={84} rows={aging.map(([l, v]) => ({ l, v, text: inr(v) }))} /></P>
      <P t="Why we lose">{l.length ? <Donut f={v => String(v)} center={String(l.length)} caption="lost deals" data={Object.entries(reasons).map(([k, v], i) => ({ l: k, v, c: RC[i % 5] }))} /> : <Empty>No lost deals</Empty>}</P>
    </div>
    <div className="bw-g g2 mb">
      <P t="Won value · 6 months (₹ lakh)"><Columns h={190} vals f={v => String(Math.round(v * 10) / 10)} data={months(d.today).map((m, i) => ({ l: m.l, v: wonM[i] }))} /></P>
      <P t="Deals created vs won · 6 months"><LineChart h={190} labels={months(d.today).map(m => m.l)} series={[{ n: 'Created', c: '#2F6FED', v: bm(d.today, O, x => x.date) }, { n: 'Won', c: '#0FA5A0', v: bm(d.today, w, x => x.closed), fill: false }]} /></P>
    </div>
    <P t="Segment (customer) × Vertical (deal) · count and value of deals" act={<small className="mu">where each customer segment buys</small>} z>
      {O.length ? <div className="fmx-w"><table className="w-full text-left hmx"><thead><tr><th />{verts.map(v => <th key={v} className="c" title={v}>{v.length > 14 ? v.slice(0, 13) + '…' : v}</th>)}</tr></thead>
        <tbody>{segs.map(s => <tr key={s}><td><b>{s}</b></td>{verts.map(v => { const X = O.filter(o => o.segment === s && o.vertical === v), val = sum(X, o => o.value)
          return <td key={v} className="c" style={{ background: `color-mix(in srgb, var(--bw-ac) ${Math.min(65, val / mxC * 65)}%, transparent)` }}>{X.length ? <><b>{X.length}</b><br /><small>{inr(val)}</small></> : <span className="mu">·</span>}</td> })}</tr>)}</tbody></table></div>
        : <Empty>No deals in your view</Empty>}
    </P>
    <div className="mt"><P t="Owner leaderboard" z><table className="w-full text-left">
      <thead><tr><th>Owner</th><th className="text-right">Deals</th><th className="text-right">Open pipeline</th><th className="text-right">Won</th><th className="text-right">Won value</th><th>Win rate</th></tr></thead>
      <tbody>{OW.map(r => <tr key={r.n}><td><span className="fown"><Avatar name={r.n} size={20} /> {r.n}</span></td><td className="text-right tabular-nums">{r.o}</td><td className="text-right tabular-nums">{inr(r.pipe)}</td>
        <td className="text-right tabular-nums">{r.w}</td><td className="text-right tabular-nums">{inr(r.wv)}</td><td style={{ minWidth: 110 }}><Bar value={r.wr} /></td></tr>)}
        {!OW.length && <tr><td colSpan={6}><Empty>No deals in your view</Empty></td></tr>}</tbody></table></P></div>
  </>
}
