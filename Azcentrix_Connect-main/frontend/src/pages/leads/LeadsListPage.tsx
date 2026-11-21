// Leads – prototype v17 listPage('leads'): crumb · "Leads" · N records · List & grid | Board · Import · + New lead,
// saved views (All · My leads · Hot (score ≥ N) · Follow-up due), grid ID | Journey | Company | Contact | Source |
// Interest | Value | Score | Flow | Stage | Owner | Model | Vertical | Follow-up | ⋯ row actions, the 7-stage board (New · Contacted · Qualified · Proposal Pending ·
// Nurturing · Converted · Disqualified) and the detail drawer (?open=<id> or /leads/:id).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import JourneyTrack from './JourneyTrack'
import LeadDrawer from './LeadDrawer'
import Lookup from './Lookup'
import { LostModal, NextStepModal } from './StageModals'
import { dto, errMsg, fd, inr, isOpen, leadApi, masters, stageLabel, stageOf, stageTone, useMaster, type ListParams, type Meta, type Row } from './leadApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './leads.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const scoreColor = (s: number, hot: number) => s >= hot ? 'var(--bw-ok)' : s >= 50 ? 'var(--bw-wa)' : 'var(--bw-ba)'

export default function LeadsListPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { id: routeId } = useParams()
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [view, setView] = useState<string>(() => store.get('leads:view', 'All'))
  const [mode, setMode] = useState<'list' | 'board'>(() => location.pathname.endsWith('/pipeline') ? 'board' : store.get('leads:mode', 'list'))
  const [stage, setStage] = useState('')
  const [p, setP] = useState<Omit<ListParams, 'view' | 'stage' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [reassign, setReassign] = useState<Row[] | null>(null)
  const [bulkStage, setBulkStage] = useState<Row[] | null>(null)
  const [del, setDel] = useState<Row[] | null>(null)
  const [importing, setImporting] = useState(false)

  const openId = routeId ? Number(routeId) : sp.get('open') ? Number(sp.get('open')) : null
  const open = (id: number) => { if (routeId) navigate(`/leads?open=${id}`); else setSp(s => { const n = new URLSearchParams(s); n.set('open', String(id)); return n }) }
  const close = useCallback(() => { if (routeId) navigate('/leads'); else setSp(s => { const n = new URLSearchParams(s); n.delete('open'); return n }) }, [routeId, navigate, setSp])

  useEffect(() => { leadApi.meta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Leads'))) }, [error])
  useEffect(() => { store.set('leads:view', view) }, [view])
  useEffect(() => { store.set('leads:mode', mode) }, [mode])
  const key = JSON.stringify([view, stage, p, qf, rev, mode])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const params = mode === 'board' ? { ...p, offset: 0, limit: 250 } : p
    const t = setTimeout(() => {
      leadApi.list({ view, stage, q: qf.q, f: qf.f, ...params })
        .then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load leads')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const hot = meta?.hot_threshold ?? 75
  const can = meta?.can

  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'ref', t: 'ID', w: 110, fn: r => <span className="mono"><b>{r.ref}</b></span>, sv: r => r.id },
    { k: 'jid', t: 'Journey', w: 236, fn: r => <JourneyTrack j={r.journey} lost={r.stage === 'Lost'} onOpen={() => open(r.id)} />, sv: r => r.id },
    { k: 'company', t: 'Company', w: 230, fn: r => <><a onClick={e => { e.stopPropagation(); open(r.id) }}><b>{r.company}</b></a>{r.approval_status === 'pending' && <> <Pill s="Pending approval" t="wa" /></>}</> },
    { k: 'contact', t: 'Contact', w: 160 },
    { k: 'source', t: 'Source', w: 140 },
    { k: 'interest', t: 'Interest', w: 190 },
    { k: 'value', t: 'Value', w: 110, r: true, sum: true, money: true, fn: r => inr(r.value), sv: r => r.value, sumv: r => r.value, sumFmt: n => inr(n) },
    { k: 'score', t: 'Score', w: 110, fn: r => <span className="lscore" title={`Lead score ${r.score}/100`}><span className="bar"><i style={{ width: `${r.score}%`, background: scoreColor(r.score, hot) }} /></span>{r.score}</span>, sv: r => r.score },
    { k: 'flow', t: 'Flow', w: 190, fn: r => r.flow ? <span className="flw">{r.flow}</span> : <span className="mu">—</span> },
    { k: 'stage', t: 'Stage', w: 150, fn: r => <Pill s={stageLabel(r.stage)} t={stageTone(r.stage)} />, sv: r => stageLabel(r.stage) },
    { k: 'owner', t: 'Owner', w: 160, fn: r => r.owner ? <span className="row" style={{ gap: 6, display: 'inline-flex' }}><Av name={r.owner} /> {r.owner}</span> : <span className="mu">unassigned</span> },
    // Model names ("Cyber Security", "AED Services") need ~150px; the pill is capped to the cell and ellipsised with a tooltip.
    { k: 'model', t: 'Model', w: 160, txt: r => r.model || '', fn: r => r.model
      ? <span className="pill mu" title={r.model} style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{r.model}</span>
      : <span className="mu">—</span> },
    { k: 'vertical', t: 'Vertical', w: 180, txt: r => r.vertical || '', fn: r => r.vertical
      ? <span title={r.vertical} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vertical}</span>
      : <span className="mu">—</span> },
    { k: 'follow_up', t: 'Follow-up', w: 120, date: true, fn: r => r.follow_up ? <span className={dto(r.follow_up) < 0 && isOpen(r.stage) ? 'ldue' : ''}>{fd(r.follow_up)}</span> : <span className="mu">—</span>, sv: r => r.follow_up || '' },
  ], [hot]) // eslint-disable-line react-hooks/exhaustive-deps

  // prototype menuBtn / gmenu: Open record · Edit · Delete
  const menu = useCallback((r: Row): GridMenuItem[] => [
    { l: 'Open record', i: <Ic n="eye" />, fn: () => open(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/leads/${r.id}/edit`) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ], [can, navigate]) // eslint-disable-line react-hooks/exhaustive-deps

  const bulk = useMemo(() => {
    const out: [string, (rows: Row[]) => void][] = []
    if (can?.update) { out.push(['Reassign', rows => setReassign(rows)]); out.push(['Change stage', rows => setBulkStage(rows)]) }
    if (can?.delete) out.push(['Delete', rows => setDel(rows)])
    return out
  }, [can])

  const stageSel = <select className="in sm" style={{ width: 140 }} value={stage} onChange={e => setStage(e.target.value)} aria-label="Stage">
    <option value="">All</option>{(meta?.stages || []).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
  const tools = <span className="ctools">{stageSel}</span>

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Leads</h1></div>
        <span className="cnt">{data.total_all} records</span>
        <span className="fl" />
        <div className="row" style={{ gap: 0 }} role="group" aria-label="Layout">
          <button type="button" className={`btn s ${mode === 'list' ? 'p' : ''}`} aria-pressed={mode === 'list'} onClick={() => setMode('list')}><Ic n="table" /> List &amp; grid</button>
          <button type="button" className={`btn s ${mode === 'board' ? 'p' : ''}`} aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Ic n="layout" /> Board</button>
        </div>
        {can?.create && <button type="button" className="btn" onClick={() => setImporting(true)}><Ic n="up" /> Import</button>}
        {can?.create && <button type="button" className="btn p" onClick={() => navigate('/leads/new')}><Ic n="plus" /> New lead</button>}
      </div>
      <div className="row wrap mb" style={{ gap: 6 }}>
        {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>
          {v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
      </div>
      <div className="panel" aria-busy={data.loading}>
        {mode === 'list'
          ? <BwGrid id="leads-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => open(r.id)} bulk={bulk} tools={tools} menu={menu}
            server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No records match the current filters.'} />
          : meta && <>
            <div className="tbr">{stageSel}
              <small>Drag cards between stages. Stages come from the lead workflow for {meta.company || 'this workspace'}.</small></div>
            <Board meta={meta} rows={data.items} loading={data.loading} total={data.total} onOpen={open} onMoved={changed} />
          </>}
      </div>
      {openId && meta && <LeadDrawer id={openId} meta={meta} onClose={close} onChanged={changed} />}
      {reassign && <ReassignModal rows={reassign} onClose={() => setReassign(null)} onDone={(n, failed) => {
        setReassign(null); changed(); failed.length ? warning(`${n} reassigned`, `${failed.length} not changed: ${failed[0].error}`) : success(`Reassigned ${n} lead${n === 1 ? '' : 's'}`)
      }} />}
      {bulkStage && meta && <StageModal rows={bulkStage} meta={meta} onClose={() => setBulkStage(null)} onDone={(n, failed) => {
        setBulkStage(null); changed(); failed.length ? warning(`${n} moved`, `${failed.length} not moved: ${failed[0].error}`) : success(`Moved ${n} lead${n === 1 ? '' : 's'}`)
      }} />}
      {del && <Modal title="Delete leads?" width={440} onClose={() => setDel(null)} foot={<><span className="fl" />
        <button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={async () => {
          try { const r = await leadApi.bulk(del.map(x => x.id), 'delete'); setDel(null); changed(); r.failed.length ? warning(`${r.done} deleted`, `${r.failed.length} not deleted: ${r.failed[0].error}`) : success(`${r.done} lead${r.done === 1 ? '' : 's'} moved to the Recycle Bin`) }
          catch (e) { error(errMsg(e, 'Could not delete')) }
        }}><Ic n="trash" /> Delete {del.length}</button></>}>
        <p style={{ margin: 0 }}>{del.length === 1 ? <><b>{del[0].ref} – {del[0].company}</b> will be</> : <><b>{del.length} leads</b> will be</>} moved to the Recycle Bin and can be restored from there.</p>
      </Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  )
}

// prototype kanban(): one .kc column per workflow stage (top bar coloured by stage kind), "count · ₹total",
// cards = company · interest · value · owner avatar; drag a card onto a column to move it (lostPrompt / convertHint).
function Board({ meta, rows, loading, total, onOpen, onMoved }: { meta: Meta; rows: Row[]; loading: boolean; total: number; onOpen: (id: number) => void; onMoved: () => void }) {
  const { success, error, warning } = useToast()
  const [over, setOver] = useState('')
  const [lost, setLost] = useState<{ r: Row; key: string; label: string } | null>(null)
  const [next, setNext] = useState<Row | null>(null)
  const drag = useRef<Row | null>(null)
  const move = async (r: Row, key: string) => {
    const st = meta.stages.find(x => x.key === key)
    if (!st || st.values.includes(r.stage)) return
    if (!meta.can.update) return warning('You can view leads but not move them')
    if (r.approval_status === 'pending') return warning(`${r.ref} is waiting for approval`)
    if (st.kind === 'lost') return setLost({ r, key, label: st.label })
    if (key === 'Opportunity Created') return isOpen(r.stage) ? setNext(r) : warning(`${r.ref} cannot be converted from ${stageLabel(r.stage)}`)
    try { await leadApi.stage(r.id, key); success(`Moved to ${st.label}`); onMoved() } catch (x) { error(errMsg(x, 'Could not change the stage')) }
  }
  if (loading && !rows.length) return <div className="empty">Loading…</div>
  return <>
    <div className="kb" style={{ padding: 8 }}>{meta.stages.map(s => {
      const L = rows.filter(r => stageOf(meta.stages, r.stage)?.key === s.key), sum = L.reduce((a, r) => a + (r.value || 0), 0)
      return <div key={s.key} className={`kc ${over === s.key ? 'dr' : ''}`} data-st={s.key}
        onDragOver={e => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== s.key) setOver(s.key) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => o === s.key ? '' : o) }}
        onDrop={e => { e.preventDefault(); setOver(''); const r = drag.current; drag.current = null; if (r) move(r, s.key) }}>
        <h4 style={{ ['--c' as string]: s.kind === 'won' ? 'var(--bw-ok)' : s.kind === 'lost' ? 'var(--bw-ba)' : 'var(--bw-ac)' }}>{s.label}<small>{L.length}{sum ? ` · ${inr(sum)}` : ''}</small></h4>
        <div className="cs">{L.map(r => <div key={r.id} className="kcard" draggable data-id={r.id} title={`${r.ref} · ${r.company}`}
          onDragStart={e => { drag.current = r; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.id)) }}
          onDragEnd={() => { drag.current = null; setOver('') }}
          onClick={() => onOpen(r.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.id) }}>
          <div className="t1">{r.company}</div>
          <small>{r.interest}</small>
          <div className="m"><b style={{ color: 'var(--bw-tx)' }}>{inr(r.value)}</b>{r.approval_status === 'pending' && <Pill s="Pending" t="wa" />}<Av name={r.owner || '?'} /></div>
        </div>)}</div>
      </div>
    })}</div>
    {total > rows.length && <div className="mu" style={{ padding: '0 12px 10px', fontSize: 12 }}>Showing the first {rows.length} of {total} – narrow with a saved view or the stage filter.</div>}
    {lost && <LostModal lost={meta.lost} label={lost.label} onClose={() => setLost(null)} onConfirm={async (reason, comment) => {
      await leadApi.stage(lost.r.id, lost.key, reason, comment); setLost(null); success(`Moved to ${lost.label}`); onMoved()
    }} />}
    {next && <NextStepModal name={next.company} onClose={() => setNext(null)} onConvert={async () => {
      await leadApi.convert(next.id, 'deal'); const id = next.id; setNext(null); success('Lead converted to a deal'); onMoved(); onOpen(id)
    }} />}
  </>
}

function ReassignModal({ rows, onClose, onDone }: { rows: Row[]; onClose: () => void; onDone: (n: number, failed: { id: number; error: string }[]) => void }) {
  const { error } = useToast()
  const users = useMaster(masters.users)
  const [u, setU] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  return <Modal title={`Reassign ${rows.length} lead${rows.length === 1 ? '' : 's'}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!u || busy} onClick={async () => {
      setBusy(true)
      try { const r = await leadApi.bulk(rows.map(x => x.id), 'reassign', String(u)); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not reassign')) } finally { setBusy(false) }
    }}>Reassign</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="ro">New owner</label>
      <Lookup id="ro" value={u} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setU(o?.id ?? null)} placeholder="Choose a user…" emptyText="No active users" /></div></div>
  </Modal>
}

function StageModal({ rows, meta, onClose, onDone }: { rows: Row[]; meta: Meta; onClose: () => void; onDone: (n: number, failed: { id: number; error: string }[]) => void }) {
  const { error } = useToast()
  const [s, setS] = useState('')
  const [busy, setBusy] = useState(false)
  const [askLost, setAskLost] = useState(false)
  return <Modal title={`Change stage of ${rows.length} lead${rows.length === 1 ? '' : 's'}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!s || busy} onClick={async () => {
      setBusy(true)
      if (meta.stages.find(x => x.key === s)?.kind === 'lost') { setAskLost(true); setBusy(false); return }
      try { const r = await leadApi.bulk(rows.map(x => x.id), 'stage', s); onDone(r.done, r.failed) } catch (e) { error(errMsg(e, 'Could not change the stage')) } finally { setBusy(false) }
    }}>Apply</button></>}>
    {askLost && <LostModal lost={meta.lost} label={meta.stages.find(x => x.key === s)?.label} count={rows.length} onClose={() => setAskLost(false)} onConfirm={async (reason, comment) => {
      const r = await leadApi.bulk(rows.map(x => x.id), 'stage', s, reason, comment); setAskLost(false); onDone(r.done, r.failed)
    }} />}
    <div className="fg"><div className="f1"><label htmlFor="bs">Stage</label>
      <select id="bs" className="in" value={s} onChange={e => setS(e.target.value)}><option value="">Choose a stage…</option>
        {meta.stages.filter(x => x.key !== 'Converted' && x.key !== 'Opportunity Created').map(x => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
      <small className="mu">Converting to a deal is done from the lead itself (Convert).</small></div></div>
  </Modal>
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{ created: number; errors: { row: number; company?: string; error: string }[]; error_count: number } | null>(null)
  const template = async () => {
    try { const b = await leadApi.template(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'leads-import-template.csv'; a.click(); URL.revokeObjectURL(u) }
    catch (e) { error(errMsg(e, 'Could not download the template')) }
  }
  return <Modal title="Import leads" width={560} onClose={onClose} foot={<><button type="button" className="btn" onClick={template}><Ic n="dl" /> Template</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>{res ? 'Close' : 'Cancel'}</button>
    {!res && <button type="button" className="btn p" disabled={!file || busy} onClick={async () => {
      if (!file) return
      setBusy(true)
      try { const r = await leadApi.importCsv(file); setRes(r); if (r.created) { success(`${r.created} lead${r.created === 1 ? '' : 's'} imported`); onDone() } }
      catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
    }}>{busy ? 'Importing…' : 'Import'}</button>}</>}>
    {!res ? <div className="fg"><div className="f1">
      <label htmlFor="imf">CSV file</label>
      <input id="imf" type="file" accept=".csv,text/csv" className="in" style={{ height: 'auto', padding: 6 }} onChange={e => setFile(e.target.files?.[0] || null)} />
      <small className="mu">One row per lead. Company, contact, source, product and owner must match existing Masters records – rows that do not match are reported, never guessed.</small>
    </div></div>
      : <div><p style={{ marginTop: 0 }}><b>{res.created}</b> imported{res.error_count ? <> · <b className="tbad">{res.error_count}</b> skipped</> : ''}.</p>
        {res.errors.length > 0 && <div className="list" style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
          {res.errors.map((x, i) => <div key={i}><small className="mu">Row {x.row}</small><span className="fl">{x.company ? <b>{x.company}: </b> : null}{x.error}</span></div>)}</div>}
      </div>}
  </Modal>
}
