// Orders & Projects v18 · payment collection.
// PaymentsTab   – order drawer "Payments" (prototype pyTab): Order value · Due to date · Received · Awaiting finance ·
//                 Outstanding · Overdue tiles, received bar, Against / Plan / Change plan / Record payment, payment schedule
//                 (Stage | % | Amount | Due | Received | Awaiting finance | Balance | Status | Record) and receipts.
// CollectionsView – the "Collections & finance" segment (prototype pyCollections): KPI strip, Finance acknowledgement
//                 queue, Payment schedule · all orders, All receipts.
// Every figure comes from /api/v1/orders (payment stages, receipts, Finance acknowledgements) – nothing is kept locally.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Pill, Strip } from '@/pages/customers/kit'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster } from '@/pages/leads/leadApi'
import {
  PYC, PYR, addDays, daysBetween, dto, errMsg, fd, inr, orderApi, todayIso,
  type Against, type Collections, type Payments, type Receipt, type RcptHistory, type RcptRow, type SchedRow,
} from './orderApi'

const dtm = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

/** prototype dueCell(): date + "in n d" / "n d ago" (red when past) */
export function DueCell({ d, done }: { d: string | null; done?: boolean }) {
  if (!d) return <span className="mu">—</span>
  const n = dto(d)
  return <span className={!done && n < 0 ? 'tbad' : !done && n <= 15 ? 'twarn' : ''}>{fd(d)}<br /><small className="mu">{n < 0 ? `${-n} d ago` : n === 0 ? 'today' : `in ${n} d`}</small></span>
}

function AgainstRef({ a }: { a: Against | null }) {
  const navigate = useNavigate()
  if (!a) return <span className="mu">—</span>
  return a.kind === 'tender'
    ? <><a onClick={e => { e.stopPropagation(); navigate(`/tenders/${a.id}`) }}><b>{a.ref}</b></a>{a.title && <small className="mu"> {a.title.slice(0, 40)}</small>}</>
    : <>Quote <b>{a.ref}</b></>
}

// ─── order drawer → Payments ──────────────────────────────────────────────────

