// Deals – prototype v17 listPage('opps'): crumb · "Deals" · N records · List & grid | Board · Import · + New deal, saved
// views (All · Tender workflow · Quotation workflow · My deals · Closing ≤ 30 days), grid ID | Journey | Opportunity |
// Customer | Workflow | Value | Win % | Flow | Stage | Owner | Model | Vertical | Close | ⋯ row actions, kanban per
// configured pipeline (Tender: Qualification → Tender Identified → Bidding → Evaluation → Negotiation → Won / Lost), drawer.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster } from '@/pages/leads/leadApi'
import JourneyTrack from '@/pages/leads/JourneyTrack'
import { vDate } from '@/utils/validation'
import DealDrawer from './DealDrawer'
import { useStageMove } from './useStageMove'
import { DueCell } from './kit'
import { dealApi, errMsg, inr, probColor, stagePill, type ImportResult, type ListParams, type Meta, type Row } from './dealApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './deals.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function DealsListPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id: routeId } = useParams()
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [view, setView] = useState<string>(() => store.get('deals:view', 'All'))
  const [mode, setMode] = useState<'list' | 'board'>(() => location.pathname.endsWith('/pipeline') ? 'board' : store.get('deals:mode', 'list'))
  const [pipe, setPipe] = useState<string>(() => store.get('deals:pipe', ''))
  const [stage, setStage] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'stage' | 'q' | 'f' | 'pipeline'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)

  const openId = routeId && /^\d+$/.test(routeId) ? Number(routeId) : sp.get('open') ? Number(sp.get('open')) : null
  const open = useCallback((id: number) => { if (routeId) navigate(`/opportunities?open=${id}`); else setSp(s => { const n = new URLSearchParams(s); n.set('open', String(id)); return n }) }, [routeId, navigate, setSp])
  const close = useCallback(() => { if (routeId) navigate('/opportunities'); else setSp(s => { const n = new URLSearchParams(s); n.delete('open'); return n }) }, [routeId, navigate, setSp])
  const changed = useCallback(() => setRev(r => r + 1), [])

  useEffect(() => { dealApi.meta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All'); setPipe(x => m.pipelines.some(pp => pp.key === x) ? x : (m.pipelines[0]?.key || '')) }).catch(e => error(errMsg(e, 'Could not load Deals'))) }, [error])
  useEffect(() => { store.set('deals:view', view) }, [view])
  useEffect(() => { store.set('deals:mode', mode) }, [mode])
  useEffect(() => { if (pipe) store.set('deals:pipe', pipe) }, [pipe])
  const key = JSON.stringify([view, stage, p, qf, rev, mode, mode === 'board' ? pipe : ''])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const params = mode === 'board' ? { ...p, offset: 0, limit: 1000, pipeline: pipe } : { ...p, pipeline: '' }
    const t = setTimeout(() => {
      dealApi.list({ view, stage, q: qf.q, f: qf.f, ...params })
        .then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load deals')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const can = meta?.can
  const saveClose = useCallback(async (r: Row, v: string) => {
    // inline edit keeps the editor open on an invalid date (an existing deal may keep / move to a past close date)
    const bad = vDate(v, 'Close date')
    if (bad) { error(bad); throw new Error(bad) }
    try { await dealApi.field(r.id, 'close', v); success(`${r.ref} updated`); changed() } catch (e) { error(errMsg(e, 'Could not save the change')); throw e }
  }, [success, error, changed])

  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'ref', t: 'ID', w: 130, fn: r => <b>{r.ref}</b>, sv: r => r.id },
    { k: 'jid', t: 'Journey', w: 236, fn: r => <JourneyTrack j={r.journey} lost={r.stage_kind === 'lost'} onOpen={() => open(r.id)} />, sv: r => r.id },
    { k: 'name', t: 'Opportunity', w: 300, fn: r => <><a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.name}</b></a>{r.pending && <> <Pill s="Pending approval" t="wa" /></>}</> },
    { k: 'customer', t: 'Customer', w: 220 },
    { k: 'workflow', t: 'Workflow', w: 120, fn: r => <Pill s={r.workflow} t={r.destination === 'tender' ? 'ac' : 'wa'} /> },
    { k: 'value', t: 'Value', w: 120, r: true, sum: true, money: true, fn: r => inr(r.value), sv: r => r.value, sumv: r => r.value, sumFmt: n => inr(n) },
    { k: 'prob', t: 'Win %', w: 135, fn: r => <><span className="bar"><i style={{ width: `${Math.min(100, r.prob)}%`, background: probColor(r.prob) }} /></span>{Math.round(r.prob)}%</>, sv: r => r.prob },
    { k: 'flow', t: 'Flow', w: 190, fn: r => r.flow ? <span className="flw">{r.flow}</span> : <span className="mu">—</span> },
    { k: 'stage', t: 'Stage', w: 160, fn: r => <><Pill s={r.stage} t={stagePill(r.stage, r.stage_kind)} />{r.sla === 'breached' && <span className="tbad" title="Stage SLA breached"> ●</span>}</> },
    { k: 'owner', t: 'Owner', w: 160, fn: r => r.owner ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.owner} />{r.owner}</span> : <span className="mu">—</span> },
    // Model names ("Cyber Security", "AED Services") need ~150px; the pill is capped to the cell and ellipsised with a tooltip.
    { k: 'model', t: 'Model', w: 160, txt: r => r.model || '', fn: r => r.model
      ? <span className="pill mu" title={r.model} style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.model}</span>
      : <span className="mu">—</span> },
    { k: 'vertical', t: 'Vertical', w: 180, txt: r => r.vertical || '', fn: r => r.vertical
      ? <span title={r.vertical} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vertical}</span>
      : <span className="mu">—</span> },
    { k: 'close', t: 'Close', w: 150, date: true, fn: r => <DueCell d={r.close} />, sv: r => r.close || '',
      ...(can?.update ? { ed: { t: 'date' as const, value: (r: Row) => r.close || '', save: saveClose } } : {}) },
  ], [can, saveClose, open])

  // prototype menuBtn / gmenu: Open record · Edit · Duplicate · Delete
  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/opportunities/${r.id}/edit`) }] : []),
    ...(can?.create ? [{ l: 'Duplicate', i: <Ic n="copy" />, fn: () => navigate(`/opportunities/new?copy=${r.id}`) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate, open])

  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) out.push(['Reassign', rows => setReassign(rows)])
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const allStages = useMemo(() => [...new Set((meta?.pipelines || []).flatMap(pp => pp.stages.map(s => s.name)))], [meta])
  const stageSel = <select className="in sm" style={{ width: 140 }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
    <option value="">All</option>{allStages.map(s => <option key={s} value={s}>{s}</option>)}</select>
  const tools = <span className="ctools">{stageSel}</span>
  const curPipe = meta?.pipelines.find(pp => pp.key === pipe) || meta?.pipelines[0]

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Deals</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        <div className="row" style={{ gap: 0 }} role="group" aria-label="Layout">
          <button type="button" className={`btn s ${mode === 'list' ? 'p' : ''}`} aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Ic n="table" /> List &amp; grid</button>
          <button type="button" className={`btn s ${mode === 'board' ? 'p' : ''}`} aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Ic n="layout" /> Board</button>
        </div>
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate('/opportunities/new')}><Ic n="plus" /> New deal</button>}
      </div>
      <div className="row wrap mb" style={{ gap: 6 }}>
        {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        {mode === 'list'
          ? <BwGrid id="deals-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} tools={tools} menu={menu}
            server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
          : meta && curPipe && <>
            <div className="tbr">{stageSel}
              <select className="in sm" style={{ width: 140 }} value={curPipe.key} onChange={e => setPipe(e.target.value)} aria-label="Pipeline">
                {meta.pipelines.map(pp => <option key={pp.key} value={pp.key}>{pp.label}</option>)}</select>
              <small>Drag cards between stages. Stages come from Pipelines &amp; Stages for {meta.company || 'this workspace'}.</small></div>
            <Board meta={meta} pipeKey={curPipe.key} rows={data.items} loading={data.loading} total={data.total} onOpen={open} onChanged={changed} />
          </>}
        {meta && !meta.pipelines.length && <div className="empty">No deal pipeline is configured – set one up in Pipelines &amp; Stages.</div>}
      </div>
      {openId && meta && <DealDrawer id={openId} meta={meta} onClose={close} onChanged={changed} onOpen={open} />}
      {reassign && <ReassignModal rows={reassign} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} records`)
      }} />}
      {del && <Modal title="Delete records?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await dealApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success('Moved to recycle bin – restore from the Recycle Bin') }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}>Move to bin</button></>}>
        <p style={{ margin: 0 }}>Move {del.length} selected record{del.length === 1 ? '' : 's'} to the recycle bin?</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  )
}

