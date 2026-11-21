// Orders & Projects – prototype v17 R.wo = olHeader() + listPage('wo'): lifecycle tabs (All contracts · <type> …, only when
// a follow-on lifecycle exists), crumb · "Orders & Projects" · N records · List & grid | Board · Import · + New order, saved
// views All · Running · Delayed · Billing gap, grid WO no. | Company | Journey | Type | Work | Customer | PO | Value | Progress | Billed | Received |
// Awaiting finance | Stage | PM | Due | ⋯ – plus the v18 segmented switch Orders & projects | Collections & finance (OrderPayments.tsx)
// (stage filter), kanban over the configured lifecycle stages (Kick-off → … → Closed) and the order drawer.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, Pill } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import JourneyTrack from '@/pages/leads/JourneyTrack'
import { masters, useMaster } from '@/pages/leads/leadApi'
import OrderDrawer, { type Tab as DrawerTab } from './OrderDrawer'
import { CollectionsView } from './OrderPayments'
import OrderSettingsModal from './OrderSettingsModal'
import { useOrderStage } from './useOrderStage'
import { errMsg, fd, inr, orderApi, pct, stagePill, type ImportResult, type ListParams, type Meta, type Row } from './orderApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/deals/deals.css'
import './orders.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function OrdersListPage() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [view, setView] = useState<string>(() => store.get('orders:view', 'All'))
  const [mode, setMode] = useState<'list' | 'board'>(() => store.get('orders:mode', 'list'))
  const [type, setType] = useState<string>(() => store.get('orders:type', ''))
  const [stage, setStage] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'type' | 'stage' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; type_counts: Record<string, number>; loading: boolean }>(
    { items: [], total: 0, total_all: 0, counts: {}, type_counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [openId, setOpenId] = useState<number | null>(null)
  const [openTab, setOpenTab] = useState<DrawerTab>('Overview')
  // v18 segmented switch: Orders & projects | Collections & finance (n receipts waiting for Finance)
  const [seg, setSeg] = useState<'Orders' | 'Collections'>(() => store.get('orders:seg', 'Orders'))
  const [pendingN, setPendingN] = useState<number | null>(null)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [settings, setSettings] = useState(false)

  const changed = useCallback(() => setRev(r => r + 1), [])
  const loadMeta = useCallback(() => orderApi.meta().then(m => {
    setMeta(m); setView(v => m.views.includes(v) ? v : 'All'); setType(t => !t || m.lifecycles.some(l => l.type === t) ? t : '')
  }).catch(e => error(errMsg(e, 'Could not load Orders & Projects'))), [error])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => { store.set('orders:view', view) }, [view])
  useEffect(() => { store.set('orders:mode', mode) }, [mode])
  useEffect(() => { store.set('orders:type', type) }, [type])
  useEffect(() => { store.set('orders:seg', seg) }, [seg])

  // ?open=<id> (links from quotes, notifications, journeys) · ?number=<WO no.> (tender page)
  useEffect(() => {
    const id = Number(sp.get('open')) || null, num = sp.get('number')
    if (id) { setOpenId(id); sp.delete('open'); setSp(sp, { replace: true }); return }
    if (num) {
      orderApi.list({ view: 'All', type: '', stage: '', q: num, f: {}, adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 50 })
        .then(r => { const m = r.items.find(x => x.ref === num); if (m) setOpenId(m.id); else warning(`Order ${num} is not visible to you`) }).catch(() => undefined)
      sp.delete('number'); setSp(sp, { replace: true })
    }
  }, [sp]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = JSON.stringify([view, type, stage, p, qf, rev, mode, seg])
  useEffect(() => {
    if (seg === 'Collections') return
    let live = true
    setData(d => ({ ...d, loading: true }))
    const params = mode === 'board' ? { ...p, offset: 0, limit: 1000 } : p
    const t = setTimeout(() => {
      orderApi.list({ view, type, stage, q: qf.q, f: qf.f, ...params })
        .then(r => { if (live) { setData({ ...r, loading: false }); setPendingN(r.pending_finance) } })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load orders')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const open = useCallback((id: number) => { setOpenTab('Overview'); setOpenId(id) }, [])
  const openPay = useCallback((id: number) => { setOpenTab('Payments'); setOpenId(id) }, [])
  const can = meta?.can
  const lcs = meta?.lifecycles || []
  const lc = lcs.find(l => l.type === type) || lcs.find(l => l.key === 'wo') || lcs[0]
  const stageNames = useMemo(() => [...new Set((type ? [lc] : lcs).filter(Boolean).flatMap(l => l!.stages.map(s => s.name)))], [lcs, lc, type])

  // prototype colsOf('wo'), exact order: WO no. · Company (colsOf, w 96) · Journey (jTrack, w 210) · Type (otype pill) · Work link ·
  // Customer · PO · Value inr · Progress bar · Billed pct · Stage pill · PM user · Due date – then the row ⋯ menu
  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'ref', t: 'WO no.', w: 124, fn: r => <b>{r.ref}</b>, sv: r => r.id },
    { k: 'company', t: 'Company', w: 96, fn: r => r.company ? <span className="pill ac oco" title={r.company}>{r.company}</span> : <span className="mu">—</span> },
    { k: 'jid', t: 'Journey', w: 210, txt: r => r.jid || '', sv: r => r.jid || '',
      fn: r => r.journey ? <JourneyTrack j={r.journey} onOpen={() => open(r.id)} /> : <span className="mu">—</span> },
    { k: 'type', t: 'Type', w: 140, txt: r => r.type || 'Project / Supply', fn: r => <Pill s={r.type || 'Project / Supply'} t="ac" /> },
    { k: 'title', t: 'Work', w: 260, fn: r => <><a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.title}</b></a>{r.pending && <> <Pill s="Pending approval" t="wa" /></>}</> },
    { k: 'customer', t: 'Customer', w: 200 },
    { k: 'po', t: 'PO', w: 150, fn: r => r.po || <span className="mu">—</span> },
    { k: 'value', t: 'Value', w: 112, r: true, sum: true, money: true, fn: r => inr(r.value), sv: r => r.value, sumv: r => r.value, sumFmt: n => inr(n) },
    { k: 'progress', t: 'Progress', w: 124, fn: r => <BarPct v={r.progress} />, sv: r => r.progress, txt: r => `${r.progress}%` },
    { k: 'billed', t: 'Billed', w: 100, r: true, fn: r => `${Math.round(r.billed)}%`, sv: r => r.billed, txt: r => `${r.billed}%` },
    // v18: Received (Finance-acknowledged, % of order) · Awaiting finance – inserted before Stage
    { k: 'received', t: 'Received', w: 120, r: true, money: true, sum: true, sv: r => r.received, sumv: r => r.received, sumFmt: n => inr(n), txt: r => inr(r.received),
      fn: r => <><span className="tok">{inr(r.received)}</span><br /><small className="mu">{pct(r.received, r.value)}% of order</small></> },
    { k: 'awaiting', t: 'Awaiting finance', w: 124, r: true, money: true, sum: true, sv: r => r.awaiting, sumv: r => r.awaiting, sumFmt: n => inr(n), txt: r => inr(r.awaiting),
      fn: r => r.awaiting ? <span className="twarn">{inr(r.awaiting)}</span> : <span className="mu">—</span> },
    { k: 'stage', t: 'Stage', w: 118, fn: r => <Pill s={r.stage} t={stagePill(r.stage, r.stage_kind)} /> },
    { k: 'pm', t: 'PM', w: 158, fn: r => r.pm ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.pm} />{r.pm}</span> : <span className="mu">—</span> },
    { k: 'due', t: 'Due', w: 122, date: true, fn: r => fd(r.due), sv: r => r.due || '' },
  ], [open])

  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/workorders/${r.id}/edit`) }] : []),
    ...(can?.create ? [{ l: 'Duplicate', i: <Ic n="copy" />, fn: () => navigate(`/workorders/new?copy=${r.id}`) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate, open])

  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) out.push(['Reassign', rows => setReassign(rows)])
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const stageSel = <select className="in sm" style={{ width: 140 }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
    <option value="">All</option>{stageNames.map(s => <option key={s} value={s}>{s}</option>)}</select>
  const tools = <span className="ctools">{type && lcs.length > 1 && <button type="button" className="btn s p" onClick={() => setType('')}>Type: {type} ✕</button>}{stageSel}</span>
  const total = lcs.reduce((a, l) => a + (data.type_counts[l.type] || 0), 0)

  const segCtl = <div style={{ margin: '0 0 12px' }}><div className="seg8" role="tablist" aria-label="Orders & Projects views">
    {([['Orders', 'Orders & projects'], ['Collections', 'Collections & finance']] as const).map(([k, l]) =>
      <button key={k} type="button" role="tab" aria-selected={seg === k} className={seg === k ? 'on' : ''} onClick={() => setSeg(k)}>
        {l}{k === 'Collections' && pendingN ? <small>{pendingN}</small> : null}</button>)}</div></div>
  const drawer = openId != null && meta && <OrderDrawer id={openId} meId={meta.me.id} initialTab={openTab} onClose={() => setOpenId(null)} onChanged={changed} onOpen={open} />

  if (seg === 'Collections') return (
    <div className="bwi">
      <div className="pg"><div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Orders &amp; Projects</h1></div><span className="fl" /></div>
      {segCtl}
      <CollectionsView rev={rev} onOpen={openPay} onChanged={changed} onCount={setPendingN} />
      {drawer}
    </div>
  )

  return (
    <div className="bwi">
      {lcs.length > 1 && <div className="tabs mb" style={{ border: '1px solid var(--bw-ln)' }} role="tablist">
        <div role="tab" tabIndex={0} aria-selected={!type} className={`tab ${!type ? 'on' : ''}`} onClick={() => { setType(''); setStage('') }}>All contracts <small>{total}</small></div>
        {lcs.map(l => <div key={l.key} role="tab" tabIndex={0} aria-selected={type === l.type} className={`tab ${type === l.type ? 'on' : ''}`} onClick={() => { setType(l.type); setStage(''); setView('All') }}
          title={l.label}>{l.type} <small>{data.type_counts[l.type] ?? 0}</small></div>)}
      </div>}
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Orders &amp; Projects</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        <div className="row" style={{ gap: 0 }} role="group" aria-label="Layout">
          <button type="button" className={`btn s ${mode === 'list' ? 'p' : ''}`} aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Ic n="table" /> List &amp; grid</button>
          <button type="button" className={`btn s ${mode === 'board' ? 'p' : ''}`} aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Ic n="layout" /> Board</button>
        </div>
        {can?.configure && <button type="button" className="btn" title="Settings → Orders & projects: milestones, billing model, retention, project manager, alerts, numbering · order lifecycles" onClick={() => setSettings(true)}><Ic n="gear" /></button>}
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate(type && lc && lc.key !== 'wo' ? `/workorders/new?lifecycle=${lc.key}` : '/workorders/new')}><Ic n="plus" /> New order</button>}
      </div>
      {segCtl}
      <div className="row wrap mb" style={{ gap: 6 }}>
        {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        {mode === 'list'
          ? <BwGrid id="orders-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} tools={tools} menu={menu}
            server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
          : meta && lc && <>
            <div className="tbr">{tools}<small>Drag cards between stages. Stages come from the Process Designer ({lc.type}) for {meta.company || 'this workspace'}.</small></div>
            <Board stages={lc.stages} lifecycle={lc.key} canUpdate={!!can?.update} rows={data.items.filter(r => r.lifecycle === lc.key)} loading={data.loading} total={data.total} onOpen={open} onChanged={changed} />
          </>}
        {meta && !lcs.length && <div className="empty">No order lifecycle is configured – set one up in the Process Designer.</div>}
      </div>
      {drawer}
      {reassign && <ReassignModal rows={reassign} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} records`)
      }} />}
      {del && <Modal title="Delete records?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await orderApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success(`${r.done} deleted`) }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}>Delete</button></>}>
        <p style={{ margin: 0 }}>Delete {del.length} selected record{del.length === 1 ? '' : 's'}? Orders with invoices or follow-on contracts are kept; linked tenders and quotes are not changed and every deletion is audit-logged.</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
      {settings && <OrderSettingsModal onClose={() => setSettings(false)} onSaved={() => { void loadMeta(); changed() }} />}
    </div>
  )
}

