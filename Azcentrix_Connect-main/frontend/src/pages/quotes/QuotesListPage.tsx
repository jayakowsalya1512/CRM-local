// Quotes – prototype v17 listPage('quotes'): crumb · "Quotes" · N records · List & grid | Board · Import · + New quote,
// saved views (All · My quotes · Multiple revisions · Expiring ≤ 7d), grid Quote no. | Company | Journey | Subject | Customer | Revision |
// Latest value | Stage | Owner | Valid till | ⋯ (Open record · Edit · Duplicate · Delete), kanban over the configured quote lifecycle (Draft → Internal Review →
// Sent to Customer → Under Negotiation → Accepted / Rejected). Clicking a quote opens its page (/quotations/:id).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import JourneyTrack from '@/pages/leads/JourneyTrack'
import { masters, useMaster } from '@/pages/leads/leadApi'
import { useQuoteStage } from './useQuoteStage'
import QuoteSettingsModal from './QuoteSettingsModal'
import JourneyTimeline from './JourneyTimeline'
import { errMsg, fd, inr, quoteApi, stagePill, type Detail, type ImportResult, type ListParams, type Meta, type Row } from './quoteApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/tenders/tenders.css'
import './quotes.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function QuotesListPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [view, setView] = useState<string>(() => store.get('quotes:view', 'All'))
  const [mode, setMode] = useState<'list' | 'board'>(() => store.get('quotes:mode', 'list'))
  const [stage, setStage] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'stage' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [settings, setSettings] = useState(false)
  const [journey, setJourney] = useState<Detail | null>(null)

  const open = useCallback((id: number) => navigate(`/quotations/${id}`), [navigate])
  const changed = useCallback(() => setRev(r => r + 1), [])
  // prototype jchip → jopen: the journey timeline of that quote
  const openJourney = useCallback((id: number) => { quoteApi.get(id).then(setJourney).catch(e => error(errMsg(e, 'Could not open the journey'))) }, [error])

  const loadMeta = useCallback(() => quoteApi.meta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Quotes'))), [error])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => { store.set('quotes:view', view) }, [view])
  useEffect(() => { store.set('quotes:mode', mode) }, [mode])
  const key = JSON.stringify([view, stage, p, qf, rev, mode])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const params = mode === 'board' ? { ...p, offset: 0, limit: 1000 } : p
    const t = setTimeout(() => {
      quoteApi.list({ view, stage, q: qf.q, f: qf.f, ...params })
        .then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load quotes')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Record view → "quotation history" of a lead: open that lead's latest quote
  const leadId = (location.state as { openLeadId?: number } | null)?.openLeadId
  useEffect(() => {
    if (!leadId) return
    quoteApi.list({ view: 'All', stage: '', q: '', f: {}, adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 1000 })
      .then(r => { const m = r.items.find(x => x.lead_id === leadId); if (m) navigate(`/quotations/${m.id}`, { replace: true }); else warning('No quote is linked to that record') })
      .catch(() => undefined)
  }, [leadId]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const can = meta?.can

  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'ref', t: 'Quote no.', w: 140, fn: r => <b>{r.ref}</b>, sv: r => r.id },
    // prototype colsOf(): Company (f:'co' → accent pill, w 96)
    { k: 'company', t: 'Company', w: 96, fn: r => r.company ? <span className="pill ac qco" title={r.company}>{r.company}</span> : <span className="mu">—</span> },
    // prototype jTrack() (replaces jchip in the grid, w 210): J-id · L D Q O steps (done / current / rejected) · current step label;
    // click → jopen (journey timeline). '—' when the quote is in no journey.
    { k: 'jid', t: 'Journey', w: 210, txt: r => r.jid || '', sv: r => r.jid || '',
      fn: r => r.jid ? <JourneyTrack j={{ ...r.journey, id: r.jid }} lost={r.stage_kind === 'lost'} onOpen={() => openJourney(r.id)} /> : <span className="mu">—</span> },
    { k: 'subject', t: 'Subject', w: 320, fn: r => <><a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.subject.slice(0, 44)}</b></a>{r.pending && <> <Pill s="Pending approval" t="wa" /></>}</> },
    { k: 'customer', t: 'Customer', w: 220 },
    { k: 'rev', t: 'Revision', w: 110, fn: r => <><span className="pill ac">Rev {r.rev}</span> <small>of {r.revs}</small></>, sv: r => r.rev },
    { k: 'value', t: 'Latest value', w: 130, r: true, sum: true, money: true, fn: r => inr(r.value), sv: r => r.value, sumv: r => r.value, sumFmt: n => inr(n) },
    { k: 'stage', t: 'Stage', w: 160, fn: r => <Pill s={r.stage} t={stagePill(r.stage, r.stage_kind)} /> },
    { k: 'owner', t: 'Owner', w: 170, fn: r => r.owner ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.owner} />{r.owner}</span> : <span className="mu">—</span> },
    { k: 'valid_till', t: 'Valid till', w: 120, date: true, fn: r => fd(r.valid_till), sv: r => r.valid_till || '' },
  ], [open, openJourney])

  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/quotations/${r.id}/edit`) }] : []),
    ...(can?.create ? [{ l: 'Duplicate', i: <Ic n="copy" />, fn: () => { quoteApi.duplicate(r.id).then(x => { success(x.message); changed() }).catch(e => error(errMsg(e, 'Could not duplicate'))) } }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate, open, success, error, changed])

  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) out.push(['Reassign', rows => setReassign(rows)])
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const stageSel = <select className="in sm" style={{ width: 160 }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
    <option value="">All</option>{(meta?.stages || []).map(s => <option key={s.id} value={s.name}>{s.name}</option>)}</select>
  const tools = <span className="ctools">{stageSel}</span>

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Quotes</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        <div className="row" style={{ gap: 0 }} role="group" aria-label="Layout">
          <button type="button" className={`btn s ${mode === 'list' ? 'p' : ''}`} aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Ic n="table" /> List &amp; grid</button>
          <button type="button" className={`btn s ${mode === 'board' ? 'p' : ''}`} aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Ic n="layout" /> Board</button>
        </div>
        {can?.configure && <button type="button" className="btn" title="Settings → Quotes: GST, validity, discount limit, commercial terms" onClick={() => setSettings(true)}><Ic n="gear" /></button>}
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate('/quotations/new')}><Ic n="plus" /> New quote</button>}
      </div>
      <div className="row wrap mb" style={{ gap: 6 }}>
        {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        {mode === 'list'
          ? <BwGrid id="quotes-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} tools={tools} menu={menu}
            server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
          : meta && <>
            <div className="tbr">{stageSel}<small>Drag cards between stages. Stages come from Pipelines &amp; Stages for {meta.company || 'this workspace'}.</small></div>
            <Board meta={meta} rows={data.items} loading={data.loading} total={data.total} onOpen={open} onChanged={changed} />
          </>}
        {meta && !meta.stages.length && <div className="empty">No quote lifecycle is configured – set one up in Pipelines &amp; Stages.</div>}
      </div>
      {reassign && <ReassignModal rows={reassign} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} records`)
      }} />}
      {del && <Modal title="Delete records?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await quoteApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success(`${r.done} deleted`) }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}>Delete</button></>}>
        <p style={{ margin: 0 }}>Delete {del.length} selected record{del.length === 1 ? '' : 's'}? Only quotes still in the first stage (with no approval pending or work order) can be deleted; every revision of the quote is removed and the deletion is audit-logged.</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
      {journey && <JourneyTimeline d={journey} onClose={() => setJourney(null)} navigate={navigate} />}
      {settings && <QuoteSettingsModal onClose={() => setSettings(false)} onSaved={() => { setSettings(false); void loadMeta() }} />}
    </div>
  )
}