// prototype kanban('opps'): every configured stage (zero-deal ones too), count · total, cards opportunity · customer · value · owner
function Board({ meta, pipeKey, rows, loading, total, onOpen, onChanged }: { meta: Meta; pipeKey: string; rows: Row[]; loading: boolean; total: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const pipe = meta.pipelines.find(pp => pp.key === pipeKey)!
  const [over, setOver] = useState('')
  const drag = useRef<Row | null>(null)
  const { move, ui } = useStageMove(meta, onChanged, onOpen)
  if (loading && !rows.length) return <div className="empty">Loading…</div>
  return <>
    <div className="kb" style={{ padding: 8 }}>{pipe.stages.map(s => {
      const L = rows.filter(r => r.pipeline === pipe.key && r.stage_id === s.id), sum = L.reduce((a, r) => a + (r.value || 0), 0)
      return <div key={s.id} className={`kc ${over === String(s.id) ? 'dr' : ''}`} data-st={s.name}
        onDragOver={e => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== String(s.id)) setOver(String(s.id)) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => o === String(s.id) ? '' : o) }}
        onDrop={e => { e.preventDefault(); setOver(''); const r = drag.current; drag.current = null; if (r) void move({ id: r.id, name: r.name, stages: pipe.stages, currentId: r.stage_id }, s) }}>
        <h4 style={{ ['--c' as string]: s.kind === 'won' ? 'var(--bw-ok)' : s.kind === 'lost' ? 'var(--bw-ba)' : 'var(--bw-ac)' }} title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''} · ${s.prob}% win`}>
          {s.name}{s.gate !== 'None' && <span className="pill wa" title={`Gate: ${s.gate}`}>{s.gate === 'Approval' ? 'Approval' : 'Checklist'}</span>}<small>{L.length}{sum ? ` · ${inr(sum)}` : ''}</small></h4>
        <div className="cs">{L.map(r => <div key={r.id} className="kcard" draggable data-id={r.id} title={`${r.ref} · ${r.name}`}
          onDragStart={e => { drag.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.id)) }}
          onDragEnd={() => { drag.current = null; setOver('') }}
          onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id) }}>
          <div className="t1">{r.name}</div>
          <small>{r.customer}</small>
          <div className="m"><b style={{ color: 'var(--bw-tx)' }}>{inr(r.value)}</b>{r.pending && <Pill s="Pending" t="wa" />}<Av name={r.owner || '?'} /></div>
        </div>)}</div>
      </div>
    })}</div>
    {total > rows.length && <div className="mu" style={{ padding: '0 12px 10px', fontSize: 12 }}>Showing the first {rows.length} of {total} – narrow with a saved view or the stage filter.</div>}
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
      try { const r = await dealApi.bulk(rows.map(x => x.id), 'reassign', String(u)); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="ro">New owner</label>
      <Lookup id="ro" value={u} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setU(o?.id ?? null)} placeholder="Choose a user…" emptyText="No active users" /></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult | null>(null)
  const template = async () => {
    try { const b = await dealApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'deals-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  const run = async (dry: boolean) => {
    if (!file) return
    setBusy(true)
    try { const r = await dealApi.importCsv(file, dry); setRes(r); if (!dry && r.created) { success(`${r.created} deal${r.created === 1 ? '' : 's'} imported`); onDone() } }
    catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
  }
  return <Modal title="Import deals" width={600} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res && !res.dry_run ? 'Close' : 'Cancel'}</button>
    {(!res || res.dry_run) && <button type="button" className="btn" disabled={!file || busy} onClick={() => run(true)}>Validate</button>}
    {(!res || res.dry_run) && <button type="button" className="btn p" disabled={!file || busy} onClick={() => run(false)}>{busy ? 'Working…' : 'Import'}</button>}</>}>
    <div className="fg"><div className="f1">
      <label htmlFor="imf">CSV file</label>
      <input id="imf" type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => { setFile(e.target.files?.[0] || null); setRes(null) }} />
      <small className="mu">One row per deal. Customer, workflow type, source and owner must match existing records; open deals with the same customer and name are reported as duplicates. Validate first to see the report without creating anything.</small>
    </div></div>
    {res && <div className="mt"><p style={{ margin: '8px 0' }}><b>{res.created}</b> {res.dry_run ? 'ready to import' : 'imported'}
      {res.duplicate_count ? <> · <b className="twarn">{res.duplicate_count}</b> duplicate{res.duplicate_count > 1 ? 's' : ''}</> : ''}
      {res.error_count ? <> · <b className="tbad">{res.error_count}</b> with errors</> : ''}.</p>
      {(res.errors.length > 0 || res.duplicates.length > 0) && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
        {[...res.duplicates, ...res.errors].sort((a, b) => a.row - b.row).map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.name ? <b>{x.name}: </b> : null}{x.error}</span></div>)}</div>}
    </div>}
  </Modal>
}
