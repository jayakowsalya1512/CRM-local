// Lead detail drawer – prototype v17 openDrawer('leads'): header (company · ID · stage), Edit / Delete, tabs
// Overview / Activity / Documents / Notes. Workflow moves go through /lead360/{id}/stage and /convert, which reuse the
// existing lead status / conversion endpoints (rules, approvals, audit, notifications).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { buildFilePreviewUrl } from '@/pages/questionnaire/questionnaireFormShared'
import { Modal } from '@/pages/notifications/Modal'
import { Pill } from '@/pages/customers/kit'
import { LostModal } from './StageModals'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, type FieldSpec } from '@/utils/validation'
import { errMsg, fd, inr, isOpen, leadApi, masters, stageLabel, stageOf, stageTone, todayIso, useMaster, type Detail, type Meta } from './leadApi'
import { recordRecentItem } from '@/store/recentItemsStore'

const TABS = ['Overview', 'Activity', 'Documents', 'Notes'] as const
type Tab = typeof TABS[number]
const DOT: Record<string, string> = { ok: 'var(--bw-ok)', wa: 'var(--bw-wa)', ba: 'var(--bw-ba)', inf: 'var(--bw-in)' }
const JICO: Record<string, string> = { lead: 'funnel', deal: 'target', tq: 'file', order: 'brief' }
const dt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export default function LeadDrawer({ id, meta, onClose, onChanged }: { id: number; meta: Meta; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [conv, setConv] = useState(false)
  const [logAct, setLogAct] = useState(false)
  const [lostTo, setLostTo] = useState<{ key: string; label: string } | null>(null)

  const load = useCallback(() => {
    setLoadErr('')
    leadApi.get(id).then(r => {
      setD(r)
      recordRecentItem({ module: 'Lead', label: `${r.ref} – ${r.company}`, path: `/leads?open=${id}` })
    }).catch(e => { setD(null); setLoadErr(errMsg(e, 'Could not open this lead')) })
  }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !del && !conv && !logAct && !lostTo) onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose, del, conv, logAct, lostTo])
  const refresh = () => { load(); onChanged() }

  const moveTo = async (stage: string) => {
    if (!d || busy || stage === d.stage) return
    setBusy(true)
    try { await leadApi.stage(d.id, stage); success(`Moved to ${stageLabel(stage)}`); refresh() }
    catch (e) { error(errMsg(e, 'Could not change the stage')) } finally { setBusy(false) }
  }

  const host = document.querySelector('.crm-shell') ?? document.body
  const openStages = d ? d.stages.filter(s => s.kind === 'open') : []
  const curKey = d ? stageOf(d.stages, d.stage)?.key : undefined
  const curIdx = d ? d.stages.findIndex(s => s.key === curKey) : -1
  const nextOpen = d ? openStages[openStages.findIndex(s => s.key === d.stage) + 1] : undefined
  const canConvertDeal = !!d && isOpen(d.stage)
  const canConvertOn = !!d && d.stage === 'Opportunity Created'
  const pending = d?.approval_status === 'pending'
  const editable = !!d && d.can.update && !pending

  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d ? `${d.company} – lead ${d.ref}` : 'Lead'}>
      <div className="dh">
        <div className="fl">
          <h2>{d?.company || (loadErr ? 'Lead' : 'Loading…')}</h2>
          {d && <div className="sub"><span className="mono">{d.ref}</span> · <Pill s={stageLabel(d.stage)} t={stageTone(d.stage)} />{pending && <Pill s="Pending approval" t="wa" />}
            {d.conversion_target && d.stage === 'Opportunity Created' && <Pill s={`Conversion to ${d.conversion_target} requested`} t="inf" />}</div>}
        </div>
        {d && editable && <button type="button" className="btn" onClick={() => navigate(`/leads/${d.id}/edit`)}><Ic n="edit" /> Edit</button>}
        {d && d.can.delete && <button type="button" className="btn d ib" title="Delete" aria-label="Delete lead" onClick={() => setDel(true)}><Ic n="trash" /></button>}
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
                  <K l="Expected value" v={d.kpis.value ? inr(d.kpis.value) : '—'} />
                  <K l="Lead score" v={<>{d.kpis.score}<small className="mu">/100</small></>} />
                  <K l="Age" v={`${d.kpis.age} d`} s={`since ${fd(d.kpis.created)}`} />
                  <K l="Next follow-up" v={d.kpis.follow_up ? fd(d.kpis.follow_up) : '—'}
                    s={d.kpis.follow_in == null ? 'not set' : d.kpis.follow_in < 0 ? <span className="tbad">{-d.kpis.follow_in} d overdue</span> : d.kpis.follow_in === 0 ? 'today' : `in ${d.kpis.follow_in} d`} />
                  {(d.kpis.model || d.kpis.vertical) && <K l="Model · Vertical" v={d.kpis.model || '—'} s={d.kpis.vertical || ''} />}
                </div>
                <div className="lprog">
                  <div style={{ flex: '1 1 220px', minWidth: 160 }}>
                    <div className="pm"><i style={{ width: `${Math.round(d.progress.index / Math.max(d.progress.of, 1) * 100)}%`, background: d.stages[curIdx]?.kind === 'lost' ? 'var(--bw-ba)' : 'var(--bw-ac)' }} /></div>
                    <small>Stage {d.progress.index} of {d.progress.of}{d.kpis.model ? ` · ${d.kpis.model}` : ''}</small>
                  </div>
                  {d.can.log_activity && <button type="button" className="btn s" onClick={() => setLogAct(true)}><Ic n="pin" /> Log activity</button>}
                  {editable && nextOpen && <button type="button" className="btn s" disabled={busy} onClick={() => nextOpen.key === 'Opportunity Created' ? setConv(true) : moveTo(nextOpen.key)}><Ic n="right" /> Next stage</button>}
                  {editable && (canConvertDeal || canConvertOn) && <button type="button" className="btn s" disabled={busy} onClick={() => setConv(true)}><Ic n="share" /> Convert</button>}
                </div>
                <div className="sigs">
                  {d.signals.map(s => <span key={s.s} className="sig"><i style={{ background: DOT[s.t] || DOT.inf }} />{s.s}</span>)}
                </div>
                {d.customer_id && meta.can.customers && <div className="sigs"><a className="sig" onClick={() => navigate(`/customers/${d.customer_id}`)}><Ic n="building" size={13} /> {d.company} · 360 →</a></div>}
              </div>
              <div className="lpath" role="list" aria-label="Lead stages">
                {d.stages.map((s, i) => {
                  const cls = `s ${i < curIdx && s.kind === 'open' ? 'done' : ''} ${i === curIdx ? 'cur' : ''} ${s.kind}`
                  const allowed = editable && i !== curIdx && s.key !== 'Converted' && s.key !== 'Opportunity Created'
                  return <button key={s.key} type="button" role="listitem" className={cls} disabled={!allowed || busy} title={allowed ? `Move to ${s.label}` : s.label}
                    onClick={() => s.kind === 'lost' ? setLostTo({ key: s.key, label: s.label }) : moveTo(s.key)}>{s.label}</button>
                })}
              </div>
              <div className="jy">
                <div className="jy-h"><Ic n="doc" /> <b>Journey</b> <small className="mu">started {d.kpis.age} d ago · {inr(d.kpis.value)}</small></div>
                <div className="jy-r">{d.journey.map((j, i) => {
                  const cur = j.done && !(d.journey[i + 1]?.done)
                  return <div key={j.k} className={`jy-s ${j.done ? 'done' : ''} ${cur ? 'cur' : ''}`}>
                    <span className="jy-n"><Ic n={JICO[j.k] || 'doc'} /></span>
                    <b>{j.label}</b>
                    {j.ref ? (j.route ? <a onClick={() => navigate(j.route!)}>{j.ref}</a> : <small>{j.ref}</small>) : <small>{j.k === 'tq' ? 'decided on the deal' : 'not started'}</small>}
                    {j.stage && <Pill s={j.k === 'lead' ? stageLabel(j.stage) : j.stage} t={j.k === 'lead' ? stageTone(j.stage) : 'inf'} />}
                    {j.k === 'deal' && !j.done && editable && canConvertDeal && <button type="button" className="btn p s mt" onClick={() => setConv(true)}>Convert</button>}
                    {j.k === 'tq' && !j.done && editable && canConvertOn && !d.conversion_target && <button type="button" className="btn p s mt" onClick={() => setConv(true)}>Convert</button>}
                    {j.value != null && j.k === 'lead' && <span className="jv">{inr(j.value)}</span>}
                    {j.date && <span className="jd"><Ic n="cal" size={12} /> {fd(j.date)}</span>}
                  </div>
                })}</div>
              </div>
              {editable && canConvertDeal && <div className="lban"><Ic n="share" /> <span className="fl">Qualified? Convert this lead into a deal.</span>
                <button type="button" className="btn p s" onClick={() => setConv(true)}>Convert lead</button></div>}
              <div className="fpan">{d.panels.map(p => {
                const fs = p.f.filter(x => x[0] !== 'Company' || p.t !== 'Additional information' || p.f.length === 1)
                const n = fs.filter(x => x[1] !== null && x[1] !== undefined && x[1] !== '').length
                return <div className="panel" key={p.t}><div className="ph"><Ic n={p.i} /> <span className="fl">{p.t}</span><small className="mu">{n}/{fs.length} filled</small></div>
                  <div className="pb"><div className="fkv">{fs.map(([l, val, kind]) => <div key={l}><div className="kl">{l}</div><div className="kv">{fmtVal(val, kind)}</div></div>)}</div></div></div>
              })}</div>
            </>
              : tab === 'Activity' ? <ActivityTab d={d} onLog={d.can.log_activity ? () => setLogAct(true) : undefined} />
                : tab === 'Documents' ? <DocsTab id={d.id} can={d.can.documents} />
                  : <NotesTab d={d} onAdded={() => load()} />}
      </div>
    </aside>
    {del && d && <Modal title="Delete lead?" width={440} onClose={() => setDel(false)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDel(false)}>Cancel</button>
      <button type="button" className="btn d" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await leadApi.remove(d.id); success(`${d.ref} moved to the Recycle Bin`); setDel(false); onChanged(); onClose() }
        catch (e) { error(errMsg(e, 'Could not delete the lead')) } finally { setBusy(false) }
      }}><Ic n="trash" /> Delete</button></>}>
      <p style={{ margin: 0 }}><b>{d.ref} – {d.company}</b> will be moved to the Recycle Bin and can be restored from there.</p>
    </Modal>}
    {conv && d && <ConvertModal d={d} onClose={() => setConv(false)} onDone={(msg, warn) => { setConv(false); warn ? warning(msg) : success(msg); refresh() }} />}
    {lostTo && d && <LostModal lost={meta.lost} label={lostTo.label} onClose={() => setLostTo(null)} onConfirm={async (reason, comment) => {
      await leadApi.stage(d.id, lostTo.key, reason, comment); setLostTo(null); success(`Moved to ${lostTo.label}`); refresh()
    }} />}
    {logAct && d && <LogActivityModal d={d} onClose={() => setLogAct(false)} onDone={() => { setLogAct(false); success('Activity logged'); refresh() }} />}
  </div>, host)
}

