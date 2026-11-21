// Product & Price Books – prototype v18 R.products():
// header (company crumb · "Product & Price Books" · N products · Import template · Download template · New product),
// product-model summary (pxModelBar), tabs Catalogue | Category map | Price books | Change log | Configuration.
// Catalogue = six KPI cards, status chips, saved views and the grid Product code | [Company] | Product description |
// Category | Used in | Record status | COO | Unit | List price | Std cost | Margin | Updated. Every value comes from
// /api/v1/products (tenant = company, isolated in FastAPI).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { download, errMsg, fd, fdt, inr, mgTone, productApi, stTone, type ListParams, type ListResult, type LogRow, type Matrix, type Meta, type Row } from './productApi'
import { ImportModal, NewProductModal } from './ProductForms'
import PriceBooksTab from './PriceBooksTab'
import ConfigurationTab from './ConfigurationTab'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './products.css'

export const TABS = ['Catalogue', 'Category map', 'Price books', 'Change log', 'Configuration'] as const
export type Tab = typeof TABS[number]
const SLUG: Record<Tab, string> = { 'Catalogue': '', 'Category map': 'map', 'Price books': 'books', 'Change log': 'log', 'Configuration': 'config' }
const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
export const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>

export default function ProductsPage() {
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [modal, setModal] = useState<'new' | 'import' | null>(null)
  const [rev, setRev] = useState(0)
  const tab: Tab = (Object.entries(SLUG).find(([, s]) => s && s === sp.get('tab'))?.[0] as Tab) || 'Catalogue'
  const setTab = useCallback((t: Tab) => setSp(s => { const n = new URLSearchParams(s); if (SLUG[t]) n.set('tab', SLUG[t]); else n.delete('tab'); return n }), [setSp])
  const loadMeta = useCallback(() => productApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load Product & Price Books'))), [error])
  useEffect(() => { void loadMeta() }, [loadMeta])
  // legacy v17 links (?open=<id>) open the product record page
  useEffect(() => { const o = sp.get('open'); if (o) navigate(`/products/${o}`, { replace: true }) }, [sp, navigate])
  const changed = useCallback(() => { setRev(r => r + 1); void loadMeta() }, [loadMeta])
  const can = meta?.can
  const group = (meta?.companies.length || 0) > 1

  const dlTemplate = async () => {
    try { const r = await productApi.template(!!can?.export); download(r.blob, r.name); success(`Template downloaded${can?.export ? ` with ${total ?? 0} products` : ''} for ${meta?.company}`) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }

  return <div className="bwi ppage">
    <div className="pg">
      <div><div className="crumb">{group ? 'All companies' : meta?.company || 'Workspace'}</div><h1>Product &amp; Price Books</h1></div>
      <span className="cnt">{total ?? '…'} products</span>
      <span className="fl" />
      {can?.create && <button type="button" className="btn" onClick={() => setModal('import')}><Ic n="up" /> Import template</button>}
      <button type="button" className="btn" onClick={dlTemplate}><Ic n="dl" /> Download template</button>
      {can?.create && <button type="button" className="btn p" disabled={!meta} onClick={() => setModal('new')}><Ic n="plus" /> New product</button>}
    </div>
    <ModelBar meta={meta} onConfigure={() => setTab('Configuration')} />
    <div className="tabs mb pxtabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`}
      onClick={() => setTab(t)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
    {!meta ? <div className="empty">Loading…</div>
      : tab === 'Catalogue' ? <Catalogue meta={meta} rev={rev} onTotal={setTotal} onChanged={changed} />
      : tab === 'Category map' ? <><Totals onTotal={setTotal} rev={rev} /><CategoryMap meta={meta} /></>
      : tab === 'Price books' ? <><Totals onTotal={setTotal} rev={rev} /><PriceBooksTab meta={meta} /></>
      : tab === 'Change log' ? <><Totals onTotal={setTotal} rev={rev} /><ChangeLog meta={meta} /></>
      : <><Totals onTotal={setTotal} rev={rev} /><ConfigurationTab meta={meta} onSaved={changed} /></>}
    {modal === 'new' && meta && <NewProductModal meta={meta} onClose={() => setModal(null)} onCreated={(id, code) => { setModal(null); success(`${code} created`); navigate(`/products/${id}`) }} />}
    {modal === 'import' && meta && <ImportModal meta={meta} onClose={() => setModal(null)} onDone={msg => { setModal(null); success(msg); setTab('Catalogue'); changed() }} />}
  </div>
}

/** product count for the header on tabs other than Catalogue */
function Totals({ onTotal, rev }: { onTotal: (n: number) => void; rev: number }) {
  useEffect(() => { productApi.list({ view: 'All', status: '', q: '', f: {}, adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 1 }).then(r => onTotal(r.total_all)).catch(() => undefined) }, [rev, onTotal])
  return null
}

/** prototype pxModelBar(): one card per authorised company – model name, categories, groupings, statuses, fields, Configure */
function ModelBar({ meta, onConfigure }: { meta: Meta | null; onConfigure: () => void }) {
  if (!meta) return null
  const group = meta.companies.length > 1
  return <div className="px8-models">{meta.companies.map(c => <div key={c.id} className="px8-model clk" role="button" tabIndex={0} title={`Open the ${c.name} product model configuration`}
    onClick={onConfigure} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConfigure() } }}>
    <span className="px8-mi"><Ic n="layout" /></span>
    <div className="fl"><small className="mu">{group ? c.name : 'Product model'}</small><b>{c.summary.name}</b>
      <div className="px8-mc"><span>{c.summary.categories} categories</span><span>{c.summary.stages} {c.summary.grouping.toLowerCase()}s</span><span>{c.summary.statuses} record statuses</span><span>{c.summary.fields} fields</span></div></div>
    <button type="button" className="btn s" onClick={e => { e.stopPropagation(); onConfigure() }}><Ic n="gear" /> Configure</button>
  </div>)}</div>
}

