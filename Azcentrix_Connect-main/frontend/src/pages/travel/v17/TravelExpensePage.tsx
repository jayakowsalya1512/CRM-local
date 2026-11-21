// Travel & Expense – prototype v17 R.travel: tabs Requests · Expense claims · Calendar above the content.
// Requests = listPage('travel'): crumb (company) · "Travel" · N records · Import · + New trip, saved views All / Upcoming / Mine
// with counts, grid ID | Traveller | Purpose | Destination | From | To | Mode | Estimate | Status with the status filter
// (All · Pending · Approved · Completed); ID / Purpose open the trip drawer.
// Expense claims = strip(Total claimed · Advances outstanding · Awaiting approval) + panel 'Expense claims'
// Trip | Traveller | Purpose | Claimed | Advance | Balance | Claim | (Submit claim).
// Calendar = panel 'Upcoming & ongoing trips' (end date ≥ today − 3 days, by start date).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Av, Panel, Pill, Tbl } from '@/pages/customers/kit'
import TripDrawer from './TripDrawer'
import { errMsg, fd, inr, tone, trApi, TRT, type ClaimRow, type Meta, type Row, type TrTab } from './travelApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/deals/deals.css'
import './travel.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const User = ({ n }: { n: string }) => <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><Av name={n} />{n}</span>