export function PaymentsTab({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [p, setP] = useState<Payments | null>(null)
  const [err, setErr] = useState('')
  const [rec, setRec] = useState<{ stage?: number; receipt?: Receipt } | null>(null)
  const [ack, setAck] = useState<Receipt | null>(null)
  const [plan, setPlan] = useState(false)
  const [hist, setHist] = useState<Receipt | null>(null)
  const load = useCallback(() => { setErr(''); orderApi.payments(id).then(setP).catch(e => { setP(null); setErr(errMsg(e, 'Could not load payments')) }) }, [id])
  useEffect(() => { load() }, [load])
  const changed = () => { load(); onChanged() }
  if (err) return <div className="dcard empty">{err} · <a onClick={load}>Retry</a></div>
  if (!p) return <div className="dcard empty">Loading…</div>
  const t = p.totals
  const T_ = (l: string, v: string, c = '') => <div><small>{l}</small><b className={c}>{v}</b></div>
  return <div className="dcard">
    <div className="py8-t">{T_('Order value', inr(t.value))}{T_('Due to date', inr(t.due))}{T_('Received', inr(t.received), 'tok')}
      {T_('Awaiting finance', inr(t.awaiting), t.awaiting ? 'twarn' : '')}{T_('Outstanding', inr(t.outstanding))}{T_('Overdue', inr(t.overdue), t.overdue ? 'tbad' : '')}</div>
    <div className="py8-bar"><span className="mbar8"><i style={{ width: `${Math.max(0, Math.min(100, t.received_pct))}%`, background: 'var(--bw-ok)' }} /></span>
      <small className="mu">{t.received_pct}% received · {t.with_awaiting_pct}% incl. awaiting finance</small></div>
    <div className="py8-ref"><span>Against: <AgainstRef a={p.against} /></span>
      <span>Plan: <b>{p.plan === 'Single' ? 'Single payment' : `Stage-wise · ${p.stages.length} stages`}</b></span><span className="fl" />
      {p.can.plan && <button type="button" className="btn s" onClick={() => setPlan(true)}><Ic n="edit" /> Change plan</button>}
      {p.can.record && <button type="button" className="btn s p" onClick={() => setRec({})}><Ic n="plus" /> Record payment</button>}</div>
    <h3 className="py8-h">Payment schedule</h3>
    <div className="tw fit"><table className="t"><thead><tr><th>Stage</th><th className="r">%</th><th className="r">Amount</th><th>Due</th><th className="r">Received</th>
      <th className="r">Awaiting finance</th><th className="r">Balance</th><th>Status</th><th /></tr></thead>
      <tbody>{p.stages.map(s => <tr key={s.id}>
        <td><b>{s.name}</b>{s.invoice_ref && <><br /><small className="mu">{s.invoice_ref}</small></>}</td><td className="r">{s.pct}%</td><td className="r">{inr(s.amount)}</td>
        <td><DueCell d={s.due} done={s.balance <= 0} /></td><td className="r tok">{s.received ? inr(s.received) : '—'}</td><td className="r">{s.awaiting ? inr(s.awaiting) : '—'}</td>
        <td className="r"><b>{s.balance ? inr(s.balance) : '—'}</b></td><td><Pill s={s.status} t={PYC[s.status]} /></td>
        <td>{s.balance > 0 && p.can.record ? <button type="button" className="btn s" onClick={() => setRec({ stage: s.id })}>Record</button> : null}</td></tr>)}</tbody></table></div>
    <h3 className="py8-h">Receipts <small className="mu">{p.receipts.length}</small></h3>
    {p.receipts.length ? <div className="tw fit"><table className="t"><thead><tr><th>Received</th><th>Stage</th><th className="r">Amount</th><th>Mode · reference</th><th>Collected by</th><th>Finance</th><th /></tr></thead>
      <tbody>{p.receipts.map(r => <tr key={r.id}>
        <td>{fd(r.date)}</td><td>{r.stage || '—'}</td>
        <td className="r"><b>{inr(r.amount)}</b>{r.original_amount != null && <><br /><small className="mu">recorded {inr(r.original_amount)}</small></>}</td>
        <td>{r.mode}<br /><small className="mu">{r.ref}</small></td>
        <td>{r.by ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.by} />{r.by}</span> : '—'}</td>
        <td><Pill s={r.status} t={PYR[r.status]} />{r.ack_at && <><br /><small className="mu">{r.ack_by} · {fd(r.ack_at)}</small></>}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {r.status === 'Pending finance' && p.can.finance && <button type="button" className="btn s p" onClick={() => setAck(r)}>Acknowledge</button>}
          {r.status !== 'Acknowledged' && p.can.record && <button type="button" className="btn s g" title={r.status === 'Not credited' ? 'Correct and send back to Finance' : 'Correct this receipt'} onClick={() => setRec({ receipt: r })}><Ic n="edit" /></button>}
          <button type="button" className="btn s g" title="History" aria-label="Receipt history" onClick={() => setHist(r)}><Ic n="clock" /></button></td></tr>)}</tbody></table></div>
      : <div className="empty">No payments recorded yet</div>}
    {rec && <RecordModal p={p} stageId={rec.stage} receipt={rec.receipt} onClose={() => setRec(null)} onDone={() => { setRec(null); changed() }} />}
    {ack && <AckModal woId={p.order.id} woRef={p.order.ref} customer={p.order.customer} r={ack} accounts={p.accounts} onClose={() => setAck(null)} onDone={() => { setAck(null); changed() }} />}
    {plan && <PlanModal p={p} onClose={() => setPlan(false)} onDone={() => { setPlan(false); changed() }} />}
    {hist && <HistoryModal woId={p.order.id} r={hist} onClose={() => setHist(null)} />}
  </div>
}

// ─── record / correct a receipt (prototype pyRec) ─────────────────────────────

