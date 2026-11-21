// Bids & Tenders – prototype v17 listPage('tenders'): crumb · "Bids & Tenders" · N records · List & grid | Board · Import ·
// + New bid, saved views (All · My tenders · Due ≤ 7 days · Overdue), grid ID | Journey | Tender | Customer | Portal | Value |
// EMD | Flow | Stage | Submission | Vertical | Bid mgr (inline edit: Submission, Portal), kanban over the stages of every
// tender & bid flow merged in order (WFS(): count · total value; cards title · customer · value · submission · bid manager;
// a drop moves the card to that stage of its own flow through the stage engine).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster } from '@/pages/leads/leadApi'
import { DueCell } from '@/pages/deals/kit'
import JourneyTrack from '@/pages/leads/JourneyTrack'
import { useBidStage } from './useBidStage'
import { bidApi, dto, errMsg, fd, inr, stagePill, type BoardCol, type ImportResult, type ListParams, type Meta, type Opt, type Row } from './bidApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './tenders.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function TendersListPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [portals, setPortals] = useState<Opt[]>([])
  const [view, setView] = useState<string>(() => store.get('tenders:view', 'All'))
  const [mode, setMode] = useState<'list' | 'board'>(() => store.get('tenders:mode', 'list'))
  const [stage, setStage] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'stage' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)
  const changed = useCallback(() => setRev(r => r + 1), [])
  const open = useCallback((id: number) => navigate(`/tenders/${id}`), [navigate])

  useEffect(() => {
    bidApi.meta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Bids & Tenders')))
    bidApi.masters().then(m => setPortals(m.portals)).catch(() => setPortals([]))
  }, [error])
  // dashboard links: /tenders?status=won → Won stage
  useEffect(() => { const s = new URLSearchParams(location.search).get('status'); if (s && meta) { const st = meta.stages.find(x => x.kind === s.toLowerCase() || x.name.toLowerCase() === s.toLowerCase()); if (st) setStage(st.name) } }, [location.search, meta])
  useEffect(() => { store.set('tenders:view', view) }, [view])
  useEffect(() => { store.set('tenders:mode', mode) }, [mode])
  const key = JSON.stringify([view, stage, p, qf, rev, mode])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const params = mode === 'board' ? { ...p, offset: 0, limit: 1000 } : p
    const t = setTimeout(() => {
      bidApi.list({ view, stage, q: qf.q, f: qf.f, ...params })
        .then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load tenders')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const can = meta?.can
  const save = useCallback(async (r: Row, values: Record<string, unknown>) => {
    try { await bidApi.patch(r.id, values); success(`${r.ref} updated`); changed() } catch (e) { error(errMsg(e, 'Could not save the change')); throw e }
  }, [success, error, changed])

  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'ref', t: 'ID', w: 162, nogroup: true, fn: r => <b>{r.ref}</b>, sv: r => r.id },
    { k: 'jid', t: 'Journey', w: 210, txt: r => r.jid, fn: r => <JourneyTrack j={r.journey} lost={r.stage_kind === 'lost'} onOpen={() => open(r.id)} />, sv: r => r.id },
    { k: 'title', t: 'Tender', w: 340, txt: r => `${r.title} ${r.nit}`,
      fn: r => <div className="ttl"><a onClick={e => { e.stopPropagation(); open(r.id) }} title={r.title}><b>{r.title.length > 46 ? `${r.title.slice(0, 46)}…` : r.title}</b></a>
        {r.pending && <> <Pill s="Pending approval" t="wa" /></>}<br /><small>{r.nit || '—'}</small></div> },
    { k: 'customer', t: 'Customer', w: 190 },
    { k: 'portal', t: 'Portal', w: 140, fn: r => r.portal || <span className="mu">—</span>,
      ...(can?.update && portals.length ? { ed: { t: 'sel' as const, o: portals.map(x => x.name), value: (r: Row) => r.portal, save: (r: Row, v: string) => save(r, { portal_id: portals.find(x => x.name === v)?.id ?? null }) } } : {}) },
    { k: 'value', t: 'Value', w: 110, r: true, sum: true, money: true, fn: r => inr(r.value), sv: r => r.value, sumv: r => r.value, sumFmt: n => inr(n) },
    { k: 'emd', t: 'EMD', w: 100, r: true, sum: true, money: true, fn: r => inr(r.emd), sv: r => r.emd, sumv: r => r.emd, sumFmt: n => inr(n) },
    { k: 'flow', t: 'Flow', w: 190, fn: r => r.flow ? <span className="flw">{r.flow}</span> : <span className="mu">—</span> },
    { k: 'stage', t: 'Stage', w: 160, txt: r => r.stage, fn: r => <><Pill s={r.stage} t={stagePill(r.stage, r.stage_kind)} />{r.sla === 'breached' && <span className="tbad" title="Stage SLA breached"> ●</span>}</> },
    { k: 'submit', t: 'Submission', w: 150, date: true, fn: r => <DueCell d={r.submit} />, sv: r => r.submit || '',
      ...(can?.update ? { ed: { t: 'date' as const, value: (r: Row) => r.submit || '', save: (r: Row, v: string) => { if (!v) { error('Bid submission date is required'); throw new Error('required') } return save(r, { submit: v }) } } } : {}) },
    { k: 'vertical', t: 'Vertical', w: 180, txt: r => r.vertical || '', fn: r => r.vertical
      ? <span title={r.vertical} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vertical}</span>
      : <span className="mu">—</span> },
    { k: 'owner', t: 'Bid mgr', w: 150, fn: r => r.owner ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.owner} />{r.owner}</span> : <span className="mu">—</span> },
  ], [can, portals, save, open, error])

  // prototype menuBtn / gmenu: Open record · Edit · Duplicate · Delete
  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/tenders/${r.id}/form`) }] : []),
    ...(can?.create ? [{ l: 'Duplicate', i: <Ic n="copy" />, fn: () => navigate(`/tenders/new?copy=${r.id}`) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate, open])
  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) out.push(['Reassign', rows => setReassign(rows)])
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const stageSel = <select className="in sm" style={{ width: 150 }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
    <option value="">All</option>{(meta?.stages || []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select>

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Bids &amp; Tenders</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        <div className="row" style={{ gap: 0 }} role="group" aria-label="Layout">
          <button type="button" className={`btn s ${mode === 'list' ? 'p' : ''}`} aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Ic n="table" /> List &amp; grid</button>
          <button type="button" className={`btn s ${mode === 'board' ? 'p' : ''}`} aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Ic n="layout" /> Board</button>
        </div>
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate('/tenders/new')}><Ic n="plus" /> New bid</button>}
      </div>
      <div className="row wrap mb" style={{ gap: 6 }}>
        {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        {mode === 'list'
          ? <BwGrid id="tenders-v17c" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} tools={<span className="ctools">{stageSel}</span>} menu={menu}
            server={{ total: data.total, onChange: onServer, chartLimit: 1000 }} chart={{ by: 'stage', donut: true }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
          : meta && <>
            <div className="tbr">{stageSel}<small>Drag cards between stages. Stages come from the Process Designer for {meta.company || 'this workspace'}.</small></div>
            <Board meta={meta} rows={data.items} loading={data.loading} total={data.total} onOpen={open} onChanged={changed} />
          </>}
        {meta && !meta.flows.length && <div className="empty">No tender flow is configured – set one up in the Process Designer.</div>}
      </div>
      {reassign && <ReassignModal rows={reassign} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} records`)
      }} />}
      {del && <Modal title="Delete records?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await bidApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success('Moved to recycle bin – restore from the Recycle Bin') }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}>Move to bin</button></>}>
        <p style={{ margin: 0 }}>Move {del.length} selected record{del.length === 1 ? '' : 's'} to the recycle bin?</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  )
}

