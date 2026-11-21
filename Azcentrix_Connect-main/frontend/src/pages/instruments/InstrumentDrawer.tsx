// Guarantees & Deposits – prototype v18 gdOpen(): instrument drawer.
// Header "<type> · <amount>" · ID · status · tender / order · customer · Open tender; expired alert; Next step with the
// actions valid for the status; approval chain; Lifecycle stepper; Key dates; Instrument details; Tender (timeline) or
// Order panel; Activity. All data from /api/v1/instruments/{id}.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { dto, errMsg, fd, fdS, fdt, inr, insApi, type Detail, type Meta } from './instrumentApi'
import { ActionModal, type ActionKey } from './InstrumentModals'

const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>
const Kv = ({ rows }: { rows: [string, ReactNode][] }) => <div className="kvm">{rows.map(([k, v]) => <div key={k}><span>{k}</span><span>{v}</span></div>)}</div>
type Step = { l: string; s: '' | 'done' | 'cur' | 'bad'; d?: string; w?: string }

function Steps({ steps }: { steps: Step[] }) {
  return <div className="lc8">{steps.map((s, i) => <div key={s.l} className={`lc8-s ${s.s}`}>
    <div className="lc8-d">{s.s === 'done' ? <Ic n="check" size={13} /> : s.s === 'bad' ? <Ic n="x" size={13} /> : i + 1}</div>
    <div className="lc8-t"><b>{s.l}</b>{s.d && <small>{s.d}</small>}{s.w && <small className="mu">{s.w}</small>}</div></div>)}</div>
}

/** prototype gdSteps() */
function lifecycle(r: Detail): Step[] {
  const D = r.dates, fee = r.type_key === 'TF'
  if (r.status === 'Exempted') return [{ l: 'Exemption recorded', s: 'done', d: fd(D.recorded), w: D.recorded_by }, { l: 'Certificate on file', s: 'done', d: r.exempt_cert }]
  const rej = r.status === 'Rejected', pending = r.approval.chain.find(c => c.state === 'Pending')
  const st: Step[] = [
    { l: 'Recorded', s: 'done', d: fd(D.recorded), w: D.recorded_by },
    { l: 'Head approval', s: rej ? 'bad' : D.approved ? 'done' : r.status === 'Pending approval' ? 'cur' : '', d: rej ? 'Rejected' : D.approved ? fd(D.approved) : '', w: D.approved_by || pending?.user || '' },
    { l: fee ? 'Finance pays · UTR' : 'Finance · UTR / instrument', s: D.paid ? 'done' : r.status === 'With Finance' ? 'cur' : '', d: D.paid ? fd(D.paid) : '', w: D.paid_by },
  ]
  if (fee) st.push({ l: 'Paid · closed', s: r.status === 'Paid' ? 'done' : '', d: r.status === 'Paid' ? 'non-refundable' : '' })
  else st.push(
    { l: 'Lodged · active', s: ['Active', 'Release Requested', 'Received – ack pending', 'Released', 'Forfeited'].includes(r.status) ? (r.expired ? 'bad' : r.status === 'Active' ? 'cur' : 'done') : '', d: r.validity ? `valid till ${fd(r.validity)}` : '' },
    { l: r.type_key === 'EMD' ? 'Refund received' : 'Returned / released', s: D.received ? 'done' : r.status === 'Release Requested' ? 'cur' : r.status === 'Forfeited' ? 'bad' : '',
      d: D.received ? fd(D.received) : D.refund_requested ? `requested ${fdS(D.refund_requested)}` : r.status === 'Forfeited' ? 'forfeited' : '', w: D.received_by },
    { l: 'Finance acknowledged', s: D.acknowledged ? 'done' : r.status === 'Received – ack pending' ? 'cur' : '', d: D.acknowledged ? fd(D.acknowledged) : '', w: D.acknowledged_by })
  return st
}

