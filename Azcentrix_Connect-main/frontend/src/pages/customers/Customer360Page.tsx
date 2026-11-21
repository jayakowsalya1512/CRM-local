// Customer 360 – prototype v17 cust360(): crumb, header card (.chd), KPI strip and the tab panel.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import ComposeModal from '@/pages/notifications/ComposeModal'
import { inboxApi, type Mailbox, type MailDetail } from '@/pages/notifications/inboxApi'
import { Av, Pill, Strip } from './kit'
import { Activity, Contacts, DealsBids, Documents, Guarantees, Health, HierarchyTab, JourneyStepper, Journeys, Orders, Overview, Plan, SegmentTab } from './C360Tabs'
import { custApi, errMsg, fd, inr, type C360, type Journey } from './customerApi'
import { recordRecentItem } from '@/store/recentItemsStore'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, type FieldSpec } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import './c360.css'

// prototype acT2 after the Hierarchy and Segment & vertical tabs were inserted
const TABS = ['360 overview', 'Hierarchy', 'Segment & vertical', 'Journeys', 'Contacts & org map', 'Deals & bids', 'Orders & billing', 'Guarantees', 'Activity & comms', 'Documents', 'Account plan', 'Health & risk'] as const
type Tab = typeof TABS[number]
const ACT_TYPES = ['Phone Call', 'Video Call', 'In Person Meet', 'Demo', 'Site Visit', 'Follow Up', 'Email']

