// Approvals – prototype v18 A.aopen() / apDetail(): wide approval drawer.
// Hero (purpose · ID · title · requester · company · date) with Value at stake · Response time · Approval step · Risk
// signals; "You are approving" (what happens on approval); purpose sections (deposit / tender / customer / record
// details, proposed changes, funds position, bid readiness, onboarding checks); side: Approval chain, Why it needs
// approval (policy), Activity; decision bar with quick remarks, Approve / Reject, Ask for info · Delegate · Escalate.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av } from '@/pages/customers/kit'
import { approvalsApi, errMsg, fd, ft, inr, type Detail, type Meta, type Section } from './approvalsApi'

const Pill = ({ s, t }: { s: string; t?: string }) => <span className={`pill ${t || ({ Pending: 'wa', Approved: 'ok', Rejected: 'ba', High: 'ba', Medium: 'wa', Low: 'mu' } as Record<string, string>)[s] || 'inf'}`}>{s}</span>
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

function Sec({ s, onGo }: { s: Section; onGo: (to: string) => void }) {
  return <div className="ap8-sec"><h4><Ic n={s.i} size={13} /> {s.t}</h4>
    {s.kv && <div className="ap8-kv">{s.kv.map(([k, v]) => <div key={k}><label>{k}</label><div>{isDate(v) ? fd(v) : v}</div></div>)}</div>}
    {s.chk && <div className="ap8-chk">{s.chk.map(([c, t, v], i) => <div key={i}><i className={c} /><b>{t}</b><span>{v}</span></div>)}</div>}
    {s.diff && <div className="tw fit"><table className="t"><thead><tr><th>Field</th><th>Current</th><th>Proposed</th></tr></thead>
      <tbody>{s.diff.map(([f, o, n]) => <tr key={String(f)}><td>{String(f)}</td><td className="mu">{o == null || o === '' ? '—' : String(o)}</td><td><b>{n == null || n === '' ? '—' : String(n)}</b></td></tr>)}</tbody></table></div>}
    {s.contacts && s.contacts.length > 0 && <div className="tw fit mt"><table className="t"><thead><tr><th>Contact</th><th>Role</th><th>Phone</th><th>Email</th></tr></thead>
      <tbody>{s.contacts.map((c, i) => <tr key={i}><td>{c.name}</td><td>{c.role}</td><td>{c.phone}</td><td>{c.email}</td></tr>)}</tbody></table></div>}
    {s.link?.to && <div className="row mt"><a onClick={() => onGo(s.link!.to!)}><Ic n="eye" size={13} /> {s.link.t}</a></div>}
  </div>
}