function RecordModal({ p, stageId, receipt, onClose, onDone }: { p: Payments; stageId?: number; receipt?: Receipt; onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const users = useMaster(masters.users)
  const open = p.stages.filter(s => s.balance > 0)
  const s0 = p.stages.find(s => s.id === (receipt?.stage_id ?? stageId)) || open[0] || p.stages[0]
  const [f, setF] = useState({
    stage: String(s0?.id ?? ''), amount: receipt ? String(receipt.amount) : s0?.balance ? String(s0.balance) : '', date: receipt?.date || todayIso(),
    mode: receipt?.mode || (p.modes.includes('RTGS') ? 'RTGS' : p.modes[0]), ref: receipt?.ref || '', by: receipt?.by_id ?? p.order.collected_by ?? null as number | null, remarks: receipt?.remarks || '',
  })
  const [busy, setBusy] = useState(false)
  const vx = useModalValidation(f, () => ({ stage: { label: 'Against stage', rule: 'select', required: true }, amount: { label: 'Amount received', rule: 'amount', required: true },
    date: { label: 'Received on', rule: 'date', required: true }, mode: { label: 'Mode', rule: 'select', required: true },
    ref: { label: 'UTR / cheque / reference', rule: 'text', required: true, max: 120 }, remarks: { label: 'Remarks', rule: 'text', max: 500 } }),
  x => ({ amount: x.amount.trim() !== '' && Number(x.amount) <= 0 ? 'Amount must be more than 0.' : '', date: x.date > todayIso() ? 'The received date cannot be in the future.' : '' }),
  { stage: 'pr-s', amount: 'pr-a', date: 'pr-d', mode: 'pr-m', ref: 'pr-r', remarks: 'pr-x' })
  const upd = (q: Partial<typeof f>) => { const n = { ...f, ...q }; setF(n); vx.change(n, ...Object.keys(q)) }
  const st = p.stages.find(s => String(s.id) === f.stage)
  const bal = st ? st.balance + (receipt && receipt.stage_id === st.id && receipt.status !== 'Not credited' ? receipt.amount : 0) : 0
  const over = Number(f.amount) > bal && bal >= 0 && f.amount !== ''
  const save = async () => {
    if (!vx.submit()) return
    setBusy(true)
    const body = { stage_id: Number(f.stage), amount: Number(f.amount), received_on: f.date, mode: f.mode, reference: f.ref.trim(), collected_by: f.by, remarks: f.remarks.trim() || null }
    try {
      if (receipt) { const r = await orderApi.correctReceipt(p.order.id, receipt.id, body); success(!r.changed ? 'Nothing changed' : r.status === 'Pending finance' && receipt.status === 'Not credited' ? 'Receipt corrected – sent back to Finance' : 'Receipt corrected') }
      else { await orderApi.recordReceipt(p.order.id, body); success('Receipt saved – waiting for Finance acknowledgement') }
      onDone()
    } catch (e) { if (!vx.server(e, { stage_id: 'stage', received_on: 'date', reference: 'ref' })) error(errMsg(e, 'Could not save the receipt')) } finally { setBusy(false) }
  }
  return <Modal title={<><Ic n="wallet" /> {receipt ? 'Correct receipt' : 'Record payment'} · {p.order.ref}</>} width={580} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : receipt ? 'Save correction' : 'Save receipt'}</button></>}>
    <div className="note inf mb">{receipt
      ? receipt.status === 'Not credited' ? <>Finance could not find this payment{receipt.ack_remarks ? <> (“{receipt.ack_remarks}”)</> : null}. Saving the correction sends it back to Finance as <b>awaiting finance</b>.</> : <>The receipt is still <b>awaiting finance</b>. Every change is kept in the receipt history.</>
      : <>The receipt is saved as <b>awaiting finance</b>. Finance acknowledges it after matching the bank credit – only then does it count as collected.</>}</div>
    <div className="fg">
      <div className="f1"><label htmlFor="pr-s">Against stage *</label><select id="pr-s" className={`in ${vx.bad('stage') ? 'err' : ''}`} {...vx.aria('stage')} value={f.stage} onChange={e => upd({ stage: e.target.value })}>
        {p.stages.map(s => <option key={s.id} value={s.id}>{s.name} · balance {inr(s.balance)}</option>)}</select><FieldError id="pr-s" msg={vx.errors.stage} /></div>
      <div><label htmlFor="pr-a">Amount received (₹) *</label><div className="cur-in"><span>₹</span><input id="pr-a" className={`in ${vx.bad('amount') ? 'err' : ''}`} {...vx.aria('amount')} type="number" min={0} step="any" value={f.amount} onChange={e => upd({ amount: e.target.value })} /></div>
        <FieldError id="pr-a" msg={vx.errors.amount} />{over && !vx.errors.amount && <small className="twarn">More than the stage balance of {inr(bal)}</small>}</div>
      <div><label htmlFor="pr-d">Received on *</label><input id="pr-d" className={`in ${vx.bad('date') ? 'err' : ''}`} {...vx.aria('date')} type="date" max={todayIso()} value={f.date} onChange={e => upd({ date: e.target.value })} /><FieldError id="pr-d" msg={vx.errors.date} /></div>
      <div><label htmlFor="pr-m">Mode *</label><select id="pr-m" className={`in ${vx.bad('mode') ? 'err' : ''}`} {...vx.aria('mode')} value={f.mode} onChange={e => upd({ mode: e.target.value })}>{p.modes.map(m => <option key={m}>{m}</option>)}</select><FieldError id="pr-m" msg={vx.errors.mode} /></div>
      <div><label htmlFor="pr-r">UTR / cheque / reference *</label><input id="pr-r" className={`in ${vx.bad('ref') ? 'err' : ''}`} {...vx.aria('ref')} maxLength={120} value={f.ref} onChange={e => upd({ ref: e.target.value })} /><FieldError id="pr-r" msg={vx.errors.ref} /></div>
      <div><label htmlFor="pr-b">Collected by</label><Lookup id="pr-b" value={f.by} items={users.items} error={users.error} onRetry={users.reload} onChange={o => setF({ ...f, by: o?.id ?? null })} placeholder="You" emptyText="No active users" /></div>
      <div><label htmlFor="pr-t">Against tender</label><input id="pr-t" className="in" disabled value={p.against ? p.against.ref : '—'} /></div>
      <div className="f1"><label htmlFor="pr-x">Remarks</label><input id="pr-x" className={`in ${vx.bad('remarks') ? 'err' : ''}`} {...vx.aria('remarks')} maxLength={500} placeholder="e.g. TDS 2% deducted" value={f.remarks} onChange={e => upd({ remarks: e.target.value })} /><FieldError id="pr-x" msg={vx.errors.remarks} /></div>
    </div>
  </Modal>
}

