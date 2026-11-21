// Quote page – prototype v17 quotePage(): crumb "Quotations / <Quote no.>" · subject · Edit header · Preview PDF · Save as
// new revision · Send for approval | Create work order (Accepted), summary row (customer · company · enquiry · stage ·
// valid till · owner), lifecycle stepper, Journey, then Revisions (left) and the selected revision: line items
// # | Description | Qty | Rate (₹) | Disc % | Amount [| Δ vs prev] with Add line / From catalog, Sub-total · GST · total
// and % change vs the previous revision, Revision note and Commercial terms. Older revisions are read-only.
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import { DueCell } from '@/pages/deals/kit'
import { useQuoteStage } from './useQuoteStage'
import JourneyTimeline from './JourneyTimeline'
import { openWorkOrder } from './workOrder'
import { buildQuotePdf } from './quotePdf'
import { errDetail, errMsg, fd, inr, lineAmount, num, quoteApi, stagePill, todayIso, type Detail, type Line, type CatalogMeta, type PdfData, type Product, type Revision } from './quoteApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { validate, type FieldSpec } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/tenders/tenders.css'
import './quotes.css'

const JICO: Record<string, string> = { lead: 'funnel', deal: 'target', tender: 'file', quote: 'doc', order: 'brief' }

export default function QuotePage() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [lost, setLost] = useState<{ required: boolean; reasons: string[] } | null>(null)
  const [sel, setSel] = useState<number | null>(null)          // selected revision index (null = latest)
  const [cmp, setCmp] = useState(false)
  const [preview, setPreview] = useState(false)
  const [cat, setCat] = useState(false)
  const [terms, setTerms] = useState(false)
  const [timeline, setTimeline] = useState(false)
  const [logAct, setLogAct] = useState(false)
  const [busy, setBusy] = useState('')

  const load = useCallback(() => quoteApi.get(id).then(x => { setD(x); setLoadErr('') }).catch(e => setLoadErr(errMsg(e, 'Could not open this quote'))), [id])
  useEffect(() => { setD(null); setSel(null); setCmp(false); void load() }, [load])
  useEffect(() => { quoteApi.meta().then(m => setLost(m.lost)).catch(() => setLost({ required: false, reasons: [] })) }, [])
  const { move, sendForApproval, ui } = useQuoteStage(lost, !!d?.can.update, () => { void load() })

  const run = useCallback(async (key: string, fn: () => Promise<unknown>, ok?: string, fail = 'Could not save') => {
    setBusy(key)
    try { const r = await fn(); if (ok) success(ok); await load(); return r } catch (e) { error(errMsg(e, fail)); await load(); return undefined } finally { setBusy('') }
  }, [load, success, error])

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/quotations')}>Quotations</a></div><div className="panel"><div className="empty">{loadErr} · <a onClick={() => void load()}>Retry</a></div></div></div>
  if (!d) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/quotations')}>Quotations</a> / …</div><div className="empty">Loading…</div></div>

  const revs = d.revisions
  const cur = revs.length - 1
  const si = sel == null || sel > cur ? cur : sel
  const rv = revs[si]
  const lock = si !== cur
  const canEdit = d.can.update && !lock && d.editable
  const prev = si > 0 ? revs[si - 1] : null
  const won = d.stage.kind === 'won'
  const ci = d.stages.findIndex(s => s.id === d.stage.id)
  const target = (s: Detail['stages'][number]) => void move({ id: d.id, name: d.subject, stages: d.stages, currentId: d.stage.id }, s)
  const rates = [...new Set(rv.lines.map(l => l.tax))]
  const gstLabel = rates.length === 1 ? `GST ${rates[0]}%` : 'GST'

  const newRevision = () => run('rev', async () => {
    const r = await quoteApi.newRevision(d.id)
    setSel(null); setCmp(true)
    success(r.message)
  }, undefined, 'Could not create the revision')
  const workOrder = async () => {
    if (d.work_order) { await openWorkOrder(navigate, d.work_order.id); return }
    setBusy('wo')
    try { const r = await quoteApi.workOrder(d.id); success(r.message); await openWorkOrder(navigate, r.id) }
    catch (e) { const x = errDetail(e); error(errMsg(e, 'Could not create the work order')); if (x.work_order_id) void load() }
    finally { setBusy('') }
  }

  return (
    <div className="bwi qpage">
      <div className="crumb"><a onClick={() => navigate('/quotations')}>Quotations</a> / {d.ref}</div>
      <div className="pg">
        <h1>{d.subject}</h1><span className="fl" />
        {d.can.update && <button type="button" className="btn" onClick={() => navigate(`/quotations/${d.id}/edit`)}><Ic n="edit" /> Edit header</button>}
        <button type="button" className="btn" onClick={() => setPreview(true)}><Ic n="doc" /> Preview PDF</button>
        {d.can.update && <button type="button" className="btn" disabled={busy === 'rev' || !!d.pending || !!d.work_order} title={d.pending ? 'Waiting for approval' : d.work_order ? 'A work order exists' : ''}
          onClick={newRevision}><Ic n="copy" /> Save as new revision</button>}
        {won
          ? (d.can.update || d.work_order) && <button type="button" className="btn p" disabled={busy === 'wo'} onClick={workOrder}>{d.work_order ? `Open work order ${d.work_order.number}` : 'Create work order'}</button>
          : d.can.update && <button type="button" className="btn p" disabled={!d.can_send} title={d.pending ? 'Already waiting for approval' : !d.can_send ? `The quote is already past ${d.send_target || 'the approval stage'}` : `Move to ${d.send_target}`}
            onClick={() => void sendForApproval({ id: d.id, name: d.subject, stages: d.stages, currentId: d.stage.id }, d.send_target || '')}>Send for approval</button>}
      </div>
      <div className="row wrap mb qsum">
        <span>{d.customer || '—'}</span>
        {d.company && <span className="pill ac">{d.company}</span>}
        <span>Enquiry {d.enquiry || '—'}</span>
        <span><Pill s={d.stage.name} t={stagePill(d.stage.name, d.stage.kind)} /></span>
        <span>Valid till <DueCell d={d.valid_till} /></span>
        <span className="row" style={{ gap: 5 }}>{d.owner ? <><Av name={d.owner} />{d.owner}</> : <span className="mu">No owner</span>}</span>
      </div>
      <Hero d={d} onLog={() => setLogAct(true)} navigate={navigate} />
      <div className="path" role="list" aria-label="Quote lifecycle">{d.stages.map((s, i) => {
        const cls = s.id === d.stage.id ? (s.kind === 'won' ? 'won' : s.kind === 'lost' ? 'lost' : 'cur') : i < ci && s.kind === 'open' ? 'done' : ''
        return <button type="button" role="listitem" key={s.id} className={`s ${cls} ${d.pending?.stage === s.name ? 'hold' : ''}`} disabled={!d.can.update || !!d.pending || !!d.work_order}
          title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`} onClick={() => target(s)}>{s.name}</button>
      })}</div>
      {d.pending && <div className="note mb">Awaiting approval to move to <b>{d.pending.stage}</b>. <a onClick={() => navigate('/approvals')}>View approval</a></div>}
      {d.lost && <div className="note bad mb">Marked <b>{d.stage.name}</b>{d.lost.reason ? <> · Reason: <b>{d.lost.reason}</b></> : null}{d.lost.note ? <> – {d.lost.note}</> : null}</div>}
      <Journey d={d} onTimeline={() => setTimeline(true)} navigate={navigate} />

      <div className="split">
        <div className="panel"><div className="ph">Revisions<span className="fl" /><small>{revs.length} total</small></div>
          <div className="side">{revs.slice().reverse().map(r => <div key={r.id} className={r.n === si ? 'on' : ''} role="button" tabIndex={0}
            onClick={() => setSel(r.n)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(r.n) } }}>
            <div className="fl"><b>Rev {r.n}</b> {r.latest && <Pill s="Latest" t="ok" />}<br />
              <small>{fd(r.date)} · {r.by || '—'}</small><br /><small>{inr(r.total)} incl. GST</small></div></div>)}</div>
        </div>
        <div className="g">
          <div className="panel">
            <div className="ph">Revision {si}{lock && <> <span className="pill mu">Locked – older revision</span></>}<span className="fl" />
              {si > 0 && <button type="button" className="btn s" onClick={() => setCmp(c => !c)}>{cmp ? 'Hide' : `Compare with Rev ${si - 1}`}</button>}</div>
            <LineTable d={d} rv={rv} prev={cmp ? prev : null} edit={canEdit} onSave={async (lineId, body) => { const r = await run(`l${lineId}`, () => quoteApi.editLine(d.id, rv.id, lineId, body), undefined, 'Could not save the line') as { warnings?: string[] } | undefined; r?.warnings?.forEach(w => warning(w)); return r }}
              onDelete={l => run(`d${l.id}`, () => quoteApi.deleteLine(d.id, rv.id, l.id), `${l.description} removed`, 'Could not remove the line')} />
            <div className="row wrap qfoot">
              <button type="button" className="btn s" disabled={!canEdit || busy === 'add'} onClick={() => run('add', () => quoteApi.addLine(d.id, rv.id, {}), undefined, 'Could not add a line')}><Ic n="plus" /> Add line</button>
              <button type="button" className="btn s" disabled={!canEdit} onClick={() => setCat(true)}><Ic n="tag" /> From catalog</button>
              <span className="fl" />
              <div className="r">
                <div className="mu">Sub-total {inr(rv.sub)} · {gstLabel} {inr(rv.gst)}</div>
                <div className="qtot"><b>{inr(rv.total)}</b>{prev && prev.total > 0 && <> <small className={rv.total < prev.total ? 'tok' : 'tbad'}>{((rv.total / prev.total - 1) * 100).toFixed(1)}% vs Rev {si - 1}</small></>}</div>
              </div>
            </div>
            {!lock && !d.editable && d.edit_block && <div className="qlock"><Ic n="lock" size={12} /> {d.edit_block}</div>}
            {!lock && d.editable && d.config.gst_percent == null && <div className="qlock">Default GST % is not configured in Settings → Quotes – new lines start at 0% GST.</div>}
          </div>
          <div className="g g2">
            <div className="panel"><div className="ph">Revision note</div><div className="pb">
              <NoteBox key={rv.id} value={rv.note} disabled={lock || !canEdit} onSave={v => run('note', () => quoteApi.note(d.id, rv.id, v), 'Note saved', 'Could not save the note')} />
              <small className="mu">Rev {rv.n} · {rv.by || '—'} · {fd(rv.date)}</small>
            </div></div>
            <div className="panel"><div className="ph">Commercial terms<span className="fl" />{d.can.update && !d.pending && !d.work_order && <a onClick={() => setTerms(true)}>Edit</a>}</div><div className="pb">
              <div className="kv one">
                <div><span>Payment</span><span>{d.terms.payment || <span className="mu">Not configured</span>}</span></div>
                <div><span>Delivery</span><span>{d.terms.delivery || <span className="mu">Not configured</span>}</span></div>
                <div><span>Validity</span><span>{fd(d.valid_till)}</span></div>
                <div><span>Warranty</span><span>{d.terms.warranty || <span className="mu">Not configured</span>}</span></div>
              </div>
              {d.custom.length > 0 && <div className="kv one mt">{d.custom.map(([k, v]) => <div key={k}><span>{k}</span><span>{v === true ? 'Yes' : v === false ? 'No' : String(v ?? '—')}</span></div>)}</div>}
            </div></div>
          </div>
        </div>
      </div>

      {preview && <PreviewModal d={d} rv={rv} onClose={() => setPreview(false)} onStored={() => void load()} />}
      {cat && <CatalogModal onClose={() => setCat(false)} onAdd={async (p, bookId) => {
        const ok = await run('cat', () => quoteApi.addLine(d.id, rv.id, { product_id: p.id, price_book_id: bookId }), `${p.name} added`, 'Could not add the product') as { warnings?: string[] } | undefined
        ok?.warnings?.forEach(w => warning(w))
        if (ok !== undefined) setCat(false)
      }} />}
      {terms && <TermsModal d={d} onClose={() => setTerms(false)} onSave={async t => { const ok = await run('terms', () => quoteApi.terms(d.id, t), 'Commercial terms saved'); if (ok !== undefined) setTerms(false) }} />}
      {timeline && <JourneyTimeline d={d} onClose={() => setTimeline(false)} navigate={navigate} />}
      {logAct && <LogActivityModal d={d} onClose={() => setLogAct(false)} onDone={() => { setLogAct(false); success('Activity logged'); void load() }} />}
      {ui}
      {busy && <span className="sr-only" aria-live="polite">Saving…</span>}
    </div>
  )
}

/* ───────────────────────── value header & journey ───────────────────────── */

// prototype recHero('quotes'): Quote total · Revision · Valid till · Customer · Owner, stage progress of the lifecycle,
// Log activity, signal chips (customer health, validity ending, approval pending) and the customer's 360 link.
function Hero({ d, onLog, navigate }: { d: Detail; onLog: () => void; navigate: (p: string) => void }) {
  const h = d.hero
  const due = h.valid_in == null ? null : h.valid_in < 0 ? <span className="tbad">{-h.valid_in} d overdue</span> : h.valid_in === 0 ? <span className="twarn">today</span>
    : <span className={h.valid_in <= 3 ? 'twarn' : ''}>in {h.valid_in} d</span>
  const T = ({ l, v, s }: { l: string; v: ReactNode; s?: ReactNode }) => <div className="rht"><label>{l}</label><b>{v}</b>{s ? <small>{s}</small> : null}</div>
  return <div className="rhero">
    <div className="rhg">
      <T l="Quote total" v={inr(h.total)} />
      <T l="Revision" v={`Rev ${h.rev}`} s={`${h.versions} versions`} />
      <T l="Valid till" v={h.valid_till ? fd(h.valid_till) : '—'} s={due} />
      <T l="Customer" v={(h.customer || '').slice(0, 22) || '—'} />
      <T l="Owner" v={h.owner || '—'} />
    </div>
    <div className="rhrow">
      <div className="fl"><div className="rhp"><div className={`rhpb ${h.kind === 'won' ? 'won' : h.kind === 'lost' ? 'lost' : ''}`} style={{ width: `${h.pct}%` }} /></div>
        <small className="mu">{h.kind === 'won' ? 'Closed won' : h.kind === 'lost' ? 'Closed lost' : `Stage ${h.stage_no} of ${h.stages_of}`} · {h.flow}</small></div>
      <button type="button" className="btn s" onClick={onLog}><Ic n="pin" /> Log activity</button>
    </div>
    {(h.signals.length > 0 || d.customer_id) && <div className="rhsig">
      {h.signals.map((x, i) => <span key={i} className={`sg ${x.t}`}>{x.s}</span>)}
      {d.customer_id && <a className="sg lnk2" onClick={() => navigate(`/customers/${d.customer_id}`)}><Ic n="building" size={12} /> {(d.customer || '').slice(0, 28)} · 360 →</a>}
    </div>}
  </div>
}

// prototype journeyHTML() redesign: Lead · Deal · Quotation (· Tender) · Work order cards – done ✓ / current / skipped /
// not started, id, stage pill and value; header "started N d ago · ₹ · quote-led" and Full timeline →.
const JLBL: Record<string, string> = { lead: 'Lead', deal: 'Deal', tender: 'Tender / bid', quote: 'Quotation', order: 'Work order' }
const WON = /^(Won|Converted|Accepted|Closed)$/, LOST = /^(Lost|Disqualified|Rejected)$/
function Journey({ d, onTimeline, navigate }: { d: Detail; onTimeline: () => void; navigate: (p: string) => void }) {
  const st = d.journey.steps
  let last = -1
  st.forEach((s, i) => { if (s.done) last = i })
  const items = st.filter(s => s.done)
  const dates = items.map(s => s.date).filter(Boolean).sort() as string[]
  const ago = dates[0] ? Math.max(0, Math.round((Date.now() - new Date(`${dates[0].slice(0, 10)}T00:00:00`).getTime()) / 864e5)) : null
  const tot = Math.max(0, ...items.map(s => s.value || 0))
  const jid = st.some(s => (s.k === 'lead' || s.k === 'deal') && s.done) ? d.journey.id : null
  return <div className="jy">
    <div className="jy-h"><span className="jy-t"><Ic n="flow" /> Journey {jid && <span className="pill ac">{jid}</span>}</span>
      <span className="jy-m">{ago != null ? `started ${ago} d ago` : ''}{tot ? ` · ${inr(tot)}` : ''} · quote-led</span><span className="fl" />
      {(jid || items.length > 1) && <a onClick={onTimeline}>Full timeline →</a>}</div>
    <div className="jy-r" style={{ gridTemplateColumns: `repeat(${st.length}, minmax(0, 1fr))` }}>{st.map((s, i) => {
      const x = s.done, cur = !!s.me, skip = !x && s.k === 'deal' && last > i, lost = x && LOST.test(s.stage || ''), won = x && WON.test(s.stage || '')
      const cls = cur ? (lost ? 'cur lost' : won ? 'cur won' : i === last ? 'cur now' : 'cur') : lost ? 'lost' : skip ? 'skip' : x ? (won ? 'won' : i < last ? 'done' : 'act now') : 'todo'
      const go = x && !cur && !!s.route
      return <div key={s.k} className={`jy-s ${cls} ${go ? 'go' : ''}`} role={go ? 'button' : undefined} tabIndex={go ? 0 : undefined}
        onClick={() => { if (go) navigate(s.route!) }} onKeyDown={e => { if (e.key === 'Enter' && go) navigate(s.route!) }}>
        <div className="jy-n"><Ic n={cls === 'done' ? 'check' : cls === 'lost' ? 'x' : JICO[s.k] || 'doc'} /></div>
        <div className="jy-l">{JLBL[s.k] || s.label}</div>
        {won && i === last ? <div className="jy-now ok">✓ won</div> : lost ? <div className="jy-now ba">✕ lost</div> : null}
        {x ? <><div className="jy-i">{s.ref}</div><div className="jy-p"><Pill s={s.stage || 'Active'} t={cur ? stagePill(s.stage || '', d.stage.kind) : undefined} /></div><div className="jy-v">{inr(s.value || 0)}</div></>
          : <div className="jy-i mu">{skip ? 'skipped – converted directly' : 'not started'}</div>}
      </div>
    })}</div>
  </div>
}

function LogActivityModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [kmeta, setKmeta] = useState<{ activity_types: string[]; statuses: string[] } | null>(null)
  const [metaErr, setMetaErr] = useState('')
  const [f, setF] = useState({ type: '', subject: '', date: todayIso(), status: '', outcome: '', description: '' })
  const [busy, setBusy] = useState(false)
  const loadMeta = useCallback(() => {
    setMetaErr('')
    api.get('/kam/meta').then(r => { setKmeta(r.data); setF(s => ({ ...s, type: s.type || r.data.activity_types?.[0] || '', status: s.status || r.data.statuses?.[0] || '' })) })
      .catch(e => setMetaErr(errMsg(e, 'Could not load activity types')))
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])
  const needOutcome = f.status === 'Completed', needDesc = f.status === 'Postponed' || f.status === 'Cancelled'
  const ok = f.type && f.subject.trim() && f.date && (!needOutcome || f.outcome.trim()) && (!needDesc || f.description.trim())
  const fe = useFieldErrors(), er = fe.errors
  type LK = 'subject' | 'date' | 'outcome' | 'description'
  const LS: Record<LK, FieldSpec> = { subject: { label: 'Subject', rule: 'text', required: true, min: 2, max: 255 }, date: { label: 'Date', rule: 'date', required: true },
    outcome: { label: 'Outcome', rule: 'text', required: needOutcome, max: 1000 }, description: { label: needDesc ? 'Reason' : 'Notes', rule: 'textarea', required: needDesc, max: 5000 } }
  const la = (k: LK, id: string) => ({ className: `in ${er[k] ? 'err' : ''}`, onBlur: () => fe.blur(k, f[k], LS[k]), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `${id}-err` : undefined })
  const lset = (k: LK, x: string) => { setF({ ...f, [k]: x }); fe.change(k, x, LS[k]) }
  return <Modal title="Log activity" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!ok || busy} onClick={async () => {
      const bad = fe.validateAll(f, { subject: LS.subject, date: LS.date, outcome: needOutcome ? LS.outcome : undefined, description: LS.description })
      if (Object.keys(bad).length) { const id = { subject: 'qla-sub', date: 'qla-d', outcome: 'qla-o', description: 'qla-n' }[(['subject', 'date', 'outcome', 'description'] as LK[]).find(k => bad[k])!]; document.getElementById(id)?.focus(); return }
      setBusy(true)
      try {
        await api.post('/kam/activities', { activity_type: f.type, customer_id: d.customer_id, lead_id: d.lead_id, tender_id: d.tender_id, subject: f.subject.trim(), activity_date: f.date,
          status: f.status, outcome: f.outcome.trim() || null, description: f.description.trim() || null, ...(f.status === 'Cancelled' ? { cancellation_reason: f.description.trim() } : {}) })
        onDone()
      } catch (e) { error(errMsg(e, 'Could not log the activity')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Log activity'}</button></>}>
    {metaErr ? <div className="note bad">{metaErr} · <a onClick={loadMeta}>Retry</a></div> : !kmeta ? <div className="empty">Loading…</div> :
      <div className="fg">
        <div><label htmlFor="qla-t">Type</label><select id="qla-t" className="in" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>{kmeta.activity_types.map(t => <option key={t}>{t}</option>)}</select></div>
        <div><label htmlFor="qla-s">Status</label><select id="qla-s" className="in" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{kmeta.statuses.map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="f1"><label htmlFor="qla-sub">Subject *</label><input id="qla-sub" {...la('subject', 'qla-sub')} value={f.subject} onChange={e => lset('subject', e.target.value)} placeholder={`Follow-up on ${d.ref}`} /><FieldError id="qla-sub" msg={er.subject} /></div>
        <div><label htmlFor="qla-d">Date *</label><input id="qla-d" {...la('date', 'qla-d')} type="date" value={f.date} onChange={e => lset('date', e.target.value)} /><FieldError id="qla-d" msg={er.date} /></div>
        {needOutcome && <div className="f1"><label htmlFor="qla-o">Outcome *</label><input id="qla-o" {...la('outcome', 'qla-o')} value={f.outcome} onChange={e => lset('outcome', e.target.value)} /><FieldError id="qla-o" msg={er.outcome} /></div>}
        <div className="f1"><label htmlFor="qla-n">{needDesc ? 'Reason *' : 'Notes'}</label><textarea id="qla-n" {...la('description', 'qla-n')} rows={3} value={f.description} onChange={e => lset('description', e.target.value)} /><FieldError id="qla-n" msg={er.description} /></div>
      </div>}
  </Modal>
}

/* ───────────────────────── line items ───────────────────────── */

type LineBody = Partial<Record<'description' | 'qty' | 'rate' | 'disc', string | number>>

function LineTable({ d, rv, prev, edit, onSave, onDelete }: { d: Detail; rv: Revision; prev: Revision | null; edit: boolean; onSave: (lineId: number, b: LineBody) => Promise<unknown>; onDelete: (l: Line) => void }) {
  return <div className="tw fit"><table className="t"><thead><tr>
    <th>#</th><th>Description</th><th className="r">Qty</th><th className="r">Rate (₹)</th><th className="r">Disc %</th><th className="r">Amount</th>{prev && <th className="r">Δ vs prev</th>}<th />
  </tr></thead><tbody>
    {rv.lines.map((l, i) => <LineRow key={l.id} i={i} l={l} pl={prev ? prev.lines[i] || null : undefined} edit={edit} maxDisc={d.config.max_discount} onSave={b => onSave(l.id, b)} onDelete={() => onDelete(l)} />)}
    {!rv.lines.length && <tr><td colSpan={prev ? 8 : 7} className="mu" style={{ textAlign: 'center', padding: 16 }}>{edit ? 'No line items yet – Add line or pick From catalog.' : 'No line items in this revision.'}</td></tr>}
  </tbody></table></div>
}

function LineRow({ i, l, pl, edit, maxDisc, onSave, onDelete }: { i: number; l: Line; pl: Line | null | undefined; edit: boolean; maxDisc: number | null; onSave: (b: LineBody) => Promise<unknown>; onDelete: () => void }) {
  const [v, setV] = useState({ description: l.description, qty: String(l.qty), rate: String(l.rate), disc: String(l.disc) })
  useEffect(() => { setV({ description: l.description, qty: String(l.qty), rate: String(l.rate), disc: String(l.disc) }); fe.clear() }, [l.description, l.qty, l.rate, l.disc]) // eslint-disable-line react-hooks/exhaustive-deps
  const am = useMemo(() => lineAmount(Number(v.qty) || 0, Number(v.rate) || 0, Number(v.disc) || 0), [v])
  const pa = pl ? pl.amount : 0
  // backend _validate_line: description required ≤ 500, qty > 0 (< 1e8), rate ≥ 0 (< 1e13), disc 0–100 and ≤ the configured maximum
  type K = keyof typeof v
  const fe = useFieldErrors(), er = fe.errors
  const LS: Record<K, FieldSpec> = { description: { label: 'Description', rule: 'text', required: true, max: 500 }, qty: { label: 'Qty', rule: 'amount', required: true, max: 99_999_999.99 },
    rate: { label: 'Rate', rule: 'amount', required: true, max: 9_999_999_999_999 }, disc: { label: 'Disc %', rule: 'percent' } }
  const xtra = (k: K, x: string) => k === 'qty' && x.trim() !== '' && Number(x) <= 0 ? 'Qty must be more than zero.'
    : k === 'disc' && maxDisc != null && x.trim() !== '' && Number(x) > maxDisc ? `Disc % cannot exceed ${maxDisc}% (Discount configuration).` : ''
  const chk = (k: K, x: string, blur = false) => {
    if (blur) fe.blur(k, x, LS[k]); else fe.change(k, x, LS[k])
    const m = validate(x, LS[k]) ? '' : xtra(k, x); if (m) fe.setError(k, m)
    return validate(x, LS[k]) || m
  }
  const commit = (k: K) => {
    const raw = v[k], old = k === 'description' ? l.description : String(l[k])
    if (raw === old) { fe.clear(k); return }
    if (chk(k, raw, true)) return                     // invalid – keep what was typed, don't save
    void onSave({ [k]: k === 'description' ? raw.trim() : raw })
  }
  const a = (k: K) => ({ 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `ql-${l.id}-${k}-err` : undefined })
  const inp = (k: 'qty' | 'rate' | 'disc', w: number, extra: { min?: number; max?: number } = {}) => {
    const style: CSSProperties = { width: w, textAlign: 'right' }
    return <><input className={`in sm ${er[k] ? 'err' : ''}`} type="number" step="any" style={style} value={v[k]} aria-label={`${k === 'qty' ? 'Qty' : k === 'rate' ? 'Rate' : 'Disc %'} line ${i + 1}`} {...extra} {...a(k)}
      onChange={e => { setV(s => ({ ...s, [k]: e.target.value })); chk(k, e.target.value) }} onBlur={() => commit(k)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      <FieldError id={`ql-${l.id}-${k}`} msg={er[k]} /></>
  }
  return <tr>
    <td>{i + 1}</td>
    <td>{edit ? <><input className={`in sm ${er.description ? 'err' : ''}`} style={{ minWidth: 230, width: '100%' }} value={v.description} maxLength={500} aria-label={`Description line ${i + 1}`} {...a('description')}
      onChange={e => { setV(s => ({ ...s, description: e.target.value })); chk('description', e.target.value) }} onBlur={() => commit('description')} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      <FieldError id={`ql-${l.id}-description`} msg={er.description} /></> : l.description}</td>
    <td className="r">{edit ? inp('qty', 60, { min: 0 }) : l.qty}</td>
    <td className="r">{edit ? inp('rate', 100, { min: 0 }) : l.rate}</td>
    <td className="r">{edit ? inp('disc', 60, { min: 0, max: maxDisc ?? 100 }) : l.disc}</td>
    <td className="r">{inr(edit ? am : l.amount)}</td>
    {pl !== undefined && <td className={`r ${pl && am < pa ? 'tok' : pl && am > pa ? 'tbad' : ''}`}>{pl ? (am - pa === 0 ? '—' : `${am > pa ? '+' : ''}${inr(am - pa)}`) : 'new'}</td>}
    <td>{edit && <button type="button" className="btn g s" aria-label={`Delete line ${i + 1}`} onClick={onDelete}><Ic n="x" /></button>}</td>
  </tr>
}

function NoteBox({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState(value)
  const fe = useFieldErrors(), msg = fe.errors.note
  const spec: FieldSpec = { label: 'Revision note', rule: 'textarea', max: 2000 }   // backend RevNoteIn max_length=2000
  useEffect(() => { setV(value); fe.clear() }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return <><textarea className={`in${msg ? ' err' : ''}`} rows={2} disabled={disabled} value={v} aria-label="Revision note" aria-invalid={msg ? true : undefined} aria-describedby={msg ? 'q-note-err' : undefined}
    onChange={e => { setV(e.target.value); fe.change('note', e.target.value, spec) }}
    onBlur={() => { if (v === value) { fe.clear(); return } fe.blur('note', v, spec); if (!validate(v, spec)) void onSave(v) }} /><FieldError id="q-note" msg={msg} /></>
}

/* ───────────────────────── modals ───────────────────────── */

// prototype v18 A.qcat: "Add from product catalogue" – approved products of the company's catalogue with the price of the
// chosen price book (override wins): Code | Product | Category | List price | Book price | Add
function CatalogModal({ onClose, onAdd }: { onClose: () => void; onAdd: (p: Product, bookId: number | null) => Promise<void> }) {
  const { error } = useToast()
  const [q, setQ] = useState('')
  const [book, setBook] = useState<number | null | undefined>(undefined)
  const [items, setItems] = useState<Product[] | null>(null)
  const [cm, setCm] = useState<CatalogMeta | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      quoteApi.catalog(q, book ?? null).then(r => { setItems(r.items); setCm(r); if (book === undefined) setBook(r.default_book) })
        .catch(e => { error(errMsg(e, 'Could not load the catalogue')); setItems([]) })
    }, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, book, error])
  return <Modal title="Add from product catalogue" width={760} onClose={onClose}>
    {cm && <div className="note inf mb">Showing {cm.approved_only ? `${cm.lock.toLowerCase()} products` : 'products'} from the {cm.model.toLowerCase()} catalogue. Prices come from the selected price book; discounts beyond {cm.disc_limit}% or below cost + {cm.min_margin}% are flagged{cm.disc_approval ? ' and need Sales Head approval' : ''}.</div>}
    <div className="row mb" style={{ gap: 8 }}>
      <input className="in" style={{ flex: 1 }} placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search products" />
      <select className="in" style={{ width: 260 }} aria-label="Price book" value={book ?? ''} onChange={e => setBook(e.target.value ? Number(e.target.value) : null)}>
        <option value="">List price (no price book)</option>{(cm?.books || []).map(b => <option key={b.id} value={b.id}>{b.name} · {b.adjustment > 0 ? '+' : ''}{b.adjustment}%{b.currency !== 'INR' ? ` · ${b.currency}` : ''}</option>)}</select>
    </div>
    {!items ? <div className="empty">Loading…</div> : !items.length ? <div className="empty">{cm?.approved_only ? `No ${cm.lock.toLowerCase()} products` : 'No active products'} in Product &amp; Price Books{q ? ' match your search' : ''}.</div> :
      <div className="tw fit" style={{ maxHeight: 420, overflow: 'auto' }}><table className="t"><thead><tr><th>Code</th><th>Product</th><th>Category</th><th className="r">List price</th><th className="r">Book price</th><th /></tr></thead><tbody>
        {items.map(p => <tr key={p.id}><td><b>{p.code || p.sku}</b></td><td>{p.name}</td><td>{p.category || '—'}</td>
          <td className="r">{p.list != null ? inr(p.list) : '—'}</td>
          <td className="r">{p.price != null ? <b>{inr(p.price)}</b> : '—'}{p.override && <> <span className="pill wa">override</span></>}
            {p.margin != null && cm && <><br /><small className={p.margin < cm.min_margin ? 'tbad' : 'mu'}>{p.margin}% margin</small></>}</td>
          <td><button type="button" className="btn s p" disabled={busy === p.id} onClick={async () => { setBusy(p.id); try { await onAdd(p, book ?? null) } finally { setBusy(null) } }}>Add</button></td></tr>)}
      </tbody></table></div>}
  </Modal>
}

function TermsModal({ d, onClose, onSave }: { d: Detail; onClose: () => void; onSave: (t: { payment: string | null; delivery: string | null; warranty: string | null }) => Promise<void> }) {
  const [t, setT] = useState({ payment: d.terms.custom.payment || '', delivery: d.terms.custom.delivery || '', warranty: d.terms.custom.warranty || '' })
  const [busy, setBusy] = useState(false)
  // backend TermsIn: each term ≤ 1000 characters
  const fe = useFieldErrors(), er = fe.errors
  const TS: Record<string, FieldSpec> = { payment: { label: 'Payment terms', rule: 'textarea', max: 1000 }, delivery: { label: 'Delivery terms', rule: 'textarea', max: 1000 }, warranty: { label: 'Warranty', rule: 'textarea', max: 1000 } }
  const row = (k: 'payment' | 'delivery' | 'warranty', label: string) => <div className="f1"><label htmlFor={`qt-${k}`}>{label}</label>
    <textarea id={`qt-${k}`} className={`in ${er[k] ? 'err' : ''}`} rows={2} value={t[k]} placeholder={d.terms.defaults[k] || 'Not configured in Settings → Quotes'} onChange={e => { setT(s => ({ ...s, [k]: e.target.value })); fe.change(k, e.target.value, TS[k]) }}
      onBlur={() => fe.blur(k, t[k], TS[k])} aria-invalid={er[k] ? true : undefined} aria-describedby={er[k] ? `qt-${k}-err` : undefined} />
    <FieldError id={`qt-${k}`} msg={er[k]} />{!er[k] && <small>{d.terms.defaults[k] ? 'Leave empty to use the default shown.' : 'No default configured.'}</small>}</div>
  return <Modal title="Commercial terms" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      const bad = fe.validateAll(t, TS)
      if (Object.keys(bad).length) { const k = ['payment', 'delivery', 'warranty'].find(x => bad[x]); if (k) document.getElementById(`qt-${k}`)?.focus(); return }
      setBusy(true); try { await onSave({ payment: t.payment.trim() || null, delivery: t.delivery.trim() || null, warranty: t.warranty.trim() || null }) } finally { setBusy(false) } }}>
      {busy ? 'Saving…' : 'Save'}</button></>}>
    <div className="fg">{row('payment', 'Payment')}{row('delivery', 'Delivery')}{row('warranty', 'Warranty')}
      <div className="f1"><small className="mu">Validity follows the quote's Valid till date ({fd(d.valid_till)}) – change it with Edit header.</small></div></div>
  </Modal>
}

// prototype A.qprint: "Quotation preview" – letterhead, Ref/Rev · Date, To, Subject (Enquiry), lines, total incl. GST,
// Yours faithfully + sender; Close · Generate PDF (stored in the Document Hub against the revision).
function PreviewModal({ d, rv, onClose, onStored }: { d: Detail; rv: Revision; onClose: () => void; onStored: () => void }) {
  const { success, error } = useToast()
  const [p, setP] = useState<PdfData | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { quoteApi.pdfData(d.id, rv.id).then(setP).catch(e => { error(errMsg(e, 'Could not load the preview')); onClose() }) }, [d.id, rv.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const generate = async () => {
    if (!p) return
    setBusy(true)
    try {
      const blob = await buildQuotePdf(p)
      const name = `${p.ref}-Rev${p.rev}.pdf`
      if (d.can.documents) { await quoteApi.uploadPdf(d.id, rv.id, blob, name); success('PDF generated and attached to the record'); onStored() }
      else success('PDF generated')
      const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000)
    } catch (e) { error(errMsg(e, 'Could not generate the PDF')) } finally { setBusy(false) }
  }
  return <Modal title="Quotation preview" width={720} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Close</button>
    <button type="button" className="btn p" disabled={!p || busy} onClick={generate}>{busy ? 'Generating…' : 'Generate PDF'}</button></>}>
    {!p ? <div className="empty">Loading…</div> : <div className="lt">
      <b style={{ fontSize: 16 }}>{p.company || '—'}</b><br /><small>{p.domain || ''}</small>
      <hr />
      <p>Ref: {p.ref}/Rev {p.rev} · Date: {fd(p.date)}</p>
      <p>To: <b>{p.customer || '—'}</b><br />Subject: {p.subject} (Enquiry {p.enquiry || '—'})</p>
      <table><tbody>
        {p.lines.map(l => <tr key={l.n}><td>{l.n}</td><td>{l.description}</td><td className="r">{l.qty}</td><td className="r">{num(l.rate)}</td><td className="r">{num(l.amount)}</td></tr>)}
      </tbody></table>
      <p style={{ textAlign: 'right' }}>Total incl. {/^GST (.+)$/.test(p.gst_label) ? `${p.gst_label.slice(4)} GST` : 'GST'}: <b>₹ {num(p.total)}</b></p>
      <p>Yours faithfully,<br />{p.sender.name || '—'}</p>
    </div>}
  </Modal>
}
