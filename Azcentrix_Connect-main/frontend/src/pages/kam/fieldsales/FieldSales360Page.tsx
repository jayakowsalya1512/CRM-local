// Field Sales 360 – prototype v17 R.kam: crumb "Key account management" · "Field Sales 360" · (KAM 360: KAM selector) ·
// + Log activity, then the tabs: Team overview · Commitments (prototype v18, KT.splice(1, 0, 'Commitments'); its header adds
// New commitment) · KAM 360 · Visits & check-ins · Customer coverage · Activity analytics · Targets · Territories. Every figure comes from /api/v1/field-sales (see field_sales_service.py for the sources).
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip } from 'react-leaflet'
import { KAM_MAP_CENTER, KAM_MAP_BOUNDS, KAM_MAP_TILE_URL, KAM_MAP_TILE_OPTIONS } from '@/pages/kam/kam360/MapSection'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, Bars, Donut, Funnel, HBars, Line, Panel, Pill, Tbl } from '@/pages/customers/kit'
import { errMsg, fd, inr } from '@/pages/customers/customerApi'
import CommitmentsTab from '@/pages/commitments/CommitmentsTab'
import { captureGps, fsApi, short, shortNames, KT, OUTCOMES, TYPES, type Analytics, type Coverage, type Kam360, type MapPt, type Meta, type Tab, type Targets, type Team, type Territories, type VisitRow, type Visits } from './fieldSalesApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './fs360.css'

const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']
const TAB_KEY: Record<Tab, string> = { 'Team overview': 'team', Commitments: 'commitments', 'KAM 360': 'kam', 'Visits & check-ins': 'visits', 'Customer coverage': 'coverage', 'Activity analytics': 'analytics', Targets: 'targets', Territories: 'territories' }
const KEY_TAB: Record<string, Tab> = { ...Object.fromEntries(Object.entries(TAB_KEY).map(([t, k]) => [k, t as Tab])), '360': 'KAM 360' }
const OUT_TONE: Record<string, string> = { Positive: 'ok', Neutral: 'mu', Negative: 'ba', 'Follow-up': 'wa' }
const dd = (iso: string) => iso.slice(8)

