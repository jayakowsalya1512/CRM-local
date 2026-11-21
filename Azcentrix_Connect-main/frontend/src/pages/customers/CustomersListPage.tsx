// Customers – prototype v17 listPage('customers'): crumb · "Customers" · N records · Import · + New customer,
// saved views (All · My accounts · Tier A · At risk) and the prototype's full customer grid (17 columns + row actions, hierarchy order).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, Pill } from './kit'
import { VIEWS, custApi, errMsg, inr, type ListParams, type Meta, type Row, type View } from './customerApi'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import './c360.css'

const INLINE_SPEC: Record<string, FieldSpec | undefined> = { city: { label: 'City', rule: 'text', min: 2, max: 100 } }

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function CustomersListPage() {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [view, setView] = useState<View>(() => { const v = store.get<string>('cust:view', 'All'); return (VIEWS as readonly string[]).includes(v) ? v as View : 'All' })
  const [status, setStatus] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'status' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Partial<Record<View, number>>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => { custApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load Customers'))) }, [error])
  useEffect(() => { store.set('cust:view', view) }, [view])
  const key = JSON.stringify([view, status, p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      custApi.list({ view, status, q: qf.q, f: qf.f, ...p })
        .then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load customers')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const changed = useCallback(() => setRev(r => r + 1), [])

  const edit = useCallback(async (r: Row, field: string, value: string) => {
    // inline cell edit: same rule as the backend (city 2–100 characters); an invalid value keeps the cell in edit mode
    const bad = INLINE_SPEC[field] ? validate(value, INLINE_SPEC[field]!) : ''
    if (bad) { error(bad); throw new Error(bad) }
    try { await custApi.field(r.id, field, value); success(`${r.name} updated`); changed() }
    catch (e) { const fx = apiFieldErrors(e); error(fx.value || Object.values(fx)[0] || errMsg(e, 'Could not save the change')); throw e }
  }, [success, error, changed])

  const can = meta?.can
  const cols: GridCol<Row>[] = useMemo(() => {
    const ed = (field: string, value: (r: Row) => string, o?: string[]) => can?.update ? { ed: { t: (o ? 'sel' : 'text') as 'sel' | 'text', o, value, save: (r: Row, v: string) => edit(r, field, v) } } : {}
    const link = (id: number | null, text: string) => id ? <a onClick={e => { e.stopPropagation(); navigate(`/customers/${id}`) }}>{text}</a> : <span className="mu">—</span>
    // Prototype v17 final grid: ID | Company | Customer | Main customer | Level | Parent entity | Type | Vertical | Value band |
    // Segment | Sub-segment | City | KAM | Tier | FY revenue | Health | Status | ⋯ (row actions, see `menu`)
    return [
      { k: 'ref', t: 'ID', w: 104, fn: r => <span className="mono">{r.ref}</span>, sv: r => r.id },
      { k: 'company', t: 'Company', w: 110, fn: r => r.company ? <span title={r.company}><Pill s={r.company} t="ac" /></span> : <span className="mu">—</span> },
      { k: 'name', t: 'Customer', w: 330, fn: r => <span className="ctree" style={{ paddingLeft: r.depth * 12 }}>
        {r.depth > 0 && <span className="mu">└ </span>}<span className={`lvb ${r.badge[1]}`} title={r.level}>{r.badge[0]}</span>{' '}
        <a onClick={e => { e.stopPropagation(); navigate(`/customers/${r.id}`) }}><b>{r.name}</b></a>
        {r.below > 0 && <small className="mu"> · {r.below} below</small>}{r.pending && <> <Pill s="Pending approval" t="wa" /></>}</span> },
      { k: 'root', t: 'Main customer', w: 180, fn: r => r.root_id ? link(r.root_id, r.root) : <Pill s="Main customer" t="ac" /> },
      { k: 'level', t: 'Level', w: 150, fn: r => <span className="clvl"><i className={`lvd ${r.badge[1]}`} />{r.level}</span>, ...ed('level', r => r.level, meta?.levels) },
      { k: 'parent', t: 'Parent entity', w: 170, fn: r => link(r.parent_id, r.parent) },
      { k: 'type', t: 'Type', w: 170, ...ed('type', r => r.type, meta?.types) },
      { k: 'vertical', t: 'Vertical', w: 170 },
      { k: 'band', t: 'Value band', w: 110, fn: r => <Pill s={r.band} t={r.band === 'Strategic' ? 'ok' : r.band === 'Growth' ? 'inf' : 'mu'} /> },
      { k: 'segment', t: 'Segment', w: 170 },
      { k: 'sub_segment', t: 'Sub-segment', w: 160 },
      { k: 'city', t: 'City', w: 130, ...ed('city', r => r.city) },
      { k: 'kam', t: 'KAM', w: 170, fn: r => r.kam ? <span className="row" style={{ gap: 6, display: 'inline-flex' }}><Av name={r.kam} /> {r.kam}{!r.kam_own && <Pill s="inherited" t="mu" />}</span> : <span className="mu">unassigned</span>,
        ...ed('kam', r => r.kam, ['', ...(meta?.users.map(u => u.name) || [])]) },
      { k: 'tier', t: 'Tier', w: 70, ...ed('tier', r => r.tier, ['A', 'B', 'C']) },
      { k: 'revenue', t: 'FY revenue', w: 120, r: true, fn: r => inr(r.revenue), sv: r => r.revenue },
      { k: 'health', t: 'Health', w: 124, fn: r => <BarPct v={r.health} c={r.health < 55 ? 'var(--bw-ba)' : r.health < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)'} />, sv: r => r.health },
      { k: 'status', t: 'Status', w: 118, fn: r => <Pill s={r.status} />, ...ed('status', r => r.status, meta?.statuses) },
    ]
  }, [meta, can, edit, navigate])

  // prototype gmenu: Open record · Edit · Duplicate · Delete (each shown only when the role allows it)
  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => navigate(`/customers/${r.id}`) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/customers/${r.id}/edit`) }] : []),
    ...(can?.create ? [{ l: 'Duplicate', i: <Ic n="copy" />, fn: () => navigate(`/customers/new?copy=${r.id}`) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate])

  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) out.push(['Reassign', rows => setReassign(rows)])
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const tools = <span className="ctools"><select className="in sm" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
    <option value="">All</option>{(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}</select></span>

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Customers</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate('/customers/new')}><Ic n="plus" /> New customer</button>}
      </div>
      <div className="row wrap mb" style={{ gap: 6 }}>
        {VIEWS.map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        <BwGrid id="customers-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => navigate(`/customers/${r.id}`)} bulk={bulk} tools={tools} menu={menu}
          server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
      </div>
      {reassign && meta && <ReassignModal rows={reassign} meta={meta} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} customer${n === 1 ? '' : 's'}`)
      }} />}
      {del && <Modal title="Delete customers?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await custApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success(`${r.done} customer${r.done === 1 ? '' : 's'} moved to the Recycle Bin`) }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}><Ic n="trash" /> Delete {del.length}</button></>}>
        <p style={{ margin: 0 }}>{del.length === 1 ? <><b>{del[0].name}</b> will be</> : <><b>{del.length} customers</b> will be</>} moved to the Recycle Bin. Their contacts, deals and orders are kept so they can be restored.</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  )
}

