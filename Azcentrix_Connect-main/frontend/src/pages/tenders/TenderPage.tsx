// Tender page – prototype v17 tenderPage(): crumb "Tenders / ID" · title · Edit · Documents · Move to <next stage>,
// summary row (NIT · customer · company · value · stage · submission · bid manager), value header (recHero: Bid value · EMD ·
// Submission · Portal · OEM · Published, stage progress of the tender's flow, Log activity · Next stage, signal chips,
// customer 360 link), the flow's stepper, Journey (Lead · Deal · Tender / bid · Work order) and six tabs – Basic Info · Tender Details · Workings · Tech Bid Evaluation · Financial · PO & Consignee. Every value is
// read from and saved to the tenant database (/api/v1/bids); options come from the Masters APIs.
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, HBars, Panel, Pill, Strip } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import { masters as leadMasters, useMaster } from '@/pages/leads/leadApi'
import { DueCell } from '@/pages/deals/kit'
import { useBidStage } from './useBidStage'
import { bidApi, errMsg, fd, inr, stagePill, todayIso, type Detail, type Doc, type Masters, type Opt } from './bidApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { validate, type FieldSpec } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './tenders.css'

const TT = ['Basic Info', 'Tender Details', 'Workings', 'Tech Bid Evaluation', 'Financial', 'PO & Consignee'] as const
type Tab = typeof TT[number]
const tabKey = 'tender:tab'