export default function TravelExpensePage() {
  const [sp, setSp] = useSearchParams()
  const { error } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [rev, setRev] = useState(0)
  const [openId, setOpenId] = useState<number | null>(null)
  const tab: TrTab = (TRT as readonly string[]).includes(sp.get('tab') || '') ? sp.get('tab') as TrTab : 'Requests'
  const setTab = (t: TrTab) => setSp(s => { const n = new URLSearchParams(s); if (t === 'Requests') n.delete('tab'); else n.set('tab', t); return n })

  useEffect(() => { trApi.meta().then(setMeta).catch(e => error('Could not load Travel & Expense', errMsg(e))) }, [error])
  useEffect(() => { const id = Number(sp.get('open')) || null; if (id) { setOpenId(id); setSp(s => { const n = new URLSearchParams(s); n.delete('open'); return n }, { replace: true }) } }, [sp]) // eslint-disable-line react-hooks/exhaustive-deps
  const changed = useCallback(() => setRev(r => r + 1), [])

  return <div className="bwi trv">
    <div className="tabs mb" role="tablist">{TRT.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`}
      onClick={() => setTab(t)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
    {tab === 'Requests' ? <Requests meta={meta} rev={rev} open={setOpenId} />
      : tab === 'Expense claims' ? <Claims rev={rev} open={setOpenId} onChanged={changed} />
        : <Calendar rev={rev} open={setOpenId} />}
    {openId != null && meta && <TripDrawer id={openId} meta={meta} onClose={() => setOpenId(null)} onChanged={changed} />}
  </div>
}

// ─── Requests (listPage('travel')) ────────────────────────────────────────────
function Requests({ meta, rev, open }: { meta: Meta | null; rev: number; open: (id: number) => void }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [view, setView] = useState<string>(() => store.get('travel-v17:view', 'All'))
  const [status, setStatus] = useState('')
  const [data, setData] = useState<{ items: Row[]; total_all: number; counts: Record<string, number>; loading: boolean; err: string }>({ items: [], total_all: 0, counts: {}, loading: true, err: '' })
  useEffect(() => { store.set('travel-v17:view', view) }, [view])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true, err: '' }))
    trApi.list(view, status).then(r => { if (live) setData({ ...r, loading: false, err: '' }) })
      .catch(e => { if (live) { setData(d => ({ ...d, items: [], loading: false, err: errMsg(e, 'Could not load trips') })); error('Could not load trips', errMsg(e)) } })
    return () => { live = false }
  }, [view, status, rev, error])

  // prototype M.travel.cols – order and gw() default widths (ID 124 · text 158 · dates 122 · inr 112 · pill 118)
  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'code', t: 'ID', w: 124, fn: r => <a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.code}</b></a>, txt: r => r.code, sv: r => r.id },
    { k: 'traveller', t: 'Traveller', w: 158, fn: r => <User n={r.traveller} />, txt: r => r.traveller },
    { k: 'purpose', t: 'Purpose', w: 158, fn: r => <a onClick={e => { e.stopPropagation(); open(r.id) }}>{r.purpose}</a>, txt: r => r.purpose },
    { k: 'to', t: 'Destination', w: 158 },
    { k: 'start', t: 'From', w: 122, date: true, fn: r => fd(r.start), txt: r => r.start || '', sv: r => r.start || '' },
    { k: 'end', t: 'To', w: 122, date: true, fn: r => fd(r.end), txt: r => r.end || '', sv: r => r.end || '' },
    { k: 'mode', t: 'Mode', w: 158 },
    { k: 'cost', t: 'Estimate', w: 112, r: true, sum: true, money: true, fn: r => inr(r.cost), txt: r => String(r.cost), sv: r => r.cost, sumv: r => r.cost, sumFmt: n => inr(n) },
    { k: 'status', t: 'Status', w: 118, fn: r => <Pill s={r.status} t={tone(r.status)} />, txt: r => r.status },
  ], [open])

  const tools = <span className="ctools"><select className="in sm" style={{ width: 140 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
    <option value="">All</option>{(meta?.statuses || ['Pending', 'Approved', 'Completed']).map(s => <option key={s}>{s}</option>)}</select></span>

  return <>
    <div className="pg">
      <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Travel</h1></div>
      <span className="cnt">{data.total_all} records</span>
      <span className="fl" />
      {meta?.can.create && <button type="button" className="btn" onClick={() => navigate('/datahub')}><Ic n="up" /> Import</button>}
      {meta?.can.create && <button type="button" className="btn p" onClick={() => navigate('/travel/new')}><Ic n="plus" /> New trip</button>}
    </div>
    <div className="row wrap mb" style={{ gap: 6 }}>
      {(meta?.views || ['All', 'Upcoming', 'Mine']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>{v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
    </div>
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id="travel-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} tools={tools} canExport={!!meta?.can.export}
        empty={data.loading ? 'Loading…' : data.err || 'No records match the current filters.'} />
    </div>
  </>
}

// ─── Expense claims ───────────────────────────────────────────────────────────
function Claims({ rev, open, onChanged }: { rev: number; open: (id: number) => void; onChanged: () => void }) {
  const { success, error } = useToast()
  const [d, setD] = useState<{ kpis: { claimed: number; outstanding: number; awaiting: number }; items: ClaimRow[] } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  useEffect(() => { setErr(''); trApi.claims().then(setD).catch(e => setErr(errMsg(e, 'Could not load expense claims'))) }, [rev])
  const submit = async (r: ClaimRow) => {
    if (busy) return
    setBusy(r.id)
    try {
      const res = await trApi.submitClaim(r.id)
      success('Claim submitted for approval', res.requested_to ? `Sent to ${res.requested_to}` : undefined)
      onChanged()
    } catch (e) { error('Claim not submitted', errMsg(e)) } finally { setBusy(null) }
  }
  const k = d?.kpis
  return <>
    <div className="strip k3">
      <div className="st"><div className="sth"><label>Total claimed</label></div><b>{k ? inr(k.claimed) : '—'}</b></div>
      <div className="st"><div className="sth"><label>Advances outstanding</label></div><b>{k ? inr(k.outstanding) : '—'}</b></div>
      <div className="st"><div className="sth"><label>Awaiting approval</label></div><b>{k ? k.awaiting : '—'}</b></div>
    </div>
    <Panel title="Expense claims" z>{err ? <div className="empty">{err}</div> : !d ? <div className="empty">Loading…</div> : <Tbl rows={d.items} empty="No trips with expenses yet" cols={[
      { k: 'id', t: 'Trip', fn: r => <a onClick={() => open(r.id)}><b>{r.code}</b></a> },
      { k: 'traveller', t: 'Traveller', fn: r => <User n={r.traveller} /> },
      { k: 'purpose', t: 'Purpose' },
      { k: 'c', t: 'Claimed', r: true, fn: r => inr(r.claimed) },
      { k: 'advance', t: 'Advance', r: true, fn: r => <span title={r.advance_requested > r.advance ? `₹${r.advance_requested.toLocaleString('en-IN')} requested · ₹${r.advance.toLocaleString('en-IN')} disbursed` : undefined}>{inr(r.advance)}</span> },
      { k: 'b', t: 'Balance', r: true, fn: r => <span className={r.balance < 0 ? 'tbad' : undefined}>{inr(r.balance)}</span> },
      { k: 's', t: 'Claim', fn: r => r.claim === '—' ? <span className="mu">—</span> : <Pill s={r.claim} t={tone(r.claim)} /> },
      { k: 'x', t: '', fn: r => r.can_submit ? <button type="button" className="btn s" disabled={busy != null} onClick={() => submit(r)}>{busy === r.id ? 'Submitting…' : 'Submit claim'}</button> : null },
    ]} />}</Panel>
  </>
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
function Calendar({ rev, open }: { rev: number; open: (id: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { setErr(''); trApi.calendar().then(setRows).catch(e => setErr(errMsg(e, 'Could not load trips'))) }, [rev])
  return <Panel title="Upcoming & ongoing trips" z>
    <div className="list">{err ? <div className="empty">{err}</div> : !rows ? <div className="empty">Loading…</div> : rows.length ? rows.map(t => <div key={t.id}>
      <span className="dt"><b>{fd(t.start)}</b><br /><small>to {fd(t.end)}</small></span>
      <Av name={t.traveller} />
      <span className="fl"><a onClick={() => open(t.id)}><b>{t.purpose}</b></a><br /><small>{t.from} → {t.to} · {t.mode} · {t.traveller}</small></span>
      <Pill s={t.status} t={tone(t.status)} />
    </div>) : <div className="empty">No upcoming trips</div>}</div>
  </Panel>
}