function K({ l, v, s }: { l: string; v: ReactNode; s?: ReactNode }) {
  return <div className="kcard"><div className="kl">{l}</div><div className="kv">{v}</div>{s ? <div className="ks">{s}</div> : null}</div>
}
function fmtVal(v: unknown, kind?: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="mu">—</span>
  if (kind === 'inr') return <b>{inr(Number(v))}</b>
  if (kind === 'date') return fd(String(v))
  if (kind === 'pill') return <Pill s={stageLabel(String(v))} t={stageTone(String(v))} />
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function ActivityTab({ d, onLog }: { d: Detail; onLog?: () => void }) {
  return <div className="dcard">
    <div className="row mb"><b className="fl">Activity</b>{onLog && <button type="button" className="btn s" onClick={onLog}><Ic n="plus" /> Log activity</button>}</div>
    {d.timeline.length ? <div className="tl">{d.timeline.map((t, i) => <div key={i}><div>{t.t}</div><small>{dt(t.d)}{t.by ? ` · ${t.by}` : ''}</small></div>)}</div>
      : <div className="empty">No activity yet</div>}
  </div>
}

function DocsTab({ id, can }: { id: number; can: boolean }) {
  const { success, error } = useToast()
  const [docs, setDocs] = useState<Awaited<ReturnType<typeof leadApi.documents>> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const load = useCallback(() => { setErr(''); leadApi.documents(id).then(setDocs).catch(e => { setDocs({ items: [], allowed: true }); setErr(errMsg(e, 'Could not load documents')) }) }, [id])
  useEffect(() => { load() }, [load])
  const upload = async (f: File) => {
    setBusy(true)
    try { await leadApi.upload(id, f); success(`${f.name} uploaded`); load() } catch (e) { error(errMsg(e, 'Upload failed')) } finally { setBusy(false); if (file.current) file.current.value = '' }
  }
  return <div className="dcard">
    <div className="row mb"><b className="fl">Documents</b>
      {can && <><input ref={file} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        <button type="button" className="btn s" disabled={busy} onClick={() => file.current?.click()}><Ic n="upload" /> {busy ? 'Uploading…' : 'Upload document'}</button></>}</div>
    {!docs ? <div className="empty">Loading…</div>
      : err ? <div className="empty">{err} · <a onClick={load}>Retry</a></div>
        : !docs.allowed ? <div className="empty">You do not have access to Document Hub.</div>
          : !docs.items.length ? <div className="empty">No documents linked yet</div>
            : <div className="list">{docs.items.map(x => <div key={x.id}><Ic n="file" /><span className="fl"><a href={x.url ? buildFilePreviewUrl(x.url) : undefined} target="_blank" rel="noreferrer">{x.name}</a>
              <br /><small>{[x.type, x.size_kb ? `${x.size_kb} KB` : '', x.owner, x.updated_at ? dt(x.updated_at) : ''].filter(Boolean).join(' · ')}</small></span></div>)}</div>}
  </div>
}

function NotesTab({ d, onAdded }: { d: Detail; onAdded: () => void }) {
  const { success, error } = useToast()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [mq, setMq] = useState<string | null>(null)
  const [hi, setHi] = useState(0)
  const users = useMaster(masters.users)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fe = useFieldErrors()
  const NOTE: FieldSpec = { label: 'Note', rule: 'textarea', max: 5000 }   // backend NoteIn: 1–5000 characters
  const sugg = useMemo(() => mq === null ? [] : (users.items || []).filter(u => u.name.toLowerCase().startsWith(mq.toLowerCase()) || u.name.toLowerCase().includes(` ${mq.toLowerCase()}`)).slice(0, 6), [mq, users.items])
  const onType = (val: string, pos: number) => {
    setBody(val); fe.change('nt', val, NOTE)
    const m = /(?:^|\s)@([\w.-]*)$/.exec(val.slice(0, pos))
    setMq(m ? m[1] : null); setHi(0)
  }
  const insert = (name: string) => {
    const el = ta.current, pos = el?.selectionStart ?? body.length
    const before = body.slice(0, pos).replace(/@([\w.-]*)$/, `@${name} `)
    setBody(before + body.slice(pos)); setMq(null)
    setTimeout(() => { el?.focus(); el?.setSelectionRange(before.length, before.length) }, 0)
  }
  const add = async () => {
    if (!body.trim()) return
    if (Object.keys(fe.validateAll({ nt: body }, { nt: NOTE })).length) { ta.current?.focus(); return }
    setBusy(true)
    try { const r = await leadApi.note(d.id, body.trim()); setBody(''); fe.clear(); success(r.mentioned ? `Note added · ${r.mentioned} teammate${r.mentioned > 1 ? 's' : ''} notified` : 'Note added'); onAdded() }
    catch (e) { const m = mapApiErrors(e).body; if (m) fe.setError('nt', m); else error(errMsg(e, 'Could not add the note')) } finally { setBusy(false) }
  }
  const render = (t: string) => t.split(/(@[A-Za-z][\w.-]*(?:\s[A-Z][\w.-]*)?)/g).map((p, i) => p.startsWith('@') ? <span key={i} className="mention">{p}</span> : p)
  return <div className="dcard">
    <div style={{ position: 'relative' }}>
      <textarea ref={ta} className={`in ${fe.errors.nt ? 'err' : ''}`} rows={3} placeholder="Add a note, @mention a teammate…" value={body} aria-label="New note" aria-invalid={fe.errors.nt ? true : undefined}
        onBlur={() => fe.blur('nt', body, NOTE)}
        onChange={e => onType(e.target.value, e.target.selectionStart)}
        onKeyDown={e => {
          if (mq !== null && sugg.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, sugg.length - 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); return }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(sugg[hi].name); return }
            if (e.key === 'Escape') { e.preventDefault(); setMq(null); return }
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add() }
        }} />
      {mq !== null && sugg.length > 0 && <div className="mpop">{sugg.map((u, i) => <div key={u.id} className={i === hi ? 'on' : ''} onMouseDown={e => { e.preventDefault(); insert(u.name) }}>{u.name}{u.sub && <small> · {u.sub}</small>}</div>)}</div>}
    </div>
    <FieldError msg={fe.errors.nt} />
    <div className="row mt mb"><small className="fl">Ctrl+Enter to add · mentioned teammates get a notification</small>
      <button type="button" className="btn p s" disabled={busy || !body.trim()} onClick={add}>{busy ? 'Adding…' : 'Add note'}</button></div>
    {d.notes.length ? d.notes.map(n => <div key={`${n.id}-${n.at}`} className="nt">{render(n.body)}<br /><small>{n.by}{n.at ? ` · ${dt(n.at)}` : ''}{n.legacy ? ' · lead remarks' : ''}</small></div>)
      : <div className="empty">No notes yet</div>}
  </div>
}

function ConvertModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (msg: string, warn?: boolean) => void }) {
  const { error } = useToast()
  const toDeal = isOpen(d.stage)
  const [target, setTarget] = useState<'deal' | 'tender' | 'quotation'>(toDeal ? 'deal' : 'tender')
  const [busy, setBusy] = useState(false)
  const opts: { k: 'deal' | 'tender' | 'quotation'; t: string; s: string }[] = toDeal
    ? [{ k: 'deal', t: 'Deal', s: 'Creates the deal on the same journey – this lead moves to Opportunity Created.' }]
    : [{ k: 'tender', t: 'Tender', s: 'Bid on a published tender.' }, { k: 'quotation', t: 'Quotation', s: 'Send a direct quotation.' }]
  return <Modal title={`Convert ${d.ref}`} width={480} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      setBusy(true)
      try {
        const r = await leadApi.convert(d.id, target) as { approval_required?: boolean; status?: string; message?: string }
        const pend = !!(r && (r.approval_required || r.status === 'pending' || /approval/i.test(r.message || '')))
        onDone(target === 'deal' ? 'Converted to a deal' : pend ? `Conversion to ${target} sent for approval` : (r?.message || `Converted to ${target}`), pend)
      } catch (e) { error(errMsg(e, 'Could not convert the lead')) } finally { setBusy(false) }
    }}><Ic n="share" /> {busy ? 'Converting…' : 'Convert'}</button></>}>
    <div className="list" style={{ border: '1px solid var(--bw-ln)', borderRadius: 8 }}>
      {opts.map(o => <label key={o.k} style={{ display: 'flex', gap: 8, padding: '10px 12px', cursor: 'pointer', alignItems: 'flex-start' }}>
        <input type="radio" name="cv" checked={target === o.k} onChange={() => setTarget(o.k)} style={{ marginTop: 3 }} />
        <span><b>{o.t}</b><br /><small>{o.s}</small></span></label>)}
    </div>
  </Modal>
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
        await leadApi.logActivity({ activity_type: f.type, lead_id: d.id, customer_id: d.customer_id, subject: f.subject.trim(), activity_date: f.date, status: f.status,
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
        <div className="f1"><label htmlFor="la-sub">Subject *</label><input id="la-sub" {...inv('subject')} value={f.subject} onChange={e => upd('subject', e.target.value)} onBlur={() => leave('subject')} placeholder={`Call with ${d.form.contact_person || d.company}`} /><FieldError id="la-sub" msg={fe.errors.subject} /></div>
        <div><label htmlFor="la-d">Date *</label><input id="la-d" {...inv('date')} type="date" value={f.date} onChange={e => upd('date', e.target.value)} onBlur={() => leave('date')} /><FieldError id="la-d" msg={fe.errors.date} /></div>
        {needOutcome && <div className="f1"><label htmlFor="la-o">Outcome *</label><input id="la-o" {...inv('outcome')} value={f.outcome} onChange={e => upd('outcome', e.target.value)} onBlur={() => leave('outcome')} /><FieldError id="la-o" msg={fe.errors.outcome} /></div>}
        <div className="f1"><label htmlFor="la-n">{needDesc ? 'Reason *' : 'Notes'}</label><textarea id="la-n" {...inv('description')} rows={3} value={f.description} onChange={e => upd('description', e.target.value)} onBlur={() => leave('description')} /><FieldError id="la-n" msg={fe.errors.description} /></div>
      </div>}
  </Modal>
}