/* ───────────────────────── Catalogue ───────────────────────── */

function Catalogue({ meta, rev, onTotal, onChanged }: { meta: Meta; rev: number; onTotal: (n: number) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [view, setView] = useState<string>(() => store.get('products:view', 'All'))
  const [status, setStatus] = useState<string>(() => store.get('products:status', 'All'))
  const [p, setP] = useState<Omit<ListParams, 'view' | 'status' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<ListResult & { loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, status_counts: [], kpi: null as never, min_margin: 0, loading: true })
  const [del, setDel] = useState<Row[] | null>(null)
  const [mine, setMine] = useState(0)
  useEffect(() => { store.set('products:view', view) }, [view])
  useEffect(() => { store.set('products:status', status) }, [status])
  const key = JSON.stringify([view, status, p, qf, rev, mine])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      productApi.list({ view, status, q: qf.q, f: qf.f, ...p })
        .then(r => { if (live) { setData({ ...r, loading: false }); onTotal(r.total_all) } })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load products')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const open = useCallback((id: number) => navigate(`/products/${id}`), [navigate])
  const m = meta.model, can = meta.can, group = meta.companies.length > 1, min = data.min_margin

  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'code', t: 'Product code', w: 130, fn: r => <b>{r.code}</b>, txt: r => r.code },
    ...(group ? [{ k: 'co', t: 'Company', w: 90, fn: () => meta.company, txt: () => meta.company } as GridCol<Row>] : []),
    { k: 'name', t: 'Product description', w: 300, txt: r => r.name, fn: r => <><a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.name}</b></a><br />
      <small className="mu">{r.longDesc.slice(0, 70)}{r.longDesc.length > 70 ? '…' : ''}</small></> },
    { k: 'cat', t: 'Category', w: 190, fn: r => r.cat || <span className="mu">—</span> },
    { k: 'used', t: 'Used in', w: 120, sv: r => r.used, txt: r => String(r.used), fn: r => `${r.used} categor${r.used === 1 ? 'y' : 'ies'}` },
    { k: 'status', t: 'Record status', w: 150, txt: r => r.status, fn: r => <>{r.status ? <Pill s={r.status} t={stTone(m, r.status)} /> : <span className="mu">—</span>}
      {r.pending_status && <small className="mu" title={`Waiting for approval to move to ${r.pending_status}`}> ⏳</small>}</> },
    { k: 'coo', t: 'COO', w: 90, fn: r => r.coo || <span className="mu">—</span> },
    { k: 'unit', t: 'Unit', w: 70, fn: r => r.unit || <span className="mu">—</span> },
    { k: 'list', t: 'List price', w: 110, r: true, money: true, sv: r => r.list ?? -1, fn: r => r.list != null ? inr(r.list) : <span className="mu">—</span> },
    { k: 'cost', t: 'Std cost', w: 110, r: true, money: true, sv: r => r.cost ?? -1, fn: r => r.cost != null ? inr(r.cost) : <span className="mu">—</span> },
    { k: 'margin', t: 'Margin', w: 80, r: true, sv: r => r.margin, fn: r => <span className={mgTone(r.margin, min)}>{r.margin}%</span> },
    { k: 'updated_at', t: 'Updated', w: 110, date: true, sv: r => r.updated_at || '', fn: r => fd(r.updated_at) },
  ], [group, meta.company, m, min, open])
  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can.delete && r.status !== m.lock ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, m.lock, open])
  const bulk = useMemo((): [string, (rows: Row[]) => void][] => can.delete ? [['Delete', rows => setDel(rows)]] : [], [can])
  const k = data.kpi
  const exportCsv = async () => { try { download(await productApi.exportCsv(view, status), 'products.csv') } catch (e) { error(errMsg(e, 'Could not export')) } }
  const tools = can.export ? <span className="ctools"><button type="button" className="btn s" title="Export the catalogue (CSV)" onClick={exportCsv}><Ic n="dl" /> CSV</button></span> : undefined

  return <>
    {/* six KPI cards, one row (prototype strip) */}
    <div className="strip px6">{([
      ['Products', k ? k.products : '…', null, ''],
      [group ? 'Approved / released' : (k?.lock_label || m.lock), k ? k.approved : '…', k ? `${k.approved_pct}% of catalogue` : null, 'tok'],
      ['In review', k ? k.review : '…', null, k?.review ? 'twarn' : ''],
      ['Draft', k ? k.draft : '…', null, ''],
      ['Categories in use', k ? k.categories : '…', null, ''],
      ['Avg margin', k ? `${k.avg_margin}%` : '…', null, ''],
    ] as [string, string | number, string | null, string][]).map(([l, v, d, dc]) => <div key={l} className={`st ${dc}`}><div className="sth"><label>{l}</label></div><b>{v}</b>{d && <i className={dc}>{d}</i>}</div>)}</div>
    {/* status chips (configured record statuses) */}
    <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
      {[{ name: 'All', count: data.total_all }, ...data.status_counts].map(s => <span key={s.name} role="button" tabIndex={0} className={`chip ${status === s.name ? 'on' : ''}`}
        onClick={() => setStatus(s.name)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatus(s.name) } }}>{s.name} <small>{s.count}</small></span>)}
    </div>
    {/* saved views */}
    <div className="row wrap mb" style={{ gap: 6 }}>
      {meta.views.map(v => <span key={v} role="button" tabIndex={0} className={`chip vw ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>{v} <small>{data.counts[v] ?? ''}</small></span>)}
    </div>
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id="products-v18" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} menu={menu} tools={tools}
        server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No products match the current filters.'} />
    </div>
    {del && <Modal title="Delete products?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => {
        try { const r = await productApi.bulk(del.map(x => x.id)); setDel(null); setMine(x => x + 1); onChanged(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success(`${r.done} deleted`) }
        catch (e) { error(errMsg(e, 'Could not delete')) }
      }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete {del.length} selected product{del.length === 1 ? '' : 's'}? {m.lock} products cannot be deleted – retire them through the lifecycle. Quotes that already use them keep their lines.</p>
    </Modal>}
  </>
}

/* ───────────────────────── Category map ───────────────────────── */

function CategoryMap({ meta }: { meta: Meta }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [internal, setInternal] = useState<boolean>(() => store.get('products:internal', false))
  const [d, setD] = useState<Matrix | null>(null)
  useEffect(() => { store.set('products:internal', internal) }, [internal])
  useEffect(() => { let live = true; productApi.matrix(internal).then(x => { if (live) setD(x) }).catch(e => error(errMsg(e, 'Could not load the category map'))); return () => { live = false } }, [internal, error])
  if (!d) return <div className="empty">Loading…</div>
  return <>
    <div className="row wrap mb" style={{ gap: 10 }}>
      <span className="mu">{meta.companies.length > 1 ? `${meta.company} · ` : ''}{d.model} · {d.grouping} × category · {d.active} active products · rows from each product’s Category mapping</span><span className="fl" />
      {d.has_internal && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> Show internal groupings</label>}
    </div>
    <div className="panel"><div className="pb z">
      {!d.categories.length ? <div className="empty">No categories configured – add them under Configuration.</div> :
        <div className="px8-mx" style={{ gridTemplateColumns: `170px repeat(${d.categories.length}, minmax(150px, 1fr))` }}>
          <div className="h" />
          {d.categories.map(c => <div key={c.id} className="h">{c.name}{c.internal && <> <span className="pill mu">internal</span></>}<small>{c.products} products</small></div>)}
          {d.stages.map(s => <MatrixRow key={s.id} stage={s} cats={d.categories} cells={d.cells} onOpen={id => navigate(`/products/${id}`)} />)}
        </div>}
    </div></div>
    <div className="row mt wrap" style={{ gap: 12 }}>
      <span className="px8-pc pr" style={{ cursor: 'default' }}>Primary</span><span className="px8-pc" style={{ cursor: 'default' }}>Supporting</span>
      {d.unmapped.length > 0 && <span className="twarn">{d.unmapped.length} product{d.unmapped.length > 1 ? 's are' : ' is'} not mapped yet: {d.unmapped.map((p, i) =>
        <span key={p.id}>{i ? ', ' : ''}<a onClick={() => navigate(`/products/${p.id}`)} title={p.name}>{p.code}</a></span>)}</span>}
    </div>
  </>
}

function MatrixRow({ stage, cats, cells, onOpen }: { stage: { id: number; name: string }; cats: Matrix['categories']; cells: Matrix['cells']; onOpen: (id: number) => void }) {
  return <>
    <div className="rh">{stage.name}</div>
    {cats.map(c => <div key={c.id} className="cl">{(cells[`${stage.id}:${c.id}`] || []).map(x =>
      <a key={`${x.id}-${x.role}`} className={`px8-pc ${x.role === 'Primary' ? 'pr' : ''}`} title={`${x.name} · ${x.role}${x.rm ? ` · ${x.rm}` : ''}`} onClick={() => onOpen(x.id)}
        onKeyDown={e => { if (e.key === 'Enter') onOpen(x.id) }} tabIndex={0} role="link">{x.code}<small>{x.name.slice(0, 22)}</small></a>)}</div>)}
  </>
}

/* ───────────────────────── Change log ───────────────────────── */

function ChangeLog({ meta }: { meta: Meta }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [f, setF] = useState<{ product_id: number | ''; user_id: number | ''; date_from: string; date_to: string }>({ product_id: '', user_id: '', date_from: '', date_to: '' })
  const [d, setD] = useState<{ items: LogRow[]; users: { id: number; name: string }[]; products: { id: number; code: string; name: string }[] } | null>(null)
  const [opts, setOpts] = useState<{ users: { id: number; name: string }[]; products: { id: number; code: string; name: string }[] }>({ users: [], products: [] })
  useEffect(() => {
    let live = true
    productApi.changelog(f).then(x => { if (live) { setD(x); if (!f.product_id && !f.user_id && !f.date_from && !f.date_to) setOpts({ users: x.users, products: x.products }) } })
      .catch(e => error(errMsg(e, 'Could not load the change log')))
    return () => { live = false }
  }, [f, error])
  const group = meta.companies.length > 1
  const cols: GridCol<LogRow>[] = useMemo(() => [
    { k: 'date', t: 'Date', w: 150, sv: r => r.date || '', txt: r => fdt(r.date), fn: r => fdt(r.date) },
    ...(group ? [{ k: 'co', t: 'Company', w: 90, fn: () => meta.company, txt: () => meta.company } as GridCol<LogRow>] : []),
    { k: 'code', t: 'Product code', w: 130, txt: r => r.code || r.book, fn: r => r.product_id ? <a onClick={e => { e.stopPropagation(); navigate(`/products/${r.product_id}`) }}><b>{r.code}</b></a> : <span className="mu">{r.book ? 'Price book' : '—'}</span> },
    { k: 'name', t: 'Product', w: 200, txt: r => r.name || r.book, fn: r => r.name || r.book || <span className="mu">—</span> },
    { k: 'field', t: 'Sheet / field', w: 240 },
    { k: 'old', t: 'Previous value', w: 170, fn: r => <span className="mu">{r.old || '—'}</span> },
    { k: 'new', t: 'New value', w: 170, fn: r => <b>{r.new || '—'}</b> },
    { k: 'reason', t: 'Reason for change', w: 240, fn: r => r.reason || <span className="mu">—</span> },
    { k: 'by', t: 'Changed by', w: 160, fn: r => r.by || <span className="mu">System</span> },
    { k: 'approver', t: 'Approved by', w: 170, fn: r => r.approver || <span className="mu">—</span> },
    { k: 'approval', t: 'Approval', w: 120, fn: r => r.approval && r.approval !== 'Not required' ? <Pill s={r.approval} t={r.approval === 'Approved' ? 'ok' : r.approval === 'Pending' ? 'wa' : 'ba'} /> : <span className="mu">Not required</span> },
  ], [group, meta.company, navigate])
  return <>
    <div className="note inf mb">Every change to a product or price book is recorded with date, field, previous and new value, reason, who changed it and who approved it – the Change Log sheet of the template. The history cannot be edited.</div>
    <div className="row wrap mb" style={{ gap: 8 }}>
      {group && <select className="in sm" style={{ width: 170 }} value={meta.companies[0].id} disabled aria-label="Company"><option>{meta.company}</option></select>}
      <select className="in sm" style={{ width: 220 }} aria-label="Product" value={f.product_id} onChange={e => setF(s => ({ ...s, product_id: e.target.value ? Number(e.target.value) : '' }))}>
        <option value="">All products</option>{opts.products.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>
      <select className="in sm" style={{ width: 170 }} aria-label="Changed by" value={f.user_id} onChange={e => setF(s => ({ ...s, user_id: e.target.value ? Number(e.target.value) : '' }))}>
        <option value="">All users</option>{opts.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <label className="row" style={{ gap: 4 }}><small className="mu">From</small><input type="date" className="in sm" value={f.date_from} max={f.date_to || undefined} onChange={e => setF(s => ({ ...s, date_from: e.target.value }))} /></label>
      <label className="row" style={{ gap: 4 }}><small className="mu">To</small><input type="date" className="in sm" value={f.date_to} min={f.date_from || undefined} onChange={e => setF(s => ({ ...s, date_to: e.target.value }))} /></label>
      {(f.product_id || f.user_id || f.date_from || f.date_to) && <button type="button" className="btn g s" onClick={() => setF({ product_id: '', user_id: '', date_from: '', date_to: '' })}>Clear</button>}
    </div>
    <div className="panel">{!d ? <div className="empty">Loading…</div> :
      <BwGrid id="px-log-v18" cols={cols} rows={d.items} rid={r => r.id} onRow={r => { if (r.product_id) navigate(`/products/${r.product_id}`) }} empty="No changes recorded yet." />}</div>
  </>
}