// prototype kanban('wo'): every configured stage, count · total, cards title · customer · value · PM
function Board({ stages, lifecycle, canUpdate, rows, loading, total, onOpen, onChanged }: {
  stages: Meta['lifecycles'][number]['stages']; lifecycle: string; canUpdate: boolean; rows: Row[]; loading: boolean; total: number; onOpen: (id: number) => void; onChanged: () => void
}) {
  const [over, setOver] = useState('')
  const drag = useRef<Row | null>(null)
  const { move, ui } = useOrderStage(canUpdate, onChanged)
  if (loading && !rows.length) return <div className="empty">Loading…</div>
  return <>
    <div className="kb" style={{ padding: 8 }} data-lifecycle={lifecycle}>{stages.map(s => {
      const L = rows.filter(r => r.stage_id === s.id), sum = L.reduce((a, r) => a + (r.value || 0), 0)
      return <div key={s.id} className={`kc ${over === String(s.id) ? 'dr' : ''}`} data-st={s.name}
        onDragOver={e => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== String(s.id)) setOver(String(s.id)) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => o === String(s.id) ? '' : o) }}
        onDrop={e => { e.preventDefault(); setOver(''); const r = drag.current; drag.current = null; if (r) void move({ id: r.id, name: r.title, stages, currentId: r.stage_id }, s) }}>
        <h4 style={{ ['--c' as string]: s.kind === 'won' ? 'var(--bw-ok)' : 'var(--bw-ac)' }} title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`}>
          {s.name}{s.gate !== 'None' && <span className="pill wa" title={`Gate: ${s.gate}`}>{s.gate}</span>}<small>{L.length}{sum ? ` · ${inr(sum)}` : ''}</small></h4>
        <div className="cs">{L.map(r => <div key={r.id} className="kcard" draggable={canUpdate && !r.pending} data-id={r.id} title={`${r.ref} · ${r.title}`}
          onDragStart={e => { drag.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.id)) }}
          onDragEnd={() => { drag.current = null; setOver('') }}
          onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id) }}>
          <div className="t1">{r.title.slice(0, 50)}</div>
          <small>{r.customer}</small>
          <div className="m"><b style={{ color: 'var(--bw-tx)' }}>{inr(r.value)}</b>{r.pending && <Pill s="Pending" t="wa" />}<Av name={r.pm || '?'} /></div>
        </div>)}</div>
      </div>
    })}</div>
    {total > rows.length && <div className="mu" style={{ padding: '0 12px 10px', fontSize: 12 }}>Showing {rows.length} of {total} – narrow with a saved view or the stage filter.</div>}
    {ui}
  </>
}

function ReassignModal({ rows, onClose, onDone }: { rows: Row[]; onClose: () => void; onDone: (n: number, failed: { id: number; error: string }[]) => void }) {
  const { error } = useToast()
  const users = useMaster(masters.users)
  const [u, setU] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  return <Modal title={`Reassign ${rows.length} record${rows.length === 1 ? '' : 's'}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!u || busy} onClick={async () => {
      setBusy(true)
      try { const r = await orderApi.bulk(rows.map(x => x.id), 'reassign', String(u)); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="oro">New project manager</label>
      <Lookup id="oro" value={u} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setU(o?.id ?? null)} placeholder="Choose a user…" emptyText="No active users" /></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult | null>(null)
  const template = async () => {
    try { const b = await orderApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'orders-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  const run = async (dry: boolean) => {
    if (!file) return
    setBusy(true)
    try { const r = await orderApi.importCsv(file, dry); setRes(r); if (!dry && r.created) { success(`${r.created} order${r.created === 1 ? '' : 's'} imported`); onDone() } }
    catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
  }
  return <Modal title="Import orders" width={600} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res && !res.dry_run ? 'Close' : 'Cancel'}</button>
    {(!res || res.dry_run) && <button type="button" className="btn" disabled={!file || busy} onClick={() => run(true)}>Validate</button>}
    {(!res || res.dry_run) && <button type="button" className="btn p" disabled={!file || busy} onClick={() => run(false)}>{busy ? 'Working…' : 'Import'}</button>}</>}>
    <div className="fg"><div className="f1">
      <label htmlFor="oimf">CSV file</label>
      <input id="oimf" type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => { setFile(e.target.files?.[0] || null); setRes(null) }} />
      <small className="mu">One row per order (Work order title, Customer, PO number, Order value, Start date, Due date, Project manager email). Customers and project managers must match existing records; a PO already used for that customer is reported as a duplicate. Validate first to see the report without creating anything.</small>
    </div></div>
    {res && <div className="mt"><p style={{ margin: '8px 0' }}><b>{res.created}</b> {res.dry_run ? 'ready to import' : 'imported'}
      {res.duplicate_count ? <> · <b className="twarn">{res.duplicate_count}</b> duplicate{res.duplicate_count > 1 ? 's' : ''}</> : ''}
      {res.error_count ? <> · <b className="tbad">{res.error_count}</b> with errors</> : ''}.</p>
      {(res.errors.length > 0 || res.duplicates.length > 0) && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
        {[...res.duplicates, ...res.errors].sort((a, b) => a.row - b.row).map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.name ? <b>{x.name}: </b> : null}{x.error}</span></div>)}</div>}
    </div>}
  </Modal>
}