export default function ApprovalDrawer({ k, meta, onClose, onChanged, onNext }: { k: string; meta: Meta; onClose: () => void; onChanged: () => void; onNext: () => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [rm, setRm] = useState('')
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<null | 'info' | 'delegate' | 'escalate' | 'answer'>(null)
  const load = useCallback(() => approvalsApi.detail(k).then(x => { setD(x); setRm('') }).catch(e => { error(errMsg(e, 'Could not open the request')); onClose() }), [k, error, onClose])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal) onClose() }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [onClose, modal])
  const goTo = (to: string) => { onClose(); navigate(to) }
  const decide = async (dec: 'approved' | 'rejected') => {
    if (!d) return
    if (dec === 'rejected' && !rm.trim()) { error('Remarks are required when you reject'); return }
    setBusy(true)
    try { await approvalsApi.decide(d.key, dec, rm.trim()); success(dec === 'approved' ? 'Approved' : 'Rejected'); onChanged(); onNext() }
    catch (e) { error(errMsg(e, 'Could not record the decision')); void load() } finally { setBusy(false) }
  }
  const host = document.querySelector('.crm-shell') ?? document.body
  const can = d?.status === 'Pending'
  const reds = d ? d.sections.flatMap(s => s.chk || []).filter(c => c[0] === 'ba').length : 0
  const ambers = d ? d.sections.flatMap(s => s.chk || []).filter(c => c[0] === 'wa').length : 0
  const risk = reds ? 'High' : ambers > 1 ? 'Medium' : 'Low'
  const pending = d ? d.chain.filter(c => c.state === 'Pending' || c.state === 'Waiting').length : 0
  return createPortal(<div className="bwi apv8">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw ap8-dw" role="dialog" aria-modal="true" aria-label="Approval request">
      <div className="dh"><div className="fl"><h2>Approval request</h2>{d && <div className="sub"><span className="mono">{d.id}</span> · <Pill s={d.status} /> · <Pill s={d.priority} />
        {d.status === 'Pending' && <span className={d.sla.cls}>· {d.sla.txt}</span>}{d.escalated && <Pill s="Escalated" t="ba" />}</div>}</div>
        <button type="button" className="btn g s" aria-label="Close" onClick={onClose}><Ic n="x" /></button></div>
      {!d ? <div className="db"><div className="empty">Loading…</div></div> : <div className="db z">
        <div className="ax-hero" style={{ ['--pc' as string]: d.purpose.c }}>
          <div className="ax-top"><span className="ax-pi"><Ic n={d.purpose.i} /></span><div className="fl"><div className="ax-pl">{d.purpose.l} · {d.id}</div><h2>{d.title}</h2>
            <div className="ax-by"><Av name={d.by} /> <b>{d.by}</b><span>{d.byRole}{d.company ? ` · ${d.company}` : ''} · {fd(d.req)} {ft(d.req)} · via {d.source}</span></div></div></div>
          <div className="ax-kpi">
            <div><small>Value at stake</small><b>{d.value ? inr(d.value) : '—'}</b><span>{d.priority} priority</span></div>
            <div><small>{can ? 'Response time' : 'Decided on'}</small><b className={can ? d.sla.cls : ''}>{can ? d.sla.txt : fd(d.decided || d.req)}</b><span>SLA {d.sla.hours} h{can && d.sla.due ? ` · due ${fd(d.sla.due)} ${ft(d.sla.due)}` : ''}</span></div>
            <div><small>Approval step</small><b>{can ? `${d.step.done + 1} of ${d.step.of}` : 'Complete'}</b><span className="ax-dots">{d.chain.map((c, i) => <i key={i} className={c.state === 'Approved' ? 'ok' : c.state === 'Rejected' ? 'ba' : c.current ? 'cur' : ''} title={c.role} />)}</span></div>
            <div><small>Risk signals</small><b className={{ High: 'tbad', Medium: 'twarn', Low: 'tok' }[risk]}>{risk}</b><span>{reds} red · {ambers} amber checks</span></div>
          </div>
        </div>
        <div className="ax-grid">
          <div className="ax-main">
            <div className="ax-ask"><span><Ic n="check" /></span><div><small>{can ? 'You are approving' : 'Request'}</small><div dangerouslySetInnerHTML={{ __html: d.what }} /></div></div>
            {d.to && <div className="ap8-move"><div><small>From</small><b>{d.from || d.stage || '—'}</b></div><Ic n="right" /><div className="to"><small>To</small><b>{d.to}</b></div></div>}
            {d.info.open && <div className="note mt"><b>Information requested:</b> {d.info.question}{d.can_answer && <> <a onClick={() => setModal('answer')}>Answer</a></>}</div>}
            {d.sections.map((s, i) => <Sec key={i} s={s} onGo={goTo} />)}
            {!d.sections.length && <div className="empty">No further details are linked to this request.</div>}
          </div>
          <aside className="ax-side">
            <div className="ax-card"><h4>Approval chain</h4>{!d.chain.length && <p className="mu">{d.status === 'Approved' ? 'Approved automatically – no approver step was required (approval rule / hierarchy).' : 'No approver steps recorded.'}</p>}<div className="ax-chain">{d.chain.map((c, i) => <div key={i} className={c.state === 'Approved' ? 'ok' : c.state === 'Rejected' ? 'ba' : c.current ? 'cur' : ''}>
              <span>{c.state === 'Approved' ? <Ic n="check" size={12} /> : c.state === 'Rejected' ? <Ic n="x" size={12} /> : i + 1}</span>
              <div><b>{c.role || 'Approver'}</b><small><Av name={c.user} /> {c.user}</small>
                <small className="mu">{c.date ? `${c.state} · ${fd(c.date)} ${ft(c.date)}` : c.current ? `Waiting now · ${d.sla.txt}` : c.state === 'Waiting' ? 'Waiting – next in line' : c.state}</small>
                {c.comment && <i>“{c.comment}”</i>}</div></div>)}</div></div>
            <div className="ax-card"><h4>Why it needs approval</h4><p>{d.purpose.why}</p><div className="ax-pol"><Ic n="git" size={13} /> {d.policy} · SLA {d.sla.hours} h</div>
              {d.route && <a onClick={() => goTo(d.route!)}><Ic n="eye" size={13} /> Open {d.ref}</a>}</div>
            <div className="ax-card"><h4>Activity</h4><div className="tl8">{d.history.map((h, i) => <div key={i}><span className="tl8-d">{fd(h.d)}<br />{ft(h.d)}</span><i className="tl8-i ac" />
              <div className="tl8-b"><span><b>{h.t}</b></span><small>{h.by}</small></div></div>)}</div></div>
          </aside>
        </div>
        {can && (d.can_decide || d.can_delegate || d.can_escalate || d.self_blocked) && <div className="ax-dec">
          {d.self_blocked && <div className="note">You raised this request – company policy does not allow approving your own request. Delegate it to another approver.</div>}
          {d.can_decide && <><div className="ax-qr"><small className="mu">Quick remark</small>{d.quick_remarks.map(x => <span key={x} className="chip" role="button" tabIndex={0} onClick={() => setRm(x)}
            onKeyDown={e => { if (e.key === 'Enter') setRm(x) }}>{x}</span>)}</div>
            <div className="row" style={{ gap: 8, alignItems: 'stretch' }}><textarea className="in fl" rows={2} maxLength={2000} value={rm} onChange={e => setRm(e.target.value)} placeholder="Remarks – required when you reject" aria-label="Remarks" />
              <div className="ax-btns"><button type="button" className="btn p" disabled={busy} onClick={() => decide('approved')}><Ic n="check" /> Approve{pending > 1 ? ' & send on' : ''}</button>
                <button type="button" className="btn d" disabled={busy} onClick={() => decide('rejected')}><Ic n="x" /> Reject</button></div></div></>}
          <div className="row" style={{ gap: 6 }}>
            {d.can_decide && <button type="button" className="btn s g" onClick={() => setModal('info')}>Ask for info</button>}
            {d.can_delegate && <button type="button" className="btn s g" onClick={() => setModal('delegate')}>Delegate</button>}
            {d.can_escalate && <button type="button" className="btn s g" onClick={() => setModal('escalate')}>Escalate</button>}</div>
        </div>}
        {d.can_answer && !d.can_decide && <div className="ax-dec"><button type="button" className="btn p" onClick={() => setModal('answer')}>Answer the information request</button></div>}
      </div>}
    </aside>
    {modal && d && <ActionModal kind={modal} d={d} meta={meta} onClose={() => setModal(null)} onDone={msg => { setModal(null); success(msg); onChanged(); void load() }} />}
  </div>, host)
}