// ─── Finance acknowledgement (prototype pyAck / pyNo) ─────────────────────────

function AckModal({ woId, woRef, customer, r, accounts, onClose, onDone }: { woId: number; woRef: string; customer: string; r: Receipt; accounts: string[]; onClose: () => void; onDone: () => void }) {
  const { success, warning, error } = useToast()
  const [f, setF] = useState({ bd: r.date || todayIso(), br: r.ref, acct: accounts[0] || '', ca: String(r.amount), rm: '' })
  const [busy, setBusy] = useState(false)
  const vx = useModalValidation(f, () => ({ bd: { label: 'Bank credit date', rule: 'date', required: true }, br: { label: 'Bank reference', rule: 'text', max: 120 },
    acct: { label: 'Credited to', rule: 'text', max: 120 }, ca: { label: 'Amount credited', rule: 'amount', required: true }, rm: { label: 'Remarks', rule: 'text', max: 500 } }),
  x => ({ ca: Number(x.ca) <= 0 && x.ca !== '' ? 'Amount must be more than 0.' : Number(x.ca) > r.amount ? `Cannot be more than the ${inr(r.amount)} recorded.` : '', bd: x.bd > todayIso() ? 'The bank credit date cannot be in the future.' : '' }),
  { bd: 'ak-d', br: 'ak-r', acct: 'ak-a', ca: 'ak-c', rm: 'ak-x' })
  const upd = (q: Partial<typeof f>) => { const n = { ...f, ...q }; setF(n); vx.change(n, ...Object.keys(q)) }
  const kv: [string, ReactNode][] = [['Customer', customer], ['Stage', r.stage || '—'], ['Amount', <b key="a">{inr(r.amount)}</b>], ['Mode · reference', `${r.mode} · ${r.ref}`],
    ['Received on', fd(r.date)], ['Collected by', r.by || '—'], ['Recorded by', `${r.entered_by || r.by || '—'}${r.recorded_at ? ` · ${dtm(r.recorded_at)}` : ''}`], ...(r.remarks ? [['Remarks', r.remarks] as [string, ReactNode]] : [])]
  const go = async (credited: boolean) => {
    if (credited ? !vx.submit() : !f.rm.trim()) { if (!credited) warning('Say why the payment was not credited in Remarks'); return }
    setBusy(true)
    try {
      if (credited) { await orderApi.acknowledge(woId, r.id, { bank_date: f.bd, bank_ref: f.br.trim() || null, credited_to: f.acct.trim() || null, credited_amount: Number(f.ca), remarks: f.rm.trim() || null }); success('Payment acknowledged – counted as collected') }
      else { await orderApi.notCredited(woId, r.id, { remarks: f.rm.trim() }); warning('Marked not credited – the sales owner is notified') }
      onDone()
    } catch (e) { if (!vx.server(e, { bank_date: 'bd', bank_ref: 'br', credited_to: 'acct', credited_amount: 'ca', remarks: 'rm' })) error(errMsg(e, 'Could not update the receipt')) } finally { setBusy(false) }
  }
  return <Modal title={<><Ic n="check" /> Acknowledge payment · {woRef}</>} width={540} onClose={onClose} foot={<>
    <button type="button" className="btn d" disabled={busy} onClick={() => void go(false)}>Not credited</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={() => void go(true)}>{busy ? 'Saving…' : 'Acknowledge'}</button></>}>
    <div className="fkv mb">{kv.map(([l, v]) => <div key={l}><div className="kl">{l}</div><div className="kv">{v}</div></div>)}</div>
    <div className="fg mt">
      <div><label htmlFor="ak-d">Bank credit date *</label><input id="ak-d" className={`in ${vx.bad('bd') ? 'err' : ''}`} {...vx.aria('bd')} type="date" max={todayIso()} value={f.bd} onChange={e => upd({ bd: e.target.value })} /><FieldError id="ak-d" msg={vx.errors.bd} /></div>
      <div><label htmlFor="ak-r">Bank reference</label><input id="ak-r" className={`in ${vx.bad('br') ? 'err' : ''}`} {...vx.aria('br')} maxLength={120} value={f.br} onChange={e => upd({ br: e.target.value })} /><FieldError id="ak-r" msg={vx.errors.br} /></div>
      <div><label htmlFor="ak-a">Credited to</label><input id="ak-a" className={`in ${vx.bad('acct') ? 'err' : ''}`} {...vx.aria('acct')} list="ak-acs" maxLength={120} placeholder="Bank account" value={f.acct} onChange={e => upd({ acct: e.target.value })} />
        <datalist id="ak-acs">{accounts.map(a => <option key={a} value={a} />)}</datalist><FieldError id="ak-a" msg={vx.errors.acct} /></div>
      <div><label htmlFor="ak-c">Amount credited (₹) *</label><div className="cur-in"><span>₹</span><input id="ak-c" className={`in ${vx.bad('ca') ? 'err' : ''}`} {...vx.aria('ca')} type="number" min={0} step="any" value={f.ca} onChange={e => upd({ ca: e.target.value })} /></div><FieldError id="ak-c" msg={vx.errors.ca} /></div>
      <div className="f1"><label htmlFor="ak-x">Remarks</label><input id="ak-x" className={`in ${vx.bad('rm') ? 'err' : ''}`} {...vx.aria('rm')} maxLength={500} placeholder="Matched with bank statement · required for Not credited" value={f.rm} onChange={e => upd({ rm: e.target.value })} /><FieldError id="ak-x" msg={vx.errors.rm} /></div>
    </div>
  </Modal>
}