// ─── prototype helpers: strip() with sparkline, heat(), mapSvg(), user cell, jchip() ───────────────────────────────
type K = { l: string; v: ReactNode; d?: ReactNode; dc?: string; sp?: number[]; na?: boolean; title?: string }
function Spark({ v, c }: { v: number[]; c: string }) {
  const id = useId().replace(/:/g, '')
  if (!v || v.length < 2) return null
  const mx = Math.max(...v), mn = Math.min(...v), W = 96, H = 28
  const pts = v.map((x, i) => [i * W / (v.length - 1), H - 4 - (x - mn) / ((mx - mn) || 1) * (H - 10)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return <svg className="sp" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".28" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
    <path d={`${d} L${W} ${H} L0 ${H}Z`} fill={`url(#${id})`} /><path d={d} fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={last[0]} cy={last[1]} r="2.4" fill={c} /></svg>
}
function Strip({ items }: { items: K[] }) {
  return <div className="strip">{items.map(x => <div key={x.l} className={`st ${x.dc || ''} ${x.sp ? 'has-sp' : ''}`} title={x.title}>
    <div className="sth"><label>{x.l}</label>{x.sp && <span className="spw"><Spark v={x.sp} c={x.dc === 'tbad' ? 'var(--bw-ba)' : x.dc === 'twarn' ? 'var(--bw-wa)' : x.dc === 'tok' ? 'var(--bw-ok)' : 'var(--bw-ac)'} /></span>}</div>
    <b className={x.na ? 'na' : ''}>{x.v}</b>{x.d != null && x.d !== '' && <i className={x.dc || ''}>{x.d}</i>}
  </div>)}</div>
}
function Heat({ rows, cols, v, t }: { rows: string[]; cols: string[]; v: (i: number, j: number) => number; t: (i: number, j: number) => string }) {
  if (!rows.length) return <div className="empty">Nothing to show</div>
  return <div className="hmw"><div className="hm" style={{ gridTemplateColumns: `90px repeat(${cols.length}, minmax(14px, 1fr))` }}><span />
    {cols.map((c, j) => <small key={j} className="c">{c}</small>)}
    {rows.map((r, i) => <div key={i} style={{ display: 'contents' }}><small style={{ lineHeight: '13px' }} title={r}>{r}</small>
      {cols.map((_, j) => <i key={j} style={{ ['--v' as string]: v(i, j) }} title={t(i, j)} />)}</div>)}
  </div></div>
}
// Real Leaflet map (OpenStreetMap tiles), panned/zoomed and bounded so only India is ever
// visible — same India-only technique (center + maxBounds) as MapSection.tsx's customer map.
// Previously this was a hand-drawn SVG polygon standing in for India, not an actual map.
function VisitMap({ pts, empty }: { pts: MapPt[]; empty: string }) {
  return <div className="fsmap-wrap" style={{ position: 'relative', height: 320, borderRadius: 10, overflow: 'hidden' }}>
    <MapContainer center={KAM_MAP_CENTER} zoom={5} minZoom={4} maxZoom={12} scrollWheelZoom={false} zoomControl
      maxBounds={KAM_MAP_BOUNDS} maxBoundsViscosity={0.9} attributionControl={false} style={{ height: '100%', width: '100%' }}>
      <TileLayer url={KAM_MAP_TILE_URL} {...KAM_MAP_TILE_OPTIONS} />
      {pts.map((p, i) => {
        const c = PAL[i % PAL.length], n = Math.min(4, p.n)
        return <CircleMarker key={p.l} center={[p.la, p.lo]} radius={5 + n * 2} pathOptions={{ color: c, fillColor: c, fillOpacity: .55, weight: 1.5 }}>
          <LeafletTooltip direction="top" offset={[0, -6]} opacity={1}>
            {p.l}: {p.n} check-in{p.n === 1 ? '' : 's'}{p.gps ? ` · ${p.gps} GPS-verified` : ''}{p.src === 'city' ? ' (plotted at the customer city)' : ''}
          </LeafletTooltip>
        </CircleMarker>
      })}
    </MapContainer>
    {!pts.length && <div className="fsmap-note" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 500 }}>{empty}</div>}
  </div>
}
const User = ({ n }: { n: string }) => <span className="avn"><Av name={n} />{n}</span>
const Bar = ({ v }: { v: number | null | undefined }) => v == null ? <span className="mu">—</span> : <BarPct v={v} />
function Loading({ err, retry }: { err?: string | null; retry?: () => void }) {
  return <div className="panel"><div className={err ? 'err-box' : 'empty'}>{err ? <>{err} {retry && <button type="button" className="btn s" onClick={retry}>Retry</button>}</> : 'Loading…'}</div></div>
}
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [d, setD] = useState<T | null>(null), [err, setErr] = useState<string | null>(null), [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setErr(null)
    fn().then(r => { if (alive) setD(r) }).catch(e => { if (alive) setErr(errMsg(e, 'Could not load Field Sales 360')) })
    return () => { alive = false }
  }, [...deps, n]) // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, retry: () => setN(x => x + 1) }
}

