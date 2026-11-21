// Journey timeline modal – shared by the Quotes grid (Journey chip) and the quote page (Full timeline).
import { Ic } from '@/components/crm/kit'
import { Modal } from '@/pages/notifications/Modal'
import { Pill } from '@/pages/customers/kit'
import { fd, inr, stagePill, type Detail } from './quoteApi'

// prototype A.jopen / jtimeline(): strip Customer · Total value · Steps · Days in journey, then one event per record
// (Lead created · Converted to deal · Tender raised · Quotation prepared · Work order created) with its id, stage and detail.
const JEV: Record<string, string> = { lead: 'Lead created', deal: 'Converted to deal', tender: 'Tender raised', quote: 'Quotation prepared', order: 'Work order created' }
export default function JourneyTimeline({ d, onClose, navigate }: { d: Detail; onClose: () => void; navigate: (p: string) => void }) {
  const done = d.journey.steps.filter(s => s.done)
  const ev = done.filter(s => s.date).sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const first = ev[0]?.date
  const days = first ? Math.max(1, Math.round((Date.now() - new Date(`${first.slice(0, 10)}T00:00:00`).getTime()) / 864e5)) : 0
  const cur = d.revisions.length - 1
  const detail = (s: (typeof ev)[number]) => s.k === 'quote' ? `Rev ${cur} · ${inr(s.value)}` : s.value != null ? `${s.ref} · ${inr(s.value)}` : ''
  const St = ({ l, v }: { l: string; v: string }) => <div className="st"><label>{l}</label><b style={{ fontSize: 14 }}>{v}</b></div>
  return <Modal title={<><Ic n="flow" /> Journey {d.journey.id}</>} width={640} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Close</button></>}>
    <div className="strip" style={{ margin: '-4px 0 10px' }}>
      <St l="Customer" v={d.customer || '—'} /><St l="Total value" v={inr(Math.max(0, ...done.map(s => s.value || 0)))} />
      <St l="Steps" v={`${done.length} of 4`} /><St l="Days in journey" v={String(days)} />
    </div>
    <div className="jtl">{ev.map(s => <div key={s.k}><b>{JEV[s.k] || s.label}</b> <small>{fd(s.date)}</small><br />
      {s.route ? <a onClick={() => { onClose(); navigate(s.route!) }}>{s.ref}</a> : <span>{s.ref}</span>} <Pill s={s.stage || 'Active'} t={s.me ? stagePill(s.stage || '', d.stage.kind) : undefined} />
      <br /><small className="mu">{detail(s)}</small></div>)}
      {!ev.length && <div className="mu">No journey events yet.</div>}</div>
  </Modal>
}
