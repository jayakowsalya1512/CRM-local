// Deal record drawer – prototype v17 openRec('opps'): header (name · ID · stage), Edit / Delete, tabs Overview / Activity /
// Documents / Notes. Overview = KPI tiles (Deal value, Weighted, Expected close, Deal type, Age), stage progress with Log
// activity / Next stage / Create tender|quotation, signals, Customer 360 link, stage bar, journey, "Ready to proceed?"
// banner and the configured field panels.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { buildFilePreviewUrl } from '@/pages/questionnaire/questionnaireFormShared'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import { masters, useMaster } from '@/pages/leads/leadApi'
import { useStageMove } from './useStageMove'
import { DueCell } from './kit'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, type FieldSpec } from '@/utils/validation'
import { dealApi, errMsg, fd, inr, stagePill, todayIso, type Detail, type Meta } from './dealApi'

const TABS = ['Overview', 'Activity', 'Documents', 'Notes'] as const
type Tab = typeof TABS[number]
const DOT: Record<string, string> = { ok: 'var(--bw-ok)', wa: 'var(--bw-wa)', ba: 'var(--bw-ba)', inf: 'var(--bw-in)' }
const JICO: Record<string, string> = { lead: 'funnel', deal: 'target', tq: 'file', order: 'brief' }
const dt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export default function DealDrawer({ id, meta, onClose, onChanged, onOpen }: { id: number; meta: Meta; onClose: () => void; onChanged: () => void; onOpen: (id: number) => void }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [conv, setConv] = useState(false)
  const [logAct, setLogAct] = useState(false)

  const load = useCallback(() => { setLoadErr(''); dealApi.get(id).then(setD).catch(e => { setD(null); setLoadErr(errMsg(e, 'Could not open this deal')) }) }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  const refresh = useCallback(() => { load(); onChanged() }, [load, onChanged])
  const { move, ui } = useStageMove(meta, refresh, onOpen)
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !del && !conv && !logAct && !document.querySelector('.bwi-ov')) onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose, del, conv, logAct])

  const host = document.querySelector('.crm-shell') ?? document.body
  const editable = !!d && d.can.update && !d.pending && d.lead_status !== 'Converted'
  const opens = d ? d.stages.filter(s => s.kind === 'open') : []
  const curIdx = d ? d.stages.findIndex(s => s.id === d.stage.id) : -1
  const tgt = d ? { id: d.id, name: d.name, stages: d.stages, currentId: d.stage.id } : null
  const nextStage = () => {
    if (!d || !tgt) return
    const i = opens.findIndex(s => s.id === d.stage.id)
    if (i < 0 || i >= opens.length - 1) { warning('Already at the last open stage – close it from the stage bar'); return }
    void move(tgt, opens[i + 1])
  }

  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d ? `${d.name} – deal ${d.ref}` : 'Deal'}>
      <div className="dh">
        <div className="fl">
          <h2>{d?.name || (loadErr ? 'Deal' : 'Loading…')}</h2>
          {d && <div className="sub"><span>{d.ref}</span> · <Pill s={d.stage.name} t={stagePill(d.stage.name, d.stage.kind)} />
            {d.pending && <Pill s={d.pending.kind === 'stage' ? `Awaiting approval → ${d.pending.stage}` : 'Conversion pending approval'} t="wa" />}
            {d.lead_status === 'Converted' && <Pill s="Converted" t="ok" />}</div>}
        </div>
        {d && d.can.update && <button type="button" className="btn" onClick={() => navigate(`/opportunities/${d.id}/edit`)}><Ic n="edit" /> Edit</button>}
        {d && d.can.delete && <button type="button" className="btn d ib" title="Delete" aria-label="Delete deal" onClick={() => setDel(true)}><Ic n="trash" /></button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}{t === 'Notes' && d?.notes.length ? <small>{d.notes.length}</small> : null}</div>)}</div>
      <div className="db">
        {loadErr ? <div className="dcard empty">{loadErr} · <a onClick={load}>Retry</a></div>
          : !d ? <div className="empty">Loading…</div>
            : tab === 'Overview' ? <>
              <div className="dcard">
                <div className="kgrid">
                  <K l="Deal value" v={inr(d.kpis.value)} />
                  <K l="Weighted" v={inr(d.kpis.weighted)} s={`${d.kpis.prob}% probability`} />
                  <K l="Expected close" v={d.kpis.close ? fd(d.kpis.close) : '—'} s={d.kpis.close_in == null ? 'not set' : d.kpis.close_in < 0 ? <span className="tbad">{-d.kpis.close_in} d ago</span> : d.kpis.close_in === 0 ? 'today' : `in ${d.kpis.close_in} d`} />
                  <K l="Deal type" v={d.kpis.type} s={d.kpis.model || ''} />
                  <K l="Age" v={`${d.kpis.age} d`} />
                </div>
                <div className="lprog">
                  <div style={{ flex: '1 1 220px', minWidth: 160 }}>
                    <div className="pm"><i style={{ width: `${d.stage.kind === 'open' ? Math.round(d.progress.index / Math.max(d.progress.of, 1) * 100) : 100}%`, background: d.stage.kind === 'lost' ? 'var(--bw-ba)' : d.stage.kind === 'won' ? 'var(--bw-ok)' : 'var(--bw-ac)' }} /></div>
                    <small>{d.stage.kind === 'open' ? `Stage ${d.progress.index} of ${d.progress.of}` : d.stage.name} · {d.pipeline.name}{d.sla ? ` · SLA ${d.sla.sla} d` : ''}</small>
                  </div>
                  {d.can.log_activity && <button type="button" className="btn s" onClick={() => setLogAct(true)}><Ic n="pin" /> Log activity</button>}
                  {editable && d.stage.kind === 'open' && <button type="button" className="btn s" disabled={busy} onClick={nextStage}><Ic n="right" /> Next stage</button>}
                  {editable && d.can_convert && <button type="button" className="btn s" onClick={() => setConv(true)}><Ic n="plus" /> {d.convert_label}</button>}
                </div>
                <div className="sigs">{d.signals.map(s => <span key={s.s} className="sig"><i style={{ background: DOT[s.t] || DOT.inf }} />{s.s}</span>)}
                  {d.customer_id && d.can.customers && <a className="sig" onClick={() => navigate(`/customers/${d.customer_id}`)}><Ic n="building" size={13} /> {d.customer} · 360 →</a>}</div>
              </div>
              <div className="lpath" role="list" aria-label="Deal stages">
                {d.stages.map((s, i) => {
                  const cls = `s ${i < curIdx && s.kind === 'open' ? 'done' : ''} ${i === curIdx ? 'cur' : ''} ${s.kind}`
                  const allowed = editable && i !== curIdx
                  return <button key={s.id} type="button" role="listitem" className={cls} disabled={!allowed || busy}
                    title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''} · ${s.prob}% win`}
                    onClick={() => tgt && void move(tgt, s)}>{s.name}</button>
                })}
              </div>
              {d.pending?.kind === 'stage' && <div className="note mb">Awaiting approval to move to <b>{d.pending.stage}</b>. <a onClick={() => navigate('/approvals')}>View approval</a></div>}
              <div className="jy">
                <div className="jy-h"><Ic n="doc" /> <b>Journey</b> <small className="mu">started {d.kpis.age} d ago · {inr(d.kpis.value)} · {d.kpis.type.toLowerCase()}</small></div>
                <div className="jy-r">{d.journey.map((j, i) => {
                  const cur = j.done && !(d.journey[i + 1]?.done)
                  return <div key={j.k} className={`jy-s ${j.done ? 'done' : ''} ${cur ? 'cur' : ''}`}>
                    <span className="jy-n"><Ic n={JICO[j.k] || 'doc'} /></span>
                    <b>{j.label}</b>
                    {j.ref ? (j.route && j.k !== 'deal' ? <a onClick={() => navigate(j.route!)}>{j.ref}</a> : <small>{j.ref}</small>) : <small>not started</small>}
                    {j.stage && <Pill s={j.stage} t={j.k === 'deal' ? stagePill(d.stage.name, d.stage.kind) : 'inf'} />}
                    {j.k === 'tq' && !j.done && editable && d.can_convert && <button type="button" className="btn p s mt" onClick={() => setConv(true)}>{d.convert_label}</button>}
                    {j.value != null && j.k === 'deal' && <span className="jv">{inr(j.value)}</span>}
                    {j.date && <span className="jd"><Ic n="cal" size={12} /> {fd(j.date)}</span>}
                  </div>
                })}</div>
              </div>
              {editable && d.can_convert && <div className="lban"><Ic n="share" /> <span className="fl">Ready to proceed? Create the {d.pipeline.destination === 'tender' ? 'tender' : 'quotation'} record from this opportunity.</span>
                <button type="button" className="btn p s" onClick={() => setConv(true)}>{d.convert_label}</button></div>}
              <div className="fpan">{d.panels.map(p => {
                const n = p.f.filter(x => x[1] !== null && x[1] !== undefined && x[1] !== '').length
                return <div className="panel" key={p.t}><div className="ph"><Ic n={p.i} /> <span className="fl">{p.t}</span><small className="mu">{n}/{p.f.length} filled</small></div>
                  <div className="pb"><div className="fkv">{p.f.map(([l, val, kind]) => <div key={l}><div className="kl">{l}</div><div className="kv">{fmtVal(val, kind, d)}</div></div>)}</div></div></div>
              })}</div>
            </>
              : tab === 'Activity' ? <div className="dcard">
                <div className="row mb"><b className="fl">Activity</b>{d.can.log_activity && <button type="button" className="btn s" onClick={() => setLogAct(true)}><Ic n="plus" /> Log activity</button>}</div>
                {d.timeline.length ? <div className="tl">{d.timeline.map((t, i) => <div key={i}><b>{t.t}</b><br /><small>{t.by}{t.by && t.d ? ' · ' : ''}{dt(t.d)}</small></div>)}</div> : <div className="empty">No activity yet</div>}
              </div>
                : tab === 'Documents' ? <DocsTab id={d.id} can={d.can.documents} />
                  : <NotesTab d={d} meId={meta.me.id} onChanged={load} />}
      </div>
    </aside>
    {ui}
    {del && d && <Modal title="Delete record?" width={420} onClose={() => setDel(false)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDel(false)}>Cancel</button>
      <button type="button" className="btn d" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await dealApi.remove(d.id); success('Deleted'); setDel(false); onChanged(); onClose() } catch (e) { error(errMsg(e, 'Could not delete the deal')) } finally { setBusy(false) }
      }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete this record? It moves to the recycle bin.</p>
    </Modal>}
    {conv && d && <Modal title="Next step" width={420} onClose={() => setConv(false)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setConv(false)}>Not now</button>
      <button type="button" className="btn p" disabled={busy} onClick={async () => {
        setBusy(true)
        try {
          const r = await dealApi.convert(d.id); setConv(false)
          r.approval_status === 'pending' ? warning(r.message || 'Conversion sent for approval') : success(r.message || 'Converted')
          refresh()
        } catch (e) { error(errMsg(e, 'Could not convert the deal')) } finally { setBusy(false) }
      }}>{d.pipeline.destination === 'tender' ? 'Create tender record' : 'Create quotation'}</button></>}>
      <p style={{ margin: 0 }}><b>{d.name}</b> moves to <b>{d.stages.find(s => s.kind === 'won')?.name || 'Won'}</b> and a {d.pipeline.destination === 'tender' ? 'tender' : 'quotation'} is created on the same journey with its customer, owner, value and source. Continue?</p>
    </Modal>}
    {logAct && d && <LogActivityModal d={d} onClose={() => setLogAct(false)} onDone={() => { setLogAct(false); success('Activity logged'); refresh() }} />}
  </div>, host)
}

function K({ l, v, s }: { l: string; v: ReactNode; s?: ReactNode }) {
  return <div className="kcard"><div className="kl">{l}</div><div className="kv">{v}</div>{s ? <div className="ks">{s}</div> : null}</div>
}
function fmtVal(v: unknown, kind: string | undefined, d: Detail): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="mu">—</span>
  if (kind === 'inr') return <b>{inr(Number(v))}</b>
  if (kind === 'due') return <DueCell d={String(v)} />
  if (kind === 'user') return <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={String(v)} />{String(v)}</span>
  if (kind === 'pill') return <Pill s={String(v)} t={stagePill(String(v), d.stage.kind)} />
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function DocsTab({ id, can }: { id: number; can: boolean }) {
  const { success, error } = useToast()
  const [docs, setDocs] = useState<Awaited<ReturnType<typeof dealApi.documents>> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const load = useCallback(() => { setErr(''); dealApi.documents(id).then(setDocs).catch(e => { setDocs({ items: [], allowed: true }); setErr(errMsg(e, 'Could not load documents')) }) }, [id])
  useEffect(() => { load() }, [load])
  const upload = async (f: File) => {
    setBusy(true)
    try { await dealApi.upload(id, f); success(`${f.name} uploaded`); load() } catch (e) { error(errMsg(e, 'Upload failed')) } finally { setBusy(false); if (file.current) file.current.value = '' }
  }
  return <div className="dcard">
    {!docs ? <div className="empty">Loading…</div>
      : err ? <div className="empty">{err} · <a onClick={load}>Retry</a></div>
        : !docs.allowed ? <div className="empty">You do not have access to Document Hub.</div>
          : !docs.items.length ? <div className="empty">No documents linked yet</div>
            : <table className="t"><thead><tr><th>File</th><th>Folder</th><th>Updated</th></tr></thead><tbody>
              {docs.items.map(x => <tr key={x.id}><td><Ic n="file" /> <a href={x.url ? buildFilePreviewUrl(x.url) : undefined} target="_blank" rel="noreferrer">{x.name}</a></td>
                <td>{x.folder}</td><td>{x.updated_at ? fd(x.updated_at) : '—'}</td></tr>)}</tbody></table>}
    {can && <><input ref={file} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
      <button type="button" className="btn mt" disabled={busy} onClick={() => file.current?.click()}><Ic n="up" /> {busy ? 'Uploading…' : 'Upload document'}</button></>}
  </div>
}

function NotesTab({ d, meId, onChanged }: { d: Detail; meId: number; onChanged: () => void }) {
  const { success, error } = useToast()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ id: number; body: string } | null>(null)
  const [mq, setMq] = useState<string | null>(null)
  const users = useMaster(masters.users)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fe = useFieldErrors()
  const NOTE: FieldSpec = { label: 'Note', rule: 'textarea', max: 5000 }   // backend NoteIn: 1–5000 characters
  const sugg = mq === null ? [] : (users.items || []).filter(u => u.name.toLowerCase().startsWith(mq.toLowerCase()) || u.name.toLowerCase().includes(` ${mq.toLowerCase()}`)).slice(0, 6)
  const insert = (name: string) => {
    const el = ta.current, pos = el?.selectionStart ?? body.length
    const before = body.slice(0, pos).replace(/@([\w.-]*)$/, `@${name} `)
    setBody(before + body.slice(pos)); setMq(null); setTimeout(() => { el?.focus(); el?.setSelectionRange(before.length, before.length) }, 0)
  }
  const add = async () => {
    if (!body.trim()) return
    if (Object.keys(fe.validateAll({ nt: body }, { nt: NOTE })).length) { ta.current?.focus(); return }
    setBusy(true)
    try { const r = await dealApi.note(d.id, body.trim()); setBody(''); fe.clear('nt'); success(r.mentioned ? `Note added · ${r.mentioned} teammate${r.mentioned > 1 ? 's' : ''} notified` : 'Note added'); onChanged() }
    catch (e) { const m = mapApiErrors(e).body; if (m) fe.setError('nt', m); else error(errMsg(e, 'Could not add the note')) } finally { setBusy(false) }
  }
  const mine = (n: Detail['notes'][number]) => !n.legacy && n.id > 0 && n.by_id === meId
  return <div className="dcard">
    <div className="list">{d.notes.length ? d.notes.map(n => <div key={`${n.id}-${n.at}`} style={{ display: 'block' }}>
      {edit?.id === n.id ? <><textarea className={`in ${fe.errors.ne ? 'err' : ''}`} rows={3} value={edit.body} onChange={e => { setEdit({ ...edit, body: e.target.value }); fe.change('ne', e.target.value, NOTE) }}
          onBlur={() => fe.blur('ne', edit.body, NOTE)} aria-label="Edit note" aria-invalid={fe.errors.ne ? true : undefined} /><FieldError msg={fe.errors.ne} />
        <div className="row mt"><span className="fl" /><button type="button" className="btn s" onClick={() => { setEdit(null); fe.clear('ne') }}>Cancel</button>
          <button type="button" className="btn p s" disabled={!edit.body.trim()} onClick={async () => {
            if (Object.keys(fe.validateAll({ ne: edit.body }, { ne: NOTE })).length) return
            try { await dealApi.editNote(d.id, n.id, edit.body.trim()); setEdit(null); success('Note updated'); onChanged() } catch (e) { const m = mapApiErrors(e).body; if (m) fe.setError('ne', m); else error(errMsg(e, 'Could not save the note')) }
          }}>Save</button></div></>
        : <><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.body}</div>
          <small>{n.by}{n.at ? ` · ${dt(n.at)}` : ''}{n.legacy ? ' · lead remarks' : ''}</small>
          {mine(n) && <> · <a onClick={() => setEdit({ id: n.id, body: n.body })}>Edit</a></>}</>}
    </div>) : <div className="mu">No notes yet</div>}</div>
    <div style={{ position: 'relative' }}>
      <textarea ref={ta} className={`in mt ${fe.errors.nt ? 'err' : ''}`} id="nt" rows={3} placeholder="Add a note, @mention a teammate…" value={body} aria-label="New note" aria-invalid={fe.errors.nt ? true : undefined}
        onBlur={() => fe.blur('nt', body, NOTE)}
        onChange={e => { setBody(e.target.value); fe.change('nt', e.target.value, NOTE); const m = /(?:^|\s)@([\w.-]*)$/.exec(e.target.value.slice(0, e.target.selectionStart)); setMq(m ? m[1] : null) }}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add() } if (e.key === 'Escape') setMq(null) }} />
      {mq !== null && sugg.length > 0 && <div className="mpop">{sugg.map(u => <div key={u.id} onMouseDown={e => { e.preventDefault(); insert(u.name) }}>{u.name}{u.sub && <small> · {u.sub}</small>}</div>)}</div>}
    </div>
    <FieldError id="nt" msg={fe.errors.nt} />
    <button type="button" className="btn p mt" disabled={busy || !body.trim()} onClick={add}>{busy ? 'Adding…' : 'Add note'}</button>
  </div>
}

function LogActivityModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [kmeta, setKmeta] = useState<{ activity_types: string[]; statuses: string[] } | null>(null)
  const [metaErr, setMetaErr] = useState('')
  const [f, setF] = useState({ type: '', subject: '', date: todayIso(), status: '', outcome: '', description: '' })
  const [busy, setBusy] = useState(false)
  const loadMeta = useCallback(() => { setMetaErr(''); api.get('/kam/meta').then(r => { setKmeta(r.data); setF(s => ({ ...s, type: s.type || r.data.activity_types?.[0] || '', status: s.status || r.data.statuses?.[0] || '' })) })
    .catch(e => setMetaErr(errMsg(e, 'Could not load activity types'))) }, [])
  useEffect(() => { loadMeta() }, [loadMeta])
  const needOutcome = f.status === 'Completed', needDesc = f.status === 'Postponed' || f.status === 'Cancelled'
  const ok = f.type && f.subject.trim() && f.date && (!needOutcome || f.outcome.trim()) && (!needDesc || f.description.trim())
  // field rules (KAM activity: subject ≤ 300 characters; outcome / notes are long text)
  const fe = useFieldErrors()
  const specs: Record<string, FieldSpec | undefined> = {
    type: { label: 'Type', rule: 'select', required: true }, subject: { label: 'Subject', rule: 'text', required: true, max: 300 }, date: { label: 'Date', rule: 'date', required: true },
    outcome: needOutcome ? { label: 'Outcome', rule: 'textarea', required: true, max: 5000 } : undefined,
    description: { label: needDesc ? 'Reason' : 'Notes', rule: 'textarea', required: needDesc, max: 5000 },
  }
  const upd = (k: keyof typeof f, x: string) => { setF({ ...f, [k]: x }); if (k === 'status') { fe.clear('outcome'); fe.clear('description') } else fe.change(k, x, specs[k]) }
  const leave = (k: keyof typeof f) => fe.blur(k, f[k], specs[k])
  const inv = (k: string) => ({ className: `in ${fe.errors[k] ? 'err' : ''}`, 'aria-invalid': fe.errors[k] ? true : undefined })
  return <Modal title="Log activity" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!ok || busy} onClick={async () => {
      if (Object.keys(fe.validateAll(f, specs)).length) return
      setBusy(true)
      try {
        await dealApi.logActivity({ activity_type: f.type, lead_id: d.id, customer_id: d.customer_id, subject: f.subject.trim(), activity_date: f.date, status: f.status,
          outcome: f.outcome.trim() || null, description: f.description.trim() || null, ...(f.status === 'Cancelled' ? { cancellation_reason: f.description.trim() } : {}) })
        onDone()
      } catch (e) {
        const fx = mapApiErrors(e, { activity_type: 'type', activity_date: 'date', cancellation_reason: 'description' }), known = Object.fromEntries(Object.entries(fx).filter(([k]) => k in specs))
        if (Object.keys(known).length) fe.setErrors(x => ({ ...x, ...known })); else error(errMsg(e, 'Could not log the activity'))
      } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Log activity'}</button></>}>
    {metaErr ? <div className="note bad">{metaErr} · <a onClick={loadMeta}>Retry</a></div> : !kmeta ? <div className="empty">Loading…</div> :
      <div className="fg">
        <div><label htmlFor="la-t">Type</label><select id="la-t" {...inv('type')} value={f.type} onChange={e => upd('type', e.target.value)} onBlur={() => leave('type')}>{kmeta.activity_types.map(t => <option key={t}>{t}</option>)}</select><FieldError id="la-t" msg={fe.errors.type} /></div>
        <div><label htmlFor="la-s">Status</label><select id="la-s" className="in" value={f.status} onChange={e => upd('status', e.target.value)}>{kmeta.statuses.map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="f1"><label htmlFor="la-sub">Subject *</label><input id="la-sub" {...inv('subject')} value={f.subject} onChange={e => upd('subject', e.target.value)} onBlur={() => leave('subject')} placeholder={`Call about ${d.name}`} /><FieldError id="la-sub" msg={fe.errors.subject} /></div>
        <div><label htmlFor="la-d">Date *</label><input id="la-d" {...inv('date')} type="date" value={f.date} onChange={e => upd('date', e.target.value)} onBlur={() => leave('date')} /><FieldError id="la-d" msg={fe.errors.date} /></div>
        {needOutcome && <div className="f1"><label htmlFor="la-o">Outcome *</label><input id="la-o" {...inv('outcome')} value={f.outcome} onChange={e => upd('outcome', e.target.value)} onBlur={() => leave('outcome')} /><FieldError id="la-o" msg={fe.errors.outcome} /></div>}
        <div className="f1"><label htmlFor="la-n">{needDesc ? 'Reason *' : 'Notes'}</label><textarea id="la-n" {...inv('description')} rows={3} value={f.description} onChange={e => upd('description', e.target.value)} onBlur={() => leave('description')} /><FieldError id="la-n" msg={fe.errors.description} /></div>
      </div>}
  </Modal>
}