// ─── payment plan editor (prototype pyPlanModal) ──────────────────────────────

type PRow = { id: number | null; name: string; pct: string; due: string; invoice_ref: string }
function PlanModal({ p, onClose, onDone }: { p: Payments; onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const o = p.order
  const start = o.start || todayIso(), end = o.due && o.due >= start ? o.due : addDays(start, 90), span = Math.max(1, daysBetween(start, end))
  const [plan, setPlan] = useState<'Single' | 'Stage-wise'>(p.plan)
  const [rows, setRows] = useState<PRow[]>(() => p.stages.map(s => ({ id: s.id, name: s.name, pct: String(s.pct), due: s.due || '', invoice_ref: s.invoice_ref })))
  const [busy, setBusy] = useState(false)
  const tot = Math.round(rows.reduce((a, r) => a + (Number(r.pct) || 0), 0) * 100) / 100
  const received = new Map(p.stages.map(s => [s.id, s.received + s.awaiting]))
  const fromTpl = (L: [string, number][]) => L.map(([name, pc], i) => ({ id: null, name, pct: String(pc), due: addDays(start, Math.round(span * (i + 1) / L.length)), invoice_ref: '' }))
  const pickPlan = (v: 'Single' | 'Stage-wise') => {
    setPlan(v)
    if (v === 'Single') setRows(r => [{ id: r[0]?.id ?? null, name: 'Full payment on completion', pct: '100', due: o.due || r[0]?.due || end, invoice_ref: r[0]?.invoice_ref || '' }])
    else if (rows.length < 2) setRows(fromTpl(p.templates['10 / 60 / 20 / 10'] || [['Stage 1', 50], ['Stage 2', 50]]))
  }
  const set = (i: number, q: Partial<PRow>) => setRows(r => r.map((x, j) => j === i ? { ...x, ...q } : x))
  const dropped = p.stages.filter(s => !rows.some(r => r.id === s.id) && (received.get(s.id) || 0) > 0)
  const errs = rows.map(r => !r.name.trim() ? 'Name the stage' : !(Number(r.pct) > 0) ? 'Enter a percentage above 0' : !r.due ? 'Pick a due date' : '')
  const save = async () => {
    if (errs.some(Boolean)) { error(errs.find(Boolean)!); return }
    if (tot !== 100) { error('Stage percentages must add up to 100%'); return }
    setBusy(true)
    try {
      const r = await orderApi.savePlan(o.id, { plan, stages: rows.map(x => ({ id: x.id, name: x.name.trim(), pct: Number(x.pct), due: x.due || null, invoice_ref: x.invoice_ref.trim() || null })) })
      success(r.moved ? `Payment plan saved – ${r.moved} receipt${r.moved > 1 ? 's' : ''} moved to “${rows[0].name.trim()}”` : 'Payment plan saved'); onDone()
    } catch (e) { error(errMsg(e, 'Could not save the payment plan')) } finally { setBusy(false) }
  }
  return <Modal title={`Payment plan · ${o.ref}`} width={760} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save plan'}</button></>}>
    <div className="row wrap mb" style={{ gap: 10 }}>
      <div className="seg8" role="tablist">{([['Single', 'Single payment'], ['Stage-wise', 'Stage-wise']] as const).map(([k, l]) =>
        <button key={k} type="button" role="tab" aria-selected={plan === k} className={plan === k ? 'on' : ''} onClick={() => pickPlan(k)}>{l}</button>)}</div>
      <span className="fl" />
      <label className="row" style={{ gap: 6 }}>Start from <select className="in sm" style={{ width: 210 }} value="" aria-label="Plan template" onChange={e => {
        const L = p.templates[e.target.value]; if (!L) return; setPlan(L.length > 1 ? 'Stage-wise' : 'Single'); setRows(fromTpl(L))
      }}><option value="">Template…</option>{Object.keys(p.templates).map(k => <option key={k}>{k}</option>)}</select></label>
    </div>
    <div className="tw fit"><table className="t"><thead><tr><th>Stage</th><th className="r">%</th><th className="r">Amount</th><th>Due date</th><th>Invoice / reference</th><th /></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>
        <td><input className={`in sm ${errs[i] && !r.name.trim() ? 'err' : ''}`} aria-label={`Stage ${i + 1} name`} maxLength={200} value={r.name} onChange={e => set(i, { name: e.target.value })} disabled={plan === 'Single'} /></td>
        <td><input className="in sm" type="number" min={0} max={100} step="any" style={{ width: 76, textAlign: 'right' }} aria-label={`Stage ${i + 1} percent`} value={r.pct} onChange={e => set(i, { pct: e.target.value })} disabled={plan === 'Single'} /></td>
        <td className="r">{inr(o.value * (Number(r.pct) || 0) / 100)}</td>
        <td><input className={`in sm ${!r.due ? 'err' : ''}`} type="date" aria-label={`Stage ${i + 1} due date`} value={r.due} onChange={e => set(i, { due: e.target.value })} /></td>
        <td><input className="in sm" maxLength={120} placeholder="INV/…" aria-label={`Stage ${i + 1} invoice`} value={r.invoice_ref} onChange={e => set(i, { invoice_ref: e.target.value })} /></td>
        <td>{rows.length > 1 && <button type="button" className="btn g s" aria-label={`Remove stage ${i + 1}`} onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Ic n="x" /></button>}</td></tr>)}</tbody></table></div>
    {plan === 'Stage-wise' && <button type="button" className="btn s mt" onClick={() => setRows(x => [...x, { id: null, name: 'New stage', pct: '0', due: end, invoice_ref: '' }])}><Ic n="plus" /> Add stage</button>}
    <div className="row mt"><span className={tot === 100 ? 'tok' : 'tbad'}>Total {tot}%{tot === 100 ? '' : ' – must add up to 100%'}</span><span className="fl" />
      <small className="mu">Order value {inr(o.value)} · receipts already recorded stay with their stage.</small></div>
    {dropped.length > 0 && <div className="note wa mt">Receipts of {dropped.map(s => `“${s.name}”`).join(', ')} will move to “{rows[0]?.name || 'the first stage'}”. They are not deleted and the move is recorded in each receipt's history.</div>}
  </Modal>
}