export default function InstrumentDrawer({ id, meta, onClose, onChanged }: { id: number; meta: Meta; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [act, setAct] = useState<ActionKey | null>(null)
  const load = useCallback(() => insApi.get(id).then(setD).catch(e => { error(errMsg(e, 'Could not load the instrument')); onClose() }), [id, error, onClose])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !act) onClose() }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [onClose, act])
  const done = (m: string) => { setAct(null); (/approval/i.test(m) && !/^Approved/.test(m) ? warning : success)(m); void load(); onChanged() }
  const host = document.querySelector('.crm-shell') ?? document.body
  const a = d?.actions
  const btn = (k: ActionKey, label: ReactNode, cls = '') => <button type="button" className={`btn ${cls}`} onClick={() => setAct(k)}>{label}</button>
  const D = d?.dates
  return createPortal(<div className="bwi gdp">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw gd8-dw" role="dialog" aria-modal="true" aria-label={d ? `Instrument ${d.code}` : 'Instrument'}>
      <div className="dh"><div className="fl">
        {!d ? <h2>Loading…</h2> : <><h2>{d.type} · {inr(d.amount)}</h2>
          <div className="sub">{d.code} · <Pill s={d.eff_status} t={d.tone} />
            {d.tender_rec ? <> · <a onClick={() => navigate(`/tenders/${d.tender_rec!.id}`)}>{d.tender_rec.ref}</a></> : d.order_rec ? <> · <a onClick={() => navigate(`/workorders?open=${d.order_rec!.id}`)}>{d.order_rec.ref}</a></> : null}
            {d.customer && <> · {d.customer}</>}</div></>}</div>
        {d?.tender_rec && <button type="button" className="btn s" onClick={() => navigate(`/tenders/${d.tender_rec!.id}`)}><Ic n="file" /> Open tender</button>}
        <button type="button" className="btn g s" aria-label="Close" onClick={onClose}><Ic n="x" /></button>
      </div>
      {d && a && D && <div className="db">
        {d.expired && <div className="gd8-al ba mb"><Ic n="alert" /><div><b>{d.type} expired on {fd(d.validity)}</b><br />
          <small>{d.type_key === 'EMD' ? 'Claim the refund from the customer or get the bid validity extended.' : 'Extend with the bank or get the original returned and released.'}</small></div></div>}
        <div className="gd8-next"><div className="fl"><small className="mu">Next step</small><b>{d.next}</b></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {a.open_approval && <button type="button" className="btn p" onClick={() => navigate(`/approvals?open=r${d.approval.id}`)}><Ic n="check" /> Open approval</button>}
            {a.withdraw && btn('withdraw', 'Withdraw request')}
            {a.resubmit && btn('resubmit', <><Ic n="flow" /> Revise &amp; resubmit</>, 'p')}
            {(d.status === 'With Finance' || d.status === 'Received – ack pending') && <span className="pill inf">Finance team</span>}
            {a.pay && btn('pay', <><Ic n="card" /> {d.bg && d.type_key !== 'TF' ? 'Enter instrument details' : 'Enter payment & UTR'}</>, 'p')}
            {a.refund && btn('refund', 'Request refund / release')}
            {a.receive && btn('receive', <><Ic n="check" /> Mark received back</>, 'p')}
            {a.extend && btn('extend', <><Ic n="cal" /> Extend validity</>)}
            {a.forfeit && btn('forfeit', 'Mark forfeited', 'd')}
            {a.acknowledge && btn('acknowledge', <><Ic n="check" /> Acknowledge receipt</>, 'p')}
          </div></div>
        {d.refund.pending_approval && <div className="note mb">The refund / release request is waiting for approval in Approvals.</div>}
        {d.extension.pending_date && <div className="note mb">Extension to {fd(d.extension.pending_date)} is waiting for approval.</div>}
        {d.approval.chain.length > 0 && <div className="panel mb"><div className="ph">Approval<span className="fl" /><small className="mu">Requested by {d.approval.requested_by} · {fdt(d.approval.requested_at)}{d.approval.priority ? ` · ${d.approval.priority} priority` : ''}</small></div>
          <div className="pb"><div className="list">{d.approval.chain.map(c => <div key={c.step}><span className="fl"><b>{c.step}. {c.role || 'Approver'}</b> · {c.user || '—'}{c.remarks && <><br /><small className="mu">“{c.remarks}”</small></>}</span>
            <Pill s={c.state} t={c.state === 'Approved' ? 'ok' : c.state === 'Rejected' ? 'ba' : c.state === 'Pending' ? 'wa' : 'mu'} />{c.at && <small className="mu">{fdS(c.at)}</small>}</div>)}</div></div></div>}
        <div className="panel mb"><div className="ph">Lifecycle</div><div className="pb"><Steps steps={lifecycle(d)} /></div></div>
        <div className="panel mb"><div className="ph">Key dates</div><div className="pb"><Kv rows={[
          ['Recorded on', D.recorded ? `${fd(D.recorded)} · ${D.recorded_by}` : '—'],
          ['Required by', D.due ? <span className={dto(D.due) < 0 && ['Pending approval', 'With Finance'].includes(d.status) ? 'tbad' : ''}>{fd(D.due)}{['Pending approval', 'With Finance'].includes(d.status) ? ` · ${dto(D.due) < 0 ? `${-dto(D.due)} d overdue` : `in ${dto(D.due)} d`}` : ''}</span> : '—'],
          ['Approved on', D.approved ? `${fd(D.approved)} · ${D.approved_by}` : <span className="mu">pending</span>],
          ['Sent to Finance', fd(D.sent_to_finance)],
          [d.type_key === 'TF' ? 'Paid on' : 'Paid / issued on', D.paid ? `${fd(D.paid)}${D.paid_by ? ` · ${D.paid_by}` : ''}` : '—'],
          ['Valid until', d.validity ? <span className={d.expired ? 'tbad' : (d.days ?? 99) <= 30 ? 'twarn' : ''}>{fd(d.validity)} · {d.expired ? `${-(d.days ?? 0)} d ago` : `in ${d.days} d`}</span> : '—'],
          ['Refund requested', D.refund_requested ? `${fd(D.refund_requested)}${d.refund.reason ? ` · ${d.refund.reason}` : ''}${d.refund.letter ? ` · ${d.refund.letter}` : ''}` : '—'],
          ['Received back', D.received ? `${fd(D.received)} · ${inr(D.received_amount ?? d.amount)}${d.receipt.ref ? ` · ${d.receipt.ref}` : ''}` : '—'],
          ['Finance acknowledged', D.acknowledged ? <>{fd(D.acknowledged)} · {D.acknowledged_by}{d.receipt.shortfall ? <b className="tbad"> · short by {inr(d.receipt.shortfall)}</b> : null}</> : '—'],
          ...(D.forfeited ? [['Forfeited', `${fd(D.forfeited)} · ${D.forfeited_by} · ${d.forfeit.reason}`] as [string, ReactNode]] : []),
        ]} /></div></div>
        <div className="panel mb"><div className="ph">Instrument details</div><div className="pb"><Kv rows={[
          ['Instrument', d.purpose], ['Mode of payment', d.mode || '—'], ['Beneficiary', d.bene || d.customer], ['Payable at', d.at || '—'], ['Bank', d.bank || '—'],
          ['UTR / transaction', d.utr ? <b>{d.utr}</b> : <span className="mu">{['Pending approval', 'With Finance'].includes(d.status) ? 'to be entered by Finance' : '—'}</span>],
          ['Instrument / DD / BG no.', d.ref || (d.exempt_cert ? d.exempt_cert : '—')],
          ['Margin held', d.margin_pct != null ? (typeof d.margin_pct === 'number' ? `${d.margin_pct}% · ${inr(typeof d.margin_amount === 'number' ? d.margin_amount : d.amount * d.margin_pct / 100)}` : d.margin_pct) : '—'],
          ['Bank charges', d.charges != null ? (typeof d.charges === 'number' ? inr(d.charges) : d.charges) : '—'],
          ['Remarks', d.remarks || '—'],
        ]} /></div></div>
        {d.tender_rec && <div className="panel mb"><div className="ph"><Ic n="file" /> Tender {d.tender_rec.ref}<span className="fl" /><a onClick={() => navigate(`/tenders/${d.tender_rec!.id}`)}>Open tender</a></div><div className="pb">
          <Kv rows={[['Tender', d.tender_rec.title.slice(0, 70)], ['Tender / NIT no.', d.tender_rec.nit || '—'], ['Customer', d.tender_rec.customer], ['Portal', d.tender_rec.portal || '—'],
            ['Estimated value', inr(d.tender_rec.value)], ['Stage', d.tender_rec.stage ? <Pill s={d.tender_rec.stage} t="inf" /> : '—'], ['Submission', fd(d.tender_rec.submit)], ['Bid manager', d.tender_rec.owner || '—']]} />
          <h3 style={{ margin: '14px 0 8px', fontSize: 13 }}>Tender timeline</h3>
          {!d.tender_rec.timeline.length ? <div className="empty">No events yet</div> : <div className="tl8">{d.tender_rec.timeline.map((e, i) => <div key={i} className={e.d && e.d > d.today ? 'fut' : ''}>
            <span className="tl8-d">{fd(e.d)}</span><i className={`tl8-i ${e.c}`} /><div className="tl8-b"><span><b>{e.l}</b>{e.d && e.d > d.today && <> <span className="pill mu">upcoming</span></>}</span>{e.s && <small>{e.s}</small>}</div></div>)}</div>}
        </div></div>}
        {d.order_rec && <div className="panel mb"><div className="ph"><Ic n="brief" /> Order {d.order_rec.ref}<span className="fl" /><a onClick={() => navigate(`/workorders?open=${d.order_rec!.id}`)}>Open order</a></div><div className="pb">
          <Kv rows={[['Work', d.order_rec.work || '—'], ['Customer', d.order_rec.customer], ['PO', d.order_rec.po || '—'], ['Value', inr(d.order_rec.value)], ['Due', fd(d.order_rec.due)]]} /></div></div>}
        <div className="panel"><div className="ph">Activity</div><div className="pb">
          {!d.timeline.length ? <div className="empty">No events yet</div> : <div className="tl8">{d.timeline.map((e, i) => <div key={i}><span className="tl8-d">{fd(e.d)}</span><i className="tl8-i ac" />
            <div className="tl8-b"><span><b>{e.t}</b></span><small>{e.by}{e.d ? ` · ${fdt(e.d).split(', ').pop()}` : ''}</small></div></div>)}</div>}
        </div></div>
      </div>}
    </aside>
    {act && d && <ActionModal act={act} r={d} d={d} meta={meta} onClose={() => setAct(null)} onDone={done} />}
  </div>, host)
}