export default function Customer360Page() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { success, error } = useToast()
  const [d, setD] = useState<C360 | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<Tab>(() => (TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab') as Tab : '360 overview')
  const [modal, setModal] = useState<null | { k: 'log' } | { k: 'contact' } | { k: 'role'; cid: number } | { k: 'journey'; j: Journey } | { k: 'mail'; id: number } | { k: 'compose'; to: string }>(null)
  const [mailbox, setMailbox] = useState<Mailbox | null>(null)

  const load = useCallback(() => {
    custApi.get(id).then(r => {
      setD(r); setErr('')
      recordRecentItem({ module: 'Customer', label: r.header.name, path: `/customers/${id}` })
    }).catch(e => setErr(errMsg(e, 'Could not load this customer')))
  }, [id])
  useEffect(() => { setD(null); load() }, [load])
  const go = (t: Tab) => { setTab(t); const n = new URLSearchParams(params); n.set('tab', t); setParams(n, { replace: true }) }

  if (err) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a></div><div className="panel"><div className="empty">{err}</div></div></div>
  if (!d) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a></div><div className="empty">Loading…</div></div>
  const h = d.header
  const primary = d.contacts.find(c => c.is_primary && c.email) || d.contacts.find(c => c.email)
  const email = async (to?: string) => {
    const addr = to || primary?.email || ''
    if (!d.can.email) { if (addr) window.location.href = `mailto:${addr}`; else error('Add a contact with an email address first'); return }
    try { setMailbox(await inboxApi.mailbox()) } catch { setMailbox(null) }
    setModal({ k: 'compose', to: addr })
  }
  const acts = {
    onLog: () => d.can.log_activity ? setModal({ k: 'log' }) : error("You don't have permission to log activities"),
    onEmail: email, onNewDeal: () => navigate(`/opportunities/new?customer=${id}`), onAddContact: () => setModal({ k: 'contact' }),
    onTab: (t: string) => go(t as Tab), onTimeline: (j: Journey) => setModal({ k: 'journey', j }),
  }
  const hc = h.health < 55 ? 'var(--bw-ba)' : h.health < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)', R = 2 * Math.PI * 30
  const F: [string, ReactNode][] = [
    ['Type', h.type], ['Location', h.location], ['Customer since', h.since ?? '—'],
    ['KAM', h.kam.name ? <><Av name={h.kam.name} /> {h.kam.name} <Pill s={h.kam.own ? 'own' : 'common'} t={h.kam.own ? 'ok' : 'mu'} /></> : <span className="mu">unassigned</span>],
    ['Tier', <Pill key="t" s={`Tier ${h.tier}`} t="ac" />], ['Segment', h.segment], ['Sub-segment', h.sub_segment], ['Vertical', h.vertical],
    ['Value band', <Pill key="v" s={h.value_band} t={h.value_band === 'Strategic' ? 'ok' : 'inf'} />],
    ['GST', h.gst ? <span className="mono">{h.gst}</span> : <span className="mu">not recorded</span>],
    ['Credit limit', h.credit_limit != null ? <b>{inr(h.credit_limit)}</b> : <span className="mu">not set</span>],
    ['Status', <Pill key="s" s={h.status} t={h.status === 'Active' ? 'ok' : undefined} />],
  ]

  return (
    <div className="bwi">
      <div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a> / {h.ref}</div>
      <div className="chd">
        <div className="chd-r"><svg width="84" height="84" viewBox="0 0 72 72" role="img" aria-label={`Health ${h.health}`}><circle cx="36" cy="36" r="30" fill="none" stroke="var(--bw-ln2)" strokeWidth="7" />
          <circle cx="36" cy="36" r="30" fill="none" stroke={hc} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${R * h.health / 100} ${R}`} transform="rotate(-90 36 36)" />
          <text x="36" y="41" textAnchor="middle" fontSize="18" fontWeight="800" fill="currentColor">{h.health}</text></svg><small>Health</small></div>
        <div className="chd-m">
          <div className="chd-t"><span className={`lvb ${h.badge[1]}`} title={h.level}>{h.badge[0]}</span><h1>{h.name}</h1>
            {h.approval_status === 'pending' && <Pill s="Pending approval" t="wa" />}</div>
          {(h.path.length > 1 || h.below > 0) && <div className="cpath">
            {h.path.map((x, i) => <span key={x.id} className="row" style={{ gap: 6, display: 'inline-flex' }}>{i > 0 && <span className="mu">›</span>}
              {i === h.path.length - 1 ? <b>{x.name}</b> : <a onClick={() => navigate(`/customers/${x.id}`)}>{x.name}</a>}</span>)}
            {h.below > 0 && <Pill s={`${h.below} entities below`} t="mu" />}<a onClick={() => go('Hierarchy')}>View hierarchy →</a></div>}
          <div className="chd-f">{F.map(([l, x]) => <div key={l}><label>{l}</label><span>{x}</span></div>)}</div>
        </div>
        <div className="chd-a">
          {d.can.new_deal && <button type="button" className="btn p" onClick={acts.onNewDeal}><Ic n="plus" /> New deal</button>}
          {d.can.log_activity && <button type="button" className="btn" onClick={acts.onLog}><Ic n="plus" /> Log activity</button>}
          <button type="button" className="btn" onClick={() => email()}><Ic n="mail" /> Email</button>
          {d.can.update && <button type="button" className="btn" onClick={() => navigate(`/customers/${id}/edit`)}><Ic n="file" /> Edit</button>}
        </div>
      </div>
      <Strip items={d.kpis} />
      <div className="panel">
        <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => go(t)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(t) } }}>{t}</div>)}</div>
        <div className="pb">
          {tab === '360 overview' ? <Overview d={d} a={acts} />
            : tab === 'Hierarchy' ? <HierarchyTab id={id} canUpdate={d.can.update} canCreate={d.can.create} onChanged={load} />
              : tab === 'Segment & vertical' ? <SegmentTab id={id} a={acts} />
                : tab === 'Journeys' ? <Journeys d={d} a={acts} />
                  : tab === 'Contacts & org map' ? <Contacts d={d} a={acts} onRole={cid => setModal({ k: 'role', cid })} />
                    : tab === 'Deals & bids' ? <DealsBids d={d} />
                      : tab === 'Orders & billing' ? <Orders d={d} />
                        : tab === 'Guarantees' ? <Guarantees d={d} />
                          : tab === 'Activity & comms' ? <Activity d={d} a={acts} onMail={mid => setModal({ k: 'mail', id: mid })} />
                            : tab === 'Documents' ? <Documents id={id} allowed={d.can.documents} />
                              : tab === 'Account plan' ? <Plan d={d} id={id} />
                                : <Health d={d} />}
        </div>
      </div>

      {modal?.k === 'log' && <LogActivityModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); success('Activity logged'); load() }} />}
      {modal?.k === 'contact' && <AddContactModal id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); success('Contact added'); load() }} />}
      {modal?.k === 'role' && <RoleModal id={id} c={d.contacts.find(x => x.id === modal.cid)!} onClose={() => setModal(null)} onDone={() => { setModal(null); success('Buying role saved'); load() }} />}
      {modal?.k === 'journey' && <Modal title={<>Journey {modal.j.id} <Pill s={modal.j.stage} /></>} width={620} onClose={() => setModal(null)}>
        <JourneyStepper j={modal.j} />
        <div className="tl" style={{ marginTop: 14 }}>{modal.j.timeline.length ? modal.j.timeline.map((x, i) => <div key={i}><b>{x.text}</b><br /><small className="mu">{fd(x.date)}</small></div>) : <div className="mu">No dated events yet.</div>}</div>
      </Modal>}
      {modal?.k === 'mail' && <MailView id={modal.id} onClose={() => setModal(null)} />}
      {modal?.k === 'compose' && <ComposeModal init={{ to: modal.to, link: { module: 'customers', id }, subject: '' }} mailbox={mailbox} onClose={() => setModal(null)}
        onDone={() => { setModal(null); load() }} />}
    </div>
  )
}

// validation specs (backend: kam_router ActivityCreate, customer360_router ContactIn)
const ACT_SPEC = (completed: boolean): Record<string, FieldSpec> => ({
  date: { label: 'Date', rule: 'date', required: true }, subject: { label: 'Subject', rule: 'text', required: true, min: 2, max: 300 },
  notes: { label: 'Notes', rule: 'textarea', max: 5000 }, outcome: { label: 'Outcome', rule: 'text', required: completed, max: 500 },
})
const ACT_FIELDS: Record<string, string> = { date: 'ad', subject: 'as', notes: 'an', outcome: 'ao' }
const ACT_API: Record<string, string> = { activity_date: 'date', subject: 'subject', description: 'notes', outcome: 'outcome' }
const focusId = (id: string) => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
const inv = (m?: string, id?: string) => ({ 'aria-invalid': m ? true : undefined, 'aria-describedby': m && id ? `${id}-err` : undefined })

function LogActivityModal({ d, onClose, onDone }: { d: C360; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const [v, setV] = useState({ type: 'Site Visit', date: iso, subject: '', notes: '', status: 'Completed', outcome: '', contacts: [] as number[] })
  const fe = useFieldErrors(), errs = fe.errors
  const [busy, setBusy] = useState(false)
  const specs = ACT_SPEC(v.status === 'Completed')
  type K = 'date' | 'subject' | 'notes' | 'outcome'
  const set = (k: K, x: string) => { setV({ ...v, [k]: x }); fe.change(k, x, specs[k]) }
  const leave = (k: K) => fe.blur(k, v[k], specs[k])
  const save = async () => {
    const bad = fe.validateAll({ date: v.date, subject: v.subject, notes: v.notes, outcome: v.outcome }, v.status === 'Completed' ? specs : { ...specs, outcome: undefined })
    if (Object.keys(bad).length) { const k = Object.keys(ACT_FIELDS).find(x => bad[x]); if (k) focusId(ACT_FIELDS[k]); return }
    setBusy(true)
    try {
      const mode = v.type === 'Phone Call' ? 'Phone' : v.type === 'Video Call' ? 'Video' : v.type === 'Email' ? 'Email' : 'In Person'
      await custApi.logActivity({ activity_type: v.type, customer_id: d.header.id, subject: v.subject.trim(), description: v.notes.trim() || null, activity_date: v.date,
        mode, status: v.status, outcome: v.status === 'Completed' ? v.outcome.trim() : null, contacts_met: v.contacts.length ? v.contacts : null })
      onDone()
    } catch (x) {
      const fx = Object.fromEntries(Object.entries(mapApiErrors(x, ACT_API)).filter(([k]) => ACT_FIELDS[k]))
      if (Object.keys(fx).length) { fe.setErrors(e => ({ ...e, ...fx })); const k = Object.keys(ACT_FIELDS).find(f => fx[f]); if (k) focusId(ACT_FIELDS[k]) }
      else error(errMsg(x, 'Could not log the activity'))
    } finally { setBusy(false) }
  }
  return <Modal title={`Log activity – ${d.header.name}`} width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Log activity'}</button></>}>
    <div className="fg">
      <div><label htmlFor="at">Type</label><select id="at" className="in" value={v.type} onChange={e => setV({ ...v, type: e.target.value })}>{ACT_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
      <div><label htmlFor="ad">Date</label><input id="ad" type="date" className={`in ${errs.date ? 'err' : ''}`} {...inv(errs.date, 'ad')} value={v.date} onChange={e => set('date', e.target.value)} onBlur={() => leave('date')} /><FieldError id="ad" msg={errs.date} /></div>
      <div className="f1"><label htmlFor="as">Subject <b>*</b></label><input id="as" className={`in ${errs.subject ? 'err' : ''}`} {...inv(errs.subject, 'as')} maxLength={300} value={v.subject} onChange={e => set('subject', e.target.value)} onBlur={() => leave('subject')} /><FieldError id="as" msg={errs.subject} /></div>
      <div className="f1"><label htmlFor="an">Notes</label><textarea id="an" className={`in ${errs.notes ? 'err' : ''}`} {...inv(errs.notes, 'an')} rows={3} value={v.notes} onChange={e => set('notes', e.target.value)} onBlur={() => leave('notes')} /><FieldError id="an" msg={errs.notes} /></div>
      <div><label htmlFor="ast">Status</label><select id="ast" className="in" value={v.status} onChange={e => { setV({ ...v, status: e.target.value }); if (e.target.value !== 'Completed') fe.clear('outcome') }}><option>Completed</option><option>Planned</option></select></div>
      <div><label htmlFor="ao">Outcome{v.status === 'Completed' && <b> *</b>}</label><input id="ao" className={`in ${errs.outcome ? 'err' : ''}`} {...inv(errs.outcome, 'ao')} value={v.outcome} disabled={v.status !== 'Completed'} onChange={e => set('outcome', e.target.value)} onBlur={() => leave('outcome')} placeholder="e.g. Positive – asked for revised quote" /><FieldError id="ao" msg={errs.outcome} /></div>
      {d.contacts.length > 0 && <div className="f1"><label>Contacts met</label><div className="row wrap" style={{ gap: 6 }}>{d.contacts.map(c => { const on = v.contacts.includes(c.id)
        return <span key={c.id} role="checkbox" aria-checked={on} tabIndex={0} className={`chip ${on ? 'on' : ''}`} onClick={() => setV({ ...v, contacts: on ? v.contacts.filter(x => x !== c.id) : [...v.contacts, c.id] })}
          onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setV({ ...v, contacts: on ? v.contacts.filter(x => x !== c.id) : [...v.contacts, c.id] }) } }}>{c.name}</span> })}</div></div>}
    </div>
  </Modal>
}

const CONTACT_SPEC: Record<string, FieldSpec> = {
  name: { label: 'Name', rule: 'name', required: true, min: 2, max: 100 },
  designation: { label: 'Designation', rule: 'text', required: true, min: 2, max: 100 },
  department: { label: 'Department', rule: 'text', required: true, min: 2, max: 100 },
  phone: { label: 'Phone number', rule: 'mobile', required: true },
  email: { label: 'Email', rule: 'email' },
}
const CONTACT_ORDER = ['name', 'designation', 'department', 'phone', 'email']

function AddContactModal({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [v, setV] = useState({ name: '', designation: '', department: '', phone: '', email: '', buying_role: '' })
  const fe = useFieldErrors(), errs = fe.errors
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const bad = fe.validateAll(v, CONTACT_SPEC)
    if (Object.keys(bad).length) { const k = CONTACT_ORDER.find(x => bad[x]); if (k) focusId(`ac-${k}`); return }
    setBusy(true)
    try { await custApi.addContact(id, { ...v, name: v.name.trim(), designation: v.designation.trim(), department: v.department.trim(), phone: v.phone.trim(), email: v.email.trim(), buying_role: v.buying_role || null }); onDone() }
    catch (x) {
      // 422 format errors and 409 duplicates (phone / email) land under their fields
      const fx = Object.fromEntries(Object.entries(mapApiErrors(x)).filter(([k]) => CONTACT_SPEC[k]))
      if (Object.keys(fx).length) { fe.setErrors(e => ({ ...e, ...fx })); const k = CONTACT_ORDER.find(f => fx[f]); if (k) focusId(`ac-${k}`) }
      else error(errMsg(x, 'Could not add the contact'))
    } finally { setBusy(false) }
  }
  const fld = (k: keyof typeof v, label: string, req = false, type = 'text') => <div><label htmlFor={`ac-${k}`}>{label}{req && <b> *</b>}</label>
    <input id={`ac-${k}`} type={type} className={`in ${errs[k] ? 'err' : ''}`} {...inv(errs[k], `ac-${k}`)} value={v[k]} onChange={e => { setV({ ...v, [k]: e.target.value }); fe.change(k, e.target.value, CONTACT_SPEC[k]) }}
      onBlur={() => fe.blur(k, v[k], CONTACT_SPEC[k])} /><FieldError id={`ac-${k}`} msg={errs[k]} /></div>
  return <Modal title="Add contact" width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add contact'}</button></>}>
    <div className="fg">{fld('name', 'Name', true)}{fld('designation', 'Designation', true)}{fld('department', 'Department', true)}{fld('phone', 'Phone', true, 'tel')}{fld('email', 'Email', false, 'email')}
      <div><label htmlFor="ac-role">Buying role</label><select id="ac-role" className="in" value={v.buying_role} onChange={e => setV({ ...v, buying_role: e.target.value })}>
        <option value="">Not mapped</option>{['Decision maker', 'Influencer', 'User', 'Gatekeeper'].map(r => <option key={r}>{r}</option>)}</select></div></div>
  </Modal>
}

function RoleModal({ id, c, onClose, onDone }: { id: number; c: C360['contacts'][number]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [role, setRole] = useState(c.buying_role || '')
  return <Modal title={`Buying role – ${c.name}`} width={420} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" onClick={async () => { try { await custApi.setRole(id, c.id, role || null); onDone() } catch (x) { error(errMsg(x, 'Could not save the role')) } }}>Save</button></>}>
    <div className="row wrap" style={{ gap: 6 }}>{['Decision maker', 'Influencer', 'User', 'Gatekeeper', ''].map(r => <span key={r || 'none'} role="radio" aria-checked={role === r} tabIndex={0} className={`chip ${role === r ? 'on' : ''}`} onClick={() => setRole(r)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRole(r) } }}>{r || 'Not mapped'}</span>)}</div>
  </Modal>
}

function MailView({ id, onClose }: { id: number; onClose: () => void }) {
  const [m, setM] = useState<MailDetail | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { inboxApi.get(id, false).then(setM).catch(e => setErr(errMsg(e, 'Could not open the email'))) }, [id])
  return <Modal title={m ? m.subject || '(no subject)' : 'Email'} width={640} onClose={onClose}>
    {err ? <div className="empty">{err}</div> : !m ? <div className="empty">Loading…</div> : <>
      <div className="row mb" style={{ gap: 8 }}><Av name={m.from_name || m.from_email} /><div className="fl"><b>{m.from_name || m.from_email}</b><br /><small className="mu">To {m.to}{m.cc ? ` · Cc ${m.cc}` : ''} · {fd(m.time)}</small></div>
        {m.track_opens && <small className="mu">{m.open_count} open{m.open_count === 1 ? '' : 's'} · {m.click_count} click{m.click_count === 1 ? '' : 's'}</small>}</div>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{m.body}</div>
      {m.attachment_list.length > 0 && <div className="row wrap mt" style={{ gap: 6, marginTop: 10 }}>{m.attachment_list.map(a => <span key={a.id} className="chip"><Ic n="file" /> {a.name}</span>)}</div>}
    </>}
  </Modal>
}