// ─── receipt history ──────────────────────────────────────────────────────────

const HACT: Record<string, string> = { recorded: 'Recorded', corrected: 'Corrected', relinked: 'Moved to another stage', acknowledged: 'Acknowledged by Finance', not_credited: 'Marked not credited' }
const HFLD: Record<string, string> = { stage_id: 'Stage', amount: 'Amount', received_on: 'Received on', mode: 'Mode', reference: 'Reference', collected_by: 'Collected by', remarks: 'Remarks',
  status: 'Status', stage: 'Stage', bank_date: 'Bank date', bank_ref: 'Bank reference', credited_to: 'Credited to', credited_amount: 'Credited' }
function HistoryModal({ woId, r, onClose }: { woId: number; r: Receipt; onClose: () => void }) {
  const [h, setH] = useState<RcptHistory[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { orderApi.receiptHistory(woId, r.id).then(setH).catch(e => setErr(errMsg(e, 'Could not load the history'))) }, [woId, r.id])
  const show = (k: string, v: unknown) => v == null || v === '' ? '—' : k === 'amount' || k === 'credited_amount' ? inr(Number(v)) : /date|_on$/.test(k) ? fd(String(v)) : String(v)
  return <Modal title={`Receipt history · ${inr(r.amount)} · ${r.ref}`} width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Close</button></>}>
    {err ? <div className="empty">{err}</div> : !h ? <div className="empty">Loading…</div> : !h.length ? <div className="empty">No history recorded</div>
      : <div className="tl">{h.map(x => {
        const keys = [...new Set([...Object.keys(x.old || {}), ...Object.keys(x.new || {})])].filter(k => k !== 'stage_id' && k !== 'collected_by' && (x.action !== 'recorded' ? JSON.stringify((x.old || {})[k]) !== JSON.stringify((x.new || {})[k]) : (x.new || {})[k] != null))
        return <div key={x.id}><b>{HACT[x.action] || x.action}</b>{x.note && <> – {x.note}</>}<br /><small>{x.by} · {dtm(x.at)}</small>
          {keys.length > 0 && <div className="mu" style={{ fontSize: 12, marginTop: 3 }}>{keys.map(k => <div key={k}>{HFLD[k] || k}: {x.action === 'recorded' ? show(k, x.new?.[k]) : <>{show(k, x.old?.[k])} → {show(k, x.new?.[k])}</>}</div>)}</div>}</div>
      })}</div>}
  </Modal>
}