// prototype kanban('tenders') over WFS(): the stages of every tender & bid flow merged in order (empty ones too) with their
// gate badge, count · total value; cards title · customer · value · submission (due colouring) · bid manager. A drop moves the
// card to the same-named stage of its own flow through the stage engine.
function Board({ meta, rows, loading, total, onOpen, onChanged }: { meta: Meta; rows: Row[]; loading: boolean; total: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const { warning } = useToast()
  const [over, setOver] = useState('')
  const drag = useRef<Row | null>(null)
  const { move, ui } = useBidStage(meta.lost, !!meta.can.update, onChanged)
  const drop = (r: Row, col: BoardCol) => {
    const flow = meta.flows.find(f => f.key === r.flow_key)
    const target = flow?.stages.find(x => x.id === col.ids[r.flow_key])
    if (!flow || !target) { warning(`“${col.name}” is not a stage of ${r.flow || 'this tender’s flow'}`); return }
    void move({ id: r.id, stages: flow.stages, currentId: r.stage_id }, target)
  }
  if (loading && !rows.length) return <div className="empty">Loading…</div>
  return <>
    <div className="kb" style={{ padding: 8 }}>{meta.board.map(s => {
      const L = rows.filter(r => r.stage === s.name), sum = L.reduce((a, r) => a + (r.value || 0), 0)
      return <div key={s.name} className={`kc ${over === s.name ? 'dr' : ''}`} data-st={s.name}
        onDragOver={e => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== s.name) setOver(s.name) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => o === s.name ? '' : o) }}
        onDrop={e => { e.preventDefault(); setOver(''); const r = drag.current; drag.current = null; if (r && r.stage !== s.name) drop(r, s) }}>
        <h4 style={{ ['--c' as string]: s.kind === 'won' ? 'var(--bw-ok)' : s.kind === 'lost' ? 'var(--bw-ba)' : 'var(--bw-ac)' }} title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`}>
          {s.name}{s.gate !== 'None' && <span className="pill wa" title={`Gate: ${s.gate}`}>{s.gate === 'Approval' ? 'Approval' : 'Checklist'}</span>}<small>{L.length}{sum ? ` · ${inr(sum)}` : ''}</small></h4>
        <div className="cs">{L.map(r => {
          const n = r.submit ? dto(r.submit) : null
          return <div key={r.id} className="kcard" draggable data-id={r.id} title={`${r.ref} · ${r.title}`}
            onDragStart={e => { drag.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.id)) }}
            onDragEnd={() => { drag.current = null; setOver('') }}
            onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id) }}>
            <div className="t1">{r.title.slice(0, 60)}</div>
            <small>{r.customer}</small>
            <div className="m"><b style={{ color: 'var(--bw-tx)' }}>{inr(r.value)}</b>
              {r.submit && <span className={n! < 0 ? 'tbad' : n! <= 7 ? 'twarn' : ''}>{fd(r.submit)}</span>}
              {r.pending && <Pill s="Pending" t="wa" />}<Av name={r.owner || '?'} /></div>
          </div>
        })}</div>
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
      try { const r = await bidApi.bulk(rows.map(x => x.id), 'reassign', String(u)); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="ro">New bid manager</label>
      <Lookup id="ro" value={u} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setU(o?.id ?? null)} placeholder="Choose a user…" emptyText="No active users" /></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResult | null>(null)
  const template = async () => {
    try { const b = await bidApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'tenders-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  const run = async (dry: boolean) => {
    if (!file) return
    setBusy(true)
    try { const r = await bidApi.importCsv(file, dry); setRes(r); if (!dry && r.created) { success(`${r.created} tender${r.created === 1 ? '' : 's'} imported`); onDone() } }
    catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
  }
  return <Modal title="Import tenders" width={600} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res && !res.dry_run ? 'Close' : 'Cancel'}</button>
    {(!res || res.dry_run) && <button type="button" className="btn" disabled={!file || busy} onClick={() => run(true)}>Validate</button>}
    {(!res || res.dry_run) && <button type="button" className="btn p" disabled={!file || busy} onClick={() => run(false)}>{busy ? 'Working…' : 'Import'}</button>}</>}>
    <div className="fg"><div className="f1">
      <label htmlFor="imf">CSV file</label>
      <input id="imf" type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => { setFile(e.target.files?.[0] || null); setRes(null) }} />
      <small className="mu">One row per tender. Customer, portal, category, location and bid manager must match existing master records; a Tender / NIT number that already exists is reported as a duplicate. Validate first to see the report without creating anything.</small>
    </div></div>
    {res && <div className="mt"><p style={{ margin: '8px 0' }}><b>{res.created}</b> {res.dry_run ? 'ready to import' : 'imported'}
      {res.duplicate_count ? <> · <b className="twarn">{res.duplicate_count}</b> duplicate{res.duplicate_count > 1 ? 's' : ''}</> : ''}
      {res.error_count ? <> · <b className="tbad">{res.error_count}</b> with errors</> : ''}.</p>
      {(res.errors.length > 0 || res.duplicates.length > 0) && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
        {[...res.duplicates, ...res.errors].sort((a, b) => a.row - b.row).map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.name ? <b>{x.name}: </b> : null}{x.error}</span></div>)}</div>}
    </div>}
  </Modal>
}