function ReassignModal({ rows, meta, onClose, onDone }: { rows: Row[]; meta: Meta; onClose: () => void; onDone: (n: number, failed: { id: number; error: string }[]) => void }) {
  const { error } = useToast()
  const [kam, setKam] = useState('')
  const [busy, setBusy] = useState(false)
  return <Modal title={`Reassign ${rows.length} customer${rows.length === 1 ? '' : 's'}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!kam || busy} onClick={async () => {
      setBusy(true)
      try { const r = await custApi.bulk(rows.map(x => x.id), 'reassign', kam); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="rk">New KAM</label>
      <select id="rk" className="in" value={kam} onChange={e => setKam(e.target.value)}><option value="">Choose a user…</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{ created: number; errors: { row: number; customer?: string; error: string }[]; error_count: number } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const template = async () => {
    try { const b = await custApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'customers-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  return <Modal title="Import customers" width={560} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res ? 'Close' : 'Cancel'}</button>
    {!res && <button type="button" className="btn p" disabled={!file || busy} onClick={async () => {
      if (!file) return
      setBusy(true)
      try { const r = await custApi.importCsv(file); setRes(r); if (r.created) { success(`${r.created} customer${r.created === 1 ? '' : 's'} imported`); onDone() } }
      catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
    }}>{busy ? 'Importing…' : 'Import'}</button>}</>}>
    {!res ? <div className="fg"><div className="f1">
      <label htmlFor="imf">CSV file</label>
      <input id="imf" ref={ref} type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => setFile(e.target.files?.[0] || null)} />
      <small className="mu">One row per customer. Each row goes through the same checks as the customer form – duplicate names, GST format and approvals.</small>
    </div></div>
      : <div><p style={{ marginTop: 0 }}><b>{res.created}</b> imported{res.error_count ? <> · <b className="tbad">{res.error_count}</b> skipped</> : ''}.</p>
        {res.errors.length > 0 && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
          {res.errors.map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.customer ? <b>{x.customer}: </b> : null}{x.error}</span></div>)}</div>}
      </div>}
  </Modal>
}