// ─── Collections & finance segment (prototype pyCollections) ─────────────────

export function CollectionsView({ rev, onOpen, onChanged, onCount }: { rev: number; onOpen: (id: number) => void; onChanged: () => void; onCount?: (n: number) => void }) {
  const navigate = useNavigate()
  const [c, setC] = useState<Collections | null>(null)
  const [err, setErr] = useState('')
  const [ack, setAck] = useState<RcptRow | null>(null)
  const load = useCallback(() => { setErr(''); orderApi.collections().then(x => { setC(x); onCount?.(x.kpis.awaiting_count) }).catch(e => { setErr(errMsg(e, 'Could not load collections')) }) }, [onCount])
  useEffect(() => { load() }, [load, rev])
  const showCo = !!c?.company
  const tenderCell = useCallback((o: { tender: string; tender_kind: string | null; tender_id: number | null }) => !o.tender ? <span className="mu">—</span>
    : o.tender_kind === 'tender' ? <a onClick={e => { e.stopPropagation(); navigate(`/tenders/${o.tender_id}`) }}>{o.tender}</a> : <small>Quote {o.tender}</small>, [navigate])
  const schCols: GridCol<SchedRow>[] = useMemo(() => [
    { k: 'order', t: 'Order', w: 130, fn: o => <b>{o.order}</b> },
    ...(showCo ? [{ k: 'company', t: 'Company', w: 96, fn: (o: SchedRow) => <span className="pill ac oco" title={o.company}>{o.company}</span> } as GridCol<SchedRow>] : []),
    { k: 'customer', t: 'Customer', w: 200 },
    { k: 'tender', t: 'Tender', w: 150, fn: tenderCell, txt: o => o.tender },
    { k: 'plan', t: 'Plan', w: 100 },
    { k: 'stage', t: 'Stage', w: 230, fn: o => <>{o.stage}{o.invoice_ref && <><br /><small className="mu">{o.invoice_ref}</small></>}</> , txt: o => o.stage },
    { k: 'amount', t: 'Amount', r: true, w: 110, money: true, sum: true, sv: o => o.amount, sumv: o => o.amount, sumFmt: inr, fn: o => inr(o.amount), txt: o => String(o.amount) },
    { k: 'due', t: 'Due', w: 130, date: true, sv: o => o.due || '', fn: o => <DueCell d={o.due} done={o.balance <= 0} />, txt: o => o.due || '' },
    { k: 'received', t: 'Received', r: true, w: 110, money: true, sum: true, sv: o => o.received, sumv: o => o.received, sumFmt: inr, fn: o => o.received ? <span className="tok">{inr(o.received)}</span> : '—', txt: o => String(o.received) },
    { k: 'awaiting', t: 'Awaiting finance', r: true, w: 120, money: true, sum: true, sv: o => o.awaiting, sumv: o => o.awaiting, sumFmt: inr, fn: o => o.awaiting ? inr(o.awaiting) : '—', txt: o => String(o.awaiting) },
    { k: 'balance', t: 'Balance', r: true, w: 110, money: true, sum: true, sv: o => o.balance, sumv: o => o.balance, sumFmt: inr, fn: o => o.balance ? <b>{inr(o.balance)}</b> : '—', txt: o => String(o.balance) },
    { k: 'status', t: 'Status', w: 150, fn: o => <Pill s={o.status} t={PYC[o.status]} /> },
  ], [showCo, tenderCell])
  const rcCols: GridCol<RcptRow>[] = useMemo(() => [
    { k: 'date', t: 'Received', w: 110, date: true, fn: r => fd(r.date), sv: r => r.date || '', txt: r => r.date || '' },
    { k: 'order', t: 'Order', w: 130, fn: r => <a onClick={e => { e.stopPropagation(); onOpen(r.wo_id) }}><b>{r.order}</b></a> },
    ...(showCo ? [{ k: 'company', t: 'Company', w: 96, fn: (r: RcptRow) => <span className="pill ac oco" title={r.company}>{r.company}</span> } as GridCol<RcptRow>] : []),
    { k: 'customer', t: 'Customer', w: 200 },
    { k: 'amount', t: 'Amount', r: true, w: 110, money: true, sum: true, sv: r => r.amount, sumv: r => r.amount, sumFmt: inr, fn: r => inr(r.amount), txt: r => String(r.amount) },
    { k: 'mode', t: 'Mode', w: 110 },
    { k: 'ref', t: 'Reference', w: 150 },
    { k: 'by', t: 'Collected by', w: 170, fn: r => r.by ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.by} />{r.by}</span> : <span className="mu">—</span> },
    { k: 'status', t: 'Finance', w: 150, fn: r => <Pill s={r.status} t={PYR[r.status]} /> },
    { k: 'ack_by', t: 'Acknowledged by', w: 170, fn: r => r.ack_by ? <>{r.ack_by}<br /><small className="mu">{fd(r.ack_at)}</small></> : '—', txt: r => r.ack_by },
  ], [showCo, onOpen])
  if (err) return <div className="panel"><div className="empty">{err} · <a onClick={load}>Retry</a></div></div>
  if (!c) return <div className="panel"><div className="empty">Loading…</div></div>
  const k = c.kpis
  return <>
    <Strip items={[
      { l: 'Order book', v: k.order_book, f: 'inr' },
      { l: 'Due to date', v: k.due, f: 'inr' },
      { l: 'Received', v: k.received, f: 'inr', dc: 'tok' },
      { l: 'Awaiting finance', v: k.awaiting, f: 'inr', note: `${k.awaiting_count} receipt${k.awaiting_count === 1 ? '' : 's'}`, dc: k.awaiting_count ? 'twarn' : '' },
      { l: 'Overdue', v: k.overdue, f: 'inr', note: `${k.overdue_count} stage${k.overdue_count === 1 ? '' : 's'}`, dc: k.overdue_count ? 'tbad' : '' },
      { l: 'Collection efficiency', v: k.efficiency, f: 'pct' },
    ]} />
    <div className="panel mb"><div className="ph"><Ic n="check" /> Finance acknowledgement queue<span className="fl" /><small className="mu">Receipts recorded by sales – acknowledge after matching the bank credit</small></div>
      <div className="list py8-q">{c.queue.length ? c.queue.map(r => <div key={r.id}>
        <div className="fl" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.wo_id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(r.wo_id) }}>
          <b>{inr(r.amount)}</b> · {r.customer} · {r.order}<br />
          <small className="mu">{r.stage}{r.stage ? ' · ' : ''}{r.mode} {r.ref} · received {fd(r.date)} · collected by {r.by || '—'}</small></div>
        <span className="mu">{r.tender_kind === 'tender' ? r.tender : ''}</span>
        {c.can.finance && <button type="button" className="btn s p" onClick={() => setAck(r)}>Acknowledge</button>}
      </div>) : <div className="empty">Nothing waiting for Finance</div>}</div></div>
    <div className="panel mb"><div className="ph">Payment schedule · all orders</div>
      <BwGrid id="orders-py-sch" cols={schCols} rows={c.schedule} rid={o => o.id} onRow={o => onOpen(o.wo_id)} empty="No payment stages yet" /></div>
    <div className="panel"><div className="ph">All receipts</div>
      <BwGrid id="orders-py-rc" cols={rcCols} rows={c.receipts} rid={r => String(r.id)} onRow={r => onOpen(r.wo_id)} empty="No receipts recorded yet" /></div>
    {ack && <AckModal woId={ack.wo_id} woRef={ack.order} customer={ack.customer} r={ack} accounts={c.accounts} onClose={() => setAck(null)} onDone={() => { setAck(null); load(); onChanged() }} />}
  </>
}