function ActionModal({ kind, d, meta, onClose, onDone }: { kind: 'info' | 'delegate' | 'escalate' | 'answer'; d: Detail; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const { error } = useToast()
  const [text, setText] = useState('')
  const [user, setUser] = useState<number | ''>('')
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const title = { info: 'Ask for information', delegate: 'Delegate approval', escalate: 'Escalate', answer: 'Answer the information request' }[kind]
  const ok = async () => {
    if ((kind === 'info' || kind === 'answer') && !text.trim()) { error('Write the message first'); return }
    if (kind === 'delegate' && !user) { error('Choose who should approve'); return }
    setBusy(true)
    try {
      if (kind === 'info') { await approvalsApi.askInfo(d.key, text.trim()); onDone('Question sent to the requester') }
      else if (kind === 'answer') { await approvalsApi.answer(d.key, text.trim()); onDone('Answer sent to the approver') }
      else if (kind === 'delegate') { const r = await approvalsApi.delegate(d.key, Number(user), text.trim(), until || null); onDone(`Delegated to ${r.to}`) }
      else { const r = await approvalsApi.escalate(d.key, text.trim()); onDone(`Escalated to ${r.to}`) }
    } catch (e) { error(errMsg(e, 'Could not complete the action')) } finally { setBusy(false) }
  }
  return <Modal title={title} width={480} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={ok}>{busy ? 'Saving…' : title}</button></>}>
    {kind === 'info' && <p className="mu" style={{ marginTop: 0 }}>The request stays pending; {d.by} is notified and can answer from the request.</p>}
    {kind === 'escalate' && <p className="mu" style={{ marginTop: 0 }}>The step moves to the reporting manager of the current approver ({d.cur}). The original approver stays in the history.</p>}
    {kind === 'answer' && d.info.question && <div className="note inf mb">“{d.info.question}”</div>}
    <div className="fg">
      {kind === 'delegate' && <><div className="f1"><label htmlFor="ad-u">Delegate to</label><select id="ad-u" className="in" value={user} onChange={e => setUser(e.target.value ? Number(e.target.value) : '')}>
        <option value="">Choose…</option>{meta.people.filter(p => p.id !== d.cur_id && p.id !== d.by_id).map(p => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ''}</option>)}</select></div>
        <div><label htmlFor="ad-t">Valid until</label><input id="ad-t" className="in" type="date" min={new Date().toISOString().slice(0, 10)} value={until} onChange={e => setUntil(e.target.value)} /></div><div /></>}
      <div className="f1"><label htmlFor="ad-x">{kind === 'info' ? 'Question' : kind === 'answer' ? 'Answer' : 'Reason'}</label>
        <textarea id="ad-x" className="in" rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} /></div>
    </div>
  </Modal>
}