// prototype kanban('quotes'): every configured stage (empty ones too), count · total, cards subject · customer · value · owner
function Board({ meta, rows, loading, total, onOpen, onChanged }: { meta: Meta; rows: Row[]; loading: boolean; total: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const [over, setOver] = useState('')
  const drag = useRef<Row | null>(null)
  const { move, ui } = useQuoteStage(meta.lost, meta.can.update, onChanged)
  if (loading && !rows.length) return <div className="empty">Loading…</div>
  return <>
    <div className="kb" style={{ padding: 8 }}>{meta.stages.map(s => {
      const L = rows.filter(r => r.stage_id === s.id), sum = L.reduce((a, r) => a + (r.value || 0), 0)
      return <div key={s.id} className={`kc ${over === String(s.id) ? 'dr' : ''}`} data-st={s.name}
        onDragOver={e => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== String(s.id)) setOver(String(s.id)) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => o === String(s.id) ? '' : o) }}
        onDrop={e => { e.preventDefault(); setOver(''); const r = drag.current; drag.current = null; if (r) void move({ id: r.id, name: r.subject, stages: meta.stages, currentId: r.stage_id }, s) }}>
        <h4 style={{ ['--c' as string]: s.kind === 'won' ? 'var(--bw-ok)' : s.kind === 'lost' ? 'var(--bw-ba)' : 'var(--bw-ac)' }} title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`}>
          {s.name}{s.gate !== 'None' && <span className="pill wa" title={`Gate: ${s.gate}`}>{s.gate}</span>}<small>{L.length}{sum ? ` · ${inr(sum)}` : ''}</small></h4>
        <div className="cs">{L.map(r => <div key={r.id} className="kcard" draggable={meta.can.update && !r.pending} data-id={r.id} title={`${r.ref} · ${r.subject}`}
          onDragStart={e => { drag.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.id)) }}
          onDragEnd={() => { drag.current = null; setOver('') }}
          onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id) }}>
          <div className="t1">{r.subject.slice(0, 50)}</div>
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
      try { const r = await quoteApi.bulk(rows.map(x => x.id), 'reassign', String(u)); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="qro">New owner</label>
      <Lookup id="qro" value={u} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setU(o?.id ?? null)} placeholder="Choose a user…" emptyText="No active users" /></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult | null>(null)
  const template = async () => {
    try { const b = await quoteApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'quotes-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  const run = async (dry: boolean) => {
    if (!file) return
    setBusy(true)
    try { const r = await quoteApi.importCsv(file, dry); setRes(r); if (!dry && r.created) { success(`${r.created} quote${r.created === 1 ? '' : 's'} imported`); onDone() } }
    catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
  }
  return <Modal title="Import quotes" width={600} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res && !res.dry_run ? 'Close' : 'Cancel'}</button>
    {(!res || res.dry_run) && <button type="button" className="btn" disabled={!file || busy} onClick={() => run(true)}>Validate</button>}
    {(!res || res.dry_run) && <button type="button" className="btn p" disabled={!file || busy} onClick={() => run(false)}>{busy ? 'Working…' : 'Import'}</button>}</>}>
    <div className="fg"><div className="f1">
      <label htmlFor="qimf">CSV file</label>
      <input id="qimf" type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => { setFile(e.target.files?.[0] || null); setRes(null) }} />
      <small className="mu">One row per quote (Subject, Customer, Enquiry reference, Valid till, Owner email). Customer and owner must match existing records; an open quote with the same customer and subject is reported as a duplicate. Line items are added on the quote page after import. Validate first to see the report without creating anything.</small>
    </div></div>
    {res && <div className="mt"><p style={{ margin: '8px 0' }}><b>{res.created}</b> {res.dry_run ? 'ready to import' : 'imported'}
      {res.duplicate_count ? <> · <b className="twarn">{res.duplicate_count}</b> duplicate{res.duplicate_count > 1 ? 's' : ''}</> : ''}
      {res.error_count ? <> · <b className="tbad">{res.error_count}</b> with errors</> : ''}.</p>
      {(res.errors.length > 0 || res.duplicates.length > 0) && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
        {[...res.duplicates, ...res.errors].sort((a, b) => a.row - b.row).map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.name ? <b>{x.name}: </b> : null}{x.error}</span></div>)}</div>}
    </div>}
  </Modal>
}