export default function TenderPage() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [tab, setTab] = useState<Tab>(() => { try { const t = sessionStorage.getItem(tabKey) as Tab; return TT.includes(t) ? t : 'Basic Info' } catch { return 'Basic Info' } })
  const [ms, setMs] = useState<Masters | null>(null)
  const [docs, setDocs] = useState(false)
  const [timeline, setTimeline] = useState(false)
  const [logAct, setLogAct] = useState(false)

  const load = useCallback(() => bidApi.get(id).then(x => { setD(x); setLoadErr('') }).catch(e => setLoadErr(errMsg(e, 'Could not open this tender'))), [id])
  useEffect(() => { setD(null); void load() }, [load])
  useEffect(() => { bidApi.masters().then(setMs).catch(() => setMs({ portals: [], categories: [], oems: [], competitors: [], products: [], verticals: [] })) }, [])
  useEffect(() => { try { sessionStorage.setItem(tabKey, tab) } catch { /* private mode */ } }, [tab])
  const { move, ui } = useBidStage(d?.lost_reasons || null, !!d?.can.update, () => { void load() })

  /** Save one or more fields (validated by the server), then re-read the tender. */
  // `inline`: the caller shows the server message under its field (e.g. duplicate NIT), so no toast
  const save = useCallback(async (values: Record<string, unknown>, ok = 'Saved', inline = false) => {
    try { await bidApi.patch(id, values); success(ok); await load() } catch (e) { if (!inline) error(errMsg(e, 'Could not save')); await load(); throw e }
  }, [id, load, success, error])
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string, fail = 'Could not save') => {
    try { const r = await fn(); if (ok) success(ok); await load(); return r } catch (e) { error(errMsg(e, fail)); await load(); return undefined }
  }, [load, success, error])

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Tenders</a></div><div className="panel"><div className="empty">{loadErr} · <a onClick={() => void load()}>Retry</a></div></div></div>
  if (!d) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Tenders</a> / …</div><div className="empty">Loading…</div></div>
  const ed = d.can.update
  const ci = d.stages.findIndex(s => s.id === d.stage.id)
  const target = (s: Detail['stages'][number]) => void move({ id: d.id, stages: d.stages, currentId: d.stage.id }, s)

  const body: Record<Tab, () => ReactNode> = {
    'Basic Info': () => <BasicInfo d={d} ms={ms} ed={ed} save={save} />,
    'Tender Details': () => <TenderDetails d={d} ed={ed} save={save} run={run} />,
    'Workings': () => <Workings d={d} ms={ms} ed={ed} save={save} run={run} />,
    'Tech Bid Evaluation': () => <TechEval d={d} ed={ed} run={run} onAdvanced={s => success(`Qualified – moved to ${s}`)} />,
    'Financial': () => <Financial d={d} ms={ms} ed={ed} save={save} run={run} warning={warning} />,
    'PO & Consignee': () => <PoConsignee d={d} ed={ed} save={save} run={run} navigate={navigate} />,
  }
  return (
    <div className="bwi tpage">
      <div className="crumb"><a onClick={() => navigate('/tenders')}>Tenders</a> / {d.ref}</div>
      <div className="pg">
        <h1>{d.title}</h1><span className="fl" />
        {ed && <button type="button" className="btn" onClick={() => navigate(`/tenders/${d.id}/form`)}><Ic n="edit" /> Edit</button>}
        <button type="button" className="btn" onClick={() => setDocs(true)}><Ic n="folder" /> Documents</button>
        {d.next && ed && !d.pending && <button type="button" className="btn p" onClick={() => target(d.next!)}>Move to {d.next.name} <Ic n="right" /></button>}
      </div>
      <div className="row wrap mb tsum">
        <span>{d.nit || '—'}</span><span className="mu">{d.customer}</span>{d.company && <span className="pill ac">{d.company}</span>}<span>{inr(d.value)}</span>
        <span><Pill s={d.stage.name} t={stagePill(d.stage.name, d.stage.kind)} /></span><span>Submission <DueCell d={d.submit} /></span>
        {d.owner && <span className="row" style={{ gap: 5 }}><Av name={d.owner} />{d.owner}</span>}
      </div>
      <Hero d={d} ed={ed} onNext={() => d.next && target(d.next)} onLog={() => setLogAct(true)} navigate={navigate} />
      <div className="path" role="list" aria-label="Workflow stages">{d.stages.map((s, i) => {
        const cls = s.id === d.stage.id ? (s.kind === 'won' ? 'won' : s.kind === 'lost' ? 'lost' : 'cur') : i < ci && s.kind === 'open' ? 'done' : ''
        return <button type="button" role="listitem" key={s.id} className={`s ${cls} ${d.pending?.stage === s.name ? 'hold' : ''}`} disabled={!ed || !!d.pending}
          title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`} onClick={() => target(s)}>{s.name}</button>
      })}</div>
      {d.pending && <div className="note mb">Awaiting approval to move to <b>{d.pending.stage}</b>. <a onClick={() => navigate('/approvals')}>View approval</a></div>}
      {d.lost && <div className="note mb" style={{ borderColor: 'var(--bw-ba)' }}>Marked <b>{d.stage.name}</b>{d.lost.reason ? <> · Reason: <b>{d.lost.reason}</b></> : null}{d.lost.note ? <> – {d.lost.note}</> : null}</div>}
      <Journey d={d} onTimeline={() => setTimeline(true)} navigate={navigate} />
      <div className="panel">
        <div className="tabs" role="tablist">{TT.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
        <div className="pb">{body[tab]()}</div>
      </div>
      {docs && <DocsModal d={d} onClose={() => setDocs(false)} navigate={navigate} />}
      {timeline && <Modal title={`Journey · ${d.journey.id}`} width={620} onClose={() => setTimeline(false)}>
        <div className="list tl">{d.history.length ? d.history.map((h, i) => <div key={i}><span className="fl">{h.t}{h.by && <small className="mu"> · {h.by}</small>}</span><small className="mu">{h.d ? `${fd(h.d)} ${h.d.slice(11, 16)}` : ''}</small></div>)
          : <div className="empty">No activity recorded yet.</div>}</div>
      </Modal>}
      {logAct && <LogActivityModal d={d} onClose={() => setLogAct(false)} onDone={() => { setLogAct(false); success('Activity logged'); void load() }} />}
      {ui}
    </div>
  )
}

// prototype recHero('tenders'): five value tiles, the stage progress of this tender's flow, Log activity · Next stage and
// the signal chips with the customer's 360 link.
function Hero({ d, ed, onNext, onLog, navigate }: { d: Detail; ed: boolean; onNext: () => void; onLog: () => void; navigate: (p: string) => void }) {
  const h = d.hero
  const due = h.submit_in == null ? '' : h.submit_in < 0 ? `${-h.submit_in} d overdue` : h.submit_in === 0 ? 'today' : `in ${h.submit_in} d`
  const T = ({ l, v, s, c }: { l: string; v: ReactNode; s?: ReactNode; c?: string }) => <div className="rht"><label>{l}</label><b className={c || ''}>{v}</b>{s ? <small>{s}</small> : null}</div>
  return <div className="rhero">
    <div className="rhg">
      <T l="Bid value" v={inr(h.value)} />
      <T l="EMD" v={h.emd ? inr(h.emd) : '—'} s={h.emd ? (h.emd_furnished ? 'furnished' : 'not furnished') : 'not required'} c={h.emd && !h.emd_furnished ? 'twarn' : ''} />
      <T l="Submission" v={h.submit ? fd(h.submit) : '—'} s={due} c={h.kind === 'open' && h.submit_in != null && h.submit_in < 0 ? 'tbad' : ''} />
      <T l="Portal · OEM" v={h.portal || '—'} s={h.oem || ''} />
      <T l="Published" v={h.published_ago != null ? `${h.published_ago} d ago` : '—'} s={h.published ? fd(h.published) : ''} />
    </div>
    <div className="rhrow">
      <div className="fl"><div className="rhp"><div className={`rhpb ${h.kind === 'won' ? 'won' : h.kind === 'lost' ? 'lost' : ''}`} style={{ width: `${h.pct}%` }} /></div>
        <small className="mu">{h.kind === 'won' ? 'Closed won' : h.kind === 'lost' ? 'Closed lost' : `Stage ${h.stage_no} of ${h.stages_of}`} · {h.flow}</small></div>
      <button type="button" className="btn s" onClick={onLog}><Ic n="pin" /> Log activity</button>
      {ed && d.next && !d.pending && <button type="button" className="btn s" onClick={onNext}><Ic n="right" /> Next stage</button>}
    </div>
    <div className="rhsig">
      {h.signals.map((x, i) => <span key={i} className="sig"><i style={{ background: x.t === 'ba' ? 'var(--bw-ba)' : x.t === 'wa' ? 'var(--bw-wa)' : x.t === 'ok' ? 'var(--bw-ok)' : 'var(--bw-in)' }} />{x.s}</span>)}
      {d.customer_id && <a className="sig lk" onClick={() => navigate(`/customers/${d.customer_id}`)}><Ic n="building" size={13} /> {d.customer} · 360 →</a>}
    </div>
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
  const fe = useFieldErrors(), er = fe.errors
  type LK = 'subject' | 'date' | 'outcome' | 'description'
  const LS: Record<LK, FieldSpec> = { subject: { label: 'Subject', rule: 'text', required: true, min: 2, max: 255 }, date: { label: 'Date', rule: 'date', required: true },
    outcome: { label: 'Outcome', rule: 'text', required: needOutcome, max: 1000 }, description: { label: needDesc ? 'Reason' : 'Notes', rule: 'textarea', required: needDesc, max: 5000 } }
  const la = (k: LK, id: string) => ({ className: `in ${er[k] ? 'err' : ''}`, onBlur: () => fe.blur(k, f[k], LS[k]), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `${id}-err` : undefined })
  const lset = (k: LK, x: string) => { setF({ ...f, [k]: x }); fe.change(k, x, LS[k]) }
  const ok = f.type && f.subject.trim() && f.date && (!needOutcome || f.outcome.trim()) && (!needDesc || f.description.trim())
  return <Modal title="Log activity" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!ok || busy} onClick={async () => {
      const bad = fe.validateAll(f, { subject: LS.subject, date: LS.date, outcome: needOutcome ? LS.outcome : undefined, description: LS.description })
      if (Object.keys(bad).length) { const id = { subject: 'la-sub', date: 'la-d', outcome: 'la-o', description: 'la-n' }[(['subject', 'date', 'outcome', 'description'] as LK[]).find(k => bad[k])!]; document.getElementById(id)?.focus(); return }
      setBusy(true)
      try {
        await api.post('/kam/activities', { activity_type: f.type, tender_id: d.id, customer_id: d.customer_id, subject: f.subject.trim(), activity_date: f.date, status: f.status,
          outcome: f.outcome.trim() || null, description: f.description.trim() || null, ...(f.status === 'Cancelled' ? { cancellation_reason: f.description.trim() } : {}) })
        onDone()
      } catch (e) { error(errMsg(e, 'Could not log the activity')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Log activity'}</button></>}>
    {metaErr ? <div className="note bad">{metaErr} · <a onClick={loadMeta}>Retry</a></div> : !kmeta ? <div className="empty">Loading…</div> :
      <div className="fg">
        <div><label htmlFor="la-t">Type</label><select id="la-t" className="in" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>{kmeta.activity_types.map(t => <option key={t}>{t}</option>)}</select></div>
        <div><label htmlFor="la-s">Status</label><select id="la-s" className="in" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{kmeta.statuses.map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="f1"><label htmlFor="la-sub">Subject *</label><input id="la-sub" {...la('subject', 'la-sub')} value={f.subject} onChange={e => lset('subject', e.target.value)} placeholder={`Pre-bid clarification – ${d.ref}`} /><FieldError id="la-sub" msg={er.subject} /></div>
        <div><label htmlFor="la-d">Date *</label><input id="la-d" {...la('date', 'la-d')} type="date" value={f.date} onChange={e => lset('date', e.target.value)} /><FieldError id="la-d" msg={er.date} /></div>
        {needOutcome && <div className="f1"><label htmlFor="la-o">Outcome *</label><input id="la-o" {...la('outcome', 'la-o')} value={f.outcome} onChange={e => lset('outcome', e.target.value)} /><FieldError id="la-o" msg={er.outcome} /></div>}
        <div className="f1"><label htmlFor="la-n">{needDesc ? 'Reason *' : 'Notes'}</label><textarea id="la-n" {...la('description', 'la-n')} rows={3} value={f.description} onChange={e => lset('description', e.target.value)} /><FieldError id="la-n" msg={er.description} /></div>
      </div>}
  </Modal>
}

/* ───────────────────────── shared inputs ───────────────────────── */

/** Input that keeps a local draft and saves on blur / Enter when the value changed (prototype data-c change handlers).
 *  `spec` / `extra` validate the typed value: the message shows under the field and an invalid value is not saved (the draft
 *  is kept). With `inlineErr` a rejected save (e.g. duplicate NIT → 409) is shown under the field instead of being reverted. */
function SaveInput({ value, onSave, type = 'text', disabled, className = 'in', style, min, max, step, placeholder, ariaLabel, rows, list, spec, extra, inlineErr }: {
  value: string | number | null | undefined; onSave: (v: string) => Promise<unknown> | void; type?: string; disabled?: boolean; className?: string; style?: React.CSSProperties
  min?: number; max?: number; step?: string; placeholder?: string; ariaLabel?: string; rows?: number; list?: string
  spec?: FieldSpec; extra?: (v: string) => string; inlineErr?: boolean
}) {
  const sv = value == null ? '' : String(value)
  const [v, setV] = useState(sv)
  const [focus, setFocus] = useState(false)
  const fe = useFieldErrors()
  const uid = useId(), msg = fe.errors.v
  useEffect(() => { if (!focus) setV(sv) }, [sv, focus])
  useEffect(() => { if (!focus && v === sv) fe.clear('v') }, [sv]) // eslint-disable-line react-hooks/exhaustive-deps
  const check = (x: string, mode: 'change' | 'blur') => {
    const base = spec ? validate(x, spec) : ''
    if (spec) { if (mode === 'change') fe.change('v', x, spec); else fe.blur('v', x, spec) } else fe.clear('v')
    const xm = base ? '' : extra?.(x) || ''      // cross-field checks (e.g. date order, EMD ≤ value)
    if (xm) fe.setError('v', xm)
    return base || xm
  }
  const commit = () => {
    setFocus(false)
    if (v === sv) { fe.clear('v'); return }                  // unchanged values (even old ones) never block
    if (check(v, 'blur')) return                             // invalid – keep the draft, don't save
    const r = onSave(v)
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(e => { if (inlineErr) fe.setError('v', errMsg(e, 'Could not save')); else setV(sv) })
  }
  const p = { className: `${className}${msg ? ' err' : ''}`, style, disabled, placeholder, 'aria-label': ariaLabel, value: v, onFocus: () => setFocus(true), onBlur: commit,
    'aria-invalid': msg ? true : undefined, 'aria-describedby': msg ? `${uid}-err` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setV(e.target.value); if (e.target.value === sv) fe.clear('v'); else check(e.target.value, 'change') } }
  if (rows) return <><textarea {...p} rows={rows} /><FieldError id={uid} msg={msg} /></>
  return <><input {...p} type={type} min={min} max={max} step={step} list={list} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /><FieldError id={uid} msg={msg} /></>
}
const numOrNull = (v: string) => v.trim() === '' ? null : Number(v)

type SaveFn = (values: Record<string, unknown>, ok?: string, inline?: boolean) => Promise<void>
type RunFn = (fn: () => Promise<unknown>, ok?: string, fail?: string) => Promise<unknown>

/* ───────────────────────── Basic Info ───────────────────────── */

function BasicInfo({ d, ms, ed, save }: { d: Detail; ms: Masters | null; ed: boolean; save: SaveFn }) {
  const b = d.basic
  const [custQ, setCustQ] = useState('')
  const [locQ, setLocQ] = useState('')
  const customers = useMaster(() => bidApi.customers(custQ), [custQ])
  const locations = useMaster(() => bidApi.locations(locQ), [locQ])
  const users = useMaster(leadMasters.users)
  const look = (id: string, cur: { id: number; name: string } | null, items: Opt[] | null, field: string, empty: string, extra: Record<string, unknown> = {}, err?: string, retry?: () => void) =>
    <Lookup id={`bi-${id}`} value={cur?.id ?? null} label={cur?.name} items={items} error={err} onRetry={retry} disabled={!ed} emptyText={empty}
      onChange={o => { if ((o?.id ?? null) !== (cur?.id ?? null)) void save({ [field]: o?.id ?? null }).catch(() => undefined) }} {...extra} />
  const F: [string, string, ReactNode, boolean?][] = [
    ['title', 'Tender title', <SaveInput key="t" value={b.title} disabled={!ed} ariaLabel="Tender title" spec={{ label: 'Tender title', rule: 'text', required: true, min: 3, max: 500 }} inlineErr
      onSave={v => save({ title: v.trim() }, 'Saved', true)} />, true],
    ['nit', 'Tender / NIT no.', <SaveInput key="n" value={b.nit} disabled={!ed} ariaLabel="Tender / NIT no." spec={{ label: 'Tender / NIT number', rule: 'text', required: true, min: 2, max: 200 }} inlineErr
      onSave={v => save({ nit: v.trim() }, 'Saved', true)} />],
    ['customer', 'Customer', look('customer', b.customer, customers.items, 'customer_id', 'No customers you can work with', { onSearch: setCustQ, clearable: false }, customers.error, customers.reload)],
    ['portal', 'Portal', look('portal', b.portal, ms?.portals ?? null, 'portal_id', 'No active portals in Masters')],
    ['category', 'Category', look('category', b.category, ms?.categories ?? null, 'category_id', 'No active categories in Masters')],
    ['location', 'Location', look('location', b.location, locations.items, 'location_id', 'No matching location in Masters', { onSearch: setLocQ }, locations.error, locations.reload)],
    ['owner', 'Bid manager', look('owner', b.owner, users.items, 'owner_id', 'No active users', { clearable: false }, users.error, users.reload)],
    ['oem', 'Principal OEM', look('oem', b.oem, ms?.oems ?? null, 'oem_id', 'No active OEMs in Partners & OEM')],
    ['value', 'Estimated value (₹)', <SaveInput key="v" type="number" min={0} value={b.value || ''} disabled={!ed} ariaLabel="Estimated value" spec={{ label: 'Estimated value', rule: 'amount' }}
      extra={v => v.trim() !== '' && b.emd && Number(v) < b.emd ? 'Estimated value cannot be less than the EMD.' : ''} onSave={v => save({ value: numOrNull(v) })} />],
    ['emd', 'EMD (₹)', <SaveInput key="e" type="number" min={0} value={b.emd || ''} disabled={!ed} ariaLabel="EMD" spec={{ label: 'EMD', rule: 'amount' }}
      extra={v => v.trim() !== '' && b.value && Number(v) > b.value ? 'EMD cannot be more than the tender value.' : ''} onSave={v => save({ emd: numOrNull(v) })} />],
    ['fee', 'Tender fee (₹)', <SaveInput key="f" type="number" min={0} value={b.fee || ''} disabled={!ed} ariaLabel="Tender fee" spec={{ label: 'Tender fee', rule: 'amount' }} onSave={v => save({ fee: numOrNull(v) })} />],
  ]
  return <>
    <div className="fg g3c">{F.map(([k, l, node, full]) => <div key={k} className={full ? 'f1' : ''}><label htmlFor={`bi-${k}`}>{l}</label>{node}</div>)}</div>
    {b.custom.length > 0 && <><h3 className="mt mb">Custom fields</h3><div className="kv">{b.custom.map(([k, v]) => <div key={k}><span>{k}</span><span>{v === true ? 'Yes' : v === false ? 'No' : String(v ?? '—')}</span></div>)}</div></>}
  </>
}

/* ───────────────────────── Tender Details ───────────────────────── */

function TenderDetails({ d, ed, save, run }: { d: Detail; ed: boolean; save: SaveFn; run: RunFn }) {
  const x = d.details
  const [corr, setCorr] = useState(false)
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [fee, setFee] = useState(x.fee_items)
  const [penalty, setPenalty] = useState(x.penalty)
  const [milestones, setMilestones] = useState(x.milestones)
  useEffect(() => { bidApi.documents(d.id).then(r => setDocs(r.items)).catch(() => setDocs([])) }, [d.id])
  useEffect(() => { setFee(x.fee_items) }, [x.fee_items])
  useEffect(() => { setPenalty(x.penalty) }, [x.penalty])
  useEffect(() => { setMilestones(x.milestones) }, [x.milestones])
  const done = x.documents.filter(i => i.ok).length
  const patchFee = (itemId: number, b: Parameters<typeof bidApi.feeItem>[2]) =>
    run(() => bidApi.feeItem(d.id, itemId, b), undefined, 'Could not save the row').then(ok => {
      if (ok) setFee(rows => rows.map(r => r.id === itemId ? { ...r, ...('status' in b ? { status: b.status! } : {}), ...('amount' in b ? { amount: b.amount ?? null } : {}),
        ...('mode' in b ? { mode: b.mode || '' } : {}), ...('stakeholder' in b ? { stakeholder: b.stakeholder || '' } : {}), ...('cutoff' in b ? { cutoff: b.cutoff || null } : {}) } : r))
      return ok
    })
  const patchPenalty = (itemId: number, b: Parameters<typeof bidApi.penalty>[2]) =>
    run(() => bidApi.penalty(d.id, itemId, b), undefined, 'Could not save the row').then(ok => {
      if (ok) setPenalty(rows => rows.map(r => r.id === itemId ? { ...r, ...('description' in b ? { desc: b.description || '' } : {}), ...('amount' in b ? { amount: b.amount || '' } : {}), ...('remarks' in b ? { remarks: b.remarks || '' } : {}) } : r))
      return ok
    })
  const patchMilestone = (itemId: number, b: Parameters<typeof bidApi.milestone>[2]) =>
    run(() => bidApi.milestone(d.id, itemId, b), undefined, 'Could not save the row').then(ok => {
      if (ok) setMilestones(rows => rows.map(r => r.id === itemId ? { ...r, ...('milestone' in b ? { milestone: b.milestone || '' } : {}), ...('description' in b ? { desc: b.description || '' } : {}), ...('remarks' in b ? { remarks: b.remarks || '' } : {}) } : r))
      return ok
    })
  const dates: [string, string, string | null][] = [['published', 'Published', x.published], ['prebid', 'Pre-bid meeting', x.prebid], ['submit', 'Bid submission', x.submit],
    ['opening', 'Technical bid opening', x.opening], ['opening2', 'Financial bid opening', x.opening2]]
  // key-date order: published ≤ pre-bid ≤ submission ≤ technical opening ≤ financial opening (checked against the saved neighbours)
  const dateOrder = (k: string, nv: string): string => {
    if (!nv) return ''
    const D = { published: x.published, prebid: x.prebid, submit: x.submit, opening: x.opening, opening2: x.opening2 } as Record<string, string | null>
    const L: Record<string, string> = { published: 'the published date', prebid: 'the pre-bid meeting date', submit: 'the bid submission date', opening: 'the technical bid opening date', opening2: 'the financial bid opening date' }
    const own: Record<string, string> = { published: 'Published date', prebid: 'Pre-bid meeting date', submit: 'Bid submission date', opening: 'Technical bid opening date', opening2: 'Financial bid opening date' }
    const order = ['published', 'prebid', 'submit', 'opening', 'opening2'], i = order.indexOf(k), day = nv.slice(0, 10)
    const before = order.slice(0, i).reverse().find(o => D[o]), after = order.slice(i + 1).find(o => D[o])
    if (before && day < D[before]!.slice(0, 10)) return `${own[k]} must be on or after ${L[before]}.`
    if (after && day > D[after]!.slice(0, 10)) return `${own[k]} must be on or before ${L[after]}.`
    return ''
  }
  return <div className="g g2">
    <div>
      <Panel title="Key dates"><div className="fg">
        {dates.map(([k, l, v]) => <div key={k}><label>{l}</label><SaveInput type="date" value={v || ''} disabled={!ed} ariaLabel={l}
          spec={{ label: l === 'Bid submission' ? 'Bid submission date' : l, rule: 'date', required: k === 'submit' }} extra={nv => dateOrder(k, nv)} onSave={nv => save({ [k]: nv || null })} /></div>)}
        <div><label>Bid validity (days)</label><SaveInput type="number" min={1} value={x.validity} disabled={!ed} ariaLabel="Bid validity (days)" spec={{ label: 'Bid validity', rule: 'integer', min: 1, max: 1000 }}
          onSave={v => save({ validity: numOrNull(v) })} /></div>
      </div></Panel>
      <div className="mt"><Panel title="Bid terms" z><div className="fg">
        <div><label>Method of selection</label><select className="in" disabled={!ed} aria-label="Method of selection" value={x.selection_method}
          onChange={e => void save({ selMethod: e.target.value || null })}><option value="">—</option><option>L1</option><option>QCBS</option><option>Single bid</option></select></div>
        <div><label>GST applicable</label><select className="in" disabled={!ed} aria-label="GST applicable" value={x.gst_applicable ? 'Yes' : 'No'}
          onChange={e => void save({ gst: e.target.value === 'Yes' })}><option>Yes</option><option>No</option></select></div>
        <div><label>JV / Consortium allowed</label><select className="in" disabled={!ed} aria-label="JV / Consortium allowed" value={x.jv_allowed ? 'Yes' : 'No'}
          onChange={e => void save({ jv: e.target.value === 'Yes' })}><option>No</option><option>Yes</option></select></div>
        {x.jv_allowed && <div><label>No. of consortium members</label><SaveInput type="number" min={1} max={20} value={x.jv_member_count ?? ''} disabled={!ed} ariaLabel="No. of consortium members"
          spec={{ label: 'No. of consortium members', rule: 'integer', min: 1, max: 20 }} onSave={v => save({ jvCount: numOrNull(v) })} /></div>}
      </div></Panel></div>
      <div className="mt"><Panel title="Corrigenda" z>
        <div className="list">{x.corrigenda.length ? x.corrigenda.map(c => <div key={c.id}><b>{c.n}</b><span className="fl">{c.t}</span><small>{fd(c.d)}</small></div>)
          : <div className="mu">No corrigenda published.</div>}</div>
        {ed && <div style={{ padding: 8 }}><button type="button" className="btn s" onClick={() => setCorr(true)}><Ic n="plus" /> Add corrigendum</button></div>}
      </Panel></div>
      <div className="mt"><Panel title="Fee & document checklist" z>
        <div className="tw fit"><table className="t"><thead><tr><th>Type</th><th className="r">Amount (₹)</th><th>Mode</th><th>Stakeholder</th><th>Cut-off</th><th>Attachment</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{fee.map(f => <tr key={f.id}>
            <td className="wr">{f.label}</td>
            <td className="r"><SaveInput className="in sm" type="number" min={0} style={{ width: 100 }} value={f.amount ?? ''} disabled={!ed} ariaLabel={`Amount – ${f.label}`}
              spec={{ label: 'Amount', rule: 'amount' }} onSave={v => patchFee(f.id, { amount: numOrNull(v) })} /></td>
            <td><select className="in sm" disabled={!ed} aria-label={`Payment mode – ${f.label}`} value={f.mode} onChange={e => void patchFee(f.id, { mode: e.target.value || null })}>
              <option value="">—</option><option>DD</option><option>BG</option><option>Online</option><option>NEFT</option></select></td>
            <td><SaveInput className="in sm" style={{ minWidth: 110 }} value={f.stakeholder} disabled={!ed} ariaLabel={`Stakeholder – ${f.label}`} spec={{ label: 'Stakeholder', rule: 'text', max: 200 }}
              onSave={v => patchFee(f.id, { stakeholder: v })} /></td>
            <td><SaveInput type="date" value={f.cutoff || ''} disabled={!ed} ariaLabel={`Cut-off date – ${f.label}`} spec={{ label: 'Cut-off date', rule: 'date' }}
              onSave={v => patchFee(f.id, { cutoff: v || null })} /></td>
            <td>{ed && docs && docs.length > 0 ? <select className="in sm dsel" aria-label={`Link a Document Hub file to ${f.label}`} value={f.document_id || ''}
              onChange={e => void patchFee(f.id, { document_id: e.target.value || null }).then(ok => { if (ok) setFee(rows => rows.map(r => r.id === f.id ? { ...r, document_id: e.target.value || null, document_name: docs.find(o => o.id === e.target.value)?.name || null } : r)) })}>
              <option value="">Link document…</option>{docs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
              : f.document_name ? <small className="mu"><Ic n="file" size={12} /> {f.document_name}</small> : <span className="mu">—</span>}</td>
            <td><Pill s={f.status === 'paid' ? 'Paid' : f.status === 'not_due' ? 'Not due' : 'Pending'} t={f.status === 'paid' ? 'ok' : f.status === 'not_due' ? 'mu' : 'wa'} /></td>
            <td>{ed && <button type="button" className="btn g s" aria-label={`Delete ${f.label}`} onClick={() => void run(() => bidApi.delFeeItem(d.id, f.id), 'Row removed').then(ok => { if (ok) setFee(rows => rows.filter(r => r.id !== f.id)) })}><Ic n="x" /></button>}</td>
          </tr>)}</tbody></table>
          {!fee.length && <div className="empty">No fee or document rows yet.</div>}
        </div>
        {ed && <div style={{ padding: 8 }}><button type="button" className="btn s" onClick={() => void run(() => bidApi.addFeeItem(d.id, { label: 'New fee / document' }), undefined, 'Could not add the row')
          .then(r => { const id = (r as { id: number } | undefined)?.id; if (id) setFee(rows => [...rows, { id, label: 'New fee / document', amount: null, mode: '', stakeholder: '', cutoff: null, document_id: null, document_name: null, status: 'pending' }]) })}>
          <Ic n="plus" /> Add row</button></div>}
      </Panel></div>
      <div className="mt"><Panel title="Penalty clause" z>
        <div className="tw fit"><table className="t"><thead><tr><th>Description</th><th>Penalty amount / rate</th><th>Remarks</th><th>Action</th></tr></thead>
          <tbody>{penalty.map(p => <tr key={p.id}>
            <td className="wr"><SaveInput value={p.desc} disabled={!ed} ariaLabel="Description" spec={{ label: 'Description', rule: 'textarea', required: true, max: 2000 }} onSave={v => patchPenalty(p.id, { description: v })} /></td>
            <td><SaveInput className="in sm" style={{ minWidth: 150 }} value={p.amount} disabled={!ed} ariaLabel="Penalty amount / rate" placeholder="e.g. 0.5% per week, max 10%" spec={{ label: 'Penalty amount', rule: 'text', max: 200 }} onSave={v => patchPenalty(p.id, { amount: v })} /></td>
            <td><SaveInput className="in sm" value={p.remarks} disabled={!ed} ariaLabel="Remarks" spec={{ label: 'Remarks', rule: 'text', max: 500 }} onSave={v => patchPenalty(p.id, { remarks: v })} /></td>
            <td>{ed && <button type="button" className="btn g s" aria-label="Delete penalty clause" onClick={() => void run(() => bidApi.delPenalty(d.id, p.id), 'Row removed').then(ok => { if (ok) setPenalty(rows => rows.filter(r => r.id !== p.id)) })}><Ic n="x" /></button>}</td>
          </tr>)}</tbody></table>
          {!penalty.length && <div className="empty">No penalty clauses yet.</div>}
        </div>
        {ed && <div style={{ padding: 8 }}><button type="button" className="btn s" onClick={() => void run(() => bidApi.addPenalty(d.id, { description: 'New penalty clause' }), undefined, 'Could not add the row')
          .then(r => { const id = (r as { id: number } | undefined)?.id; if (id) setPenalty(rows => [...rows, { id, desc: 'New penalty clause', amount: '', remarks: '' }]) })}>
          <Ic n="plus" /> Add row</button></div>}
      </Panel></div>
      <div className="mt"><Panel title="Payment milestone" z>
        <div className="tw fit"><table className="t"><thead><tr><th>Milestone</th><th>Description</th><th>Remarks</th><th>Action</th></tr></thead>
          <tbody>{milestones.map(m => <tr key={m.id}>
            <td><SaveInput className="in sm" style={{ minWidth: 150 }} value={m.milestone} disabled={!ed} ariaLabel="Milestone" spec={{ label: 'Milestone', rule: 'text', required: true, max: 300 }} onSave={v => patchMilestone(m.id, { milestone: v })} /></td>
            <td className="wr"><SaveInput value={m.desc} disabled={!ed} ariaLabel="Description" spec={{ label: 'Description', rule: 'textarea', max: 2000 }} onSave={v => patchMilestone(m.id, { description: v })} /></td>
            <td><SaveInput className="in sm" value={m.remarks} disabled={!ed} ariaLabel="Remarks" spec={{ label: 'Remarks', rule: 'text', max: 500 }} onSave={v => patchMilestone(m.id, { remarks: v })} /></td>
            <td>{ed && <button type="button" className="btn g s" aria-label="Delete payment milestone" onClick={() => void run(() => bidApi.delMilestone(d.id, m.id), 'Row removed').then(ok => { if (ok) setMilestones(rows => rows.filter(r => r.id !== m.id)) })}><Ic n="x" /></button>}</td>
          </tr>)}</tbody></table>
          {!milestones.length && <div className="empty">No payment milestones yet.</div>}
        </div>
        {ed && <div style={{ padding: 8 }}><button type="button" className="btn s" onClick={() => void run(() => bidApi.addMilestone(d.id, { milestone: 'New milestone' }), undefined, 'Could not add the row')
          .then(r => { const id = (r as { id: number } | undefined)?.id; if (id) setMilestones(rows => [...rows, { id, milestone: 'New milestone', desc: '', remarks: '' }]) })}>
          <Ic n="plus" /> Add row</button></div>}
      </Panel></div>
    </div>
    <div>
      <Panel title="Eligibility criteria" z><div className="list">{x.eligibility.map(e => <div key={e.id}>
        <input type="checkbox" checked={e.ok} disabled={!ed} aria-label={e.t} onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { ok: ev.target.checked }))} />
        <span className="fl">{e.t}</span><Pill s={e.ok ? 'Met' : 'Gap'} t={e.ok ? 'ok' : 'ba'} /></div>)}</div></Panel>
      <div className="mt"><Panel title={<>Mandatory documents <small className="mu" style={{ fontWeight: 400 }}>· {done} / {x.documents.length} complete</small></>} z>
        <div className="list">{x.documents.map(e => <div key={e.id}>
          <input type="checkbox" checked={e.ok} disabled={!ed} aria-label={e.t} onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { ok: ev.target.checked }))} />
          <span className="fl">{e.t}{e.document_name && <small className="mu"> · <Ic n="file" size={12} /> {e.document_name}</small>}</span>
          {ed && docs && docs.length > 0 && <select className="in sm dsel" aria-label={`Link a Document Hub file to ${e.t}`} value={e.document_id || ''}
            onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { document_id: ev.target.value }), ev.target.value ? 'Document linked' : 'Link removed')}>
            <option value="">Link document…</option>{docs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        </div>)}</div>
        <div className="pbar"><span className="bar" style={{ width: '100%' }}><i style={{ width: `${x.documents.length ? done / x.documents.length * 100 : 0}%`, background: done === x.documents.length ? 'var(--bw-ok)' : undefined }} /></span></div>
      </Panel></div>
      {x.documents_commercial.length > 0 && <div className="mt"><Panel title="Commercial documents" z>
        <div className="list">{x.documents_commercial.map(e => <div key={e.id}>
          <input type="checkbox" checked={e.ok} disabled={!ed} aria-label={e.t} onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { ok: ev.target.checked }))} />
          <span className="fl">{e.t}{e.document_name && <small className="mu"> · <Ic n="file" size={12} /> {e.document_name}</small>}</span>
          {ed && docs && docs.length > 0 && <select className="in sm dsel" aria-label={`Link a Document Hub file to ${e.t}`} value={e.document_id || ''}
            onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { document_id: ev.target.value }), ev.target.value ? 'Document linked' : 'Link removed')}>
            <option value="">Link document…</option>{docs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        </div>)}</div>
      </Panel></div>}
      {x.documents_final.length > 0 && <div className="mt"><Panel title="Final bid documents" z>
        <div className="list">{x.documents_final.map(e => <div key={e.id}>
          <input type="checkbox" checked={e.ok} disabled={!ed} aria-label={e.t} onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { ok: ev.target.checked }))} />
          <span className="fl">{e.t}{e.document_name && <small className="mu"> · <Ic n="file" size={12} /> {e.document_name}</small>}</span>
          {ed && docs && docs.length > 0 && <select className="in sm dsel" aria-label={`Link a Document Hub file to ${e.t}`} value={e.document_id || ''}
            onChange={ev => void run(() => bidApi.checklist(d.id, e.id, { document_id: ev.target.value }), ev.target.value ? 'Document linked' : 'Link removed')}>
            <option value="">Link document…</option>{docs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        </div>)}</div>
      </Panel></div>}
      <div className="mt"><Panel title="Scope of work"><SaveInput rows={3} value={x.scope} disabled={!ed} ariaLabel="Scope of work" spec={{ label: 'Scope of work', rule: 'textarea', max: 20000 }} onSave={v => save({ scope: v })} /></Panel></div>
    </div>
    {corr && <CorrModal next={x.corrigenda.length + 1} onClose={() => setCorr(false)} onSave={async b => { const r = await run(() => bidApi.corrigendum(d.id, b), 'Corrigendum recorded', 'Could not add the corrigendum'); if (r) setCorr(false) }} />}
  </div>
}

function CorrModal({ next, onClose, onSave }: { next: number; onClose: () => void; onSave: (b: { number: string; description: string; date: string }) => Promise<void> }) {
  const [n, setN] = useState(`Corrigendum ${next}`)
  const [t, setT] = useState('')
  const [dt, setDt] = useState(todayIso())
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors(), er = fe.errors
  const S: Record<string, FieldSpec> = { cn: { label: 'Corrigendum number', rule: 'text', required: true, max: 80 }, cd: { label: 'Date', rule: 'date', required: true },
    ct: { label: 'Description', rule: 'textarea', required: true, max: 5000 } }
  const vals = { cn: n, cd: dt, ct: t }
  const a = (k: string) => ({ className: `in ${er[k] ? 'err' : ''}`, onBlur: () => fe.blur(k, vals[k as keyof typeof vals], S[k]), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `${k}-err` : undefined })
  const submit = async () => {
    const bad = fe.validateAll(vals, S)
    if (Object.keys(bad).length) { const k = ['cn', 'cd', 'ct'].find(x => bad[x]); if (k) document.getElementById(k)?.focus(); return }
    setBusy(true); try { await onSave({ number: n.trim(), description: t.trim(), date: dt }) } finally { setBusy(false) }
  }
  return <Modal title="Add corrigendum" width={460} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || !t.trim() || !dt || !n.trim()} onClick={submit}>Add</button></>}>
    <div className="fg">
      <div><label htmlFor="cn">Corrigendum number</label><input id="cn" {...a('cn')} value={n} maxLength={80} onChange={e => { setN(e.target.value); fe.change('cn', e.target.value, S.cn) }} /><FieldError id="cn" msg={er.cn} /></div>
      <div><label htmlFor="cd">Date</label><input id="cd" {...a('cd')} type="date" value={dt} onChange={e => { setDt(e.target.value); fe.change('cd', e.target.value, S.cd) }} /><FieldError id="cd" msg={er.cd} /></div>
      <div className="f1"><label htmlFor="ct">Description</label><textarea id="ct" {...a('ct')} rows={3} value={t} onChange={e => { setT(e.target.value); fe.change('ct', e.target.value, S.ct) }} placeholder="What changed on the portal" /><FieldError id="ct" msg={er.ct} /></div>
    </div>
  </Modal>
}

/* ───────────────────────── Workings ───────────────────────── */

function Workings({ d, ms, ed, save, run }: { d: Detail; ms: Masters | null; ed: boolean; save: SaveFn; run: RunFn }) {
  const w = d.workings
  const lock = !ed || w.locked
  const prods = ms?.products || []
  const linePatch = (lineId: number, b: Record<string, unknown>) => run(() => bidApi.line(d.id, lineId, b), undefined, 'Could not save the line')
  return <div className="g g21">
    <div><Panel title="Cost working / BoQ" z>
      <div className="tw fit"><table className="t"><thead><tr><th>#</th><th>Item</th><th>OEM</th><th>Qty</th><th className="r">Rate (₹)</th><th className="r">Amount</th><th>Action</th></tr></thead>
        <tbody>{w.lines.map((l, i) => <tr key={l.id}>
          <td>{i + 1}</td>
          <td><SaveInput className="in sm" style={{ minWidth: 200 }} value={l.item} disabled={lock} ariaLabel={`Item ${i + 1}`} placeholder="Item" list="bq-products" spec={{ label: 'Item', rule: 'text', max: 300 }}
            onSave={v => { const p = prods.find(x => x.name.toLowerCase() === v.trim().toLowerCase()); return linePatch(l.id, p ? { item: v, product_id: p.id } : { item: v, product_id: null }) }} />
          </td>
          <td><select className="in sm" style={{ minWidth: 120 }} value={l.oem_id ?? ''} disabled={lock} aria-label={`OEM ${i + 1}`} onChange={e => void linePatch(l.id, { oem_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>{(ms?.oems || []).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            {l.oem_id && !(ms?.oems || []).some(o => o.id === l.oem_id) && <option value={l.oem_id}>{l.oem}</option>}</select></td>
          <td><SaveInput className="in sm" type="number" min={1} step="1" style={{ width: 60 }} value={l.qty} disabled={lock} ariaLabel={`Qty ${i + 1}`}
            spec={{ label: 'Qty', rule: 'amount', required: true, min: 1, max: 10_000_000 }} onSave={v => linePatch(l.id, { qty: Number(v) })} /></td>
          <td className="r"><SaveInput className="in sm" type="number" min={0} style={{ width: 110 }} value={l.rate} disabled={lock} ariaLabel={`Rate ${i + 1}`}
            spec={{ label: 'Rate', rule: 'amount', required: true }} onSave={v => linePatch(l.id, { rate: Number(v) })} /></td>
          <td className="r">{inr(l.amount)}</td>
          <td>{!lock && <button type="button" className="btn g s" aria-label={`Delete line ${i + 1}`} onClick={() => void run(() => bidApi.delLine(d.id, l.id), 'Line removed')}><Ic n="x" /></button>}</td>
        </tr>)}</tbody></table>
        {!w.lines.length && <div className="empty">No BoQ lines yet{w.initial_products ? ` – start from the ${w.initial_products} product line${w.initial_products > 1 ? 's' : ''} captured on this tender, or add lines` : ' – add the first line'}.</div>}
      </div>
      <datalist id="bq-products">{prods.map(p => <option key={p.id} value={p.name} />)}</datalist>
      {!lock && <div className="row" style={{ padding: 8, gap: 6 }}>
        <button type="button" className="btn s" onClick={() => void run(() => bidApi.addLine(d.id, { item: 'New line item', qty: 1, rate: 0 }))}><Ic n="plus" /> Add line</button>
        {!w.lines.length && w.initial_products > 0 && <button type="button" className="btn s" onClick={() => void run(() => bidApi.copyProducts(d.id), 'Product lines copied')}><Ic n="copy" /> Copy tender products</button>}
      </div>}
      {w.locked && <div className="note" style={{ margin: 8 }}><Ic n="lock" /> The price bid is frozen{d.financial.price_status === 'pending' ? ' and awaiting approval' : ' and approved'} – the BoQ and build-up are locked.</div>}
    </Panel></div>
    <div><Panel title="Price build-up">
      <div className="kv one">
        <div><span>Base cost</span><span>{inr(w.base)}</span></div>
        <div><span>Overheads <SaveInput className="in sm pin" type="number" min={0} max={100} value={w.oh_pct} disabled={lock} ariaLabel="Overheads %" spec={{ label: 'Overheads %', rule: 'percent' }} onSave={v => save({ oh: numOrNull(v) })} />%</span><span>{inr(w.oh)}</span></div>
        <div><span>Contingency <SaveInput className="in sm pin" type="number" min={0} max={100} value={w.cg_pct} disabled={lock} ariaLabel="Contingency %" spec={{ label: 'Contingency %', rule: 'percent' }} onSave={v => save({ cg: numOrNull(v) })} />%</span><span>{inr(w.cg)}</span></div>
        <div><span>Total cost</span><span><b>{inr(w.cost)}</b></span></div>
        <div><span>Margin <SaveInput className="in sm pin" type="number" min={0} max={100} value={w.mg_pct} disabled={lock} ariaLabel="Margin %" spec={{ label: 'Margin %', rule: 'percent' }} onSave={v => save({ mg: numOrNull(v) })} />%</span><span className="tok">{inr(w.margin)}</span></div>
        <div><span><b>Quoted price (excl. GST)</b></span><span><b>{inr(w.price)}</b></span></div>
        <div><span>vs estimate</span><span className={w.vs == null ? 'mu' : w.vs > 0 ? 'tbad' : 'tok'}>{w.vs == null ? '—' : `${w.vs.toFixed(1)}%`}</span></div>
      </div>
      <button type="button" className="btn p mt" style={{ width: '100%', justifyContent: 'center' }} disabled={lock || w.price <= 0}
        onClick={() => void run(() => bidApi.syncPrice(d.id), 'Price synced to Financial tab', 'Could not sync the price')}><Ic n="link" /> Sync to financial bid</button>
      <small className="mu" style={{ display: 'block', marginTop: 6 }}>{w.synced != null ? <>Financial bid: <b>{inr(w.synced)}</b>{w.synced_at ? ` · synced ${fd(w.synced_at)}` : ''}{Math.round(w.synced) !== Math.round(w.price) ? ' · differs from the current working' : ''}</> : 'Not synced to the financial bid yet.'}</small>
    </Panel></div>
  </div>
}

/* ───────────────────────── Tech Bid Evaluation ───────────────────────── */

function TechEval({ d, ed, run, onAdvanced }: { d: Detail; ed: boolean; run: RunFn; onAdvanced: (stage: string) => void }) {
  const e = d.tech
  const res = e.result
  return <>
    <Strip items={[{ l: 'Technical score', v: `${+e.score.toFixed(2)} / ${+e.max.toFixed(2)}`, f: 'text' }, { l: 'Percentage', v: `${e.pct}%`, f: 'text' }, { l: 'Cut-off', v: `${e.cutoff}%`, f: 'text' },
      { l: 'Result', v: res, f: 'text', dc: res === 'Qualified' ? 'tok' : res === 'Not qualified' ? 'tbad' : '' }]} />
    <Panel title="Evaluation matrix" z>
      <table className="t"><thead><tr><th>Criterion</th><th className="r">Max marks</th><th className="r">Awarded</th><th>Score</th><th>Evaluator remark</th></tr></thead>
        <tbody>{e.rows.map(r => { const p = r.s == null ? 0 : r.s / r.w * 100, low = r.s != null && r.s / r.w < .6
          return <tr key={r.id}><td className="wr">{r.c}</td><td className="r">{r.w}</td>
            <td className="r"><SaveInput className="in sm" type="number" min={0} max={r.w} step="any" style={{ width: 70 }} value={r.s ?? ''} disabled={!ed} ariaLabel={`Awarded – ${r.c}`} spec={{ label: 'Awarded marks', rule: 'amount', max: r.w }}
              onSave={async v => { const x = await run(() => bidApi.score(d.id, r.id, v.trim() === '' ? { clear: true } : { awarded: Number(v) }), undefined, 'Could not save the score') as { advanced?: string | null } | undefined; if (x?.advanced) onAdvanced(x.advanced) }} /></td>
            <td><BarPct v={p} c={low ? 'var(--bw-ba)' : undefined} /></td>
            <td><SaveInput className={`in sm ${low && !r.rm ? 'tbad-ph' : ''}`} style={{ minWidth: 180 }} value={r.rm} disabled={!ed} placeholder={low ? 'Clarification likely' : '—'} ariaLabel={`Evaluator remark – ${r.c}`} spec={{ label: 'Evaluator remark', rule: 'text', max: 500 }}
              onSave={v => run(() => bidApi.score(d.id, r.id, { remark: v }), undefined, 'Could not save the remark')} /></td></tr>
        })}</tbody></table>
    </Panel>
    <div className="note inf mt">Cut-off is configurable per tenant under Settings → Approvals. Qualifying bids move to <b>{d.stages.find(s => /price/i.test(s.name))?.name || 'Price Bid'}</b> stage automatically if the “auto-advance” rule is {e.auto_advance ? 'enabled (it is on)' : 'enabled (it is off)'}.</div>
  </>
}

/* ───────────────────────── Financial ───────────────────────── */

function Financial({ d, ms, ed, save, run, warning }: { d: Detail; ms: Masters | null; ed: boolean; save: SaveFn; run: RunFn; warning: (m: string) => void }) {
  const { success } = useToast()
  const f = d.financial
  const [round, setRound] = useState(false)
  const [comp, setComp] = useState<string>('')
  const [amt, setAmt] = useState('')
  const fe = useFieldErrors()
  const amtSpec: FieldSpec = { label: 'Price bid', rule: 'amount' }
  const amtChk = (x: string, blur = false) => { if (blur) fe.blur('amt', x, amtSpec); else fe.change('amt', x, amtSpec); if (!validate(x, amtSpec) && x.trim() !== '' && !(Number(x) > 0)) fe.setError('amt', 'Price bid must be more than 0.') }
  const l1 = f.bids[0]?.p || 0
  const vsL1 = f.rank === 1 ? 'Lowest bidder' : `+${((f.our / (l1 || 1) - 1) * 100).toFixed(1)}% vs L1`
  const priceLbl = f.price_status === 'pending' ? 'Awaiting approval' : f.price_status === 'approved' ? 'Approved' : f.price_status === 'rejected' ? 'Rejected' : null
  return <>
    <Strip items={[{ l: 'Our price (excl. GST)', v: f.our, f: 'inr', note: f.synced ? undefined : 'not synced' },
      { l: 'Rank', v: `L${f.rank}`, f: 'text', note: f.bids.length > 1 ? vsL1 : 'no competitor bids yet', dc: f.bids.length > 1 ? (f.rank === 1 ? 'tok' : 'twarn') : '' },
      { l: `GST @${f.gst_pct}%`, v: f.gst, f: 'inr' }, { l: 'Total with GST', v: f.total, f: 'inr' }, { l: 'Performance BG', v: `${f.pbg_pct}% · ${inr(f.pbg)}`, f: 'text' }]} />
    <div className="g g2">
      <Panel title="Price bid comparison">
        <HBars d={f.bids.map((b, i) => ({ l: `L${i + 1} · ${b.n}`, v: b.p, c: b.me ? 'var(--bw-ac)' : 'var(--bw-mu)' }))} f={inr} lw={150} vw={76} />
        {f.bids.some(b => !b.me) && <div className="list cmp mt">{f.bids.filter(b => !b.me).map(b => <div key={b.id}><span className="fl">{b.n}</span><b>{inr(b.p)}</b>
          {ed && <button type="button" className="btn g s" aria-label={`Remove ${b.n}`} onClick={() => void run(() => bidApi.delCompetitor(d.id, b.id!), 'Competitor bid removed')}><Ic n="x" /></button>}</div>)}</div>}
        {ed && <div className="row wrap mt" style={{ gap: 6 }}>
          <select className="in sm" style={{ flex: 1, minWidth: 140 }} value={comp} onChange={e => setComp(e.target.value)} aria-label="Competitor">
            <option value="">Competitor…</option>{(ms?.competitors || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input className={`in sm ${fe.errors.amt ? 'err' : ''}`} type="number" min={1} style={{ width: 130 }} placeholder="Price bid (₹)" value={amt} onChange={e => { setAmt(e.target.value); amtChk(e.target.value) }}
            onBlur={() => amtChk(amt, true)} aria-label="Competitor price" aria-invalid={fe.errors.amt ? true : undefined} aria-describedby={fe.errors.amt ? 'cmp-amt-err' : undefined} />
          <button type="button" className="btn s" disabled={!comp || !(Number(amt) > 0) || !!fe.errors.amt} onClick={async () => { const r = await run(() => bidApi.competitor(d.id, { competitor_id: Number(comp), amount: Number(amt) }), 'Competitor bid saved'); if (r) { setComp(''); setAmt(''); fe.clear() } }}>
            <Ic n="plus" /> Add bid</button><FieldError id="cmp-amt" msg={fe.errors.amt} /></div>}
        {!(ms?.competitors || []).length && <small className="mu">Add competitors in Competitive Intel to compare price bids.</small>}
      </Panel>
      <Panel title="Commercial terms">
        <div className="fg">
          <div><label>Performance BG %</label><SaveInput type="number" min={0} max={100} value={f.pbg_pct} disabled={!ed} ariaLabel="Performance BG %" spec={{ label: 'Performance BG %', rule: 'percent' }} onSave={v => save({ pbg_pct: numOrNull(v) })} /></div>
          <div><label>EMD</label><input className="in" disabled value={inr(f.emd)} aria-label="EMD" /></div>
          <div className="f1"><label>Payment terms</label><SaveInput value={f.pay} disabled={!ed} ariaLabel="Payment terms" spec={{ label: 'Payment terms', rule: 'textarea' }} onSave={v => save({ pay: v })} /></div>
        </div>
        {ed && <div className="mt row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn" onClick={() => setRound(true)}><Ic n="plus" /> Log negotiation round</button>
          <button type="button" className="btn" disabled={f.price_status === 'pending' || f.price_status === 'approved'} onClick={() => {
            if (!f.synced) { warning('Sync the Workings price to the financial bid first'); return }
            void run(async () => { const r = await bidApi.freeze(d.id); (r.status === 'approved' ? success : warning)(r.message); return r }, undefined, 'Could not freeze the price bid')
          }}>Freeze &amp; send for approval</button>
          {priceLbl && <Pill s={`Price bid: ${priceLbl}`} t={f.price_status === 'approved' ? 'ok' : f.price_status === 'rejected' ? 'ba' : 'wa'} />}
        </div>}
        {f.rounds.length > 0 && <div className="mt"><small className="mu b">Negotiation rounds{f.final != null ? ` · final ${inr(f.final)}` : ''}</small>
          <div className="list">{f.rounds.map(r => <div key={r.n}><b>Round {r.n}</b><span className="fl">{inr(r.p)}{r.note && <small className="mu"> · {r.note}</small>}</span><small className="mu">{r.by}{r.at ? ` · ${fd(r.at)}` : ''}</small></div>)}</div></div>}
        {f.instruments.length > 0 && <div className="mt"><small className="mu b">Guarantees &amp; deposits</small>
          <div className="list">{f.instruments.map(x => <div key={x.id}><Pill s={x.type} t="ac" /><span className="fl">{x.ref}{x.bank ? <small className="mu"> · {x.bank}</small> : null}</span><b>{inr(x.amount)}</b>
            {x.expiry && <small className={x.days != null && x.days < 0 ? 'tbad' : x.days != null && x.days <= f.emd_alert_days ? 'twarn' : 'mu'}>valid till {fd(x.expiry)}</small>}</div>)}</div></div>}
      </Panel>
    </div>
    {round && <RoundModal suggested={f.final ?? f.our} onClose={() => setRound(false)} onSave={async b => { const r = await run(() => bidApi.negotiation(d.id, b), 'Negotiation round logged', 'Could not log the round'); if (r) setRound(false) }} />}
  </>
}

function RoundModal({ suggested, onClose, onSave }: { suggested: number; onClose: () => void; onSave: (b: { our_price: number; note?: string }) => Promise<void> }) {
  const [p, setP] = useState(suggested ? String(Math.round(suggested)) : '')
  const [n, setN] = useState('')
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors(), er = fe.errors
  const S: Record<string, FieldSpec> = { rp: { label: 'Revised price', rule: 'amount', required: true }, rn: { label: 'Note', rule: 'textarea', max: 2000 } }
  const zero = (x: string) => !validate(x, S.rp) && !(Number(x) > 0) ? 'Revised price must be more than 0.' : ''
  const chk = (k: 'rp' | 'rn', x: string, blur = false) => { if (blur) fe.blur(k, x, S[k]); else fe.change(k, x, S[k]); if (k === 'rp' && zero(x)) fe.setError(k, zero(x)) }
  const a = (k: 'rp' | 'rn', x: string) => ({ className: `in ${er[k] ? 'err' : ''}`, onBlur: () => chk(k, x, true), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `${k}-err` : undefined })
  const submit = async () => {
    const bad = fe.validateAll({ rp: p, rn: n }, S, { rp: zero(p) })
    if (Object.keys(bad).length) { document.getElementById(bad.rp ? 'rp' : 'rn')?.focus(); return }
    setBusy(true); try { await onSave({ our_price: Number(p), note: n.trim() || undefined }) } finally { setBusy(false) }
  }
  return <Modal title="Log negotiation round" width={440} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || !(Number(p) > 0)} onClick={submit}>Log round</button></>}>
    <div className="fg">
      <div className="f1"><label htmlFor="rp">Our revised price (₹, excl. GST)</label><input id="rp" {...a('rp', p)} type="number" min={1} value={p} onChange={e => { setP(e.target.value); chk('rp', e.target.value) }} /><FieldError id="rp" msg={er.rp} /></div>
      <div className="f1"><label htmlFor="rn">Note</label><textarea id="rn" {...a('rn', n)} rows={3} value={n} onChange={e => { setN(e.target.value); chk('rn', e.target.value) }} placeholder="What the customer asked for, what was agreed" /><FieldError id="rn" msg={er.rn} /></div>
    </div>
  </Modal>
}

/* ───────────────────────── PO & Consignee ───────────────────────── */

// PATCH /bids/{id} limits: PO number ≤ 50, delivery period ≤ 200, LD ≤ 300, PO value ≥ 0
const PO_SPEC: Record<string, FieldSpec> = { po_no: { label: 'PO number', rule: 'text', max: 50 }, po_date: { label: 'PO date', rule: 'date' }, po_value: { label: 'PO value', rule: 'amount' },
  deliv: { label: 'Delivery period', rule: 'text', max: 200 }, ld: { label: 'Liquidated damages', rule: 'text', max: 300 } }
function PoConsignee({ d, ed, save, run, navigate }: { d: Detail; ed: boolean; save: SaveFn; run: RunFn; navigate: (p: string) => void }) {
  const po = d.po
  const [add, setAdd] = useState(false)
  const F: [string, string, string, string | number | null][] = [['po_no', 'PO number', 'text', po.no], ['po_date', 'PO date', 'date', po.date], ['po_value', 'PO value (₹)', 'number', po.value],
    ['deliv', 'Delivery period', 'text', po.deliv], ['ld', 'Liquidated damages', 'text', po.ld]]
  return <div className="g g2">
    <Panel title="Purchase order">
      <div className="fg">{F.map(([k, l, ty, v]) => <div key={k}><label>{l}</label><SaveInput type={ty} min={ty === 'number' ? 0 : undefined} value={v ?? ''} disabled={!ed} ariaLabel={l} spec={PO_SPEC[k]}
        onSave={nv => save({ [k]: ty === 'number' ? numOrNull(nv) : nv || null })} /></div>)}
        <div><label>Acknowledged</label><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={po.ack} disabled={!ed} onChange={e => void save({ ack: e.target.checked }).catch(() => undefined)} /> PO acknowledged to customer</label></div>
      </div>
      {po.wo ? <div className="note mt"><Ic n="check" /> Work order <a onClick={() => navigate(`/workorders?number=${encodeURIComponent(po.wo!)}`)}><b>{po.wo}</b></a> was created from this tender.</div>
        : po.won ? (d.can.workorders && ed ? <button type="button" className="btn p mt" onClick={() => void run(async () => { const r = await bidApi.workOrder(d.id); return r }, 'Work order created', 'Could not create the work order')}>Create work order</button>
          : <div className="note mt">You need permission to create work orders.</div>)
          : <div className="note mt">PO details are enabled once the tender reaches the <b>{d.stages.find(s => s.kind === 'won')?.name || 'Won'}</b> stage; you can still pre-fill them.</div>}
    </Panel>
    <Panel title="Consignee details" z>
      {po.consignees.length ? <table className="t"><thead><tr><th>Consignee</th><th>Location</th><th>Qty share</th><th>Contact</th><th>Delivery by</th><th>Action</th></tr></thead>
        <tbody>{po.consignees.map(c => <tr key={c.id}><td>{c.name}</td><td>{c.loc || '—'}</td><td>{c.qty || '—'}</td><td>{c.contact || '—'}</td><td>{c.del ? fd(c.del) : '—'}</td>
          <td>{ed && <button type="button" className="btn g s" aria-label={`Delete ${c.name}`} onClick={() => void run(() => bidApi.delConsignee(d.id, c.id), 'Consignee removed')}><Ic n="x" /></button>}</td></tr>)}</tbody></table>
        : <div className="empty">No consignees yet.</div>}
      {ed && <div style={{ padding: 8 }}><button type="button" className="btn s" onClick={() => setAdd(true)}><Ic n="plus" /> Add consignee</button></div>}
    </Panel>
    {add && <ConsModal onClose={() => setAdd(false)} onSave={async b => { const r = await run(() => bidApi.consignee(d.id, b), 'Consignee added', 'Could not add the consignee'); if (r) setAdd(false) }} />}
  </div>
}

function ConsModal({ onClose, onSave }: { onClose: () => void; onSave: (b: { name: string; location_id: number | null; qty: string; contact: string; delivery: string | null }) => Promise<void> }) {
  const [v, setV] = useState({ name: '', qty: '', contact: '', delivery: '' })
  const [loc, setLoc] = useState<Opt | null>(null)
  const [q, setQ] = useState('')
  const locations = useMaster(() => bidApi.locations(q), [q])
  const [busy, setBusy] = useState(false)
  type K = keyof typeof v
  const fe = useFieldErrors(), er = fe.errors
  const S: Record<K, FieldSpec> = { name: { label: 'Consignee name', rule: 'text', required: true, max: 255 }, qty: { label: 'Qty share', rule: 'text', max: 20 },
    contact: { label: 'Contact', rule: 'text', max: 255 }, delivery: { label: 'Delivery date', rule: 'date' } }
  // backend: "25", "25%" or "12.5%" – a share between 0 and 100
  const qtyChk = (x: string) => { const m = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$/.exec(x); return !x.trim() ? '' : !m || !(Number(m[1]) > 0 && Number(m[1]) <= 100) ? 'Qty share must be a percentage between 0 and 100 (e.g. 25%).' : '' }
  const chk = (k: K, x: string, blur = false) => { if (blur) fe.blur(k, x, S[k]); else fe.change(k, x, S[k]); if (k === 'qty' && !validate(x, S.qty) && qtyChk(x)) fe.setError(k, qtyChk(x)) }
  const put = (k: K, x: string) => { setV(s => ({ ...s, [k]: x })); chk(k, x) }
  const a = (k: K) => ({ id: `cs-${k === 'delivery' ? 'del' : k}`, className: `in ${er[k] ? 'err' : ''}`, onBlur: () => chk(k, v[k], true), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `cs-${k}-err` : undefined })
  return <Modal title="Add consignee" width={460} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      const bad = fe.validateAll(v, S, { qty: qtyChk(v.qty) })
      if (Object.keys(bad).length) { const k = (['name', 'qty', 'contact', 'delivery'] as K[]).find(x => bad[x]); if (k) document.getElementById(a(k).id)?.focus(); return }
      setBusy(true); try { await onSave({ name: v.name.trim(), location_id: loc?.id ?? null, qty: v.qty.trim(), contact: v.contact.trim(), delivery: v.delivery || null }) } finally { setBusy(false) }
    }}>Add</button></>}>
    <div className="fg" id="cf">
      <div className="f1"><label htmlFor="cs-name">Consignee name</label><input {...a('name')} maxLength={255} value={v.name} onChange={e => put('name', e.target.value)} /><FieldError id="cs-name" msg={er.name} /></div>
      <div><label htmlFor="cs-loc">Location</label><Lookup id="cs-loc" value={loc?.id ?? null} label={loc?.name} items={locations.items} error={locations.error} onRetry={locations.reload} onSearch={setQ}
        emptyText="No matching location in Masters" onChange={setLoc} placeholder="Select location…" /></div>
      <div><label htmlFor="cs-qty">Qty share</label><input {...a('qty')} placeholder="e.g. 25%" value={v.qty} onChange={e => put('qty', e.target.value)} /><FieldError id="cs-qty" msg={er.qty} /></div>
      <div><label htmlFor="cs-contact">Contact</label><input {...a('contact')} maxLength={255} value={v.contact} onChange={e => put('contact', e.target.value)} /><FieldError id="cs-contact" msg={er.contact} /></div>
      <div><label htmlFor="cs-del">Delivery by</label><input {...a('delivery')} type="date" value={v.delivery} onChange={e => put('delivery', e.target.value)} /><FieldError id="cs-delivery" msg={er.delivery} /></div>
    </div>
  </Modal>
}

/* ───────────────────────── Journey + documents ───────────────────────── */

// prototype journey (.jy): "Journey · started N d ago · value · tender-led", then Lead · Deal · Tender / bid (this record) · Work
// order cards; missing steps say "not started" (a deal the tender skipped: "skipped – converted directly").
const JICO: Record<string, string> = { lead: 'funnel', deal: 'target', tender: 'file', order: 'brief' }
function Journey({ d, onTimeline, navigate }: { d: Detail; onTimeline: () => void; navigate: (p: string) => void }) {
  const age = d.created ? Math.max(0, Math.round((Date.now() - new Date(`${d.created}T00:00:00`).getTime()) / 864e5)) : null
  return <div className="jy">
    <div className="jy-h"><Ic n="doc" /> <b>Journey</b> <small className="mu">{age != null ? `started ${age} d ago · ` : ''}{inr(d.value)} · tender-led</small>
      <span className="fl" /><a onClick={onTimeline}>Full timeline</a></div>
    <div className="jy-r">{d.journey.steps.map(j => <div key={j.k} className={`jy-s ${j.done ? 'done' : ''} ${j.me ? 'cur' : ''}`}
      role={j.route ? 'button' : undefined} tabIndex={j.route ? 0 : undefined} onClick={() => j.route && navigate(j.route)} onKeyDown={e => { if (e.key === 'Enter' && j.route) navigate(j.route) }}>
      <span className="jy-n"><Ic n={JICO[j.k] || 'doc'} /></span>
      <b>{j.label}</b>
      {j.done ? <small>{j.ref}</small> : <small className="mu">{j.note || 'not started'}</small>}
      {j.done && j.stage && <Pill s={j.stage} t={j.me ? stagePill(j.stage, d.stage.kind) : undefined} />}
      {j.done && j.value != null && <span className="jv">{inr(j.value)}</span>}
      {j.done && j.date && <span className="jd"><Ic n="cal" size={12} /> {fd(j.date)}</span>}
    </div>)}</div>
  </div>
}

function DocsModal({ d, onClose, navigate }: { d: Detail; onClose: () => void; navigate: (p: string) => void }) {
  const { success, error } = useToast()
  const [r, setR] = useState<{ items: Doc[]; allowed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => bidApi.documents(d.id).then(setR).catch(e => { error(errMsg(e, 'Could not load documents')); setR({ items: [], allowed: false }) }), [d.id, error])
  useEffect(() => { void load() }, [load])
  const rows = useMemo(() => r?.items || [], [r])
  return <Modal title={`Documents · ${d.ref}`} width={640} onClose={onClose} foot={<>
    <button type="button" className="btn" onClick={() => navigate('/document-management')}><Ic n="folder" /> Open Document Hub</button><span className="fl" />
    {d.can.documents && <label className={`btn p ${busy ? 'dis' : ''}`} style={{ cursor: 'pointer' }}><Ic n="up" /> {busy ? 'Uploading…' : 'Upload'}
      <input type="file" hidden disabled={busy} onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true)
        try { await bidApi.upload(d.id, f); success('Uploaded to the Document Hub'); await load() } catch (x) { error(errMsg(x, 'Upload failed')) } finally { setBusy(false) } }} /></label>}
    <button type="button" className="btn" onClick={onClose}>Close</button></>}>
    {!r ? <div className="empty">Loading…</div> : !r.allowed ? <div className="empty">You do not have access to the Document Hub.</div>
      : rows.length ? <table className="t"><thead><tr><th>File</th><th>Folder</th><th>Updated</th></tr></thead>
        <tbody>{rows.map(x => <tr key={x.id}><td><a href={x.url} target="_blank" rel="noreferrer"><Ic n="file" size={13} /> {x.name}</a></td><td>{x.folder}</td><td>{x.updated_at ? fd(x.updated_at) : '—'}</td></tr>)}</tbody></table>
        : <div className="empty">No documents linked to this tender yet.</div>}
  </Modal>
}