// ─── page ──────────────────────────────────────────────────────────────────────────────────────────────────────
export default function FieldSales360Page() {
  const navigate = useNavigate()
  const loc = useLocation()
  const [sp, setSp] = useSearchParams()
  const { error } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [ver, setVer] = useState(0)
  const [cmNew, setCmNew] = useState(0)

  // Older deep links into /kam keep working: ?new=activity opens the composer; the footer timer goes to the classic form.
  useEffect(() => {
    if (sp.get('logTimer') === '1') { navigate(`/kam/activities${loc.search}`, { replace: true }); return }
    if (sp.get('new') === 'activity') navigate('/kam/log', { replace: true, state: { back: '/kam' } })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMeta = useCallback(() => { setMetaErr(null); fsApi.meta().then(setMeta).catch(e => setMetaErr(errMsg(e, 'Could not load Field Sales 360'))) }, [])
  useEffect(loadMeta, [loadMeta])

  const tab: Tab = KEY_TAB[sp.get('tab') || ''] || (sp.get('kam') ? 'KAM 360' : KT[0])
  const L = meta?.kams || []
  const want = Number(sp.get('kam')) || 0
  const sel = L.find(k => k.id === want)?.id ?? L.find(k => k.id === meta?.me.id)?.id ?? L[0]?.id ?? null
  const go = (t: Tab, kam?: number) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', TAB_KEY[t]); if (kam) n.set('kam', String(kam)); if (t !== 'Commitments') ['cmv', 'cmp', 'cmw', 'cmt'].forEach(k => n.delete(k)); return n })
  const logActivity = () => navigate('/kam/log', { state: { back: `/kam${loc.search}`, kam: tab === 'KAM 360' ? sel : undefined } })
  const open360 = (id: number | null) => { if (id) navigate(`/customers/${id}`) }
  const openDeal = (id: number) => navigate(`/opportunities?open=${id}`)
  const bump = () => setVer(v => v + 1)

  const body = !meta ? <Loading err={metaErr} retry={loadMeta} />
    : tab === 'Commitments' ? <CommitmentsTab newNonce={cmNew} />
    : !L.length ? <div className="panel"><div className="empty">No KAMs in this scope</div></div>
    : tab === 'Team overview' ? <TeamTab ver={ver} onKam={id => go('KAM 360', id)} />
    : tab === 'KAM 360' ? (sel ? <Kam360Tab key={sel} id={sel} ver={ver} can={meta.can.create} onLog={logActivity} open360={open360} openDeal={openDeal} /> : null)
    : tab === 'Visits & check-ins' ? <VisitsTab ver={ver} canExport={meta.can.export} canCheck={meta.can.update} open360={open360} onChanged={bump} onError={error} />
    : tab === 'Customer coverage' ? <CoverageTab ver={ver} open360={open360} />
    : tab === 'Activity analytics' ? <AnalyticsTab ver={ver} />
    : tab === 'Targets' ? <TargetsTab ver={ver} onSaved={bump} />
    : <TerritoriesTab ver={ver} />

  return <div className="bwi fs360">
    <div className="pg"><div><div className="crumb">Key account management</div><h1>Field Sales 360</h1></div><span className="fl" />
      {tab === 'KAM 360' && L.length > 0 && <select className="in" style={{ width: 200 }} value={sel ?? ''} aria-label="KAM" onChange={e => go('KAM 360', Number(e.target.value))}>
        {L.map(k => <option key={k.id} value={k.id} title={[k.designation, k.branch, k.manager && `Reports to ${k.manager}`].filter(Boolean).join(' · ')}>{k.name}</option>)}</select>}
      {tab === 'Commitments' && meta && (meta.can.create || meta.can.update) && <button type="button" className="btn" onClick={() => setCmNew(n => n + 1)}><Ic n="target" /> New commitment</button>}
      {meta?.can.create && <button type="button" className="btn p" onClick={logActivity}><Ic n="plus" /> Log activity</button>}
    </div>
    <div className="tabs mb" role="tablist">{KT.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`}
      onClick={() => go(t, t === 'KAM 360' && sel ? sel : undefined)} onKeyDown={e => { if (e.key === 'Enter') go(t) }}>{t}</div>)}</div>
    {body}
  </div>
}

// ─── Team overview ────────────────────────────────────────────────────────────────────────────────────────────────
function TeamTab({ ver, onKam }: { ver: number; onKam: (id: number) => void }) {
  const { d, err, retry } = useLoad<Team>(fsApi.team, [ver])
  if (!d) return <Loading err={err} retry={retry} />
  const k = d.kpis
  const board = [...d.scoreboard].sort((a, b) => (b.target ? b.won / b.target : -1) - (a.target ? a.won / a.target : -1))
  return <>
    <Strip items={[
      { l: 'Team target', v: inr(k.target), title: `Sum of ${d.fy} annual targets` },
      { l: 'Achieved', v: inr(k.won), d: k.attain != null ? `${k.attain}%` : '', dc: 'tok', title: `Closed-won deal value in ${d.fy}` },
      { l: 'Pipeline', v: inr(k.pipe) },
      { l: 'Activities · 14 d', v: k.acts, sp: k.spark },
      { l: 'Site visits', v: k.visits },
      { l: 'Customers covered', v: `${k.covered} / ${k.customers}`, title: 'Customers with an activity in the last 14 days / customers assigned to these KAMs' },
    ]} />
    <div className="g g2 mb">
      <Panel title="Visit map · check-ins by city"><VisitMap pts={d.map} empty="No site-visit check-ins in the last 14 days." /></Panel>
      <Panel title="Team scoreboard" z><Tbl rows={board} onRow={x => onKam(x.id)} cols={[
        { k: 'n', t: 'KAM', fn: x => <User n={x.name} /> },
        { k: 'a', t: 'Target', fn: x => <Bar v={x.attain} /> },
        { k: 'acts', t: 'Activities', r: true }, { k: 'visits', t: 'Visits', r: true },
        { k: 'wr', t: 'Win %', fn: x => x.wr == null ? '—' : `${x.wr}%` },
      ]} /></Panel>
    </div>
    <Panel title="Activity heat-map · last 14 days"><Heat rows={shortNames(d.scoreboard.map(x => x.name))} cols={d.days.map(dd)}
      v={(i, j) => Math.min(100, d.heat[i][j] ? d.heat[i][j] * 35 + 6 : 0)} t={(i, j) => `${d.scoreboard[i].name} ${fd(d.days[j])}: ${d.heat[i][j]} activit${d.heat[i][j] === 1 ? 'y' : 'ies'}`} /></Panel>
  </>
}

// ─── KAM 360 ──────────────────────────────────────────────────────────────────────────────────────────────────
function JChip({ j, onOpen }: { j: { id: string; steps: { done: boolean }[] }; onOpen: () => void }) {
  return <><a onClick={e => { e.stopPropagation(); onOpen() }}><span className="pill ac">{j.id}</span></a> <small className="mu">{j.steps.map(s => s.done ? '●' : '○').join('')}</small></>
}
function Kam360Tab({ id, ver, can, onLog, open360, openDeal }: { id: number; ver: number; can: boolean; onLog: () => void; open360: (id: number | null) => void; openDeal: (id: number) => void }) {
  const { d, err, retry } = useLoad<Kam360>(() => fsApi.kam(id), [id, ver])
  if (!d) return <Loading err={err} retry={retry} />
  const s = d.stats, a = s.attain
  return <>
    <Strip items={[
      { l: 'FY target', v: inr(s.target) },
      { l: 'Achieved', v: inr(s.won), d: a != null ? `${Math.round(a)}%` : '', dc: a != null && a > 70 ? 'tok' : 'twarn' },
      { l: 'Open pipeline', v: inr(s.pipe) },
      { l: 'Win rate', v: s.wr == null ? '—' : `${s.wr}%`, na: s.wr == null, title: 'Won ÷ (won + lost) deals' },
      { l: 'Customers', v: s.accts },
      { l: 'Activities · 14 d', v: s.acts, sp: d.spark },
    ]} />
    <div className="g g3 mb">
      <Panel title="Sales journey"><Funnel d={d.journey} /></Panel>
      <Panel title="Activity by type"><Donut d={d.by_type} /></Panel>
      <Panel title="Activities · 14 days"><Bars d={d.days.map((x, i) => ({ l: dd(x), v: d.daily[i] }))} h={120} f={v => String(Math.round(v * 10) / 10)} /></Panel>
    </div>
    <div className="g g2 mb">
      <Panel title="Customers owned" z><Tbl rows={d.customers} empty="No customers assigned" cols={[
        { k: 'name', t: 'Customer', fn: c => <a onClick={() => open360(c.id)}>{c.name}</a> },
        { k: 'tier', t: 'Tier' }, { k: 'revenue', t: 'Revenue', r: true, fn: c => inr(c.revenue) },
        { k: 'health', t: 'Health', fn: c => <BarPct v={c.health} /> },
        { k: 'v', t: 'Last visit', fn: c => c.last_visit ? fd(c.last_visit) : <span className="tba">never</span> },
      ]} /></Panel>
      <Panel title="Open deals & bids" z><Tbl rows={d.deals} onRow={o => openDeal(o.id)} empty="No open deals" cols={[
        { k: 'name', t: 'Deal', fn: o => o.name.slice(0, 34) }, { k: 'value', t: 'Value', r: true, fn: o => inr(o.value) },
        { k: 'stage', t: 'Stage', fn: o => <Pill s={o.stage} /> }, { k: 'jid', t: 'Journey', fn: o => <JChip j={o.journey} onOpen={() => openDeal(o.id)} /> },
      ]} /></Panel>
    </div>
    <Panel title="Activity log" z act={can ? <button type="button" className="btn s p" onClick={onLog}><Ic n="plus" /> Log activity</button> : undefined}>
      <Tbl rows={d.log} empty="No activities logged yet" cols={[
        { k: 'date', t: 'Date', fn: x => fd(x.date) }, { k: 'time', t: 'Time', fn: x => x.time || '—' },
        { k: 'type', t: 'Type', fn: x => <Pill s={x.type} t="ac" /> },
        { k: 'customer', t: 'Customer', fn: x => x.customer_id ? <a onClick={() => open360(x.customer_id)}>{x.customer}</a> : x.customer },
        { k: 'note', t: 'Notes', fn: x => <span title={x.notes}>{x.notes}</span> },
        { k: 'outcome', t: 'Outcome', fn: x => x.outcome ? <Pill s={x.outcome} t={OUT_TONE[x.outcome] || 'inf'} /> : <span className="mu">—</span> },
      ]} /></Panel>
  </>
}

// ─── Visits & check-ins ───────────────────────────────────────────────────────────────────────────────────────
function VisitsTab({ ver, canExport, canCheck, open360, onChanged, onError }: { ver: number; canExport: boolean; canCheck: boolean; open360: (id: number | null) => void; onChanged: () => void; onError: (t: string, m?: string) => void }) {
  const { success } = useToast()
  const { d, err, retry } = useLoad<Visits>(fsApi.visits, [ver])
  const [busy, setBusy] = useState<number | null>(null)
  const [out, setOut] = useState<VisitRow | null>(null)
  const checkIn = async (r: VisitRow) => {
    setBusy(r.id)
    try {
      const g = await captureGps()
      await fsApi.checkIn(r.id, g.gps, g.perm)
      success('Checked in', g.gps ? 'Location captured for this visit' : 'Location not available – check-in recorded as Manual')
      onChanged()
    } catch (e) { onError('Check-in failed', errMsg(e)) } finally { setBusy(null) }
  }
  const cols = useMemo<GridCol<VisitRow>[]>(() => [
    { k: 'date', t: 'Date', w: 100, date: true, fn: a => fd(a.date), txt: a => a.date },
    { k: 'check_in', t: 'Check-in', w: 80, fn: a => a.status === 'Planned'
      ? (a.mine && canCheck ? <button type="button" className="btn xs p" disabled={busy === a.id} onClick={e => { e.stopPropagation(); checkIn(a) }}>{busy === a.id ? '…' : 'Check in'}</button> : <span className="mu">Planned</span>)
      : (a.check_in || '—'), txt: a => a.check_in || '' },
    { k: 'kam', t: 'KAM', w: 170, fn: a => <User n={a.kam} />, txt: a => a.kam },
    { k: 'customer', t: 'Customer', w: 200, fn: a => a.customer_id ? <a onClick={e => { e.stopPropagation(); open360(a.customer_id) }}>{a.customer}</a> : a.customer, txt: a => a.customer },
    { k: 'loc', t: 'Location', w: 120, fn: a => a.location || '—', txt: a => a.location },
    { k: 'dur', t: 'Duration', w: 90, fn: a => a.status === 'In Progress'
      ? (a.mine && canCheck ? <button type="button" className="btn xs" onClick={e => { e.stopPropagation(); setOut(a) }}>Check out</button> : <span className="mu">In progress</span>)
      : a.duration != null ? `${a.duration} min` : <span className="mu" title="No check-in / check-out recorded">—</span>, txt: a => a.duration != null ? String(a.duration) : '' },
    { k: 'gps', t: 'GPS', w: 90, fn: a => a.gps === 'verified' ? <Pill s="Verified" t="ok" /> : a.gps ? <Pill s="Manual" t="wa" /> : <span className="mu">—</span>, txt: a => a.gps === 'verified' ? 'Verified' : a.gps ? 'Manual' : '' },
    { k: 'note', t: 'Notes', w: 300, fn: a => <span title={a.notes}>{a.notes}</span>, txt: a => a.notes },
    { k: 'outcome', t: 'Outcome', w: 100, fn: a => a.outcome ? <Pill s={a.outcome} t={OUT_TONE[a.outcome] || 'inf'} /> : <span className="mu">—</span>, txt: a => a.outcome || '' },
  ], [busy, canCheck]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Loading err={err} retry={retry} />
  const k = d.kpis
  return <>
    <Strip items={[
      { l: 'Visits · 14 d', v: k.visits },
      { l: 'Check-ins verified (GPS)', v: k.verified, d: k.verified_pct != null ? `${k.verified_pct}%` : '', dc: 'tok' },
      { l: 'Avg visit time', v: k.avg_min != null ? `${k.avg_min} min` : '—', na: k.avg_min == null, d: k.avg_min == null ? 'no check-outs yet' : `${k.timed} timed`, title: 'Average of check-out − check-in' },
      { l: 'Distance covered', v: k.distance != null ? `${k.distance.toLocaleString('en-IN')} km` : '—', na: k.distance == null, d: k.distance == null ? 'not recorded' : '', title: 'Distance recorded at check-out and on visit travel expenses' },
      { l: 'Unplanned visits', v: k.unplanned },
    ]} />
    <div className="g g2 mb">
      <Panel title="Check-in map"><VisitMap pts={d.map} empty="No visits recorded in the last 14 days." /></Panel>
      <Panel title="Visits per KAM"><HBars d={short(d.per_kam).sort((a, b) => b.v - a.v)} lw={90} vw={30} /></Panel>
    </div>
    <Panel title="Visit log" z><BwGrid id="fs360-visits" cols={cols} rows={d.log} rid={r => String(r.id)} canExport={canExport} empty="No site visits in the last 14 days." /></Panel>
    {out && <CheckOutModal row={out} onClose={() => setOut(null)} onDone={m => { setOut(null); success('Checked out', `Visit time ${m} min`); onChanged() }} />}
  </>
}
function CheckOutModal({ row, onClose, onDone }: { row: VisitRow; onClose: () => void; onDone: (min: number) => void }) {
  const { error } = useToast()
  const [o, setO] = useState<string>('Positive'), [notes, setNotes] = useState(''), [km, setKm] = useState(''), [busy, setBusy] = useState(false)
  const save = async () => {
    const dist = km.trim() === '' ? null : Number(km)
    if (dist != null && (!isFinite(dist) || dist < 0 || dist > 5000)) { error('Check the distance', 'Enter kilometres between 0 and 5000'); return }
    setBusy(true)
    try {
      const g = await captureGps()
      const r = await fsApi.checkOut(row.id, { outcome: o, notes: notes.trim() || undefined, distance_km: dist, gps: g.gps, gps_permission: g.perm })
      onDone(r.duration)
    } catch (e) { error('Check-out failed', errMsg(e)) } finally { setBusy(false) }
  }
  return <Modal title={`Check out – ${row.customer}`} width={480} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Check out'}</button></>}>
    <label className="lb">Outcome</label>
    <div className="row wrap" style={{ gap: 5 }}>{OUTCOMES.map(x => <span key={x} role="button" tabIndex={0} className={`chip ${o === x ? 'on' : ''}`} onClick={() => setO(x)}>{x}</span>)}</div>
    <label className="lb mt">Visit notes</label><textarea className="in" rows={4} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What was discussed, what was agreed…" />
    <label className="lb mt">Travel distance (km)</label><input className="in" type="number" min={0} step="0.1" value={km} onChange={e => setKm(e.target.value)} placeholder="Optional" />
    <small className="mu">Your location is read once when you press Check out, only if you allow it.</small>
  </Modal>
}

// ─── Customer coverage ────────────────────────────────────────────────────────────────────────────────────────
function CoverageTab({ ver, open360 }: { ver: number; open360: (id: number | null) => void }) {
  const { d, err, retry } = useLoad<Coverage>(fsApi.coverage, [ver])
  if (!d) return <Loading err={err} retry={retry} />
  const k = d.kpis, p = d.policy
  return <>
    <Strip items={[
      { l: 'Customers', v: k.customers }, { l: 'Visited within plan', v: k.ok, dc: 'tok' }, { l: 'Overdue for visit', v: k.overdue, dc: 'tbad' },
      { l: 'Never visited', v: k.never, dc: 'twarn' }, { l: 'Coverage', v: k.coverage == null ? '—' : `${k.coverage}%` },
    ]} />
    <div className="note inf mb">Visit policy: Tier A every {p.A} days · Tier B every {p.B} days · Tier C every {p.C} days.</div>
    <div className="g g2 mb">
      <Panel title="Coverage by tier"><HBars d={d.by_tier} lw={70} vw={40} f={v => `${v}%`} /></Panel>
      <Panel title="Coverage by KAM"><HBars d={short(d.by_kam)} lw={90} vw={40} f={v => `${v}%`} /></Panel>
    </div>
    <Panel title="Customers overdue for a visit" z><Tbl rows={d.overdue} empty="Every customer is within its visit policy" cols={[
      { k: 'name', t: 'Customer', fn: c => <a onClick={() => open360(c.id)}>{c.name}</a> }, { k: 'tier', t: 'Tier' },
      { k: 'kam', t: 'KAM', fn: c => <User n={c.kam} /> },
      { k: 'd', t: 'Last visit', fn: c => c.days == null ? <span className="tba">never</span> : `${c.days} days ago` },
      { k: 'n', t: 'Policy', fn: c => `every ${c.need} d` }, { k: 'revenue', t: 'Revenue', r: true, fn: c => inr(c.revenue) },
    ]} /></Panel>
  </>
}

// ─── Activity analytics ───────────────────────────────────────────────────────────────────────────────────────
function AnalyticsTab({ ver }: { ver: number }) {
  const { d, err, retry } = useLoad<Analytics>(fsApi.analytics, [ver])
  if (!d) return <Loading err={err} retry={retry} />
  const k = d.kpis
  return <>
    <Strip items={[
      { l: 'Activities · 14 d', v: k.acts }, { l: 'Positive outcomes', v: k.positive == null ? '—' : `${k.positive}%`, dc: 'tok' },
      { l: 'Per KAM / day', v: k.per_kam_day == null ? '—' : k.per_kam_day.toFixed(1) }, { l: 'Follow-ups pending', v: k.followups },
      { l: 'Visit : call ratio', v: k.ratio == null ? '—' : k.ratio, na: k.ratio == null, title: `${k.visits} site visits · ${k.calls} calls` },
    ]} />
    <div className="g g3 mb">
      <Panel title="By type"><Donut d={d.by_type} /></Panel>
      <Panel title="Outcome"><Donut d={d.outcome} /></Panel>
      <Panel title="Daily trend"><Line ser={[{ n: 'Activities', c: PAL[0], v: d.daily }]} labels={d.days.map((x, i) => i % 3 === 0 ? dd(x) : '')} h={130} /></Panel>
    </div>
    <Panel title="Productivity by KAM" z><Tbl rows={d.productivity} cols={[
      { k: 'n', t: 'KAM', fn: x => <User n={x.name} /> },
      ...TYPES.map(t => ({ k: t, t, r: true, fn: (x: typeof d.productivity[number]) => String(x[t] ?? 0) })),
      { k: 'p', t: 'Positive %', fn: x => <BarPct v={x.positive} /> },
    ]} /></Panel>
  </>
}

// ─── Targets ─────────────────────────────────────────────────────────────────────────────────────────────────
function TargetsTab({ ver, onSaved }: { ver: number; onSaved: () => void }) {
  const { success, error } = useToast()
  const { d, err, retry } = useLoad<Targets>(fsApi.targets, [ver])
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  useEffect(() => setDraft({}), [d])
  if (!d) return <Loading err={err} retry={retry} />
  const lakh = (v: number) => String(Math.round(v / 1e5 * 100) / 100)
  const commit = async (id: number, name: string, cur: number) => {
    const raw = draft[id]
    if (raw == null || raw === lakh(cur)) return
    const v = Number(raw)
    if (raw.trim() === '' || !isFinite(v) || v < 0) { error('Invalid target', 'Enter the annual target in ₹ lakh (0 or more)'); return }
    setSaving(id)
    try {
      await fsApi.setTarget(id, v)
      success('Target updated', `${d.fy} target for ${name} is now ₹ ${v} L`)
      onSaved()
    } catch (e) { error('Target not saved', errMsg(e)) } finally { setSaving(null) }
  }
  return <>
    <div className="note inf mb">Set annual targets per KAM. Achievement is calculated from won deals; changes apply instantly.</div>
    <Panel title="Targets & achievement" z><Tbl rows={d.rows} cols={[
      { k: 'n', t: 'KAM', fn: x => <User n={x.name} /> },
      { k: 'tg', t: 'Annual target', fn: x => <><input className={`in sm ${draft[x.id] != null && !(Number(draft[x.id]) >= 0 && draft[x.id].trim() !== '') ? 'bad' : ''}`} type="number" min={0} step="0.01" style={{ width: 130 }}
        aria-label={`Annual target for ${x.name} in lakh`} disabled={!x.can_edit || saving === x.id} value={draft[x.id] ?? lakh(x.target)}
        title={x.updated_by ? `Last set by ${x.updated_by}${x.updated_at ? ` on ${fd(x.updated_at)}` : ''}` : x.source === 'kam_targets' ? 'From configured KAM targets' : x.source === 'user_master' ? 'From the user master target' : undefined}
        onChange={e => setDraft(s => ({ ...s, [x.id]: e.target.value }))} onBlur={() => commit(x.id, x.name, x.target)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(s => { const n = { ...s }; delete n[x.id]; return n }) }} /> <small>₹ L</small></> },
      { k: 'won', t: 'Achieved', r: true, fn: x => inr(x.won) },
      { k: 'a', t: 'Attainment', fn: x => <Bar v={x.attain} /> },
      { k: 'g', t: 'Gap', r: true, fn: x => inr(x.gap) },
      { k: 'q', t: 'Run-rate vs plan', fn: x => x.runrate == null ? <span className="mu">—</span> : <span className={x.runrate >= 0 ? 'tok' : 'tbad'} title={`Attainment vs ${d.elapsed_pct}% of ${d.fy} elapsed`}>{x.runrate >= 0 ? '+' : ''}{x.runrate} pts</span> },
    ]} /></Panel>
  </>
}

// ─── Territories ─────────────────────────────────────────────────────────────────────────────────────────────
function TerritoriesTab({ ver }: { ver: number }) {
  const { d, err, retry } = useLoad<Territories>(fsApi.territories, [ver])
  if (!d) return <Loading err={err} retry={retry} />
  return <>
    <Panel title="Territory plan · customers by state × KAM"><Heat rows={d.states} cols={shortNames(d.kams)}
      v={(i, j) => Math.min(100, d.heat[i][j] * 40)} t={(i, j) => `${d.states[i]} · ${d.kams[j]}: ${d.heat[i][j]} customer${d.heat[i][j] === 1 ? '' : 's'}`} /></Panel>
    <div className="g g2 mt">
      <Panel title="Revenue by state"><HBars d={d.revenue} f={inr} lw={110} vw={84} /></Panel>
      <Panel title="Customers per KAM"><HBars d={short(d.per_kam)} lw={90} vw={30} /></Panel>
    </div>
  </>
}
